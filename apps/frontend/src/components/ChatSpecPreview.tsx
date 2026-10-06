"use client";

import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { RunDiagnostics } from "@/components/RunDiagnostics";
import { ApiRunEvidence } from "@/components/SpecRunDialog";
import { StatusPill } from "@/components/StatusPill";
import { TechnicalDetails } from "@/components/TechnicalDetails";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { api, apiPath, API_URL, errorMessage, getRunEvidence, getSpec, isAbortError } from "@/lib/api";
import { formatDuration } from "@/lib/format";
import type { Run, RunEvidence, SpecDetail } from "@/lib/types";

export function ChatSpecPreview({ specId, runId, onClose }: { specId: string; runId?: string; onClose: () => void }) {
    const [detail, setDetail] = useState<SpecDetail | null>(null);
    const [run, setRun] = useState<Run | null>(null);
    const [evidence, setEvidence] = useState<RunEvidence | null>(null);
    const [error, setError] = useState("");
    const [evidenceError, setEvidenceError] = useState("");
    const [runError, setRunError] = useState("");
    const [retryKey, setRetryKey] = useState(0);
    const [selectedRunId, setSelectedRunId] = useState(runId);

    useEffect(() => {
        const controller = new AbortController();
        setError("");
        getSpec(specId, { signal: controller.signal })
            .then((data) => {
                setDetail(data);
                setSelectedRunId((current) => current ?? data.runs[0]?.id);
            })
            .catch((error) => { if (!isAbortError(error)) setError(errorMessage(error)); });
        return () => controller.abort();
    }, [specId, retryKey]);

    useEffect(() => {
        if (!selectedRunId) return;
        const controller = new AbortController();
        setRun(null);
        setRunError("");
        setEvidence(null);
        setEvidenceError("");
        void (async () => {
            try {
                const { run: selected } = await api<{ run: Run }>(apiPath`/runs/${selectedRunId}`, { signal: controller.signal });
                if (controller.signal.aborted) return;
                if (selected.specId !== specId) throw new Error("This run does not belong to the selected Spec.");
                setRun(selected);
            } catch (error) {
                if (!controller.signal.aborted && !isAbortError(error)) setRunError(errorMessage(error));
                return;
            }
            try {
                const evidence = await getRunEvidence(selectedRunId, controller.signal);
                if (!controller.signal.aborted) setEvidence(evidence);
            } catch (error) {
                if (!controller.signal.aborted && !isAbortError(error)) setEvidenceError(errorMessage(error));
            }
        })();
        return () => controller.abort();
    }, [specId, selectedRunId, retryKey]);

    const humanSpec = detail?.content?.humanSpec;
    const artifactUrl = (file: string) => `${API_URL}/runs/${encodeURIComponent(selectedRunId!)}/artifacts/${file.split("/").map(encodeURIComponent).join("/")}`;

    return <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-reading">
            <DialogHeader><DialogTitle>{detail?.spec.title ?? "Review Spec"}</DialogTitle><DialogDescription>Review the behavior and run evidence without leaving this conversation.</DialogDescription></DialogHeader>
            {error ? <Alert variant="danger" role="alert"><AlertDescription>{error}</AlertDescription><Button variant="outline" size="sm" onClick={() => setRetryKey((key) => key + 1)}><RefreshCw size={13} />Try again</Button></Alert> : !detail ? <Skeleton className="h-40" role="status" aria-label="Loading Spec" /> : <div className="space-y-5">
                {detail.spec.description && <p className="whitespace-pre-wrap break-words text-body text-ink-muted">{detail.spec.description}</p>}
                {humanSpec ? <div className="space-y-4">
                    {humanSpec.preconditions.length > 0 && <section><h3 className="text-body font-medium text-ink">Before the run</h3><ul className="mt-2 list-disc space-y-1 pl-5 text-body text-ink-muted">{humanSpec.preconditions.map((condition, index) => <li key={index}>{condition}</li>)}</ul></section>}
                    <section><h3 className="text-body font-medium text-ink">What this Spec does</h3><ol className="mt-2 list-decimal space-y-2 pl-5 text-body text-ink">{humanSpec.steps.map((step, index) => <li key={index}>{step}</li>)}</ol></section>
                    <section className="rounded-lg border border-line bg-surface-soft px-4 py-3"><h3 className="text-body font-medium text-ink">Expected result</h3><p className="mt-1 whitespace-pre-wrap break-words text-body text-ink">{humanSpec.expectedResult}</p></section>
                    {humanSpec.postconditions.length > 0 && <section><h3 className="text-body font-medium text-ink">After the run</h3><ul className="mt-2 list-disc space-y-1 pl-5 text-body text-ink-muted">{humanSpec.postconditions.map((condition, index) => <li key={index}>{condition}</li>)}</ul></section>}
                </div> : <p className="text-body text-ink-muted">{detail.spec.invalidReason ?? "The Spec files are incomplete."}</p>}
                {runError && <Alert variant="danger" role="alert"><AlertDescription>{runError}</AlertDescription><Button variant="outline" size="sm" onClick={() => setRetryKey((key) => key + 1)}>Retry run result</Button></Alert>}
                {selectedRunId && !run && !runError && <Skeleton className="h-20" role="status" aria-label="Loading run result" />}
                {run && <section className="space-y-3 border-t border-line pt-4">
                    <h3 className="flex flex-wrap items-center gap-2 text-body font-medium text-ink">Run result <StatusPill status={run.flaky ? "flaky" : run.status} kind="run" size="sm" />{run.durationMs !== null && <span className="text-meta font-normal text-ink-subtle">{formatDuration(run.durationMs)}</span>}</h3>
                    {evidence?.failedStep && <p className="text-body text-danger">Failed at: {evidence.failedStep}</p>}
                    {evidenceError && <Alert variant="danger" role="alert"><AlertDescription>{evidenceError}</AlertDescription><Button variant="outline" size="sm" onClick={() => setRetryKey((key) => key + 1)}>Retry evidence</Button></Alert>}
                    {!evidence && !evidenceError && <Skeleton className="h-20" role="status" aria-label="Loading run evidence" />}
                    {evidence && <>
                        {evidence.steps.map((step) => <figure key={step.number} className="space-y-2"><figcaption className="text-body font-medium text-ink">{step.number}. {step.label}</figcaption><img src={artifactUrl(step.file)} alt={`Step ${step.number}: ${step.label}`} loading="lazy" className="w-full rounded-lg border border-line bg-surface-soft" /></figure>)}
                        {evidence.video && <video controls preload="metadata" src={artifactUrl(evidence.video)} className="w-full rounded-lg border border-line bg-surface-soft" aria-label="Run recording" />}
                        <ApiRunEvidence evidence={evidence} />
                        <RunDiagnostics evidence={evidence} />
                    </>}
                </section>}
                <TechnicalDetails>
                    {run?.failReason && <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono text-meta text-ink-muted">{run.failReason}</pre>}
                    {detail.content && <><pre tabIndex={0} aria-label="Spec behavior file" className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-code-canvas p-3 font-mono text-meta text-ink-muted">{detail.content.yamlSource}</pre><pre tabIndex={0} aria-label="Spec implementation" className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-code-canvas p-3 font-mono text-meta text-ink-muted">{detail.content.testSource}</pre></>}
                </TechnicalDetails>
            </div>}
        </DialogContent>
    </Dialog>;
}
