"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Check, LoaderCircle, MessageSquareText, X } from "lucide-react";
import { FileDiff } from "@/components/FileDiff";
import { StoryTimeline } from "@/components/StoryDetails";
import { TechnicalDetails } from "@/components/TechnicalDetails";
import { SpecBatchDecision } from "@/components/SpecBatchDecision";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { useAuth } from "@/components/AuthProvider";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { api, apiPath, API_URL } from "@/lib/api";
import type { ActivityStory, PresentedInboxItem } from "@/lib/types";
import { cn } from "@/lib/utils";

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
                    <DialogDescription className="sr-only">Screenshot captured during the run.</DialogDescription>
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
            {humanSpec.preconditions.length > 0 && <section><h3 className="text-body font-medium text-ink">Before the run</h3><ul className="mt-2 list-disc space-y-1.5 pl-5 text-body text-ink-muted">{humanSpec.preconditions.map((condition, index) => <li key={index}>{condition}</li>)}</ul></section>}
            <section><h3 className="text-body font-medium text-ink">What this Spec will do</h3><ol className="mt-3 space-y-3">{humanSpec.steps.map((step, index) => <li key={index} className="flex gap-3.5"><span aria-hidden="true" className="flex size-6 shrink-0 items-center justify-center rounded-full border border-line-strong bg-surface text-meta font-semibold text-ink-muted tabular">{index + 1}</span><span className="min-w-0 break-words pt-0.5 text-body text-ink"><span className="sr-only">Step {index + 1}: </span>{step}</span></li>)}</ol></section>
            <section className="rounded-lg border border-line bg-surface-soft px-4 py-3"><h3 className="text-body font-medium text-ink">Expected result</h3><p className="mt-1.5 whitespace-pre-wrap break-words text-body text-ink">{humanSpec.expectedResult}</p></section>
            {humanSpec.postconditions.length > 0 && <section><h3 className="text-body font-medium text-ink">After the run</h3><ul className="mt-2 list-disc space-y-1.5 pl-5 text-body text-ink-muted">{humanSpec.postconditions.map((condition, index) => <li key={index}>{condition}</li>)}</ul></section>}
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

export function DecisionDetails({ projectId, item, story, onChange }: { projectId: string; item: PresentedInboxItem; story?: ActivityStory; onChange: () => Promise<void> }) {
    const { canEdit } = useAuth();
    const router = useRouter();
    const [actionError, setActionError] = useState<{ id: string; message: string } | null>(null);
    const [busy, setBusy] = useState<{ id: string; action: InboxAction } | null>(null);
    const [answers, setAnswers] = useState<Record<string, string>>({});
    const view = item.presentation;
    const pending = item.status === "pending";
    const stateLabel = item.status === "approved" ? "Saved" : item.status === "rejected" ? "Kept unchanged" : item.status === "answered" ? "Answered" : item.status === "dismissed" ? "Reviewed" : "Saving";

    async function act(item: PresentedInboxItem, action: InboxAction) {
        setBusy({ id: item.id, action });
        setActionError(null);
        try {
            if (action === "discuss") {
                const result = await api<{ chatId: string }>(apiPath`/projects/${projectId}/inbox/${item.id}/discuss`, { method: "POST" });
                router.push(`/p/${projectId}/chats/${result.chatId}`);
            } else if (action === "promote") {
                await api(apiPath`/projects/${projectId}/inbox/${item.id}/promote`, { method: "POST" });
                await onChange();
            } else {
                const answer = item.presentation.credentialRequest ? "Credentials have been updated. Check the available access and continue." : answers[item.id];
                await api(apiPath`/projects/${projectId}/inbox/${item.id}/review`, { method: "POST", body: JSON.stringify({ action, answer }) });
                await onChange();
            }
        } catch {
            setActionError({ id: item.id, message: action === "discuss" ? "The conversation could not open. Try again in a moment." : "Your decision could not be saved. Refresh the page and try again." });
        } finally { setBusy(null); }
    }

    function actions(item: PresentedInboxItem) {
        if (!canEdit) return <p className="text-body text-ink-muted">An editor can answer or review this decision.</p>;
        const { type, credentialRequest } = item.presentation;
        const active = busy?.id === item.id;
        const label = (action: InboxAction, ready: string, working: string) => active && busy.action === action ? working : ready;
        return <>
            {type === "update" && <><Button size="sm" disabled={busy !== null} onClick={() => void act(item, "approve")}>{label("approve", "Update the Spec", "Saving…")}</Button><Button variant="outline" size="sm" disabled={busy !== null} onClick={() => void act(item, "report_bug")}>{label("report_bug", "No, this is a bug in the app", "Recording the bug…")}</Button></>}
            {(type === "new_check" || type === "feature") && <><Button size="sm" disabled={busy !== null} onClick={() => void act(item, "approve")}>{label("approve", type === "feature" ? "Add this feature" : "Add this Spec", "Saving…")}</Button><Button variant="outline" size="sm" disabled={busy !== null} onClick={() => void act(item, "reject")}>{label("reject", "Not now", "Saving your decision…")}</Button></>}
            {type === "question" && (credentialRequest ? <><Button asChild size="sm"><Link href={`/p/${projectId}/settings?tab=credentials`}>Open credentials</Link></Button><Button variant="outline" size="sm" disabled={busy !== null} onClick={() => void act(item, "answer")}>{label("answer", "Check access again", "Continuing…")}</Button></> : <Button size="sm" disabled={busy !== null || !answers[item.id]?.trim()} onClick={() => void act(item, "answer")}>{label("answer", "Send answer and continue", "Sending…")}</Button>)}
            {type === "bug" && <>{item.payload.regressionIntentId ? <Button asChild variant="outline" size="sm"><Link href={`/p/${projectId}/overview#${item.presentation.activityId}`}>Follow the new Spec</Link></Button> : <Button size="sm" disabled={busy !== null} onClick={() => void act(item, "promote")}>{label("promote", "Add a regression Spec", "Preparing a Spec…")}</Button>}<Button variant="outline" size="sm" disabled={busy !== null} onClick={() => void act(item, "dismiss")}>{label("dismiss", "Mark as reviewed", "Saving…")}</Button></>}
            {type === "help" && <><Button size="sm" disabled={busy !== null} onClick={() => void act(item, "discuss")}><MessageSquareText size={13} />{label("discuss", "Look at it together", "Opening chat…")}</Button><Button variant="outline" size="sm" disabled={busy !== null} onClick={() => void act(item, "ignore")}>{label("ignore", "Ignore this Spec for now", "Saving…")}</Button></>}
            {type !== "help" && <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => void act(item, "discuss")}><MessageSquareText size={13} />{label("discuss", "Discuss in chat", "Opening chat…")}</Button>}
        </>;
    }

    return <div className="space-y-5">
        {!pending && view.type !== "batch" && <Badge variant={item.status === "applying" ? "running" : item.status === "approved" || item.status === "answered" ? "success" : "neutral"}>{item.status === "applying" ? <LoaderCircle size={12} className="animate-spin motion-reduce:animate-none" /> : item.status === "rejected" ? <X size={12} /> : <Check size={12} />}{stateLabel}</Badge>}
        <div className="space-y-2"><p className="text-body text-ink">{view.summary}</p>{view.workDone && <p className="text-body text-ink-muted">{view.workDone}</p>}</div>
        <Screenshots item={item} />
        <SuggestedBehavior item={item} />
        {view.type === "batch" && <SpecBatchDecision key={item.id} projectId={projectId} item={item} onChange={onChange} />}
        {item.answer && <p className="whitespace-pre-wrap break-words text-body text-ink-muted"><span className="font-medium">Your answer: </span>{item.answer}</p>}
        {actionError && <Alert variant="danger" role="alert"><AlertDescription>{actionError.message}</AlertDescription></Alert>}
        {pending && view.type !== "batch" && <div className="space-y-3">
            {canEdit && view.type === "question" && !view.credentialRequest && <div className="space-y-2"><Label htmlFor={`answer-${item.id}`} className="text-body">Your answer</Label><Textarea id={`answer-${item.id}`} className="text-body" value={answers[item.id] ?? ""} onChange={(event) => setAnswers((current) => ({ ...current, [item.id]: event.target.value }))} disabled={busy !== null} aria-describedby={`answer-help-${item.id}`} /><p id={`answer-help-${item.id}`} className="text-meta text-ink-subtle">Keep passwords in <Link className="underline underline-offset-2 hover:text-ink" href={`/p/${projectId}/settings?tab=credentials`}>Settings → Credentials</Link>.</p></div>}
            <div className="flex flex-wrap gap-2">{actions(item)}</div>
            <p className="text-meta text-ink-subtle">{view.consequence}</p>
        </div>}
        {story?.timeline.some((event) => ![view.title, view.summary, view.workDone].includes(event.detail)) && <section className="space-y-3 border-t border-line pt-4"><h3 className="text-body font-medium text-ink">What happened</h3><StoryTimeline story={story} projectId={projectId} omit={[view.title, view.summary, view.workDone]} /></section>}
        <ItemTechnicalDetails item={item} />
    </div>;
}
