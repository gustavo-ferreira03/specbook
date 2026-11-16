"use client";

import {
  AlertCircle,
  ChevronDown,
  CircleHelp,
  Clock3,
  Download,
  ExternalLink,
  HardDrive,
  Minus,
  Network,
  RefreshCw,
} from "lucide-react";
import { useEffect, useState } from "react";

import { RunDiagnostics } from "@/components/RunDiagnostics";
import { RunnerQueueNotice } from "@/components/RunnerQueueNotice";
import { RunStateAnnouncement } from "@/components/RunStateAnnouncement";
import { StatusPill } from "@/components/StatusPill";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { errorMessage, getRunEvidence, isAbortError } from "@/lib/api";
import { countLabel, evidenceStepLabel, formatDuration } from "@/lib/format";
import type { RunBatch, RunEvidence } from "@/lib/types";

export type SpecBatchStatus =
  | "queued"
  | "running"
  | "passed"
  | "failed"
  | "error"
  | "skipped"
  | "unknown";

export interface SpecBatchItem {
  runId?: string;
  specId: string;
  title: string;
  status: SpecBatchStatus;
  durationMs: number | null;
  failReason: string | null;
}

function BatchDiagnostics({ runId }: { runId: string }) {
  const [open, setOpen] = useState(false);
  const [evidence, setEvidence] = useState<RunEvidence | null>(null);
  const [error, setError] = useState("");
  const [retryKey, setRetryKey] = useState(0);

  useEffect(() => {
    if (!open) {
      return;
    }
    const controller = new AbortController();
    setError("");
    getRunEvidence(runId, controller.signal)
      .then(setEvidence)
      .catch((error) => {
        if (!isAbortError(error)) {
          setError(errorMessage(error));
        }
      });
    return () => controller.abort();
  }, [open, runId, retryKey]);

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="mt-2">
      <CollapsibleTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="group/toggle h-7 px-2"
        >
          Evidence{" "}
          <ChevronDown
            size={13}
            aria-hidden="true"
            className="transition-transform group-data-[state=open]/toggle:rotate-180 motion-reduce:transition-none"
          />
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-2">
        {error ? (
          <Alert variant="danger" role="alert" className="space-y-2">
            <AlertDescription>{error}</AlertDescription>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setRetryKey((key) => key + 1)}
            >
              <RefreshCw size={13} /> Try again
            </Button>
          </Alert>
        ) : !evidence ? (
          <Skeleton
            className="h-14 w-full"
            aria-busy="true"
            aria-label="Loading diagnostics"
            role="status"
          />
        ) : evidence.diagnostics?.length ||
          evidence.errorContext ||
          evidence.apiSteps?.length ? (
          <div className="space-y-3">
            <ApiRunEvidence evidence={evidence} />
            <RunDiagnostics evidence={evidence} />
          </div>
        ) : (
          <p className="text-meta text-ink-subtle">
            No console or network failures were recorded.
          </p>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}

export function ApiRunEvidence({ evidence }: { evidence: RunEvidence }) {
  if (!evidence.apiSteps?.length) {
    return null;
  }
  return (
    <section aria-label="API evidence" className="space-y-3">
      <h4 className="text-meta text-ink-muted font-semibold">
        API requests by step
      </h4>
      {evidence.apiSteps.map((step) => (
        <div key={step.number} className="space-y-2">
          <p className="text-control text-ink font-medium">
            <span className="text-ink-subtle">{evidenceStepLabel(step)}</span>{" "}
            {step.label}
          </p>
          {step.requests.map((request, index) => (
            <Collapsible
              key={index}
              className="group/api border-line overflow-hidden rounded-lg border"
            >
              <CollapsibleTrigger asChild>
                <button
                  type="button"
                  className="hover:bg-surface-soft focus-visible:ring-ring flex w-full min-w-0 items-start gap-2 px-3 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset"
                >
                  <span className="text-meta text-ink-muted shrink-0 font-mono font-semibold">
                    {request.method}
                  </span>
                  <span className="text-meta text-ink min-w-0 flex-1 break-all">
                    {request.url}
                  </span>
                  <span className="text-meta text-ink-muted shrink-0 font-mono">
                    {request.status ?? "No response"}
                  </span>
                  <ChevronDown
                    size={13}
                    className="text-ink-subtle mt-0.5 shrink-0 transition-transform group-data-[state=open]/api:rotate-180 motion-reduce:transition-none"
                    aria-hidden="true"
                  />
                </button>
              </CollapsibleTrigger>
              <CollapsibleContent className="border-line bg-surface-soft space-y-3 border-t px-3 py-3">
                {request.error && (
                  <p className="text-meta text-danger break-words">
                    {request.error}
                  </p>
                )}
                <div className="space-y-1">
                  <h5 className="text-meta text-ink font-medium">Request</h5>
                  <pre className="text-meta text-ink-muted max-h-48 overflow-auto font-mono break-all whitespace-pre-wrap">
                    {JSON.stringify(request.requestHeaders, null, 2)}
                    {request.requestBody ? `\n\n${request.requestBody}` : ""}
                  </pre>
                </div>
                <div className="space-y-1">
                  <h5 className="text-meta text-ink font-medium">Response</h5>
                  <pre className="text-meta text-ink-muted max-h-48 overflow-auto font-mono break-all whitespace-pre-wrap">
                    {JSON.stringify(request.responseHeaders ?? {}, null, 2)}
                    {request.responseBody ? `\n\n${request.responseBody}` : ""}
                  </pre>
                </div>
              </CollapsibleContent>
            </Collapsible>
          ))}
        </div>
      ))}
    </section>
  );
}

function BatchStatus({ status }: { status: SpecBatchStatus }) {
  if (
    status === "passed" ||
    status === "failed" ||
    status === "error" ||
    status === "running" ||
    status === "queued"
  ) {
    return <StatusPill status={status} kind="run" size="sm" />;
  }
  const Icon =
    status === "skipped" ? Minus : status === "unknown" ? CircleHelp : Clock3;
  const label =
    status === "skipped"
      ? "Skipped"
      : status === "unknown"
        ? "Unknown"
        : "Waiting to run";
  return (
    <Badge variant="neutral" size="sm" className="gap-1 pr-2.5 pl-1.5">
      <Icon size={12} strokeWidth={2.25} aria-hidden="true" /> {label}
    </Badge>
  );
}

export function SpecRunDialog({
  open,
  onOpenChange,
  title,
  items,
  running,
  reportUrl,
  error = "",
  warning = "",
  environment,
  queue,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  items: SpecBatchItem[];
  running: boolean;
  reportUrl: string | null;
  error?: string;
  warning?: string;
  environment?: RunBatch["environment"] | null;
  queue?: RunBatch["queue"] | null;
}) {
  const settled = items.filter(
    (item) => item.status !== "queued" && item.status !== "running"
  ).length;
  const passed = items.filter((item) => item.status === "passed").length;
  const failed = items.filter(
    (item) => item.status === "failed" || item.status === "error"
  ).length;
  const skipped = items.filter((item) => item.status === "skipped").length;
  const waiting =
    running &&
    items.some((item) => item.status === "queued") &&
    !items.some((item) => item.status === "running");

  const summary = [
    `${passed} passed`,
    failed ? `${failed} failed` : "",
    skipped ? `${skipped} skipped` : "",
  ]
    .filter(Boolean)
    .join(", ");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex h-[min(34rem,calc(100dvh-24px))] max-w-xl flex-col gap-0 overflow-hidden p-0 sm:p-0"
        showCloseButton={!running}
      >
        <RunStateAnnouncement
          priority={10}
          message={
            running
              ? waiting
                ? `Waiting to run. ${queue?.reason ?? ""}`
                : "Running Specs."
              : error
                ? "Results incomplete."
                : `Run completed. ${summary}.`
          }
        />
        <DialogHeader className="shrink-0 px-5 pt-5 pr-12 pb-4">
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {running
              ? `${waiting ? "Waiting to run" : "Running"} ${countLabel(items.length, "Spec")} together. You can keep this open to follow along.`
              : `${summary} across ${countLabel(items.length, "Spec")}.`}
          </DialogDescription>
          {environment && (
            <p className="text-meta text-ink-muted mt-1 break-words">
              <span className="text-ink font-medium">{environment.name}</span> ·{" "}
              {environment.baseUrl}
            </p>
          )}
          {environment?.executor === "runner" && (
            <p className="text-meta text-ink-muted mt-1 flex items-center gap-1.5">
              <HardDrive size={12} aria-hidden="true" />
              Runs on a private-network runner
              {environment.runnerGroup ? ` · ${environment.runnerGroup}` : ""}
            </p>
          )}
          {environment?.executor === "tunnel" && (
            <p className="text-meta text-ink-muted mt-1 flex items-center gap-1.5">
              <Network size={12} aria-hidden="true" />
              Runs on the server through a tunnel
              {environment.runnerGroup ? ` · ${environment.runnerGroup}` : ""}
            </p>
          )}
          <RunnerQueueNotice queue={queue} className="mt-3" />
        </DialogHeader>

        <div className="border-line bg-surface-soft shrink-0 border-y px-5 py-3">
          <div className="text-meta text-ink-muted flex items-center justify-between gap-3">
            <span className="text-ink font-medium">
              {running
                ? `${settled} of ${items.length} completed`
                : error
                  ? "Results incomplete"
                  : "Run completed"}
            </span>
            <span className="tabular">
              {passed} passed · {failed} failed
            </span>
          </div>
          <div
            className="bg-surface-selected mt-2 h-1.5 overflow-hidden rounded-full"
            role="progressbar"
            aria-label="Run progress"
            aria-valuemin={0}
            aria-valuemax={items.length}
            aria-valuenow={settled}
          >
            <div
              className="bg-primary h-full rounded-full transition-[width] duration-200 motion-reduce:transition-none"
              style={{
                width: `${items.length ? (settled / items.length) * 100 : 0}%`,
              }}
            />
          </div>
          {warning && (
            <p
              className="text-meta text-ink [&_svg]:text-warning-icon mt-2 flex items-start gap-1.5"
              role="status"
            >
              <AlertCircle
                size={13}
                className="mt-0.5 shrink-0"
                aria-hidden="true"
              />{" "}
              {warning}
            </p>
          )}
        </div>

        {error && (
          <Alert
            variant="danger"
            className="mx-5 mt-4 w-auto shrink-0"
            role="alert"
          >
            <AlertDescription className="break-words">{error}</AlertDescription>
          </Alert>
        )}

        <ScrollArea className="min-h-0 flex-1">
          <ul
            className="divide-line divide-y px-5"
            aria-label="Specs in this run"
          >
            {items.map((item) => (
              <li
                key={item.specId}
                className="flex min-w-0 items-start gap-3 py-3"
              >
                <span className="w-28 shrink-0 pt-0.5">
                  <BatchStatus status={item.status} />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-control text-ink font-medium break-words">
                    {item.title}
                  </p>
                  {item.failReason && (
                    <p className="text-meta text-danger mt-1 line-clamp-4 font-mono break-words whitespace-pre-wrap">
                      {item.failReason}
                    </p>
                  )}
                  {item.runId &&
                    ["passed", "failed", "error"].includes(item.status) && (
                      <BatchDiagnostics runId={item.runId} />
                    )}
                </div>
                {item.durationMs !== null && (
                  <span className="text-meta text-ink-subtle tabular shrink-0 pt-0.5">
                    {formatDuration(item.durationMs)}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </ScrollArea>

        <DialogFooter className="border-line shrink-0 border-t px-5 py-3">
          {reportUrl && (
            <Button asChild variant="outline">
              <a href={`${reportUrl}?download`} download>
                <Download size={13} aria-hidden="true" />
                Download report
              </a>
            </Button>
          )}
          {reportUrl && (
            <Button asChild variant="outline">
              <a href={reportUrl} target="_blank" rel="noreferrer">
                Open report <ExternalLink size={13} />
              </a>
            </Button>
          )}
          <DialogClose asChild>
            <Button type="button" disabled={running}>
              {running ? (waiting ? "Waiting to run…" : "Running…") : "Close"}
            </Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
