import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

export type PageWidth = "reading" | "chat" | "data" | "full";

const widthClasses: Record<PageWidth, string> = {
    reading: "max-w-reading",
    chat: "max-w-chat",
    data: "max-w-data",
    full: "max-w-none",
};

export interface Crumb {
    label: React.ReactNode;
    href?: string;
}

/**
 * The single header of a route: breadcrumb (ancestors only, never the current page), title,
 * optional meta line, and actions on the right. Use the same `width` as the PageContainer below it
 * so the header and content share a left edge.
 */
export function PageHeader({
    title,
    breadcrumbs,
    description,
    meta,
    actions,
    titleAdornment,
    width = "full",
    bordered = true,
    className,
}: {
    title: React.ReactNode;
    breadcrumbs?: Crumb[];
    description?: React.ReactNode;
    meta?: React.ReactNode;
    actions?: React.ReactNode;
    /** Inline element after the title, e.g. a StatusPill. */
    titleAdornment?: React.ReactNode;
    width?: PageWidth;
    bordered?: boolean;
    className?: string;
}) {
    const crumbs = breadcrumbs ?? [];
    return (
        <header className={cn("shrink-0 bg-surface px-4 pt-5 pb-4 md:px-8 md:pt-6 md:pb-5", bordered && "border-b border-line", className)}>
            <div className={cn("mx-auto w-full", widthClasses[width])}>
                {crumbs.length > 0 && (
                    <nav aria-label="Breadcrumb" className="mb-1.5">
                        <ol className="flex min-w-0 flex-wrap items-center gap-1 text-meta text-ink-subtle">
                            {crumbs.map((crumb, index) => (
                                <li key={index} className="flex min-w-0 items-center gap-1">
                                    {index > 0 && <ChevronRight size={12} aria-hidden="true" className="shrink-0 text-ink-disabled" />}
                                    {crumb.href ? (
                                        <Link href={crumb.href} className="truncate rounded-sm transition-colors hover:text-ink">{crumb.label}</Link>
                                    ) : (
                                        <span className="truncate">{crumb.label}</span>
                                    )}
                                </li>
                            ))}
                        </ol>
                    </nav>
                )}
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
                    <div className="min-w-0 flex-1">
                        <div className="flex min-h-9 min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5">
                            <h1 className="min-w-0 text-title break-words text-ink">{title}</h1>
                            {titleAdornment}
                        </div>
                        {description && <p className="mt-0.5 max-w-[70ch] text-body text-ink-muted">{description}</p>}
                        {meta && <div className="mt-1 text-meta text-ink-muted">{meta}</div>}
                    </div>
                    {actions && <div className="flex shrink-0 flex-wrap items-center gap-2 sm:justify-end">{actions}</div>}
                </div>
            </div>
        </header>
    );
}

/** Content region under a PageHeader: gutters, vertical rhythm, and a centered measure. */
export function PageContainer({ width = "data", className, innerClassName, children }: { width?: PageWidth; className?: string; innerClassName?: string; children: React.ReactNode }) {
    return (
        <div className={cn("px-4 py-6 md:px-8 md:py-8", className)}>
            <div className={cn("mx-auto w-full", widthClasses[width], innerClassName)}>{children}</div>
        </div>
    );
}
