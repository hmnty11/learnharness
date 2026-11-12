"use client";

import { useEffect, useState } from "react";
import {
	AlertCircleIcon,
	CheckCircle2Icon,
	CloudIcon,
	LockIcon,
	RefreshCwIcon,
	ShieldCheckIcon,
} from "lucide-react";
import type { SyncStatus } from "@/src/core";
import { cn } from "@/lib/utils";
import { SettingsGroup, SettingsRow, SettingsSection, Toggle } from "./controls.tsx";

const DEFAULT_STATUS: SyncStatus = {
	connected: false,
	owner: null,
	repo: "learnharness-sync",
	autoSync: true,
	syncApiKeys: true,
	hasPassphrase: false,
	lastSyncedAt: null,
	lastError: null,
	syncing: false,
};

export function SyncSection({ initialStatus }: { initialStatus?: SyncStatus }) {
	const [status, setStatus] = useState<SyncStatus>(initialStatus ?? DEFAULT_STATUS);
	const [token, setToken] = useState("");
	const [repo, setRepo] = useState("learnharness-sync");
	const [passphrase, setPassphrase] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const refreshStatus = async () => {
		try {
			const res = await fetch("/api/sync");
			if (res.ok) {
				const data = (await res.json()) as SyncStatus;
				setStatus(data);
			}
		} catch {
			// ignore fetch error on unmounted or offline
		}
	};

	useEffect(() => {
		void refreshStatus();
	}, []);

	const handleConnect = async (e: React.FormEvent) => {
		e.preventDefault();
		if (!token.trim()) {
			setError("GitHub Personal Access Token is required");
			return;
		}
		setBusy(true);
		setError(null);
		try {
			const res = await fetch("/api/sync", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					action: "connect",
					token: token.trim(),
					repo: repo.trim() || undefined,
					passphrase: passphrase.trim() || undefined,
				}),
			});
			const data = (await res.json()) as { ok: boolean; status?: SyncStatus; error?: string };
			if (data.ok && data.status) {
				setStatus(data.status);
				setToken("");
				setPassphrase("");
			} else {
				setError(data.error ?? "Failed to connect GitHub Sync");
			}
		} catch (err) {
			setError(err instanceof Error ? err.message : "Network error");
		} finally {
			setBusy(false);
		}
	};

	const handleSyncNow = async () => {
		setBusy(true);
		setError(null);
		try {
			const res = await fetch("/api/sync", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ action: "sync-now" }),
			});
			const data = (await res.json()) as { ok: boolean; status?: SyncStatus; error?: string };
			if (data.ok && data.status) {
				setStatus(data.status);
			} else {
				setError(data.error ?? "Sync failed");
			}
		} catch (err) {
			setError(err instanceof Error ? err.message : "Network error");
		} finally {
			setBusy(false);
		}
	};

	const handleDisconnect = async () => {
		setBusy(true);
		setError(null);
		try {
			const res = await fetch("/api/sync", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ action: "disconnect" }),
			});
			const data = (await res.json()) as { ok: boolean; status?: SyncStatus };
			if (data.ok && data.status) {
				setStatus(data.status);
			}
		} catch (err) {
			setError(err instanceof Error ? err.message : "Network error");
		} finally {
			setBusy(false);
		}
	};

	const handleToggleAutoSync = async (next: boolean) => {
		setStatus((prev) => ({ ...prev, autoSync: next }));
		try {
			const res = await fetch("/api/sync", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ action: "configure", autoSync: next }),
			});
			const data = (await res.json()) as { ok: boolean; status?: SyncStatus };
			if (data.ok && data.status) setStatus(data.status);
		} catch {
			// ignore
		}
	};

	const handleToggleSyncApiKeys = async (next: boolean) => {
		setStatus((prev) => ({ ...prev, syncApiKeys: next }));
		try {
			const res = await fetch("/api/sync", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ action: "configure", syncApiKeys: next }),
			});
			const data = (await res.json()) as { ok: boolean; status?: SyncStatus };
			if (data.ok && data.status) setStatus(data.status);
		} catch {
			// ignore
		}
	};

	return (
		<SettingsSection
			title="Sync"
			hint="Private GitHub repository backup and cross-device sync. Set a passphrase for zero-knowledge API key encryption."
			testid="section-sync"
		>
			{status.connected ? (
				<div className="flex flex-col gap-3 rounded-md border border-border bg-background p-4 text-xs font-ui">
					<div className="flex items-center justify-between gap-2">
						<div className="flex items-center gap-2 text-foreground font-medium">
							<CheckCircle2Icon className="h-4 w-4 text-success" />
							<span>@{status.owner}</span>
							<span className="flex items-center gap-1 text-muted-foreground font-normal">
								<ShieldCheckIcon className="h-3.5 w-3.5 text-accent-foreground" />
								{status.owner}/{status.repo}
							</span>
						</div>
						<div className="flex items-center gap-2">
							<button
								type="button"
								onClick={() => void handleSyncNow()}
								disabled={busy || status.syncing}
								className={cn(
									"flex items-center gap-1.5 rounded border border-border bg-accent px-2.5 py-1 text-xs text-foreground transition-colors hover:border-muted-foreground/50 disabled:opacity-50",
								)}
							>
								<RefreshCwIcon className={cn("h-3 w-3", (busy || status.syncing) && "animate-spin")} />
								<span>{busy || status.syncing ? "Syncing…" : "Sync Now"}</span>
							</button>
							<button
								type="button"
								onClick={() => void handleDisconnect()}
								disabled={busy || status.syncing}
								className="rounded border border-border px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground hover:border-muted-foreground/50 disabled:opacity-50"
							>
								Disconnect
							</button>
						</div>
					</div>

					<div className="flex items-center justify-between text-muted-foreground pt-1 border-t border-border/40">
						<span>Last synced: {status.lastSyncedAt ? new Date(status.lastSyncedAt).toLocaleString() : "Never"}</span>
						{status.hasPassphrase ? (
							<span className="flex items-center gap-1 text-foreground">
								<LockIcon className="h-3 w-3" /> Passphrase Encrypted
							</span>
						) : (
							<span className="text-muted-foreground/80">
								No passphrase (keys protected by private repo access only)
							</span>
						)}
					</div>

					{status.lastError && (
						<div className="flex items-start gap-1.5 rounded border border-error/30 bg-error/10 p-2 text-error">
							<AlertCircleIcon className="h-4 w-4 shrink-0 mt-0.5" />
							<span>{status.lastError}</span>
						</div>
					)}
				</div>
			) : (
				<form onSubmit={(e) => void handleConnect(e)} className="flex flex-col gap-3 rounded-md border border-border bg-background p-4 text-xs font-ui">
					<div className="flex items-center gap-2 text-foreground font-medium pb-2 border-b border-border/40">
						<CloudIcon className="h-4 w-4 text-muted-foreground" />
						<span>Connect GitHub Account</span>
					</div>

					<div className="flex flex-col gap-1.5">
						<label htmlFor="sync-token" className="text-muted-foreground">
							Personal Access Token (with <code className="bg-accent px-1 rounded">repo</code> scope)
						</label>
						<input
							id="sync-token"
							data-testid="input-sync-token"
							type="password"
							value={token}
							onChange={(e) => setToken(e.target.value)}
							placeholder="ghp_... or github_pat_..."
							className="h-8 rounded border border-border bg-background px-2.5 text-xs text-foreground placeholder:text-muted-foreground/50 focus:border-muted-foreground focus:outline-none"
						/>
					</div>

					<div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
						<div className="flex flex-col gap-1.5">
							<label htmlFor="sync-repo" className="text-muted-foreground">
								Repository Name
							</label>
							<input
								id="sync-repo"
								data-testid="input-sync-repo"
								type="text"
								value={repo}
								onChange={(e) => setRepo(e.target.value)}
								placeholder="learnharness-sync"
								className="h-8 rounded border border-border bg-background px-2.5 text-xs text-foreground placeholder:text-muted-foreground/50 focus:border-muted-foreground focus:outline-none"
							/>
						</div>
						<div className="flex flex-col gap-1.5">
							<label htmlFor="sync-passphrase" className="text-muted-foreground">
								Encryption Passphrase (Optional)
							</label>
							<input
								id="sync-passphrase"
								data-testid="input-sync-passphrase"
								type="password"
								value={passphrase}
								onChange={(e) => setPassphrase(e.target.value)}
								placeholder="Optional extra passphrase"
								className="h-8 rounded border border-border bg-background px-2.5 text-xs text-foreground placeholder:text-muted-foreground/50 focus:border-muted-foreground focus:outline-none"
							/>
						</div>
					</div>

					<p className="text-[11px] text-muted-foreground/80 leading-relaxed">
						Without a passphrase, your API keys vault is derived from your public GitHub login—it only protects against someone who cannot read the private repository. We recommend setting a custom passphrase for true end-to-end secrecy.
					</p>

					{error && (
						<div className="flex items-center gap-1.5 rounded border border-error/30 bg-error/10 p-2 text-error">
							<AlertCircleIcon className="h-4 w-4 shrink-0" />
							<span>{error}</span>
						</div>
					)}

					<div className="pt-1">
						<button
							type="submit"
							disabled={busy}
							className="rounded border border-border bg-accent px-3 py-1.5 text-xs font-medium text-foreground hover:border-muted-foreground/50 disabled:opacity-50"
						>
							{busy ? "Connecting & Syncing…" : "Connect & Sync"}
						</button>
					</div>
				</form>
			)}

			<SettingsGroup label="Sync Preferences">
				<SettingsRow
					label="Automatic sync"
					hint="Sync on startup and after learning turns"
					testid="row-auto-sync"
				>
					<Toggle
						label="Automatic sync"
						checked={status.autoSync}
						onChange={(next) => void handleToggleAutoSync(next)}
					/>
				</SettingsRow>

				<SettingsRow
					label="Sync API keys"
					hint="Encrypted with your passphrase (recommended) or account login"
					testid="row-sync-api-keys"
				>
					<Toggle
						label="Sync API keys"
						checked={status.syncApiKeys}
						onChange={(next) => void handleToggleSyncApiKeys(next)}
					/>
				</SettingsRow>
			</SettingsGroup>
		</SettingsSection>
	);
}
