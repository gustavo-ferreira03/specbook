"use client";

import { useState } from "react";
import { Check, CircleDashed, KeyRound, LoaderCircle, MessageSquareText, X } from "lucide-react";
import { useAuth } from "@/components/AuthProvider";
import { CredentialProfilesCard } from "@/components/CredentialProfilesCard";
import { FileDiff } from "@/components/FileDiff";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button, focusRing } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { api, apiPath, API_URL, errorMessage } from "@/lib/api";
import type { PresentedInboxItem, SpecCandidate } from "@/lib/types";
import { cn } from "@/lib/utils";

type ReviewAction = "approve" | "reject" | "answer" | "dismiss" | "report_bug" | "ignore";
type DecisionAction = ReviewAction | "promote" | "discuss";

export interface ChatDecisionDetailsProps {
    projectId: string;
    item: PresentedInboxItem;
    onChange: () => Promise<void>;
    onDiscuss: (item: PresentedInboxItem) => Promise<void>;
    onReviewContext?: () => void;
    onViewSpec?: (specId: string, runId?: string) => void;
    onAnswerQuestion?: (itemId: string) => void;
}

function CandidateStatus({ candidate }: { candidate: SpecCandidate }) {
    if (candidate.state === "passed") return <Badge variant="success" size="sm"><Check size={12} aria-hidden="true" />Passed</Badge>;
    if (candidate.state === "failed") return <Badge variant="danger" size="sm"><X size={12} aria-hidden="true" />First run failed</Badge>;
    if (candidate.state === "generating") return <Badge variant="running" size="sm"><LoaderCircle size={12} aria-hidden="true" className="animate-spin motion-reduce:animate-none" />Creating</Badge>;
    if (candidate.state === "needs_answer") return <Badge variant="warning" size="sm"><MessageSquareText size={12} aria-hidden="true" />Needs your answer</Badge>;
    return <Badge variant="neutral" size="sm"><CircleDashed size={12} aria-hidden="true" />{candidate.state === "stopped" ? "Needs review" : "Waiting"}</Badge>;
}

function ChatSpecBatch({ projectId, item, onChange, onDiscuss, onReviewContext, onViewSpec, onAnswerQuestion }: ChatDecisionDetailsProps) {
    const { canEdit } = useAuth();
    const [selected, setSelected] = useState<string[]>([]);
    const [busy, setBusy] = useState<string | null>(null);
    const [error, setError] = useState("");
    const batch = item.payload.specBatch;
    if (!batch) return <p className="text-body text-ink-muted">This list could not load. Reload the conversation to try again.</p>;
    const pending = item.status === "pending";
    const selectedCandidates = batch.candidates.filter((candidate) => candidate.selected);
    const selectedIds = selected.filter((id) => batch.candidates.some((candidate) => candidate.id === id));
    const finished = selectedCandidates.filter((candidate) => ["passed", "failed", "stopped"].includes(candidate.state)).length;

    async function save(action: string, path: string, body: unknown) {
        setBusy(action);
        setError("");
        try {
            await api(path, { method: "POST", body: JSON.stringify(body) });
            await onChange();
        } catch (failure) { setError(errorMessage(failure)); }
        finally { setBusy(null); }
    }

    async function discuss() {
        setBusy("discuss");
        setError("");
        try { await onDiscuss(item); }
        catch (failure) { setError(errorMessage(failure)); }
        finally { setBusy(null); }
    }

    return <div className="space-y-4">
        {error && <Alert variant="danger" role="alert"><AlertDescription>{error}</AlertDescription></Alert>}
        {pending ? <>
            {batch.contextReviewRequired && <Alert variant="info"><AlertDescription>{batch.contextStatus === "discarded" ? "These suggestions belong to discarded findings. Use Discuss these Specs to request fresh suggestions in this conversation." : <>Confirm the discovery findings before adding Specs.{onReviewContext && <Button variant="link" className="ml-1 whitespace-normal text-left" onClick={onReviewContext}>Review findings in this chat</Button>}</>}</AlertDescription></Alert>}
            <fieldset disabled={!canEdit || busy !== null} className="min-w-0">
                <legend className="sr-only">Choose Specs to create</legend>
                {canEdit && <label className="mb-2 flex min-h-9 w-fit cursor-pointer items-center gap-2.5 text-body text-ink-muted"><input type="checkbox" checked={batch.candidates.length > 0 && selectedIds.length === batch.candidates.length} onChange={(event) => setSelected(event.target.checked ? batch.candidates.map((candidate) => candidate.id) : [])} className={cn("size-4 shrink-0 accent-primary", focusRing)} />Select all Specs</label>}
                <ul className="divide-y divide-line border-y border-line">
                    {batch.candidates.map((candidate) => <li key={candidate.id} className="min-w-0 py-3">
                        <label className={cn("flex items-start gap-3", canEdit && "cursor-pointer")}>
                            <input type="checkbox" checked={selectedIds.includes(candidate.id)} onChange={(event) => setSelected((current) => event.target.checked ? [...current, candidate.id] : current.filter((id) => id !== candidate.id))} aria-label={`Add ${candidate.title}`} className={cn("mt-1 size-4 shrink-0 accent-primary", focusRing)} />
                            <span className="min-w-0 space-y-1"><span className="block break-words text-body font-medium text-ink">{candidate.title}</span><span className="block break-words text-body text-ink-muted">{candidate.goal}</span><span className="block break-words text-meta text-ink-subtle">{candidate.feature}</span><span className="block break-words text-body text-ink-muted">{candidate.why}</span></span>
                        </label>
                    </li>)}
                </ul>
            </fieldset>
            {canEdit ? <div className="flex flex-wrap items-center gap-2">
                <Button disabled={!selectedIds.length || busy !== null || batch.contextReviewRequired} onClick={() => void save("select", apiPath`/projects/${projectId}/inbox/${item.id}/select`, { candidateIds: selectedIds })}>{busy === "select" ? <><LoaderCircle size={14} className="animate-spin motion-reduce:animate-none" />Creating selected Specs…</> : `Add selected Specs${selectedIds.length ? ` (${selectedIds.length})` : ""}`}</Button>
                <Button variant="ghost" disabled={busy !== null} onClick={() => void save("dismiss", apiPath`/projects/${projectId}/inbox/${item.id}/review`, { action: "dismiss" })}>Not now</Button>
                <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => void discuss()}><MessageSquareText size={13} aria-hidden="true" />{busy === "discuss" ? "Preparing…" : "Discuss these Specs"}</Button>
            </div> : <p className="text-body text-ink-muted">An editor can select which Specs to add.</p>}
            <p className="text-meta text-ink-subtle">Each selected Spec is created, validated and run once. Results and follow-up questions appear here.</p>
        </> : item.status === "approved" ? <>
            <p role="status" className="text-body text-ink-muted">{finished} of {selectedCandidates.length} selected Specs finished.</p>
            <ul className="divide-y divide-line border-y border-line">
                {selectedCandidates.map((candidate) => <li key={candidate.id} className="min-w-0 space-y-2 py-3">
                    <div className="flex flex-wrap items-center gap-2"><span className="min-w-0 flex-1 break-words text-body font-medium text-ink">{candidate.title}</span><CandidateStatus candidate={candidate} /></div>
                    <p className="break-words text-body text-ink-muted">{candidate.goal}</p>
                    {candidate.error && <p className="whitespace-pre-wrap break-words text-meta text-ink-muted">{candidate.error}</p>}
                    <div className="flex flex-wrap gap-2">
                        {candidate.specId && onViewSpec && <Button variant="outline" size="sm" onClick={() => onViewSpec(candidate.specId!, candidate.runId)}>Review Spec{candidate.runId ? " and first result" : ""}</Button>}
                        {candidate.questionId && onAnswerQuestion && <Button variant="outline" size="sm" onClick={() => onAnswerQuestion(candidate.questionId!)}>Answer question</Button>}
                    </div>
                </li>)}
            </ul>
        </> : item.status === "applying" ? <p role="status" className="flex items-center gap-2 text-body text-ink-muted"><LoaderCircle size={14} className="animate-spin motion-reduce:animate-none" />Saving your selection…</p> : <p className="text-body text-ink-muted">These suggestions were set aside. No Specs were created.</p>}
    </div>;
}

function Screenshots({ item }: { item: PresentedInboxItem }) {
    const [selected, setSelected] = useState<{ url: string; label: string } | null>(null);
    const [unavailable, setUnavailable] = useState<string[]>([]);
    const shots: [string, { url: string; label: string } | null][] = Object.entries(item.presentation.screenshots).filter((entry): entry is [string, { url: string; label: string }] => Boolean(entry[1]));
    if (item.presentation.type === "update" && item.presentation.screenshots.after && !item.presentation.screenshots.before) shots.unshift(["before", null]);
    if (!shots.length) return null;
    const url = (value: string) => value.startsWith("/") ? `${API_URL}${value}` : value;
    return <>
        <div className={cn("grid gap-4", shots.length > 1 && "sm:grid-cols-2")}>
            {shots.map(([side, shot]) => <figure key={side} className="min-w-0">
                <figcaption className="mb-2 text-body font-medium text-ink">{item.presentation.type === "update" ? side === "before" ? "Before" : "After" : side === "before" ? "What happened" : "What Specbook checked"}</figcaption>
                {!shot ? <p className="rounded-lg border border-line bg-surface-soft p-4 text-body text-ink-muted">No screenshot was captured for the earlier run.</p> : unavailable.includes(shot.url) ? <p className="rounded-lg border border-line bg-surface-soft p-4 text-body text-ink-muted">This screenshot is unavailable.</p> : <button type="button" className={cn("block w-full overflow-hidden rounded-lg border border-line bg-surface-soft", focusRing)} aria-label={`Enlarge screenshot: ${shot.label}`} onClick={() => setSelected({ ...shot, url: url(shot.url) })}><img src={url(shot.url)} alt={shot.label} loading="lazy" onError={() => setUnavailable((current) => [...current, shot.url])} className="max-h-64 w-full object-contain" /></button>}
                {shot && <p className="mt-1.5 text-meta text-ink-subtle">{shot.label}</p>}
            </figure>)}
        </div>
        <Dialog open={Boolean(selected)} onOpenChange={(open) => { if (!open) setSelected(null); }}>
            <DialogContent className="max-w-data sm:max-w-data"><DialogTitle>{selected?.label}</DialogTitle><DialogDescription className="sr-only">Screenshot captured during the run.</DialogDescription>{selected && <img src={selected.url} alt={selected.label} className="max-h-[calc(100dvh-150px)] w-full rounded-lg border border-line bg-surface-soft object-contain" />}</DialogContent>
        </Dialog>
    </>;
}

function SuggestedBehavior({ item }: { item: PresentedInboxItem }) {
    if (!["update", "new_check", "feature"].includes(item.presentation.type)) return null;
    const { humanSpec, description } = item.payload.params ?? {};
    if (!humanSpec && !description) return null;
    return <div className="space-y-4 border-t border-line pt-4">
        {description && <p className="whitespace-pre-wrap break-words text-body text-ink">{description}</p>}
        {humanSpec && <>
            {humanSpec.preconditions.length > 0 && <section><h4 className="text-body font-medium text-ink">Before the run</h4><ul className="mt-2 list-disc space-y-1.5 pl-5 text-body text-ink-muted">{humanSpec.preconditions.map((condition, index) => <li key={index}>{condition}</li>)}</ul></section>}
            <section><h4 className="text-body font-medium text-ink">What this Spec will do</h4><ol className="mt-2 list-decimal space-y-1.5 pl-5 text-body text-ink">{humanSpec.steps.map((step, index) => <li key={index}>{step}</li>)}</ol></section>
            <section className="rounded-lg border border-line bg-surface-soft px-4 py-3"><h4 className="text-body font-medium text-ink">Expected result</h4><p className="mt-1.5 whitespace-pre-wrap break-words text-body text-ink">{humanSpec.expectedResult}</p></section>
            {humanSpec.postconditions.length > 0 && <section><h4 className="text-body font-medium text-ink">After the run</h4><ul className="mt-2 list-disc space-y-1.5 pl-5 text-body text-ink-muted">{humanSpec.postconditions.map((condition, index) => <li key={index}>{condition}</li>)}</ul></section>}
        </>}
    </div>;
}

export function ChatDecisionDetails(props: ChatDecisionDetailsProps) {
    const { projectId, item, onChange, onDiscuss } = props;
    const { canEdit } = useAuth();
    const [busy, setBusy] = useState<DecisionAction | null>(null);
    const [answer, setAnswer] = useState("");
    const [error, setError] = useState("");
    const [credentialsOpen, setCredentialsOpen] = useState(false);
    const view = item.presentation;
    const pending = item.status === "pending";
    const stateLabel = item.status === "approved" ? "Saved" : item.status === "rejected" ? "Kept unchanged" : item.status === "answered" ? "Answered" : item.status === "dismissed" ? "Reviewed" : "Saving";

    async function act(action: DecisionAction) {
        setBusy(action);
        setError("");
        try {
            if (action === "discuss") await onDiscuss(item);
            else if (action === "promote") {
                await api(apiPath`/projects/${projectId}/inbox/${item.id}/promote`, { method: "POST" });
                await onChange();
            } else {
                const response = action === "answer" ? view.credentialRequest ? "Credentials have been updated. Check the available access and continue." : answer.trim() : undefined;
                await api(apiPath`/projects/${projectId}/inbox/${item.id}/review`, { method: "POST", body: JSON.stringify({ action, answer: response }) });
                await onChange();
            }
        } catch (failure) { setError(errorMessage(failure)); }
        finally { setBusy(null); }
    }

    const label = (action: DecisionAction, ready: string, working: string) => busy === action ? working : ready;

    return <section id={`chat-result-${item.id}`} aria-labelledby={`chat-result-title-${item.id}`} className="min-w-0 space-y-4 border-y border-line py-4">
        <div className="flex flex-wrap items-center gap-2">
            <h3 id={`chat-result-title-${item.id}`} className="min-w-0 flex-1 break-words text-body font-semibold text-ink">{view.title}</h3>
            {!pending && view.type !== "batch" && <Badge variant={item.status === "applying" ? "running" : item.status === "approved" || item.status === "answered" ? "success" : "neutral"}>{item.status === "applying" ? <LoaderCircle size={12} className="animate-spin motion-reduce:animate-none" /> : item.status === "rejected" ? <X size={12} /> : <Check size={12} />}{stateLabel}</Badge>}
        </div>
        <div className="space-y-2"><p className="whitespace-pre-wrap break-words text-body text-ink">{view.summary}</p>{view.workDone && <p className="whitespace-pre-wrap break-words text-body text-ink-muted">{view.workDone}</p>}</div>
        <Screenshots item={item} />
        <SuggestedBehavior item={item} />
        {view.type === "batch" && <ChatSpecBatch {...props} />}
        {item.answer && <p className="whitespace-pre-wrap break-words text-body text-ink-muted"><span className="font-medium">Your answer: </span>{item.answer}</p>}
        {error && <Alert variant="danger" role="alert"><AlertDescription>{error}</AlertDescription></Alert>}
        {pending && view.type !== "batch" && <div className="space-y-3">
            {canEdit && view.type === "question" && !view.credentialRequest && <div className="space-y-2"><Label htmlFor={`chat-answer-${item.id}`} className="text-body">Your answer</Label><Textarea id={`chat-answer-${item.id}`} className="text-body" value={answer} onChange={(event) => setAnswer(event.target.value)} disabled={busy !== null} aria-describedby={`chat-answer-help-${item.id}`} /><p id={`chat-answer-help-${item.id}`} className="text-meta text-ink-subtle">For passwords, use Update credentials. Its encrypted form keeps values out of messages and the model.</p></div>}
            {canEdit ? <div className="flex flex-wrap gap-2">
                {view.type === "update" && <><Button size="sm" disabled={busy !== null} onClick={() => void act("approve")}>{label("approve", "Update the Spec", "Saving…")}</Button><Button variant="outline" size="sm" disabled={busy !== null} onClick={() => void act("reject")}>{label("reject", "Keep the current Spec", "Saving…")}</Button><Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => void act("report_bug")}>{label("report_bug", "This is a bug in the app", "Recording the bug…")}</Button></>}
                {(view.type === "new_check" || view.type === "feature") && <><Button size="sm" disabled={busy !== null} onClick={() => void act("approve")}>{label("approve", view.type === "feature" ? "Add this feature" : "Add this Spec", "Saving…")}</Button><Button variant="outline" size="sm" disabled={busy !== null} onClick={() => void act("reject")}>{label("reject", "Not now", "Saving…")}</Button></>}
                {view.type === "question" && <><Button size="sm" disabled={busy !== null || (!view.credentialRequest && !answer.trim())} onClick={() => void act("answer")}>{label("answer", view.credentialRequest ? "Check access again" : "Send answer and continue", "Continuing…")}</Button><Button variant="outline" size="sm" disabled={busy !== null} onClick={() => setCredentialsOpen(true)}><KeyRound size={13} />Update credentials</Button></>}
                {view.type === "bug" && <>{item.payload.regressionIntentId ? <p role="status" className="text-body text-ink-muted">A regression Spec was requested. Its results and questions appear in this chat.</p> : <Button size="sm" disabled={busy !== null} onClick={() => void act("promote")}>{label("promote", "Add a regression Spec", "Preparing a Spec…")}</Button>}<Button variant="outline" size="sm" disabled={busy !== null} onClick={() => void act("dismiss")}>{label("dismiss", "Mark as reviewed", "Saving…")}</Button></>}
                {view.type === "help" && <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => void act("ignore")}>{label("ignore", "Ignore this Spec for now", "Saving…")}</Button>}
                <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => void act("discuss")}><MessageSquareText size={13} />{label("discuss", view.type === "help" ? "Look at it together" : "Discuss here", "Preparing…")}</Button>
            </div> : <p className="text-body text-ink-muted">An editor can answer or review this decision.</p>}
            <p className="text-meta text-ink-subtle">{view.consequence}</p>
        </div>}
        {item.payload.files?.length ? <section className="space-y-3"><h3 className="text-body font-medium text-ink">Proposed changes</h3>{item.payload.files.map((file) => <FileDiff key={file.path} file={file} />)}</section> : null}
        <Dialog open={credentialsOpen} onOpenChange={setCredentialsOpen}>
            <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-reading"><DialogHeader><DialogTitle>Update access</DialogTitle><DialogDescription>Save credentials securely, then check access again in this conversation.</DialogDescription></DialogHeader><CredentialProfilesCard projectId={projectId} /></DialogContent>
        </Dialog>
    </section>;
}
