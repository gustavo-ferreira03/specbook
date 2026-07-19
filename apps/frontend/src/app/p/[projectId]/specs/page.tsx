"use client";

import Link from "next/link";
import { use, useEffect, useState } from "react";
import { Pie, PieChart } from "recharts";
import { AlertTriangle, ArrowRight, Check, CircleDashed, FileCheck2, GitMerge, Play, RefreshCw, X } from "lucide-react";
import { NewFeatureDialog, NewSpecDialog } from "@/components/CreateStructureDialogs";
import { LogoMark } from "@/components/LogoMark";
import { PageHeader } from "@/components/PageHeader";
import { StatusPill } from "@/components/StatusPill";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { Skeleton } from "@/components/ui/skeleton";
import { api, getProjectContext, startRunBatch } from "@/lib/api";
import type { Feature, Project, ProjectContextState, SpecStatus, SpecSummary } from "@/lib/types";

const STATUS_ORDER: SpecStatus[] = ["passed", "failed", "invalid", "conflict", "unverified"];

const STATUS_CHART_CONFIG: ChartConfig = {
    passed: { label: "Passed", color: "var(--color-success-chart)" },
    failed: { label: "Failed", color: "var(--color-danger-chart)" },
    unverified: { label: "Unverified", color: "var(--color-pending-chart)" },
    invalid: { label: "Invalid", color: "var(--color-invalid-chart)" },
    conflict: { label: "Conflict", color: "var(--color-conflict-chart)" },
};

const STATUS_ICON: Record<SpecStatus, React.ComponentType<{ size?: number; className?: string }>> = {
    passed: Check,
    failed: X,
    unverified: CircleDashed,
    invalid: AlertTriangle,
    conflict: GitMerge,
};

function StatTile({ label, value, tone }: { label: string; value: number; tone?: "success" | "danger" | "pending" }) {
    const toneClass = tone === "success" ? "text-success" : tone === "danger" ? "text-danger" : tone === "pending" ? "text-pending" : "text-ink";
    return (
        <div className="rounded-[13px] border border-line bg-surface p-4">
            <p className="text-[0.625rem] font-bold tracking-[0.08em] text-ink-faint uppercase">{label}</p>
            <p className={`mt-1.5 text-xl font-bold tracking-[-0.02em] tabular-nums ${toneClass}`}>{value}</p>
        </div>
    );
}

export default function SpecsDashboard({ params }: { params: Promise<{ projectId: string }> }) {
    const { projectId } = use(params);
    const [features, setFeatures] = useState<Feature[] | null>(null);
    const [specs, setSpecs] = useState<SpecSummary[] | null>(null);
    const [project, setProject] = useState<Project | null>(null);
    const [contextState, setContextState] = useState<ProjectContextState | null>(null);
    const [syncWarning, setSyncWarning] = useState("");
    const [loadError, setLoadError] = useState("");
    const [retryKey, setRetryKey] = useState(0);
    const [isRunning, setIsRunning] = useState(false);

    useEffect(() => {
        let active = true;
        setLoadError("");
        api<{ features: Feature[]; specs: SpecSummary[]; syncError: string | null }>(`/projects/${projectId}/tree`)
            .then((result) => {
                if (!active) return;
                setFeatures(result.features);
                setSpecs(result.specs);
                setSyncWarning(result.syncError ?? "");
            })
            .catch((error) => {
                if (!active) return;
                setLoadError(error instanceof Error ? error.message : String(error));
            });
        api<{ project: Project }>(`/projects/${projectId}`)
            .then((result) => { if (active) setProject(result.project); })
            .catch(() => undefined);
        getProjectContext(projectId)
            .then((result) => { if (active) setContextState(result); })
            .catch(() => undefined);
        return () => {
            active = false;
        };
    }, [projectId, retryKey]);

    if (loadError) {
        return (
            <div className="flex min-h-full flex-col bg-surface">
                <PageHeader title="Specs" eyebrow="Project" />
                <div className="flex flex-1 items-center justify-center px-5 py-10">
                    <Alert variant="destructive" className="w-full max-w-sm bg-transparent text-center" role="alert">
                        <AlertDescription className="text-xs leading-5">{loadError}</AlertDescription>
                        <Button type="button" onClick={() => setRetryKey((key) => key + 1)} className="mx-auto mt-4">
                            <RefreshCw size={14} /> Try again
                        </Button>
                    </Alert>
                </div>
            </div>
        );
    }

    if (!features || !specs) {
        return (
            <div className="flex min-h-full flex-col bg-surface" aria-busy="true" role="status">
                <span className="sr-only">Loading Specs dashboard</span>
                <PageHeader title="Specs" eyebrow="Project" />
                <div className="mx-auto w-full max-w-[1040px] space-y-4 px-5 py-8">
                    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                        {Array.from({ length: 4 }).map((_, index) => <Skeleton key={index} className="h-20 rounded-[13px]" />)}
                    </div>
                    <div className="grid gap-4 md:grid-cols-[280px_1fr]">
                        <Skeleton className="h-64 rounded-[13px]" />
                        <Skeleton className="h-64 rounded-[13px]" />
                    </div>
                </div>
            </div>
        );
    }

    if (specs.length === 0) {
        return (
            <div className="flex min-h-full flex-col bg-surface">
                <PageHeader title="Specs" eyebrow="Project" />
                <div className="flex flex-1 items-center justify-center px-5 py-10">
                    <div className="max-w-[420px] text-center">
                        <LogoMark className="mx-auto size-9" />
                        <h2 className="mt-4 text-sm font-bold">No Specs yet</h2>
                        <p className="mt-2 text-xs leading-5 text-ink-soft">
                            Describe a behavior in a chat and the agent will save it as a verified Spec here.
                        </p>
                        <Button asChild className="mt-5">
                            <Link href={`/p/${projectId}/chats/new`}>
                                <FileCheck2 size={13} /> Start a chat
                            </Link>
                        </Button>
                        <div className="mt-4 flex justify-center gap-2">
                            <NewFeatureDialog projectId={projectId} features={features} onCreated={() => setRetryKey((key) => key + 1)} />
                            <NewSpecDialog projectId={projectId} features={features} />
                        </div>
                    </div>
                </div>
            </div>
        );
    }

    const featureById = new Map(features.map((feature) => [feature.id, feature]));
    const counts = STATUS_ORDER.reduce<Record<SpecStatus, number>>(
        (acc, status) => ({ ...acc, [status]: 0 }),
        { passed: 0, failed: 0, unverified: 0, invalid: 0, conflict: 0 },
    );
    for (const spec of specs) counts[spec.status] += 1;

    const chartData = STATUS_ORDER.filter((status) => counts[status] > 0).map((status) => ({
        status,
        count: counts[status],
        fill: `var(--color-${status})`,
    }));

    const listPriority: Record<SpecStatus, number> = {
        conflict: 0,
        invalid: 1,
        failed: 2,
        unverified: 3,
        passed: 4,
    };
    const orderedSpecs = [...specs].sort((a, b) => listPriority[a.status] - listPriority[b.status]);

    const passRate = specs.length > 0 ? Math.round((counts.passed / specs.length) * 100) : 0;
    const passRateTone = counts.failed > 0 || counts.invalid > 0
        ? "text-danger"
        : counts.conflict > 0 || counts.unverified > 0
          ? "text-pending"
          : "text-success";


    async function handleRun(specIds: string[], label: string) {
        if (specIds.length === 0 || isRunning) return;
        setIsRunning(true);
        try {
            await startRunBatch(projectId, specIds, label);
            setRetryKey((k) => k + 1);
        } catch {
            // batch errors surface via the tree fetch
        } finally {
            setIsRunning(false);
        }
    }

    return (
        <div className="flex min-h-full flex-col bg-surface">
            <PageHeader
                title="Specs"
                eyebrow="Project"
                actions={
                    <div className="flex items-center gap-2">
                        <NewFeatureDialog projectId={projectId} features={features} onCreated={() => setRetryKey((key) => key + 1)} />
                        <NewSpecDialog projectId={projectId} features={features} />
                    </div>
                }
            />
            <div className="mx-auto w-full max-w-[1040px] flex-1 px-5 py-8">
                {syncWarning && <Alert variant="warning" className="mb-4" role="status"><AlertDescription>Remote sync failed. Showing the local index: {syncWarning}</AlertDescription></Alert>}
                {project && (
                    <div className="mb-6 flex items-start justify-between gap-4 border-b border-line pb-4">
                        <div className="min-w-0 flex-1">
                            <div className="flex items-baseline gap-2">
                                <h2 className="text-lg font-bold tracking-[-0.02em] text-ink">{project.name}</h2>
                                <a href={project.baseUrl} target="_blank" rel="noopener noreferrer" className="font-mono text-[0.625rem] text-ink-faint underline-offset-2 hover:underline [overflow-wrap:anywhere]">{project.baseUrl}</a>
                            </div>
                            {(() => {
                                const confirmed = contextState?.confirmed;
                                if (!confirmed) {
                                    return (
                                        <p className="mt-1 text-xs text-ink-faint">
                                            No project context yet.{" "}
                                            <Link href={`/p/${projectId}`} className="underline underline-offset-2 hover:text-ink">Set up context</Link>
                                        </p>
                                    );
                                }
                                const ctx = confirmed.context;
                                const stats = [
                                    ctx.areas.length > 0 && `${ctx.areas.length} ${ctx.areas.length === 1 ? "area" : "areas"}`,
                                    ctx.terminology.length > 0 && `${ctx.terminology.length} ${ctx.terminology.length === 1 ? "term" : "terms"}`,
                                    ctx.roles.length > 0 && `${ctx.roles.length} ${ctx.roles.length === 1 ? "role" : "roles"}`,
                                    ctx.businessRules.length > 0 && `${ctx.businessRules.length} ${ctx.businessRules.length === 1 ? "rule" : "rules"}`,
                                ].filter(Boolean);
                                return (
                                    <>
                                        {ctx.summary && <p className="mt-1 line-clamp-1 text-xs leading-5 text-ink-soft">{ctx.summary}</p>}
                                        {stats.length > 0 && <p className="mt-1.5 text-[0.625rem] text-ink-faint">{stats.join(" · ")}</p>}
                                    </>
                                );
                            })()}
                        </div>
                        <Link href={`/p/${projectId}`} className="mt-0.5 shrink-0 text-ink-faint transition-colors hover:text-ink" aria-label="Project overview">
                            <ArrowRight size={14} />
                        </Link>
                    </div>
                )}
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                    <StatTile label="Total Specs" value={specs.length} />
                    <StatTile label="Passed" value={counts.passed} tone="success" />
                    <StatTile label="Failed" value={counts.failed} tone="danger" />
                    <StatTile label="Unverified" value={counts.unverified} tone="pending" />
                </div>

                <div className="mt-4 grid gap-4 md:grid-cols-[280px_1fr] md:items-start">
                    <div className="rounded-[13px] border border-line bg-surface p-4">
                        <p className="text-[0.625rem] font-bold tracking-[0.08em] text-ink-faint uppercase">Status breakdown</p>
                        <p className="mt-1 text-xs text-ink-soft">
                            <span className={`font-bold ${passRateTone}`}>{passRate}%</span> of Specs are passing
                        </p>
                        <ChartContainer config={STATUS_CHART_CONFIG} className="mx-auto mt-3 aspect-square max-h-[170px]">
                            <PieChart>
                                <ChartTooltip content={<ChartTooltipContent nameKey="status" hideLabel />} />
                                <Pie data={chartData} dataKey="count" nameKey="status" innerRadius="55%" outerRadius="85%" strokeWidth={2} stroke="var(--color-surface)" />
                            </PieChart>
                        </ChartContainer>
                        {chartData.length > 1 && (
                            <ul className="mt-4 space-y-1.5 border-t border-line pt-3">
                                {STATUS_ORDER.filter((status) => counts[status] > 0).map((status) => {
                                    const Icon = STATUS_ICON[status];
                                    return (
                                        <li key={status} className="flex items-center justify-between gap-2 text-[0.6875rem]">
                                            <span className="flex items-center gap-1.5 text-ink-soft">
                                                <Icon size={11} className="text-ink-faint" />
                                                {STATUS_CHART_CONFIG[status].label}
                                            </span>
                                            <span className="font-bold text-ink">{counts[status]}</span>
                                        </li>
                                    );
                                })}
                            </ul>
                        )}
                    </div>

                    <div className="rounded-[13px] border border-line bg-surface p-4 md:flex md:max-h-80 md:flex-col">
                        <div className="shrink-0 flex items-center justify-between">
                            <p className="text-[0.625rem] font-bold tracking-[0.08em] text-ink-faint uppercase">All Specs</p>
                            <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                    <Button variant="ghost" size="sm" disabled={isRunning}>
                                        <Play size={12} /> Run
                                    </Button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="end" className="min-w-36">
                                    <DropdownMenuItem onClick={() => handleRun(specs.map((s) => s.id), "Run all")}>
                                        Run All
                                    </DropdownMenuItem>
                                    {STATUS_ORDER.filter((status) => status !== "passed").map((status) => {
                                        const count = specs.filter((s) => s.status === status).length;
                                        if (count === 0) return null;
                                        return (
                                            <DropdownMenuItem
                                                key={status}
                                                onClick={() => handleRun(specs.filter((s) => s.status === status).map((s) => s.id), `Run ${status}`)}
                                            >
                                                Run {STATUS_CHART_CONFIG[status].label}
                                            </DropdownMenuItem>
                                        );
                                    })}
                                </DropdownMenuContent>
                            </DropdownMenu>
                        </div>
                        <ul aria-label="All Specs" className="mt-2 -mx-2.5 space-y-0.5 md:min-h-0 md:flex-1 md:overflow-y-auto md:overscroll-contain md:px-2.5">
                            {orderedSpecs.map((spec) => {
                                const feature = featureById.get(spec.featureId);
                                return (
                                    <li key={spec.id}>
                                        <Link
                                            href={`/p/${projectId}/specs/${spec.id}`}
                                            className="flex items-center justify-between gap-3 rounded-[9px] px-2.5 py-2.5 transition-colors hover:bg-surface-hover"
                                        >
                                            <span className="min-w-0 flex-1">
                                                <span className="block truncate text-xs font-semibold text-ink">{spec.title}</span>
                                                {feature && <span className="mt-0.5 block truncate text-[0.625rem] text-ink-faint">{feature.title}</span>}
                                            </span>
                                            <StatusPill status={spec.status} />
                                        </Link>
                                    </li>
                                );
                            })}
                        </ul>
                    </div>
                </div>
            </div>
        </div>
    );
}
