"use client";

import { useAuth } from "@/components/AuthProvider";

import Link from "next/link";
import { Folder, LoaderCircle, Play, RotateCcw } from "lucide-react";
import { RelativeTime } from "@/components/RelativeTime";
import { StatusPill } from "@/components/StatusPill";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { countLabel, formatDuration, formatNumber } from "@/lib/format";
import { SPEC_STATUS_ORDER, countStatuses, statusMeta } from "@/lib/status";
import { cn } from "@/lib/utils";
import type { Feature, Run, SpecSummary } from "@/lib/types";

/** Most recent run per Spec: `undefined` while loading, `null` when the Spec was never run. */
export type LastRuns = Record<string, Run | null | undefined>;

/** Latest run per Spec, as carried by the project tree. */
export function lastRunsOf(specs: SpecSummary[]): LastRuns {
    return Object.fromEntries(specs.map((spec) => [spec.id, spec.lastRun ?? null]));
}

/** Features in tree order (parents before children), each with its path label ("Checkout / Payments"). */
export function orderFeatures(features: Feature[], rootId: string | null = null): { feature: Feature; label: string; depth: number }[] {
    const byParent = new Map<string | null, Feature[]>();
    const known = new Set(features.map((feature) => feature.id));
    for (const feature of features) {
        const parent = feature.parentId && known.has(feature.parentId) ? feature.parentId : null;
        byParent.set(parent, [...(byParent.get(parent) ?? []), feature]);
    }
    const result: { feature: Feature; label: string; depth: number }[] = [];
    function visit(parentId: string | null, trail: string[], depth: number) {
        for (const feature of byParent.get(parentId) ?? []) {
            const path = [...trail, feature.title];
            result.push({ feature, label: path.join(" / "), depth });
            visit(feature.id, path, depth + 1);
        }
    }
    visit(rootId, [], 0);
    return result;
}

export interface SpecGroup {
    id: string;
    title: React.ReactNode;
    href?: string;
    specs: SpecSummary[];
    /** Shown when the group has no Specs. */
    emptyText?: string;
    /** Hide the group header row (e.g. the Feature's own Specs on the Feature page). */
    hideHeader?: boolean;
}

function canRun(spec: SpecSummary) {
    return spec.status !== "invalid";
}

function GroupSummary({ specs }: { specs: SpecSummary[] }) {
    const counts = countStatuses(specs);
    const problems = SPEC_STATUS_ORDER.filter((status) => status !== "passed" && (counts[status] ?? 0) > 0);
    if (problems.length === 0) return null;
    return (
        <span className="hidden items-center gap-2.5 text-meta text-ink-muted sm:flex">
            {problems.map((status) => {
                const meta = statusMeta(status);
                const Icon = meta.icon;
                return (
                    <span key={status} className="inline-flex items-center gap-1" title={meta.label}>
                        <Icon size={12} strokeWidth={2.25} aria-hidden="true" className={meta.text} />
                        <span className="tabular">{formatNumber(counts[status] ?? 0)}</span>
                        <span className="sr-only">{meta.label}</span>
                    </span>
                );
            })}
        </span>
    );
}

function LastRunText({ run }: { run: Run | null | undefined }) {
    if (run === undefined) return <Skeleton className="ml-auto h-3 w-20" />;
    if (run === null) return <span className="text-ink-subtle" aria-label="Not run">—</span>;
    return <span className="inline-flex flex-wrap items-center gap-x-1.5 sm:flex-col sm:items-end"><RelativeTime value={run.startedAt} /><span className="text-meta text-ink-subtle" title={run.baseUrl ?? undefined}>{run.environment?.name ?? "Production"}</span></span>;
}

function SpecRow({ projectId, spec, run, running, onRun }: { projectId: string; spec: SpecSummary; run: Run | null | undefined; running: boolean; onRun?: (spec: SpecSummary) => void }) {
    const { canEdit } = useAuth();
    const duration = run?.durationMs != null ? formatDuration(run.durationMs) : null;
    return (
        <li className="group/row relative flex items-center gap-3 border-b border-line px-4 py-2.5 transition-colors duration-150 hover:bg-surface-soft sm:gap-4">
            <span className="hidden w-24 shrink-0 sm:flex">
                <StatusPill status={spec.status} size="sm" />
            </span>
            <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-center gap-2">
                    <Link
                        href={`/p/${projectId}/specs/${spec.id}`}
                        className="min-w-0 flex-1 truncate rounded-sm text-body font-medium text-ink outline-none after:absolute after:inset-0 after:rounded-[inherit] focus-visible:after:ring-2 focus-visible:after:ring-ring focus-visible:after:ring-inset"
                    >
                        {spec.title}
                    </Link>
                    {run?.flaky && <Badge variant="warning" size="sm" title="Failed first, then passed on an automatic retry with no test changes."><RotateCcw size={12} aria-hidden="true" /> Flaky</Badge>}
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-2 text-meta text-ink-muted sm:hidden">
                    <StatusPill status={spec.status} size="sm" />
                    <LastRunText run={run} />
                    {duration && <><span aria-hidden="true" className="text-ink-disabled">·</span><span className="tabular">{duration}</span></>}
                </div>
            </div>
            <span className="hidden w-32 shrink-0 text-right text-meta text-ink-muted sm:block">
                <LastRunText run={run} />
            </span>
            <span className="hidden w-14 shrink-0 text-right text-meta text-ink-subtle tabular sm:block">
                {duration ?? (run === undefined ? "" : "—")}
            </span>
            <span className="relative z-10 flex w-7 shrink-0 justify-end">
                {canEdit && onRun && canRun(spec) && (
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <Button
                                type="button"
                                variant="ghost"
                                size="icon-xs"
                                aria-label={`Run ${spec.title}`}
                                disabled={running}
                                onClick={() => onRun(spec)}
                                className="opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100 disabled:opacity-0 group-hover/row:disabled:opacity-45 [@media(hover:none)]:opacity-100"
                            >
                                <Play size={13} />
                            </Button>
                        </TooltipTrigger>
                        <TooltipContent>Run Spec</TooltipContent>
                    </Tooltip>
                )}
            </span>
        </li>
    );
}

function GroupHeader({ group, running, onRunGroup }: { group: SpecGroup; running: boolean; onRunGroup?: (group: SpecGroup) => void }) {
    const { canEdit } = useAuth();
    const runnable = group.specs.filter(canRun);
    return (
        <li className="flex min-h-11 items-center gap-2.5 border-b border-line bg-surface-soft px-4 py-1.5">
            <Folder size={14} aria-hidden="true" className="shrink-0 text-ink-subtle" />
            <h2 className="min-w-0 truncate text-control font-semibold text-ink">
                {group.href ? <Link href={group.href} className="rounded-sm hover:underline hover:underline-offset-2">{group.title}</Link> : group.title}
            </h2>
            <span className="tabular text-meta text-ink-subtle" aria-label={countLabel(group.specs.length, "Spec")}>{formatNumber(group.specs.length)}</span>
            <span className="flex-1" />
            <GroupSummary specs={group.specs} />
            {canEdit && onRunGroup && runnable.length > 0 && (
                <Button type="button" variant="ghost" size="sm" className="-mr-2 h-7 px-2" disabled={running} onClick={() => onRunGroup(group)} aria-label={`Run ${countLabel(runnable.length, "Spec")} in ${typeof group.title === "string" ? group.title : "this feature"}`}>
                    <Play size={12} /> Run
                </Button>
            )}
        </li>
    );
}

/**
 * Specs as one bordered table grouped by Feature: an optional column header, a header row per
 * Feature (title, count, problem counts, run action), and one row per Spec with status, title,
 * last run, duration, and a hover/focus run action. Nothing scrolls inside it.
 */
export function SpecTable({
    projectId,
    groups,
    lastRuns,
    running,
    onRunSpec,
    onRunGroup,
    label,
    className,
}: {
    projectId: string;
    groups: SpecGroup[];
    lastRuns: LastRuns;
    running: boolean;
    onRunSpec?: (spec: SpecSummary) => void;
    onRunGroup?: (group: SpecGroup) => void;
    label: string;
    className?: string;
}) {
    return (
        <div className={cn("overflow-hidden rounded-xl border border-line bg-surface", className)}>
            <div aria-hidden="true" className="hidden items-center gap-4 border-b border-line px-4 py-2 text-meta font-semibold tracking-[0.06em] text-ink-subtle uppercase sm:flex">
                <span className="w-24 shrink-0">Status</span>
                <span className="flex-1">Spec</span>
                <span className="w-32 shrink-0 text-right">Last run</span>
                <span className="w-14 shrink-0 text-right">Duration</span>
                <span className="w-7 shrink-0" />
            </div>
            <ul aria-label={label} className="[&>li:last-child>ul>li:last-child]:border-b-0">
                {groups.map((group) => (
                    <li key={group.id}>
                        <ul aria-label={typeof group.title === "string" ? group.title : undefined}>
                            {!group.hideHeader && <GroupHeader group={group} running={running} onRunGroup={onRunGroup} />}
                            {group.specs.length === 0 ? (
                                <li className="border-b border-line px-4 py-3 text-control text-ink-subtle">{group.emptyText ?? "No Specs yet."}</li>
                            ) : (
                                group.specs.map((spec) => (
                                    <SpecRow key={spec.id} projectId={projectId} spec={spec} run={lastRuns[spec.id]} running={running} onRun={onRunSpec} />
                                ))
                            )}
                        </ul>
                    </li>
                ))}
            </ul>
        </div>
    );
}

/** Placeholder with the same shape as SpecTable. */
export function SpecTableSkeleton({ groups = 3, rows = 3 }: { groups?: number; rows?: number }) {
    return (
        <div className="overflow-hidden rounded-xl border border-line" aria-hidden="true">
            <div className="hidden h-9 border-b border-line sm:block" />
            {Array.from({ length: groups }).map((_, group) => (
                <div key={group}>
                    <div className="flex h-11 items-center gap-2.5 border-b border-line bg-surface-soft px-4"><Skeleton className="h-3.5 w-32" /></div>
                    {Array.from({ length: rows }).map((_, row) => (
                        <div key={row} className="flex h-12 items-center gap-4 border-b border-line px-4 last:border-0">
                            <Skeleton className="hidden h-5 w-16 rounded-full sm:block" />
                            <Skeleton className="h-3.5 flex-1 sm:max-w-72" />
                            <Skeleton className="hidden h-3 w-20 sm:block" />
                        </div>
                    ))}
                </div>
            ))}
        </div>
    );
}

export function RunningIcon({ running, size = 13 }: { running: boolean; size?: number }) {
    return running ? <LoaderCircle size={size} className="animate-spin motion-reduce:animate-none" /> : <Play size={size} />;
}
