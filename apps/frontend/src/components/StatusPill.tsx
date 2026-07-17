import { Check, CircleDashed, Clock3, LoaderCircle, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";

const styles: Record<string, string> = {
    passed: "success",
    failed: "danger",
    unverified: "pending",
    draft: "secondary",
    running: "secondary",
    error: "danger",
};

const labels: Record<string, string> = {
    passed: "Passed",
    failed: "Failed",
    unverified: "Changed",
    draft: "Draft",
    running: "Running",
    error: "Error",
};

function StatusIcon({ status }: { status: string }) {
    if (status === "passed") return <Check size={11} strokeWidth={2.4} />;
    if (status === "failed" || status === "error") return <X size={11} strokeWidth={2.4} />;
    if (status === "running") return <LoaderCircle size={11} className="animate-spin motion-reduce:animate-none" />;
    if (status === "unverified") return <CircleDashed size={11} />;
    return <Clock3 size={11} />;
}

export function StatusPill({ status }: { status: string }) {
    return (
        <Badge variant={(styles[status] ?? styles.draft) as "success" | "danger" | "pending" | "secondary"}>
            <StatusIcon status={status} />
            {labels[status] ?? status}
        </Badge>
    );
}
