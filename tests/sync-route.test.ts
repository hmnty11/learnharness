import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { SettingsDialogBody } from "../components/settings/settings-dialog.tsx";
import { SyncSection } from "../components/settings/sync-section.tsx";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-sync-route-"));
process.env.LH_DATA_DIR = TMP_DATA;
process.env.LH_AUTH_FILE = path.join(TMP_DATA, "auth.json");
// Dynamic import required so LH_DATA_DIR is set before config.ts reads it at module load.
const { GET, POST } = await import("../app/api/sync/route.ts");

after(() => fs.rmSync(TMP_DATA, { recursive: true, force: true }));

describe("Sync API Route (/api/sync)", () => {
	it("GET returns the current sync status", async () => {
		const res = await GET();
		assert.equal(res.status, 200);
		const data = await res.json() as { repo: string; autoSync: boolean; connected: boolean };
		assert.equal(typeof data.repo, "string");
		assert.equal(typeof data.autoSync, "boolean");
		assert.equal(typeof data.connected, "boolean");
	});

	it("POST rejects unknown actions with 400", async () => {
		const req = new Request("http://localhost/api/sync", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ action: "invalid-action" }),
		});
		const res = await POST(req);
		assert.equal(res.status, 400);
		const data = await res.json() as { ok: boolean; error: string };
		assert.equal(data.ok, false);
		assert.match(data.error, /invalid/i);
	});

	it("POST configure updates sync settings", async () => {
		const req = new Request("http://localhost/api/sync", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ action: "configure", autoSync: false, syncApiKeys: true }),
		});
		const res = await POST(req);
		assert.equal(res.status, 200);
		const data = await res.json() as { ok: boolean; status: { autoSync: boolean; syncApiKeys: boolean } };
		assert.equal(data.ok, true);
		assert.equal(data.status.autoSync, false);
		assert.equal(data.status.syncApiKeys, true);
	});

	it("POST connect without token returns 400", async () => {
		const req = new Request("http://localhost/api/sync", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ action: "connect", token: "" }),
		});
		const res = await POST(req);
		assert.equal(res.status, 400);
		const data = await res.json() as { ok: boolean; error: string };
		assert.equal(data.ok, false);
		assert.match(data.error, /token/i);
	});

	it("POST disconnect returns connected: false", async () => {
		const req = new Request("http://localhost/api/sync", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ action: "disconnect" }),
		});
		const res = await POST(req);
		assert.equal(res.status, 200);
		const data = await res.json() as { ok: boolean; status: { connected: boolean } };
		assert.equal(data.ok, true);
		assert.equal(data.status.connected, false);
	});
});

describe("Settings Sync UI (SSR)", () => {
	it("renders SyncSection with connection form and toggles", () => {
		const html = renderToStaticMarkup(
			React.createElement(SyncSection, {
				initialStatus: {
					connected: false,
					owner: null,
					repo: "learnharness-sync",
					autoSync: true,
					syncApiKeys: true,
					hasPassphrase: false,
					lastSyncedAt: null,
					lastError: null,
					syncing: false,
				},
			}),
		);
		assert.ok(html.includes("Sync"));
		assert.ok(html.includes('data-testid="input-sync-token"') || html.includes("Personal Access Token"));
		assert.ok(html.includes("Automatic sync"));
		assert.ok(html.includes("Sync API keys"));
	});

	it("renders SettingsDialogBody navigated to sync section", () => {
		const html = renderToStaticMarkup(
			React.createElement(SettingsDialogBody, {
				initialSection: "sync",
				onClose: () => "closed",
			}),
		);
		const { document } = parseHTML(html);
		const syncButton = document.querySelector('[data-testid="settings-nav-sync"]');
		assert.ok(syncButton);
		assert.equal(syncButton?.getAttribute("aria-current"), "true");
	});
});
