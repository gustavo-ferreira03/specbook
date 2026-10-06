"use client";

import { useCallback, useEffect, useState } from "react";
import { InlineFeedback, SettingsBlock, SettingsSection } from "@/components/SettingsLayout";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { api, errorMessage } from "@/lib/api";
import { formatDateTime } from "@/lib/format";

interface AuditEvent { id: string; actorId: string | null; actorName: string | null; actorKind: string; action: string; projectId: string | null; details: unknown; createdAt: string }
interface AuditResponse { events: AuditEvent[]; nextBefore: string | null }

export function AuditSettings() {
    const [data, setData] = useState<AuditResponse | null>(null);
    const [error, setError] = useState("");
    const [busy, setBusy] = useState(false);
    const load = useCallback(async () => { setError(""); try { setData(await api<AuditResponse>("/settings/audit?limit=50")); } catch (reason) { setError(errorMessage(reason)); } }, []);
    useEffect(() => { void load(); }, [load]);
    async function more() {
        if (!data?.nextBefore) return; setBusy(true); setError("");
        try { const next = await api<AuditResponse>(`/settings/audit?limit=50&before=${encodeURIComponent(data.nextBefore)}`); setData({ events: [...data.events, ...next.events], nextBefore: next.nextBefore }); }
        catch (reason) { setError(errorMessage(reason)); }
        finally { setBusy(false); }
    }
    return <SettingsSection id="audit-heading" title="Audit log" description="Account, project and agent actions recorded by this instance.">
        {error && <SettingsBlock><InlineFeedback feedback={{ type: "error", text: error }} />{!data && <Button variant="outline" className="mt-3" onClick={() => void load()}>Try again</Button>}</SettingsBlock>}
        {!data && !error ? <SettingsBlock><Skeleton className="h-40 w-full" /></SettingsBlock> : !data ? null : !data.events.length ? <SettingsBlock><p className="text-body text-ink-muted">No actions recorded yet.</p></SettingsBlock> : <ul>{data.events.map((event) => <li key={event.id} className="border-b border-line px-4 py-4 last:border-0 sm:px-5"><div className="flex flex-wrap justify-between gap-2"><p className="text-body font-medium text-ink">{event.action.replaceAll(/[._]/g, " ")}</p><time className="text-meta text-ink-subtle" dateTime={event.createdAt}>{formatDateTime(event.createdAt, { seconds: true })}</time></div><p className="mt-1 text-body text-ink-muted">{event.actorName ?? (event.actorKind === "user" ? "Former member" : event.actorKind === "agent" ? "Specbook agent" : event.actorKind === "ci" ? "CI integration" : "Specbook server")}</p></li>)}</ul>}
        {data?.nextBefore && <SettingsBlock><Button variant="outline" onClick={() => void more()} disabled={busy}>{busy ? "Loading…" : "Load older actions"}</Button></SettingsBlock>}
    </SettingsSection>;
}
