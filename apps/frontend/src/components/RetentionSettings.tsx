"use client";

import { useCallback, useEffect, useState } from "react";
import { InlineFeedback, SettingsBlock, SettingsFooter, SettingsRow, SettingsSection, type InlineFeedbackValue } from "@/components/SettingsLayout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { api, errorMessage } from "@/lib/api";
import { formatDateTime } from "@/lib/format";

interface Retention { runsPerSpec: number; runDays: number; videoDays: number; batchDays: number; metricDays: number; browserProfileDays: number }
interface RetentionResponse { settings: Retention; lastCleanup: { completedAt: string; removedRuns: number; removedVideos: number; removedBatches: number; removedMetrics: number; removedBrowserProfiles: number } | null }
const FIELDS: { key: keyof Retention; label: string; description: string }[] = [
    { key: "runsPerSpec", label: "Runs per Spec", description: "Always keep this many recent runs for each Spec." },
    { key: "runDays", label: "Run history, days", description: "Also keep every run newer than this." },
    { key: "videoDays", label: "Failure videos, days", description: "Remove older videos while keeping the run result." },
    { key: "batchDays", label: "Run batches, days", description: "Keep batch summaries for this period." },
    { key: "metricDays", label: "Metrics, days", description: "Keep older usage and performance records for this period." },
    { key: "browserProfileDays", label: "Browser profiles, days", description: "Remove inactive chat browser profiles after this period." },
];

export function RetentionSettings() {
    const [data, setData] = useState<RetentionResponse | null>(null);
    const [busy, setBusy] = useState(false);
    const [feedback, setFeedback] = useState<InlineFeedbackValue | null>(null);
    const load = useCallback(async () => { try { setData(await api<RetentionResponse>("/settings/retention")); } catch (reason) { setFeedback({ type: "error", text: errorMessage(reason) }); } }, []);
    useEffect(() => { void load(); }, [load]);
    async function save(event: React.FormEvent) {
        event.preventDefault(); if (!data) return; setBusy(true); setFeedback(null);
        try { setData(await api<RetentionResponse>("/settings/retention", { method: "PUT", body: JSON.stringify(data.settings) })); setFeedback({ type: "success", text: "Retention settings saved." }); }
        catch (reason) { setFeedback({ type: "error", text: errorMessage(reason) }); }
        finally { setBusy(false); }
    }
    async function clean() {
        setBusy(true); setFeedback(null);
        try { setData(await api<RetentionResponse>("/settings/retention/cleanup", { method: "POST" })); setFeedback({ type: "success", text: "Cleanup completed using the saved retention settings." }); }
        catch (reason) { setFeedback({ type: "error", text: errorMessage(reason) }); }
        finally { setBusy(false); }
    }
    return <SettingsSection id="retention-heading" title="Storage retention" description="Keep recent evidence and remove older data automatically. Pending decisions and active investigations keep the runs they need.">
        {!data ? <SettingsBlock>{feedback ? <><InlineFeedback feedback={feedback} /><Button type="button" variant="outline" className="mt-3" onClick={() => void load()}>Try again</Button></> : <Skeleton className="h-40 w-full" />}</SettingsBlock> : <form onSubmit={save}>
            {FIELDS.map(({ key, label, description }) => <SettingsRow key={key} label={label} htmlFor={`retention-${key}`} description={description}><Input id={`retention-${key}`} type="number" min={1} max={key === "runsPerSpec" ? 1000 : 3650} step={1} required className="max-w-32" value={data.settings[key] || ""} onChange={(event) => setData({ ...data, settings: { ...data.settings, [key]: Number(event.target.value) } })} disabled={busy} /></SettingsRow>)}
            {data.lastCleanup && <SettingsBlock><p className="text-body text-ink">Last cleanup: {formatDateTime(data.lastCleanup.completedAt)}</p><p className="mt-1 text-meta text-ink-muted">Removed {data.lastCleanup.removedRuns} runs, {data.lastCleanup.removedVideos} videos, {data.lastCleanup.removedBatches} batches, {data.lastCleanup.removedMetrics} metrics and {data.lastCleanup.removedBrowserProfiles} browser profiles.</p></SettingsBlock>}
            <SettingsFooter feedback={<InlineFeedback feedback={feedback} />}><Button type="button" variant="outline" disabled={busy} onClick={() => void clean()}>Clean up now</Button><Button type="submit" disabled={busy}>{busy ? "Saving…" : "Save retention settings"}</Button></SettingsFooter>
        </form>}
    </SettingsSection>;
}
