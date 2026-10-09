import { statusMeta } from "@/lib/status";
import { cn } from "@/lib/utils";

export function StatusDot({ status, size = 14, className }: { status: string; size?: number; className?: string }) {
    const meta = statusMeta(status);
    const Icon = meta.icon;
    return (
        <span role="img" aria-label={`Status: ${meta.label}`} title={meta.label} className={cn("inline-flex shrink-0 items-center justify-center", meta.text, className)}>
            <Icon size={size} strokeWidth={2.25} aria-hidden="true" className={status === "running" ? "animate-spin motion-reduce:animate-none" : undefined} />
        </span>
    );
}
