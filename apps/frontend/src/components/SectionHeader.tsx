import { cn } from "@/lib/utils";

/** Heading for a region inside a page: title (+ optional count and one-line description) with actions on the right. */
export function SectionHeader({
    title,
    description,
    count,
    actions,
    as: Heading = "h2",
    id,
    className,
}: {
    title: React.ReactNode;
    description?: React.ReactNode;
    count?: number;
    actions?: React.ReactNode;
    as?: "h2" | "h3";
    id?: string;
    className?: string;
}) {
    return (
        <div className={cn("flex min-h-8 flex-wrap items-center justify-between gap-x-4 gap-y-2", className)}>
            <div className="min-w-0">
                <Heading id={id} className="flex items-baseline gap-2 text-section text-ink">
                    <span className="min-w-0">{title}</span>
                    {count !== undefined && <span className="tabular text-control font-normal text-ink-subtle">{count}</span>}
                </Heading>
                {description && <p className="mt-0.5 text-control text-ink-muted">{description}</p>}
            </div>
            {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
        </div>
    );
}
