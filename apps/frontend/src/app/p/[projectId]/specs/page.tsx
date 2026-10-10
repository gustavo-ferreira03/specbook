"use client";

import { useAuth } from "@/components/AuthProvider";

import Link from "next/link";
import { use, useEffect, useMemo, useState } from "react";
import { ChevronDown, FileCheck2, Plus, RefreshCw, Search, X } from "lucide-react";
import { NewFeatureDialog, NewSpecDialog } from "@/components/CreateStructureDialogs";
import { EmptyState } from "@/components/EmptyState";
import { EnvironmentSelect } from "@/components/EnvironmentSelect";
import { SpecsFrontMatter } from "@/components/SpecsFrontMatter";
import { PageContainer, PageHeader } from "@/components/PageHeader";
import { SpecRunDialog } from "@/components/SpecRunDialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { errorMessage, getProjectTree, isAbortError } from "@/lib/api";
import { useRunEnvironment } from "@/lib/useRunEnvironment";
import { formatNumber } from "@/lib/format";
import { matchesInvalidation, onInvalidate } from "@/lib/invalidation";
import { NO_SPECS_DESCRIPTION, countStatuses, statusMeta } from "@/lib/status";
import { useRunBatch } from "@/lib/useRunBatch";
import { cn } from "@/lib/utils";
import type { Feature, SpecStatus, SpecSummary } from "@/lib/types";
import { RunningIcon, SpecTable, SpecTableSkeleton, orderFeatures, lastRunsOf, type SpecGroup } from "./_components/spec-table";

type StatusFilter = "all" | SpecStatus;

const FILTERS: { value: StatusFilter; label: string }[] = [
    { value: "all", label: "All" },
    { value: "failed", label: "Failing" },
    { value: "invalid", label: "Invalid" },
    { value: "unverified", label: "Not run" },
    { value: "passed", label: "Passing" },
];

const RUN_SUBSETS: { status: SpecStatus; label: string }[] = [
    { status: "failed", label: "Failing" },
    { status: "unverified", label: "Not run" },
];

function plural(count: number, noun: string) {
    return `${formatNumber(count)} ${count === 1 ? noun : `${noun}s`}`;
}

export default function SpecsDashboard({ params }: { params: Promise<{ projectId: string }> }) {
    const { canEdit } = useAuth();
    const { projectId } = use(params);
    const [features, setFeatures] = useState<Feature[] | null>(null);
    const [specs, setSpecs] = useState<SpecSummary[] | null>(null);
    const [syncWarning, setSyncWarning] = useState("");
    const [loadError, setLoadError] = useState("");
    const [retryKey, setRetryKey] = useState(0);
    const [filter, setFilter] = useState<StatusFilter>("all");
    const [query, setQuery] = useState("");
    const [environment, setEnvironment] = useRunEnvironment(projectId);
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
        return () => controller.abort();
    }, [projectId, retryKey]);

    const pendingRun = Boolean(specs?.some((spec) => spec.lastRun?.status === "running" || spec.lastRun?.automationPending));
    useEffect(() => {
        if (!pendingRun) return;
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout>;
        async function refreshRuns() {
            try {
                const result = await getProjectTree(projectId, controller.signal);
                setFeatures(result.features);
                setSpecs(result.specs);
                setLoadError("");
            } catch (error) {
                if (!isAbortError(error)) setLoadError(errorMessage(error));
            } finally {
                if (!controller.signal.aborted) timer = setTimeout(() => void refreshRuns(), 1500);
            }
        }
        timer = setTimeout(() => void refreshRuns(), 1500);
        return () => {
            controller.abort();
            clearTimeout(timer);
        };
    }, [pendingRun, projectId]);

    useEffect(() => onInvalidate((event) => {
        if (matchesInvalidation(event, "tree", projectId)) setRetryKey((key) => key + 1);
    }), [projectId]);

    const lastRuns = useMemo(() => lastRunsOf(specs ?? []), [specs]);

    const createActions = features ? (
        <>
            <NewFeatureDialog projectId={projectId} features={features} onCreated={() => setRetryKey((key) => key + 1)} />
            <NewSpecDialog projectId={projectId} features={features} />
        </>
    ) : null;

    if (loadError) {
        return (
            <div className="flex min-h-full flex-col bg-surface">
                <PageHeader title="Specs" width="data" />
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
                <PageHeader title="Specs" width="data" />
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
                <PageHeader title="Specs" width="data" actions={createActions} />
                <EmptyState
                    icon={FileCheck2}
                    title="No Specs yet"
                    description={NO_SPECS_DESCRIPTION}
                    action={canEdit &&
                        <Button asChild>
                            <Link href={`/p/${projectId}/chats/new`}><Plus size={14} /> New chat</Link>
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
            specs: specs.filter((spec) => spec.featureId === feature.id && visible(spec)),
            emptyText: "No Specs in this feature yet.",
            hasChildren: features.some((item) => item.parentId === feature.id),
        }))
        .filter((group) => group.specs.length > 0 || (!filtering && !group.hasChildren));
    const orphans = specs.filter((spec) => !knownFeatureIds.has(spec.featureId) && visible(spec));
    if (orphans.length > 0) groups.push({ id: "__orphans__", title: "Without a feature", specs: orphans });
    const visibleCount = groups.reduce((sum, group) => sum + group.specs.length, 0);

    function handleRun(selected: SpecSummary[], label: string) {
        const runnable = selected.filter((spec) => spec.status !== "invalid");
        if (runnable.length === 0) return;
        void runBatch.start(label, runnable.map((spec) => ({ id: spec.id, title: spec.title })), environment);
    }

    const runnableCount = specs.filter((spec) => spec.status !== "invalid").length;
    const filterCount = (value: StatusFilter) => value === "all" ? specs.length : counts[value] ?? 0;

    const runControls = (
        <>
            <EnvironmentSelect projectId={projectId} value={environment} onValueChange={setEnvironment} disabled={isRunning} />
                        <div className="group/split flex items-center">
                            <Button type="button" size="sm" className="rounded-r-none border-r-0 group-hover/split:bg-transparent group-hover/split:text-primary" disabled={isRunning || runnableCount === 0} onClick={() => handleRun(specs, "Run all Specs")}>
                                <RunningIcon running={isRunning} size={13} /> {isRunning ? "Running…" : "Run all"}
                            </Button>
                            <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                    <Button type="button" size="sm" className="w-8 rounded-l-none border-l border-l-primary-foreground/20 px-0 group-hover/split:border-l-primary/30 group-hover/split:bg-transparent group-hover/split:text-primary" disabled={isRunning} aria-label="More run options">
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
    );

    return (
        <div className="flex min-h-full flex-col bg-surface">
            <PageHeader
                title="Specs"
                width="data"
            />
            <PageContainer width="data" innerClassName="space-y-6">
                <SpecsFrontMatter projectId={projectId} />
                {syncWarning && <Alert variant="warning" role="status"><AlertDescription>Remote sync failed. Showing the local index: {syncWarning}</AlertDescription></Alert>}

                <div className="space-y-3">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                        <div role="group" aria-label="Filter by status" className="-mx-1 flex flex-wrap items-center gap-1">
                            {FILTERS.filter((item) => item.value === "all" || filterCount(item.value) > 0).map((item) => {
                                const active = filter === item.value;
                                const count = filterCount(item.value);
                                const Icon = item.value === "all" ? null : statusMeta(item.value).icon;
                                return (
                                    <Button
                                        key={item.value}
                                        type="button"
                                        variant="ghost"
                                        size="sm"
                                        aria-pressed={active}
                                        onClick={() => setFilter(item.value)}
                                        className={cn("h-8 gap-1.5 rounded-full px-3", active && "bg-primary text-primary-foreground hover:bg-primary hover:text-primary-foreground [&_svg]:text-current [&_[class*=text-ink]]:text-primary-foreground/80")}
                                    >
                                        {Icon && <Icon size={12} strokeWidth={2.25} aria-hidden="true" className={statusMeta(item.value).iconColor} />}
                                        {item.label}
                                        <span className="tabular text-ink-subtle">{count}</span>
                                    </Button>
                                );
                            })}
                        </div>
                        <div className="flex flex-wrap items-center gap-2">
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
                        {canEdit && runControls}
                        </div>
                    </div>

                    {visibleCount === 0 && filtering ? (
                        <div className="sheet rounded-xl">
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
                    <div className="flex flex-wrap items-center justify-between gap-3 pt-3">
                        {filtering && visibleCount > 0 ? <p className="text-meta text-ink-subtle" aria-live="polite">Showing {plural(visibleCount, "Spec")} of {formatNumber(specs.length)}.</p> : <span />}
                        {canEdit && createActions && <div className="flex items-center gap-3">{createActions}</div>}
                    </div>
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
                environment={runBatch.environment}
            />
        </div>
    );
}
