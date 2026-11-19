import assert from "node:assert/strict";
import { after, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createProvider, fauxAssistantMessage, fauxText, normalizeContext, createFauxCore, type Api, type Model, type SimpleStreamOptions, type StreamFunction } from "@earendil-works/pi-ai";

import { AssistantMessageEventStream, createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";

// All runtime/store imports follow isolation. No ambient auth, profiles,
// models, data or network: scripted streams stop at the retry seam.
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lh-stream-retry-"));
const originalEnv = process.env;
process.env = { PATH: originalEnv.PATH, HOME: directory, NODE_ENV: "test", NODE_TEST_CONTEXT: originalEnv.NODE_TEST_CONTEXT, LH_DATA_DIR: directory, LH_AUTH_FILE: path.join(directory, "auth.json") };
fs.writeFileSync(process.env.LH_AUTH_FILE!, "{}");
const { piModels, piEngineForSpec, configureProviderSource } = await import("../src/agent/models.ts");
after(() => { process.env = originalEnv; fs.rmSync(directory, { recursive: true, force: true }); });
const context = normalizeContext({ systemPrompt: "stable", messages: [{ role: "user", content: "offline", timestamp: 1 }] });
const PROVIDER_ID = "stream-retry-fixture";

/** Insert a provider whose streamSimple plays a per-call script, returning
 *  the call log so tests assert exact attempt and event counts. */
function scriptedProvider(scripts: (string | AssistantMessageEventStream)[]): { calls: number } {
	const state = { calls: 0 };
	const faux = createFauxCore({});
	const entry = { ...faux.getModel(), id: "fixture/model", provider: PROVIDER_ID } as unknown as Model<Api>;
	const stream: StreamFunction = (model, ctx, options) => {
		const script = scripts[Math.min(state.calls, scripts.length - 1)]!;
		state.calls++;
		if (typeof script === "string") return errorStream(script);
		return script;
	};
	const provider = createProvider({ id: PROVIDER_ID, models: [entry], auth: { apiKey: { name: "fixture", resolve: async () => ({ auth: {} }) } }, api: { stream, streamSimple: stream } });
	configureProviderSource({ isCustom: (id) => id === PROVIDER_ID, sync: (models) => { models.setProvider(provider); } });
	return state;
}

/** A failure that dies before any content: exactly the pre-content death
 *  the retry seam replays. */
function errorStream(errorMessage: string): AssistantMessageEventStream {
	const out = createAssistantMessageEventStream();
	const failure = fauxAssistantMessage([], { stopReason: "error", errorMessage });
	out.push({ type: "start", partial: failure });
	out.push({ type: "error", reason: "error", error: failure });
	out.end(failure);
	return out;
}

/** A completed response with one text block — the post-retry success shape. */
function successStream(): AssistantMessageEventStream {
	const out = createAssistantMessageEventStream();
	const message = fauxAssistantMessage([fauxText("recovered")], { stopReason: "stop" });
	out.push({ type: "start", partial: message });
	out.push({ type: "text_start", contentIndex: 0, partial: message });
	out.push({ type: "text_delta", contentIndex: 0, delta: "recovered", partial: message });
	out.push({ type: "text_end", contentIndex: 0, content: "recovered", partial: message });
	out.push({ type: "done", reason: "stop", message });
	out.end(message);
	return out;
}

test("pre-content transient SSE death replays transparently and the retry succeeds", async () => {
	const state = scriptedProvider(["Stream ended without finish_reason", successStream()]);
	const engine = piEngineForSpec({ provider: PROVIDER_ID, id: "fixture/model" });
	const result = await engine.streamFn(engine.model, context).result();
	assert.equal(state.calls, 2, "one dead attempt, one recovery attempt");
	assert.equal(result.stopReason, "stop");
	assert.equal(result.errorMessage, undefined);
	piModels().deleteProvider(PROVIDER_ID);
});

test("all attempts dying pre-content surfaces the raw error after the retry budget", async () => {
	const state = scriptedProvider(["Stream ended without finish_reason"]);
	const engine = piEngineForSpec({ provider: PROVIDER_ID, id: "fixture/model" });
	const result = await engine.streamFn(engine.model, context).result();
	// The failing event is forwarded as-is on the last attempt (no replays left).
	assert.equal(state.calls, 3, "initial + 2 retries");
	assert.equal(result.stopReason, "error");
	assert.match(result.errorMessage ?? "", /Stream ended without finish_reason/);
	piModels().deleteProvider(PROVIDER_ID);
});

test("non-transient failures never replay", async () => {
	const state = scriptedProvider(["Provider returned an error stop reason"]);
	const engine = piEngineForSpec({ provider: PROVIDER_ID, id: "fixture/model" });
	const result = await engine.streamFn(engine.model, context).result();
	assert.equal(state.calls, 1);
	assert.equal(result.stopReason, "error");
	piModels().deleteProvider(PROVIDER_ID);
});

test("a transient failure AFTER visible content never replays (no transcript double-write)", async () => {
	class MidDeath extends AssistantMessageEventStream {
		constructor() {
			super();
			const partial = fauxAssistantMessage([fauxText("partial")], { stopReason: "error", errorMessage: "Stream ended without finish_reason" });
			this.push({ type: "start", partial });
			this.push({ type: "text_start", contentIndex: 0, partial });
			this.push({ type: "error", reason: "error", error: partial });
			this.end(partial);
		}
	}
	const state = scriptedProvider([new MidDeath(), successStream()]);
	const engine = piEngineForSpec({ provider: PROVIDER_ID, id: "fixture/model" });
	const result = await engine.streamFn(engine.model, context).result();
	assert.equal(state.calls, 1, "content was already forwarded: no replay");
	assert.equal(result.stopReason, "error");
	piModels().deleteProvider(PROVIDER_ID);
});

test("abort stops retries", async () => {
	const controller = new AbortController();
	const state = scriptedProvider(["Stream ended without finish_reason"]);
	const engine = piEngineForSpec({ provider: PROVIDER_ID, id: "fixture/model" });
	controller.abort();
	const result = await engine.streamFn(engine.model, context, { signal: controller.signal } as SimpleStreamOptions).result();
	assert.ok(state.calls <= 1, "aborted signal prevents any replay: " + state.calls);
	assert.equal(result.stopReason, "error");
	assert.ok(state.calls === 0 || /abort/i.test(result.errorMessage ?? ""), "failure reflects the abort, not a silent replay loop");
	piModels().deleteProvider(PROVIDER_ID);
});
