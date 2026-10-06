"use client";

import Link from "next/link";
import { use, useEffect, useRef, useState } from "react";
import { AlertCircle, Check, ChevronRight, CircleHelp, Eye, LoaderCircle, ScanSearch, Search, MessageSquareText, Pause, Play, RefreshCw, type LucideIcon } from "lucide-react";
import { useAuth } from "@/components/AuthProvider";
import { DecisionDetails } from "@/components/DecisionDetails";
import { EmptyState } from "@/components/EmptyState";
import { PageContainer, PageHeader } from "@/components/PageHeader";
import { RelativeTime } from "@/components/RelativeTime";
import { SectionHeader } from "@/components/SectionHeader";
import { InlineFeedback, type InlineFeedbackValue } from "@/components/SettingsLayout";
import { StatusDot } from "@/components/StatusDot";
import { StoryDetails } from "@/components/StoryDetails";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { requestTask as requestProjectTask, setStewardPaused } from "@/lib/api";
import { environmentLabel, formatDateTime } from "@/lib/format";
import { useProjectOverview } from "@/lib/projectOverview";
import type { OverviewResponse, RecentRun } from "@/lib/types";

type Selection = { type: "item" | "story" | "failure"; id: string };

const RUN_TRIGGERS: Record<RecentRun["trigger"], string> = { deploy: "Deployments", ci: "CI", schedule: "Scheduled", manual: "Manual", spec_change: "Spec changes" };
const LOAD_ERROR = "The latest project overview could not load. Check your connection and try again.";

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

function RowList({ children }: { children: React.ReactNode }) {
    return <ul className="divide-y divide-line border-y border-line">{children}</ul>;
}

function ShowMore({ label = "Show more", onClick }: { label?: string; onClick: () => void }) {
    return <Button variant="ghost" size="sm" className="mt-2" onClick={onClick}>{label}</Button>;
}

function BusyButton({ busy, icon: Icon, variant = "outline", disabled, onClick, children }: { busy: boolean; icon: LucideIcon; variant?: "outline" | "ghost"; disabled: boolean; onClick: () => void; children: React.ReactNode }) {
    return <Button variant={variant} size="sm" disabled={disabled} onClick={onClick}>
        {busy ? <LoaderCircle size={14} className="animate-spin motion-reduce:animate-none" /> : <Icon size={14} />}
        {children}
    </Button>;
}

function RunOutcome({ run }: { run: RecentRun }) {
    if (run.counts.running > 0) return <LoaderCircle size={15} className="animate-spin text-running motion-reduce:animate-none" />;
    if (run.outcome === "failed" || run.counts.failed > 0) return <AlertCircle size={15} className="text-danger" />;
    if (run.outcome === "flaky" || run.counts.flaky > 0) return <RefreshCw size={15} className="text-warning" />;
    if (run.outcome === "passed") return <Check size={15} className="text-success" />;
    return <Check size={15} className="text-ink-subtle" />;
}

function runCounts(run: RecentRun) {
    // A single Spec's outcome is already the row icon; counts only add information for batches.
    if (run.counts.passed + run.counts.failed + run.counts.flaky + run.counts.running <= 1) return "";
    return `${run.counts.passed} passed · ${run.counts.failed} failed${run.counts.flaky ? ` · ${run.counts.flaky} flaky` : ""}${run.counts.running ? ` · ${run.counts.running} running` : ""}`;
}

function healthStatus(health: OverviewResponse["summary"]["specHealth"]) {
    if (health.failing > 0) return "failing";
    if (health.running > 0) return "running";
    if (health.invalid > 0) return "invalid";
    if (health.repairing > 0) return "repairing";
    if (health.flaky > 0) return "flaky";
    if (health.passing > 0) return "passing";
    return "not_checked";
}

function ProjectHealth({ summary }: { summary: OverviewResponse["summary"] }) {
    return <section aria-label="Project health" className="border-b border-line pb-5">
        <div className="flex items-start gap-2.5">
            <StatusDot status={healthStatus(summary.specHealth)} className="mt-1" />
            <div className="min-w-0">
                <p className="text-body font-medium text-ink">{summary.verdict}</p>
                <p className="mt-1 text-meta text-ink-subtle">
                    {summary.lastCheckedAt ? <><RelativeTime value={summary.lastCheckedAt} prefix="Last checked" /> · </> : null}
                    {summary.nextCheck}
                    {summary.nextCheck && summary.nextCheckAt ? " · " : null}
                    {summary.nextCheckAt && <>Next scheduled run <time dateTime={summary.nextCheckAt}>{formatDateTime(summary.nextCheckAt)}</time></>}
                </p>
            </div>
        </div>
        {summary.systemHealth && <Alert variant="warning" role="status" className="mt-4">
            <AlertDescription>{summary.systemHealth.message}</AlertDescription>
        </Alert>}
    </section>;
}

function NeedsYou({ items, onOpen }: { items: OverviewResponse["needsYou"]; onOpen: (selection: Selection) => void }) {
    const [limit, setLimit] = useState(5);
    return <OverviewSection id="needs-you" title="Needs you" count={items.length}>
        <RowList>{items.slice(0, limit).map((item) => <OverviewRow key={item.id} icon={<CircleHelp size={16} className="text-warning-icon" />} title={item.presentation.title} time={item.createdAt} action="Review" onClick={() => onOpen({ type: "item", id: item.id })} />)}</RowList>
        {items.length > limit && <ShowMore onClick={() => setLimit((count) => count + 5)} />}
    </OverviewSection>;
}

function SelectedSpecs({ items, onOpen }: { items: OverviewResponse["items"]; onOpen: (selection: Selection) => void }) {
    return <OverviewSection id="selected-specs" title="Selected Specs">
        <RowList>{items.slice(0, 5).map((item) => <OverviewRow key={item.id} icon={<LoaderCircle size={16} className="text-ink-subtle" />} title={item.presentation.title} annotation={item.presentation.summary} time={item.createdAt} action="View results" onClick={() => onOpen({ type: "item", id: item.id })} />)}</RowList>
    </OverviewSection>;
}

function Failing({ failing, onOpen }: { failing: OverviewResponse["failing"]; onOpen: (selection: Selection) => void }) {
    const [limit, setLimit] = useState(5);
    return <OverviewSection id="failing" title="Failing" count={failing.length}>
        <RowList>{failing.slice(0, limit).map((failure) => <OverviewRow key={failure.specId} icon={<AlertCircle size={16} className="text-danger" />} title={failure.title} annotation={failure.triageStatus} time={failure.updatedAt} onClick={() => onOpen({ type: "failure", id: failure.specId })} />)}</RowList>
        {failing.length > limit && <ShowMore onClick={() => setLimit((count) => count + 5)} />}
    </OverviewSection>;
}

function RecentRuns({ runs, onOpen }: { runs: RecentRun[]; onOpen: (selection: Selection) => void }) {
    const [limit, setLimit] = useState(10);
    const groups = new Map<RecentRun["trigger"], RecentRun[]>();
    for (const run of runs.slice(0, limit)) groups.set(run.trigger, [...(groups.get(run.trigger) ?? []), run]);
    return <OverviewSection id="recent-runs" title="Recent runs">
        {[...groups].map(([trigger, group]) => <div key={trigger} className="mt-4 first:mt-0">
            <h3 className="mb-1 text-meta font-medium text-ink-subtle">{RUN_TRIGGERS[trigger]}</h3>
            <RowList>{group.map((run) => <OverviewRow key={run.id} icon={<RunOutcome run={run} />} title={run.subject.name} annotation={[environmentLabel(run.environment?.name), runCounts(run)].filter(Boolean).join(" · ")} detail={`${run.occurrences > 1 ? `${run.occurrences} runs · Last ` : ""}${formatDateTime(run.updatedAt, { seconds: true })}`} onClick={() => onOpen({ type: "story", id: run.id })} />)}</RowList>
        </div>)}
        {runs.length > limit && <ShowMore label="Show more runs" onClick={() => setLimit((count) => count + 10)} />}
    </OverviewSection>;
}

export default function OverviewPage({ params }: { params: Promise<{ projectId: string }> }) {
    const { canEdit, isAdmin } = useAuth();
    const { projectId } = use(params);
    const { data, failed, reload } = useProjectOverview();
    const [selected, setSelected] = useState<Selection | null>(null);
    const [requestingTask, setRequestingTask] = useState<"coverage" | "explore" | null>(null);
    const [savingPause, setSavingPause] = useState(false);
    const [feedback, setFeedback] = useState<InlineFeedbackValue | null>(null);
    const openedAnchor = useRef("");
    const returnFocus = useRef<HTMLElement | null>(null);

    const stories = data ? [...data.stories, ...data.recentRuns] : [];
    const item = selected?.type === "item" ? data?.items.find((item) => item.id === selected.id) : undefined;
    const story = selected?.type === "story" ? stories.find((story) => story.id === selected.id) : undefined;
    const failure = selected?.type === "failure" ? data?.failing.find((entry) => entry.specId === selected.id) : undefined;
    const failureStory = failure?.storyId ? data?.stories.find((story) => story.id === failure.storyId) : undefined;

    useEffect(() => {
        function fromHash() {
            let anchor: string;
            try { anchor = decodeURIComponent(window.location.hash.slice(1)); } catch { return; }
            if (!anchor || anchor === openedAnchor.current || !data) return;
            const item = data.items.find((item) => item.id === anchor);
            const story = stories.find((story) => story.id === anchor || story.jobIds.includes(anchor) || story.timeline.some((event) => event.id === anchor));
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
            await setStewardPaused(projectId, paused);
            await reload();
            setFeedback({ type: "success", text: paused ? "Specbook is paused for this project. Current work will stop safely." : "Specbook has resumed this project." });
        } catch {
            setFeedback({ type: "error", text: "The pause setting could not be saved. Try again in a moment." });
        } finally { setSavingPause(false); }
    }

    async function requestTask(kind: "coverage" | "explore") {
        setRequestingTask(kind);
        setFeedback(null);
        try {
            const result = await requestProjectTask(projectId, kind);
            setFeedback({ type: "success", text: result.status === "paused" ? "Requested. Resume Specbook to start." : kind === "coverage" ? "Coverage review requested. Suggestions will appear in Needs you." : "Exploration requested. Findings will appear in Needs you." });
            await reload();
        } catch {
            setFeedback({ type: "error", text: "The request could not start. Try again in a moment." });
        } finally { setRequestingTask(null); }
    }

    const selectedSpecs = data?.items.filter((item) => item.kind === "spec_batch" && item.status === "approved") ?? [];
    const hasActivity = data && (data.needsYou.length || data.failing.length || data.recentRuns.length);
    const emptyProject = data && !hasActivity && data.summary.specHealth.total === 0;
    const panelTitle = item?.presentation.title ?? story?.title ?? failure?.title ?? "Details";
    const panelTime = item?.createdAt ?? story?.updatedAt ?? failure?.updatedAt;
    const tryAgain = () => void reload();

    return <div className="flex min-h-full flex-col bg-surface">
        <PageHeader title="Overview" width="data"
            description={data?.summary.globallyPaused ? "Specbook is paused across all projects." : data?.summary.paused ? "Specbook is paused for this project." : undefined}
            actions={data && canEdit && <>
                <BusyButton busy={requestingTask === "explore"} icon={ScanSearch} disabled={requestingTask !== null} onClick={() => void requestTask("explore")}>Explore app</BusyButton>
                {data.summary.globallyPaused
                    ? isAdmin && <Button asChild variant="ghost" size="sm"><Link href="/settings?tab=security#agent-pause-heading"><Play size={14} /> Resume in settings</Link></Button>
                    : <BusyButton busy={savingPause} icon={data.summary.paused ? Play : Pause} variant="ghost" disabled={savingPause} onClick={() => void togglePause()}>{savingPause ? "Saving…" : data.summary.paused ? "Resume" : "Pause"}</BusyButton>}
            </>} />
        <PageContainer width="data" innerClassName="space-y-7">
            {failed && data && <Alert variant="danger" role="alert" className="flex flex-wrap items-center justify-between gap-3"><AlertDescription>{LOAD_ERROR}</AlertDescription><Button variant="outline" size="sm" onClick={tryAgain}><RefreshCw size={13} /> Try again</Button></Alert>}
            {failed && !data ? <EmptyState role="alert" tone="danger" icon={AlertCircle} title="Overview could not load" description={LOAD_ERROR} action={<Button onClick={tryAgain}><RefreshCw size={14} /> Try again</Button>} /> : !data ? <div className="space-y-6" role="status" aria-busy="true" aria-label="Loading Overview"><Skeleton className="h-14 w-full" />{[0, 1, 2].map((row) => <Skeleton key={row} className="h-11 w-full" />)}</div> : <>
                {!emptyProject && <ProjectHealth summary={data.summary} />}
                {feedback && <InlineFeedback feedback={feedback} />}
                {data.needsYou.length > 0 && <NeedsYou items={data.needsYou} onOpen={open} />}
                {selectedSpecs.length > 0 && <SelectedSpecs items={selectedSpecs} onOpen={open} />}
                {data.failing.length > 0 && <Failing failing={data.failing} onOpen={open} />}
                {data.recentRuns.length > 0 && <RecentRuns runs={data.recentRuns} onOpen={open} />}
                {emptyProject && <EmptyState icon={Eye} title="Your project starts here" description="Describe a behavior in a chat. Spec results and anything that needs you will appear here." action={canEdit && <Button asChild variant="outline"><Link href={`/p/${projectId}/chats/new`}><MessageSquareText size={14} /> Tell Specbook about your app</Link></Button>} />}
            </>}
        </PageContainer>
        <Sheet open={Boolean(selected)} onOpenChange={(value) => { if (!value) close(); }}>
            <SheetContent side="right" className="w-full bg-surface sm:max-w-reading" onCloseAutoFocus={(event) => { event.preventDefault(); const target = returnFocus.current?.isConnected ? returnFocus.current : document.getElementById("main-content"); target?.focus(); }}>
                <SheetHeader className="shrink-0 border-b border-line px-5 py-5 pr-14">
                    <SheetTitle className="break-words text-section">{panelTitle}</SheetTitle>
                    <SheetDescription asChild><p className="text-meta">{panelTime ? <RelativeTime value={panelTime} /> : "Details for this Spec."}</p></SheetDescription>
                </SheetHeader>
                <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-5 py-5">
                    {item && <DecisionDetails key={item.id} projectId={projectId} item={item} story={data?.stories.find((story) => story.id === item.presentation.activityId)} onChange={reload} />}
                    {story && <StoryDetails story={story} projectId={projectId} onDecision={(id) => open({ type: "item", id })} />}
                    {failure && <>
                        <p className="text-body text-ink">{failure.triageStatus}</p>
                        {failure.inboxIds.flatMap((id) => data?.items.find((item) => item.id === id) ?? []).map((item) => <Button key={item.id} variant="outline" className="h-auto max-w-full whitespace-normal text-left" onClick={() => open({ type: "item", id: item.id })}>{item.presentation.type === "bug" ? "View the bug report" : "Review the suggestion"}<ChevronRight size={14} /></Button>)}
                        {failureStory
                            ? <StoryDetails story={failureStory} showDecisions={false} projectId={projectId} onDecision={(id) => open({ type: "item", id })} />
                            : <Button asChild variant="outline"><Link href={`/p/${projectId}/specs/${failure.specId}${failure.runId ? `#run-${failure.runId}` : ""}`}>View the Spec and evidence</Link></Button>}
                    </>}
                </div>
            </SheetContent>
        </Sheet>
    </div>;
}
