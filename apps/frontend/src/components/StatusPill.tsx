import { statusMeta } from "@/lib/status";
import { cn } from "@/lib/utils";

export function StatusPill({ status, kind = "spec", size = "default", className }: { status: string; kind?: "spec" | "run"; size?: "default" | "sm"; className?: string }) {
    const meta = statusMeta(status);
    const Icon = meta.icon;
    return (
        <span className={cn("inline-flex w-fit shrink-0 items-center gap-1.5 text-meta font-medium whitespace-nowrap", size === "sm" ? "h-5" : "h-6", meta.text, className)} title={meta.description || undefined}>
            <Icon size={size === "sm" ? 12 : 13} strokeWidth={2.25} aria-hidden="true" className={status === "running" ? "animate-spin motion-reduce:animate-none" : undefined} />
            {kind === "run" ? meta.runLabel : meta.label}
        </span>
    );
}
