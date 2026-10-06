"use client";

import Link from "next/link";
import { use, useCallback, useEffect, useRef, useState } from "react";
import { Activity, AlertCircle, Check, ChevronDown, CircleDashed, Inbox, LoaderCircle, MessageSquareText, RefreshCw, X } from "lucide-react";
import { EmptyState } from "@/components/EmptyState";
import { PageContainer, PageHeader } from "@/components/PageHeader";
import { RelativeTime } from "@/components/RelativeTime";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge, type BadgeVariant } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Skeleton } from "@/components/ui/skeleton";
import { api, apiPath, errorMessage, isAbortError } from "@/lib/api";
import type { JobAction } from "@/lib/types";

interface ActivityEntry {
    id: string;
    kind: "signal" | "job";
    title: string;
    reason: string;
    status: string;
    createdAt: string;
    jobId?: string;
    specId?: string;
    runId?: string;
}

const ACTIVITY_STATUSES: Record<string, { label: string; variant: BadgeVariant; icon: typeof Check }> = {
    pending: { label: "Waiting", variant: "neutral", icon: CircleDashed },
    queued: { label: "Queued", variant: "neutral", icon: CircleDashed },
    running: { label: "In progress", variant: "running", icon: LoaderCircle },
    processing: { label: "In progress", variant: "running", icon: LoaderCircle },
    blocked: { label: "Needs an answer", variant: "warning", icon: AlertCircle },
    completed: { label: "Completed", variant: "success", icon: Check },
    handled: { label: "Completed", variant: "success", icon: Check },
    observed: { label: "Observed", variant: "neutral", icon: Check },
    ignored: { label: "Observed", variant: "neutral", icon: Check },
    proposed: { label: "Needs review", variant: "warning", icon: CircleDashed },
    failed: { label: "Failed", variant: "danger", icon: X },
    error: { label: "Error", variant: "danger", icon: X },
    budget_exceeded: { label: "Budget reached", variant: "warning", icon: AlertCircle },
    cancelled: { label: "Stopped", variant: "neutral", icon: X },
};

function ActivityDetails({ projectId, entry }: { projectId: string; entry: ActivityEntry }) {
    const [actions, setActions] = useState<JobAction[] | null>(null);
    const [error, setError] = useState("");
    const [retryKey, setRetryKey] = useState(0);

    useEffect(() => {
        if (!entry.jobId) return;
        const controller = new AbortController();
        async function load() {
            try {
                const result = await api<{ actions: JobAction[] }>(apiPath`/projects/${projectId}/jobs/${entry.jobId!}`, { signal: controller.signal });
                setActions(result.actions);
                setError("");
            } catch (error) {
                if (!isAbortError(error)) setError(errorMessage(error));
            }
        }
        void load();
        const timer = ["running", "queued", "processing"].includes(entry.status) ? setInterval(() => void load(), 3000) : null;
        return () => {
            controller.abort();
            if (timer) clearInterval(timer);
        };
    }, [projectId, entry.jobId, entry.status, retryKey]);

    return (
        <div className="mt-3 space-y-3 rounded-lg border border-line bg-surface-soft p-3.5">
            {error && (
                <Alert variant="danger" role="alert" className="flex flex-wrap items-center justify-between gap-3">
                    <AlertDescription>{error}</AlertDescription>
                    <Button type="button" variant="outline" size="sm" onClick={() => setRetryKey((key) => key + 1)}><RefreshCw size={13} /> Try again</Button>
                </Alert>
            )}
            {!actions && !error ? (
                <div className="space-y-2" aria-busy="true" aria-label="Loading activity details" role="status"><Skeleton className="h-4 w-48" /><Skeleton className="h-4 w-3/4" /></div>
            ) : actions?.length === 0 ? (
                <p className="text-body text-ink-muted">No actions recorded yet.</p>
            ) : actions ? (
                <ol aria-label="Agent actions" className="max-h-96 space-y-4 overflow-auto">
                    {actions.map((action) => (
                        <li key={action.id}>
                            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                                <span className="text-body font-medium text-ink">{action.action.replaceAll("_", " ")}</span>
                                <RelativeTime value={action.createdAt} className="text-meta text-ink-subtle" />
                            </div>
                            {action.detail && <pre className="mt-1 whitespace-pre-wrap break-words text-meta text-ink-muted">{action.detail}</pre>}
                        </li>
                    ))}
                </ol>
            ) : null}
        </div>
    );
}

export default function ActivityPage({ params }: { params: Promise<{ projectId: string }> }) {
    const { projectId } = use(params);
    const [activity, setActivity] = useState<ActivityEntry[] | null>(null);
    const [loadError, setLoadError] = useState("");
    const [openEntryId, setOpenEntryId] = useState<string | null>(null);
    const openedAnchor = useRef("");

    const load = useCallback(async (signal?: AbortSignal) => {
        try {
            const result = await api<{ activity: ActivityEntry[] }>(apiPath`/projects/${projectId}/activity`, { signal });
            setActivity(result.activity);
            setLoadError("");
        } catch (error) {
            if (!isAbortError(error)) setLoadError(errorMessage(error));
        }
    }, [projectId]);

    useEffect(() => {
        const controller = new AbortController();
        void load(controller.signal);
        const timer = setInterval(() => void load(controller.signal), 5000);
        return () => {
            controller.abort();
            clearInterval(timer);
        };
    }, [load]);

    useEffect(() => {
        const anchor = window.location.hash.slice(1);
        if (!anchor || openedAnchor.current === anchor) return;
        const entry = activity?.find((item) => item.kind === "job" && item.jobId === anchor);
        if (!entry) return;
        openedAnchor.current = anchor;
        setOpenEntryId(entry.id);
        document.getElementById(anchor)?.scrollIntoView({ block: "start" });
    }, [activity]);

    return (
        <div className="flex min-h-full flex-col bg-surface">
            <PageHeader
                title="Activity"
                description="What the agent noticed, what it is doing, and why."
                width="data"
                actions={<Button asChild variant="outline"><Link href={`/p/${projectId}/inbox`}><Inbox size={14} /> Open Inbox</Link></Button>}
            />
            <PageContainer width="data" innerClassName="space-y-6">
                {loadError && activity && (
                    <Alert variant="danger" role="alert" className="flex flex-wrap items-center justify-between gap-3">
                        <AlertDescription>{loadError}</AlertDescription>
                        <Button type="button" variant="outline" size="sm" onClick={() => void load()}><RefreshCw size={13} /> Try again</Button>
                    </Alert>
                )}
                {loadError && !activity ? (
                    <EmptyState role="alert" tone="danger" icon={AlertCircle} title="Activity could not load" description={loadError} action={<Button type="button" onClick={() => void load()}><RefreshCw size={14} /> Try again</Button>} />
                ) : !activity ? (
                    <div className="space-y-2" aria-busy="true" aria-label="Loading activity" role="status">
                        {[0, 1, 2].map((row) => <Skeleton key={row} className="h-28 w-full rounded-lg" />)}
                    </div>
                ) : !activity.length ? (
                    <EmptyState icon={Activity} title="Watching for changes" description="The agent records its work here as it learns about your app. You can steer it from a chat." action={<Button asChild variant="outline"><Link href={`/p/${projectId}/chats/new`}><MessageSquareText size={14} /> Start a chat</Link></Button>} />
                ) : (
                    <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line" aria-label="Project activity">
                        {activity.map((entry) => {
                            const status = ACTIVITY_STATUSES[entry.status] ?? { label: entry.status.replaceAll("_", " "), variant: "neutral" as const, icon: CircleDashed };
                            const Icon = status.icon;
                            const active = status.variant === "running";
                            return (
                                <li id={entry.kind === "job" ? entry.jobId ?? entry.id : entry.id} key={entry.id} className="min-w-0 scroll-mt-4 px-4 py-4">
                                    <div className="flex flex-wrap items-start justify-between gap-3">
                                        <h2 className="min-w-0 max-w-reading flex-1 break-words text-body font-medium text-ink">{entry.title}</h2>
                                        <Badge variant={status.variant}><Icon size={12} aria-hidden="true" className={active ? "animate-spin motion-reduce:animate-none" : undefined} />{status.label}</Badge>
                                    </div>
                                    <RelativeTime value={entry.createdAt} className="mt-1 block text-meta text-ink-subtle" />
                                    {entry.reason && entry.reason !== entry.title && <p className="mt-2 max-w-reading whitespace-pre-wrap break-words text-body text-ink-muted">{entry.reason}</p>}
                                    <Collapsible open={openEntryId === entry.id} onOpenChange={(open) => setOpenEntryId(open ? entry.id : null)}>
                                        {(entry.jobId || entry.specId || entry.status === "blocked" || entry.status === "proposed") && (
                                            <div className="mt-3 flex flex-wrap gap-2">
                                                {entry.jobId && <CollapsibleTrigger asChild><Button variant="outline" size="sm"><ChevronDown size={13} className={openEntryId === entry.id ? "rotate-180" : undefined} /> {openEntryId === entry.id ? "Hide details" : "View details"}</Button></CollapsibleTrigger>}
                                                {entry.specId && <Button asChild variant="ghost" size="sm"><Link href={`/p/${projectId}/specs/${entry.specId}${entry.runId ? `#run-${entry.runId}` : ""}`}>View Spec</Link></Button>}
                                                {(entry.status === "blocked" || entry.status === "proposed") && <Button asChild variant="outline" size="sm"><Link href={`/p/${projectId}/inbox`}>{entry.status === "blocked" ? "Answer in Inbox" : "Review in Inbox"}</Link></Button>}
                                            </div>
                                        )}
                                        {entry.jobId && <CollapsibleContent><ActivityDetails projectId={projectId} entry={entry} /></CollapsibleContent>}
                                    </Collapsible>
                                </li>
                            );
                        })}
                    </ul>
                )}
            </PageContainer>
        </div>
    );
}
