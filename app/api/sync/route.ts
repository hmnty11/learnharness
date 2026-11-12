import { syncService } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET() {
	return Response.json(syncService.getStatus());
}

export async function POST(request: Request) {
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return Response.json({ ok: false, error: "body must be JSON" }, { status: 400 });
	}

	if (!body || typeof body !== "object" || Array.isArray(body)) {
		return Response.json({ ok: false, error: "Invalid sync request" }, { status: 400 });
	}

	const req = body as Record<string, unknown>;
	const action = typeof req.action === "string" ? req.action : "";

	switch (action) {
		case "connect": {
			if (typeof req.token !== "string" || !req.token.trim()) {
				return Response.json({ ok: false, error: "GitHub token is required" }, { status: 400 });
			}
			const res = await syncService.connect({
				token: req.token.trim(),
				repo: typeof req.repo === "string" ? req.repo.trim() : undefined,
				passphrase: typeof req.passphrase === "string" ? req.passphrase : undefined,
				autoSync: typeof req.autoSync === "boolean" ? req.autoSync : undefined,
				syncApiKeys: typeof req.syncApiKeys === "boolean" ? req.syncApiKeys : undefined,
			});
			if (!res.ok) {
				return Response.json({ ok: false, error: res.error }, { status: 400 });
			}
			return Response.json(res);
		}

		case "sync-now": {
			const res = await syncService.syncNow();
			if (!res.ok) {
				return Response.json({ ok: false, error: res.error }, { status: 400 });
			}
			return Response.json(res);
		}

		case "configure": {
			const status = await syncService.configure({
				autoSync: typeof req.autoSync === "boolean" ? req.autoSync : undefined,
				syncApiKeys: typeof req.syncApiKeys === "boolean" ? req.syncApiKeys : undefined,
				passphrase: typeof req.passphrase === "string" ? req.passphrase : undefined,
				repo: typeof req.repo === "string" ? req.repo.trim() : undefined,
			});
			return Response.json({ ok: true, status });
		}

		case "disconnect": {
			const status = await syncService.disconnect();
			return Response.json({ ok: true, status });
		}

		default: {
			return Response.json({ ok: false, error: "Invalid sync action" }, { status: 400 });
		}
	}
}
