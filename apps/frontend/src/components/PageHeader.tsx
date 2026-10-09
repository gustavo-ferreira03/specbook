import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { SpecGrid } from "@/components/SpecGrid";
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

export function PageHeader({
    title,
    breadcrumbs,
    description,
    meta,
    actions,
    titleAdornment,
    kicker,
    size = "default",
    width = "full",
    bordered = true,
    className,
}: {
    title: React.ReactNode;
    breadcrumbs?: Crumb[];
    description?: React.ReactNode;
    meta?: React.ReactNode;
    actions?: React.ReactNode;
    titleAdornment?: React.ReactNode;
    kicker?: React.ReactNode;
    size?: "default" | "document";
    width?: PageWidth;
    bordered?: boolean;
    className?: string;
}) {
    const crumbs = breadcrumbs ?? [];
    return (
        <header className={cn("relative isolate shrink-0 overflow-hidden bg-surface px-4 pt-5 pb-4 md:px-8 md:pt-6 md:pb-5", size === "document" && "md:pt-8 md:pb-7", bordered && "border-b border-line", className)}>
            <SpecGrid fade={false} className="spec-grid-header -z-10" />
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
                        {kicker && <p className="mb-1.5 truncate font-mono text-meta text-ink-muted">{kicker}</p>}
                        <div className="flex min-h-9 min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5">
                            <h1 className={cn("min-w-0 break-words text-ink font-[650]", size === "document" ? "text-display" : "text-title")}>{title}</h1>
                            {titleAdornment}
                        </div>
                        {description && <p className={cn("max-w-[70ch] text-body text-ink-muted", size === "document" ? "mt-2" : "mt-0.5")}>{description}</p>}
                        {meta && <div className="mt-1 text-meta text-ink-muted">{meta}</div>}
                    </div>
                    {actions && <div className={cn("flex shrink-0 flex-wrap items-center gap-2 sm:justify-end", kicker ? (size === "document" ? "sm:pt-7" : "sm:pt-6") : size === "document" && "sm:pt-1")}>{actions}</div>}
                </div>
            </div>
        </header>
    );
}

export function PageContainer({ width = "data", className, innerClassName, children }: { width?: PageWidth; className?: string; innerClassName?: string; children: React.ReactNode }) {
    return (
        <div className={cn("px-4 py-6 md:px-8 md:py-8", className)}>
            <div className={cn("mx-auto w-full", widthClasses[width], innerClassName)}>{children}</div>
        </div>
    );
}
