import { Badge } from "@/components/ui/badge";
import { statusMeta } from "@/lib/status";
import { cn } from "@/lib/utils";

export function StatusPill({ status, kind = "spec", size = "default", className }: { status: string; kind?: "spec" | "run"; size?: "default" | "sm"; className?: string }) {
    const meta = statusMeta(status);
    const Icon = meta.icon;
    return (
        <Badge variant="secondary" size={size} className={cn("gap-1 pr-2.5 pl-1.5", meta.soft, meta.text, className)} title={meta.description || undefined}>
            <Icon size={size === "sm" ? 12 : 13} strokeWidth={2.25} aria-hidden="true" className={status === "running" ? "animate-spin motion-reduce:animate-none" : undefined} />
            {kind === "run" ? meta.runLabel : meta.label}
        </Badge>
    );
}
