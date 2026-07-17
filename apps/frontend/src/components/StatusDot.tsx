import { Check, CircleDashed, Clock3, LoaderCircle, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";

const colors: Record<string, string> = {
    passed: "text-success",
    failed: "text-danger",
    unverified: "text-pending",
    running: "text-ink",
    error: "text-danger",
    draft: "text-ink-faint",
};

function Icon({ status }: { status: string }) {
    if (status === "passed") return <Check size={11} strokeWidth={2.5} />;
    if (status === "failed" || status === "error") return <X size={11} strokeWidth={2.5} />;
    if (status === "running") return <LoaderCircle size={11} className="animate-spin motion-reduce:animate-none" />;
    if (status === "unverified") return <CircleDashed size={11} />;
    return <Clock3 size={11} />;
}

export function StatusDot({ status }: { status: string }) {
    return (
        <Badge role="img" aria-label={`Status: ${status}`} variant="outline" className={`size-3 border-0 bg-transparent p-0 ${colors[status] ?? colors.draft}`}>
            <Icon status={status} />
        </Badge>
    );
}
