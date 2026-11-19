import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { describe, it, beforeEach, afterEach } from "node:test";
import {
	encryptAuthVault,
	decryptAuthVault,
	createSyncService,
	recordChatDeleted,
	recordGraphNodeDeleted,
	recordGraphSourceDeleted,
	type GitHubSyncPort,
	type SyncService,
} from "../src/server/sync.ts";
import type { ChatRecord } from "../src/core/index.ts";

class InMemoryGitHubAdapter implements GitHubSyncPort {
	public repos = new Map<string, { private: boolean; files: Record<string, string> }>();
	public userLogins = new Map<string, string>();

	constructor() {
		this.userLogins.set("token_hmnty11", "hmnty11");
		this.userLogins.set("token_intruder", "intruder");
	}

	async verifyToken(token: string): Promise<{ login: string }> {
		const login = this.userLogins.get(token);
		if (!login) throw new Error("Bad credentials");
		return { login };
	}

	async ensurePrivateRepo(token: string, owner: string, repo: string): Promise<{ owner: string; repo: string; private: boolean }> {
		const key = `${owner.toLowerCase()}/${repo.toLowerCase()}`;
		const existing = this.repos.get(key);
		if (existing) {
			if (!existing.private) throw new Error(`Refusing to sync to a public repository: ${owner}/${repo}`);
			return { owner, repo, private: true };
		}
		this.repos.set(key, { private: true, files: {} });
		return { owner, repo, private: true };
	}

	async readRemoteFiles(_token: string, owner: string, repo: string): Promise<Record<string, string> | null> {
		const key = `${owner.toLowerCase()}/${repo.toLowerCase()}`;
		const repoData = this.repos.get(key);
		if (!repoData || Object.keys(repoData.files).length === 0) return null;
		return { ...repoData.files };
	}

	async writeRemoteFiles(_token: string, owner: string, repo: string, files: Record<string, string>, _message: string): Promise<void> {
		const key = `${owner.toLowerCase()}/${repo.toLowerCase()}`;
		const existing = this.repos.get(key) ?? { private: true, files: {} };
		existing.files = { ...files };
		this.repos.set(key, existing);
	}
}

describe("AES-256-GCM Auth Vault", () => {
	it("encrypts and decrypts with passphrase", () => {
		const keys = { OPENAI_API_KEY: "sk-test-123", ANTHROPIC_API_KEY: "sk-ant-456" };
		const payload = encryptAuthVault(keys, "hmnty11", "my-secret-passphrase");
		const decrypted = decryptAuthVault(payload, "hmnty11", "my-secret-passphrase");
		assert.deepEqual(decrypted, keys);
	});

	it("encrypts and decrypts with default owner key when no passphrase is provided", () => {
		const keys = { OPENAI_API_KEY: "sk-test-default" };
		const payload = encryptAuthVault(keys, "HMNTY11");
		const decrypted = decryptAuthVault(payload, "hmnty11");
		assert.deepEqual(decrypted, keys);
	});

	it("rejects decryption on wrong passphrase", () => {
		const keys = { OPENAI_API_KEY: "sk-test-fail" };
		const payload = encryptAuthVault(keys, "hmnty11", "correct-passphrase");
		assert.throws(() => {
			decryptAuthVault(payload, "hmnty11", "wrong-passphrase");
		});
	});

	it("rejects decryption if account owner differs", () => {
		const keys = { OPENAI_API_KEY: "sk-test-fail" };
		const payload = encryptAuthVault(keys, "hmnty11");
		assert.throws(() => {
			decryptAuthVault(payload, "other-user");
		});
	});
});

describe("GitHubSyncPort & Repo Security", () => {
	it("refuses to sync to a public repository", async () => {
		const github = new InMemoryGitHubAdapter();
		github.repos.set("hmnty11/public-repo", { private: false, files: {} });
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-sync-test-"));
		const authFile = path.join(tmpDir, "auth.json");
		const service = createSyncService({ dataDir: tmpDir, authFile, github });

		const res = await service.connect({
			token: "token_hmnty11",
			repo: "public-repo",
		});
		assert.equal(res.ok, false);
		if (!res.ok) {
			assert.match(res.error, /public/i);
		}
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});
});

describe("Multi-device Sync & Tombstone Deletion Integration", () => {
	let dirA: string;
	let dirB: string;
	let authA: string;
	let authB: string;
	let github: InMemoryGitHubAdapter;

	beforeEach(() => {
		dirA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-deviceA-"));
		dirB = fs.mkdtempSync(path.join(os.tmpdir(), "lh-deviceB-"));
		authA = path.join(dirA, "auth.json");
		authB = path.join(dirB, "auth.json");
		github = new InMemoryGitHubAdapter();

		fs.mkdirSync(path.join(dirA, "chats"), { recursive: true });
		fs.mkdirSync(path.join(dirA, "graph"), { recursive: true });
		fs.mkdirSync(path.join(dirA, "prompts", "skills", "math"), { recursive: true });
		fs.mkdirSync(path.join(dirA, "themes"), { recursive: true });

		fs.mkdirSync(path.join(dirB, "chats"), { recursive: true });
		fs.mkdirSync(path.join(dirB, "graph"), { recursive: true });
	});

	afterEach(() => {
		fs.rmSync(dirA, { recursive: true, force: true });
		fs.rmSync(dirB, { recursive: true, force: true });
	});

	it("simulates full two-device sync, key exchange, and tombstone propagation", async () => {
		// Device A creates chat c1, graph node n1, prompt skill, and an auth key
		const chat1: ChatRecord = {
			id: "c1",
			title: "Calculus",
			createdAt: "2026-11-10T10:00:00.000Z",
			updatedAt: "2026-11-10T10:00:00.000Z",
			messages: [],
		};
		fs.writeFileSync(path.join(dirA, "chats", "c1.json"), JSON.stringify(chat1, null, "\t"));
		fs.writeFileSync(path.join(dirA, "graph", "nodes.jsonl"), JSON.stringify({ id: "n1", label: "Derivatives" }) + "\n");
		fs.writeFileSync(path.join(dirA, "prompts", "skills", "math", "SKILL.md"), "# Math Skill\nDerive first principles.");
		fs.writeFileSync(authA, JSON.stringify({ OPENAI_API_KEY: "sk-deviceA-key" }, null, "\t"));

		const serviceA = createSyncService({ dataDir: dirA, authFile: authA, github });
		const connA = await serviceA.connect({
			token: "token_hmnty11",
			passphrase: "shared-secret-passphrase",
		});
		assert.equal(connA.ok, true);

		// Verify remote repo now holds encrypted auth and files
		const remoteFiles = await github.readRemoteFiles("token_hmnty11", "hmnty11", "learnharness-sync");
		assert.ok(remoteFiles);
		assert.ok(remoteFiles["manifest.json"]);
		assert.ok(remoteFiles["chats/c1.json"]);
		assert.ok(remoteFiles["auth.enc.json"]);
		assert.ok(remoteFiles["prompts/skills/math/SKILL.md"]);

		// Device B has its own chat c2
		const chat2: ChatRecord = {
			id: "c2",
			title: "Linear Algebra",
			createdAt: "2026-11-10T11:00:00.000Z",
			updatedAt: "2026-11-10T11:00:00.000Z",
			messages: [],
		};
		fs.writeFileSync(path.join(dirB, "chats", "c2.json"), JSON.stringify(chat2, null, "\t"));
		const serviceB = createSyncService({ dataDir: dirB, authFile: authB, github });
		const connB = await serviceB.connect({
			token: "token_hmnty11",
			passphrase: "shared-secret-passphrase",
		});
		assert.equal(connB.ok, true);

		// Device B should now have BOTH c1 and c2, nodes.jsonl, skills/math/SKILL.md, and decrypted auth key!
		assert.ok(fs.existsSync(path.join(dirB, "chats", "c1.json")), "c1 should be synced to Device B");
		assert.ok(fs.existsSync(path.join(dirB, "chats", "c2.json")), "c2 should remain on Device B");
		assert.ok(fs.existsSync(path.join(dirB, "prompts", "skills", "math", "SKILL.md")), "prompt skill should be synced to Device B");
		const authBData = JSON.parse(fs.readFileSync(authB, "utf-8")) as Record<string, string>;
		assert.equal(authBData.OPENAI_API_KEY, "sk-deviceA-key", "API keys should decrypt into auth.json on Device B");

		// Sync Device A again so Device A gets c2 as well
		const syncA2 = await serviceA.syncNow();
		assert.equal(syncA2.ok, true);
		assert.ok(fs.existsSync(path.join(dirA, "chats", "c2.json")), "Device A should now also have c2");

		// ─── Tombstone Deletion Test ───
		// Device A deletes c1
		fs.unlinkSync(path.join(dirA, "chats", "c1.json"));
		recordChatDeleted("c1", dirA);

		// Device A syncs deletion
		const syncA3 = await serviceA.syncNow();
		assert.equal(syncA3.ok, true);

		// Device B syncs
		const syncB2 = await serviceB.syncNow();
		assert.equal(syncB2.ok, true);

		// c1 must be gone from Device B!
		assert.equal(fs.existsSync(path.join(dirB, "chats", "c1.json")), false, "c1 must be deleted on Device B via tombstone");
		assert.ok(fs.existsSync(path.join(dirB, "chats", "c2.json")), "c2 must survive");
	});

	it("refuses sync when another account attempts to connect to existing repo", async () => {
		// Device A connects as hmnty11
		const serviceA = createSyncService({ dataDir: dirA, authFile: authA, github });
		await serviceA.connect({ token: "token_hmnty11" });

		// Device B attempts to connect as intruder specifying hmnty11's repo
		const serviceB = createSyncService({ dataDir: dirB, authFile: authB, github });
		const intruderConn = await serviceB.connect({ token: "token_intruder", repo: "hmnty11/learnharness-sync" });
		assert.equal(intruderConn.ok, false);
		if (!intruderConn.ok) {
			assert.match(intruderConn.error, /mismatch|intruder|hmnty11/i);
		}

		// Device B attempts to sync against a repo whose remote manifest belongs to hmnty11
		const hmnty11Repo = github.repos.get("hmnty11/learnharness-sync");
		assert.ok(hmnty11Repo);
		github.repos.set("intruder/shared-repo", { private: true, files: { ...hmnty11Repo.files } });
		fs.writeFileSync(path.join(dirB, "chats", "local-intruder.json"), JSON.stringify({ id: "local-intruder", title: "Mine", createdAt: "2026-11-10T10:00:00.000Z", updatedAt: "2026-11-10T10:00:00.000Z", messages: [] }));

		const intruderSharedConn = await serviceB.connect({ token: "token_intruder", repo: "shared-repo" });
		assert.equal(intruderSharedConn.ok, false);
		if (!intruderSharedConn.ok) {
			assert.match(intruderSharedConn.error, /mismatch|intruder|hmnty11/i);
		}
		assert.ok(fs.existsSync(path.join(dirB, "chats", "local-intruder.json")), "intruder local data must remain untouched");
	});

	it("preserves concurrently created and updated local files during network await", async () => {
		const chat1: ChatRecord = {
			id: "c1",
			title: "Original c1",
			createdAt: "2026-11-10T10:00:00.000Z",
			updatedAt: "2026-11-10T10:00:00.000Z",
			messages: [],
		};
		fs.writeFileSync(path.join(dirA, "chats", "c1.json"), JSON.stringify(chat1, null, "\t"));
		fs.writeFileSync(path.join(dirA, "prompts", "shared.md"), "initial local prompt");

		// Connect Device A
		const serviceA = createSyncService({ dataDir: dirA, authFile: authA, github });
		await serviceA.connect({ token: "token_hmnty11" });

		// Simulate remote having newer c1 and newer shared.md
		const repoData = github.repos.get("hmnty11/learnharness-sync")!;
		repoData.files["chats/c1.json"] = JSON.stringify({
			...chat1,
			title: "Remote Newer c1",
			updatedAt: "2026-11-10T11:00:00.000Z",
		});
		repoData.files["prompts/shared.md"] = "remote newer prompt";
		repoData.files["sync-meta.json"] = JSON.stringify({
			promptUpdatedAt: { "shared.md": "2026-11-10T11:00:00.000Z" },
			themeUpdatedAt: {},
		});
		const manifest = JSON.parse(repoData.files["manifest.json"]!) as { updatedAt: string };
		manifest.updatedAt = "2026-11-10T11:00:00.000Z";
		repoData.files["manifest.json"] = JSON.stringify(manifest);

		// Custom GitHub adapter hook: during readRemoteFiles (network await), local mutations occur
		const originalRead = github.readRemoteFiles.bind(github);
		github.readRemoteFiles = async (token, owner, repo) => {
			// 1. A new local chat is created during network await
			const newChat: ChatRecord = {
				id: "c_mid_sync",
				title: "Created Mid Sync",
				createdAt: "2026-11-10T14:00:00.000Z",
				updatedAt: "2026-11-10T14:00:00.000Z",
				messages: [],
			};
			fs.writeFileSync(path.join(dirA, "chats", "c_mid_sync.json"), JSON.stringify(newChat, null, "\t"));

			// 2. An existing local chat c1 gets a new turn persisted during network await
			const updatedChat: ChatRecord = {
				...chat1,
				title: "Updated Mid Sync",
				updatedAt: "2026-11-10T15:00:00.000Z",
				messages: [{ id: "m_new", role: "user", content: "newer message", timestamp: 1700000000000 }],
			};
			fs.writeFileSync(path.join(dirA, "chats", "c1.json"), JSON.stringify(updatedChat, null, "\t"));

			// 3. A new prompt is created and shared.md is edited during network await
			fs.writeFileSync(path.join(dirA, "prompts", "mid-sync.md"), "# Prompt Mid Sync");
			fs.writeFileSync(path.join(dirA, "prompts", "shared.md"), "local mid-sync prompt edit");
			return originalRead(token, owner, repo);
		};

		// Run syncNow
		const syncResult = await serviceA.syncNow();
		assert.equal(syncResult.ok, true);

		// 1. c_mid_sync must NOT be deleted (Issue 1)
		assert.ok(fs.existsSync(path.join(dirA, "chats", "c_mid_sync.json")), "c_mid_sync must not be deleted");

		// 2. c1 must NOT be overwritten with stale c1 (Issue 2)
		const c1OnDisk = JSON.parse(fs.readFileSync(path.join(dirA, "chats", "c1.json"), "utf-8")) as ChatRecord;
		assert.equal(c1OnDisk.title, "Updated Mid Sync", "c1 must retain its mid-sync updated title");
		assert.equal(c1OnDisk.updatedAt, "2026-11-10T15:00:00.000Z", "c1 must retain its mid-sync updatedAt");
		assert.equal(c1OnDisk.messages.length, 1, "c1 must retain its mid-sync messages");

		// 3. mid-sync prompt must NOT be deleted (Issue 1), and shared.md must NOT be overwritten (Issue 2)
		assert.ok(fs.existsSync(path.join(dirA, "prompts", "mid-sync.md")), "prompts/mid-sync.md must not be deleted");
		assert.equal(fs.readFileSync(path.join(dirA, "prompts", "shared.md"), "utf-8"), "local mid-sync prompt edit");
	});
});

describe("Graph deletion tombstones across devices", () => {
	let dirA: string;
	let dirB: string;
	let authA: string;
	let authB: string;
	let github: InMemoryGitHubAdapter;
	let serviceA: SyncService;
	let serviceB: SyncService;

	const CREATED_AT = "2026-11-10T08:00:00.000Z";

	const nodeLine = (over: Record<string, unknown> & { id: string }): string =>
		JSON.stringify({
			name: over.id,
			statement: `Statement of ${over.id}`,
			aliases: [],
			createdAt: CREATED_AT,
			provenance: [],
			...over,
		}) + "\n";

	const writeGraphFixture = (dir: string): void => {
		const graphDir = path.join(dir, "graph");
		fs.mkdirSync(graphDir, { recursive: true });
		fs.writeFileSync(
			path.join(graphDir, "nodes.jsonl"),
			nodeLine({ id: "n_live", provenance: [{ chatId: "c_live", messageId: "m1" }] }) +
				nodeLine({ id: "n_dead", provenance: [{ chatId: "src_dead", messageId: "" }] }),
		);
		fs.writeFileSync(
			path.join(graphDir, "chains.jsonl"),
			JSON.stringify({
				id: "arg_dead",
				premises: ["n_dead"],
				conclusion: "n_live",
				provenance: [{ chatId: "src_dead", messageId: "" }],
				createdAt: CREATED_AT,
			}) + "\n",
		);
		fs.writeFileSync(
			path.join(graphDir, "sessions.jsonl"),
			JSON.stringify({ chatId: "src_dead", foldedAt: CREATED_AT }) + "\n",
		);
		fs.writeFileSync(
			path.join(graphDir, "coverage.jsonl"),
			JSON.stringify({ chatId: "src_dead", fp: "abc123", tokens: 10, foldedAt: CREATED_AT }) + "\n",
		);
		fs.writeFileSync(
			path.join(graphDir, "sources.json"),
			JSON.stringify({ src_dead: { id: "src_dead", filePath: "notes/dead.md", importedAt: CREATED_AT } }, null, "\t"),
		);
		fs.writeFileSync(
			path.join(graphDir, "positions.json"),
			JSON.stringify({ positions: { n_dead: { x: 1, y: 2 } }, updatedAt: CREATED_AT }, null, "\t"),
		);
		fs.writeFileSync(
			path.join(graphDir, "source-organization.json"),
			JSON.stringify({ version: 1, folders: [], placements: { src_dead: { folderId: null } } }, null, "\t"),
		);
	};

	/** Disk state left by deleteSourcesTraces(..., "delete-nodes") + deleteSources. */
	const writeGraphWithoutDeadSource = (dir: string): void => {
		const graphDir = path.join(dir, "graph");
		fs.writeFileSync(
			path.join(graphDir, "nodes.jsonl"),
			nodeLine({ id: "n_live", provenance: [{ chatId: "c_live", messageId: "m1" }] }),
		);
		fs.writeFileSync(path.join(graphDir, "chains.jsonl"), "");
		fs.writeFileSync(path.join(graphDir, "sessions.jsonl"), "");
		fs.writeFileSync(path.join(graphDir, "coverage.jsonl"), "");
		fs.writeFileSync(path.join(graphDir, "sources.json"), JSON.stringify({}, null, "\t"));
		fs.writeFileSync(
			path.join(graphDir, "positions.json"),
			JSON.stringify({ positions: {}, updatedAt: CREATED_AT }, null, "\t"),
		);
		fs.writeFileSync(
			path.join(graphDir, "source-organization.json"),
			JSON.stringify({ version: 1, folders: [], placements: {} }, null, "\t"),
		);
	};

	const remoteFiles = (): Record<string, string> => github.repos.get("hmnty11/learnharness-sync")!.files;
	const localFile = (dir: string, rel: string): string => fs.readFileSync(path.join(dir, ...rel.split("/")), "utf-8");
	const syncConfigOf = (dir: string): Record<string, Record<string, string>> =>
		JSON.parse(fs.readFileSync(path.join(dir, "sync-config.json"), "utf-8")) as Record<string, Record<string, string>>;

	beforeEach(async () => {
		dirA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-graphA-"));
		dirB = fs.mkdtempSync(path.join(os.tmpdir(), "lh-graphB-"));
		authA = path.join(dirA, "auth.json");
		authB = path.join(dirB, "auth.json");
		github = new InMemoryGitHubAdapter();
		fs.mkdirSync(path.join(dirA, "chats"), { recursive: true });
		fs.mkdirSync(path.join(dirB, "chats"), { recursive: true });
		writeGraphFixture(dirA);

		serviceA = createSyncService({ dataDir: dirA, authFile: authA, github });
		assert.equal((await serviceA.connect({ token: "token_hmnty11" })).ok, true);

		serviceB = createSyncService({ dataDir: dirB, authFile: authB, github });
		assert.equal((await serviceB.connect({ token: "token_hmnty11" })).ok, true);
		assert.ok(localFile(dirB, "graph/nodes.jsonl").includes("n_dead"), "device B starts with the stale copy");
	});

	afterEach(() => {
		fs.rmSync(dirA, { recursive: true, force: true });
		fs.rmSync(dirB, { recursive: true, force: true });
	});

	it("does not resurrect a deleted graph source on a stale device", async () => {
		writeGraphWithoutDeadSource(dirA);
		recordGraphSourceDeleted("src_dead", dirA);

		assert.equal((await serviceA.syncNow()).ok, true);

		const remote = remoteFiles();
		assert.equal(remote["graph/nodes.jsonl"]?.includes("n_dead") ?? false, false, "remote must not carry the deleted node");
		assert.equal(remote["graph/chains.jsonl"]?.includes("arg_dead") ?? false, false, "remote must not carry the dead chain");
		assert.equal(remote["graph/sources.json"]?.includes("src_dead") ?? false, false, "remote must not carry the deleted source");
		const remoteManifest = JSON.parse(remote["manifest.json"]!) as { deletedGraphSources?: Record<string, string> };
		assert.ok(remoteManifest.deletedGraphSources?.src_dead, "remote manifest carries the source tombstone");

		// Stale device B still has every deleted row on disk.
		assert.equal((await serviceB.syncNow()).ok, true);

		assert.equal(localFile(dirB, "graph/nodes.jsonl").includes("n_dead"), false, "deleted-source node must not survive on B");
		assert.equal(localFile(dirB, "graph/chains.jsonl").includes("arg_dead"), false, "dead chain must not survive on B");
		assert.equal(localFile(dirB, "graph/sessions.jsonl").includes("src_dead"), false, "session checkpoint must not survive on B");
		assert.equal(localFile(dirB, "graph/coverage.jsonl").includes("src_dead"), false, "coverage must not survive on B");
		assert.equal(localFile(dirB, "graph/sources.json").includes("src_dead"), false, "source entry must not survive on B");
		assert.equal(localFile(dirB, "graph/positions.json").includes("n_dead"), false, "resting position must not survive on B");
		assert.equal(
			localFile(dirB, "graph/source-organization.json").includes("src_dead"),
			false,
			"folder placement must not survive on B",
		);
		assert.ok(localFile(dirB, "graph/nodes.jsonl").includes("n_live"), "untouched node must survive on B");
		assert.equal(typeof syncConfigOf(dirB).deletedGraphSources?.src_dead, "string", "B persists the merged tombstone");
	});

	it("does not resurrect a deleted node on a stale device", async () => {
		const graphDir = path.join(dirA, "graph");
		fs.writeFileSync(
			path.join(graphDir, "nodes.jsonl"),
			nodeLine({ id: "n_live", provenance: [{ chatId: "c_live", messageId: "m1" }] }),
		);
		fs.writeFileSync(path.join(graphDir, "chains.jsonl"), "");
		fs.writeFileSync(
			path.join(graphDir, "positions.json"),
			JSON.stringify({ positions: {}, updatedAt: CREATED_AT }, null, "\t"),
		);
		recordGraphNodeDeleted("n_dead", dirA);

		assert.equal((await serviceA.syncNow()).ok, true);
		assert.equal(remoteFiles()["graph/nodes.jsonl"]?.includes("n_dead") ?? false, false, "remote must not carry the deleted node");

		assert.equal((await serviceB.syncNow()).ok, true);
		assert.equal(localFile(dirB, "graph/nodes.jsonl").includes("n_dead"), false, "deleted node must not survive on B");
		assert.equal(localFile(dirB, "graph/chains.jsonl").includes("arg_dead"), false, "chain on a dead node must not survive on B");
		assert.equal(localFile(dirB, "graph/positions.json").includes("n_dead"), false, "resting position must not survive on B");
		assert.ok(localFile(dirB, "graph/nodes.jsonl").includes("n_live"), "untouched node must survive on B");
		assert.equal(typeof syncConfigOf(dirB).deletedGraphNodes?.n_dead, "string", "B persists the merged tombstone");
	});

	it("unions graph tombstones by newest timestamp across devices", async () => {
		const graphDir = path.join(dirA, "graph");
		fs.writeFileSync(path.join(graphDir, "nodes.jsonl"), nodeLine({ id: "n_live" }));
		fs.writeFileSync(path.join(graphDir, "positions.json"), JSON.stringify({ positions: {} }, null, "\t"));
		recordGraphNodeDeleted("n_dead", dirA);
		assert.equal((await serviceA.syncNow()).ok, true);

		// Device B's local record is NEWER than the remote's tombstone — the max must win.
		const future = "2099-01-01T00:00:00.000Z";
		const configB = syncConfigOf(dirB);
		configB.deletedGraphNodes = { ...(configB.deletedGraphNodes ?? {}), n_dead: future };
		fs.writeFileSync(path.join(dirB, "sync-config.json"), JSON.stringify(configB, null, "\t"));
		assert.equal((await serviceB.syncNow()).ok, true);

		const remoteManifest = JSON.parse(remoteFiles()["manifest.json"]!) as { deletedGraphNodes?: Record<string, string> };
		assert.equal(remoteManifest.deletedGraphNodes?.n_dead, future, "the newer tombstone wins the union");
		assert.equal(syncConfigOf(dirB).deletedGraphNodes?.n_dead, future, "B keeps the winning timestamp");
		assert.equal(localFile(dirB, "graph/nodes.jsonl").includes("n_dead"), false);
	});

	it("keeps a source re-imported after its tombstone and clears the tombstone", async () => {
		writeGraphWithoutDeadSource(dirA);
		recordGraphSourceDeleted("src_dead", dirA);
		assert.equal((await serviceA.syncNow()).ok, true);
		assert.equal(remoteFiles()["graph/nodes.jsonl"]?.includes("n_dead") ?? false, false);

		// Re-import on A: the source's importedAt and the new node's createdAt both
		// postdate the tombstone.
		const graphDir = path.join(dirA, "graph");
		const importedAt = new Date(Date.now() + 60_000).toISOString();
		fs.writeFileSync(
			path.join(graphDir, "sources.json"),
			JSON.stringify({ src_dead: { id: "src_dead", filePath: "notes/dead.md", importedAt } }, null, "\t"),
		);
		fs.appendFileSync(
			path.join(graphDir, "nodes.jsonl"),
			nodeLine({ id: "n_reimport", createdAt: importedAt, provenance: [{ chatId: "src_dead", messageId: "" }] }),
		);

		assert.equal((await serviceA.syncNow()).ok, true);
		assert.ok(remoteFiles()["graph/nodes.jsonl"]?.includes("n_reimport") ?? false, "re-imported node reaches the remote");
		const remoteManifest = JSON.parse(remoteFiles()["manifest.json"]!) as { deletedGraphSources?: Record<string, string> };
		assert.equal(remoteManifest.deletedGraphSources?.src_dead, undefined, "resurrection clears the remote tombstone");
		assert.equal(syncConfigOf(dirA).deletedGraphSources?.src_dead, undefined, "A's config drops the cleared tombstone");

		// A second sync must not re-kill the re-import.
		assert.equal((await serviceA.syncNow()).ok, true);
		assert.ok(remoteFiles()["graph/nodes.jsonl"]?.includes("n_reimport") ?? false, "re-import survives the next sync");
		assert.ok(localFile(dirA, "graph/nodes.jsonl").includes("n_reimport"), "re-import survives locally");
	});
});
