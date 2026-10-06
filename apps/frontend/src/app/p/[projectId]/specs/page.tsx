"use client";

import Link from "next/link";
import { use, useEffect, useMemo, useState } from "react";
import { ChevronDown, FileCheck2, MessageSquarePlus, RefreshCw, Search, X } from "lucide-react";
import { NewFeatureDialog, NewSpecDialog } from "@/components/CreateStructureDialogs";
import { EmptyState } from "@/components/EmptyState";
import { PageContainer, PageHeader } from "@/components/PageHeader";
import { SpecRunDialog } from "@/components/SpecRunDialog";
import { SummaryStrip } from "@/components/SummaryStrip";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { errorMessage, getProject, getProjectContext, getProjectTree, isAbortError } from "@/lib/api";
import { formatNumber } from "@/lib/format";
import { matchesInvalidation, onInvalidate } from "@/lib/invalidation";
import { countStatuses, statusMeta } from "@/lib/status";
import { useRunBatch } from "@/lib/useRunBatch";
import { cn } from "@/lib/utils";
import type { Feature, Project, ProjectContextState, SpecStatus, SpecSummary } from "@/lib/types";
import { RunningIcon, SpecTable, SpecTableSkeleton, orderFeatures, lastRunsOf, type SpecGroup } from "./_components/spec-table";

type StatusFilter = "all" | SpecStatus;

const FILTERS: { value: StatusFilter; label: string }[] = [
    { value: "all", label: "All" },
    { value: "failed", label: "Failing" },
    { value: "invalid", label: "Invalid" },
    { value: "unverified", label: "Not run" },
    { value: "passed", label: "Passing" },
];

/** Batches that can be started from the Run menu, problems first. */
const RUN_SUBSETS: { status: SpecStatus; label: string }[] = [
    { status: "failed", label: "Failing" },
    { status: "unverified", label: "Not run" },
];

function plural(count: number, noun: string) {
    return `${formatNumber(count)} ${count === 1 ? noun : `${noun}s`}`;
}

function ContextLine({ projectId, project, contextState }: { projectId: string; project: Project | null; contextState: ProjectContextState | null }) {
    const confirmed = contextState?.confirmed;
    let context: React.ReactNode = null;
    if (contextState && !confirmed) {
        context = (
            <span>
                No project context yet.{" "}
                <Link href={`/p/${projectId}`} className="font-medium text-ink underline underline-offset-2 hover:no-underline">Set up context</Link>
            </span>
        );
    } else if (confirmed) {
        const ctx = confirmed.context;
        const stats = [
            ctx.areas.length > 0 && plural(ctx.areas.length, "area"),
            ctx.terminology.length > 0 && plural(ctx.terminology.length, "term"),
            ctx.roles.length > 0 && plural(ctx.roles.length, "role"),
            ctx.businessRules.length > 0 && plural(ctx.businessRules.length, "rule"),
        ].filter(Boolean);
        context = (
            <Link href={`/p/${projectId}`} className="hover:text-ink hover:underline hover:underline-offset-2">
                Project context{stats.length > 0 ? `: ${stats.join(", ")}` : ""}
            </Link>
        );
    }
    if (!project && !context) return null;
    return (
        <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1">
            {project && (
                <a href={project.baseUrl} target="_blank" rel="noopener noreferrer" className="min-w-0 font-mono text-meta [overflow-wrap:anywhere] hover:text-ink hover:underline hover:underline-offset-2">
                    {project.baseUrl.replace(/^https?:\/\//, "").replace(/\/$/, "")}
                </a>
            )}
            {project && context && <span aria-hidden="true" className="text-ink-disabled">·</span>}
            {context}
        </span>
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
    const [filter, setFilter] = useState<StatusFilter>("all");
    const [query, setQuery] = useState("");
    const runBatch = useRunBatch(projectId);
    const isRunning = runBatch.running;

    useEffect(() => {
        const controller = new AbortController();
        const { signal } = controller;
        setLoadError("");
        getProjectTree(projectId, signal)
            .then((result) => {
                setFeatures(result.features);
                setSpecs(result.specs);
                setSyncWarning(result.syncError ?? "");
            })
            .catch((error) => {
                if (isAbortError(error)) return;
                setLoadError(errorMessage(error));
            });
        getProject(projectId, signal)
            .then((result) => setProject(result.project))
            .catch(() => undefined);
        getProjectContext(projectId)
            .then((result) => { if (!signal.aborted) setContextState(result); })
            .catch(() => undefined);
        return () => controller.abort();
    }, [projectId, retryKey]);

    useEffect(() => onInvalidate((event) => {
        if (matchesInvalidation(event, "tree", projectId)) setRetryKey((key) => key + 1);
    }), [projectId]);

    const lastRuns = useMemo(() => lastRunsOf(specs ?? []), [specs]);

    const crumbs = [{ label: project?.name ?? "Project", href: `/p/${projectId}` }];
    const createActions = features ? (
        <>
            <NewFeatureDialog projectId={projectId} features={features} onCreated={() => setRetryKey((key) => key + 1)} />
            <NewSpecDialog projectId={projectId} features={features} />
        </>
    ) : null;

    if (loadError) {
        return (
            <div className="flex min-h-full flex-col bg-surface">
                <PageHeader title="Specs" breadcrumbs={crumbs} width="data" />
                <EmptyState
                    role="alert"
                    tone="danger"
                    icon={FileCheck2}
                    title="Specs could not load"
                    description={loadError}
                    action={<Button type="button" onClick={() => setRetryKey((key) => key + 1)}><RefreshCw size={14} /> Try again</Button>}
                />
            </div>
        );
    }

    if (!features || !specs) {
        return (
            <div className="flex min-h-full flex-col bg-surface" aria-busy="true" role="status">
                <span className="sr-only">Loading Specs</span>
                <PageHeader title="Specs" breadcrumbs={crumbs} width="data" />
                <PageContainer width="data" innerClassName="space-y-6">
                    <div className="space-y-3"><Skeleton className="h-4 w-80 max-w-full" /><Skeleton className="h-1.5 w-full rounded-full" /></div>
                    <SpecTableSkeleton />
                </PageContainer>
            </div>
        );
    }

    if (specs.length === 0) {
        return (
            <div className="flex min-h-full flex-col bg-surface">
                <PageHeader title="Specs" breadcrumbs={crumbs} width="data" meta={<ContextLine projectId={projectId} project={project} contextState={contextState} />} actions={createActions} />
                <EmptyState
                    icon={FileCheck2}
                    title="No Specs yet"
                    description="Describe a behavior in a chat and the agent saves it here as a Spec you can verify."
                    action={
                        <Button asChild>
                            <Link href={`/p/${projectId}/chats/new`}><MessageSquarePlus size={14} /> Start a chat</Link>
                        </Button>
                    }
                />
            </div>
        );
    }

    const counts = countStatuses(specs);
    const needle = query.trim().toLowerCase();
    const visible = (spec: SpecSummary) => (filter === "all" || spec.status === filter) && (!needle || spec.title.toLowerCase().includes(needle));
    const filtering = filter !== "all" || needle.length > 0;

    const knownFeatureIds = new Set(features.map((feature) => feature.id));
    const groups: SpecGroup[] = orderFeatures(features)
        .map(({ feature, label }) => ({
            id: feature.id,
            title: label,
            href: `/p/${projectId}/features/${feature.id}`,
            specs: specs.filter((spec) => spec.featureId === feature.id && visible(spec)),
            emptyText: "No Specs in this feature yet.",
            hasChildren: features.some((item) => item.parentId === feature.id),
        }))
        // Hide empty groups while filtering, and structural parents that only hold sub-features.
        .filter((group) => group.specs.length > 0 || (!filtering && !group.hasChildren));
    const orphans = specs.filter((spec) => !knownFeatureIds.has(spec.featureId) && visible(spec));
    if (orphans.length > 0) groups.push({ id: "__orphans__", title: "Without a feature", specs: orphans });
    const visibleCount = groups.reduce((sum, group) => sum + group.specs.length, 0);

    function handleRun(selected: SpecSummary[], label: string) {
        const runnable = selected.filter((spec) => spec.status !== "invalid");
        if (runnable.length === 0) return;
        void runBatch.start(label, runnable.map((spec) => ({ id: spec.id, title: spec.title })));
    }

    const runnableCount = specs.filter((spec) => spec.status !== "invalid").length;

    return (
        <div className="flex min-h-full flex-col bg-surface">
            <PageHeader
                title="Specs"
                breadcrumbs={crumbs}
                width="data"
                meta={<ContextLine projectId={projectId} project={project} contextState={contextState} />}
                actions={
                    <>
                        {createActions}
                        <div className="flex items-center">
                            <Button type="button" size="sm" className="rounded-r-none" disabled={isRunning || runnableCount === 0} onClick={() => handleRun(specs, "Run all Specs")}>
                                <RunningIcon running={isRunning} size={13} /> {isRunning ? "Running..." : "Run all"}
                            </Button>
                            <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                    <Button type="button" size="sm" className="w-8 rounded-l-none border-l border-primary-foreground/20 px-0" disabled={isRunning} aria-label="More run options">
                                        <ChevronDown size={14} />
                                    </Button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="end" className="min-w-48">
                                    <DropdownMenuLabel>Run a subset</DropdownMenuLabel>
                                    <DropdownMenuSeparator />
                                    <DropdownMenuItem onClick={() => handleRun(specs, "Run all Specs")}>
                                        All Specs <span className="ml-auto tabular text-ink-subtle">{runnableCount}</span>
                                    </DropdownMenuItem>
                                    {RUN_SUBSETS.map(({ status, label }) => {
                                        const count = counts[status] ?? 0;
                                        return (
                                            <DropdownMenuItem key={status} disabled={count === 0} onClick={() => handleRun(specs.filter((spec) => spec.status === status), `Run ${label.toLowerCase()} Specs`)}>
                                                {label} <span className="ml-auto tabular text-ink-subtle">{count}</span>
                                            </DropdownMenuItem>
                                        );
                                    })}
                                    {filtering && visibleCount > 0 && (
                                        <DropdownMenuItem onClick={() => handleRun(groups.flatMap((group) => group.specs), "Run filtered Specs")}>
                                            Shown in the list <span className="ml-auto tabular text-ink-subtle">{visibleCount}</span>
                                        </DropdownMenuItem>
                                    )}
                                </DropdownMenuContent>
                            </DropdownMenu>
                        </div>
                    </>
                }
            />
            <PageContainer width="data" innerClassName="space-y-6">
                {syncWarning && <Alert variant="warning" role="status"><AlertDescription>Remote sync failed. Showing the local index: {syncWarning}</AlertDescription></Alert>}

                <SummaryStrip counts={counts} />

                <div className="space-y-3">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                        <div role="group" aria-label="Filter by status" className="-mx-1 flex flex-wrap items-center gap-1">
                            {FILTERS.filter((item) => item.value === "all" || (counts[item.value] ?? 0) > 0).map((item) => {
                                const active = filter === item.value;
                                const count = item.value === "all" ? specs.length : counts[item.value] ?? 0;
                                const Icon = item.value === "all" ? null : statusMeta(item.value).icon;
                                return (
                                    <Button
                                        key={item.value}
                                        type="button"
                                        variant="ghost"
                                        size="sm"
                                        aria-pressed={active}
                                        onClick={() => setFilter(item.value)}
                                        className={cn("h-8 gap-1.5 rounded-full px-3", active && "bg-surface-selected text-ink hover:bg-surface-selected")}
                                    >
                                        {Icon && <Icon size={12} strokeWidth={2.25} aria-hidden="true" className={statusMeta(item.value).text} />}
                                        {item.label}
                                        <span className="tabular text-ink-subtle">{count}</span>
                                    </Button>
                                );
                            })}
                        </div>
                        <div className="relative sm:w-64">
                            <Search size={14} aria-hidden="true" className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-ink-subtle" />
                            <Input
                                type="search"
                                value={query}
                                onChange={(event) => setQuery(event.target.value)}
                                placeholder="Filter by title"
                                aria-label="Filter Specs by title"
                                className="h-8 pr-8 pl-8 [&::-webkit-search-cancel-button]:hidden"
                            />
                            {query && (
                                <button type="button" onClick={() => setQuery("")} aria-label="Clear filter" className="absolute top-1/2 right-1.5 flex size-6 -translate-y-1/2 items-center justify-center rounded-md text-ink-subtle outline-none transition-colors hover:bg-surface-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-ring">
                                    <X size={13} />
                                </button>
                            )}
                        </div>
                    </div>

                    {visibleCount === 0 && filtering ? (
                        <div className="rounded-xl border border-line">
                            <EmptyState
                                size="compact"
                                icon={Search}
                                title="No Specs match"
                                description="Try another status or a different title."
                                action={<Button type="button" variant="outline" size="sm" onClick={() => { setFilter("all"); setQuery(""); }}>Clear filters</Button>}
                            />
                        </div>
                    ) : (
                        <SpecTable
                            projectId={projectId}
                            label="Specs by feature"
                            groups={groups}
                            lastRuns={lastRuns}
                            running={isRunning}
                            onRunSpec={(spec) => handleRun([spec], `Run ${spec.title}`)}
                            onRunGroup={(group) => handleRun(group.specs, `Run ${typeof group.title === "string" ? group.title : "feature"}`)}
                        />
                    )}
                    {filtering && visibleCount > 0 && (
                        <p className="text-meta text-ink-subtle" aria-live="polite">Showing {plural(visibleCount, "Spec")} of {formatNumber(specs.length)}.</p>
                    )}
                </div>
            </PageContainer>
            <SpecRunDialog
                open={runBatch.open}
                onOpenChange={runBatch.setOpen}
                title={runBatch.title}
                items={runBatch.items}
                running={runBatch.running}
                reportUrl={runBatch.reportUrl}
                error={runBatch.error}
                warning={runBatch.warning}
            />
        </div>
    );
}
