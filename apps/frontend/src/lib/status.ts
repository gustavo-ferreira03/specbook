import { AlertTriangle, Check, CircleDashed, LoaderCircle, X, type LucideIcon } from "lucide-react";
import type { RunStatus, SpecHealth, SpecStatus } from "./types";

export type AnyStatus = SpecStatus | RunStatus | SpecHealth["status"];
export type StatusTone = "success" | "danger" | "warning" | "invalid" | "neutral" | "running";

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
    warning: { text: "text-warning", soft: "bg-warning-soft", chart: "bg-warning-chart" },
    invalid: { text: "text-invalid", soft: "bg-invalid-soft", chart: "bg-invalid-chart" },
    neutral: { text: "text-ink-subtle", soft: "bg-neutral-soft", chart: "bg-neutral-chart" },
    running: { text: "text-running", soft: "bg-running-soft", chart: "bg-running-chart" },
};

// One vocabulary for both spec states and health states: "Passing"/"Failing" describe a Spec now,
// "Passed"/"Failed" describe a single run.
const STATUS: Record<AnyStatus, Omit<StatusMeta, "text" | "soft" | "chart">> = {
    draft: { label: "Draft", runLabel: "Draft", description: "Run manually and activate when ready. Automatic runs exclude drafts.", tone: "neutral", icon: CircleDashed },
    passed: { label: "Passing", runLabel: "Passed", description: "The last run passed.", tone: "success", icon: Check },
    failed: { label: "Failing", runLabel: "Failed", description: "The last run failed.", tone: "danger", icon: X },
    error: { label: "Error", runLabel: "Error", description: "The run could not complete.", tone: "danger", icon: X },
    invalid: { label: "Invalid", runLabel: "Invalid", description: "The Spec files could not be read.", tone: "invalid", icon: AlertTriangle },
    unverified: { label: "Not run", runLabel: "Not run", description: "Not run since it was created or changed.", tone: "neutral", icon: CircleDashed },
    running: { label: "Running", runLabel: "Running", description: "A run is in progress.", tone: "running", icon: LoaderCircle },
    passing: { label: "Passing", runLabel: "Passed", description: "The last run passed.", tone: "success", icon: Check },
    failing: { label: "Failing", runLabel: "Failed", description: "The last run failed.", tone: "danger", icon: X },
    flaky: { label: "Flaky", runLabel: "Passed on retry", description: "The run failed, then passed on retry.", tone: "warning", icon: AlertTriangle },
    not_checked: { label: "Not run", runLabel: "Not run", description: "There is no completed run for the current Spec.", tone: "neutral", icon: CircleDashed },
};

export const NO_SPECS_DESCRIPTION = "Describe a behavior in a chat and the agent saves it here as a Spec.";

export function statusMeta(status: string): StatusMeta {
    const base = STATUS[status as AnyStatus] ?? { label: status, runLabel: status, description: "", tone: "neutral" as const, icon: CircleDashed };
    return { ...base, ...TONES[base.tone] };
}

/** Display order for summaries: problems first, then not run, then passing. */
export const SPEC_STATUS_ORDER: SpecStatus[] = ["failed", "invalid", "unverified", "passed"];

export type StatusCounts = Partial<Record<SpecStatus, number>>;

export function countStatuses(items: { status: SpecStatus }[]): StatusCounts {
    const counts: StatusCounts = {};
    for (const item of items) counts[item.status] = (counts[item.status] ?? 0) + 1;
    return counts;
}
