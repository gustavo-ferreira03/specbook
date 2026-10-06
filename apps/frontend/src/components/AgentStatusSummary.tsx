"use client";

import { useState } from "react";
import { Eye, LoaderCircle, Play } from "lucide-react";
import { RelativeTime } from "@/components/RelativeTime";
import { InlineFeedback } from "@/components/SettingsLayout";
import { TechnicalDetails } from "@/components/TechnicalDetails";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { api, apiPath } from "@/lib/api";
import type { AgentSummary } from "@/lib/types";

export function AgentStatusSummary({ summary, projectId, onContinue }: { summary: AgentSummary; projectId: string; onContinue: () => Promise<void> }) {
    const [busy, setBusy] = useState(false);
    const [feedback, setFeedback] = useState<{ type: "success" | "error"; text: string } | null>(null);

    async function continueNow() {
        setBusy(true);
        setFeedback(null);
        try {
            await api(apiPath`/projects/${projectId}/continue-now`, { method: "POST" });
            await onContinue();
            setFeedback({ type: "success", text: "Specbook can continue its checks today." });
        } catch {
            setFeedback({ type: "error", text: "Specbook could not continue yet. Try again in a moment." });
        } finally { setBusy(false); }
    }

    return (
        <section aria-label="What Specbook is doing" className="space-y-4 border-b border-line pb-6">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                <div className="flex min-w-0 max-w-reading flex-1 gap-2.5">
                    {summary.activeCount > 0 ? <LoaderCircle size={17} className="mt-0.5 shrink-0 animate-spin text-ink-muted motion-reduce:animate-none" aria-hidden="true" /> : <Eye size={17} className="mt-0.5 shrink-0 text-ink-muted" aria-hidden="true" />}
                    <div className="min-w-0">
                        <p className="text-body text-ink">{summary.statusText}</p>
                        <p className="mt-1 text-meta text-ink-subtle">{summary.lastCheckedAt ? <RelativeTime value={summary.lastCheckedAt} prefix="Last check" /> : "The first completed check will appear here."}</p>
                    </div>
                </div>
                {summary.canContinue && (
                    <div className="space-y-1.5">
                        <Button type="button" variant="outline" disabled={busy} onClick={() => void continueNow()}>{busy ? <LoaderCircle size={14} className="animate-spin motion-reduce:animate-none" /> : <Play size={14} />} {busy ? "Continuing…" : "Continue now"}</Button>
                        <p className="text-meta text-ink-subtle">Allows one more round today.</p>
                    </div>
                )}
            </div>
            {feedback && <InlineFeedback feedback={feedback} />}
            {summary.systemHealth && <Alert variant="warning" role="status" className="text-body"><AlertDescription>{summary.systemHealth.message}</AlertDescription>{summary.systemHealth.detail && <div className="mt-2"><TechnicalDetails><p className="whitespace-pre-wrap break-words text-meta text-ink-muted">{summary.systemHealth.detail}</p></TechnicalDetails></div>}</Alert>}
        </section>
    );
}
