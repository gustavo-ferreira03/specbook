"use client";

import Link from "next/link";
import { useState } from "react";
import { Check, CircleDashed, LoaderCircle, MessageSquareText, X } from "lucide-react";
import { useAuth } from "@/components/AuthProvider";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button, focusRing } from "@/components/ui/button";
import { api, apiPath, errorMessage } from "@/lib/api";
import type { PresentedInboxItem } from "@/lib/types";
import { cn } from "@/lib/utils";

type Candidate = NonNullable<PresentedInboxItem["payload"]["specBatch"]>["candidates"][number];

function CandidateStatus({ candidate }: { candidate: Candidate }) {
    if (candidate.state === "passed") return <Badge variant="success" size="sm"><Check size={12} aria-hidden="true" />Passed</Badge>;
    if (candidate.state === "failed") return <Badge variant="danger" size="sm"><X size={12} aria-hidden="true" />First run failed</Badge>;
    if (candidate.state === "generating") return <Badge variant="running" size="sm"><LoaderCircle size={12} aria-hidden="true" className="animate-spin motion-reduce:animate-none" />Creating</Badge>;
    if (candidate.state === "needs_answer") return <Badge variant="warning" size="sm"><MessageSquareText size={12} aria-hidden="true" />Needs your answer</Badge>;
    return <Badge variant="neutral" size="sm"><CircleDashed size={12} aria-hidden="true" />{candidate.state === "stopped" ? "Needs review" : "Waiting"}</Badge>;
}

export function SpecBatchDecision({ projectId, item, onChange }: { projectId: string; item: PresentedInboxItem; onChange: () => Promise<void> }) {
    const { canEdit } = useAuth();
    const [selected, setSelected] = useState<string[]>([]);
    const [busy, setBusy] = useState<string | null>(null);
    const [error, setError] = useState("");
    const batch = item.payload.specBatch;
    if (!batch) return <p className="text-body text-ink-muted">This list could not load. Refresh Overview to try again.</p>;
    const pending = item.status === "pending";
    const selectedCandidates = batch.candidates.filter((candidate) => candidate.selected);
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

    return <div className="space-y-4">
        {error && <Alert variant="danger" role="alert"><AlertDescription>{error}</AlertDescription></Alert>}
        {pending ? <>
            {batch.contextReviewRequired && <Alert variant="info"><AlertDescription>{batch.contextStatus === "discarded" ? "These suggestions belong to discarded findings. Use Discuss these Specs to request fresh suggestions." : <>Review and confirm the discovery findings before adding Specs. <Link href={`/p/${projectId}#overview-context-heading`} className="font-medium underline underline-offset-2">Review project context</Link></>}</AlertDescription></Alert>}
            <fieldset disabled={!canEdit || busy !== null} className="min-w-0">
                <legend className="sr-only">Choose Specs to create</legend>
                {canEdit && <label className="mb-2 flex min-h-9 w-fit cursor-pointer items-center gap-2.5 text-body text-ink-muted"><input type="checkbox" checked={selected.length === batch.candidates.length} onChange={(event) => setSelected(event.target.checked ? batch.candidates.map((candidate) => candidate.id) : [])} className={cn("size-4 shrink-0 accent-primary", focusRing)} />Select all Specs</label>}
                <ul className="divide-y divide-line border-y border-line">
                    {batch.candidates.map((candidate) => <li key={candidate.id} className="min-w-0 py-3">
                        <label className={cn("flex items-start gap-3", canEdit && "cursor-pointer")}>
                            <input type="checkbox" checked={selected.includes(candidate.id)} onChange={(event) => setSelected((current) => event.target.checked ? [...current, candidate.id] : current.filter((id) => id !== candidate.id))} aria-label={`Add ${candidate.title}`} className={cn("mt-1 size-4 shrink-0 accent-primary", focusRing)} />
                            <span className="min-w-0 space-y-1"><span className="block break-words text-body font-medium text-ink">{candidate.title}</span><span className="block break-words text-body text-ink-muted">{candidate.goal}</span><span className="block break-words text-meta text-ink-subtle">{candidate.feature}</span><span className="block break-words text-body text-ink-muted">{candidate.why}</span></span>
                        </label>
                    </li>)}
                </ul>
            </fieldset>
            {canEdit ? <div className="flex flex-wrap items-center gap-2">
                <Button disabled={!selected.length || busy !== null || batch.contextReviewRequired} onClick={() => void save("select", apiPath`/projects/${projectId}/inbox/${item.id}/select`, { candidateIds: selected })}>{busy === "select" ? <><LoaderCircle size={14} className="animate-spin motion-reduce:animate-none" />Creating selected Specs…</> : `Add selected Specs${selected.length ? ` (${selected.length})` : ""}`}</Button>
                <Button variant="ghost" disabled={busy !== null} onClick={() => void save("dismiss", apiPath`/projects/${projectId}/inbox/${item.id}/review`, { action: "dismiss" })}>Not now</Button>
            </div> : <p className="text-body text-ink-muted">An editor can select which Specs to add.</p>}
            <p className="text-meta text-ink-subtle">Each selected Spec is created, validated and run once.</p>
            <Button asChild variant="ghost" size="sm"><Link href={`/p/${projectId}/chats/${batch.sourceChatId}`}><MessageSquareText size={13} aria-hidden="true" />Discuss these Specs</Link></Button>
        </> : item.status === "approved" ? <>
            <p role="status" className="text-body text-ink-muted">{finished} of {selectedCandidates.length} selected Specs finished.</p>
            <ul className="divide-y divide-line border-y border-line">
                {selectedCandidates.map((candidate) => <li key={candidate.id} className="min-w-0 space-y-2 py-3">
                    <div className="flex flex-wrap items-center gap-2"><span className="min-w-0 flex-1 break-words text-body font-medium text-ink">{candidate.title}</span><CandidateStatus candidate={candidate} /></div>
                    <p className="break-words text-body text-ink-muted">{candidate.goal}</p>
                    {candidate.error && <details className="text-body"><summary className="w-fit cursor-pointer text-ink-muted">Why this Spec needs attention</summary><p className="mt-2 whitespace-pre-wrap break-words text-body text-ink-muted">{candidate.error}</p></details>}
                    <div className="flex flex-wrap gap-2">
                        {candidate.specId && <Button asChild variant="outline" size="sm"><Link href={`/p/${projectId}/specs/${candidate.specId}`}>Review Spec</Link></Button>}
                        {candidate.specId && candidate.runId && <Button asChild variant="ghost" size="sm"><Link href={`/p/${projectId}/specs/${candidate.specId}#run-${candidate.runId}`}>View first result</Link></Button>}
                        {candidate.questionId && <Button asChild variant="outline" size="sm"><Link href={`/p/${projectId}/overview#${candidate.questionId}`}>Answer question</Link></Button>}
                    </div>
                </li>)}
            </ul>
        </> : <p className="text-body text-ink-muted">These suggestions were set aside. No Specs were created.</p>}
    </div>;
}
