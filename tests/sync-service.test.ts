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
	type GitHubSyncPort,
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
