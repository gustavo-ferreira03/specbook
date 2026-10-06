import { SPEC_STATUS_ORDER, statusMeta, type StatusCounts } from "@/lib/status";
import { formatNumber } from "@/lib/format";
import { cn } from "@/lib/utils";

const SUMMARY_WORDING: Record<string, string> = {
    passed: "passing",
    failed: "failing",
    invalid: "invalid",
    unverified: "not run",
};

function total(counts: StatusCounts) {
    return Object.values(counts).reduce((sum, value) => sum + (value ?? 0), 0);
}

/**
 * Thin stacked bar of Spec statuses. Decorative for sighted users only when paired with text
 * (SummaryStrip does this); on its own it exposes the full breakdown as its accessible name.
 */
export function StatusBar({ counts, className, label }: { counts: StatusCounts; className?: string; label?: string }) {
    const sum = total(counts);
    const parts = SPEC_STATUS_ORDER.filter((status) => (counts[status] ?? 0) > 0);
    const description = label ?? (parts.map((status) => `${counts[status]} ${SUMMARY_WORDING[status]}`).join(", ") || "No Specs");
    return (
        <div role="img" aria-label={description} className={cn("flex h-1.5 w-full gap-0.5 overflow-hidden rounded-full bg-surface-hover", className)}>
            {sum > 0 && parts.map((status) => (
                <span key={status} className={cn("h-full min-w-1", statusMeta(status).chart)} style={{ flex: `${counts[status] ?? 0} 1 0%` }} />
            ))}
        </div>
    );
}

/**
 * "9 Specs · 5 passing · 2 failing · 1 invalid · 1 not run" with a colored icon per status and an
 * optional status bar underneath. Zero counts are left out.
 */
export function SummaryStrip({ counts, noun = "Spec", showBar = true, className, trailing }: { counts: StatusCounts; noun?: string; showBar?: boolean; className?: string; trailing?: React.ReactNode }) {
    const sum = total(counts);
    const parts = SPEC_STATUS_ORDER.filter((status) => (counts[status] ?? 0) > 0);
    return (
        <div className={cn("min-w-0", className)}>
            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
                <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-control text-ink-muted">
                    <span className="tabular font-semibold text-ink">{formatNumber(sum)} {sum === 1 ? noun : `${noun}s`}</span>
                    {parts.map((status) => {
                        const meta = statusMeta(status);
                        const Icon = meta.icon;
                        return (
                            <span key={status} className="inline-flex items-center gap-1">
                                <Icon size={13} strokeWidth={2.25} aria-hidden="true" className={meta.text} />
                                <span className="tabular">{formatNumber(counts[status] ?? 0)}</span> {SUMMARY_WORDING[status]}
                            </span>
                        );
                    })}
                </p>
                {trailing}
            </div>
            {showBar && sum > 0 && <StatusBar counts={counts} className="mt-3" />}
        </div>
    );
}
