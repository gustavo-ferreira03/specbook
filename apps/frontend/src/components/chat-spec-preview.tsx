"use client";

import { RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";

import { RunDiagnostics } from "@/components/run-diagnostics";
import { ApiRunEvidence } from "@/components/spec-run-dialog";
import { StatusPill } from "@/components/status-pill";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import {
  api,
  apiPath,
  API_URL,
  errorMessage,
  getRunEvidence,
  getSpec,
  isAbortError,
} from "@/lib/api";
import { evidenceStepLabel, formatDuration } from "@/lib/format";
import { requiredValue } from "@/lib/required-value";
import type { Run, RunEvidence, SpecDetail } from "@/lib/types";

export const ChatSpecPreview = function ChatSpecPreview({
  specId,
  runId,
  onClose,
}: {
  specId: string;
  runId?: string;
  onClose: () => void;
}) {
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
    // oxlint-disable-next-line react/set-state-in-effect -- Reset the previous request or selection when its external key changes before loading fresh state.
    setError("");
    (async () => {
      try {
        const resolvedValue = await getSpec(specId, {
          signal: controller.signal,
        });
        const data = resolvedValue;
        setDetail(data);
        setSelectedRunId((current) => current ?? data.runs[0]?.id);
      } catch (error_) {
        if (!isAbortError(error_)) {
          setError(errorMessage(error_));
        }
      }
    })();
    return () => controller.abort();
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- This dependency intentionally triggers a retry, navigation reset, or DOM measurement without being read by the effect.
  }, [specId, retryKey]);

  useEffect(() => {
    if (!selectedRunId) {
      return;
    }
    const controller = new AbortController();
    // oxlint-disable-next-line react/set-state-in-effect -- Reset the previous request or selection when its external key changes before loading fresh state.
    setRun(null);
    setRunError("");
    setEvidence(null);
    setEvidenceError("");
    (async () => {
      try {
        const { run: selected } = await api<{ run: Run }>(
          apiPath`/runs/${selectedRunId}`,
          { signal: controller.signal }
        );
        if (controller.signal.aborted) {
          return;
        }
        if (selected.specId !== specId) {
          // oxlint-disable-next-line react/todo -- Oxlint React Compiler cannot analyze this supported JavaScript syntax; preserve its cleanup and error behavior.
          throw new Error("This run does not belong to the selected Spec.");
        }
        setRun(selected);
      } catch (error_) {
        if (!controller.signal.aborted && !isAbortError(error_)) {
          setRunError(errorMessage(error_));
        }
        return;
      }
      try {
        const evidenceValue = await getRunEvidence(
          selectedRunId,
          controller.signal
        );
        if (!controller.signal.aborted) {
          setEvidence(evidenceValue);
        }
      } catch (error_) {
        if (!controller.signal.aborted && !isAbortError(error_)) {
          setEvidenceError(errorMessage(error_));
        }
      }
    })();
    return () => controller.abort();
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- This dependency intentionally triggers a retry, navigation reset, or DOM measurement without being read by the effect.
  }, [specId, selectedRunId, retryKey]);

  const humanSpec = detail?.content?.humanSpec;
  const artifactUrl = (file: string) =>
    `${API_URL}/runs/${encodeURIComponent(requiredValue(selectedRunId))}/artifacts/${file.split("/").map(encodeURIComponent).join("/")}`;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
    >
      <DialogContent className="sm:max-w-reading max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{detail?.spec.title ?? "Review Spec"}</DialogTitle>
          <DialogDescription>
            Review the behavior and run evidence without leaving this
            conversation.
          </DialogDescription>
        </DialogHeader>
        {
          /* oxlint-disable eslint/complexity -- Keep the existing render states and their coordinated actions together during the lint migration. */
          (() => {
            if (error) {
              return (
                <Alert variant="danger" role="alert">
                  <AlertDescription>{error}</AlertDescription>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setRetryKey((key) => key + 1)}
                  >
                    <RefreshCw size={13} />
                    Try again
                  </Button>
                </Alert>
              );
            }
            if (detail) {
              return (
                <div className="space-y-5">
                  {detail.spec.description && (
                    <p className="text-body text-ink-muted break-words whitespace-pre-wrap">
                      {detail.spec.description}
                    </p>
                  )}
                  {humanSpec ? (
                    <div className="space-y-4">
                      {humanSpec.preconditions.length > 0 && (
                        <section>
                          <h3 className="text-body text-ink font-medium">
                            Before the run
                          </h3>
                          <ul className="text-body text-ink-muted mt-2 list-disc space-y-1 pl-5">
                            {humanSpec.preconditions.map((condition, index) => (
                              <li key={index}>{condition}</li>
                            ))}
                          </ul>
                        </section>
                      )}
                      <section>
                        <h3 className="text-body text-ink font-medium">
                          What this Spec does
                        </h3>
                        <ol className="text-body text-ink mt-2 list-decimal space-y-2 pl-5">
                          {humanSpec.steps.map((step, index) => (
                            <li key={index}>{step}</li>
                          ))}
                        </ol>
                      </section>
                      <section className="border-line bg-surface-soft rounded-lg border px-4 py-3">
                        <h3 className="text-body text-ink font-medium">
                          Expected result
                        </h3>
                        <p className="text-body text-ink mt-1 break-words whitespace-pre-wrap">
                          {humanSpec.expectedResult}
                        </p>
                      </section>
                      {humanSpec.postconditions.length > 0 && (
                        <section>
                          <h3 className="text-body text-ink font-medium">
                            After the run
                          </h3>
                          <ul className="text-body text-ink-muted mt-2 list-disc space-y-1 pl-5">
                            {humanSpec.postconditions.map(
                              (condition, index) => (
                                <li key={index}>{condition}</li>
                              )
                            )}
                          </ul>
                        </section>
                      )}
                    </div>
                  ) : (
                    <p className="text-body text-ink-muted">
                      {detail.spec.invalidReason ??
                        "The Spec files are incomplete."}
                    </p>
                  )}
                  {runError && (
                    <Alert variant="danger" role="alert">
                      <AlertDescription>{runError}</AlertDescription>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setRetryKey((key) => key + 1)}
                      >
                        Retry run result
                      </Button>
                    </Alert>
                  )}
                  {selectedRunId && !run && !runError && (
                    /* oxlint-disable jsx-a11y/prefer-tag-over-role -- Alert forwards live-region semantics to its shared native wrapper; preserve the component structure. */
                    <Skeleton
                      className="h-20"
                      role="status"
                      aria-label="Loading run result"
                    />
                    /* oxlint-enable jsx-a11y/prefer-tag-over-role */
                  )}
                  {run && (
                    <section className="border-line space-y-3 border-t pt-4">
                      <h3 className="text-body text-ink flex flex-wrap items-center gap-2 font-medium">
                        Run result{" "}
                        <StatusPill
                          status={run.flaky ? "flaky" : run.status}
                          kind="run"
                          size="sm"
                        />
                        {run.durationMs !== null && (
                          <span className="text-meta text-ink-subtle font-normal">
                            {formatDuration(run.durationMs)}
                          </span>
                        )}
                      </h3>
                      {evidence?.failedStep && (
                        <p className="text-body text-danger">
                          Failed at: {evidence.failedStep}
                        </p>
                      )}
                      {evidenceError && (
                        <Alert variant="danger" role="alert">
                          <AlertDescription>{evidenceError}</AlertDescription>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => setRetryKey((key) => key + 1)}
                          >
                            Retry evidence
                          </Button>
                        </Alert>
                      )}
                      {!evidence && !evidenceError && (
                        /* oxlint-disable jsx-a11y/prefer-tag-over-role -- Alert forwards live-region semantics to its shared native wrapper; preserve the component structure. */
                        <Skeleton
                          className="h-20"
                          role="status"
                          aria-label="Loading run evidence"
                        />
                        /* oxlint-enable jsx-a11y/prefer-tag-over-role */
                      )}
                      {evidence && (
                        <>
                          {evidence.steps.map((step) => (
                            <figure key={step.number} className="space-y-2">
                              <figcaption className="text-body text-ink font-medium">
                                <span className="text-ink-subtle">
                                  {evidenceStepLabel(step)}
                                </span>{" "}
                                {step.label}
                              </figcaption>
                              {/* oxlint-disable next/no-img-element -- Evidence URLs and CSS-sized SVG icons must load directly without an image optimization proxy. */}
                              <img
                                src={artifactUrl(step.file)}
                                alt={`${evidenceStepLabel(step)}: ${step.label}`}
                                loading="lazy"
                                className="border-line bg-surface-soft w-full rounded-lg border"
                              />
                              {/* oxlint-enable next/no-img-element */}
                            </figure>
                          ))}
                          {evidence.video && (
                            /* oxlint-disable jsx-a11y/media-has-caption -- This muted browser recording contains visual test evidence without a speech track. */
                            <video
                              controls
                              preload="metadata"
                              src={artifactUrl(evidence.video)}
                              className="border-line bg-surface-soft w-full rounded-lg border"
                              aria-label="Run recording"
                            />
                            /* oxlint-enable jsx-a11y/media-has-caption */
                          )}
                          <ApiRunEvidence evidence={evidence} />
                          <RunDiagnostics evidence={evidence} />
                        </>
                      )}
                    </section>
                  )}
                </div>
              );
            }
            return (
              /* oxlint-disable jsx-a11y/prefer-tag-over-role -- Alert forwards live-region semantics to its shared native wrapper; preserve the component structure. */
              <Skeleton
                className="h-40"
                role="status"
                aria-label="Loading Spec"
              />
              /* oxlint-enable jsx-a11y/prefer-tag-over-role */
            );
          })()
          /* oxlint-enable eslint/complexity */
        }
      </DialogContent>
    </Dialog>
  );
};
