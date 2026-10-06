"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { Search, RefreshCw } from "lucide-react";
import { useAuth } from "@/components/AuthProvider";
import { EnvironmentSelect } from "@/components/EnvironmentSelect";
import { EmptyState } from "@/components/EmptyState";
import { PageContainer, PageHeader } from "@/components/PageHeader";
import { RelativeTime } from "@/components/RelativeTime";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { api, apiPath, errorMessage } from "@/lib/api";
import { useVisiblePolling } from "@/lib/usePolling";

type Counts = Record<"passing" | "failing" | "flaky" | "draft" | "notRun" | "invalid" | "running", number>;
interface Coverage {
    confirmed: boolean;
    basis: string;
    environment: { id: string; name: string };
    totals: Counts;
    areas: { kind: "area" | "role" | "rule"; name: string; description: string; routes: string[]; coverage: "covered" | "partial" | "uncovered"; reason: string; featureIds: string[]; specIds: string[] }[];
    features: { id: string; title: string; counts: Counts; lastRunAt: string | null }[];
    trend: { id: string; label: string; startedAt: string; passed: number; total: number; passRate: number }[];
}
const healthLabels: Record<keyof Counts, string> = { passing: "passing", failing: "failing", flaky: "flaky", draft: "draft", notRun: "not run", invalid: "need repairing", running: "running" };

export default function CoveragePage() {
    const { projectId } = useParams<{ projectId: string }>();
    const { canEdit } = useAuth();
    const [environment, setEnvironment] = useState("Production");
    const [data, setData] = useState<Coverage | null>(null);
    const [error, setError] = useState("");
    const [requesting, setRequesting] = useState(false);
    const [requested, setRequested] = useState(false);
    const load = useCallback(async () => {
        try { setData(await api<Coverage>(`${apiPath`/projects/${projectId}/coverage`}?environment=${encodeURIComponent(environment)}`)); setError(""); }
        catch (error) { setError(errorMessage(error)); }
    }, [projectId, environment]);
    useEffect(() => { setData(null); void load(); }, [load]);
    useVisiblePolling(() => void load(), 15_000);
    async function findGaps() {
        setRequesting(true);
        try { await api(apiPath`/projects/${projectId}/tasks`, { method: "POST", body: JSON.stringify({ kind: "coverage" }) }); setRequested(true); }
        catch (error) { setError(errorMessage(error)); }
        finally { setRequesting(false); }
    }

    return <div className="flex min-h-full flex-col bg-surface">
        <PageHeader title="Coverage" width="data" breadcrumbs={[{ label: "Overview", href: `/p/${projectId}/overview` }]} description="Compare the project context with saved Specs and their latest results." actions={<EnvironmentSelect projectId={projectId} value={environment} onValueChange={setEnvironment} />} />
        <PageContainer width="data" innerClassName="space-y-7">
            {error && <Alert variant="danger" role="alert"><AlertDescription>{error}<Button variant="outline" size="sm" className="ml-3" onClick={() => void load()}><RefreshCw size={14} /> Try again</Button></AlertDescription></Alert>}
            {!data && !error ? <div className="space-y-4" role="status" aria-label="Loading coverage"><Skeleton className="h-14 w-full" /><Skeleton className="h-40 w-full" /></div> : data && <>
                <section className="border-b border-line pb-5" aria-label="Spec health"><p className="text-body font-medium text-ink">{Object.entries(data.totals).filter(([, count]) => count > 0).map(([key, count]) => `${count} ${healthLabels[key as keyof Counts]}`).join(" · ") || "No Specs yet"}</p><p className="mt-1 text-meta text-ink-subtle">{data.basis}</p></section>
                <section aria-labelledby="context-coverage-title"><div className="mb-3 flex flex-wrap items-center justify-between gap-3"><h2 id="context-coverage-title" className="text-section font-semibold text-ink">Confirmed context</h2>{canEdit && data.confirmed && <Button variant="outline" size="sm" disabled={requesting} onClick={() => void findGaps()}><Search size={14} />{requesting ? "Requesting…" : "Find uncovered areas"}</Button>}</div>
                    {requested && <p className="mb-3 text-body text-ink-muted">Requested. Review suggested Specs in <Link href={`/p/${projectId}/overview`} className="underline underline-offset-2">Overview</Link>.</p>}
                    {!data.confirmed ? <EmptyState title="Confirm what your app does" description="Discovery records areas, roles and rules. Confirm that context to compare it with your Specs." action={<Button asChild variant="outline"><Link href={`/p/${projectId}`}>Review project context</Link></Button>} /> : data.areas.length === 0 ? <p className="text-body text-ink-muted">No areas, roles or rules in the confirmed context.</p> : <ul className="divide-y divide-line border-y border-line">{data.areas.map((area, index) => <li key={`${area.kind}:${index}`} className="flex flex-wrap items-start gap-3 py-3"><div className="min-w-0 flex-1"><p className="break-words text-body font-medium text-ink">{area.name}<span className="ml-2 text-meta font-normal text-ink-subtle">{area.kind}</span></p><p className="mt-1 text-meta text-ink-muted">{area.reason}</p>{area.routes.length > 0 && <p className="mt-1 break-all font-mono text-meta text-ink-subtle">{area.routes.join(" · ")}</p>}{area.specIds.length > 0 && <Link href={`/p/${projectId}/specs${area.featureIds.length === 1 ? `?feature=${area.featureIds[0]}` : ""}`} className="mt-1 inline-block text-meta text-ink-muted underline underline-offset-2">{area.specIds.length} matching Specs</Link>}</div><Badge variant={area.coverage === "covered" ? "success" : area.coverage === "partial" ? "warning" : "secondary"} size="sm">{area.coverage === "partial" ? "Partially covered" : area.coverage === "covered" ? "Covered" : "Uncovered"}</Badge>{canEdit && area.coverage !== "covered" && <Button variant="ghost" size="sm" disabled={requesting} onClick={() => void findGaps()}>Find Specs</Button>}</li>)}</ul>}
                </section>
                <section aria-labelledby="feature-health-title"><h2 id="feature-health-title" className="mb-3 text-section font-semibold text-ink">Health by feature</h2>{data.features.length === 0 ? <p className="text-body text-ink-muted">Saved features will appear here.</p> : <ul className="divide-y divide-line border-y border-line">{data.features.map((feature) => <li key={feature.id} className="flex flex-wrap items-center justify-between gap-3 py-3"><div className="min-w-0"><Link href={`/p/${projectId}/features/${feature.id}`} className="text-body font-medium text-ink hover:underline">{feature.title}</Link><p className="mt-1 text-meta text-ink-muted">{Object.entries(feature.counts).filter(([, count]) => count > 0).map(([key, count]) => `${count} ${healthLabels[key as keyof Counts]}`).join(" · ") || "No Specs"}</p></div><span className="text-meta text-ink-subtle">{feature.lastRunAt ? <RelativeTime value={feature.lastRunAt} prefix="Last run" /> : "Never run"}</span></li>)}</ul>}</section>
                <section aria-labelledby="pass-rate-title"><h2 id="pass-rate-title" className="mb-3 text-section font-semibold text-ink">Recent batch pass rate</h2>{data.trend.length === 0 ? <p className="text-body text-ink-muted">Run a batch of Specs to see the trend for {environment}.</p> : <ol className="divide-y divide-line border-y border-line">{data.trend.map((batch) => <li key={batch.id} className="grid grid-cols-[1fr_auto] items-center gap-3 py-3 sm:grid-cols-[minmax(0,1fr)_12rem_5rem]"><div className="min-w-0"><Link href={`/p/${projectId}/overview#batch:${batch.id}`} className="text-body font-medium text-ink hover:underline">{batch.label}</Link><p className="mt-1 text-meta text-ink-subtle"><RelativeTime value={batch.startedAt} /> · {batch.passed}/{batch.total} passed</p></div><div role="meter" aria-label={`${batch.label} pass rate`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={batch.passRate} className="hidden h-2 overflow-hidden rounded-full bg-surface-soft sm:block"><div className="h-full bg-success" style={{ width: `${batch.passRate}%` }} /></div><span className="text-right text-body tabular text-ink">{batch.passRate}%</span></li>)}</ol>}</section>
            </>}
        </PageContainer>
    </div>;
}
