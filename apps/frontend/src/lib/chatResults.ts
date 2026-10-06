"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, apiPath, errorMessage, isAbortError } from "./api";
import { onInvalidate } from "./invalidation";
import type { ChatCredentialRequest, PresentedInboxItem, ProjectContextRevision, RunStatus, SpecStatus } from "./types";
import { useVisiblePolling } from "./usePolling";

interface Placement { afterMessageId?: string | null }

export interface ChatResults {
    items: (PresentedInboxItem & Placement)[];
    tasks: (Placement & { id: string; kind: string; title: string; status: "queued" | "working" | "needs_answer" | "paused" | "completed" | "failed" | "stopped"; summary: string; batchId?: string; createdAt: string; updatedAt: string })[];
    notes: (Placement & { id: string; title: string; body: string; createdAt: string; updatedAt: string })[];
    runs: (Placement & { id: string; specId: string; title: string; status: RunStatus; durationMs: number | null; failReason: string | null; flaky: boolean; startedAt: string; batchId?: string; evidenceUrl: string })[];
    specs: (Placement & { id: string; title: string; status: SpecStatus; toolName: string; createdAt: string })[];
    credentialRequests: (Placement & { chatId: string; request: ChatCredentialRequest })[];
    contextRevision: ProjectContextRevision | null;
}

export function useChatResults(chatId: string, projectId: string) {
    const [state, setState] = useState<{ chatId: string; data: ChatResults | null; error: string }>({ chatId, data: null, error: "" });
    const request = useRef<AbortController | null>(null);

    const reload = useCallback(async () => {
        request.current?.abort();
        const controller = new AbortController();
        request.current = controller;
        try {
            const data = await api<ChatResults>(apiPath`/chats/${chatId}/results`, { signal: controller.signal });
            if (controller.signal.aborted) return;
            setState((previous) => previous.chatId === chatId && !previous.error && JSON.stringify(previous.data) === JSON.stringify(data) ? previous : { chatId, data, error: "" });
        } catch (error) {
            if (!controller.signal.aborted && !isAbortError(error)) setState((previous) => ({ chatId, data: previous.chatId === chatId ? previous.data : null, error: errorMessage(error) }));
        }
    }, [chatId]);

    useEffect(() => {
        void reload();
        return () => request.current?.abort();
    }, [reload]);
    useVisiblePolling(() => void reload(), 5000);
    useEffect(() => onInvalidate((event) => {
        if (!event.projectId || event.projectId === projectId) void reload();
    }), [projectId, reload]);

    const current = state.chatId === chatId;
    return { data: current ? state.data : null, error: current ? state.error : "", reload };
}
