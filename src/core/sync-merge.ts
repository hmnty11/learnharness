import type { ChatRecord, SideChatThread, ImageSnapshot } from "./contracts/chat.ts";
import { sanitizeUserSettings, type UserSettings } from "./settings.ts";

export interface SyncTombstone {
	deletedAt: string;
}

export interface SyncManifest {
	version: 1;
	owner: string;
	updatedAt: string;
	deletedChats: Record<string, string>;
	deletedPrompts?: Record<string, string>;
	deletedThemes?: Record<string, string>;
	/** Graph deletion tombstones (sourceId → deletedAt): sources.json keys and
	 *  every provenance chatId the source left in the graph ledgers. */
	deletedGraphSources?: Record<string, string>;
	/** Graph deletion tombstones (nodeId → deletedAt); `arg_` ids name chains. */
	deletedGraphNodes?: Record<string, string>;
}

export interface SyncTextFile {
	content: string;
	updatedAt: string;
}

export interface SyncSnapshot {
	manifest: SyncManifest;
	chats: Record<string, ChatRecord>;
	graphLedgers: {
		nodes: string;
		chains: string;
		sessions: string;
		coverage: string;
	};
	graphFiles: {
		sources?: string;
		sourceOrganization?: string;
		positions?: string;
		renderSettings?: string;
	};
	settings?: UserSettings | null;
	settingsUpdatedAt?: string;
	prompts: Record<string, SyncTextFile>;
	themes: Record<string, SyncTextFile>;
}

export interface SyncStatus {
	connected: boolean;
	owner: string | null;
	repo: string;
	autoSync: boolean;
	syncApiKeys: boolean;
	hasPassphrase: boolean;
	lastSyncedAt: string | null;
	lastError: string | null;
	syncing: boolean;
}

function parseIso(ts: string | undefined): number {
	if (!ts) return Number.NaN;
	const t = Date.parse(ts);
	return Number.isNaN(t) ? Number.NaN : t;
}

function compareIso(a: string | undefined, b: string | undefined): number {
	const ta = parseIso(a);
	const tb = parseIso(b);
	if (!Number.isNaN(ta) && !Number.isNaN(tb)) {
		if (ta < tb) return -1;
		if (ta > tb) return 1;
		return 0;
	}
	if (!Number.isNaN(ta)) return 1;
	if (!Number.isNaN(tb)) return -1;
	const sa = a ?? "";
	const sb = b ?? "";
	return sa < sb ? -1 : sa > sb ? 1 : 0;
}

export function verifySameAccountOwner(
	localOwner: string | null | undefined,
	remoteOwner: string | null | undefined,
): { ok: true; owner: string } | { ok: false; error: string } {
	const local = localOwner?.trim();
	const remote = remoteOwner?.trim();
	if (!local && !remote) {
		return { ok: false, error: "Missing sync account owner" };
	}
	if (local && remote && local.toLowerCase() !== remote.toLowerCase()) {
		return {
			ok: false,
			error: `Account owner mismatch: local account is "${local}" but remote account is "${remote}". Sync refused to prevent mixing different accounts.`,
		};
	}
	return { ok: true, owner: local || remote || "" };
}

export function mergeChatRecords(
	localChats: Record<string, ChatRecord>,
	remoteChats: Record<string, ChatRecord>,
	localDeleted: Record<string, string>,
	remoteDeleted: Record<string, string>,
): { chats: Record<string, ChatRecord>; deletedChats: Record<string, string> } {
	const tombstoneMap: Record<string, string> = { ...localDeleted };
	for (const [id, remoteTs] of Object.entries(remoteDeleted)) {
		const localTs = tombstoneMap[id];
		if (!localTs || compareIso(remoteTs, localTs) > 0) {
			tombstoneMap[id] = remoteTs;
		}
	}

	const candidates = new Map<string, ChatRecord>();
	const allChatIds = new Set([...Object.keys(localChats), ...Object.keys(remoteChats)]);

	for (const id of allChatIds) {
		const local = localChats[id];
		const remote = remoteChats[id];
		if (local && remote) {
			const timeComparison = compareIso(remote.updatedAt, local.updatedAt);
			if (timeComparison > 0) {
				candidates.set(id, remote);
			} else if (timeComparison < 0) {
				candidates.set(id, local);
			} else {
				// Tie-breaker: messages.length, union sideChats and imageSnapshots
				const winner = remote.messages.length > local.messages.length ? remote : local;
				const loser = winner === remote ? local : remote;

				let mergedSideChats: SideChatThread[] | undefined = winner.sideChats;
				if (local.sideChats || remote.sideChats) {
					const threadMap = new Map<string, SideChatThread>();
					for (const thread of loser.sideChats ?? []) threadMap.set(thread.id, thread);
					for (const thread of winner.sideChats ?? []) threadMap.set(thread.id, thread);
					mergedSideChats = Array.from(threadMap.values());
				}

				let mergedImages: Record<string, ImageSnapshot> | undefined = winner.imageSnapshots;
				if (local.imageSnapshots || remote.imageSnapshots) {
					mergedImages = { ...(loser.imageSnapshots ?? {}), ...(winner.imageSnapshots ?? {}) };
				}

				candidates.set(id, {
					...winner,
					...(mergedSideChats ? { sideChats: mergedSideChats } : {}),
					...(mergedImages ? { imageSnapshots: mergedImages } : {}),
				});
			}
		} else if (local) {
			candidates.set(id, local);
		} else if (remote) {
			candidates.set(id, remote);
		}
	}

	const chats: Record<string, ChatRecord> = {};
	const deletedChats: Record<string, string> = { ...tombstoneMap };

	for (const [id, chat] of candidates.entries()) {
		const tombstone = deletedChats[id];
		if (tombstone) {
			if (compareIso(tombstone, chat.updatedAt) >= 0) {
				// Zombie chat suppressed by tombstone
				continue;
			}
			// Chat updated after tombstone; resurrect and clear stale tombstone
			delete deletedChats[id];
		}
		chats[id] = chat;
	}

	return { chats, deletedChats };
}

function canonicalizeJson(val: unknown): unknown {
	if (val === null || typeof val !== "object") return val;
	if (Array.isArray(val)) return val.map(canonicalizeJson);
	const record = val as Record<string, unknown>;
	const keys = Object.keys(record).sort();
	const out: Record<string, unknown> = {};
	for (const key of keys) {
		out[key] = canonicalizeJson(record[key]);
	}
	return out;
}

export function mergeJsonlLedger(localJsonl: string, remoteJsonl: string): string {
	const seenKeys = new Set<string>();
	const lines: string[] = [];

	const addLines = (raw: string) => {
		for (const rawLine of raw.split(/\r?\n/)) {
			const trimmed = rawLine.trim();
			if (!trimmed) continue;
			try {
				const parsed: unknown = JSON.parse(trimmed);
				const key = JSON.stringify(canonicalizeJson(parsed));
				if (!seenKeys.has(key)) {
					seenKeys.add(key);
					lines.push(JSON.stringify(parsed));
				}
			} catch {
				// Ignore corrupt lines safely
			}
		}
	};

	addLines(localJsonl);
	addLines(remoteJsonl);

	return lines.length > 0 ? lines.join("\n") + "\n" : "";
}

export function mergeTextFileMap(
	localMap: Record<string, SyncTextFile>,
	remoteMap: Record<string, SyncTextFile>,
	localDeleted: Record<string, string> = {},
	remoteDeleted: Record<string, string> = {},
): { files: Record<string, SyncTextFile>; deleted: Record<string, string> } {
	const tombstoneMap: Record<string, string> = { ...localDeleted };
	for (const [key, remoteTs] of Object.entries(remoteDeleted)) {
		const localTs = tombstoneMap[key];
		if (!localTs || compareIso(remoteTs, localTs) > 0) {
			tombstoneMap[key] = remoteTs;
		}
	}

	const candidates = new Map<string, SyncTextFile>();
	const allKeys = new Set([...Object.keys(localMap), ...Object.keys(remoteMap)]);

	for (const key of allKeys) {
		const local = localMap[key];
		const remote = remoteMap[key];
		if (local && remote) {
			candidates.set(key, compareIso(remote.updatedAt, local.updatedAt) > 0 ? remote : local);
		} else if (local) {
			candidates.set(key, local);
		} else if (remote) {
			candidates.set(key, remote);
		}
	}

	const files: Record<string, SyncTextFile> = {};
	const deleted: Record<string, string> = { ...tombstoneMap };

	for (const [key, file] of candidates.entries()) {
		const tombstone = deleted[key];
		if (tombstone) {
			if (compareIso(tombstone, file.updatedAt) >= 0) {
				continue;
			}
			delete deleted[key];
		}
		files[key] = file;
	}

	return { files, deleted };
}

function parseJsonObject(raw: string | undefined): Record<string, unknown> | null {
	if (!raw) return null;
	try {
		const parsed: unknown = JSON.parse(raw);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			return parsed as Record<string, unknown>;
		}
		return null;
	} catch {
		return null;
	}
}

/** Union two manifest tombstone maps, keeping the later deletedAt per key. */
function mergeTombstoneMaps(
	local: Record<string, string> | undefined,
	remote: Record<string, string> | undefined,
): Record<string, string> {
	const merged: Record<string, string> = { ...(local ?? {}) };
	for (const [id, ts] of Object.entries(remote ?? {})) {
		const existing = merged[id];
		if (!existing || compareIso(ts, existing) > 0) merged[id] = ts;
	}
	return merged;
}

type LedgerRecord = Record<string, unknown>;

interface Point {
	chatId: string;
	messageId: string;
}

function parseLedgerObjects(raw: string): LedgerRecord[] {
	const out: LedgerRecord[] = [];
	for (const rawLine of raw.split(/\r?\n/)) {
		const trimmed = rawLine.trim();
		if (!trimmed) continue;
		try {
			const parsed: unknown = JSON.parse(trimmed);
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) out.push(parsed as LedgerRecord);
		} catch {
			// Corrupt line handled exactly like the pure union: skipped.
		}
	}
	return out;
}

function recordString(rec: LedgerRecord, key: string): string | undefined {
	const value = rec[key];
	return typeof value === "string" ? value : undefined;
}

function pointsOf(value: unknown): Point[] {
	if (!Array.isArray(value)) return [];
	const out: Point[] = [];
	for (const raw of value) {
		if (!raw || typeof raw !== "object") continue;
		const rec = raw as LedgerRecord;
		if (typeof rec.chatId !== "string") continue;
		out.push({ chatId: rec.chatId, messageId: typeof rec.messageId === "string" ? rec.messageId : "" });
	}
	return out;
}

function unionPoints(into: Point[], points: ReadonlyArray<Point>): void {
	for (const pt of points) {
		if (!into.some((q) => q.chatId === pt.chatId && q.messageId === pt.messageId)) into.push({ ...pt });
	}
}

function unionStrings(into: string[], values: ReadonlyArray<unknown> | string): void {
	const list = typeof values === "string" ? [values] : values;
	for (const value of list) {
		if (typeof value === "string" && value.length > 0 && !into.includes(value)) into.push(value);
	}
}

function earliestIso(values: ReadonlyArray<string | undefined>): string | undefined {
	let best: string | undefined;
	for (const value of values) {
		if (value === undefined || Number.isNaN(parseIso(value))) continue;
		if (best === undefined || compareIso(value, best) < 0) best = value;
	}
	return best;
}

/** A tombstone is stale when the record was minted after the deletion —
 *  the same resurrection rule chat tombstones use. */
function resurrects(earliestCreatedAt: string | undefined, tombstone: string): boolean {
	return earliestCreatedAt !== undefined && compareIso(earliestCreatedAt, tombstone) > 0;
}

function joinLedgerLines(records: ReadonlyArray<unknown>): string {
	return records.length > 0 ? records.map((rec) => JSON.stringify(rec)).join("\n") + "\n" : "";
}

interface NodeLedgerReconciliation {
	nodes: string;
	/** Node ids whose every line is dead — chain members referencing them die. */
	deadNodes: Set<string>;
	deletedGraphNodes: Record<string, string>;
}

function reconcileNodeLedger(
	raw: string,
	deadSources: Record<string, string>,
	tombstones: Record<string, string>,
): NodeLedgerReconciliation {
	const groups = new Map<string, LedgerRecord[]>();
	// Emission slots preserve the union's line order: a group is emitted at its
	// first occurrence, and identity-less records ride through in place.
	const slots: Array<{ id?: string; rec?: LedgerRecord }> = [];
	for (const rec of parseLedgerObjects(raw)) {
		const id = recordString(rec, "id");
		if (id === undefined) {
			slots.push({ rec }); // not addressable as a node — foreign data
			continue;
		}
		const group = groups.get(id);
		if (group) group.push(rec);
		else {
			groups.set(id, [rec]);
			slots.push({ id });
		}
	}

	const deletedGraphNodes: Record<string, string> = { ...tombstones };
	const deadNodes = new Set<string>();
	const out: LedgerRecord[] = [];
	const isDeadSource = (pt: Point): boolean => Object.hasOwn(deadSources, pt.chatId);

	for (const slot of slots) {
		if (slot.rec) {
			out.push(slot.rec);
			continue;
		}
		const id = slot.id!;
		const records = groups.get(id)!;
		const tombstone = deletedGraphNodes[id];
		if (tombstone) {
			const earliest = earliestIso(records.map((rec) => recordString(rec, "createdAt")));
			if (!resurrects(earliest, tombstone)) {
				deadNodes.add(id); // ALL lines die with an active tombstone
				continue;
			}
			delete deletedGraphNodes[id]; // re-created after deletion — the node lives
		}

		const touched = records.some((rec) => pointsOf(rec.provenance).some(isDeadSource));
		if (!touched) {
			// Outside this deletion's blast radius (incl. legacy provenance-free).
			out.push(...records);
			continue;
		}

		const cleaned = records.map((rec) => ({
			rec,
			original: pointsOf(rec.provenance),
			points: pointsOf(rec.provenance).filter((pt) => !isDeadSource(pt)),
		}));
		// The create line is the EARLIEST line (a link line shares the id but
		// was minted later); it owns the node's identity.
		let createIndex = 0;
		for (let i = 1; i < cleaned.length; i += 1) {
			const candidate = cleaned[i]!;
			const incumbent = cleaned[createIndex]!;
			const candidateAt = recordString(candidate.rec, "createdAt");
			const incumbentAt = recordString(incumbent.rec, "createdAt");
			if (candidateAt !== undefined && (incumbentAt === undefined || compareIso(candidateAt, incumbentAt) < 0)) {
				createIndex = i;
			}
		}
		const create = cleaned[createIndex]!;

		if (!cleaned.some((line) => line.points.length > 0)) {
			// No provenance survived. Legacy provenance-free lines are foreign
			// data and ride untouched; a node whose every line carried the
			// deleted source's points dies with them.
			const survivors = cleaned.filter((line) => line.original.length === 0).map((line) => line.rec);
			if (survivors.length === 0) deadNodes.add(id);
			else out.push(...survivors);
			continue;
		}

		// Reconcile into ONE canonical line: identity from the create line,
		// provenance/aliases from the surviving lines. Link lines whose points
		// all died collapse away with their phrasings.
		const aliases: string[] = [];
		const provenance: Point[] = [];
		const ownsPhrasings = (line: (typeof cleaned)[number]): boolean => line.points.length > 0;
		if (ownsPhrasings(create)) {
			unionPoints(provenance, create.points);
			unionStrings(aliases, Array.isArray(create.rec.aliases) ? (create.rec.aliases as unknown[]) : []);
		}
		cleaned.forEach((line, index) => {
			if (index === createIndex || !ownsPhrasings(line)) return;
			unionPoints(provenance, line.points);
			unionStrings(aliases, recordString(line.rec, "statement") ?? []);
			unionStrings(aliases, Array.isArray(line.rec.aliases) ? (line.rec.aliases as unknown[]) : []);
		});
		out.push({
			...create.rec,
			name: recordString(create.rec, "name") ?? "",
			statement: recordString(create.rec, "statement") ?? "",
			createdAt: recordString(create.rec, "createdAt") ?? "",
			aliases,
			provenance,
		});
	}

	// Tombstones with no surviving lines still name dead ids for chains/positions.
	for (const id of Object.keys(deletedGraphNodes)) deadNodes.add(id);

	return { nodes: joinLedgerLines(out), deadNodes, deletedGraphNodes };
}

interface ChainLedgerReconciliation {
	chains: string;
	deadChains: Set<string>;
	deletedGraphNodes: Record<string, string>;
}

function reconcileChainLedger(
	raw: string,
	deadSources: Record<string, string>,
	deadNodes: ReadonlySet<string>,
	tombstones: Record<string, string>,
): ChainLedgerReconciliation {
	const deletedGraphNodes: Record<string, string> = { ...tombstones };
	const deadChains = new Set<string>();
	const out: LedgerRecord[] = [];
	const isDeadSource = (pt: Point): boolean => Object.hasOwn(deadSources, pt.chatId);

	const records = parseLedgerObjects(raw);
	// Chain-level tombstones (an arg_ id names a chain assertion).
	const tombstonedIds = new Set(records.map((rec) => recordString(rec, "id")).filter((id): id is string => id !== undefined));
	for (const id of tombstonedIds) {
		const tombstone = deletedGraphNodes[id];
		if (tombstone === undefined) continue;
		const earliest = earliestIso(
			records.filter((rec) => recordString(rec, "id") === id).map((rec) => recordString(rec, "createdAt")),
		);
		if (resurrects(earliest, tombstone)) delete deletedGraphNodes[id];
	}

	const deadNodeId = (value: unknown): boolean => typeof value === "string" && deadNodes.has(value);

	for (const rec of records) {
		const id = recordString(rec, "id");
		if (id !== undefined && deletedGraphNodes[id] !== undefined) {
			deadChains.add(id);
			continue;
		}
		const premises = Array.isArray(rec.premises) ? rec.premises : [];
		const conclusion = recordString(rec, "conclusion");
		if (conclusion === undefined || premises.some(deadNodeId) || deadNodes.has(conclusion)) {
			if (id !== undefined) deadChains.add(id);
			continue; // a chain with a dead member is not a chain
		}
		const original = pointsOf(rec.provenance);
		const points = original.filter((pt) => !isDeadSource(pt));
		if (original.length > 0 && points.length === 0) {
			if (id !== undefined) deadChains.add(id);
			continue; // THIS deletion emptied the assertion's provenance
		}
		out.push(points.length === original.length ? rec : { ...rec, provenance: points });
	}

	// Every remaining tombstone names a chain id (node ids are equally dead), so
	// its position key is pruned even when no line of it survived the union.
	for (const id of Object.keys(deletedGraphNodes)) deadChains.add(id);

	return { chains: joinLedgerLines(out), deadChains, deletedGraphNodes };
}

/** Drop ledger rows whose chatId was deleted (chat or graph-source tombstone). */
function filterLedgerByChatId(raw: string, deadChatIds: ReadonlySet<string>): string {
	const kept = parseLedgerObjects(raw).filter((rec) => {
		const chatId = recordString(rec, "chatId");
		return chatId === undefined || !deadChatIds.has(chatId);
	});
	return joinLedgerLines(kept);
}

/** Drop sources tombstoned for deletion; a re-import newer than the tombstone
 * resurrects its entry and clears the tombstone (mirrors chat resurrection). */
function pruneSourcesJson(
	sourcesRaw: string | undefined,
	tombstones: Record<string, string>,
): { sources: string | undefined; tombstones: Record<string, string> } {
	const obj = parseJsonObject(sourcesRaw);
	if (!obj) return { sources: sourcesRaw, tombstones };
	let changed = false;
	for (const id of Object.keys(tombstones)) {
		if (!Object.hasOwn(obj, id)) continue;
		const entry = obj[id];
		const importedAt =
			entry && typeof entry === "object" ? recordString(entry as LedgerRecord, "importedAt") : undefined;
		if (importedAt !== undefined && compareIso(importedAt, tombstones[id]!) > 0) {
			delete tombstones[id]; // imported again after the deletion — resurrected
			continue;
		}
		delete obj[id];
		changed = true;
	}
	return { sources: changed ? JSON.stringify(obj, null, "\t") : sourcesRaw, tombstones };
}

/** Drop graph ids that died in this merge; untouched when nothing dies. */
function prunePositionsJson(positionsRaw: string | undefined, deadIds: ReadonlySet<string>): string | undefined {
	const parsed = parsePositionsMap(positionsRaw);
	if (!parsed) return positionsRaw;
	let changed = false;
	for (const id of deadIds) {
		if (!Object.hasOwn(parsed.positions, id)) continue;
		delete parsed.positions[id];
		changed = true;
	}
	return changed ? JSON.stringify({ positions: parsed.positions, updatedAt: parsed.updatedAt }, null, "\t") : positionsRaw;
}

/** Drop folder placements for tombstoned sources; other organization data stays
 * verbatim so a merge cannot reorder or reformat folders the user arranged. */
function pruneSourceOrganizationJson(
	organizationRaw: string | undefined,
	tombstones: Record<string, string>,
): string | undefined {
	const obj = parseJsonObject(organizationRaw);
	if (!obj) return organizationRaw;
	const placements = obj.placements;
	if (!placements || typeof placements !== "object" || Array.isArray(placements)) return organizationRaw;
	let changed = false;
	for (const id of Object.keys(tombstones)) {
		if (!Object.hasOwn(placements, id)) continue;
		delete (placements as Record<string, unknown>)[id];
		changed = true;
	}
	return changed ? JSON.stringify(obj, null, "\t") : organizationRaw;
}

function mergeSourcesJson(localSourcesRaw?: string, remoteSourcesRaw?: string): string | undefined {
	const localObj = parseJsonObject(localSourcesRaw);
	const remoteObj = parseJsonObject(remoteSourcesRaw);
	if (!localObj && !remoteObj) return undefined;
	const merged: Record<string, unknown> = {};
	const allKeys = new Set([...Object.keys(localObj ?? {}), ...Object.keys(remoteObj ?? {})]);
	for (const id of allKeys) {
		const local = localObj?.[id];
		const remote = remoteObj?.[id];
		if (local && remote && typeof local === "object" && typeof remote === "object") {
			const localRecord = local as Record<string, unknown>;
			const remoteRecord = remote as Record<string, unknown>;
			const localTime = typeof localRecord.importedAt === "string" ? localRecord.importedAt : undefined;
			const remoteTime = typeof remoteRecord.importedAt === "string" ? remoteRecord.importedAt : undefined;
			merged[id] = compareIso(remoteTime, localTime) > 0 ? remote : local;
		} else {
			merged[id] = remote ?? local;
		}
	}
	return JSON.stringify(merged, null, "\t");
}

function parsePositionsMap(raw: string | undefined): { positions: Record<string, unknown>; updatedAt?: string } | null {
	const obj = parseJsonObject(raw);
	if (!obj) return null;
	if (obj.positions && typeof obj.positions === "object" && !Array.isArray(obj.positions)) {
		return {
			positions: obj.positions as Record<string, unknown>,
			updatedAt: typeof obj.updatedAt === "string" ? obj.updatedAt : undefined,
		};
	}
	return { positions: obj, updatedAt: typeof obj.updatedAt === "string" ? obj.updatedAt : undefined };
}

function mergePositionsJson(
	localPositionsRaw: string | undefined,
	remotePositionsRaw: string | undefined,
	fallbackLocalUpdatedAt: string,
	fallbackRemoteUpdatedAt: string,
): string | undefined {
	const local = parsePositionsMap(localPositionsRaw);
	const remote = parsePositionsMap(remotePositionsRaw);
	if (!local && !remote) return undefined;
	const localUpdatedAt = local?.updatedAt ?? fallbackLocalUpdatedAt;
	const remoteUpdatedAt = remote?.updatedAt ?? fallbackRemoteUpdatedAt;
	const remoteIsNewer = compareIso(remoteUpdatedAt, localUpdatedAt) > 0;

	const mergedPositions: Record<string, unknown> = {};
	const allNodeIds = new Set([...Object.keys(local?.positions ?? {}), ...Object.keys(remote?.positions ?? {})]);

	for (const id of allNodeIds) {
		const locPos = local?.positions[id];
		const remPos = remote?.positions[id];
		if (locPos && remPos) {
			mergedPositions[id] = remoteIsNewer ? remPos : locPos;
		} else {
			mergedPositions[id] = remPos ?? locPos;
		}
	}

	return JSON.stringify(
		{
			positions: mergedPositions,
			updatedAt: remoteIsNewer ? remoteUpdatedAt : localUpdatedAt,
		},
		null,
		"\t",
	);
}

export function mergeSyncSnapshots(
	local: SyncSnapshot,
	remote: SyncSnapshot,
	nowIso?: string,
): { ok: true; merged: SyncSnapshot } | { ok: false; error: string } {
	const ownerCheck = verifySameAccountOwner(local.manifest.owner, remote.manifest.owner);
	if (!ownerCheck.ok) {
		return { ok: false, error: ownerCheck.error };
	}

	const remoteManifestNewer = compareIso(remote.manifest.updatedAt, local.manifest.updatedAt) > 0;
	const chatMerge = mergeChatRecords(
		local.chats,
		remote.chats,
		local.manifest.deletedChats ?? {},
		remote.manifest.deletedChats ?? {},
	);
	const promptMerge = mergeTextFileMap(
		local.prompts ?? {},
		remote.prompts ?? {},
		local.manifest.deletedPrompts ?? {},
		remote.manifest.deletedPrompts ?? {},
	);
	const themeMerge = mergeTextFileMap(
		local.themes ?? {},
		remote.themes ?? {},
		local.manifest.deletedThemes ?? {},
		remote.manifest.deletedThemes ?? {},
	);

	// Deletions travel as manifest tombstones: a stale peer's copy of a deleted
	// graph source or node must not be resurrected by the union below. Sources
	// are pruned FIRST — a re-import newer than its tombstone clears the
	// tombstone, which in turn keeps that source's nodes and coverage alive.
	const sourcePrune = pruneSourcesJson(
		mergeSourcesJson(local.graphFiles?.sources, remote.graphFiles?.sources),
		mergeTombstoneMaps(local.manifest.deletedGraphSources, remote.manifest.deletedGraphSources),
	);
	const sources = sourcePrune.sources;
	const deletedGraphSources = sourcePrune.tombstones;

	const nodeResult = reconcileNodeLedger(
		mergeJsonlLedger(local.graphLedgers.nodes ?? "", remote.graphLedgers.nodes ?? ""),
		deletedGraphSources,
		mergeTombstoneMaps(local.manifest.deletedGraphNodes, remote.manifest.deletedGraphNodes),
	);
	const chainResult = reconcileChainLedger(
		mergeJsonlLedger(local.graphLedgers.chains ?? "", remote.graphLedgers.chains ?? ""),
		deletedGraphSources,
		nodeResult.deadNodes,
		nodeResult.deletedGraphNodes,
	);
	const nodes = nodeResult.nodes;
	const chains = chainResult.chains;
	const deletedGraphNodes = chainResult.deletedGraphNodes;

	// Coverage rows and session checkpoints key off chatId, which is also the
	// graph-source id, so chat deletion and graph deletion both suppress them.
	const deadLedgerChatIds = new Set([...Object.keys(chatMerge.deletedChats), ...Object.keys(deletedGraphSources)]);
	const sessions = filterLedgerByChatId(
		mergeJsonlLedger(local.graphLedgers.sessions ?? "", remote.graphLedgers.sessions ?? ""),
		deadLedgerChatIds,
	);
	const coverage = filterLedgerByChatId(
		mergeJsonlLedger(local.graphLedgers.coverage ?? "", remote.graphLedgers.coverage ?? ""),
		deadLedgerChatIds,
	);

	const positions = prunePositionsJson(
		mergePositionsJson(
			local.graphFiles?.positions,
			remote.graphFiles?.positions,
			local.manifest.updatedAt,
			remote.manifest.updatedAt,
		),
		new Set([...nodeResult.deadNodes, ...chainResult.deadChains]),
	);

	const mergedOrganization = remoteManifestNewer
		? (remote.graphFiles?.sourceOrganization ?? local.graphFiles?.sourceOrganization)
		: (local.graphFiles?.sourceOrganization ?? remote.graphFiles?.sourceOrganization);
	const sourceOrganization = pruneSourceOrganizationJson(mergedOrganization, deletedGraphSources);

	const renderSettings = remoteManifestNewer
		? (remote.graphFiles?.renderSettings ?? local.graphFiles?.renderSettings)
		: (local.graphFiles?.renderSettings ?? remote.graphFiles?.renderSettings);

	const localSettingsTime = local.settingsUpdatedAt ?? local.manifest.updatedAt;
	const remoteSettingsTime = remote.settingsUpdatedAt ?? remote.manifest.updatedAt;
	const pickRemoteSettings = compareIso(remoteSettingsTime, localSettingsTime) > 0;
	const rawSettings = pickRemoteSettings
		? (remote.settings ?? local.settings)
		: (local.settings ?? remote.settings);
	const settings = rawSettings ? sanitizeUserSettings(rawSettings) : null;
	const settingsUpdatedAt = pickRemoteSettings
		? (remote.settingsUpdatedAt ?? remote.manifest.updatedAt)
		: (local.settingsUpdatedAt ?? local.manifest.updatedAt);

	const mergedUpdatedAt = nowIso ?? (remoteManifestNewer ? remote.manifest.updatedAt : local.manifest.updatedAt);

	const merged: SyncSnapshot = {
		manifest: {
			version: 1,
			owner: ownerCheck.owner,
			updatedAt: mergedUpdatedAt,
			deletedChats: chatMerge.deletedChats,
			deletedPrompts: promptMerge.deleted,
			deletedThemes: themeMerge.deleted,
			...(Object.keys(deletedGraphSources).length > 0 ? { deletedGraphSources } : {}),
			...(Object.keys(deletedGraphNodes).length > 0 ? { deletedGraphNodes } : {}),
		},
		chats: chatMerge.chats,
		graphLedgers: { nodes, chains, sessions, coverage },
		graphFiles: {
			...(sources !== undefined ? { sources } : {}),
			...(positions !== undefined ? { positions } : {}),
			...(sourceOrganization !== undefined ? { sourceOrganization } : {}),
			...(renderSettings !== undefined ? { renderSettings } : {}),
		},
		settings,
		settingsUpdatedAt,
		prompts: promptMerge.files,
		themes: themeMerge.files,
	};

	return { ok: true, merged };
}
