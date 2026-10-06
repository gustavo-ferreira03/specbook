"use client";

import Link from "next/link";
import { use, useCallback, useEffect, useRef, useState } from "react";
import { Activity, AlertCircle, Check, Clock3, Eye, Inbox, LoaderCircle, MessageSquareText, Pause, RefreshCw, X } from "lucide-react";
import { AgentStatusSummary } from "@/components/AgentStatusSummary";
import { EmptyState } from "@/components/EmptyState";
import { PageContainer, PageHeader } from "@/components/PageHeader";
import { RelativeTime } from "@/components/RelativeTime";
import { TechnicalDetails } from "@/components/TechnicalDetails";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge, type BadgeVariant } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { api, apiPath, isAbortError } from "@/lib/api";
import type { ActivityStory, AgentSummary } from "@/lib/types";

interface ActivityResponse {
    activity: ActivityStory[];
    summary: AgentSummary;
}

const STORY_STATUSES: Record<ActivityStory["status"], { label: string; variant: BadgeVariant; icon: typeof Check }> = {
    working: { label: "Investigating", variant: "running", icon: LoaderCircle },
    queued: { label: "Up next", variant: "neutral", icon: Clock3 },
    waiting: { label: "Waiting for access", variant: "warning", icon: Clock3 },
    needs_attention: { label: "Your decision", variant: "warning", icon: MessageSquareText },
    paused: { label: "Paused for today", variant: "neutral", icon: Pause },
    completed: { label: "Done", variant: "success", icon: Check },
    observing: { label: "Watching", variant: "neutral", icon: Eye },
    stopped: { label: "Stopped", variant: "neutral", icon: X },
};

export default function ActivityPage({ params }: { params: Promise<{ projectId: string }> }) {
    const { projectId } = use(params);
    const [data, setData] = useState<ActivityResponse | null>(null);
    const [loadError, setLoadError] = useState("");
    const [visibleCount, setVisibleCount] = useState(5);
    const openedAnchor = useRef("");

    const load = useCallback(async (signal?: AbortSignal) => {
        try {
            setData(await api<ActivityResponse>(apiPath`/projects/${projectId}/activity`, { signal }));
            setLoadError("");
        } catch (error) {
            if (!isAbortError(error)) setLoadError("The latest activity could not load. Check your connection and try again.");
        }
    }, [projectId]);

    useEffect(() => {
        const controller = new AbortController();
        void load(controller.signal);
        const timer = setInterval(() => void load(controller.signal), 5000);
        return () => { controller.abort(); clearInterval(timer); };
    }, [load]);

    useEffect(() => {
        const anchor = window.location.hash.slice(1);
        if (!anchor || openedAnchor.current === anchor || !data) return;
        const index = data.activity.findIndex((story) => story.id === anchor || story.jobIds.includes(anchor));
        if (index < 0) return;
        if (index >= visibleCount) { setVisibleCount(index + 1); return; }
        openedAnchor.current = anchor;
        document.getElementById(data.activity[index].id)?.scrollIntoView({ block: "start" });
    }, [data, visibleCount]);

    return (
        <div className="flex min-h-full flex-col bg-surface">
            <PageHeader title="Activity" description="Follow what changed in your app and what happens next." width="data" actions={<Button asChild variant="outline"><Link href={`/p/${projectId}/inbox`}><Inbox size={14} /> Open Inbox</Link></Button>} />
            <PageContainer width="data" innerClassName="space-y-6">
                {data && <AgentStatusSummary projectId={projectId} summary={data.summary} onContinue={load} />}
                {loadError && data && <Alert variant="danger" role="alert" className="flex flex-wrap items-center justify-between gap-3"><AlertDescription>{loadError}</AlertDescription><Button type="button" variant="outline" size="sm" onClick={() => void load()}><RefreshCw size={13} /> Try again</Button></Alert>}
                {loadError && !data ? (
                    <EmptyState role="alert" tone="danger" icon={AlertCircle} title="Activity could not load" description={loadError} action={<Button type="button" onClick={() => void load()}><RefreshCw size={14} /> Try again</Button>} />
                ) : !data ? (
                    <div className="space-y-3" aria-busy="true" aria-label="Loading activity" role="status"><Skeleton className="mb-6 h-12 w-full" />{[0, 1, 2].map((row) => <Skeleton key={row} className="h-44 w-full rounded-lg" />)}</div>
                ) : !data.activity.length ? (
                    <EmptyState icon={Activity} title="Watching for the first change" description="As Specbook checks your app, each story will show what it noticed, what it tried, and what happens next." action={<Button asChild variant="outline"><Link href={`/p/${projectId}/chats/new`}><MessageSquareText size={14} /> Tell Specbook what matters</Link></Button>} />
                ) : (
                    <>
                        <ul className="space-y-4" aria-label="Project activity">
                            {data.activity.slice(0, visibleCount).map((story) => {
                                const status = STORY_STATUSES[story.status];
                                const Icon = status.icon;
                                const timeline = story.timeline.length > 4 ? [story.timeline[0], ...story.timeline.slice(-3)] : story.timeline;
                                return (
                                    <li id={story.id} key={story.id} className="min-w-0 scroll-mt-4 space-y-4 rounded-xl border border-line px-4 py-5 sm:px-5">
                                        <div>
                                            <div className="flex flex-col items-start gap-2 sm:flex-row sm:justify-between sm:gap-3"><h2 className="min-w-0 max-w-reading flex-1 break-words text-section text-ink">{story.title}</h2><Badge variant={status.variant}><Icon size={12} aria-hidden="true" className={story.status === "working" ? "animate-spin motion-reduce:animate-none" : undefined} />{status.label}</Badge></div>
                                            <RelativeTime value={story.updatedAt} className="mt-1 block text-meta text-ink-subtle" />
                                            {story.summary && <p className="mt-3 max-w-reading text-body text-ink-muted">{story.summary}</p>}
                                        </div>
                                        {timeline.length > 0 && <ol className="max-w-reading space-y-3 border-l border-line pl-4" aria-label="What happened">{timeline.map((event) => <li key={event.id}><div className="flex flex-wrap items-baseline gap-x-3 gap-y-1"><p className="text-body font-medium text-ink">{event.label}</p><RelativeTime value={event.createdAt} className="text-meta text-ink-subtle" /></div>{event.detail && <p className="mt-0.5 text-body text-ink-muted">{event.detail}</p>}</li>)}</ol>}
                                        <div className="border-t border-line pt-3">
                                            <p className="max-w-reading text-body text-ink"><span className="font-medium">Next: </span>{story.nextStep}</p>
                                            {(story.inboxIds.length > 0 || story.specId) && <div className="mt-3 flex flex-wrap gap-2">{story.inboxIds.length > 0 && <Button asChild variant="outline" size="sm"><Link href={`/p/${projectId}/inbox#${story.inboxIds[0]}`}><Inbox size={13} /> Open the decision</Link></Button>}{story.specId && <Button asChild variant="ghost" size="sm"><Link href={`/p/${projectId}/specs/${story.specId}${story.runId ? `#run-${story.runId}` : ""}`}>View the check</Link></Button>}</div>}
                                        </div>
                                        {story.technicalDetails && <TechnicalDetails><pre tabIndex={0} aria-label="Technical activity details" className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-code-canvas p-3 font-mono text-meta text-ink-muted">{story.technicalDetails}</pre></TechnicalDetails>}
                                    </li>
                                );
                            })}
                        </ul>
                        {data.activity.length > visibleCount && <div className="flex justify-center"><Button type="button" variant="outline" onClick={() => setVisibleCount((count) => count + 5)}>Show more activity <span className="text-meta text-ink-subtle">{data.activity.length - visibleCount} more</span></Button></div>}
                    </>
                )}
            </PageContainer>
        </div>
    );
}
