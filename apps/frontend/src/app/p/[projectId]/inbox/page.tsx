"use client";

import Link from "next/link";
import { use, useCallback, useEffect, useState } from "react";
import { Activity, AlertCircle, Check, ChevronDown, CircleDashed, FileCode2, Inbox, LoaderCircle, MessageSquareText, RefreshCw, X } from "lucide-react";
import { EmptyState } from "@/components/EmptyState";
import { PageContainer, PageHeader } from "@/components/PageHeader";
import { HighlightedCode } from "@/components/RawFileEditor";
import { RelativeTime } from "@/components/RelativeTime";
import { StatusPill } from "@/components/StatusPill";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge, type BadgeVariant } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { api, apiPath, API_URL, errorMessage, isAbortError } from "@/lib/api";
import type { InboxItem } from "@/lib/types";
import { cn } from "@/lib/utils";

const ITEM_STATUSES: Record<InboxItem["status"], { label: string; variant: BadgeVariant; icon: typeof Check }> = {
    pending: { label: "Needs review", variant: "warning", icon: CircleDashed },
    applying: { label: "Applying", variant: "running", icon: LoaderCircle },
    approved: { label: "Approved", variant: "success", icon: Check },
    rejected: { label: "Rejected", variant: "neutral", icon: X },
    answered: { label: "Answered", variant: "success", icon: MessageSquareText },
    dismissed: { label: "Reviewed", variant: "neutral", icon: Check },
};

const ITEM_KINDS: Record<InboxItem["kind"], string> = {
    new_spec: "New Spec",
    spec_fix: "Spec fix",
    feature: "Feature",
    question: "Question",
    bug_report: "Bug report",
    note: "Note",
};

type ReviewAction = "approve" | "reject" | "answer" | "dismiss";

function ProposedChanges({ item }: { item: InboxItem }) {
    return (
        <Collapsible className="group/source mt-4 overflow-hidden rounded-xl border border-line">
            <CollapsibleTrigger asChild>
                <button type="button" className="flex w-full items-center gap-3 px-3.5 py-3 text-left outline-none transition-colors hover:bg-surface-soft focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset">
                    <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-surface-hover text-ink-muted"><FileCode2 size={15} aria-hidden="true" /></span>
                    <span className="min-w-0 flex-1 text-control font-semibold text-ink">Review proposed changes</span>
                    <ChevronDown size={15} className="shrink-0 text-ink-subtle transition-transform group-data-[state=open]/source:rotate-180 motion-reduce:transition-none" aria-hidden="true" />
                </button>
            </CollapsibleTrigger>
            <CollapsibleContent className="space-y-4 border-t border-line bg-surface-soft/60 p-3.5">
                {item.payload.before?.yaml && (
                    <div className="space-y-2">
                        <h3 className="text-body font-medium">Current spec.yml</h3>
                        <HighlightedCode label="Current spec.yml" language="yaml" source={item.payload.before.yaml} className="max-h-64 overflow-auto" />
                    </div>
                )}
                {item.payload.before?.testSource && (
                    <div className="space-y-2">
                        <h3 className="text-body font-medium">Current spec.ts</h3>
                        <HighlightedCode label="Current spec.ts" language="typescript" source={item.payload.before.testSource} className="max-h-64 overflow-auto" />
                    </div>
                )}
                <div className="space-y-2">
                    <h3 className="text-body font-medium">Proposed fields</h3>
                    <pre tabIndex={0} aria-label="Proposed fields" className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-code-canvas p-3 text-meta outline-none focus-visible:ring-2 focus-visible:ring-ring/20">
                        {Object.entries(item.payload.params ?? {}).map(([key, value]) => `${key}:\n${typeof value === "string" ? value : JSON.stringify(value, null, 2)}`).join("\n\n")}
                    </pre>
                </div>
            </CollapsibleContent>
        </Collapsible>
    );
}

export default function InboxPage({ params }: { params: Promise<{ projectId: string }> }) {
    const { projectId } = use(params);
    const [items, setItems] = useState<InboxItem[] | null>(null);
    const [loadError, setLoadError] = useState("");
    const [actionError, setActionError] = useState<{ id: string; message: string } | null>(null);
    const [busy, setBusy] = useState<{ id: string; action: ReviewAction | "promote" } | null>(null);
    const [answers, setAnswers] = useState<Record<string, string>>({});
    const [showReviewed, setShowReviewed] = useState(false);

    const load = useCallback(async (signal?: AbortSignal) => {
        try {
            const result = await api<{ items: InboxItem[] }>(apiPath`/projects/${projectId}/inbox`, { signal });
            setItems(result.items);
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

    async function review(item: InboxItem, action: ReviewAction) {
        setBusy({ id: item.id, action });
        setActionError(null);
        try {
            await api(apiPath`/projects/${projectId}/inbox/${item.id}/review`, { method: "POST", body: JSON.stringify({ action, answer: answers[item.id] }) });
            await load();
        } catch (error) {
            setActionError({ id: item.id, message: errorMessage(error) });
        } finally {
            setBusy(null);
        }
    }

    async function promote(item: InboxItem) {
        setBusy({ id: item.id, action: "promote" });
        setActionError(null);
        try {
            await api(apiPath`/projects/${projectId}/inbox/${item.id}/promote`, { method: "POST" });
            await load();
        } catch (error) {
            setActionError({ id: item.id, message: errorMessage(error) });
        } finally { setBusy(null); }
    }

    const reviewable = items?.filter((item) => item.kind !== "note") ?? [];
    const pending = reviewable.filter((item) => item.status === "pending" || item.status === "applying");
    const visible = showReviewed ? reviewable : pending;

    return (
        <div className="flex min-h-full flex-col bg-surface">
            <PageHeader
                title="Inbox"
                description="Review the agent’s proposals, findings, and questions."
                width="data"
                actions={<Button asChild variant="outline"><Link href={`/p/${projectId}/activity`}><Activity size={14} /> View activity</Link></Button>}
            />
            <PageContainer width="data" innerClassName="space-y-6">
                {loadError && items && (
                    <Alert variant="danger" role="alert" className="flex flex-wrap items-center justify-between gap-3">
                        <AlertDescription>{loadError}</AlertDescription>
                        <Button type="button" variant="outline" size="sm" onClick={() => void load()}><RefreshCw size={13} /> Try again</Button>
                    </Alert>
                )}
                {loadError && !items ? (
                    <EmptyState role="alert" tone="danger" icon={AlertCircle} title="Inbox could not load" description={loadError} action={<Button type="button" onClick={() => void load()}><RefreshCw size={14} /> Try again</Button>} />
                ) : !items ? (
                    <div className="space-y-2" aria-busy="true" aria-label="Loading Inbox" role="status">
                        {[0, 1, 2].map((row) => <Skeleton key={row} className="h-32 w-full rounded-lg" />)}
                    </div>
                ) : (
                    <>
                        {reviewable.length > 0 && (
                            <div role="group" aria-label="Filter Inbox" className="-mx-1 flex flex-wrap items-center gap-1">
                                {[{ value: false, label: "Needs review", count: pending.length }, { value: true, label: "All items", count: reviewable.length }].map((filter) => (
                                    <Button key={filter.label} type="button" variant="ghost" size="sm" aria-pressed={showReviewed === filter.value} onClick={() => setShowReviewed(filter.value)} className={cn("h-8 gap-1.5 rounded-full px-3", showReviewed === filter.value && "bg-surface-selected text-ink hover:bg-surface-selected")}>
                                        {filter.label}<span className="tabular text-ink-subtle">{filter.count}</span>
                                    </Button>
                                ))}
                            </div>
                        )}
                        {visible.length === 0 ? (
                            <EmptyState
                                icon={Inbox}
                                title="Nothing needs your attention"
                                description="The agent brings you proposals, findings, and questions when a decision is needed. Follow its work in Activity."
                                action={<Button asChild variant="outline"><Link href={`/p/${projectId}/activity`}><Activity size={14} /> View activity</Link></Button>}
                            />
                        ) : (
                            <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line" aria-label="Inbox items">
                                {visible.map((item) => {
                                    const status = ITEM_STATUSES[item.status];
                                    const Icon = status.icon;
                                    const verification = item.payload.verification;
                                    const reviewing = busy?.id === item.id;
                                    return (
                                        <li key={item.id} className="min-w-0 px-4 py-5">
                                            <div className="flex flex-wrap items-start justify-between gap-3">
                                                <h2 className="min-w-0 flex-1 break-words text-body font-medium text-ink">{item.title}</h2>
                                                <Badge variant={status.variant}><Icon size={12} aria-hidden="true" className={item.status === "applying" ? "animate-spin motion-reduce:animate-none" : undefined} />{status.label}</Badge>
                                            </div>
                                            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-meta text-ink-subtle">
                                                <span>{ITEM_KINDS[item.kind]}</span>
                                                <RelativeTime value={item.createdAt} />
                                                <Link className="rounded-sm underline underline-offset-2 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" href={`/p/${projectId}/activity#${item.jobId}`}>View activity</Link>
                                            </div>
                                            <p className="mt-3 max-w-reading whitespace-pre-wrap break-words text-body text-ink">{item.body}</p>
                                            {item.kind === "bug_report" && (
                                                <div className="mt-3 flex flex-wrap gap-2">
                                                    {item.payload.regressionIntentId ? <Button asChild variant="outline" size="sm"><Link href={`/p/${projectId}/activity`}>Follow regression proposal</Link></Button>
                                                        : <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => void promote(item)}>{reviewing && busy.action === "promote" ? "Requesting proposal…" : "Promote to regression Spec"}</Button>}
                                                    {item.payload.specId && <Button asChild variant="ghost" size="sm"><Link href={`/p/${projectId}/specs/${item.payload.specId}${item.payload.runId ? `#run-${item.payload.runId}` : ""}`}>View evidence</Link></Button>}
                                                </div>
                                            )}
                                            {item.payload.params && <ProposedChanges item={item} />}
                                            {verification && (
                                                <div className="mt-4 space-y-2">
                                                    <div className="flex flex-wrap items-center gap-2"><span className="text-meta text-ink-muted">Verification</span><StatusPill status={verification.status} kind="run" size="sm" /></div>
                                                    {verification.failReason && <pre className="whitespace-pre-wrap break-words text-meta text-danger">{verification.failReason}</pre>}
                                                    {verification.screenshots.length > 0 && (
                                                        <div className="flex flex-wrap gap-x-4 gap-y-2">
                                                            {verification.screenshots.map((file, index) => <a key={file} className="rounded-sm text-meta text-ink-muted underline underline-offset-2 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" href={`${API_URL}${apiPath`/projects/${projectId}/inbox/${item.id}/evidence/${file}`}`} target="_blank" rel="noreferrer">Step {index + 1} screenshot</a>)}
                                                        </div>
                                                    )}
                                                </div>
                                            )}
                                            {item.payload.requiresVerification && verification?.status !== "passed" && <Alert variant="warning" className="mt-4" role="status"><AlertDescription>A passing verification is required before approval.</AlertDescription></Alert>}
                                            {item.answer && <p className="mt-3 whitespace-pre-wrap break-words text-body text-ink-muted">Your answer: {item.answer}</p>}
                                            {item.commitSha && <p className="mt-3 text-meta text-ink-subtle">Committed as <code>{item.commitSha.slice(0, 8)}</code></p>}
                                            {actionError?.id === item.id && <Alert variant="danger" role="alert" className="mt-4"><AlertDescription>{actionError.message}</AlertDescription></Alert>}
                                            {item.status === "pending" && (
                                                <div className="mt-4 space-y-3">
                                                    {item.kind === "question" && (
                                                        <div className="max-w-reading space-y-2">
                                                            <Label htmlFor={`answer-${item.id}`} className="text-body">Your answer</Label>
                                                            <Textarea id={`answer-${item.id}`} className="text-body" value={answers[item.id] ?? ""} onChange={(event) => setAnswers((current) => ({ ...current, [item.id]: event.target.value }))} disabled={reviewing} aria-describedby={`answer-help-${item.id}`} />
                                                            <p id={`answer-help-${item.id}`} className="text-meta text-ink-subtle">Add credentials in <Link className="font-medium underline underline-offset-2 hover:text-ink" href={`/p/${projectId}/settings?tab=credentials`}>Settings</Link>, then let the agent know they are ready.</p>
                                                        </div>
                                                    )}
                                                    <div className="flex flex-wrap gap-2">
                                                        {["new_spec", "spec_fix", "feature"].includes(item.kind) ? (
                                                            <>
                                                                <Button size="sm" disabled={busy !== null || Boolean(item.payload.requiresVerification && verification?.status !== "passed")} onClick={() => void review(item, "approve")}>{reviewing && busy.action === "approve" ? "Applying…" : "Approve and commit"}</Button>
                                                                <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => void review(item, "reject")}>{reviewing && busy.action === "reject" ? "Rejecting…" : "Reject proposal"}</Button>
                                                            </>
                                                        ) : item.kind === "question" ? (
                                                            <Button size="sm" disabled={busy !== null || !answers[item.id]?.trim()} onClick={() => void review(item, "answer")}>{reviewing ? "Sending answer…" : "Answer and resume"}</Button>
                                                        ) : (
                                                            <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => void review(item, "dismiss")}>{reviewing ? "Marking reviewed…" : "Mark reviewed"}</Button>
                                                        )}
                                                    </div>
                                                </div>
                                            )}
                                        </li>
                                    );
                                })}
                            </ul>
                        )}
                    </>
                )}
            </PageContainer>
        </div>
    );
}
