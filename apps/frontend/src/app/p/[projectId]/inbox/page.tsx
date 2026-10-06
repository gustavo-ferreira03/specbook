"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { use, useCallback, useEffect, useRef, useState } from "react";
import { Activity, AlertCircle, Check, Inbox, LoaderCircle, MessageSquareText, RefreshCw, X } from "lucide-react";
import { AgentStatusSummary } from "@/components/AgentStatusSummary";
import { EmptyState } from "@/components/EmptyState";
import { FileDiff } from "@/components/FileDiff";
import { PageContainer, PageHeader } from "@/components/PageHeader";
import { RelativeTime } from "@/components/RelativeTime";
import { TechnicalDetails } from "@/components/TechnicalDetails";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { api, apiPath, API_URL, isAbortError } from "@/lib/api";
import type { AgentSummary, PresentedInboxItem } from "@/lib/types";
import { cn } from "@/lib/utils";

interface InboxResponse {
    items: PresentedInboxItem[];
    summary: AgentSummary;
}

type ReviewAction = "approve" | "reject" | "answer" | "dismiss" | "report_bug" | "ignore";
type InboxAction = ReviewAction | "promote" | "discuss";

function Screenshots({ item }: { item: PresentedInboxItem }) {
    const [selected, setSelected] = useState<{ url: string; label: string } | null>(null);
    const [unavailable, setUnavailable] = useState<string[]>([]);
    const shots: [string, { url: string; label: string } | null][] = Object.entries(item.presentation.screenshots).filter((entry): entry is [string, { url: string; label: string }] => Boolean(entry[1]));
    if (item.presentation.type === "update" && item.presentation.screenshots.after && !item.presentation.screenshots.before) shots.unshift(["before", null]);
    if (!shots.length) return null;
    const url = (value: string) => value.startsWith("/") ? `${API_URL}${value}` : value;
    return (
        <>
            <div className={cn("grid gap-4", shots.length > 1 && "sm:grid-cols-2")}>
                {shots.map(([side, shot]) => (
                    <figure key={side} className="min-w-0">
                        <figcaption className="mb-2 text-body font-medium text-ink">{item.presentation.type === "update" ? side === "before" ? "Before" : "After" : side === "before" ? "What happened" : "What Specbook checked"}</figcaption>
                        {!shot ? <p className="rounded-lg border border-line bg-surface-soft p-4 text-body text-ink-muted">No screenshot was captured for the earlier test run.</p> : unavailable.includes(shot.url) ? <p className="rounded-lg border border-line bg-surface-soft p-4 text-body text-ink-muted">This screenshot is unavailable.</p> : <button type="button" className="block w-full overflow-hidden rounded-lg border border-line bg-surface-soft outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label={`Enlarge screenshot: ${shot.label}`} onClick={() => setSelected({ ...shot, url: url(shot.url) })}><img src={url(shot.url)} alt={shot.label} loading="lazy" onError={() => setUnavailable((current) => [...current, shot.url])} className="max-h-64 w-full object-contain" /></button>}
                        {shot && <p className="mt-1.5 text-meta text-ink-subtle">{shot.label}</p>}
                    </figure>
                ))}
            </div>
            <Dialog open={Boolean(selected)} onOpenChange={(open) => { if (!open) setSelected(null); }}>
                <DialogContent className="max-w-data sm:max-w-data">
                    <DialogTitle>{selected?.label}</DialogTitle>
                    <DialogDescription className="sr-only">Screenshot captured during the check.</DialogDescription>
                    {selected && <img src={selected.url} alt={selected.label} className="max-h-[calc(100dvh-150px)] w-full rounded-lg border border-line bg-surface-soft object-contain" />}
                </DialogContent>
            </Dialog>
        </>
    );
}

function SuggestedBehavior({ item }: { item: PresentedInboxItem }) {
    if (!["update", "new_check", "feature"].includes(item.presentation.type)) return null;
    const { humanSpec, description } = item.payload.params ?? {};
    if (!humanSpec && !description) return null;
    return <div className="max-w-reading space-y-4 border-t border-line pt-4">
        {description && <p className="whitespace-pre-wrap break-words text-body text-ink">{description}</p>}
        {humanSpec && <>
            {humanSpec.preconditions.length > 0 && <section><h3 className="text-body font-medium text-ink">Before the check</h3><ul className="mt-2 list-disc space-y-1.5 pl-5 text-body text-ink-muted">{humanSpec.preconditions.map((condition, index) => <li key={index}>{condition}</li>)}</ul></section>}
            <section><h3 className="text-body font-medium text-ink">What this check will do</h3><ol className="mt-3 space-y-3">{humanSpec.steps.map((step, index) => <li key={index} className="flex gap-3.5"><span aria-hidden="true" className="flex size-6 shrink-0 items-center justify-center rounded-full border border-line-strong bg-surface text-meta font-semibold text-ink-muted tabular">{index + 1}</span><span className="min-w-0 break-words pt-0.5 text-body text-ink"><span className="sr-only">Step {index + 1}: </span>{step}</span></li>)}</ol></section>
            <section className="rounded-lg border border-line bg-surface-soft px-4 py-3"><h3 className="text-body font-medium text-ink">Expected result</h3><p className="mt-1.5 whitespace-pre-wrap break-words text-body text-ink">{humanSpec.expectedResult}</p></section>
            {humanSpec.postconditions.length > 0 && <section><h3 className="text-body font-medium text-ink">After the check</h3><ul className="mt-2 list-disc space-y-1.5 pl-5 text-body text-ink-muted">{humanSpec.postconditions.map((condition, index) => <li key={index}>{condition}</li>)}</ul></section>}
        </>}
    </div>;
}

function ItemTechnicalDetails({ item }: { item: PresentedInboxItem }) {
    const verification = item.payload.verification;
    if (!item.payload.files?.length && !item.presentation.technicalDetails && !verification && !item.commitSha) return null;
    return <TechnicalDetails>
        {verification && <p className="text-meta text-ink-muted">Latest test run: {verification.status === "passed" ? "passed" : verification.status === "failed" ? "failed" : "could not finish"}.</p>}
        {item.payload.files?.map((file) => <FileDiff key={file.path} file={file} />)}
        {item.presentation.technicalDetails && <pre tabIndex={0} aria-label="Technical details of this suggestion" className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-code-canvas p-3 font-mono text-meta text-ink-muted">{item.presentation.technicalDetails}</pre>}
        {item.commitSha && <p className="text-meta text-ink-subtle">Saved revision: <code>{item.commitSha.slice(0, 8)}</code></p>}
    </TechnicalDetails>;
}

export default function InboxPage({ params }: { params: Promise<{ projectId: string }> }) {
    const { projectId } = use(params);
    const router = useRouter();
    const [data, setData] = useState<InboxResponse | null>(null);
    const [loadError, setLoadError] = useState("");
    const [actionError, setActionError] = useState<{ id: string; message: string } | null>(null);
    const [busy, setBusy] = useState<{ id: string; action: InboxAction } | null>(null);
    const [answers, setAnswers] = useState<Record<string, string>>({});
    const [showReviewed, setShowReviewed] = useState(false);
    const [visibleCount, setVisibleCount] = useState(5);
    const openedAnchor = useRef("");

    const load = useCallback(async (signal?: AbortSignal) => {
        try {
            setData(await api<InboxResponse>(apiPath`/projects/${projectId}/inbox`, { signal }));
            setLoadError("");
        } catch (error) {
            if (!isAbortError(error)) setLoadError("The latest decisions could not load. Check your connection and try again.");
        }
    }, [projectId]);

    useEffect(() => {
        const controller = new AbortController();
        void load(controller.signal);
        const timer = setInterval(() => void load(controller.signal), 5000);
        return () => { controller.abort(); clearInterval(timer); };
    }, [load]);

    const items = data?.items ?? [];
    const pending = items.filter((item) => item.status === "pending" || item.status === "applying");
    const visible = showReviewed ? items : pending;

    useEffect(() => {
        const anchor = window.location.hash.slice(1);
        if (!anchor || openedAnchor.current === anchor || !data) return;
        const item = data.items.find((item) => item.id === anchor);
        if (!item) return;
        if (!showReviewed && !["pending", "applying"].includes(item.status)) { setShowReviewed(true); return; }
        const index = visible.findIndex((item) => item.id === anchor);
        if (index >= visibleCount) { setVisibleCount(index + 1); return; }
        openedAnchor.current = anchor;
        document.getElementById(anchor)?.scrollIntoView({ block: "start" });
    }, [data, showReviewed, visible, visibleCount]);

    async function act(item: PresentedInboxItem, action: InboxAction) {
        setBusy({ id: item.id, action });
        setActionError(null);
        try {
            if (action === "discuss") {
                const result = await api<{ chatId: string }>(apiPath`/projects/${projectId}/inbox/${item.id}/discuss`, { method: "POST" });
                router.push(`/p/${projectId}/chats/${result.chatId}`);
            } else if (action === "promote") {
                await api(apiPath`/projects/${projectId}/inbox/${item.id}/promote`, { method: "POST" });
                await load();
            } else {
                const answer = item.presentation.credentialRequest ? "Credentials have been updated. Check the available access and continue." : answers[item.id];
                await api(apiPath`/projects/${projectId}/inbox/${item.id}/review`, { method: "POST", body: JSON.stringify({ action, answer }) });
                await load();
            }
        } catch {
            setActionError({ id: item.id, message: action === "discuss" ? "The conversation could not open. Try again in a moment." : "Your decision could not be saved. Refresh the page and try again." });
        } finally { setBusy(null); }
    }

    function actions(item: PresentedInboxItem) {
        const { type, credentialRequest } = item.presentation;
        const active = busy?.id === item.id;
        const label = (action: InboxAction, ready: string, working: string) => active && busy.action === action ? working : ready;
        return <>
            {type === "update" && <><Button size="sm" disabled={busy !== null} onClick={() => void act(item, "approve")}>{label("approve", "Update the check", "Saving…")}</Button><Button variant="outline" size="sm" disabled={busy !== null} onClick={() => void act(item, "report_bug")}>{label("report_bug", "No, this is a bug in the app", "Recording the bug…")}</Button></>}
            {(type === "new_check" || type === "feature") && <><Button size="sm" disabled={busy !== null} onClick={() => void act(item, "approve")}>{label("approve", type === "feature" ? "Add this feature" : "Add this check", "Saving…")}</Button><Button variant="outline" size="sm" disabled={busy !== null} onClick={() => void act(item, "reject")}>{label("reject", "Not now", "Saving your decision…")}</Button></>}
            {type === "question" && (credentialRequest ? <><Button asChild size="sm"><Link href={`/p/${projectId}/settings?tab=credentials`}>Open credentials</Link></Button><Button variant="outline" size="sm" disabled={busy !== null} onClick={() => void act(item, "answer")}>{label("answer", "Check access again", "Continuing…")}</Button></> : <Button size="sm" disabled={busy !== null || !answers[item.id]?.trim()} onClick={() => void act(item, "answer")}>{label("answer", "Send answer and continue", "Sending…")}</Button>)}
            {type === "bug" && <>{item.payload.regressionIntentId ? <Button asChild variant="outline" size="sm"><Link href={`/p/${projectId}/activity#${item.presentation.activityId}`}>Follow the new check</Link></Button> : <Button size="sm" disabled={busy !== null} onClick={() => void act(item, "promote")}>{label("promote", "Add a regression check", "Preparing a check…")}</Button>}<Button variant="outline" size="sm" disabled={busy !== null} onClick={() => void act(item, "dismiss")}>{label("dismiss", "Mark as reviewed", "Saving…")}</Button></>}
            {type === "help" && <><Button size="sm" disabled={busy !== null} onClick={() => void act(item, "discuss")}><MessageSquareText size={13} />{label("discuss", "Look at it together", "Opening chat…")}</Button><Button variant="outline" size="sm" disabled={busy !== null} onClick={() => void act(item, "ignore")}>{label("ignore", "Ignore this check for now", "Saving…")}</Button></>}
            {type !== "help" && <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => void act(item, "discuss")}><MessageSquareText size={13} />{label("discuss", "Discuss in chat", "Opening chat…")}</Button>}
        </>;
    }

    return (
        <div className="flex min-h-full flex-col bg-surface">
            <PageHeader title="Inbox" description="Decide what your app should do. Specbook handles the checks." width="data" actions={<Button asChild variant="outline"><Link href={`/p/${projectId}/activity`}><Activity size={14} /> View activity</Link></Button>} />
            <PageContainer width="data" innerClassName="space-y-6">
                {data && <AgentStatusSummary projectId={projectId} summary={data.summary} onContinue={load} />}
                {loadError && data && <Alert variant="danger" role="alert" className="flex flex-wrap items-center justify-between gap-3"><AlertDescription>{loadError}</AlertDescription><Button type="button" variant="outline" size="sm" onClick={() => void load()}><RefreshCw size={13} /> Try again</Button></Alert>}
                {loadError && !data ? (
                    <EmptyState role="alert" tone="danger" icon={AlertCircle} title="Inbox could not load" description={loadError} action={<Button type="button" onClick={() => void load()}><RefreshCw size={14} /> Try again</Button>} />
                ) : !data ? (
                    <div className="space-y-3" aria-busy="true" aria-label="Loading Inbox" role="status"><Skeleton className="mb-6 h-12 w-full" />{[0, 1, 2].map((row) => <Skeleton key={row} className="h-44 w-full rounded-lg" />)}</div>
                ) : (
                    <>
                        {items.length > 0 && <div role="group" aria-label="Filter Inbox" className="-mx-1 flex flex-wrap items-center gap-1">{[{ value: false, label: "Needs your decision", count: pending.length }, { value: true, label: "All decisions", count: items.length }].map((filter) => <Button key={filter.label} type="button" variant="ghost" size="sm" aria-pressed={showReviewed === filter.value} onClick={() => { setShowReviewed(filter.value); setVisibleCount(5); }} className={cn("h-8 gap-1.5 rounded-full px-3", showReviewed === filter.value && "bg-surface-selected text-ink hover:bg-surface-selected")}>{filter.label}<span className="tabular text-ink-subtle">{filter.count}</span></Button>)}</div>}
                        {visible.length === 0 ? (
                            <EmptyState icon={Inbox} title="No decisions needed" description="Suggestions with evidence and questions that need your answer will appear here. Specs are the saved checks that describe how your app should work." action={<Button asChild variant="outline"><Link href={`/p/${projectId}/activity`}><Activity size={14} /> See what Specbook is doing</Link></Button>} />
                        ) : <ul className="space-y-4" aria-label="Decisions for you">{visible.slice(0, visibleCount).map((item) => {
                            const view = item.presentation;
                            const decisionPending = item.status === "pending";
                            const stateLabel = item.status === "approved" ? "Saved" : item.status === "rejected" ? "Kept unchanged" : item.status === "answered" ? "Answered" : item.status === "dismissed" ? "Reviewed" : "Saving";
                            return <li id={item.id} key={item.id} className="min-w-0 scroll-mt-4 space-y-4 rounded-xl border border-line px-4 py-5 sm:px-5">
                                <div>
                                    <div className="flex flex-wrap items-start justify-between gap-3"><h2 className="min-w-0 max-w-reading flex-1 break-words text-section text-ink">{view.title}</h2>{!decisionPending && <Badge variant={item.status === "applying" ? "running" : item.status === "approved" || item.status === "answered" ? "success" : "neutral"}>{item.status === "applying" ? <LoaderCircle size={12} className="animate-spin motion-reduce:animate-none" /> : item.status === "rejected" ? <X size={12} /> : <Check size={12} />}{stateLabel}</Badge>}</div>
                                    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-meta text-ink-subtle"><RelativeTime value={item.createdAt} /><Link className="rounded-sm underline underline-offset-2 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" href={`/p/${projectId}/activity#${view.activityId}`}>How we got here</Link></div>
                                    <p className="mt-3 max-w-reading text-body text-ink">{view.summary}</p>
                                    {view.workDone && <p className="mt-2 max-w-reading text-body text-ink-muted">{view.workDone}</p>}
                                </div>
                                <Screenshots item={item} />
                                <SuggestedBehavior item={item} />
                                {item.answer && <p className="max-w-reading whitespace-pre-wrap break-words text-body text-ink-muted"><span className="font-medium">Your answer: </span>{item.answer}</p>}
                                {actionError?.id === item.id && <Alert variant="danger" role="alert" className="text-body"><AlertDescription>{actionError.message}</AlertDescription></Alert>}
                                {decisionPending && <div className="space-y-3">
                                    {view.type === "question" && !view.credentialRequest && <div className="max-w-reading space-y-2"><Label htmlFor={`answer-${item.id}`} className="text-body">Your answer</Label><Textarea id={`answer-${item.id}`} className="text-body" value={answers[item.id] ?? ""} onChange={(event) => setAnswers((current) => ({ ...current, [item.id]: event.target.value }))} disabled={busy !== null} aria-describedby={`answer-help-${item.id}`} /><p id={`answer-help-${item.id}`} className="text-meta text-ink-subtle">Keep passwords in <Link className="underline underline-offset-2 hover:text-ink" href={`/p/${projectId}/settings?tab=credentials`}>Settings → Credentials</Link>.</p></div>}
                                    <div className="flex flex-wrap gap-2">{actions(item)}</div>
                                    <p className="max-w-reading text-meta text-ink-subtle">{view.consequence}</p>
                                </div>}
                                <ItemTechnicalDetails item={item} />
                            </li>;
                        })}</ul>}
                        {visible.length > visibleCount && <div className="flex justify-center"><Button type="button" variant="outline" onClick={() => setVisibleCount((count) => count + 5)}>Show more decisions <span className="text-meta text-ink-subtle">{visible.length - visibleCount} more</span></Button></div>}
                    </>
                )}
            </PageContainer>
        </div>
    );
}
