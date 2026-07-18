import { AlertTriangle, Check, CircleDashed, GitMerge, LoaderCircle, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";

const styles: Record<string, string> = {
    passed: "success",
    failed: "danger",
    unverified: "pending",
    invalid: "invalid",
    conflict: "conflict",
    running: "secondary",
    error: "danger",
};

const labels: Record<string, string> = {
    passed: "Passed",
    failed: "Failed",
    unverified: "Changed",
    invalid: "Invalid",
    conflict: "Conflict",
    running: "Running",
    error: "Error",
};

function StatusIcon({ status }: { status: string }) {
    if (status === "passed") return <Check size={11} strokeWidth={2.4} />;
    if (status === "failed" || status === "error") return <X size={11} strokeWidth={2.4} />;
    if (status === "running") return <LoaderCircle size={11} className="animate-spin motion-reduce:animate-none" />;
    if (status === "unverified") return <CircleDashed size={11} />;
    if (status === "invalid") return <AlertTriangle size={11} />;
    if (status === "conflict") return <GitMerge size={11} />;
    return <CircleDashed size={11} />;
}

export function StatusPill({ status }: { status: string }) {
    return (
        <Badge variant={(styles[status] ?? "secondary") as "success" | "danger" | "pending" | "secondary" | "invalid" | "conflict"}>
            <StatusIcon status={status} />
            {labels[status] ?? status}
        </Badge>
    );
}
