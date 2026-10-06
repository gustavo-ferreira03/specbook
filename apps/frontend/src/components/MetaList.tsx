import { cn } from "@/lib/utils";

export interface MetaItem {
    label?: React.ReactNode;
    value: React.ReactNode;
    /** Render the value in the mono font (URLs, paths, hashes). */
    mono?: boolean;
}

/**
 * Key/value metadata. `inline`: "Label value · Label value" on one wrapping line (headers, rows).
 * `grid`: two-column definition list (detail panels, settings).
 */
export function MetaList({ items, layout = "inline", className }: { items: (MetaItem | false | null | undefined)[]; layout?: "inline" | "grid"; className?: string }) {
    const visible = items.filter(Boolean) as MetaItem[];
    if (layout === "grid") {
        return (
            <dl className={cn("grid grid-cols-[minmax(7rem,auto)_1fr] gap-x-6 gap-y-2.5 text-control", className)}>
                {visible.map((item, index) => (
                    <div key={index} className="contents">
                        <dt className="text-ink-muted">{item.label ?? ""}</dt>
                        <dd className={cn("min-w-0 break-words text-ink", item.mono && "font-mono text-meta leading-5")}>{item.value}</dd>
                    </div>
                ))}
            </dl>
        );
    }
    return (
        <dl className={cn("flex flex-wrap items-center gap-x-1.5 gap-y-1 text-meta text-ink-muted", className)}>
            {visible.map((item, index) => (
                <div key={index} className="flex min-w-0 items-center gap-1.5">
                    {index > 0 && <span aria-hidden="true" className="text-ink-disabled">·</span>}
                    {item.label !== undefined && <dt className="text-ink-subtle">{item.label}</dt>}
                    <dd className={cn("min-w-0 truncate text-ink-muted", item.mono && "font-mono text-[0.92em]")}>{item.value}</dd>
                </div>
            ))}
        </dl>
    );
}

/** Single key/value pair, for one-off use. */
export function KeyValue({ label, value, mono, className }: MetaItem & { className?: string }) {
    return <MetaList items={[{ label, value, mono }]} className={className} />;
}
