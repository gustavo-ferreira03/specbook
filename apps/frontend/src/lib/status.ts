import { AlertTriangle, Check, CircleDashed, GitMerge, LoaderCircle, X, type LucideIcon } from "lucide-react";
import type { RunStatus, SpecStatus } from "./types";

export type AnyStatus = SpecStatus | RunStatus;
export type StatusTone = "success" | "danger" | "invalid" | "neutral" | "running" | "conflict";

export interface StatusMeta {
    /** Label for the current state of a Spec ("Failing", "Not run"). */
    label: string;
    /** Label for a single verification run ("Failed"). */
    runLabel: string;
    /** One-line explanation, used in tooltips and legends. */
    description: string;
    tone: StatusTone;
    icon: LucideIcon;
    /** Tailwind classes for the text/icon color, soft background, and chart fill. */
    text: string;
    soft: string;
    chart: string;
}

const TONES: Record<StatusTone, Pick<StatusMeta, "text" | "soft" | "chart">> = {
    success: { text: "text-success", soft: "bg-success-soft", chart: "bg-success-chart" },
    danger: { text: "text-danger", soft: "bg-danger-soft", chart: "bg-danger-chart" },
    invalid: { text: "text-invalid", soft: "bg-invalid-soft", chart: "bg-invalid-chart" },
    neutral: { text: "text-ink-subtle", soft: "bg-neutral-soft", chart: "bg-neutral-chart" },
    running: { text: "text-running", soft: "bg-running-soft", chart: "bg-running-chart" },
    conflict: { text: "text-conflict", soft: "bg-conflict-soft", chart: "bg-conflict-chart" },
};

const STATUS: Record<AnyStatus, Omit<StatusMeta, "text" | "soft" | "chart">> = {
    passed: { label: "Passed", runLabel: "Passed", description: "The last verification passed.", tone: "success", icon: Check },
    failed: { label: "Failing", runLabel: "Failed", description: "The last verification failed.", tone: "danger", icon: X },
    error: { label: "Error", runLabel: "Error", description: "The run could not complete.", tone: "danger", icon: X },
    invalid: { label: "Invalid", runLabel: "Invalid", description: "The Spec files could not be read.", tone: "invalid", icon: AlertTriangle },
    unverified: { label: "Not run", runLabel: "Not run", description: "Not verified since it was created or changed.", tone: "neutral", icon: CircleDashed },
    running: { label: "Running", runLabel: "Running", description: "A verification is in progress.", tone: "running", icon: LoaderCircle },
    conflict: { label: "Conflict", runLabel: "Conflict", description: "Local and remote changes conflict.", tone: "conflict", icon: GitMerge },
};

export function statusMeta(status: string): StatusMeta {
    const base = STATUS[status as AnyStatus] ?? { label: status, runLabel: status, description: "", tone: "neutral" as const, icon: CircleDashed };
    return { ...base, ...TONES[base.tone] };
}

/** Display order for summaries: problems first, then not run, then passing. */
export const SPEC_STATUS_ORDER: SpecStatus[] = ["failed", "invalid", "conflict", "unverified", "passed"];

export type StatusCounts = Partial<Record<SpecStatus, number>>;

export function countStatuses(items: { status: SpecStatus }[]): StatusCounts {
    const counts: StatusCounts = {};
    for (const item of items) counts[item.status] = (counts[item.status] ?? 0) + 1;
    return counts;
}
