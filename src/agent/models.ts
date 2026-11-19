import {
	clampThinkingLevel,
	createModels,
	getSupportedThinkingLevels,
	type Api,
	type AssistantMessage,
	type AssistantMessageEvent,
	type CacheRetention,
	type Model,
	type Models,
	type MutableModels,
	type SimpleStreamOptions,
	type StreamFunction,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { lazyApi, lazyStream } from "@earendil-works/pi-ai/api/lazy";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { type ModelRole } from "../../config.ts";
import { DEFAULT_THINKING_ORDER } from "../core/settings.ts";
import packageMetadata from "../../package.json" with { type: "json" };
import { chatGPTModel } from "./chatgpt-bridge.ts";
import { chatGPTStream } from "./chatgpt-stream.ts";
import type { ChatGPTDispatchLifecycle } from "./chatgpt-request-cycle.ts";
import { createClaudeCodeProvider } from "./claude-code/provider.ts";
import { streamClaudeCode } from "./claude-code/stream.ts";
import { nativeSubscriptionId, nativeSubscriptionModel } from "./subscription-bridge.ts";
import { nativeSubscriptionStream } from "./subscription-stream.ts";
import { nineRouterProvider } from "./9router-provider.ts";

/** App identity is immutable and shared by Models and every native Agent.
 * Agent's default Pi attribution otherwise overrides the Models identity. */
export const APP_IDENTITY = Object.freeze({
	userAgent: Object.freeze({ custom: `learnharness/${packageMetadata.version}` }),
	attribution: Object.freeze({ name: packageMetadata.name, url: packageMetadata.homepage }),
});

/**
 * The one engine factory every agent's model comes from (the pi-ai swap,
 * docs/archive/pi-engine-swap.md). BYOK ALL THE WAY DOWN (owner, 2026-09-22):
 * there are no factory pins — every engine resolves from a RESOLVED SPEC
 * (the settings chain's output) and the one builder here wires it to
 * pi-ai's federated catalogs.
 *
 * An "engine" is the model + the stream function the agent loop runs on —
 * the two things a test fake replaces. Production engines resolve the model
 * from pi-ai's static catalogs and stream through the same Models
 * collection.
 */

export interface PiEngine {
	model: Model<Api>;
	streamFn: StreamFunction;
	/** The initially resolved (config-or-settings, CLAMPED) thinking level.
	 *  Custom streams re-resolve the original preference per operation. */
	level?: ThinkingLevel;
}

export type { ThinkingLevel };

let collection: ReturnType<typeof createModels> | undefined;
interface ProviderSource {
	sync(models: MutableModels): void;
	isCustom(id: string): boolean;
}
let providerSource: ProviderSource | undefined;

/** Configuration IO is injected by the server; the agent never imports stores. */
export function configureProviderSource(source: ProviderSource): void {
	// Server module re-evaluation can replace the source while this collection
	// survives. Retire only the previous source's routes, not built-ins.
	if (collection && providerSource) {
		for (const provider of collection.getProviders()) {
			if (providerSource.isCustom(provider.id)) collection.deleteProvider(provider.id);
		}
	}
	providerSource = source;
}

/** The process-wide pi-ai Models collection — EVERY builtin provider's
 *  catalog (model slots wave, 2026-09-20): engines and the picker resolve
 *  against all of pi-ai's per-provider catalogs, so a settings slot can pin
 *  any native model id. Auth is resolved per request by pi-ai itself from
 *  the environment (the keys seam reflects file-saved keys into env), and
 *  a provider with no key simply fails its stream with "not configured" —
 *  honest, late, and unreachable through the picker, which gates on
 *  keyPresent. */
export function piModels() {
	if (!collection) {
		collection = createModels({ identity: APP_IDENTITY });
		for (const provider of builtinProviders()) {
			// Keep the native Bedrock implementation reachable by standalone tracing.
			// Pi's default Node-only loader hides this import from bundlers. Only
			// replace its lazy forwarding; preserve the native factory's auth/catalog.
			collection.setProvider(provider.id === "amazon-bedrock"
				? { ...provider, ...lazyApi(() => import("@earendil-works/pi-ai/api/bedrock-converse-stream")) }
				: provider);
		}
		collection.setProvider(createClaudeCodeProvider(streamClaudeCode));
		collection.setProvider(nineRouterProvider());
	}
	providerSource?.sync(collection);
	return collection;
}

/** OpenRouter API key (BYOK); tests never read this — they inject engines. */
export function openRouterApiKey(): string | undefined {
	return process.env.OPENROUTER_API_KEY || undefined;
}

/** A fully-resolved model pin — the shape every engine now comes from:
 *  the settings-resolution chain's output (role override → slot, or the
 *  chat's conversation chain). thinkingLevel is OPTIONAL: unset means
 *  the baked default resolves here (owner 2026-09-22) — the first entry
 *  of DEFAULT_THINKING_ORDER the model supports. */
export interface ResolvedModelSpec {
	provider: string;
	id: string;
	thinkingLevel?: ThinkingLevel;
}

/** The first entry of the baked default order the model supports (owner,
 *  2026-09-22). A non-reasoning model reports exactly ["off"], so the
 *  order walk lands there naturally. */
function defaultThinkingLevel(model: Model<Api>): ThinkingLevel {
	const supported = getSupportedThinkingLevels(model);
	for (const level of DEFAULT_THINKING_ORDER) {
		if (supported.includes(level)) return level;
	}
	return supported[0] ?? "off";
}


/** Upstream proxies (9router/OmniRoute, custom OpenAI-compatible endpoints)
 *  sometimes kill the SSE connection BEFORE any content is produced —
 *  pi-ai surfaces that as "Stream ended without finish_reason". Nothing was
 *  shown or persisted, so replaying the request cannot duplicate transcript
 *  content. Anything else — a non-transient failure, an abort, or a failure
 *  AFTER visible content — settles as-is: a mid-generation replay could
 *  double-write the transcript. */
const TRANSIENT_STREAM_RETRIES = 2;
const TRANSIENT_STREAM_BACKOFF_MS = [1_000, 3_000] as const;
const isTransientStreamError = (message: string | undefined): boolean =>
	Boolean(message && /Stream ended without finish_reason|Stream ended before producing a non-ping SSE event/i.test(message));

/** The zero-usage error AssistantMessage the other stream adapters build
 *  (chatgpt-stream.ts `empty`, subscription-stream.ts) for failures. */
function streamFailureMessage(model: Model<Api>, message: string, aborted: boolean): AssistantMessage {
	return {
		role: "assistant",
		api: model.api,
		provider: model.provider,
		model: model.id,
		content: [],
		stopReason: aborted ? "aborted" : "error",
		errorMessage: message,
		timestamp: Date.now(),
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	};
}

/** Replay `open()` attempts that die before ANY visible content. An empty
 *  `start` event is held back (a retried attempt emits its own) until the
 *  first real event flushes it, so a dead attempt leaks nothing. */
async function runTransientRetries(model: Model<Api>, open: () => AssistantMessageEventStream, out: AssistantMessageEventStream, signal: AbortSignal | undefined): Promise<void> {
	for (let attempt = 0; ; attempt++) {
		let heldStart: AssistantMessageEvent | undefined;
		let forwarded = false;
		try {
			let replay = false;
			for await (const event of open()) {
				if (event.type === "start") {
					heldStart = event; // not visible content: a retry replaces it
					continue;
				}
				if (
					event.type === "error" && !forwarded &&
					isTransientStreamError(event.error.errorMessage) &&
					attempt < TRANSIENT_STREAM_RETRIES && !signal?.aborted
				) { replay = true; break; } // died before visible content
				if (heldStart) { out.push(heldStart); heldStart = undefined; }
				forwarded = true;
				out.push(event);
				if (event.type === "done" || event.type === "error") {
					out.end(event.type === "done" ? event.message : event.error);
					return;
				}
			}
			if (!replay) {
				// Source exhausted without a terminal event: whatever was
				// forwarded stands; never fabricate a terminal.
				if (heldStart) out.push(heldStart);
				out.end();
				return;
			}
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			if (forwarded || !isTransientStreamError(message) || attempt >= TRANSIENT_STREAM_RETRIES || signal?.aborted) {
				// Thrown failures surface as a direct error event (legal before
				// start per pi-ai's contract); the dead attempt's held start
				// never escapes.
				const failure = streamFailureMessage(model, message, signal?.aborted === true);
				out.push({ type: "error", reason: failure.stopReason as "aborted" | "error", error: failure });
				out.end(failure);
				return;
			}
			// thrown transient before content: fall through to replay
		}
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, TRANSIENT_STREAM_BACKOFF_MS[attempt]);
		await promise;
	}
}

/** Wrap ONE bound request: pre-content transient failures replay with
 *  backoff; the consumer sees a single stream. */
function withTransientStreamRetry(model: Model<Api>, open: () => AssistantMessageEventStream, signal: AbortSignal | undefined): AssistantMessageEventStream {
	const out = new AssistantMessageEventStream();
	void runTransientRetries(model, open, out, signal);
	return out;
}


/** The production engine for a RESOLVED spec (model slots wave,
 *  2026-09-20): provider-aware catalog lookup + thinking clamp. The API
 *  key is resolved by pi-ai itself from the environment per request (the
 *  keys seam reflects file-saved keys into env), so the engine never
 *  hardcodes OpenRouter's. */
export function piEngineForSpec(spec: ResolvedModelSpec, background: boolean | (() => boolean) = true, lifecycle?: ChatGPTDispatchLifecycle, cacheRetention?: () => CacheRetention | undefined): PiEngine {
	const models: Models = piModels();
	const nativeId = nativeSubscriptionId(spec.provider);
	const registeredModel = spec.provider === "chatgpt" ? chatGPTModel(spec.id) : nativeId ? nativeSubscriptionModel(spec.provider, spec.id) : models.getModel(spec.provider, spec.id);
	const custom = providerSource?.isCustom(spec.provider) ?? false;
	// Custom endpoint owners authorize image attempts independently of sparse
	// discovery metadata. Never promote the registered/catalog capabilities.
	const permitImages = (value: Model<Api>): Model<Api> => ({ ...value, input: ["text", "image"] });
	const model = custom && registeredModel ? permitImages(registeredModel) : registeredModel;
	if (!model) {
		throw new Error(`${spec.provider} catalog has no model ${spec.id}`);
	}
	// UNSET level → the baked default order (first entry the model
	// supports); SET level → pi's native nearest-clamp (model swaps keep
	// the user's intent and adapt honestly).
	const thinkingPreference = spec.thinkingLevel;
	const level = thinkingPreference
		? clampThinkingLevel(model, thinkingPreference)
		: defaultThinkingLevel(model);
	// A lesson's agent loop can stay alive through many tool calls. Remember
	// only that this is a custom route, never its configuration for that run.
	return {
		model,
		level,
		// The agent loop forwards state.thinkingLevel as `reasoning` (undefined
		// = off on pi-ai's scale). Built-ins keep the factory clamp; custom
		// requests re-resolve thinking against their current metadata below.
		streamFn: (requestModel, context, options) => {
			// Read the slot preference for every operation, not just engine creation.
			// Unset adds NOTHING: native defaults/env and explicit caller options survive.
			const retention = cacheRetention?.();
			const requestOptions = {
				...options,
				...(retention !== undefined ? { cacheRetention: retention } : {}),
				reasoning: level === "off" ? undefined : level,
			};
			if (custom) {
				// Revalidate before EVERY upstream model operation, including later
				// tool-loop steps. Resolve thinking from the ORIGINAL preference (or
				// existing default order), not a previous metadata snapshot's clamp.
				// Pi retains the setup of an operation already in flight.
				return withTransientStreamRetry(requestModel, () => {
					// Re-resolve the custom route per attempt, not per request:
					// Pi retains setup of an operation in flight, but a replay
					// RESTARTS the operation, so metadata may have changed.
					const now = piModels();
					const nowModel = now.getModel(spec.provider, spec.id);
					if (!nowModel) {
						return lazyStream(requestModel, async () => { throw new Error("The selected custom model is unavailable."); });
					}
					const nowLevel = thinkingPreference
						? clampThinkingLevel(nowModel, thinkingPreference)
						: defaultThinkingLevel(nowModel);
					return now.streamSimple(permitImages(nowModel), context, { ...requestOptions, reasoning: nowLevel === "off" ? undefined : nowLevel });
				}, options?.signal);
			}
			const purpose = typeof background === "function" ? background : () => background;
			const stream = spec.provider === "chatgpt" ? chatGPTStream(purpose, lifecycle) : nativeId ? nativeSubscriptionStream(models.getProvider(nativeId)!, purpose, lifecycle) : models.streamSimple.bind(models);
			return withTransientStreamRetry(requestModel, () => stream(requestModel, context, requestOptions), options?.signal);
		},
	};
}

/** The LEGACY role entry point — BYOK made it an honest THROWER (owner,
 *  2026-09-22): no factory pins exist to fall back to, and this module
 *  cannot read settings (architecture law — the agent layer never
 *  imports the server layer). Production resolves the chain in
 *  chat-handler and ALWAYS injects engines; reaching this means a
 *  wiring bug, so it fails loudly instead of guessing a model. */
export function piEngineFor(role: ModelRole): PiEngine {
	throw new Error(
		`no configured model for role "${role}" — set your model slots (settings → models)`,
	);
}
