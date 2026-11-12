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

	const nodes = mergeJsonlLedger(local.graphLedgers.nodes ?? "", remote.graphLedgers.nodes ?? "");
	const chains = mergeJsonlLedger(local.graphLedgers.chains ?? "", remote.graphLedgers.chains ?? "");
	const sessions = mergeJsonlLedger(local.graphLedgers.sessions ?? "", remote.graphLedgers.sessions ?? "");
	const coverage = mergeJsonlLedger(local.graphLedgers.coverage ?? "", remote.graphLedgers.coverage ?? "");

	const sources = mergeSourcesJson(local.graphFiles?.sources, remote.graphFiles?.sources);
	const positions = mergePositionsJson(
		local.graphFiles?.positions,
		remote.graphFiles?.positions,
		local.manifest.updatedAt,
		remote.manifest.updatedAt,
	);

	const sourceOrganization = remoteManifestNewer
		? (remote.graphFiles?.sourceOrganization ?? local.graphFiles?.sourceOrganization)
		: (local.graphFiles?.sourceOrganization ?? remote.graphFiles?.sourceOrganization);

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
