"use client";

import Link from "next/link";
import { use, useCallback, useEffect, useState } from "react";
import { Inbox } from "lucide-react";
import { PageContainer, PageHeader } from "@/components/PageHeader";
import { EmptyState } from "@/components/EmptyState";
import { RelativeTime } from "@/components/RelativeTime";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { api, apiPath, errorMessage } from "@/lib/api";
import type { InboxItem } from "@/lib/types";

export default function InboxPage({ params }: { params: Promise<{ projectId: string }> }) {
    const { projectId } = use(params);
    const [items, setItems] = useState<InboxItem[] | null>(null);
    const [error, setError] = useState("");
    const [busy, setBusy] = useState<string | null>(null);
    const [answers, setAnswers] = useState<Record<string, string>>({});
    const [showReviewed, setShowReviewed] = useState(false);
    const load = useCallback(async () => {
        try { setItems((await api<{ items: InboxItem[] }>(apiPath`/projects/${projectId}/inbox`)).items); setError(""); }
        catch (error) { setError(errorMessage(error)); }
    }, [projectId]);
    useEffect(() => { void load(); const timer = setInterval(() => void load(), 5000); return () => clearInterval(timer); }, [load]);
    async function review(item: InboxItem, action: string) {
        setBusy(item.id); setError("");
        try {
            await api(apiPath`/projects/${projectId}/inbox/${item.id}/review`, { method: "POST", body: JSON.stringify({ action, answer: answers[item.id] }) });
            await load();
        } catch (error) { setError(errorMessage(error)); }
        finally { setBusy(null); }
    }
    const visible = items?.filter((item) => showReviewed || item.status === "pending" || item.status === "applying");
    return <div className="min-h-full bg-surface text-body">
        <PageHeader title="Inbox" description="Review the agent’s proposals, findings, and questions." actions={<Button asChild variant="outline"><Link href={`/p/${projectId}/jobs`}>View jobs</Link></Button>} />
        <PageContainer>
            {error && <p role="alert" className="mb-4 text-danger">{error} <Button variant="ghost" onClick={() => void load()}>Retry</Button></p>}
            <label className="mb-6 flex items-center gap-2 text-body"><input type="checkbox" checked={showReviewed} onChange={(event) => setShowReviewed(event.target.checked)} /> Show reviewed items</label>
            {!items ? <Skeleton className="h-32 w-full" /> : visible?.length === 0 ? <EmptyState icon={Inbox} title="Nothing to review" description="Start a job to investigate your app. Its proposals and questions will appear here." action={<Button asChild><Link href={`/p/${projectId}/jobs`}>Start a job</Link></Button>} /> :
                <ul className="divide-y divide-line">{visible?.map((item) => <li key={item.id} className="py-5 first:pt-0">
                    <div className="flex flex-wrap items-center gap-2"><h2 className="text-section">{item.title}</h2><Badge variant={item.kind === "question" ? "warning" : "secondary"}>{item.status}</Badge><Badge variant="neutral">{item.kind.replaceAll("_", " ")}</Badge></div>
                    <div className="mt-1 flex flex-wrap gap-3 text-meta text-ink-subtle"><RelativeTime value={item.createdAt} /><Link className="underline" href={`/p/${projectId}/jobs#${item.jobId}`}>Job details</Link></div>
                    <p className="mt-3 max-w-reading whitespace-pre-wrap break-words">{item.body}</p>
                    {item.payload.params && <details className="mt-3 rounded-lg border border-line p-3"><summary className="cursor-pointer font-medium">Review proposed changes</summary>
                        {item.payload.before?.yaml && <><h3 className="mt-4 font-medium">Current spec.yml</h3><pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words bg-code-canvas p-3 text-meta">{item.payload.before.yaml}</pre></>}
                        {item.payload.before?.testSource && <><h3 className="mt-4 font-medium">Current spec.ts</h3><pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words bg-code-canvas p-3 text-meta">{item.payload.before.testSource}</pre></>}
                        <h3 className="mt-4 font-medium">Proposed fields</h3><pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap break-words bg-code-canvas p-3 text-meta">{Object.entries(item.payload.params).map(([key, value]) => `${key}:\n${typeof value === "string" ? value : JSON.stringify(value, null, 2)}`).join("\n\n")}</pre>
                    </details>}
                    {item.answer && <p className="mt-3 whitespace-pre-wrap text-ink-muted">Your answer: {item.answer}</p>}
                    {item.commitSha && <p className="mt-3 text-meta text-ink-subtle">Committed as <code>{item.commitSha.slice(0, 8)}</code></p>}
                    {item.status === "pending" && <div className="mt-4 space-y-3">
                        {item.kind === "question" && <><label htmlFor={`answer-${item.id}`}>Answer <span className="text-ink-muted">(enter credentials in <Link className="underline" href={`/p/${projectId}/settings?tab=credentials`}>Settings</Link>)</span></label><Textarea id={`answer-${item.id}`} value={answers[item.id] ?? ""} onChange={(event) => setAnswers({ ...answers, [item.id]: event.target.value })} /></>}
                        <div className="flex flex-wrap gap-2">{["new_spec", "spec_fix", "feature"].includes(item.kind) ? <><Button disabled={busy !== null} onClick={() => void review(item, "approve")}>Approve and commit</Button><Button variant="outline" disabled={busy !== null} onClick={() => void review(item, "reject")}>Reject proposal</Button></> : item.kind === "question" ? <Button disabled={busy !== null || !answers[item.id]?.trim()} onClick={() => void review(item, "answer")}>Answer and resume</Button> : <Button variant="outline" disabled={busy !== null} onClick={() => void review(item, "dismiss")}>Mark reviewed</Button>}</div>
                    </div>}
                </li>)}</ul>}
        </PageContainer>
    </div>;
}
