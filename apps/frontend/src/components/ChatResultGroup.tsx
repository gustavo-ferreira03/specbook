"use client";

import { Check, Clock3, LoaderCircle, MessageSquareText, Pause, X } from "lucide-react";
import { useAuth } from "@/components/AuthProvider";
import { ChatContextReview } from "@/components/ChatContextReview";
import { ChatDecisionDetails } from "@/components/ChatDecisionDetails";
import { CredentialRequestCard } from "@/components/CredentialRequestCard";
import { RelativeTime } from "@/components/RelativeTime";
import { StatusPill } from "@/components/StatusPill";
import { Button } from "@/components/ui/button";
import type { ChatResults } from "@/lib/chatResults";
import { formatDuration } from "@/lib/format";
import type { PresentedInboxItem } from "@/lib/types";

const TASK_STATUS = {
    queued: { label: "Queued", icon: Clock3 },
    working: { label: "Working", icon: LoaderCircle },
    needs_answer: { label: "Waiting for your answer", icon: MessageSquareText },
    paused: { label: "Paused", icon: Pause },
    completed: { label: "Finished", icon: Check },
    failed: { label: "Could not finish", icon: X },
    stopped: { label: "Stopped", icon: X },
};

export function ChatResultGroup({ projectId, data, busy, onChange, onDiscuss, onViewSpec, onReviewContext, onAnswerQuestion, onManageAutomation }: {
    projectId: string;
    data: ChatResults;
    busy: boolean;
    onChange: () => Promise<void>;
    onDiscuss: (message: string) => Promise<void>;
    onViewSpec: (specId: string, runId?: string) => void;
    onReviewContext: () => void;
    onAnswerQuestion: (itemId: string) => void;
    onManageAutomation: () => void;
}) {
    const { canEdit } = useAuth();
    function discuss(item: PresentedInboxItem) {
        return onDiscuss(`Help me understand this suggestion and decide what to do. Do not change files unless I ask you to.\n${item.presentation.title}\n${item.presentation.summary}\nSuggestion reference: ${item.id}.`);
    }
    return <div className="space-y-6">
        {data.contextRevision && <ChatContextReview revision={data.contextRevision} busy={busy} onChange={onChange} onDiscuss={onDiscuss} />}
        {data.tasks.length > 0 && <ul className="divide-y divide-line border-y border-line">
            {data.tasks.map((task) => {
                const status = TASK_STATUS[task.status];
                const Icon = status.icon;
                return <li key={task.id} className="space-y-1 py-3" aria-label={task.title}>
                    <p className="flex items-start gap-2 text-body font-medium text-ink"><Icon size={14} aria-hidden="true" className={task.status === "working" ? "mt-1 shrink-0 animate-spin motion-reduce:animate-none" : "mt-1 shrink-0"} /><span className="min-w-0 break-words">{task.title}</span></p>
                    <p role={task.status === "working" || task.status === "queued" ? "status" : undefined} className="text-meta text-ink-muted">{status.label}<span aria-hidden="true"> · </span><RelativeTime value={task.updatedAt} /></p>
                    {task.summary && <p className="whitespace-pre-wrap break-words text-body text-ink-muted">{task.summary}</p>}
                    {task.status === "paused" && canEdit && <Button variant="outline" size="sm" onClick={onManageAutomation}>Review pause settings</Button>}
                </li>;
            })}
        </ul>}
        {data.items.map((item) => <ChatDecisionDetails key={item.id} projectId={projectId} item={item} onChange={onChange} onDiscuss={discuss} onViewSpec={onViewSpec} onReviewContext={onReviewContext} onAnswerQuestion={onAnswerQuestion} />)}
        {data.notes.map((note) => <section key={note.id} className="space-y-2" aria-label={note.title}>
            <h3 className="text-body font-medium text-ink">{note.title}</h3>
            <p className="whitespace-pre-wrap break-words text-body text-ink-muted">{note.body}</p>
        </section>)}
        {(data.runs.length > 0 || data.specs.length > 0) && <ul className="divide-y divide-line border-y border-line">
            {data.runs.map((run) => <li key={run.id} className="flex min-w-0 flex-wrap items-center gap-2 py-3">
                <span className="min-w-0 flex-1 break-words text-body font-medium text-ink">{run.title}</span>
                <StatusPill status={run.flaky ? "flaky" : run.status} kind="run" size="sm" />
                {run.durationMs !== null && <span className="text-meta text-ink-subtle">{formatDuration(run.durationMs)}</span>}
                <Button variant="outline" size="sm" onClick={() => onViewSpec(run.specId, run.id)}>Review result</Button>
            </li>)}
            {data.specs.filter((spec) => !data.runs.some((run) => run.specId === spec.id)).map((spec) => <li key={spec.id} className="flex min-w-0 flex-wrap items-center gap-2 py-3">
                <span className="min-w-0 flex-1 break-words text-body font-medium text-ink">{spec.title}</span>
                <StatusPill status={spec.status} size="sm" />
                <Button variant="outline" size="sm" onClick={() => onViewSpec(spec.id)}>Review Spec</Button>
            </li>)}
        </ul>}
        {canEdit && data.credentialRequests.map(({ chatId, request }) => <CredentialRequestCard key={request.id} chatId={chatId} request={request} nested onResolved={() => void onChange()} />)}
    </div>;
}
