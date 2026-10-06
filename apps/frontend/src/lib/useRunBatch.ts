"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { SpecBatchItem } from "@/components/SpecRunDialog";
import { API_URL, errorMessage, getRunBatch, isAbortError, startRunBatch } from "./api";
import { invalidate } from "./invalidation";
import type { RunBatch } from "./types";

const POLL_INTERVAL_MS = 750;
const MAX_POLL_BACKOFF_MS = 10_000;
const MAX_CONSECUTIVE_POLL_FAILURES = 6;
const MAX_BATCH_DURATION_MS = 30 * 60 * 1000;

export interface RunBatchTarget {
    id: string;
    title: string;
}

export interface RunBatchController {
    open: boolean;
    setOpen: (open: boolean) => void;
    title: string;
    items: SpecBatchItem[];
    running: boolean;
    reportUrl: string | null;
    /** Terminal problem: the run could not start or stopped being tracked. */
    error: string;
    /** Transient problem while polling; the hook keeps retrying. */
    warning: string;
    start: (title: string, targets: RunBatchTarget[]) => Promise<void>;
}

function itemsFromBatch(batch: RunBatch): SpecBatchItem[] {
    return batch.specs.map((item) => ({
        runId: item.runId,
        specId: item.specId,
        title: item.title,
        status: item.status,
        durationMs: item.durationMs,
        failReason: item.failReason,
    }));
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal.aborted) {
            reject(new DOMException("Aborted", "AbortError"));
            return;
        }
        const timer = window.setTimeout(() => {
            signal.removeEventListener("abort", onAbort);
            resolve();
        }, ms);
        function onAbort() {
            window.clearTimeout(timer);
            reject(new DOMException("Aborted", "AbortError"));
        }
        signal.addEventListener("abort", onAbort, { once: true });
    });
}

/**
 * Starts a run batch and follows it until it settles. Shared by the Sidebar, the Specs dashboard
 * and the feature page so every entry point reports start failures, survives transient polling
 * failures with backoff, stops following on unmount, and gives up after a maximum duration.
 */
export function useRunBatch(projectId: string, options: { onProgress?: (batch: RunBatch) => void } = {}): RunBatchController {
    const [open, setOpen] = useState(false);
    const [title, setTitle] = useState("Run Specs");
    const [items, setItems] = useState<SpecBatchItem[]>([]);
    const [running, setRunning] = useState(false);
    const [reportUrl, setReportUrl] = useState<string | null>(null);
    const [error, setError] = useState("");
    const [warning, setWarning] = useState("");
    const controllerRef = useRef<AbortController | null>(null);
    const onProgressRef = useRef(options.onProgress);
    useEffect(() => {
        onProgressRef.current = options.onProgress;
    });

    useEffect(() => () => controllerRef.current?.abort(), []);

    const start = useCallback(async (nextTitle: string, targets: RunBatchTarget[]) => {
        if (controllerRef.current) {
            setOpen(true);
            return;
        }
        if (targets.length === 0) return;
        const controller = new AbortController();
        controllerRef.current = controller;
        const { signal } = controller;
        setTitle(nextTitle);
        setItems(targets.map((target) => ({
            specId: target.id,
            title: target.title,
            status: "running",
            durationMs: null,
            failReason: null,
        })));
        setReportUrl(null);
        setError("");
        setWarning("");
        setRunning(true);
        setOpen(true);

        const apply = (batch: RunBatch) => {
            if (signal.aborted) return;
            setItems(itemsFromBatch(batch));
            onProgressRef.current?.(batch);
        };
        const markUnknown = () => setItems((current) => current.map((item) =>
            item.status === "running" || item.status === "queued" ? { ...item, status: "unknown" } : item,
        ));

        let started = false;
        try {
            let { batch } = await startRunBatch(projectId, targets.map((target) => target.id), nextTitle);
            started = true;
            apply(batch);
            const deadline = Date.now() + MAX_BATCH_DURATION_MS;
            let failures = 0;
            // Fetch at least once so a batch that settled immediately still gets its report link.
            for (;;) {
                if (Date.now() > deadline) {
                    markUnknown();
                    setError("Stopped waiting for results after 30 minutes. The run may still finish; check each Spec for its result.");
                    break;
                }
                if (batch.status === "running" || failures > 0) {
                    await wait(Math.min(POLL_INTERVAL_MS * 2 ** failures, MAX_POLL_BACKOFF_MS), signal);
                }
                try {
                    const result = await getRunBatch(batch.id, signal);
                    failures = 0;
                    setWarning("");
                    batch = result.batch;
                    apply(batch);
                    setReportUrl(result.reportUrl ? `${API_URL}${result.reportUrl}` : null);
                    if (batch.status !== "running") break;
                } catch (caught) {
                    if (isAbortError(caught)) throw caught;
                    failures += 1;
                    if (failures >= MAX_CONSECUTIVE_POLL_FAILURES) {
                        markUnknown();
                        setError(`Lost contact with this run: ${errorMessage(caught)} It may still finish; check each Spec for its result.`);
                        break;
                    }
                    setWarning(`Results are delayed: ${errorMessage(caught)} Retrying...`);
                }
            }
        } catch (caught) {
            if (isAbortError(caught)) return;
            if (!started) {
                setItems((current) => current.map((item) => ({ ...item, status: "skipped" })));
                setError(`The run could not start: ${errorMessage(caught)}`);
            } else {
                markUnknown();
                setError(errorMessage(caught));
            }
        } finally {
            if (controllerRef.current === controller) controllerRef.current = null;
            if (!signal.aborted) {
                setRunning(false);
                setWarning("");
            }
            invalidate({ resource: "tree", projectId });
        }
    }, [projectId]);

    return { open, setOpen, title, items, running, reportUrl, error, warning, start };
}
