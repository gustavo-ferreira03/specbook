"use client";

import Link from "next/link";
import { use, useCallback, useEffect, useRef, useState } from "react";
import { AlertCircle, Check, ChevronRight, CircleHelp, Clock3, Eye, LoaderCircle, MessageSquareText, Pause, Play, RefreshCw } from "lucide-react";
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
import { formatDate, formatDateTime, formatTime } from "@/lib/format";
import type { ActivityStory, OverviewResponse } from "@/lib/types";

type Selection = { type: "item" | "story"; id: string } | { type: "paused" | "queued" | "working" };

function OverviewRow({ icon, title, time, action = "Details", onClick, clock }: { icon: React.ReactNode; title: string; time?: string; action?: string; onClick: () => void; clock?: boolean }) {
    return <li className="min-w-0">
        <Button type="button" variant="ghost" onClick={onClick} className="h-auto w-full justify-start gap-3 rounded-none px-2 py-3 text-left text-body font-normal">
            <span className="flex shrink-0 items-center" aria-hidden="true">{icon}</span>
            {clock && time && <time dateTime={time} className="hidden shrink-0 text-meta text-ink-subtle tabular sm:block">{formatTime(time)}</time>}
            <span className="min-w-0 flex-1 truncate" title={title}>{title}</span>
            {!clock && time && <RelativeTime value={time} className="hidden shrink-0 text-meta text-ink-subtle sm:block" />}
            <span className="flex shrink-0 items-center gap-1 text-meta font-medium text-ink-muted">{action}<ChevronRight size={13} /></span>
        </Button>
    </li>;
}

function OverviewSection({ id, title, count, children }: { id: string; title: string; count?: number; children: React.ReactNode }) {
    return <section aria-labelledby={id}><SectionHeader id={id} title={title} count={count} className="mb-2" />{children}</section>;
}

function dayLabel(value: string) {
    const date = new Date(value);
    const today = new Date();
    const yesterday = new Date();
    yesterday.setDate(today.getDate() - 1);
    return date.toDateString() === today.toDateString() ? "Today" : date.toDateString() === yesterday.toDateString() ? "Yesterday" : formatDate(date);
}

function HistoryOutcome({ outcome }: { outcome: ActivityStory["outcome"] }) {
    if (outcome === "passed") return <Check size={15} className="text-success" />;
    if (outcome === "failed") return <AlertCircle size={15} className="text-danger" />;
    if (outcome === "flaky") return <RefreshCw size={15} className="text-warning" />;
    if (outcome === "stopped") return <Pause size={15} className="text-ink-subtle" />;
    return <Check size={15} className="text-ink-subtle" />;
}

export default function OverviewPage({ params }: { params: Promise<{ projectId: string }> }) {
    const { projectId } = use(params);
    const [data, setData] = useState<OverviewResponse | null>(null);
    const [loadError, setLoadError] = useState("");
    const [selected, setSelected] = useState<Selection | null>(null);
    const [decisionLimit, setDecisionLimit] = useState(5);
    const [problemLimit, setProblemLimit] = useState(5);
    const [historyLimit, setHistoryLimit] = useState(10);
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

    const stories = data ? [...data.stories, ...data.history] : [];
    const item = selected?.type === "item" ? data?.items.find((item) => item.id === selected.id) : undefined;
    const story = selected?.type === "story" ? stories.find((story) => story.id === selected.id) : undefined;
    const pausedCount = data?.paused.reduce((count, group) => count + group.count, 0) ?? 0;

    useEffect(() => {
        function fromHash() {
            let anchor: string;
            try { anchor = decodeURIComponent(window.location.hash.slice(1)); } catch { return; }
            if (!anchor || anchor === openedAnchor.current || !data) return;
            const item = data.items.find((item) => item.id === anchor);
            const story = [...data.stories, ...data.history].find((story) => story.id === anchor || story.jobIds.includes(anchor));
            if (item) setSelected({ type: "item", id: item.id });
            else if (story) setSelected({ type: "story", id: story.id });
            else if (["paused", "queued", "working"].includes(anchor)) setSelected({ type: anchor as "paused" | "queued" | "working" });
            else return;
            openedAnchor.current = anchor;
        }
        fromHash();
        window.addEventListener("hashchange", fromHash);
        return () => window.removeEventListener("hashchange", fromHash);
    }, [data]);

    function open(selection: Selection) {
        if (!selected) returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        const anchor = "id" in selection ? selection.id : selection.type;
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
            if (selected?.type === "paused" && !paused) close();
        } catch {
            setFeedback({ type: "error", text: "The pause setting could not be saved. Try again in a moment." });
        } finally { setSavingPause(false); }
    }

    const pausedTitle = data?.paused[0]?.label ?? "";
    const historyDays = new Map<string, ActivityStory[]>();
    for (const entry of data?.history.slice(0, historyLimit) ?? []) {
        const day = dayLabel(entry.updatedAt);
        historyDays.set(day, [...(historyDays.get(day) ?? []), entry]);
    }
    const hasActivity = data && (data.needsYou.length || data.working.length || data.queued.length || data.problems.length || data.paused.length || data.history.length);
    const groupStories = selected?.type === "queued" ? data?.queued ?? [] : selected?.type === "working" ? data?.working ?? [] : [];
    const panelTitle = item?.presentation.title ?? story?.title ?? (selected?.type === "paused" ? "Paused checks" : selected?.type === "queued" ? "Queued checks" : selected?.type === "working" ? "Checks in progress" : "Details");

    return <div className="flex min-h-full flex-col bg-surface">
        <PageHeader title={data ? `Overview — ${data.summary.projectName}` : "Overview"} width="data"
            description={data ? data.summary.globallyPaused ? "Specbook is paused across all projects." : data.summary.paused ? "Specbook is paused for this project." : `Specbook is ${data.summary.activeCount > 0 ? "working on" : "watching"} ${data.summary.projectName}.` : undefined}
            actions={data && (data.summary.globallyPaused ? <Button asChild variant="outline"><Link href={`/p/${projectId}/settings?tab=automation#agent-pause-heading`}><Play size={14} /> Resume in settings</Link></Button> : <Button variant="outline" disabled={savingPause} onClick={() => void togglePause()}>{savingPause ? <LoaderCircle size={14} className="animate-spin motion-reduce:animate-none" /> : data.summary.paused ? <Play size={14} /> : <Pause size={14} />}{savingPause ? "Saving…" : data.summary.paused ? "Resume" : "Pause"}</Button>)} />
        <PageContainer width="data" innerClassName="space-y-7">
            {loadError && data && <Alert variant="danger" role="alert" className="flex flex-wrap items-center justify-between gap-3"><AlertDescription>{loadError}</AlertDescription><Button variant="outline" size="sm" onClick={() => void load()}><RefreshCw size={13} /> Try again</Button></Alert>}
            {loadError && !data ? <EmptyState role="alert" tone="danger" icon={AlertCircle} title="Overview could not load" description={loadError} action={<Button onClick={() => void load()}><RefreshCw size={14} /> Try again</Button>} /> : !data ? <div className="space-y-6" role="status" aria-busy="true" aria-label="Loading Overview"><Skeleton className="h-14 w-full" />{[0, 1, 2].map((row) => <Skeleton key={row} className="h-11 w-full" />)}</div> : <>
                <section aria-label="Project health" className="border-b border-line pb-5">
                    <div className="flex items-start gap-2.5"><StatusDot status={data.summary.specHealth.failing > 0 || data.summary.problemCount > 0 ? "failing" : data.summary.specHealth.running > 0 ? "running" : data.summary.specHealth.flaky > 0 ? "flaky" : data.summary.specHealth.paused > 0 ? "paused" : data.summary.specHealth.passing > 0 ? "passing" : "not_checked"} className="mt-1" /><div className="min-w-0"><p className="text-body font-medium text-ink">{data.summary.verdict}</p><p className="mt-1 text-meta text-ink-subtle">{data.summary.lastCheckedAt ? <><RelativeTime value={data.summary.lastCheckedAt} prefix="Last checked" /> · </> : null}{data.summary.nextCheckAt ? <>{data.summary.nextCheck !== "Next scheduled check" && <>{data.summary.nextCheck} · </>}Next scheduled check <time dateTime={data.summary.nextCheckAt}>{formatDateTime(data.summary.nextCheckAt)}</time></> : data.summary.nextCheck}</p></div></div>
                    {data.summary.systemHealth && <Alert variant="warning" role="status" className="mt-4"><AlertDescription>{data.summary.systemHealth.message}</AlertDescription>{data.summary.systemHealth.detail && <TechnicalDetails><p className="text-meta text-ink-muted">{data.summary.systemHealth.detail}</p></TechnicalDetails>}</Alert>}
                </section>
                {feedback && <InlineFeedback feedback={feedback} />}
                {data.needsYou.length > 0 && <OverviewSection id="needs-you" title="Needs you" count={data.needsYou.length}><ul className="divide-y divide-line border-y border-line">{data.needsYou.slice(0, decisionLimit).map((item) => <OverviewRow key={item.id} icon={<CircleHelp size={16} className="text-warning-icon" />} title={item.presentation.title} time={item.createdAt} action="Review" onClick={() => open({ type: "item", id: item.id })} />)}</ul>{data.needsYou.length > decisionLimit && <Button variant="ghost" size="sm" className="mt-2" onClick={() => setDecisionLimit((count) => count + 5)}>Show more decisions</Button>}</OverviewSection>}
                {(data.working.length > 0 || data.queued.length > 0) && <OverviewSection id="working" title="Working on it now"><ul className="divide-y divide-line border-y border-line">{data.working.slice(0, 2).map((story) => <OverviewRow key={story.id} icon={<LoaderCircle size={16} className="animate-spin text-running motion-reduce:animate-none" />} title={story.title} time={story.updatedAt} onClick={() => open({ type: "story", id: story.id })} />)}{data.working.length > 2 && <OverviewRow icon={<LoaderCircle size={16} className="text-running" />} title={`${data.working.length - 2} other checks in progress`} action="Show which" onClick={() => open({ type: "working" })} />}{data.queued.length > 0 && <OverviewRow icon={<Clock3 size={16} className="text-ink-subtle" />} title={`${data.queued.length} ${data.queued.length === 1 ? "check queued" : "checks queued"}`} action="Show which" onClick={() => open({ type: "queued" })} />}</ul></OverviewSection>}
                {data.problems.length > 0 && <OverviewSection id="problems" title="Problems found" count={data.problems.length}><ul className="divide-y divide-line border-y border-line">{data.problems.slice(0, problemLimit).map((item) => <OverviewRow key={item.id} icon={<AlertCircle size={16} className="text-danger" />} title={item.presentation.title} time={item.createdAt} onClick={() => open({ type: "item", id: item.id })} />)}</ul>{data.problems.length > problemLimit && <Button variant="ghost" size="sm" className="mt-2" onClick={() => setProblemLimit((count) => count + 5)}>Show more problems</Button>}</OverviewSection>}
                {data.paused.length > 0 && <OverviewSection id="paused" title="Paused by you" count={pausedCount}><ul className="divide-y divide-line border-y border-line"><OverviewRow icon={<Pause size={16} className="text-ink-subtle" />} title={pausedTitle} action="Show which" onClick={() => open({ type: "paused" })} /></ul></OverviewSection>}
                {data.history.length > 0 && <OverviewSection id="history" title="History">{[...historyDays].map(([day, entries]) => <div key={day} className="mt-4 first:mt-0"><h3 className="mb-1 text-meta font-medium text-ink-subtle">{day}</h3><ul className="divide-y divide-line border-y border-line">{entries.map((story) => <OverviewRow key={story.id} icon={<HistoryOutcome outcome={story.outcome} />} title={story.title} time={story.updatedAt} clock onClick={() => open({ type: "story", id: story.id })} />)}</ul></div>)}{data.history.length > historyLimit && <Button variant="ghost" size="sm" className="mt-2" onClick={() => setHistoryLimit((count) => count + 10)}>Show more history</Button>}</OverviewSection>}
                {!hasActivity && data.summary.specHealth.total === 0 && <EmptyState icon={Eye} title="Your project starts here" description="Checks, problems, and questions that need your decision will appear here as Specbook learns about your app." action={<Button asChild variant="outline"><Link href={`/p/${projectId}/chats/new`}><MessageSquareText size={14} /> Tell Specbook about your app</Link></Button>} />}
            </>}
        </PageContainer>
        <Sheet open={Boolean(selected)} onOpenChange={(value) => { if (!value) close(); }}>
            <SheetContent side="right" className="w-full bg-surface sm:max-w-reading" onCloseAutoFocus={(event) => { event.preventDefault(); const target = returnFocus.current?.isConnected ? returnFocus.current : document.getElementById("main-content"); target?.focus(); }}>
                <SheetHeader className="shrink-0 border-b border-line px-5 py-5 pr-14"><SheetTitle className="break-words text-section">{panelTitle}</SheetTitle><SheetDescription asChild><p className="text-meta">{item ? <RelativeTime value={item.createdAt} /> : story ? <RelativeTime value={story.updatedAt} /> : selected?.type === "paused" ? `${pausedCount} checks are paused.` : selected?.type === "queued" ? "These checks will start after the current work finishes." : "Checks currently in progress."}</p></SheetDescription></SheetHeader>
                <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-5 py-5">
                    {item && <DecisionDetails key={item.id} projectId={projectId} item={item} story={data?.stories.find((story) => story.id === item.presentation.activityId)} onChange={load} />}
                    {story && <StoryDetails story={story} projectId={projectId} onDecision={(id) => open({ type: "item", id })} />}
                    {selected?.type === "paused" && data?.paused.map((group) => <section key={group.reason} className="space-y-3"><h3 className="text-body font-medium text-ink">{group.label}</h3>{data.summary.globallyPaused ? <Button asChild variant="outline" size="sm"><Link href={`/p/${projectId}/settings?tab=automation#agent-pause-heading`}>Resume in settings</Link></Button> : <Button variant="outline" size="sm" disabled={savingPause} onClick={() => void togglePause()}>{savingPause ? "Saving…" : "Resume this project"}</Button>}<ul className="divide-y divide-line border-y border-line">{group.stories.map((story) => <OverviewRow key={story.id} icon={<Pause size={14} className="text-ink-subtle" />} title={story.subject.name} onClick={() => open({ type: "story", id: story.id })} />)}</ul></section>)}
                    {groupStories.length > 0 && <ul className="divide-y divide-line border-y border-line">{groupStories.map((story) => <OverviewRow key={story.id} icon={selected?.type === "queued" ? <Clock3 size={14} className="text-ink-subtle" /> : <LoaderCircle size={14} className="text-running" />} title={story.title} time={story.updatedAt} onClick={() => open({ type: "story", id: story.id })} />)}</ul>}
                </div>
            </SheetContent>
        </Sheet>
    </div>;
}
