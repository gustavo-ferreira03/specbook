"use client";

import Link from "next/link";
import { use, useCallback, useEffect, useState } from "react";
import { Bot } from "lucide-react";
import { EmptyState } from "@/components/EmptyState";
import { PageContainer, PageHeader } from "@/components/PageHeader";
import { RelativeTime } from "@/components/RelativeTime";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { api, apiPath, errorMessage } from "@/lib/api";
import type { Job, JobAction } from "@/lib/types";

export default function JobsPage({ params }: { params: Promise<{ projectId: string }> }) {
    const { projectId } = use(params);
    const [jobs, setJobs] = useState<Job[] | null>(null);
    const [goal, setGoal] = useState("");
    const [error, setError] = useState("");
    const [busy, setBusy] = useState(false);
    const [logs, setLogs] = useState<Record<string, JobAction[]>>({});
    const load = useCallback(async () => {
        try { setJobs((await api<{ jobs: Job[] }>(apiPath`/projects/${projectId}/jobs`)).jobs); }
        catch (error) { setError(errorMessage(error)); }
    }, [projectId]);
    useEffect(() => { void load(); const timer = setInterval(() => void load(), 3000); return () => clearInterval(timer); }, [load]);
    async function start() {
        setBusy(true); setError("");
        try { await api(apiPath`/projects/${projectId}/jobs`, { method: "POST", body: JSON.stringify(goal.trim() ? { goal } : {}) }); setGoal(""); await load(); }
        catch (error) { setError(errorMessage(error)); }
        finally { setBusy(false); }
    }
    async function inspect(id: string) {
        try { const result = await api<{ actions: JobAction[] }>(apiPath`/projects/${projectId}/jobs/${id}`); setLogs((current) => ({ ...current, [id]: result.actions })); }
        catch (error) { setError(errorMessage(error)); }
    }
    async function cancel(id: string) {
        setBusy(true);
        try { await api(apiPath`/projects/${projectId}/jobs/${id}/cancel`, { method: "POST" }); await load(); }
        catch (error) { setError(errorMessage(error)); }
        finally { setBusy(false); }
    }
    return <div className="min-h-full bg-surface text-body">
        <PageHeader title="Jobs" description="The agent works independently and sends results to your Inbox." actions={<Button asChild variant="outline"><Link href={`/p/${projectId}/inbox`}>Open Inbox</Link></Button>} />
        <PageContainer>
            {error && <p role="alert" className="mb-4 text-danger">{error} <Button variant="ghost" onClick={() => void load()}>Retry</Button></p>}
            <form className="mb-8 max-w-reading space-y-3" onSubmit={(event) => { event.preventDefault(); void start(); }}>
                <label htmlFor="job-goal" className="font-medium">What should the agent investigate? <span className="font-normal text-ink-muted">Optional</span></label>
                <Textarea id="job-goal" value={goal} onChange={(event) => setGoal(event.target.value)} placeholder="Review this project’s Specs and propose improvements" />
                <div className="flex flex-wrap items-center gap-3"><Button type="submit" disabled={busy}>{busy ? "Starting…" : "Start job"}</Button><p className="text-meta text-ink-subtle">Up to 80 actions, 100,000 tokens, 10 minutes.</p></div>
            </form>
            {!jobs ? <Skeleton className="h-32 w-full" /> : !jobs.length ? <EmptyState icon={Bot} title="No jobs yet" description="Leave the goal empty for a general review, or give the agent a specific task." /> :
                <ul className="divide-y divide-line">{jobs.map((job) => <li id={job.id} key={job.id} className="scroll-mt-4 py-5">
                    <div className="flex flex-wrap items-start justify-between gap-3"><h2 className="max-w-reading break-words text-section">{job.goal}</h2><Badge variant={job.status === "blocked" || job.status === "budget_exceeded" ? "warning" : job.status === "completed" ? "success" : "neutral"}>{job.status.replaceAll("_", " ")}</Badge></div>
                    <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-meta text-ink-subtle"><span>{job.trigger.replaceAll("_", " ")}</span><RelativeTime value={job.createdAt} /><span>{job.actionsUsed}/{job.budget.maxActions} actions</span><span>{job.tokensUsed.toLocaleString()}/{job.budget.maxTokens.toLocaleString()} tokens</span><span>{Math.round(job.elapsedMs / 1000)}s active</span></div>
                    <div className="mt-3 flex flex-wrap gap-2"><Button variant="outline" onClick={() => void inspect(job.id)}>View audit log</Button>{["queued", "running", "blocked"].includes(job.status) && <Button variant="ghost" disabled={busy} onClick={() => void cancel(job.id)}>Cancel job</Button>}{job.status === "blocked" && <Button asChild variant="outline"><Link href={`/p/${projectId}/inbox`}>Answer in Inbox</Link></Button>}</div>
                    {logs[job.id] && <ol aria-label="Audit log" className="mt-3 max-h-96 space-y-3 overflow-auto rounded-lg border border-line p-3">{logs[job.id].map((entry) => <li key={entry.id}><div className="flex flex-wrap gap-2 text-meta"><span className="font-medium">{entry.action}</span><RelativeTime value={entry.createdAt} /></div>{entry.detail && <pre className="mt-1 whitespace-pre-wrap break-words text-meta text-ink-muted">{entry.detail}</pre>}</li>)}</ol>}
                </li>)}</ul>}
        </PageContainer>
    </div>;
}
