import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { AUTH_FILE, PATHS } from "../../config.ts";
import {
	emit,
	mergeSyncSnapshots,
	sanitizeUserSettings,
	subscribe,
	verifySameAccountOwner,
	type ChatRecord,
	type SyncManifest,
	type SyncSnapshot,
	type SyncStatus,
	type SyncTextFile,
	type UserSettings,
} from "../core/index.ts";
import { removeLeftoverTemps, writeFileAtomicSync } from "../store/atomic-write.ts";

const INTERNAL_SYNC_KEYS = new Set(["LH_SYNC_GITHUB_TOKEN", "LH_SYNC_PASSPHRASE"]);
const DEFAULT_SYNC_REPO = "learnharness-sync";
const GITHUB_API_BASE = "https://api.github.com";

export interface GitHubSyncPort {
	verifyToken(token: string): Promise<{ login: string }>;
	ensurePrivateRepo(
		token: string,
		owner: string,
		repo: string,
	): Promise<{ owner: string; repo: string; private: boolean }>;
	readRemoteFiles(token: string, owner: string, repo: string): Promise<Record<string, string> | null>;
	writeRemoteFiles(
		token: string,
		owner: string,
		repo: string,
		files: Record<string, string>,
		message: string,
	): Promise<void>;
}

interface LocalSyncConfig {
	repo: string;
	owner: string | null;
	autoSync: boolean;
	syncApiKeys: boolean;
	lastSyncedAt: string | null;
	lastError: string | null;
	deletedChats: Record<string, string>;
	deletedPrompts: Record<string, string>;
	deletedThemes: Record<string, string>;
}

interface LocalSyncSecrets {
	token: string;
	passphrase?: string;
}

interface EncryptedVaultPayload {
	v: 1;
	salt: string;
	iv: string;
	tag: string;
	ciphertext: string;
}

interface SyncMeta {
	settingsUpdatedAt?: string;
	promptUpdatedAt?: Record<string, string>;
	themeUpdatedAt?: Record<string, string>;
}

function isRecord(val: unknown): val is Record<string, unknown> {
	return val !== null && typeof val === "object" && !Array.isArray(val);
}

function deriveVaultKey(owner: string, salt: Buffer, passphrase?: string): Buffer {
	const trimmedPassphrase = passphrase?.trim();
	const secret =
		trimmedPassphrase && trimmedPassphrase.length > 0
			? trimmedPassphrase
			: `lh-sync-v1:${owner.trim().toLowerCase()}`;
	return crypto.scryptSync(secret, salt, 32);
}

function filterSyncableKeys(keys: Record<string, string>): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(keys)) {
		if (!INTERNAL_SYNC_KEYS.has(k) && typeof v === "string") {
			out[k] = v;
		}
	}
	return out;
}

export function encryptAuthVault(
	keys: Record<string, string>,
	owner: string,
	passphrase?: string,
): string {
	const salt = crypto.randomBytes(16);
	const iv = crypto.randomBytes(12);
	const key = deriveVaultKey(owner, salt, passphrase);
	const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
	const plaintext = Buffer.from(JSON.stringify(filterSyncableKeys(keys)), "utf-8");
	const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
	const tag = cipher.getAuthTag();

	const payload: EncryptedVaultPayload = {
		v: 1,
		salt: salt.toString("base64"),
		iv: iv.toString("base64"),
		tag: tag.toString("base64"),
		ciphertext: ciphertext.toString("base64"),
	};
	return JSON.stringify(payload, null, "\t");
}

export function decryptAuthVault(
	rawPayload: string,
	owner: string,
	passphrase?: string,
): Record<string, string> {
	const parsed: unknown = JSON.parse(rawPayload);
	if (
		!isRecord(parsed) ||
		parsed.v !== 1 ||
		typeof parsed.salt !== "string" ||
		typeof parsed.iv !== "string" ||
		typeof parsed.tag !== "string" ||
		typeof parsed.ciphertext !== "string"
	) {
		throw new Error("Invalid encrypted auth vault format");
	}

	const salt = Buffer.from(parsed.salt, "base64");
	const iv = Buffer.from(parsed.iv, "base64");
	const tag = Buffer.from(parsed.tag, "base64");
	const ciphertext = Buffer.from(parsed.ciphertext, "base64");

	if (salt.length !== 16 || iv.length !== 12 || tag.length !== 16) {
		throw new Error("Invalid encrypted auth vault parameters");
	}

	const key = deriveVaultKey(owner, salt, passphrase);
	const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
	decipher.setAuthTag(tag);
	const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf-8");
	const decoded: unknown = JSON.parse(plaintext);
	if (!isRecord(decoded)) {
		throw new Error("Decrypted auth vault must be a JSON object");
	}

	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(decoded)) {
		if (!INTERNAL_SYNC_KEYS.has(k) && typeof v === "string") {
			out[k] = v;
		}
	}
	return out;
}

function configPath(dataDir: string): string {
	return path.join(dataDir, "sync-config.json");
}

function secretsPath(dataDir: string): string {
	return path.join(dataDir, "sync-secrets.json");
}

function defaultSyncConfig(): LocalSyncConfig {
	return {
		repo: DEFAULT_SYNC_REPO,
		owner: null,
		autoSync: true,
		syncApiKeys: true,
		lastSyncedAt: null,
		lastError: null,
		deletedChats: {},
		deletedPrompts: {},
		deletedThemes: {},
	};
}

function readSyncConfig(dataDir: string): LocalSyncConfig {
	const file = configPath(dataDir);
	try {
		const raw: unknown = JSON.parse(fs.readFileSync(file, "utf-8"));
		if (!isRecord(raw)) return defaultSyncConfig();
		const toStringRecord = (val: unknown): Record<string, string> => {
			if (!isRecord(val)) return {};
			const out: Record<string, string> = {};
			for (const [k, v] of Object.entries(val)) {
				if (typeof v === "string") out[k] = v;
			}
			return out;
		};
		return {
			repo: typeof raw.repo === "string" && raw.repo.trim() ? raw.repo.trim() : DEFAULT_SYNC_REPO,
			owner: typeof raw.owner === "string" && raw.owner.trim() ? raw.owner.trim() : null,
			autoSync: typeof raw.autoSync === "boolean" ? raw.autoSync : true,
			syncApiKeys: typeof raw.syncApiKeys === "boolean" ? raw.syncApiKeys : true,
			lastSyncedAt: typeof raw.lastSyncedAt === "string" ? raw.lastSyncedAt : null,
			lastError: typeof raw.lastError === "string" ? raw.lastError : null,
			deletedChats: toStringRecord(raw.deletedChats),
			deletedPrompts: toStringRecord(raw.deletedPrompts),
			deletedThemes: toStringRecord(raw.deletedThemes),
		};
	} catch {
		return defaultSyncConfig();
	}
}

function writeSyncConfig(dataDir: string, config: LocalSyncConfig): void {
	fs.mkdirSync(dataDir, { recursive: true });
	writeFileAtomicSync(configPath(dataDir), `${JSON.stringify(config, null, "\t")}\n`, { mode: 0o600 });
}

function readSyncSecrets(dataDir: string): LocalSyncSecrets | null {
	try {
		const raw: unknown = JSON.parse(fs.readFileSync(secretsPath(dataDir), "utf-8"));
		if (!isRecord(raw) || typeof raw.token !== "string" || !raw.token.trim()) return null;
		return {
			token: raw.token.trim(),
			passphrase: typeof raw.passphrase === "string" && raw.passphrase.length > 0 ? raw.passphrase : undefined,
		};
	} catch {
		return null;
	}
}

function writeSyncSecrets(dataDir: string, secrets: LocalSyncSecrets): void {
	fs.mkdirSync(dataDir, { recursive: true });
	writeFileAtomicSync(secretsPath(dataDir), `${JSON.stringify(secrets, null, "\t")}\n`, { mode: 0o600 });
}

function clearSyncSecrets(dataDir: string): void {
	const file = secretsPath(dataDir);
	try {
		fs.rmSync(file, { force: true });
		removeLeftoverTemps(file);
	} catch {
		// ignore
	}
}

export function recordChatDeleted(chatId: string, dataDir: string = PATHS.data): void {
	if (!chatId) return;
	const config = readSyncConfig(dataDir);
	config.deletedChats[chatId] = new Date().toISOString();
	writeSyncConfig(dataDir, config);
}

export function recordPromptDeleted(relPath: string, dataDir: string = PATHS.data): void {
	if (!relPath) return;
	const config = readSyncConfig(dataDir);
	config.deletedPrompts[relPath] = new Date().toISOString();
	writeSyncConfig(dataDir, config);
}

export function recordThemeDeleted(themeId: string, dataDir: string = PATHS.data): void {
	if (!themeId) return;
	const config = readSyncConfig(dataDir);
	const fileName = themeId.endsWith(".json") ? themeId : `${themeId}.json`;
	config.deletedThemes[fileName] = new Date().toISOString();
	writeSyncConfig(dataDir, config);
}

function githubHeaders(token: string): Record<string, string> {
	return {
		Authorization: `Bearer ${token}`,
		"User-Agent": "LearnHarness-Sync",
		Accept: "application/vnd.github+json",
		"Content-Type": "application/json",
	};
}

export const githubHttpAdapter: GitHubSyncPort = {
	async verifyToken(token: string): Promise<{ login: string }> {
		const res = await fetch(`${GITHUB_API_BASE}/user`, {
			headers: githubHeaders(token),
		});
		if (!res.ok) {
			throw new Error(`GitHub token verification failed (${res.status})`);
		}
		const data: unknown = await res.json();
		if (!isRecord(data) || typeof data.login !== "string" || !data.login.trim()) {
			throw new Error("GitHub user response missing login");
		}
		return { login: data.login.trim() };
	},

	async ensurePrivateRepo(
		token: string,
		owner: string,
		repo: string,
	): Promise<{ owner: string; repo: string; private: boolean }> {
		const headers = githubHeaders(token);
		const checkRes = await fetch(`${GITHUB_API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, {
			headers,
		});
		if (checkRes.ok) {
			const data: unknown = await checkRes.json();
			if (!isRecord(data) || data.private !== true) {
				throw new Error(`Refusing to sync to a public repository: ${owner}/${repo}`);
			}
			return { owner, repo, private: true };
		}
		if (checkRes.status !== 404) {
			throw new Error(`Failed to inspect repository ${owner}/${repo} (${checkRes.status})`);
		}

		const createRes = await fetch(`${GITHUB_API_BASE}/user/repos`, {
			method: "POST",
			headers,
			body: JSON.stringify({
				name: repo,
				private: true,
				description: "LearnHarness private cross-device sync vault",
				auto_init: true,
			}),
		});
		if (!createRes.ok) {
			const text = await createRes.text().catch(() => "");
			throw new Error(`Failed to create private repository ${owner}/${repo} (${createRes.status}): ${text}`);
		}
		return { owner, repo, private: true };
	},

	async readRemoteFiles(token: string, owner: string, repo: string): Promise<Record<string, string> | null> {
		const headers = githubHeaders(token);
		const base = `${GITHUB_API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
		const treeRes = await fetch(`${base}/git/trees/HEAD?recursive=1`, { headers });
		if (treeRes.status === 404 || treeRes.status === 409) {
			return null;
		}
		if (!treeRes.ok) {
			throw new Error(`Failed to read remote repository tree (${treeRes.status})`);
		}
		const treeData: unknown = await treeRes.json();
		if (!isRecord(treeData) || !Array.isArray(treeData.tree)) {
			return null;
		}

		const files: Record<string, string> = {};
		for (const item of treeData.tree) {
			if (!isRecord(item) || item.type !== "blob" || typeof item.path !== "string" || typeof item.sha !== "string") {
				continue;
			}
			const blobRes = await fetch(`${base}/git/blobs/${encodeURIComponent(item.sha)}`, { headers });
			if (!blobRes.ok) {
				throw new Error(`Failed to fetch remote file ${item.path} (${blobRes.status})`);
			}
			const blobData: unknown = await blobRes.json();
			if (isRecord(blobData) && typeof blobData.content === "string") {
				files[item.path] =
					blobData.encoding === "base64"
						? Buffer.from(blobData.content, "base64").toString("utf-8")
						: blobData.content;
			}
		}
		return files;
	},

	async writeRemoteFiles(
		token: string,
		owner: string,
		repo: string,
		files: Record<string, string>,
		message: string,
	): Promise<void> {
		const headers = githubHeaders(token);
		const base = `${GITHUB_API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;

		let branch = "main";
		let parentCommitSha: string | null = null;

		const repoRes = await fetch(base, { headers });
		if (repoRes.ok) {
			const repoInfo: unknown = await repoRes.json();
			if (isRecord(repoInfo) && typeof repoInfo.default_branch === "string" && repoInfo.default_branch) {
				branch = repoInfo.default_branch;
			}
		}

		const refRes = await fetch(`${base}/git/refs/heads/${encodeURIComponent(branch)}`, { headers });
		if (refRes.ok) {
			const refData: unknown = await refRes.json();
			if (isRecord(refData) && isRecord(refData.object) && typeof refData.object.sha === "string") {
				parentCommitSha = refData.object.sha;
			}
		}

		const treeEntries: Array<{ path: string; mode: string; type: string; sha: string }> = [];
		for (const [filePath, content] of Object.entries(files)) {
			const blobRes = await fetch(`${base}/git/blobs`, {
				method: "POST",
				headers,
				body: JSON.stringify({ content, encoding: "utf-8" }),
			});
			if (!blobRes.ok) {
				throw new Error(`Failed to upload blob for ${filePath} (${blobRes.status})`);
			}
			const blobData: unknown = await blobRes.json();
			if (!isRecord(blobData) || typeof blobData.sha !== "string") {
				throw new Error(`Invalid blob response for ${filePath}`);
			}
			treeEntries.push({
				path: filePath,
				mode: "100644",
				type: "blob",
				sha: blobData.sha,
			});
		}

		const treeRes = await fetch(`${base}/git/trees`, {
			method: "POST",
			headers,
			body: JSON.stringify({ tree: treeEntries }),
		});
		if (!treeRes.ok) {
			throw new Error(`Failed to create Git tree (${treeRes.status})`);
		}
		const treeData: unknown = await treeRes.json();
		if (!isRecord(treeData) || typeof treeData.sha !== "string") {
			throw new Error("Invalid tree response");
		}

		const commitRes = await fetch(`${base}/git/commits`, {
			method: "POST",
			headers,
			body: JSON.stringify({
				message,
				tree: treeData.sha,
				parents: parentCommitSha ? [parentCommitSha] : [],
			}),
		});
		if (!commitRes.ok) {
			throw new Error(`Failed to create commit (${commitRes.status})`);
		}
		const commitData: unknown = await commitRes.json();
		if (!isRecord(commitData) || typeof commitData.sha !== "string") {
			throw new Error("Invalid commit response");
		}

		if (parentCommitSha) {
			const updateRes = await fetch(`${base}/git/refs/heads/${encodeURIComponent(branch)}`, {
				method: "PATCH",
				headers,
				body: JSON.stringify({ sha: commitData.sha }),
			});
			if (!updateRes.ok) {
				const text = await updateRes.text().catch(() => "");
				throw new Error(`Failed to update branch ref ${branch} (${updateRes.status}): ${text}`);
			}
		} else {
			const createRefRes = await fetch(`${base}/git/refs`, {
				method: "POST",
				headers,
				body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: commitData.sha }),
			});
			if (!createRefRes.ok) {
				throw new Error(`Failed to create branch ref ${branch} (${createRefRes.status})`);
			}
		}
	},
};

function readTextIfExists(filePath: string): string | undefined {
	try {
		return fs.readFileSync(filePath, "utf-8");
	} catch {
		return undefined;
	}
}

function readLocalChats(dataDir: string): Record<string, ChatRecord> {
	const chatsDir = path.join(dataDir, "chats");
	const out: Record<string, ChatRecord> = {};
	let entries: string[];
	try {
		entries = fs.readdirSync(chatsDir);
	} catch {
		return out;
	}
	for (const name of entries) {
		if (!name.endsWith(".json") || name.includes(".tmp-")) continue;
		try {
			const raw: unknown = JSON.parse(fs.readFileSync(path.join(chatsDir, name), "utf-8"));
			if (isRecord(raw) && typeof raw.id === "string" && typeof raw.updatedAt === "string") {
				out[raw.id] = raw as unknown as ChatRecord;
			}
		} catch {
			// skip invalid chat JSON
		}
	}
	return out;
}

function readLocalTextDir(baseDir: string, extensionFilter?: string): Record<string, SyncTextFile> {
	const out: Record<string, SyncTextFile> = {};
	const walk = (dir: string, prefix: string) => {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (entry.name.includes(".tmp-")) continue;
			const full = path.join(dir, entry.name);
			const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
			if (entry.isDirectory()) {
				walk(full, rel);
			} else if (entry.isFile()) {
				if (extensionFilter && !entry.name.endsWith(extensionFilter)) continue;
				try {
					const stat = fs.statSync(full);
					const content = fs.readFileSync(full, "utf-8");
					out[rel] = { content, updatedAt: stat.mtime.toISOString() };
				} catch {
					// skip unreadable
				}
			}
		}
	};
	walk(baseDir, "");
	return out;
}

function readLocalSnapshot(dataDir: string, config: LocalSyncConfig): SyncSnapshot {
	const graphDir = path.join(dataDir, "graph");
	const settingsPath = path.join(dataDir, "settings.json");
	let settings: UserSettings | null = null;
	let settingsUpdatedAt: string | undefined;

	try {
		const stat = fs.statSync(settingsPath);
		const parsed: unknown = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
		settings = sanitizeUserSettings(parsed);
		settingsUpdatedAt = stat.mtime.toISOString();
	} catch {
		settings = null;
	}

	return {
		manifest: {
			version: 1,
			owner: config.owner ?? "",
			updatedAt: new Date().toISOString(),
			deletedChats: { ...config.deletedChats },
			deletedPrompts: { ...config.deletedPrompts },
			deletedThemes: { ...config.deletedThemes },
		},
		chats: readLocalChats(dataDir),
		graphLedgers: {
			nodes: readTextIfExists(path.join(graphDir, "nodes.jsonl")) ?? "",
			chains: readTextIfExists(path.join(graphDir, "chains.jsonl")) ?? "",
			sessions: readTextIfExists(path.join(graphDir, "sessions.jsonl")) ?? "",
			coverage: readTextIfExists(path.join(graphDir, "coverage.jsonl")) ?? "",
		},
		graphFiles: {
			sources: readTextIfExists(path.join(graphDir, "sources.json")),
			sourceOrganization: readTextIfExists(path.join(graphDir, "source-organization.json")),
			positions: readTextIfExists(path.join(graphDir, "positions.json")),
			renderSettings: readTextIfExists(path.join(graphDir, "render-settings.json")),
		},
		settings,
		settingsUpdatedAt,
		prompts: readLocalTextDir(path.join(dataDir, "prompts")),
		themes: readLocalTextDir(path.join(dataDir, "themes"), ".json"),
	};
}

function setFileMtime(filePath: string, iso: string | undefined): void {
	if (!iso) return;
	const ms = Date.parse(iso);
	if (Number.isNaN(ms)) return;
	const date = new Date(ms);
	try {
		fs.utimesSync(filePath, date, date);
	} catch {
		// ignore mtime failure
	}
}

function reconcileLocalDirectory(
	baseDir: string,
	mergedFiles: Record<string, SyncTextFile>,
	localFiles: Record<string, SyncTextFile>,
	deletedPaths: Record<string, string>,
): void {
	fs.mkdirSync(baseDir, { recursive: true });

	for (const [relPath, file] of Object.entries(mergedFiles)) {
		const captured = localFiles[relPath];
		if (captured && captured.content === file.content && captured.updatedAt === file.updatedAt) {
			continue;
		}

		const fullPath = path.join(baseDir, ...relPath.split("/"));
		let currentMtime: string | undefined;
		let currentContent: string | undefined;
		try {
			currentMtime = fs.statSync(fullPath).mtime.toISOString();
			currentContent = fs.readFileSync(fullPath, "utf-8");
		} catch {
			currentMtime = undefined;
			currentContent = undefined;
		}

		if (currentMtime !== captured?.updatedAt || currentContent !== captured?.content) {
			continue;
		}

		fs.mkdirSync(path.dirname(fullPath), { recursive: true });
		writeFileAtomicSync(fullPath, file.content);
		setFileMtime(fullPath, file.updatedAt);
	}

	for (const relPath of Object.keys(deletedPaths)) {
		if (Object.hasOwn(mergedFiles, relPath)) continue;
		const fullPath = path.join(baseDir, ...relPath.split("/"));
		if (!fs.existsSync(fullPath)) continue;
		const captured = localFiles[relPath];
		if (!captured) continue;
		try {
			const currentMtime = fs.statSync(fullPath).mtime.toISOString();
			const currentContent = fs.readFileSync(fullPath, "utf-8");
			if (currentMtime !== captured.updatedAt || currentContent !== captured.content) {
				continue;
			}
			fs.rmSync(fullPath, { force: true });
			removeLeftoverTemps(fullPath);
		} catch {
			// ignore
		}
	}
}

function readDiskChatUpdatedAt(filePath: string): string | undefined {
	try {
		const raw: unknown = JSON.parse(fs.readFileSync(filePath, "utf-8"));
		if (isRecord(raw) && typeof raw.updatedAt === "string") {
			return raw.updatedAt;
		}
		return undefined;
	} catch {
		return undefined;
	}
}

function writeMergedSnapshotToDisk(dataDir: string, snapshot: SyncSnapshot, localSnapshot: SyncSnapshot): void {
	// 1. Chats: only write changed chats when disk still matches captured updatedAt; only delete explicitly tombstoned chats
	const chatsDir = path.join(dataDir, "chats");
	fs.mkdirSync(chatsDir, { recursive: true });
	for (const [id, chat] of Object.entries(snapshot.chats)) {
		const captured = localSnapshot.chats[id];
		if (captured && JSON.stringify(chat) === JSON.stringify(captured)) {
			continue;
		}
		const filePath = path.join(chatsDir, `${id}.json`);
		const diskUpdatedAt = readDiskChatUpdatedAt(filePath);
		if (diskUpdatedAt !== captured?.updatedAt) {
			continue;
		}
		writeFileAtomicSync(filePath, `${JSON.stringify(chat, null, "\t")}\n`);
	}

	for (const id of Object.keys(snapshot.manifest.deletedChats)) {
		if (Object.hasOwn(snapshot.chats, id)) continue;
		const filePath = path.join(chatsDir, `${id}.json`);
		if (!fs.existsSync(filePath)) continue;
		const captured = localSnapshot.chats[id];
		if (!captured) continue;
		const diskUpdatedAt = readDiskChatUpdatedAt(filePath);
		if (diskUpdatedAt && diskUpdatedAt !== captured.updatedAt) {
			continue;
		}
		try {
			fs.rmSync(filePath, { force: true });
			removeLeftoverTemps(filePath);
		} catch {
			// ignore
		}
	}

	// 2. Graph ledgers & files
	const graphDir = path.join(dataDir, "graph");
	fs.mkdirSync(graphDir, { recursive: true });
	const writeIfNeeded = (filePath: string, content: string | undefined) => {
		if (content === undefined) return;
		if (content.length > 0 || fs.existsSync(filePath)) {
			writeFileAtomicSync(filePath, content);
		}
	};
	writeIfNeeded(path.join(graphDir, "nodes.jsonl"), snapshot.graphLedgers.nodes);
	writeIfNeeded(path.join(graphDir, "chains.jsonl"), snapshot.graphLedgers.chains);
	writeIfNeeded(path.join(graphDir, "sessions.jsonl"), snapshot.graphLedgers.sessions);
	writeIfNeeded(path.join(graphDir, "coverage.jsonl"), snapshot.graphLedgers.coverage);

	writeIfNeeded(path.join(graphDir, "sources.json"), snapshot.graphFiles.sources);
	writeIfNeeded(path.join(graphDir, "source-organization.json"), snapshot.graphFiles.sourceOrganization);
	writeIfNeeded(path.join(graphDir, "positions.json"), snapshot.graphFiles.positions);
	writeIfNeeded(path.join(graphDir, "render-settings.json"), snapshot.graphFiles.renderSettings);

	// 3. Settings
	if (snapshot.settings) {
		const settingsPath = path.join(dataDir, "settings.json");
		writeFileAtomicSync(settingsPath, `${JSON.stringify(snapshot.settings, null, "\t")}\n`);
		setFileMtime(settingsPath, snapshot.settingsUpdatedAt);
	}

	// 4. Prompts & Themes
	reconcileLocalDirectory(
		path.join(dataDir, "prompts"),
		snapshot.prompts,
		localSnapshot.prompts,
		snapshot.manifest.deletedPrompts ?? {},
	);
	reconcileLocalDirectory(
		path.join(dataDir, "themes"),
		snapshot.themes,
		localSnapshot.themes,
		snapshot.manifest.deletedThemes ?? {},
	);

	emit("chats-changed", {});
	emit("sources-changed", {});
	emit("activity-changed", {});
}

function deserializeRemoteSnapshot(files: Record<string, string>): SyncSnapshot {
	const rawManifest: unknown = JSON.parse(files["manifest.json"] ?? "{}");
	if (!isRecord(rawManifest) || typeof rawManifest.owner !== "string") {
		throw new Error("Remote manifest.json is invalid or missing owner");
	}
	const toStringMap = (val: unknown): Record<string, string> => {
		if (!isRecord(val)) return {};
		const out: Record<string, string> = {};
		for (const [k, v] of Object.entries(val)) {
			if (typeof v === "string") out[k] = v;
		}
		return out;
	};

	const manifest: SyncManifest = {
		version: 1,
		owner: rawManifest.owner,
		updatedAt: typeof rawManifest.updatedAt === "string" ? rawManifest.updatedAt : new Date(0).toISOString(),
		deletedChats: toStringMap(rawManifest.deletedChats),
		deletedPrompts: toStringMap(rawManifest.deletedPrompts),
		deletedThemes: toStringMap(rawManifest.deletedThemes),
	};

	let meta: SyncMeta = {};
	if (files["sync-meta.json"]) {
		try {
			const parsedMeta: unknown = JSON.parse(files["sync-meta.json"]);
			if (isRecord(parsedMeta)) {
				meta = {
					settingsUpdatedAt: typeof parsedMeta.settingsUpdatedAt === "string" ? parsedMeta.settingsUpdatedAt : undefined,
					promptUpdatedAt: toStringMap(parsedMeta.promptUpdatedAt),
					themeUpdatedAt: toStringMap(parsedMeta.themeUpdatedAt),
				};
			}
		} catch {
			// ignore corrupt meta
		}
	}

	const chats: Record<string, ChatRecord> = {};
	const prompts: Record<string, SyncTextFile> = {};
	const themes: Record<string, SyncTextFile> = {};

	for (const [filePath, content] of Object.entries(files)) {
		if (filePath.startsWith("chats/") && filePath.endsWith(".json")) {
			try {
				const parsed: unknown = JSON.parse(content);
				if (isRecord(parsed) && typeof parsed.id === "string" && typeof parsed.updatedAt === "string") {
					chats[parsed.id] = parsed as unknown as ChatRecord;
				}
			} catch {
				// skip corrupt remote chat
			}
		} else if (filePath.startsWith("prompts/")) {
			const rel = filePath.slice("prompts/".length);
			prompts[rel] = {
				content,
				updatedAt: meta.promptUpdatedAt?.[rel] ?? manifest.updatedAt,
			};
		} else if (filePath.startsWith("themes/") && filePath.endsWith(".json")) {
			const fileName = filePath.slice("themes/".length);
			themes[fileName] = {
				content,
				updatedAt: meta.themeUpdatedAt?.[fileName] ?? manifest.updatedAt,
			};
		}
	}

	let settings: UserSettings | null = null;
	if (files["settings.json"]) {
		try {
			settings = sanitizeUserSettings(JSON.parse(files["settings.json"]));
		} catch {
			settings = null;
		}
	}

	return {
		manifest,
		chats,
		graphLedgers: {
			nodes: files["graph/nodes.jsonl"] ?? "",
			chains: files["graph/chains.jsonl"] ?? "",
			sessions: files["graph/sessions.jsonl"] ?? "",
			coverage: files["graph/coverage.jsonl"] ?? "",
		},
		graphFiles: {
			...(files["graph/sources.json"] !== undefined ? { sources: files["graph/sources.json"] } : {}),
			...(files["graph/source-organization.json"] !== undefined
				? { sourceOrganization: files["graph/source-organization.json"] }
				: {}),
			...(files["graph/positions.json"] !== undefined ? { positions: files["graph/positions.json"] } : {}),
			...(files["graph/render-settings.json"] !== undefined
				? { renderSettings: files["graph/render-settings.json"] }
				: {}),
		},
		settings,
		settingsUpdatedAt: meta.settingsUpdatedAt ?? manifest.updatedAt,
		prompts,
		themes,
	};
}

function serializeSnapshotToRemoteFiles(snapshot: SyncSnapshot): Record<string, string> {
	const files: Record<string, string> = {};
	files["manifest.json"] = `${JSON.stringify(snapshot.manifest, null, "\t")}\n`;

	for (const [id, chat] of Object.entries(snapshot.chats)) {
		files[`chats/${id}.json`] = `${JSON.stringify(chat, null, "\t")}\n`;
	}

	if (snapshot.graphLedgers.nodes) files["graph/nodes.jsonl"] = snapshot.graphLedgers.nodes;
	if (snapshot.graphLedgers.chains) files["graph/chains.jsonl"] = snapshot.graphLedgers.chains;
	if (snapshot.graphLedgers.sessions) files["graph/sessions.jsonl"] = snapshot.graphLedgers.sessions;
	if (snapshot.graphLedgers.coverage) files["graph/coverage.jsonl"] = snapshot.graphLedgers.coverage;

	if (snapshot.graphFiles.sources !== undefined) files["graph/sources.json"] = snapshot.graphFiles.sources;
	if (snapshot.graphFiles.sourceOrganization !== undefined) {
		files["graph/source-organization.json"] = snapshot.graphFiles.sourceOrganization;
	}
	if (snapshot.graphFiles.positions !== undefined) files["graph/positions.json"] = snapshot.graphFiles.positions;
	if (snapshot.graphFiles.renderSettings !== undefined) {
		files["graph/render-settings.json"] = snapshot.graphFiles.renderSettings;
	}

	if (snapshot.settings) {
		files["settings.json"] = `${JSON.stringify(snapshot.settings, null, "\t")}\n`;
	}

	const promptUpdatedAt: Record<string, string> = {};
	for (const [rel, file] of Object.entries(snapshot.prompts)) {
		files[`prompts/${rel}`] = file.content;
		promptUpdatedAt[rel] = file.updatedAt;
	}

	const themeUpdatedAt: Record<string, string> = {};
	for (const [name, file] of Object.entries(snapshot.themes)) {
		files[`themes/${name}`] = file.content;
		themeUpdatedAt[name] = file.updatedAt;
	}

	const meta: SyncMeta = {
		settingsUpdatedAt: snapshot.settingsUpdatedAt,
		promptUpdatedAt,
		themeUpdatedAt,
	};
	files["sync-meta.json"] = `${JSON.stringify(meta, null, "\t")}\n`;

	return files;
}

function readAuthMap(authFile: string): Record<string, string> {
	try {
		const raw: unknown = JSON.parse(fs.readFileSync(authFile, "utf-8"));
		if (!isRecord(raw)) return {};
		const out: Record<string, string> = {};
		for (const [k, v] of Object.entries(raw)) {
			if (!INTERNAL_SYNC_KEYS.has(k) && typeof v === "string") {
				out[k] = v;
			}
		}
		return out;
	} catch {
		return {};
	}
}

function writeAuthMap(authFile: string, map: Record<string, string>): void {
	fs.mkdirSync(path.dirname(authFile), { recursive: true });
	writeFileAtomicSync(authFile, `${JSON.stringify(filterSyncableKeys(map), null, "\t")}\n`, { mode: 0o600 });
}

export interface CreateSyncServiceOptions {
	dataDir?: string;
	authFile?: string;
	github?: GitHubSyncPort;
}

export interface SyncService {
	getStatus(): SyncStatus;
	connect(input: {
		token: string;
		repo?: string;
		passphrase?: string;
		autoSync?: boolean;
		syncApiKeys?: boolean;
	}): Promise<{ ok: true; status: SyncStatus } | { ok: false; error: string }>;
	configure(input: {
		autoSync?: boolean;
		syncApiKeys?: boolean;
		passphrase?: string;
		repo?: string;
	}): Promise<SyncStatus>;
	disconnect(): Promise<SyncStatus>;
	syncNow(): Promise<{ ok: true; status: SyncStatus } | { ok: false; error: string }>;
}

export function createSyncService(options: CreateSyncServiceOptions = {}): SyncService {
	const dataDir = options.dataDir ?? PATHS.data;
	const authFile = options.authFile ?? AUTH_FILE;
	const github = options.github ?? githubHttpAdapter;

	let activeSync: Promise<{ ok: true; status: SyncStatus } | { ok: false; error: string }> | null = null;

	const getStatus = (): SyncStatus => {
		const config = readSyncConfig(dataDir);
		const secrets = readSyncSecrets(dataDir);
		return {
			connected: Boolean(secrets?.token && config.owner),
			owner: config.owner,
			repo: config.repo,
			autoSync: config.autoSync,
			syncApiKeys: config.syncApiKeys,
			hasPassphrase: Boolean(secrets?.passphrase),
			lastSyncedAt: config.lastSyncedAt,
			lastError: config.lastError,
			syncing: activeSync !== null,
		};
	};

	const runSync = async (): Promise<{ ok: true; status: SyncStatus } | { ok: false; error: string }> => {
		const config = readSyncConfig(dataDir);
		const secrets = readSyncSecrets(dataDir);

		if (!secrets?.token || !config.owner) {
			return { ok: false, error: "GitHub Sync is not connected" };
		}

		try {
			const localSnapshot = readLocalSnapshot(dataDir, config);
			const remoteFiles = await github.readRemoteFiles(secrets.token, config.owner, config.repo);

			let mergedSnapshot: SyncSnapshot;

			if (remoteFiles && remoteFiles["manifest.json"]) {
				const remoteSnapshot = deserializeRemoteSnapshot(remoteFiles);
				const mergeResult = mergeSyncSnapshots(localSnapshot, remoteSnapshot, new Date().toISOString());
				if (!mergeResult.ok) {
					config.lastError = mergeResult.error;
					writeSyncConfig(dataDir, config);
					return { ok: false, error: mergeResult.error };
				}
				mergedSnapshot = mergeResult.merged;

				if (config.syncApiKeys && remoteFiles["auth.enc.json"]) {
					const remoteKeys = decryptAuthVault(
						remoteFiles["auth.enc.json"],
						config.owner,
						secrets.passphrase,
					);
					const localKeys = readAuthMap(authFile);
					const mergedKeys: Record<string, string> = {};
					for (const [k, v] of Object.entries(remoteKeys)) {
						if (v) mergedKeys[k] = v;
					}
					for (const [k, v] of Object.entries(localKeys)) {
						if (v) mergedKeys[k] = v;
					}
					writeAuthMap(authFile, mergedKeys);
					for (const [k, v] of Object.entries(mergedKeys)) {
						if (v && (!process.env[k] || localKeys[k] === process.env[k])) {
							process.env[k] = v;
						}
					}
				}

				writeMergedSnapshotToDisk(dataDir, mergedSnapshot, localSnapshot);
			} else {
				mergedSnapshot = {
					...localSnapshot,
					manifest: {
						...localSnapshot.manifest,
						owner: config.owner,
						updatedAt: new Date().toISOString(),
					},
				};
			}

			const outgoingFiles = serializeSnapshotToRemoteFiles(mergedSnapshot);
			if (config.syncApiKeys) {
				const keysToEncrypt = readAuthMap(authFile);
				outgoingFiles["auth.enc.json"] = encryptAuthVault(keysToEncrypt, config.owner, secrets.passphrase);
			}

			await github.writeRemoteFiles(
				secrets.token,
				config.owner,
				config.repo,
				outgoingFiles,
				`LearnHarness sync ${mergedSnapshot.manifest.updatedAt}`,
			);

			const updatedConfig: LocalSyncConfig = {
				...config,
				lastSyncedAt: mergedSnapshot.manifest.updatedAt,
				lastError: null,
				deletedChats: mergedSnapshot.manifest.deletedChats,
				deletedPrompts: mergedSnapshot.manifest.deletedPrompts ?? {},
				deletedThemes: mergedSnapshot.manifest.deletedThemes ?? {},
			};
			writeSyncConfig(dataDir, updatedConfig);

			return { ok: true, status: getStatus() };
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			config.lastError = message;
			writeSyncConfig(dataDir, config);
			return { ok: false, error: message };
		}
	};

	const syncNow = async (): Promise<{ ok: true; status: SyncStatus } | { ok: false; error: string }> => {
		if (activeSync) {
			return activeSync;
		}
		activeSync = runSync().finally(() => {
			activeSync = null;
		});
		return activeSync;
	};

	const connect = async (input: {
		token: string;
		repo?: string;
		passphrase?: string;
		autoSync?: boolean;
		syncApiKeys?: boolean;
	}): Promise<{ ok: true; status: SyncStatus } | { ok: false; error: string }> => {
		try {
			const token = input.token.trim();
			if (!token) {
				return { ok: false, error: "GitHub token is required" };
			}
			const { login } = await github.verifyToken(token);
			const config = readSyncConfig(dataDir);

			if (config.owner) {
				const check = verifySameAccountOwner(config.owner, login);
				if (!check.ok) {
					return { ok: false, error: check.error };
				}
			}

			let repoName = input.repo?.trim() || config.repo || DEFAULT_SYNC_REPO;
			if (repoName.includes("/")) {
				const [repoOwner, name] = repoName.split("/", 2);
				const check = verifySameAccountOwner(login, repoOwner);
				if (!check.ok) {
					return { ok: false, error: check.error };
				}
				repoName = name || DEFAULT_SYNC_REPO;
			}

			await github.ensurePrivateRepo(token, login, repoName);

			writeSyncSecrets(dataDir, {
				token,
				passphrase: input.passphrase?.trim() || undefined,
			});

			writeSyncConfig(dataDir, {
				...config,
				owner: login,
				repo: repoName,
				autoSync: input.autoSync ?? config.autoSync,
				syncApiKeys: input.syncApiKeys ?? config.syncApiKeys,
				lastError: null,
			});

			return await syncNow();
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return { ok: false, error: message };
		}
	};

	const configure = async (input: {
		autoSync?: boolean;
		syncApiKeys?: boolean;
		passphrase?: string;
		repo?: string;
	}): Promise<SyncStatus> => {
		const config = readSyncConfig(dataDir);
		if (typeof input.autoSync === "boolean") config.autoSync = input.autoSync;
		if (typeof input.syncApiKeys === "boolean") config.syncApiKeys = input.syncApiKeys;
		if (typeof input.repo === "string" && input.repo.trim()) config.repo = input.repo.trim();
		writeSyncConfig(dataDir, config);

		if (input.passphrase !== undefined) {
			const secrets = readSyncSecrets(dataDir);
			if (secrets) {
				writeSyncSecrets(dataDir, {
					token: secrets.token,
					passphrase: input.passphrase.trim() || undefined,
				});
			}
		}

		return getStatus();
	};

	const disconnect = async (): Promise<SyncStatus> => {
		clearSyncSecrets(dataDir);
		const config = readSyncConfig(dataDir);
		config.lastError = null;
		writeSyncConfig(dataDir, config);
		return getStatus();
	};

	return {
		getStatus,
		connect,
		configure,
		disconnect,
		syncNow,
	};
}

export const syncService = createSyncService();

const AUTO_SYNC_DEBOUNCE_MS = 2500;
let autoSyncTimer: NodeJS.Timeout | undefined;

export function triggerAutoSync(): void {
	if (process.env.NODE_ENV === "test") return;
	const status = syncService.getStatus();
	if (!status.connected || !status.autoSync || status.syncing) return;
	clearTimeout(autoSyncTimer);
	autoSyncTimer = setTimeout(() => {
		autoSyncTimer = undefined;
		const current = syncService.getStatus();
		if (current.connected && current.autoSync && !current.syncing) {
			void syncService.syncNow();
		}
	}, AUTO_SYNC_DEBOUNCE_MS);
}

interface LhAutoSyncGlobal {
	__lhAutoSyncSubscribed?: boolean;
}

const g = globalThis as typeof globalThis & LhAutoSyncGlobal;
if (!g.__lhAutoSyncSubscribed) {
	g.__lhAutoSyncSubscribed = true;
	subscribe((event) => {
		if (
			event.type === "turn-settled" ||
			event.type === "chats-changed" ||
			event.type === "sources-changed" ||
			event.type === "activity-changed"
		) {
			triggerAutoSync();
		}
	});
	if (process.env.NODE_ENV !== "test") {
		setTimeout(() => {
			triggerAutoSync();
		}, 1000);
	}
}
