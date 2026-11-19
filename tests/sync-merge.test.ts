import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	verifySameAccountOwner,
	mergeChatRecords,
	mergeJsonlLedger,
	mergeTextFileMap,
	mergeSyncSnapshots,
	type ChatRecord,
	type GraphChain,
	type GraphNode,
	type LhMessage,
	type SyncSnapshot,
	type SyncTextFile,
} from "../src/core/index.ts";

function makeChat(overrides: Partial<ChatRecord> & { id: string }): ChatRecord {
	return {
		title: `Chat ${overrides.id}`,
		createdAt: "2026-11-01T00:00:00.000Z",
		updatedAt: "2026-11-01T00:00:00.000Z",
		messages: [],
		...overrides,
	};
}

function makeSnapshot(overrides: Partial<SyncSnapshot> = {}): SyncSnapshot {
	return {
		manifest: {
			version: 1,
			owner: "hmnty11",
			updatedAt: "2026-11-10T12:00:00.000Z",
			deletedChats: {},
			deletedPrompts: {},
			deletedThemes: {},
			...(overrides.manifest ?? {}),
		},
		chats: overrides.chats ?? {},
		graphLedgers: {
			nodes: "",
			chains: "",
			sessions: "",
			coverage: "",
			...(overrides.graphLedgers ?? {}),
		},
		graphFiles: {
			...(overrides.graphFiles ?? {}),
		},
		settings: overrides.settings ?? null,
		settingsUpdatedAt: overrides.settingsUpdatedAt,
		prompts: overrides.prompts ?? {},
		themes: overrides.themes ?? {},
	};
}

describe("verifySameAccountOwner", () => {
	it("accepts identical and case-insensitive GitHub usernames", () => {
		assert.deepEqual(verifySameAccountOwner("hmnty11", "hmnty11"), { ok: true, owner: "hmnty11" });
		const ci = verifySameAccountOwner("hmnty11", "HMNTY11");
		assert.equal(ci.ok, true);
		if (ci.ok) assert.equal(ci.owner.toLowerCase(), "hmnty11");
	});

	it("accepts when one side is missing an owner", () => {
		assert.deepEqual(verifySameAccountOwner("hmnty11", null), { ok: true, owner: "hmnty11" });
		assert.deepEqual(verifySameAccountOwner(undefined, "hmnty11"), { ok: true, owner: "hmnty11" });
	});

	it("refuses mismatched owners with a clear error", () => {
		const res = verifySameAccountOwner("hmnty11", "other-user");
		assert.equal(res.ok, false);
		if (!res.ok) {
			assert.match(res.error, /hmnty11/);
			assert.match(res.error, /other-user/);
		}
	});

	it("refuses when both owners are missing", () => {
		const res = verifySameAccountOwner(null, "");
		assert.equal(res.ok, false);
	});
});

describe("mergeChatRecords", () => {
	it("unions disjoint local and remote chats", () => {
		const local = { c1: makeChat({ id: "c1" }) };
		const remote = { c2: makeChat({ id: "c2" }) };
		const res = mergeChatRecords(local, remote, {}, {});
		assert.deepEqual(Object.keys(res.chats).sort(), ["c1", "c2"]);
		assert.deepEqual(res.deletedChats, {});
	});

	it("picks newer updatedAt when both local and remote have the same chat", () => {
		const local = {
			c1: makeChat({ id: "c1", title: "Older", updatedAt: "2026-11-10T10:00:00.000Z" }),
		};
		const remote = {
			c1: makeChat({ id: "c1", title: "Newer", updatedAt: "2026-11-10T11:00:00.000Z" }),
		};
		const res = mergeChatRecords(local, remote, {}, {});
		assert.equal(res.chats.c1?.title, "Newer");
	});

	it("breaks equal updatedAt ties by messages.length and merges sideChats + imageSnapshots", () => {
		const ts = "2026-11-10T10:00:00.000Z";
		const msg: LhMessage = { id: "m1", role: "user", content: "hi", timestamp: 1700000000000 };
		const local = {
			c1: makeChat({
				id: "c1",
				title: "Local Shorter",
				updatedAt: ts,
				messages: [msg],
				sideChats: [
					{
						id: "sc-local",
						anchor: { messageId: "m1", partId: "m1-t0", blockIndex: 0, blockText: "hi" },
						open: true,
						createdAt: ts,
						messages: [],
					},
				],
				imageSnapshots: {
					"img-local": {
						id: "img-local",
						mimeType: "image/png",
						dataUrl: "data:image/png;base64,AAA",
						createdAt: ts,
					} as never,
				},
			}),
		};
		const remote = {
			c1: makeChat({
				id: "c1",
				title: "Remote Longer",
				updatedAt: ts,
				messages: [msg, { ...msg, id: "m2" }],
				sideChats: [
					{
						id: "sc-remote",
						anchor: { messageId: "m2", partId: "m2-t0", blockIndex: 0, blockText: "hello" },
						open: false,
						createdAt: ts,
						messages: [],
					},
				],
				imageSnapshots: {
					"img-remote": {
						id: "img-remote",
						mimeType: "image/png",
						dataUrl: "data:image/png;base64,BBB",
						createdAt: ts,
					} as never,
				},
			}),
		};

		const res = mergeChatRecords(local, remote, {}, {});
		assert.ok(res.chats.c1);
		assert.equal(res.chats.c1.title, "Remote Longer");
		assert.equal(res.chats.c1.messages.length, 2);
		assert.deepEqual(
			(res.chats.c1.sideChats ?? []).map((s) => s.id).sort(),
			["sc-local", "sc-remote"],
		);
		assert.deepEqual(
			Object.keys(res.chats.c1.imageSnapshots ?? {}).sort(),
			["img-local", "img-remote"],
		);
	});

	it("prevents zombie chats when tombstone deletedAt >= chat.updatedAt", () => {
		const local = {
			c1: makeChat({ id: "c1", updatedAt: "2026-11-10T09:00:00.000Z" }),
		};
		const remote = {};
		const remoteDeleted = { c1: "2026-11-10T10:00:00.000Z" };
		const res = mergeChatRecords(local, remote, {}, remoteDeleted);
		assert.equal(res.chats.c1, undefined);
		assert.equal(res.deletedChats.c1, "2026-11-10T10:00:00.000Z");
	});

	it("keeps latest deletedAt across tombstones and revives chat if updatedAt > deletedAt", () => {
		const local = {
			c1: makeChat({ id: "c1", updatedAt: "2026-11-10T12:00:00.000Z" }),
		};
		const res = mergeChatRecords(
			local,
			{},
			{ c1: "2026-11-10T08:00:00.000Z", c2: "2026-11-10T08:00:00.000Z" },
			{ c1: "2026-11-10T10:00:00.000Z", c2: "2026-11-10T11:00:00.000Z" },
		);
		assert.ok(res.chats.c1, "chat updated after deletion should survive");
		assert.equal(res.deletedChats.c1, undefined, "stale tombstone should be removed");
		assert.equal(res.deletedChats.c2, "2026-11-10T11:00:00.000Z");
	});
});

describe("mergeJsonlLedger", () => {
	it("preserves local order, appends unseen remote lines, and deduplicates by canonical JSON", () => {
		const local = [
			JSON.stringify({ id: "n1", label: "Derivative", meta: { b: 2, a: 1 } }),
			JSON.stringify({ id: "n2", label: "Integral" }),
		].join("\n") + "\n";

		const remote = [
			// Same semantic JSON as n1, different key order and whitespace
			'  { "meta": { "a": 1, "b": 2 }, "label": "Derivative", "id": "n1" }  ',
			// Corrupt line should be skipped safely
			"{not-valid-json",
			"",
			// New unseen line
			JSON.stringify({ id: "n3", label: "Limit" }),
		].join("\n") + "\n";

		const merged = mergeJsonlLedger(local, remote);
		const lines = merged.trimEnd().split("\n").map((l) => JSON.parse(l) as { id: string });
		assert.deepEqual(
			lines.map((x) => x.id),
			["n1", "n2", "n3"],
		);
		assert.ok(merged.endsWith("\n"));
	});

	it("returns empty string when both ledgers have no valid lines", () => {
		assert.equal(mergeJsonlLedger("", "   \n{bad\n"), "");
	});
});

describe("mergeTextFileMap", () => {
	it("merges prompts/themes by newer updatedAt and respects tombstones", () => {
		const local: Record<string, SyncTextFile> = {
			"personalization.md": { content: "local", updatedAt: "2026-11-10T09:00:00.000Z" },
			"skills/a/SKILL.md": { content: "keep-me", updatedAt: "2026-11-10T11:00:00.000Z" },
			"skills/old/SKILL.md": { content: "zombie", updatedAt: "2026-11-10T08:00:00.000Z" },
		};
		const remote: Record<string, SyncTextFile> = {
			"personalization.md": { content: "remote", updatedAt: "2026-11-10T10:00:00.000Z" },
			"skills/b/SKILL.md": { content: "new-skill", updatedAt: "2026-11-10T10:00:00.000Z" },
		};
		const res = mergeTextFileMap(
			local,
			remote,
			{ "skills/a/SKILL.md": "2026-11-10T09:00:00.000Z" },
			{ "skills/old/SKILL.md": "2026-11-10T09:00:00.000Z" },
		);

		assert.equal(res.files["personalization.md"]?.content, "remote");
		assert.equal(res.files["skills/a/SKILL.md"]?.content, "keep-me");
		assert.equal(res.files["skills/b/SKILL.md"]?.content, "new-skill");
		assert.equal(res.files["skills/old/SKILL.md"], undefined);
		assert.equal(res.deleted["skills/old/SKILL.md"], "2026-11-10T09:00:00.000Z");
		assert.equal(res.deleted["skills/a/SKILL.md"], undefined);
	});
});

describe("mergeSyncSnapshots", () => {
	it("refuses snapshot merge when account owners do not match", () => {
		const local = makeSnapshot({ manifest: { version: 1, owner: "alice", updatedAt: "2026-11-10T10:00:00.000Z", deletedChats: {} } });
		const remote = makeSnapshot({ manifest: { version: 1, owner: "bob", updatedAt: "2026-11-10T11:00:00.000Z", deletedChats: {} } });
		const res = mergeSyncSnapshots(local, remote);
		assert.equal(res.ok, false);
	});

	it("merges full snapshots including ledgers, sources.json, positions.json, settings, prompts, and themes", () => {
		const local = makeSnapshot({
			manifest: {
				version: 1,
				owner: "hmnty11",
				updatedAt: "2026-11-10T10:00:00.000Z",
				deletedChats: { c_deleted: "2026-11-10T10:00:00.000Z" },
				deletedPrompts: {},
				deletedThemes: {},
			},
			chats: {
				c1: makeChat({ id: "c1", title: "Local c1", updatedAt: "2026-11-10T10:00:00.000Z" }),
			},
			graphLedgers: {
				nodes: JSON.stringify({ id: "n1", label: "N1" }) + "\n",
				chains: JSON.stringify({ id: "arg1", premises: ["n1"], conclusion: "n2" }) + "\n",
				sessions: JSON.stringify({ chatId: "c1", foldedAt: "2026-11-10T10:00:00.000Z" }) + "\n",
				coverage: JSON.stringify({ chatId: "c1", fp: "abc" }) + "\n",
			},
			graphFiles: {
				sources: JSON.stringify({
					src_1: { id: "src_1", filePath: "notes/a.md", importedAt: "2026-11-10T09:00:00.000Z" },
				}),
				positions: JSON.stringify({
					positions: { n1: { x: 10, y: 20 } },
					updatedAt: "2026-11-10T09:00:00.000Z",
				}),
				sourceOrganization: JSON.stringify({ version: 1, folders: [{ id: "f1", name: "Local" }], placements: {} }),
				renderSettings: JSON.stringify({ nodeSize: 4 }),
			},
			settings: { version: 1, appearance: { theme: "catppuccin-mocha" } } as never,
			settingsUpdatedAt: "2026-11-10T09:00:00.000Z",
			prompts: {
				"personalization.md": { content: "Be concise.", updatedAt: "2026-11-10T09:00:00.000Z" },
			},
			themes: {
				"custom.json": { content: '{"name":"Local"}', updatedAt: "2026-11-10T09:00:00.000Z" },
			},
		});

		const remote = makeSnapshot({
			manifest: {
				version: 1,
				owner: "HMNTY11",
				updatedAt: "2026-11-10T12:00:00.000Z",
				deletedChats: {},
				deletedPrompts: {},
				deletedThemes: {},
			},
			chats: {
				c_deleted: makeChat({ id: "c_deleted", updatedAt: "2026-11-10T08:00:00.000Z" }),
				c2: makeChat({ id: "c2", title: "Remote c2", updatedAt: "2026-11-10T11:00:00.000Z" }),
			},
			graphLedgers: {
				nodes: JSON.stringify({ label: "N1", id: "n1" }) + "\n" + JSON.stringify({ id: "n2", label: "N2" }) + "\n",
				chains: "",
				sessions: "",
				coverage: JSON.stringify({ fp: "abc", chatId: "c1" }) + "\n",
			},
			graphFiles: {
				sources: JSON.stringify({
					src_2: { id: "src_2", filePath: "notes/b.md", importedAt: "2026-11-10T11:00:00.000Z" },
				}),
				positions: JSON.stringify({
					positions: { n1: { x: 100, y: 200 }, n2: { x: 300, y: 400 } },
					updatedAt: "2026-11-10T12:00:00.000Z",
				}),
				sourceOrganization: JSON.stringify({ version: 1, folders: [{ id: "f2", name: "Remote" }], placements: {} }),
				renderSettings: JSON.stringify({ nodeSize: 8 }),
			},
			settings: { version: 1, appearance: { theme: "rose-pine" }, unknownFutureKey: "keep-me" } as never,
			settingsUpdatedAt: "2026-11-10T12:00:00.000Z",
			prompts: {
				"skills/math/SKILL.md": { content: "# Math", updatedAt: "2026-11-10T12:00:00.000Z" },
			},
			themes: {
				"custom.json": { content: '{"name":"Remote"}', updatedAt: "2026-11-10T12:00:00.000Z" },
			},
		});

		const result = mergeSyncSnapshots(local, remote, "2026-11-10T13:00:00.000Z");
		assert.equal(result.ok, true);
		if (!result.ok) return;

		const { merged } = result;
		assert.equal(merged.manifest.updatedAt, "2026-11-10T13:00:00.000Z");
		assert.deepEqual(Object.keys(merged.chats).sort(), ["c1", "c2"]);
		assert.equal(merged.manifest.deletedChats.c_deleted, "2026-11-10T10:00:00.000Z");

		const nodeIds: string[] = [];
		for (const line of merged.graphLedgers.nodes.trimEnd().split("\n")) {
			const parsed: unknown = JSON.parse(line);
			if (parsed && typeof parsed === "object" && "id" in parsed && typeof parsed.id === "string") {
				nodeIds.push(parsed.id);
			}
		}
		assert.equal(merged.graphLedgers.coverage.trimEnd().split("\n").length, 1);

		const sources = JSON.parse(merged.graphFiles.sources ?? "{}") as Record<string, unknown>;
		assert.deepEqual(Object.keys(sources).sort(), ["src_1", "src_2"]);

		const pos = JSON.parse(merged.graphFiles.positions ?? "{}") as {
			positions: Record<string, { x: number; y: number }>;
			updatedAt: string;
		};
		assert.deepEqual(pos.positions.n1, { x: 100, y: 200 });
		assert.deepEqual(pos.positions.n2, { x: 300, y: 400 });
		assert.equal(pos.updatedAt, "2026-11-10T12:00:00.000Z");

		const org = JSON.parse(merged.graphFiles.sourceOrganization ?? "{}");
		assert.equal(Array.isArray(org?.folders) && org.folders[0]?.id, "f2");
		const renderSettings = JSON.parse(merged.graphFiles.renderSettings ?? "{}");
		assert.equal(renderSettings?.nodeSize, 8);

		assert.equal(merged.settings?.appearance?.theme, "rose-pine");
		const settingsMap: Record<string, unknown> = merged.settings ?? {};
		assert.equal(settingsMap.unknownFutureKey, "keep-me");
		assert.equal(merged.settingsUpdatedAt, "2026-11-10T12:00:00.000Z");

		assert.deepEqual(Object.keys(merged.prompts).sort(), ["personalization.md", "skills/math/SKILL.md"]);
		assert.equal(merged.themes["custom.json"]?.content, '{"name":"Remote"}');
	});
});

// ─── Graph deletion tombstones (design: local://graph-sync-tombstone-design.md) ───

function linesOf<T>(raw: string): T[] {
	return raw
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
		.map((line) => JSON.parse(line) as T);
}

function nodeLine(over: Partial<GraphNode> & { id: string }): GraphNode {
	return {
		name: over.id,
		statement: `Statement of ${over.id}`,
		aliases: [],
		createdAt: "2026-11-10T08:00:00.000Z",
		provenance: [],
		...over,
	};
}

function chainLine(over: Partial<GraphChain> & { id: string; premises: string[]; conclusion: string }): GraphChain {
	return {
		createdAt: "2026-11-10T08:00:00.000Z",
		provenance: [],
		...over,
	};
}

const jsonl = (...rows: unknown[]): string => rows.map((row) => JSON.stringify(row) + "\n").join("");

describe("mergeSyncSnapshots graph tombstones", () => {
	it("suppresses a deleted source's nodes and prunes sources, positions, and organization", () => {
		const deadSource = "src_dead";
		const node = nodeLine({
			id: "n_dead",
			provenance: [{ chatId: deadSource, messageId: "" }],
		});
		const local = makeSnapshot({
			manifest: {
				version: 1,
				owner: "hmnty11",
				updatedAt: "2026-11-10T12:00:00.000Z",
				deletedChats: {},
				deletedGraphSources: { [deadSource]: "2026-11-10T11:00:00.000Z" },
			},
			graphLedgers: { nodes: "", chains: "", sessions: "", coverage: "" },
			graphFiles: {
				sources: JSON.stringify({
					[deadSource]: { id: deadSource, filePath: "notes/dead.md", importedAt: "2026-11-10T09:00:00.000Z" },
				}),
				positions: JSON.stringify({ positions: { n_dead: { x: 1, y: 2 } }, updatedAt: "2026-11-10T12:00:00.000Z" }),
				sourceOrganization: JSON.stringify({
					version: 1,
					folders: [],
					placements: { [deadSource]: { folderId: null } },
				}),
			},
		});
		// Stale remote: still carries the deleted source's graph content.
		const remote = makeSnapshot({
			manifest: {
				version: 1,
				owner: "hmnty11",
				updatedAt: "2026-11-10T13:00:00.000Z",
				deletedChats: {},
				deletedGraphSources: { [deadSource]: "2026-11-10T11:00:00.000Z" },
			},
			graphLedgers: { nodes: jsonl(node), chains: "", sessions: "", coverage: "" },
			graphFiles: {
				sources: JSON.stringify({
					[deadSource]: { id: deadSource, filePath: "notes/dead.md", importedAt: "2026-11-10T09:00:00.000Z" },
				}),
				positions: JSON.stringify({ positions: { n_dead: { x: 5, y: 5 } }, updatedAt: "2026-11-10T13:00:00.000Z" }),
				sourceOrganization: JSON.stringify({
					version: 1,
					folders: [],
					placements: { [deadSource]: { folderId: null } },
				}),
			},
		});

		const res = mergeSyncSnapshots(local, remote, "2026-11-10T14:00:00.000Z");
		assert.equal(res.ok, true);
		if (!res.ok) return;
		const { merged } = res;

		assert.deepEqual(linesOf<GraphNode>(merged.graphLedgers.nodes), [], "deleted-source node must not resurrect");
		assert.equal(JSON.parse(merged.graphFiles.sources ?? "{}")[deadSource], undefined);
		const positions = JSON.parse(merged.graphFiles.positions ?? "{}") as { positions: Record<string, unknown> };
		assert.equal(positions.positions.n_dead, undefined);
		const org = JSON.parse(merged.graphFiles.sourceOrganization ?? "{}") as {
			placements: Record<string, unknown>;
		};
		assert.equal(org.placements[deadSource], undefined);
		assert.equal(merged.manifest.deletedGraphSources?.[deadSource], "2026-11-10T11:00:00.000Z");
	});

	it("keeps a multi-source node, strips tombstoned provenance, and drops aliases from deleted link lines", () => {
		const deadSource = "src_dead";
		const create = nodeLine({
			id: "n_shared",
			name: "Shared",
			statement: "The original statement",
			aliases: ["create alias"],
			createdAt: "2026-11-10T08:00:00.000Z",
			provenance: [{ chatId: deadSource, messageId: "m1" }],
		});
		const liveLink = nodeLine({
			id: "n_shared",
			statement: "Live phrasing",
			aliases: ["live alias"],
			provenance: [{ chatId: "chat_live", messageId: "m2" }],
		});
		const deadLink = nodeLine({
			id: "n_shared",
			statement: "Dead phrasing",
			aliases: ["dead alias"],
			createdAt: "2026-11-10T09:00:00.000Z",
			provenance: [{ chatId: deadSource, messageId: "m3" }],
		});
		const local = makeSnapshot({
			manifest: {
				version: 1,
				owner: "hmnty11",
				updatedAt: "2026-11-10T12:00:00.000Z",
				deletedChats: {},
				deletedGraphSources: { [deadSource]: "2026-11-10T11:00:00.000Z" },
			},
			graphLedgers: { nodes: jsonl(create), chains: "", sessions: "", coverage: "" },
		});
		const remote = makeSnapshot({
			manifest: { version: 1, owner: "hmnty11", updatedAt: "2026-11-10T10:00:00.000Z", deletedChats: {} },
			graphLedgers: { nodes: jsonl(liveLink, deadLink), chains: "", sessions: "", coverage: "" },
		});

		const res = mergeSyncSnapshots(local, remote);
		assert.equal(res.ok, true);
		if (!res.ok) return;

		const nodes = linesOf<GraphNode>(res.merged.graphLedgers.nodes);
		assert.equal(nodes.length, 1, "link lines collapse into the canonical create line");
		const node = nodes[0]!;
		assert.equal(node.id, "n_shared");
		assert.equal(node.name, "Shared");
		assert.equal(node.statement, "The original statement");
		assert.deepEqual(node.provenance, [{ chatId: "chat_live", messageId: "m2" }]);
		assert.deepEqual(node.aliases, ["Live phrasing", "live alias"]);
	});

	it("kills tombstoned nodes and their chains while unrelated chains survive", () => {
		const nodes = jsonl(
			nodeLine({ id: "n_dead", provenance: [{ chatId: "chat_a", messageId: "" }] }),
			nodeLine({ id: "n_live", provenance: [{ chatId: "chat_a", messageId: "" }] }),
			nodeLine({ id: "n_concl", provenance: [{ chatId: "chat_a", messageId: "" }] }),
		);
		const chains = jsonl(
			chainLine({
				id: "arg_dead",
				premises: ["n_dead"],
				conclusion: "n_concl",
				provenance: [{ chatId: "chat_a", messageId: "" }],
			}),
			chainLine({
				id: "arg_live",
				premises: ["n_live"],
				conclusion: "n_concl",
				provenance: [{ chatId: "chat_a", messageId: "" }],
			}),
		);
		const local = makeSnapshot({
			manifest: {
				version: 1,
				owner: "hmnty11",
				updatedAt: "2026-11-10T12:00:00.000Z",
				deletedChats: {},
				deletedGraphNodes: { n_dead: "2026-11-10T11:00:00.000Z" },
			},
			graphLedgers: { nodes, chains, sessions: "", coverage: "" },
			graphFiles: {
				positions: JSON.stringify({
					positions: { n_dead: { x: 1, y: 1 }, arg_dead: { x: 2, y: 2 }, n_live: { x: 3, y: 3 } },
					updatedAt: "2026-11-10T12:00:00.000Z",
				}),
			},
		});
		const remote = makeSnapshot({
			manifest: { version: 1, owner: "hmnty11", updatedAt: "2026-11-10T10:00:00.000Z", deletedChats: {} },
			graphLedgers: { nodes, chains, sessions: "", coverage: "" },
		});

		const res = mergeSyncSnapshots(local, remote);
		assert.equal(res.ok, true);
		if (!res.ok) return;

		assert.deepEqual(linesOf<GraphNode>(res.merged.graphLedgers.nodes).map((n) => n.id), ["n_live", "n_concl"]);
		assert.deepEqual(linesOf<GraphChain>(res.merged.graphLedgers.chains).map((c) => c.id), ["arg_live"]);
		const positions = JSON.parse(res.merged.graphFiles.positions ?? "{}") as { positions: Record<string, unknown> };
		assert.deepEqual(Object.keys(positions.positions).sort(), ["n_live"]);
	});

	it("keeps a source re-imported after its tombstone and clears the tombstone", () => {
		const sourceId = "src_reimport";
		const node = nodeLine({ id: "n_new", provenance: [{ chatId: sourceId, messageId: "" }] });
		const local = makeSnapshot({
			manifest: {
				version: 1,
				owner: "hmnty11",
				updatedAt: "2026-11-10T12:00:00.000Z",
				deletedChats: {},
				deletedGraphSources: { [sourceId]: "2026-11-10T09:00:00.000Z" },
			},
			graphLedgers: { nodes: jsonl(node), chains: "", sessions: "", coverage: "" },
			graphFiles: {
				sources: JSON.stringify({
					[sourceId]: { id: sourceId, filePath: "notes/x.md", importedAt: "2026-11-10T11:00:00.000Z" },
				}),
				positions: JSON.stringify({ positions: { n_new: { x: 1, y: 1 } }, updatedAt: "2026-11-10T12:00:00.000Z" }),
			},
		});
		const remote = makeSnapshot({
			manifest: { version: 1, owner: "hmnty11", updatedAt: "2026-11-10T10:00:00.000Z", deletedChats: {} },
			graphLedgers: { nodes: "", chains: "", sessions: "", coverage: "" },
		});

		const res = mergeSyncSnapshots(local, remote);
		assert.equal(res.ok, true);
		if (!res.ok) return;

		const sources = JSON.parse(res.merged.graphFiles.sources ?? "{}") as Record<string, unknown>;
		assert.ok(sources[sourceId], "re-imported source must survive");
		assert.equal(res.merged.manifest.deletedGraphSources?.[sourceId], undefined, "resurrection clears the tombstone");
		assert.deepEqual(linesOf<GraphNode>(res.merged.graphLedgers.nodes).map((n) => n.id), ["n_new"]);
		const positions = JSON.parse(res.merged.graphFiles.positions ?? "{}") as { positions: Record<string, unknown> };
		assert.deepEqual(Object.keys(positions.positions), ["n_new"]);
	});

	it("unions tombstones across manifests by max timestamp and lets a newer create resurrect a node", () => {
		const recreated = nodeLine({
			id: "n_recreated",
			createdAt: "2026-11-10T12:30:00.000Z",
			provenance: [{ chatId: "chat_a", messageId: "" }],
		});
		const local = makeSnapshot({
			manifest: {
				version: 1,
				owner: "hmnty11",
				updatedAt: "2026-11-10T17:00:00.000Z",
				deletedChats: {},
				deletedGraphSources: { src_a: "2026-11-10T09:00:00.000Z" },
				deletedGraphNodes: { n_recreated: "2026-11-10T11:00:00.000Z", n_old: "2026-11-10T11:00:00.000Z" },
			},
			graphLedgers: { nodes: jsonl(recreated), chains: "", sessions: "", coverage: "" },
		});
		const remote = makeSnapshot({
			manifest: {
				version: 1,
				owner: "hmnty11",
				updatedAt: "2026-11-10T10:00:00.000Z",
				deletedChats: {},
				deletedGraphSources: { src_a: "2026-11-10T10:30:00.000Z" },
				deletedGraphNodes: { n_recreated: "2026-11-10T12:00:00.000Z" },
			},
			graphLedgers: { nodes: jsonl(nodeLine({ id: "n_old", provenance: [{ chatId: "chat_b", messageId: "" }] })), chains: "", sessions: "", coverage: "" },
		});

		const res = mergeSyncSnapshots(local, remote);
		assert.equal(res.ok, true);
		if (!res.ok) return;

		// Source tombstone: remote's later timestamp wins.
		assert.equal(res.merged.manifest.deletedGraphSources?.src_a, "2026-11-10T10:30:00.000Z");
		// Node recreated after its tombstone (12:30 > 12:00) resurrects; the stale tombstone clears.
		assert.equal(res.merged.manifest.deletedGraphNodes?.n_recreated, undefined);
		assert.deepEqual(linesOf<GraphNode>(res.merged.graphLedgers.nodes).map((n) => n.id), ["n_recreated"]);
		// n_old keeps its tombstone.
		assert.equal(res.merged.manifest.deletedGraphNodes?.n_old, "2026-11-10T11:00:00.000Z");
	});

	it("lets legacy provenance-free nodes and empty-provenance chains ride untouched", () => {
		const legacyNode = nodeLine({ id: "n_legacy", provenance: [] });
		const legacyHead = nodeLine({ id: "n_head", provenance: [{ chatId: "chat_a", messageId: "" }] });
		const chains = jsonl(
			chainLine({ id: "arg_legacy", premises: ["n_legacy"], conclusion: "n_head", provenance: [] }),
			chainLine({
				id: "arg_live",
				premises: ["n_head"],
				conclusion: "n_legacy",
				provenance: [{ chatId: "chat_a", messageId: "" }],
			}),
		);
		const local = makeSnapshot({
			manifest: {
				version: 1,
				owner: "hmnty11",
				updatedAt: "2026-11-10T12:00:00.000Z",
				deletedChats: {},
				deletedGraphSources: { src_unrelated: "2026-11-10T11:00:00.000Z" },
			},
			graphLedgers: { nodes: jsonl(legacyNode, legacyHead), chains, sessions: "", coverage: "" },
		});
		const remote = makeSnapshot({
			manifest: { version: 1, owner: "hmnty11", updatedAt: "2026-11-10T10:00:00.000Z", deletedChats: {} },
			graphLedgers: {
				nodes: "",
				chains: "",
				sessions: "",
				coverage:
					jsonl({ chatId: "chat_a", fp: "abc", tokens: 10, foldedAt: "2026-11-10T09:00:00.000Z" }) +
					jsonl({ chatId: "src_unrelated", fp: "def", tokens: 20, foldedAt: "2026-11-10T09:00:00.000Z" }),
			},
			graphFiles: {
				sources: JSON.stringify({
					src_kept: { id: "src_kept", filePath: "notes/kept.md", importedAt: "2026-11-10T08:00:00.000Z" },
				}),
			},
		});

		const res = mergeSyncSnapshots(local, remote);
		assert.equal(res.ok, true);
		if (!res.ok) return;

		assert.deepEqual(linesOf<GraphNode>(res.merged.graphLedgers.nodes).map((n) => n.id), ["n_legacy", "n_head"]);
		assert.deepEqual(linesOf<GraphChain>(res.merged.graphLedgers.chains).map((c) => c.id), ["arg_legacy", "arg_live"]);
		assert.deepEqual(
			linesOf<{ chatId: string }>(res.merged.graphLedgers.coverage).map((r) => r.chatId),
			["chat_a"],
		);
		const sources = JSON.parse(res.merged.graphFiles.sources ?? "{}") as Record<string, unknown>;
		assert.deepEqual(Object.keys(sources), ["src_kept"]);
	});
});
