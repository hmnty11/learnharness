import { useEffect, useState } from "react";

/**
 * Import error toasts (owner-approved UX, 2026-11-19): the newest errors from
 * user-triggered import/extract actions float as dismissible popups instead of
 * a permanent inline banner. Identical error texts collapse — one toast with a
 * "muncul error yang sama sebanyak N" counter replaces its duplicates.
 * Distinct texts stay separate, each manually dismissible, and every toast
 * disappears after 60 seconds of no interaction.
 */
const AUTO_DISMISS_MS = 60_000;

interface Toast {
	text: string;
	sameCount: number;
}

/** Each distinct error text becomes one toast; identical texts collapse into
 * their newest representative with a duplicate count. */
const collapse = (errors: readonly string[]): Toast[] => {
	const counts = new Map<string, number>();
	for (const text of errors) counts.set(text, (counts.get(text) ?? 0) + 1);
	return [...counts].map(([text, sameCount]) => ({ text, sameCount }));
};

export function ImportErrorToasts({ errors }: { errors: readonly string[] }) {
	const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());
	const [visible, setVisible] = useState(true);
	// The auto-dismiss timer resets whenever the error list changes — an
	// arriving duplicate or new error means the user is still triggering work.
	useEffect(() => {
		if (errors.length === 0) return;
		setVisible(true);
		const timer = setTimeout(() => setVisible(false), AUTO_DISMISS_MS);
		return () => clearTimeout(timer);
	}, [errors]);
	// A fresh import batch (errors reset to empty) re-arms dismissal so a new
	// run's identical failures reappear instead of staying silently ignored.
	useEffect(() => {
		if (errors.length === 0) setDismissed(new Set());
	}, [errors.length]);

	const latest = collapse(errors).filter((t) => !dismissed.has(t.text));
	if (!visible || latest.length === 0) return null;

	return (
		<div className="pointer-events-none absolute bottom-4 right-4 z-50 flex flex-col gap-2" data-testid="import-error-toasts">
			{latest.map((toast) => (
				<div key={toast.text} role="alert" data-testid="import-error-toast"
					className="pointer-events-auto max-w-sm whitespace-pre-wrap break-words rounded-lg border border-error/40 bg-card px-3 py-2 text-xs text-error shadow-lg">
					{toast.sameCount > 1 && (
						<p className="mb-1 font-medium">{`muncul error yang sama sebanyak ${toast.sameCount}`}</p>
					)}
					<div className="flex items-start justify-between gap-2">
						<span>{toast.text}</span>
						<button type="button" aria-label="Dismiss error" onClick={() => setDismissed((prev) => new Set(prev).add(toast.text))}
							className="ml-2 shrink-0 rounded px-1 text-muted-foreground hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1">
							✕
						</button>
					</div>
				</div>
			))}
		</div>
	);
}
