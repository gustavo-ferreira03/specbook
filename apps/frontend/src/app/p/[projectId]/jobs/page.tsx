"use client";

import Link from "next/link";
import { use, useCallback, useEffect, useState } from "react";
import { AlertCircle, Bot, Check, ChevronDown, CircleDashed, Inbox, LoaderCircle, Play, RefreshCw, X } from "lucide-react";
import { EmptyState } from "@/components/EmptyState";
import { PageContainer, PageHeader } from "@/components/PageHeader";
import { RelativeTime } from "@/components/RelativeTime";
import { SectionHeader } from "@/components/SectionHeader";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge, type BadgeVariant } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { api, apiPath, errorMessage, isAbortError } from "@/lib/api";
import type { Job, JobAction } from "@/lib/types";

const JOB_STATUSES: Record<Job["status"], { label: string; variant: BadgeVariant; icon: typeof Check }> = {
    queued: { label: "Queued", variant: "neutral", icon: CircleDashed },
    running: { label: "Running", variant: "running", icon: LoaderCircle },
    blocked: { label: "Needs an answer", variant: "warning", icon: AlertCircle },
    completed: { label: "Completed", variant: "success", icon: Check },
    budget_exceeded: { label: "Budget reached", variant: "warning", icon: AlertCircle },
    cancelled: { label: "Cancelled", variant: "neutral", icon: X },
};

function JobAuditLog({ projectId, job }: { projectId: string; job: Job }) {
    const [actions, setActions] = useState<JobAction[] | null>(null);
    const [error, setError] = useState("");
    const [retryKey, setRetryKey] = useState(0);

    useEffect(() => {
        const controller = new AbortController();
        async function load() {
            try {
                const result = await api<{ actions: JobAction[] }>(apiPath`/projects/${projectId}/jobs/${job.id}`, { signal: controller.signal });
                setActions(result.actions);
                setError("");
            } catch (error) {
                if (!isAbortError(error)) setError(errorMessage(error));
            }
        }
        void load();
        const timer = job.status === "running" || job.status === "queued" ? setInterval(() => void load(), 3000) : null;
        return () => {
            controller.abort();
            if (timer) clearInterval(timer);
        };
    }, [projectId, job.id, job.status, retryKey]);

    return (
        <div className="mt-3 space-y-3 rounded-lg border border-line bg-surface-soft p-3.5">
            {error && (
                <Alert variant="danger" role="alert" className="flex flex-wrap items-center justify-between gap-3">
                    <AlertDescription>{error}</AlertDescription>
                    <Button type="button" variant="outline" size="sm" onClick={() => setRetryKey((key) => key + 1)}><RefreshCw size={13} /> Try again</Button>
                </Alert>
            )}
            {!actions && !error ? (
                <div className="space-y-2" aria-busy="true" aria-label="Loading audit log" role="status"><Skeleton className="h-4 w-48" /><Skeleton className="h-4 w-3/4" /></div>
            ) : actions?.length === 0 ? (
                <p className="text-body text-ink-muted">No actions recorded yet.</p>
            ) : actions ? (
                <ol aria-label="Audit log" className="max-h-96 space-y-4 overflow-auto">
                    {actions.map((entry) => (
                        <li key={entry.id}>
                            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                                <span className="text-body font-medium text-ink">{entry.action.replaceAll("_", " ")}</span>
                                <RelativeTime value={entry.createdAt} className="text-meta text-ink-subtle" />
                            </div>
                            {entry.detail && <pre className="mt-1 whitespace-pre-wrap break-words text-meta text-ink-muted">{entry.detail}</pre>}
                        </li>
                    ))}
                </ol>
            ) : null}
        </div>
    );
}

export default function JobsPage({ params }: { params: Promise<{ projectId: string }> }) {
    const { projectId } = use(params);
    const [jobs, setJobs] = useState<Job[] | null>(null);
    const [goal, setGoal] = useState("");
    const [loadError, setLoadError] = useState("");
    const [actionError, setActionError] = useState("");
    const [busy, setBusy] = useState<string | null>(null);
    const [openJobId, setOpenJobId] = useState<string | null>(null);

    const load = useCallback(async (signal?: AbortSignal) => {
        try {
            const result = await api<{ jobs: Job[] }>(apiPath`/projects/${projectId}/jobs`, { signal });
            setJobs(result.jobs);
            setLoadError("");
        } catch (error) {
            if (!isAbortError(error)) setLoadError(errorMessage(error));
        }
    }, [projectId]);

    useEffect(() => {
        const controller = new AbortController();
        void load(controller.signal);
        const timer = setInterval(() => void load(controller.signal), 3000);
        return () => {
            controller.abort();
            clearInterval(timer);
        };
    }, [load]);

    async function start() {
        setBusy("start");
        setActionError("");
        try {
            await api(apiPath`/projects/${projectId}/jobs`, { method: "POST", body: JSON.stringify(goal.trim() ? { goal: goal.trim() } : {}) });
            setGoal("");
            await load();
        } catch (error) {
            setActionError(errorMessage(error));
        } finally {
            setBusy(null);
        }
    }

    async function cancel(id: string) {
        setBusy(id);
        setActionError("");
        try {
            await api(apiPath`/projects/${projectId}/jobs/${id}/cancel`, { method: "POST" });
            await load();
        } catch (error) {
            setActionError(errorMessage(error));
        } finally {
            setBusy(null);
        }
    }

    return (
        <div className="flex min-h-full flex-col bg-surface">
            <PageHeader
                title="Jobs"
                description="The agent works independently and sends results to your Inbox."
                width="data"
                actions={<Button asChild variant="outline"><Link href={`/p/${projectId}/inbox`}><Inbox size={14} /> Open Inbox</Link></Button>}
            />
            <PageContainer width="data" innerClassName="space-y-8">
                {actionError && <Alert variant="danger" role="alert"><AlertDescription>{actionError}</AlertDescription></Alert>}
                <form className="max-w-reading space-y-3" onSubmit={(event) => { event.preventDefault(); void start(); }}>
                    <Label htmlFor="job-goal" className="text-body">What should the agent investigate? <span className="font-normal text-ink-muted">Optional</span></Label>
                    <Textarea id="job-goal" className="text-body" value={goal} onChange={(event) => setGoal(event.target.value)} disabled={busy === "start"} placeholder="Review this project’s Specs and propose improvements" aria-describedby="job-budget" />
                    <div className="flex flex-wrap items-center gap-3">
                        <Button type="submit" disabled={busy !== null}>
                            {busy === "start" ? <LoaderCircle size={14} className="animate-spin motion-reduce:animate-none" /> : <Play size={13} />}
                            {busy === "start" ? "Starting…" : "Start job"}
                        </Button>
                        <p id="job-budget" className="text-meta text-ink-subtle">Up to 80 actions, 100,000 tokens, 10 minutes.</p>
                    </div>
                </form>

                <section aria-labelledby="job-history-heading" className="space-y-3">
                    <SectionHeader id="job-history-heading" title="Job history" count={jobs?.length} />
                    {loadError && jobs && (
                        <Alert variant="danger" role="alert" className="flex flex-wrap items-center justify-between gap-3">
                            <AlertDescription>{loadError}</AlertDescription>
                            <Button type="button" variant="outline" size="sm" onClick={() => void load()}><RefreshCw size={13} /> Try again</Button>
                        </Alert>
                    )}
                    {loadError && !jobs ? (
                        <EmptyState role="alert" tone="danger" icon={AlertCircle} title="Jobs could not load" description={loadError} action={<Button type="button" onClick={() => void load()}><RefreshCw size={14} /> Try again</Button>} />
                    ) : !jobs ? (
                        <div className="space-y-2" aria-busy="true" aria-label="Loading jobs" role="status">
                            {[0, 1, 2].map((row) => <Skeleton key={row} className="h-28 w-full rounded-lg" />)}
                        </div>
                    ) : !jobs.length ? (
                        <div className="rounded-xl border border-line"><EmptyState icon={Bot} title="No jobs yet" description="Leave the goal empty for a general review, or give the agent a specific task." /></div>
                    ) : (
                        <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line" aria-label="Jobs">
                            {jobs.map((job) => {
                                const status = JOB_STATUSES[job.status];
                                const Icon = status.icon;
                                return (
                                    <li id={job.id} key={job.id} className="scroll-mt-4 px-4 py-4">
                                        <div className="flex flex-wrap items-start justify-between gap-3">
                                            <h3 className="min-w-0 max-w-reading flex-1 break-words text-body font-medium text-ink">{job.goal}</h3>
                                            <Badge variant={status.variant}>
                                                <Icon size={12} aria-hidden="true" className={job.status === "running" ? "animate-spin motion-reduce:animate-none" : undefined} />
                                                {status.label}
                                            </Badge>
                                        </div>
                                        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-meta text-ink-subtle">
                                            <span>{job.trigger.replaceAll("_", " ")}</span>
                                            <RelativeTime value={job.createdAt} />
                                            <span className="tabular">{job.actionsUsed}/{job.budget.maxActions} actions</span>
                                            <span className="tabular">{job.tokensUsed.toLocaleString()}/{job.budget.maxTokens.toLocaleString()} tokens</span>
                                            <span className="tabular">{Math.round(job.elapsedMs / 1000)}s active</span>
                                        </div>
                                        <Collapsible open={openJobId === job.id} onOpenChange={(open) => setOpenJobId(open ? job.id : null)}>
                                            <div className="mt-3 flex flex-wrap gap-2">
                                                <CollapsibleTrigger asChild>
                                                    <Button variant="outline" size="sm"><ChevronDown size={13} className={openJobId === job.id ? "rotate-180" : undefined} /> {openJobId === job.id ? "Hide audit log" : "View audit log"}</Button>
                                                </CollapsibleTrigger>
                                                {["queued", "running", "blocked"].includes(job.status) && <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => void cancel(job.id)}>{busy === job.id ? "Cancelling…" : "Cancel job"}</Button>}
                                                {job.status === "blocked" && <Button asChild variant="outline" size="sm"><Link href={`/p/${projectId}/inbox`}>Answer in Inbox</Link></Button>}
                                            </div>
                                            <CollapsibleContent><JobAuditLog projectId={projectId} job={job} /></CollapsibleContent>
                                        </Collapsible>
                                    </li>
                                );
                            })}
                        </ul>
                    )}
                </section>
            </PageContainer>
        </div>
    );
}
