import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

type EmptyTone = "neutral" | "danger" | "success" | "warning";

const toneClasses: Record<EmptyTone, string> = {
    neutral: "bg-surface-hover text-ink-muted",
    danger: "bg-danger-soft text-danger",
    success: "bg-success-soft text-success",
    warning: "bg-warning-soft text-warning-icon",
};

/**
 * Icon in a soft tinted circle, a one-line title, one line of help, and at most one primary action.
 * `size="compact"` fits inside lists and the sidebar; `default` centers in a page region.
 */
export function EmptyState({
    icon: Icon,
    title,
    description,
    action,
    secondaryAction,
    tone = "neutral",
    size = "default",
    className,
    role,
}: {
    icon?: LucideIcon;
    title: React.ReactNode;
    description?: React.ReactNode;
    action?: React.ReactNode;
    secondaryAction?: React.ReactNode;
    tone?: EmptyTone;
    size?: "default" | "compact";
    className?: string;
    role?: "status" | "alert";
}) {
    const compact = size === "compact";
    return (
        <div role={role} className={cn("flex flex-col items-center text-center", compact ? "px-4 py-6" : "mx-auto max-w-sm px-5 py-12", className)}>
            {Icon && (
                <span className={cn("mb-3 flex items-center justify-center rounded-full", compact ? "size-9" : "mb-4 size-12", toneClasses[tone])}>
                    <Icon size={compact ? 16 : 20} strokeWidth={1.9} aria-hidden="true" />
                </span>
            )}
            <p className={cn("font-semibold text-ink", compact ? "text-control" : "text-section")}>{title}</p>
            {description && <p className={cn("mt-1 text-ink-muted", compact ? "text-meta" : "text-control leading-5")}>{description}</p>}
            {(action || secondaryAction) && <div className={cn("flex flex-wrap items-center justify-center gap-2", compact ? "mt-3" : "mt-5")}>{action}{secondaryAction}</div>}
        </div>
    );
}
