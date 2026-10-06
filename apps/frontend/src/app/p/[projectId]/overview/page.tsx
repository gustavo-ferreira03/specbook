"use client";

import Link from "next/link";
import { use, useCallback, useEffect, useRef, useState } from "react";
import { AlertCircle, Check, ChevronRight, CircleHelp, Eye, LoaderCircle, ScanSearch, Search, MessageSquareText, Pause, Play, RefreshCw } from "lucide-react";
import { DecisionDetails } from "@/components/DecisionDetails";
import { EmptyState } from "@/components/EmptyState";
import { PageContainer, PageHeader } from "@/components/PageHeader";
import { RelativeTime } from "@/components/RelativeTime";
import { SectionHeader } from "@/components/SectionHeader";
import { InlineFeedback } from "@/components/SettingsLayout";
import { StatusDot } from "@/components/StatusDot";
import { StoryDetails } from "@/components/StoryDetails";
import { TechnicalDetails } from "@/components/TechnicalDetails";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { api, apiPath, isAbortError } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import type { OverviewResponse, RecentRun } from "@/lib/types";

type Selection = { type: "item" | "story" | "failure"; id: string };

const RUN_TRIGGERS: Record<RecentRun["trigger"], string> = { deploy: "Deployments", ci: "CI", schedule: "Scheduled", manual: "Manual", spec_change: "Spec changes" };

function OverviewRow({ icon, title, time, action = "Details", onClick, annotation, detail }: { icon: React.ReactNode; title: string; time?: string; action?: string; onClick: () => void; annotation?: string; detail?: string }) {
    return <li className="min-w-0">
        <Button type="button" variant="ghost" onClick={onClick} className="h-auto w-full justify-start gap-3 rounded-none px-2 py-3 text-left text-body font-normal">
            <span className="flex shrink-0 items-center" aria-hidden="true">{icon}</span>
            <span className="min-w-0 flex-1"><span className={annotation ? "block truncate" : "block whitespace-normal break-words sm:truncate"} title={title}>{title}</span>{detail && <span className="mt-0.5 block whitespace-normal text-meta text-ink-subtle">{detail}</span>}</span>
            {annotation && <span className="max-w-[45%] shrink-0 truncate text-meta text-ink-muted" title={annotation}>{annotation}</span>}
            {time && <RelativeTime value={time} className="hidden shrink-0 text-meta text-ink-subtle sm:block" />}
            <span className="flex shrink-0 items-center gap-1 text-meta font-medium text-ink-muted"><span className={annotation ? "hidden sm:inline" : undefined}>{action}</span><ChevronRight size={13} /></span>
        </Button>
    </li>;
}

function OverviewSection({ id, title, count, children }: { id: string; title: string; count?: number; children: React.ReactNode }) {
    return <section aria-labelledby={id}><SectionHeader id={id} title={title} count={count} className="mb-2" />{children}</section>;
}

function RunOutcome({ run }: { run: RecentRun }) {
    if (run.counts.running > 0) return <LoaderCircle size={15} className="animate-spin text-running motion-reduce:animate-none" />;
    if (run.outcome === "failed" || run.counts.failed > 0) return <AlertCircle size={15} className="text-danger" />;
    if (run.outcome === "flaky" || run.counts.flaky > 0) return <RefreshCw size={15} className="text-warning" />;
    if (run.outcome === "passed") return <Check size={15} className="text-success" />;
    return <Check size={15} className="text-ink-subtle" />;
}

function runCounts(run: RecentRun) {
    return `${run.counts.passed} passed · ${run.counts.failed} failed${run.counts.flaky ? ` · ${run.counts.flaky} flaky` : ""}${run.counts.running ? ` · ${run.counts.running} running` : ""}`;
}

export default function OverviewPage({ params }: { params: Promise<{ projectId: string }> }) {
    const { projectId } = use(params);
    const [data, setData] = useState<OverviewResponse | null>(null);
    const [loadError, setLoadError] = useState("");
    const [selected, setSelected] = useState<Selection | null>(null);
    const [decisionLimit, setDecisionLimit] = useState(5);
    const [failingLimit, setFailingLimit] = useState(5);
    const [runsLimit, setRunsLimit] = useState(10);
    const [requestingTask, setRequestingTask] = useState<"coverage" | "explore" | null>(null);
    const [savingPause, setSavingPause] = useState(false);
    const [feedback, setFeedback] = useState<{ type: "success" | "error"; text: string } | null>(null);
    const openedAnchor = useRef("");
    const returnFocus = useRef<HTMLElement | null>(null);

    const load = useCallback(async (signal?: AbortSignal) => {
        try {
            setData(await api<OverviewResponse>(apiPath`/projects/${projectId}/overview`, { signal }));
            setLoadError("");
        } catch (error) {
            if (!isAbortError(error)) setLoadError("The latest project overview could not load. Check your connection and try again.");
        }
    }, [projectId]);

    useEffect(() => {
        const controller = new AbortController();
        void load(controller.signal);
        const timer = setInterval(() => void load(controller.signal), 5000);
        return () => { controller.abort(); clearInterval(timer); };
    }, [load]);

    const stories = data ? [...data.stories, ...data.recentRuns] : [];
    const item = selected?.type === "item" ? data?.items.find((item) => item.id === selected.id) : undefined;
    const story = selected?.type === "story" ? stories.find((story) => story.id === selected.id) : undefined;
    const failure = selected?.type === "failure" ? data?.failing.find((entry) => entry.specId === selected.id) : undefined;

    useEffect(() => {
        function fromHash() {
            let anchor: string;
            try { anchor = decodeURIComponent(window.location.hash.slice(1)); } catch { return; }
            if (!anchor || anchor === openedAnchor.current || !data) return;
            const item = data.items.find((item) => item.id === anchor);
            const story = [...data.stories, ...data.recentRuns].find((story) => story.id === anchor || story.jobIds.includes(anchor) || story.timeline.some((event) => event.id === anchor));
            if (item) setSelected({ type: "item", id: item.id });
            else if (story) setSelected({ type: "story", id: story.id });
            else if (data.failing.some((entry) => entry.specId === anchor)) setSelected({ type: "failure", id: anchor });
            else return;
            openedAnchor.current = anchor;
        }
        fromHash();
        window.addEventListener("hashchange", fromHash);
        return () => window.removeEventListener("hashchange", fromHash);
    }, [data]);

    function open(selection: Selection) {
        if (!selected) returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        const anchor = selection.id;
        openedAnchor.current = anchor;
        window.history.replaceState(window.history.state, "", `#${encodeURIComponent(anchor)}`);
        setSelected(selection);
    }

    function close() {
        setSelected(null);
        openedAnchor.current = "";
        window.history.replaceState(window.history.state, "", `${window.location.pathname}${window.location.search}`);
    }

    async function togglePause() {
        if (!data) return;
        const paused = !data.summary.paused;
        setSavingPause(true);
        setFeedback(null);
        try {
            await api(apiPath`/projects/${projectId}/steward`, { method: "PUT", body: JSON.stringify({ paused }) });
            await load();
            setFeedback({ type: "success", text: paused ? "Specbook is paused for this project. Current work will stop safely." : "Specbook has resumed this project." });
        } catch {
            setFeedback({ type: "error", text: "The pause setting could not be saved. Try again in a moment." });
        } finally { setSavingPause(false); }
    }

    async function requestTask(kind: "coverage" | "explore") {
        setRequestingTask(kind);
        setFeedback(null);
        try {
            const result = await api<{ intentId: string; status: "queued" | "running" | "paused" }>(apiPath`/projects/${projectId}/tasks`, { method: "POST", body: JSON.stringify({ kind }) });
            setFeedback({ type: "success", text: result.status === "paused" ? "Requested. Resume Specbook to start." : kind === "coverage" ? "Coverage review requested. Suggestions will appear in Needs you." : "Exploration requested. Findings will appear in Needs you." });
            await load();
        } catch {
            setFeedback({ type: "error", text: "The request could not start. Try again in a moment." });
        } finally { setRequestingTask(null); }
    }

    const runGroups = new Map<RecentRun["trigger"], RecentRun[]>();
    for (const run of data?.recentRuns.slice(0, runsLimit) ?? []) runGroups.set(run.trigger, [...(runGroups.get(run.trigger) ?? []), run]);
    const hasActivity = data && (data.needsYou.length || data.failing.length || data.recentRuns.length);
    const emptyProject = data && !hasActivity && data.summary.specHealth.total === 0;
    const panelTitle = item?.presentation.title ?? story?.title ?? failure?.title ?? "Details";

    return <div className="flex min-h-full flex-col bg-surface">
        <PageHeader title={data ? `Overview — ${data.summary.projectName}` : "Overview"} width="data"
            description={data?.summary.globallyPaused ? "Specbook is paused across all projects." : data?.summary.paused ? "Specbook is paused for this project." : undefined}
            actions={data && <>
                <Button variant="outline" size="sm" disabled={requestingTask !== null} onClick={() => void requestTask("coverage")}>{requestingTask === "coverage" ? <LoaderCircle size={14} className="animate-spin motion-reduce:animate-none" /> : <Search size={14} />} Find uncovered areas</Button>
                <Button variant="outline" size="sm" disabled={requestingTask !== null} onClick={() => void requestTask("explore")}>{requestingTask === "explore" ? <LoaderCircle size={14} className="animate-spin motion-reduce:animate-none" /> : <ScanSearch size={14} />} Explore app</Button>
                {data.summary.globallyPaused ? <Button asChild variant="ghost" size="sm"><Link href={`/p/${projectId}/settings?tab=automation#agent-pause-heading`}><Play size={14} /> Resume in settings</Link></Button> : <Button variant="ghost" size="sm" disabled={savingPause} onClick={() => void togglePause()}>{savingPause ? <LoaderCircle size={14} className="animate-spin motion-reduce:animate-none" /> : data.summary.paused ? <Play size={14} /> : <Pause size={14} />}{savingPause ? "Saving…" : data.summary.paused ? "Resume" : "Pause"}</Button>}
            </>} />
        <PageContainer width="data" innerClassName="space-y-7">
            {loadError && data && <Alert variant="danger" role="alert" className="flex flex-wrap items-center justify-between gap-3"><AlertDescription>{loadError}</AlertDescription><Button variant="outline" size="sm" onClick={() => void load()}><RefreshCw size={13} /> Try again</Button></Alert>}
            {loadError && !data ? <EmptyState role="alert" tone="danger" icon={AlertCircle} title="Overview could not load" description={loadError} action={<Button onClick={() => void load()}><RefreshCw size={14} /> Try again</Button>} /> : !data ? <div className="space-y-6" role="status" aria-busy="true" aria-label="Loading Overview"><Skeleton className="h-14 w-full" />{[0, 1, 2].map((row) => <Skeleton key={row} className="h-11 w-full" />)}</div> : <>
                {!emptyProject && <section aria-label="Project health" className="border-b border-line pb-5">
                    <div className="flex items-start gap-2.5"><StatusDot status={data.summary.specHealth.failing > 0 ? "failing" : data.summary.specHealth.running > 0 ? "running" : data.summary.specHealth.invalid > 0 ? "invalid" : data.summary.specHealth.flaky > 0 ? "flaky" : data.summary.specHealth.passing > 0 ? "passing" : "not_checked"} className="mt-1" /><div className="min-w-0"><p className="text-body font-medium text-ink">{data.summary.verdict}</p><p className="mt-1 text-meta text-ink-subtle">{data.summary.lastCheckedAt ? <><RelativeTime value={data.summary.lastCheckedAt} prefix="Last checked" /> · </> : null}{data.summary.nextCheckAt ? <>{data.summary.nextCheck !== "Next scheduled check" && <>{data.summary.nextCheck} · </>}Next scheduled check <time dateTime={data.summary.nextCheckAt}>{formatDateTime(data.summary.nextCheckAt)}</time></> : data.summary.nextCheck}</p></div></div>
                    {data.summary.systemHealth && <Alert variant="warning" role="status" className="mt-4"><AlertDescription>{data.summary.systemHealth.message}</AlertDescription>{data.summary.systemHealth.detail && <TechnicalDetails><p className="text-meta text-ink-muted">{data.summary.systemHealth.detail}</p></TechnicalDetails>}</Alert>}
                </section>}
                {feedback && <InlineFeedback feedback={feedback} />}
                {data.needsYou.length > 0 && <OverviewSection id="needs-you" title="Needs you" count={data.needsYou.length}><ul className="divide-y divide-line border-y border-line">{data.needsYou.slice(0, decisionLimit).map((item) => <OverviewRow key={item.id} icon={<CircleHelp size={16} className="text-warning-icon" />} title={item.presentation.title} time={item.createdAt} action="Review" onClick={() => open({ type: "item", id: item.id })} />)}</ul>{data.needsYou.length > decisionLimit && <Button variant="ghost" size="sm" className="mt-2" onClick={() => setDecisionLimit((count) => count + 5)}>Show more decisions</Button>}</OverviewSection>}
                {data.failing.length > 0 && <OverviewSection id="failing" title="Failing" count={data.failing.length}><ul className="divide-y divide-line border-y border-line">{data.failing.slice(0, failingLimit).map((failure) => <OverviewRow key={failure.specId} icon={<AlertCircle size={16} className="text-danger" />} title={failure.title} annotation={failure.triageStatus} time={failure.updatedAt} onClick={() => open({ type: "failure", id: failure.specId })} />)}</ul>{data.failing.length > failingLimit && <Button variant="ghost" size="sm" className="mt-2" onClick={() => setFailingLimit((count) => count + 5)}>Show more failing checks</Button>}</OverviewSection>}
                {data.recentRuns.length > 0 && <OverviewSection id="recent-runs" title="Recent runs">{[...runGroups].map(([trigger, runs]) => <div key={trigger} className="mt-4 first:mt-0"><h3 className="mb-1 text-meta font-medium text-ink-subtle">{RUN_TRIGGERS[trigger]}</h3><ul className="divide-y divide-line border-y border-line">{runs.map((run) => <OverviewRow key={run.id} icon={<RunOutcome run={run} />} title={run.subject.name} annotation={runCounts(run)} detail={`${run.occurrences > 1 ? `${run.occurrences} runs · Last ` : ""}${formatDateTime(run.updatedAt, { seconds: true })}`} onClick={() => open({ type: "story", id: run.id })} />)}</ul></div>)}{data.recentRuns.length > runsLimit && <Button variant="ghost" size="sm" className="mt-2" onClick={() => setRunsLimit((count) => count + 10)}>Show more runs</Button>}</OverviewSection>}
                {emptyProject && <EmptyState icon={Eye} title="Your project starts here" description="Create a check in chat. Its results and any questions that need your decision will appear here." action={<Button asChild variant="outline"><Link href={`/p/${projectId}/chats/new`}><MessageSquareText size={14} /> Tell Specbook about your app</Link></Button>} />}
            </>}
        </PageContainer>
        <Sheet open={Boolean(selected)} onOpenChange={(value) => { if (!value) close(); }}>
            <SheetContent side="right" className="w-full bg-surface sm:max-w-reading" onCloseAutoFocus={(event) => { event.preventDefault(); const target = returnFocus.current?.isConnected ? returnFocus.current : document.getElementById("main-content"); target?.focus(); }}>
                <SheetHeader className="shrink-0 border-b border-line px-5 py-5 pr-14"><SheetTitle className="break-words text-section">{panelTitle}</SheetTitle><SheetDescription asChild><p className="text-meta">{item ? <RelativeTime value={item.createdAt} /> : story ? <RelativeTime value={story.updatedAt} /> : failure ? <RelativeTime value={failure.updatedAt} /> : "Details for this check."}</p></SheetDescription></SheetHeader>
                <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-5 py-5">
                    {item && <DecisionDetails key={item.id} projectId={projectId} item={item} story={data?.stories.find((story) => story.id === item.presentation.activityId)} onChange={load} />}
                    {story && <StoryDetails story={story} projectId={projectId} onDecision={(id) => open({ type: "item", id })} />}
                    {failure && <>
                        <p className="text-body text-ink">{failure.triageStatus}</p>
                        {failure.inboxIds.map((id) => data?.items.find((item) => item.id === id)).filter((item) => Boolean(item)).map((item) => item && <Button key={item.id} variant="outline" className="h-auto max-w-full whitespace-normal text-left" onClick={() => open({ type: "item", id: item.id })}>{item.presentation.type === "bug" ? "View the bug report" : "Review the suggestion"}<ChevronRight size={14} /></Button>)}
                        {failure.storyId && data?.stories.find((story) => story.id === failure.storyId) ? <StoryDetails story={data.stories.find((story) => story.id === failure.storyId)!} showDecisions={false} projectId={projectId} onDecision={(id) => open({ type: "item", id })} /> : <Button asChild variant="outline"><Link href={`/p/${projectId}/specs/${failure.specId}${failure.runId ? `#run-${failure.runId}` : ""}`}>View the check and evidence</Link></Button>}
                    </>}
                </div>
            </SheetContent>
        </Sheet>
    </div>;
}
