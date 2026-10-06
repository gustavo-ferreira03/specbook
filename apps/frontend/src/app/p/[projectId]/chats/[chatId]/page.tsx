"use client";

import { useAuth } from "@/components/AuthProvider";

import { Suspense, type ReactNode, memo, use, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { AlertCircle, ArrowUp, Check, Compass, Copy, ExternalLink, LoaderCircle, MessageSquareText, Pencil, RefreshCw, RotateCcw, Settings2, Sparkles, Square, WifiOff, X } from "lucide-react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { CredentialRequestCard } from "@/components/CredentialRequestCard";
import { EmptyState } from "@/components/EmptyState";
import { LogoMark } from "@/components/LogoMark";
import { PageHeader } from "@/components/PageHeader";
import { RelativeTime } from "@/components/RelativeTime";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
    abortChatTurn,
    chatEventsUrl,
    editChatMessage,
    errorMessage,
    getChat,
    getLlmRuntimeStatus,
    getProject,
    isAbortError,
    queueChatFollowUp,
    retryChatMessage,
    sendChatMessage,
} from "@/lib/api";
import { copyText } from "@/lib/clipboard";
import { countLabel } from "@/lib/format";
import type { ChatMessage, ChatState } from "@/lib/types";
import { cn } from "@/lib/utils";
import { LiveBrowser, originOf, useWideLayout } from "./live-browser";
import { type ToolStep, TurnActivity, activeToolLabel } from "./tool-activity";

const REMARK_PLUGINS = [remarkGfm];

/** Message typography. Tokens only, so code, tables, and quotes read in both themes. */
const MARKDOWN_COMPONENTS: Components = {
    p: ({ children }) => <p className="my-3 first:mt-0 last:mb-0">{children}</p>,
    strong: ({ children }) => <strong className="font-semibold text-ink">{children}</strong>,
    em: ({ children }) => <em className="italic">{children}</em>,
    h1: ({ children }) => <h3 className="mt-5 mb-2 text-section text-ink first:mt-0">{children}</h3>,
    h2: ({ children }) => <h3 className="mt-5 mb-2 text-section text-ink first:mt-0">{children}</h3>,
    h3: ({ children }) => <h4 className="mt-4 mb-1.5 text-body font-semibold text-ink first:mt-0">{children}</h4>,
    h4: ({ children }) => <h4 className="mt-4 mb-1.5 text-body font-semibold text-ink first:mt-0">{children}</h4>,
    a: ({ children, href }) => (
        <a
            href={href}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-baseline gap-0.5 rounded-sm font-medium text-ink underline decoration-line-hover underline-offset-[3px] transition-colors hover:decoration-ink focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
            {children}
            <ExternalLink size={11} aria-hidden="true" className="translate-y-px text-ink-subtle" />
        </a>
    ),
    code: ({ children }) => (
        <code className="rounded-sm border border-line bg-surface-soft px-1 py-px font-mono text-control text-ink [overflow-wrap:anywhere]">{children}</code>
    ),
    pre: ({ children }) => (
        <pre className="my-3 overflow-x-auto rounded-lg border border-line bg-code-canvas px-3.5 py-3 font-mono text-meta leading-5 text-ink [&_code]:border-0 [&_code]:bg-transparent [&_code]:p-0 [&_code]:text-meta [&_code]:[overflow-wrap:normal]">
            {children}
        </pre>
    ),
    ul: ({ children }) => <ul className="my-3 list-disc space-y-1.5 pl-5 marker:text-ink-subtle">{children}</ul>,
    ol: ({ children }) => <ol className="my-3 list-decimal space-y-1.5 pl-5 marker:text-ink-subtle">{children}</ol>,
    li: ({ children }) => <li className="pl-1 [&>ol]:my-1.5 [&>ul]:my-1.5">{children}</li>,
    blockquote: ({ children }) => <blockquote className="my-3 border-l-2 border-line-strong pl-3.5 text-ink-muted">{children}</blockquote>,
    hr: () => <hr className="my-5 border-line" />,
    table: ({ children }) => (
        <div className="my-3 overflow-x-auto rounded-lg border border-line">
            <table className="w-full border-collapse text-control">{children}</table>
        </div>
    ),
    thead: ({ children }) => <thead className="bg-surface-soft">{children}</thead>,
    th: ({ children }) => <th className="border-b border-line px-3 py-2 text-left font-semibold text-ink">{children}</th>,
    td: ({ children }) => <td className="border-b border-line px-3 py-2 align-top [tr:last-child_&]:border-b-0">{children}</td>,
};

const MessageContent = memo(function MessageContent({ content }: { content: string }) {
    return (
        <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={MARKDOWN_COMPONENTS}>
            {content}
        </ReactMarkdown>
    );
});

function AgentAvatar() {
    return (
        <span className="flex size-7 shrink-0 items-center justify-center rounded-full border border-line bg-surface" aria-hidden="true">
            <LogoMark className="size-4 dark:invert" />
        </span>
    );
}

/** Keeps a stable function identity while always calling the latest implementation. */
function useStableCallback<Args extends unknown[], Result>(callback: (...args: Args) => Result): (...args: Args) => Result {
    const ref = useRef(callback);
    useEffect(() => {
        ref.current = callback;
    });
    return useCallback((...args: Args) => ref.current(...args), []);
}

/**
 * Holds the in-flight assistant text outside React state, so a token only re-renders the
 * streaming bubble. Deltas are coalesced into one update per animation frame.
 */
function createStreamStore() {
    let text = "";
    let pending = "";
    let frame: number | null = null;
    const listeners = new Set<() => void>();
    const emit = () => {
        for (const listener of listeners) listener();
    };
    return {
        get: () => text,
        subscribe(listener: () => void) {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
        append(delta: string) {
            pending += delta;
            if (frame !== null) return;
            frame = window.requestAnimationFrame(() => {
                frame = null;
                text += pending;
                pending = "";
                emit();
            });
        },
        reset() {
            if (frame !== null) window.cancelAnimationFrame(frame);
            frame = null;
            pending = "";
            if (!text) return;
            text = "";
            emit();
        },
    };
}

type StreamStore = ReturnType<typeof createStreamStore>;

function sameChatState(left: ChatState, right: ChatState): boolean {
    if (
        left.title !== right.title ||
        left.busy !== right.busy ||
        left.vncSessionId !== right.vncSessionId ||
        left.projectId !== right.projectId ||
        left.mode !== right.mode ||
        left.queue.steering !== right.queue.steering ||
        left.queue.followUp !== right.queue.followUp ||
        left.messages.length !== right.messages.length
    ) {
        return false;
    }
    if (JSON.stringify(left.contextRevision) !== JSON.stringify(right.contextRevision)) return false;
    if (JSON.stringify(left.credentialRequest) !== JSON.stringify(right.credentialRequest)) return false;
    if (JSON.stringify(left.toolSteps) !== JSON.stringify(right.toolSteps)) return false;
    return left.messages.every((message, index) => {
        const next = right.messages[index];
        return (
            message.id === next.id &&
            message.chatId === next.chatId &&
            message.role === next.role &&
            message.content === next.content &&
            message.createdAt === next.createdAt &&
            message.canRetry === next.canRetry
        );
    });
}

function StreamingBubble({ store, busy, onGrow }: { store: StreamStore; busy: boolean; onGrow: () => void }) {
    const text = useSyncExternalStore(store.subscribe, store.get, () => "");
    useEffect(() => {
        if (text) onGrow();
    }, [onGrow, text]);
    if (!text || !busy) return null;
    // Hidden from assistive technology: the persisted message is announced by the log once it lands.
    return (
        <article className="mt-3 flex items-start gap-3" aria-hidden="true">
            <AgentAvatar />
            <div className="min-w-0 flex-1">
                <p className="mb-1 flex h-7 items-center text-control font-semibold text-ink">Specbook</p>
                <div className="text-body leading-[1.65] text-ink break-words [overflow-wrap:anywhere]">
                    <MessageContent content={text} />
                    <span className="ml-0.5 inline-block h-4 w-0.5 animate-pulse rounded-full bg-ink align-[-3px] motion-reduce:animate-none" />
                </div>
            </div>
        </article>
    );
}

function ActionButton({
    label,
    disabled,
    children,
    onClick,
}: {
    label: string;
    disabled: boolean;
    children: ReactNode;
    onClick: () => void;
}) {
    return (
        <Tooltip>
            <TooltipTrigger asChild>
                <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    onClick={onClick}
                    disabled={disabled}
                    className="text-ink-subtle hover:text-ink"
                    aria-label={label}
                >
                    {children}
                </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={5}>{label}</TooltipContent>
        </Tooltip>
    );
}

function MessageActions({
    userMessage,
    retryable,
    disabled,
    copied,
    createdAt,
    onCopy,
    onEdit,
    onRetry,
}: {
    userMessage: boolean;
    retryable: boolean;
    disabled: boolean;
    copied: boolean;
    createdAt: string;
    onCopy: () => void;
    onEdit: () => void;
    onRetry: () => void;
}) {
    const { canEdit } = useAuth();
    // Revealed on hover and when focus enters the message; always visible on touch screens.
    return (
        <div
            className={cn(
                "relative z-10 mt-1 flex h-8 items-center gap-0.5 opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100",
                copied && "opacity-100",
                userMessage ? "flex-row-reverse" : "-ml-1.5",
            )}
        >
            <ActionButton label={copied ? "Message copied" : "Copy message"} onClick={onCopy} disabled={false}>
                {copied ? <Check size={14} /> : <Copy size={14} />}
            </ActionButton>
            {canEdit && userMessage && (
                <ActionButton label="Edit message" onClick={onEdit} disabled={disabled}>
                    <Pencil size={14} />
                </ActionButton>
            )}
            {canEdit && retryable && (
                <ActionButton label={userMessage ? "Retry message" : "Retry response"} onClick={onRetry} disabled={disabled}>
                    <RotateCcw size={14} />
                </ActionButton>
            )}
            <RelativeTime value={createdAt} className="px-1.5 text-meta text-ink-subtle" />
        </div>
    );
}

interface MessageHandlers {
    onCopy: (message: ChatMessage) => void;
    onStartEdit: (message: ChatMessage) => void;
    onCancelEdit: () => void;
    onEditTextChange: (text: string) => void;
    onSubmitEdit: (event: React.FormEvent<HTMLFormElement>) => void;
    onRetry: (messageId: string) => void;
}

const MessageItem = memo(function MessageItem({
    message,
    first,
    editing,
    editingText,
    actionBusy,
    copied,
    actionsDisabled,
    handlers,
}: {
    message: ChatMessage;
    first: boolean;
    editing: boolean;
    editingText: string;
    actionBusy: boolean;
    copied: boolean;
    actionsDisabled: boolean;
    handlers: MessageHandlers;
}) {
    const userMessage = message.role === "user";
    const spacing = first ? "" : "mt-3";
    const actions = !editing && (
        <MessageActions
            userMessage={userMessage}
            retryable={userMessage || message.canRetry !== false}
            disabled={actionsDisabled}
            copied={copied}
            createdAt={message.createdAt}
            onCopy={() => handlers.onCopy(message)}
            onEdit={() => handlers.onStartEdit(message)}
            onRetry={() => handlers.onRetry(message.id)}
        />
    );

    if (userMessage) {
        return (
            <article className={cn("group flex flex-col items-end", spacing)} aria-label="You said">
                {editing ? (
                    <form onSubmit={handlers.onSubmitEdit} className="w-full max-w-[min(100%,560px)] rounded-2xl border border-line-strong bg-surface p-2 shadow-composer">
                        <Textarea
                            value={editingText}
                            onChange={(event) => handlers.onEditTextChange(event.target.value)}
                            rows={3}
                            autoFocus
                            className="min-h-20 resize-y border-0 bg-transparent px-2 text-body shadow-none hover:border-transparent focus-visible:border-transparent focus-visible:ring-0"
                            aria-label="Edit message"
                        />
                        <div className="flex items-center justify-between gap-2 pt-1 pl-2">
                            <p className="text-meta text-ink-subtle">Saving replaces this message and asks again.</p>
                            <div className="flex shrink-0 items-center gap-1.5">
                                <Button type="button" variant="ghost" size="sm" onClick={handlers.onCancelEdit}>
                                    <X size={13} /> Cancel
                                </Button>
                                <Button type="submit" size="sm" disabled={!editingText.trim() || actionBusy}>
                                    {actionBusy ? "Saving…" : "Save and retry"}
                                </Button>
                            </div>
                        </div>
                    </form>
                ) : (
                    <div className="w-fit max-w-[min(88%,560px)] rounded-2xl rounded-br-md bg-primary-soft px-4 py-2.5 text-body leading-[1.6] text-ink break-words select-text [overflow-wrap:anywhere]">
                        <MessageContent content={message.content} />
                    </div>
                )}
                {actions}
            </article>
        );
    }

    return (
        <article className={cn("group flex items-start gap-3", spacing)} aria-label="Specbook said">
            <AgentAvatar />
            <div className="min-w-0 flex-1">
                <p className="mb-1 flex h-7 items-center text-control font-semibold text-ink">Specbook</p>
                <div className="max-w-full overflow-x-auto text-body leading-[1.65] text-ink break-words select-text [overflow-wrap:anywhere]">
                    <MessageContent content={message.content} />
                </div>
                {actions}
            </div>
        </article>
    );
});

const MessageList = memo(function MessageList({
    messages,
    steps,
    busy,
    editingMessageId,
    editingText,
    actionMessageId,
    copiedMessageId,
    actionsDisabled,
    handlers,
}: {
    messages: ChatMessage[];
    steps: ToolStep[];
    busy: boolean;
    editingMessageId: string;
    editingText: string;
    actionMessageId: string;
    copiedMessageId: string;
    actionsDisabled: boolean;
    handlers: MessageHandlers;
}) {
    const groups = new Map<string | null, ToolStep[]>();
    const messageIds = new Set(messages.map((message) => message.id));
    const pending: ToolStep[] = [];
    for (const step of steps) {
        if (step.afterMessageId !== null && !messageIds.has(step.afterMessageId)) {
            pending.push(step);
            continue;
        }
        const group = groups.get(step.afterMessageId) ?? [];
        group.push(step);
        groups.set(step.afterMessageId, group);
    }
    return (
        <div className="flex flex-col" role="log" aria-live="polite" aria-relevant="additions" aria-label="Conversation">
            <TurnActivity steps={groups.get(null) ?? []} busy={busy} />
            {messages.map((message, index) => {
                const editing = editingMessageId === message.id;
                return (
                    <div key={message.id}>
                        <MessageItem
                            message={message}
                            first={index === 0}
                            editing={editing}
                            editingText={editing ? editingText : ""}
                            actionBusy={actionMessageId === message.id}
                            copied={copiedMessageId === message.id}
                            actionsDisabled={actionsDisabled}
                            handlers={handlers}
                        />
                        <TurnActivity steps={groups.get(message.id) ?? []} busy={busy} />
                    </div>
                );
            })}
            <TurnActivity steps={pending} busy={busy} />
        </div>
    );
});

function ChatContent({ projectId, chatId }: { projectId: string; chatId: string }) {
    const { canEdit, isAdmin } = useAuth();
    const searchParams = useSearchParams();
    const specId = searchParams.get("specId");
    const repair = searchParams.get("intent") === "repair";
    const [state, setState] = useState<ChatState | null>(null);
    const [text, setText] = useState("");
    const [loadError, setLoadError] = useState("");
    const [pollError, setPollError] = useState("");
    const [sendError, setSendError] = useState("");
    const [sending, setSending] = useState(false);
    const [actionMessageId, setActionMessageId] = useState("");
    const [actionError, setActionError] = useState("");
    const [copiedMessageId, setCopiedMessageId] = useState("");
    const [editingMessageId, setEditingMessageId] = useState("");
    const [editingText, setEditingText] = useState("");
    const [streamStore] = useState(createStreamStore);
    const [eventsPaused, setEventsPaused] = useState(false);
    const [activeTool, setActiveTool] = useState("");
    const [agentStatus, setAgentStatus] = useState("");
    const [stopping, setStopping] = useState(false);
    const [beginning, setBeginning] = useState(false);
    const [beginError, setBeginError] = useState("");
    const [retryKey, setRetryKey] = useState(0);
    const [steps, setSteps] = useState<ToolStep[]>([]);
    const [modelReady, setModelReady] = useState<boolean | null>(null);
    const [projectOrigin, setProjectOrigin] = useState("");
    const wide = useWideLayout();
    const streamAnchorRef = useRef<string | null>(null);
    const scrollRef = useRef<HTMLDivElement>(null);
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const stickToBottomRef = useRef(true);

    useEffect(() => {
        setText(
            !specId
                ? ""
                : repair
                    ? `Repair the executable check for Spec ${specId}, keeping its saved steps and expected result unchanged. `
                    : `I want to change the Spec ${specId}. `,
        );
    }, [chatId, repair, specId]);

    useEffect(() => {
        let active = true;
        let loaded = false;
        let refreshController: AbortController | null = null;
        let events: EventSource | null = null;
        let reconnectTimer: number | null = null;
        let reconnectAttempt = 0;
        let hasOpened = false;
        setState(null);
        setLoadError("");
        setPollError("");
        setActionError("");
        setActionMessageId("");
        setEditingMessageId("");
        setEventsPaused(false);
        streamStore.reset();
        streamAnchorRef.current = null;
        setActiveTool("");
        setAgentStatus("");
        setSteps([]);

        async function refresh() {
            refreshController?.abort();
            const controller = new AbortController();
            refreshController = controller;
            try {
                const result = await getChat(chatId, controller.signal);
                if (!active || controller.signal.aborted) return;
                loaded = true;
                if (!result.busy) streamStore.reset();
                setState((current) => (current && sameChatState(current, result) ? current : result));
                if (!result.busy) {
                    setActiveTool("");
                    setAgentStatus("");
                    setSteps([]);
                }
                setLoadError("");
                setPollError("");
            } catch (error) {
                if (!active || isAbortError(error)) return;
                const message = errorMessage(error);
                if (loaded) setPollError(message);
                else setLoadError(message);
            }
        }

        const readEvent = (event: Event) => {
            try {
                return JSON.parse((event as MessageEvent<string>).data) as {
                    delta?: string;
                    toolName?: string;
                    status?: "working" | "retrying" | "idle";
                    message?: string | ChatMessage;
                    steering?: number;
                    followUp?: number;
                    afterMessageId?: string | null;
                    step?: ToolStep;
                    stepId?: string;
                    endedAt?: number;
                };
            } catch {
                return null;
            }
        };
        const onConnected = () => {
            reconnectAttempt = 0;
            setEventsPaused(false);
            // Events published while disconnected are gone; resync from the persisted state.
            streamStore.reset();
            setSteps([]);
            void refresh();
        };
        const onDelta = (event: Event) => {
            const data = readEvent(event);
            if (data?.delta) streamStore.append(data.delta);
        };
        const onMessageStart = (event: Event) => {
            streamAnchorRef.current = readEvent(event)?.afterMessageId ?? null;
            streamStore.reset();
        };
        const onMessageEnd = (event: Event) => {
            const data = readEvent(event);
            const message = typeof data?.message === "object" ? data.message : undefined;
            refreshController?.abort();
            if (message) {
                if (message.role === "agent" && streamAnchorRef.current === data?.afterMessageId) streamStore.reset();
                setState((current) => {
                    if (!current || current.messages.some((item) => item.id === message.id)) return current;
                    return { ...current, messages: [...current.messages, message] };
                });
            }
            void refresh();
        };
        const onToolStart = (event: Event) => {
            const data = readEvent(event);
            const toolName = data?.toolName;
            const step = data?.step;
            if (!toolName || !step) return;
            setActiveTool(toolName);
            setSteps((current) => current.some((item) => item.id === step.id) ? current : [...current, step]);
        };
        const onToolEnd = (event: Event) => {
            setActiveTool("");
            const data = readEvent(event);
            const stepId = data?.stepId;
            const endedAt = data?.endedAt;
            if (!stepId || endedAt === undefined) return;
            setSteps((current) => {
                const index = current.findIndex((step) => step.id === stepId);
                if (index === -1) return current;
                const next = current.slice();
                next[index] = { ...next[index], endedAt };
                return next;
            });
        };
        const onAgentStatus = (event: Event) => {
            const data = readEvent(event);
            if (data?.status === "retrying") setAgentStatus(typeof data.message === "string" ? data.message : "Retrying the response");
            else if (data?.status === "working") setAgentStatus("Thinking through the request");
            else setAgentStatus("");
        };
        const onQueueUpdate = (event: Event) => {
            const data = readEvent(event);
            if (typeof data?.steering !== "number" || typeof data.followUp !== "number") return;
            setState((current) => current ? { ...current, queue: { steering: data.steering!, followUp: data.followUp! } } : current);
        };

        function connect() {
            if (!active) return;
            const source = new EventSource(chatEventsUrl(chatId));
            events = source;
            source.addEventListener("connected", onConnected);
            source.addEventListener("updated", () => void refresh());
            source.addEventListener("assistant_delta", onDelta);
            source.addEventListener("message_start", onMessageStart);
            source.addEventListener("message_end", onMessageEnd);
            source.addEventListener("tool_start", onToolStart);
            source.addEventListener("tool_end", onToolEnd);
            source.addEventListener("agent_status", onAgentStatus);
            source.addEventListener("queue_update", onQueueUpdate);
            source.onopen = () => {
                setEventsPaused(false);
                // Servers without the `connected` event still need a resync after a reconnect.
                if (hasOpened) onConnected();
                hasOpened = true;
            };
            source.onerror = () => {
                if (!active) return;
                // While CONNECTING the browser retries on its own; `connected` then triggers a resync.
                setEventsPaused(true);
                if (source.readyState !== EventSource.CLOSED) return;
                // The browser gave up (e.g. the server answered with an error): retry with backoff.
                source.close();
                const delay = Math.min(1000 * 2 ** reconnectAttempt, 30_000);
                reconnectAttempt += 1;
                reconnectTimer = window.setTimeout(connect, delay);
            };
        }

        void refresh();
        connect();
        return () => {
            active = false;
            refreshController?.abort();
            if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
            events?.close();
            streamStore.reset();
        };
    }, [chatId, retryKey, streamStore]);

    useEffect(() => {
        const controller = new AbortController();
        let active = true;
        // The model status only gates the composer; a failed check leaves it enabled.
        getLlmRuntimeStatus()
            .then((status) => active && setModelReady(status.ready))
            .catch(() => active && setModelReady(null));
        getProject(projectId, controller.signal)
            .then(({ project }) => active && setProjectOrigin(originOf(project.baseUrl)))
            .catch(() => undefined);
        return () => {
            active = false;
            controller.abort();
        };
    }, [projectId]);

    const scrollToBottomIfPinned = useCallback(() => {
        const container = scrollRef.current?.querySelector<HTMLElement>("[data-slot=scroll-area-viewport]");
        if (container && stickToBottomRef.current) container.scrollTop = container.scrollHeight;
    }, []);

    useEffect(() => {
        const container = scrollRef.current?.querySelector<HTMLElement>("[data-slot=scroll-area-viewport]");
        if (container && stickToBottomRef.current) container.scrollTop = container.scrollHeight;
    }, [state?.busy, state?.messages.length, state?.vncSessionId, steps.length]);

    useEffect(() => {
        if (!state) return;
        const container = scrollRef.current?.querySelector<HTMLElement>("[data-slot=scroll-area-viewport]");
        if (!container) return;
        const handleScroll = () => {
            stickToBottomRef.current = container.scrollHeight - container.scrollTop - container.clientHeight < 80;
        };
        container.addEventListener("scroll", handleScroll, { passive: true });
        return () => container.removeEventListener("scroll", handleScroll);
    }, [state?.messages.length]);

    const discovery = state?.mode === "discovery";
    const revisionInfo = state?.contextRevision ?? null;
    const discoveryTerminal = discovery && revisionInfo ? revisionInfo.status !== "draft" : false;
    const awaitingDiscoveryStart =
        discovery && state !== null && state.messages.length === 0 && !state.busy && !discoveryTerminal;

    async function beginDiscovery() {
        if (beginning) return;
        setBeginning(true);
        setBeginError("");
        try {
            await sendChatMessage(
                chatId,
                "Begin the discovery. Follow the saved brief: explore from the start URL within the allowed origin, respect the safety notes, then propose the project context.",
            );
            stickToBottomRef.current = true;
            setState((current) => current ? { ...current, busy: true } : current);
        } catch (error) {
            setBeginError(errorMessage(error));
        } finally {
            setBeginning(false);
        }
    }

    async function sendMessage(event: React.FormEvent<HTMLFormElement>) {
        event.preventDefault();
        const value = text.trim();
        if (!value || !state || sending) return;
        const followUp = state.busy;
        setSending(true);
        setSendError("");
        setActionError("");
        setText("");
        stickToBottomRef.current = true;
        try {
            if (followUp) await queueChatFollowUp(chatId, value);
            else {
                await sendChatMessage(chatId, value);
                setState((current) => current ? { ...current, busy: true } : current);
            }
            if (followUp) {
                setState((current) => current ? { ...current, queue: { ...current.queue, followUp: current.queue.followUp + 1 } } : current);
            }
            setPollError("");
            if (textareaRef.current) textareaRef.current.style.height = "auto";
        } catch (error) {
            setSendError(errorMessage(error));
            setText(value);
        } finally {
            setSending(false);
        }
    }

    async function stopAgent() {
        if (stopping || !state?.busy) return;
        setStopping(true);
        setActionError("");
        try {
            await abortChatTurn(chatId);
            streamStore.reset();
            setActiveTool("");
            setSteps((current) => current.map((step) => (step.endedAt === null ? { ...step, endedAt: Date.now() } : step)));
        } catch (error) {
            setActionError(errorMessage(error));
        } finally {
            setStopping(false);
        }
    }

    async function copyMessage(messageId: string, content: string) {
        if (await copyText(content)) {
            setCopiedMessageId(messageId);
            window.setTimeout(() => setCopiedMessageId((current) => current === messageId ? "" : current), 1600);
        } else {
            setActionError("Could not copy this message. Select the text and copy it manually.");
        }
    }

    async function editMessage(event: React.FormEvent<HTMLFormElement>) {
        event.preventDefault();
        const value = editingText.trim();
        if (!editingMessageId || !value || state?.busy || actionMessageId) return;
        setActionMessageId(editingMessageId);
        setActionError("");
        try {
            await editChatMessage(chatId, editingMessageId, value);
            setEditingMessageId("");
            setEditingText("");
            setState((current) => current ? { ...current, busy: true } : current);
            stickToBottomRef.current = true;
        } catch (error) {
            setActionError(errorMessage(error));
        } finally {
            setActionMessageId("");
        }
    }

    async function retryMessage(messageId: string) {
        if (state?.busy || actionMessageId) return;
        setActionMessageId(messageId);
        setActionError("");
        try {
            await retryChatMessage(chatId, messageId);
            setState((current) => current ? { ...current, busy: true } : current);
            stickToBottomRef.current = true;
        } catch (error) {
            setActionError(errorMessage(error));
        } finally {
            setActionMessageId("");
        }
    }

    const handleCopy = useStableCallback((message: ChatMessage) => void copyMessage(message.id, message.content));
    const handleStartEdit = useStableCallback((message: ChatMessage) => {
        setEditingMessageId(message.id);
        setEditingText(message.content);
        setActionError("");
    });
    const handleSubmitEdit = useStableCallback((event: React.FormEvent<HTMLFormElement>) => void editMessage(event));
    const handleRetry = useStableCallback((messageId: string) => void retryMessage(messageId));
    const messageHandlers = useMemo<MessageHandlers>(() => ({
        onCopy: handleCopy,
        onStartEdit: handleStartEdit,
        onCancelEdit: () => setEditingMessageId(""),
        onEditTextChange: setEditingText,
        onSubmitEdit: handleSubmitEdit,
        onRetry: handleRetry,
    }), [handleCopy, handleRetry, handleStartEdit, handleSubmitEdit]);
    const visibleSteps = useMemo(() => {
        const merged = new Map((state?.toolSteps ?? []).map((step) => [step.id, step]));
        for (const step of steps) merged.set(step.id, step);
        return [...merged.values()];
    }, [state?.toolSteps, steps]);

    const modelMissing = modelReady === false;
    const composerDisabled = discoveryTerminal || modelMissing;
    const chatsHref = `/p/${projectId}/chats`;
    const modelSettingsHref = "/settings?tab=model";

    useEffect(() => {
        // Autosize, including text set programmatically (suggestions, the Spec prefill, a failed send).
        const textarea = textareaRef.current;
        if (!textarea) return;
        textarea.style.height = "auto";
        textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`;
    }, [text, state !== null]);

    if (loadError && !state) {
        return (
            <div className="flex min-h-full flex-col bg-surface">
                <PageHeader title="Chat" breadcrumbs={[{ label: "Chats", href: chatsHref }]} width="chat" />
                <div className="flex flex-1 items-center justify-center">
                    <EmptyState
                        role="alert"
                        tone="danger"
                        icon={AlertCircle}
                        title="Chat could not load"
                        description={loadError}
                        action={
                            <Button type="button" onClick={() => setRetryKey((key) => key + 1)}>
                                <RefreshCw size={14} /> Try again
                            </Button>
                        }
                    />
                </div>
            </div>
        );
    }

    if (!state) {
        return (
            <div className="flex h-full min-h-0 flex-col bg-surface" aria-label="Loading chat" aria-busy="true" role="status">
                <div className="shrink-0 border-b border-line px-4 pt-5 pb-4 md:px-8 md:pt-6 md:pb-5">
                    <div className="mx-auto w-full max-w-chat">
                        <Skeleton className="h-3.5 w-14" />
                        <Skeleton className="mt-3 h-6 w-2/3 max-w-md" />
                    </div>
                </div>
                <div className="min-h-0 flex-1 overflow-hidden px-4 pt-8 md:px-8">
                    <div className="mx-auto w-full max-w-chat space-y-8">
                        <Skeleton className="ml-auto h-11 w-1/2 rounded-2xl" />
                        <div className="flex gap-3">
                            <Skeleton className="size-7 shrink-0 rounded-full" />
                            <div className="flex-1 space-y-2 pt-1.5">
                                <Skeleton className="h-3.5 w-20" />
                                <Skeleton className="h-3.5 w-11/12" />
                                <Skeleton className="h-3.5 w-3/4" />
                            </div>
                        </div>
                    </div>
                </div>
                <div className="shrink-0 px-3 pb-4 md:px-8">
                    <Skeleton className="mx-auto h-[92px] w-full max-w-chat rounded-2xl" />
                </div>
            </div>
        );
    }

    const browserBeside = canEdit && wide && Boolean(state.vncSessionId);
    const browserOrigin = originOf(revisionInfo?.brief.startUrl) || projectOrigin;

    return (
        <div className="flex h-full min-h-0 flex-col bg-surface">
            <PageHeader
                title={<span className="line-clamp-1 max-sm:text-section" title={state.title}>{state.title}</span>}
                breadcrumbs={[{ label: discovery ? "Project discovery" : "Chats", href: discovery ? `/p/${projectId}` : chatsHref }]}
                width={browserBeside ? "full" : "chat"}
                className="pt-3 pb-3 md:pt-5 md:pb-4"
            />

            {discovery && revisionInfo && (
                <div className="shrink-0 border-b border-line bg-surface-soft px-4 py-2 md:px-8" role="note" aria-label="Project discovery status">
                    <div className={cn("mx-auto flex w-full flex-wrap items-center gap-x-3 gap-y-1 text-control", browserBeside ? "max-w-none" : "max-w-chat")}>
                        <span className="flex items-center gap-1.5 font-medium text-ink"><Compass size={14} className="text-ink-subtle" aria-hidden="true" /> Discovery goal</span>
                        <span className="min-w-0 flex-1 truncate text-ink-muted" title={revisionInfo.brief.goal}>{revisionInfo.brief.goal}</span>
                        {revisionInfo.hasProposal && revisionInfo.status === "draft" ? (
                            <Button asChild variant="outline" size="sm" className="shrink-0">
                                <Link href={`/p/${projectId}`}>Review project context</Link>
                            </Button>
                        ) : !revisionInfo.hasProposal ? (
                            <Link href={`/p/${projectId}`} className="shrink-0 rounded-sm text-ink-muted underline decoration-line-hover underline-offset-[3px] hover:text-ink">Project context</Link>
                        ) : null}
                    </div>
                </div>
            )}

            {eventsPaused && !pollError && (
                <Alert variant="warning" className="shrink-0 rounded-none border-x-0 border-t-0 px-4 py-2 md:px-8" role="status">
                    <div className="mx-auto flex w-full max-w-chat items-center gap-2">
                        <WifiOff size={14} className="status-pulse shrink-0" aria-hidden="true" />
                        <span className="min-w-0 flex-1 break-words">Updates paused. Reconnecting to the agent…</span>
                    </div>
                </Alert>
            )}

            {pollError && (
                <Alert variant="destructive" className="shrink-0 rounded-none border-x-0 border-t-0 px-4 py-1.5 md:px-8" role="alert">
                    <div className="mx-auto flex w-full max-w-chat items-center gap-2">
                        <AlertCircle size={14} className="shrink-0" aria-hidden="true" />
                        <span className="min-w-0 flex-1 break-words">Updates paused: {pollError}</span>
                        <Button type="button" variant="link" size="sm" onClick={() => setRetryKey((key) => key + 1)} className="shrink-0 text-danger">Retry</Button>
                    </div>
                </Alert>
            )}

            <div className="flex min-h-0 flex-1">
                <div className="flex min-w-0 flex-1 flex-col">
                    <ScrollArea ref={scrollRef} className="min-h-0 flex-1">
                        <div className="px-4 pt-6 pb-10 md:px-8 md:pt-8">
                            <div className="mx-auto w-full max-w-chat">
                                {canEdit && awaitingDiscoveryStart && revisionInfo && (
                                    <section className="pt-2 pb-8 md:pt-6" aria-labelledby="discovery-intro">
                                        <span className="flex size-10 items-center justify-center rounded-full bg-surface-hover text-ink-muted" aria-hidden="true"><Compass size={18} /></span>
                                        <h2 id="discovery-intro" className="mt-4 text-title text-ink text-balance">Ready to explore this application</h2>
                                        <p className="mt-2 max-w-[60ch] text-body text-ink-muted">
                                            The agent will browse from <span className="rounded-sm border border-line bg-surface-soft px-1 font-mono text-control text-ink [overflow-wrap:anywhere]">{revisionInfo.brief.startUrl}</span>, follow the saved goal, and draft a project context for your review.
                                        </p>
                                        {beginError && (
                                            <Alert variant="destructive" className="mt-4 max-w-md" role="alert">
                                                <AlertDescription>{beginError}</AlertDescription>
                                            </Alert>
                                        )}
                                        <div className="mt-6 flex flex-wrap items-center gap-3">
                                            <Button type="button" onClick={() => void beginDiscovery()} disabled={beginning || modelMissing}>
                                                <Compass size={14} /> {beginning ? "Starting…" : "Begin discovery"}
                                            </Button>
                                            {modelMissing && isAdmin && (
                                                <Link href={modelSettingsHref} className="rounded-sm text-control text-ink-muted underline decoration-line-hover underline-offset-[3px] hover:text-ink">Set up a model first</Link>
                                            )}
                                        </div>
                                    </section>
                                )}

                                {canEdit && !discovery && state.messages.length === 0 && !state.busy && (
                                    <section className="pt-2 pb-8 md:pt-6" aria-labelledby="chat-intro">
                                        <span className="flex size-10 items-center justify-center rounded-full border border-line bg-surface" aria-hidden="true">
                                            <LogoMark className="size-5 dark:invert" />
                                        </span>
                                        <h2 id="chat-intro" className="mt-4 text-title text-ink text-balance">What should this application do?</h2>
                                        <p className="mt-2 max-w-[60ch] text-body text-ink-muted">
                                            Describe a flow or point the agent to an area of the application. It will browse, clarify the behavior, and save the verified result as a Spec.
                                        </p>
                                        <div className="mt-6 grid gap-2 sm:grid-cols-2">
                                            {[
                                                { title: "Describe a flow", body: "State what should happen and how success is recognized.", seed: "A user should be able to ", icon: MessageSquareText },
                                                { title: "Explore a feature", body: "Let the agent inspect an area and propose useful coverage.", seed: "Explore the ", icon: Sparkles },
                                            ].map((suggestion) => (
                                                <button
                                                    key={suggestion.title}
                                                    type="button"
                                                    disabled={modelMissing}
                                                    onClick={() => {
                                                        setText(suggestion.seed);
                                                        textareaRef.current?.focus();
                                                    }}
                                                    className="group/suggestion flex items-start gap-3 rounded-xl border border-line bg-surface p-3.5 text-left transition-colors hover:border-line-strong hover:bg-surface-soft focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-surface focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50"
                                                >
                                                    <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-surface-hover text-ink-muted transition-colors group-hover/suggestion:text-ink" aria-hidden="true">
                                                        <suggestion.icon size={14} />
                                                    </span>
                                                    <span>
                                                        <span className="block text-control font-semibold text-ink">{suggestion.title}</span>
                                                        <span className="mt-0.5 block text-meta text-ink-muted">{suggestion.body}</span>
                                                    </span>
                                                </button>
                                            ))}
                                        </div>
                                    </section>
                                )}

                                <MessageList
                                    messages={state.messages}
                                    steps={visibleSteps}
                                    busy={state.busy}
                                    editingMessageId={editingMessageId}
                                    editingText={editingText}
                                    actionMessageId={actionMessageId}
                                    copiedMessageId={copiedMessageId}
                                    actionsDisabled={Boolean(state.busy || actionMessageId || discoveryTerminal || modelMissing)}
                                    handlers={messageHandlers}
                                />

                                <StreamingBubble store={streamStore} busy={state.busy} onGrow={scrollToBottomIfPinned} />

                                {state.busy && (
                                    <div
                                        className={cn(
                                            "mt-3 flex items-center gap-2.5 pl-10 text-control text-ink-muted",
                                            activeTool && state.queue.followUp === 0 && "sr-only",
                                        )}
                                        role="status"
                                    >
                                        <span className="flex gap-1" aria-hidden="true">
                                            <span className="status-pulse size-1.5 rounded-full bg-running" />
                                            <span className="status-pulse size-1.5 rounded-full bg-running [animation-delay:200ms]" />
                                            <span className="status-pulse size-1.5 rounded-full bg-running [animation-delay:400ms]" />
                                        </span>
                                        <span>
                                            {activeTool ? activeToolLabel(activeTool) : agentStatus || "Thinking through the request"}
                                            {state.queue.followUp > 0 && (
                                                <span className="text-ink-subtle"> · {countLabel(state.queue.followUp, "follow-up")} queued</span>
                                            )}
                                        </span>
                                    </div>
                                )}

                                {canEdit && state.vncSessionId && !browserBeside && (
                                    <LiveBrowser sessionId={state.vncSessionId} origin={browserOrigin} variant="inline" />
                                )}

                                {canEdit && state.credentialRequest && (
                                    <CredentialRequestCard
                                        chatId={chatId}
                                        request={state.credentialRequest}
                                        onResolved={() =>
                                            setState((prev) => (prev ? { ...prev, credentialRequest: null } : prev))
                                        }
                                    />
                                )}
                            </div>
                        </div>
                    </ScrollArea>

                    {canEdit ? <div className="relative shrink-0 bg-surface px-3 pb-[max(12px,env(safe-area-inset-bottom))] md:px-8 md:pb-5">
                        <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 -top-6 h-6 bg-linear-to-t from-surface to-transparent" />
                        <div className="mx-auto w-full max-w-chat">
                            {discoveryTerminal && revisionInfo && (
                                <Alert className="mb-2" role="status">
                                    <AlertDescription>
                                        This discovery is closed: its context was {revisionInfo.status}.{" "}
                                        <Link href={`/p/${projectId}`}>Open the project overview</Link> to see the current context.
                                    </AlertDescription>
                                </Alert>
                            )}
                            {sendError && (
                                <Alert variant="destructive" className="mb-2 flex items-start gap-2" role="alert">
                                    <AlertCircle size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
                                    <AlertDescription>{sendError}</AlertDescription>
                                </Alert>
                            )}
                            {actionError && (
                                <Alert variant="destructive" className="mb-2 flex items-start gap-2" role="alert">
                                    <AlertCircle size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
                                    <AlertDescription>{actionError}</AlertDescription>
                                </Alert>
                            )}
                            <form
                                onSubmit={sendMessage}
                                className={cn(
                                    "overflow-hidden rounded-2xl border bg-surface shadow-composer transition-colors duration-150",
                                    composerDisabled ? "border-line bg-surface-soft" : "border-line-strong focus-within:border-line-hover",
                                )}
                            >
                                {modelMissing && (
                                    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line bg-surface-soft px-4 py-2.5">
                                        <p className="flex min-w-0 flex-1 items-center gap-2 text-control text-ink-muted">
                                            <span className="size-1.5 shrink-0 rounded-full bg-warning-chart" aria-hidden="true" />
                                            <span>No model is set up yet.<span className="hidden sm:inline"> {isAdmin ? "Choose a provider to chat with the agent." : "Ask an administrator to connect a provider."}</span></span>
                                        </p>
                                        {isAdmin && <Button asChild variant="outline" size="sm">
                                            <Link href={modelSettingsHref}><Settings2 size={13} /> Set up model</Link>
                                        </Button>}
                                    </div>
                                )}
                                <Label className="block">
                                    <span className="sr-only">Message Specbook</span>
                                    <Textarea
                                        ref={textareaRef}
                                        value={text}
                                        onChange={(event) => setText(event.target.value)}
                                        onKeyDown={(event) => {
                                            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                                                event.preventDefault();
                                                event.currentTarget.form?.requestSubmit();
                                            }
                                        }}
                                        rows={1}
                                        disabled={composerDisabled}
                                        placeholder={
                                            modelMissing
                                                ? "Describe a behavior to verify…"
                                                : discoveryTerminal
                                                  ? "This discovery is closed"
                                                  : state.busy
                                                    ? "Add a follow-up for the agent…"
                                                    : discovery
                                                      ? "Guide the discovery or ask about what was found…"
                                                      : "Describe what to explore or verify…"
                                        }
                                        className="block max-h-[200px] min-h-12 resize-none rounded-none border-0 bg-transparent px-4 pt-3.5 pb-1 text-body shadow-none hover:border-transparent focus-visible:border-transparent focus-visible:ring-0 disabled:bg-transparent disabled:opacity-100"
                                    />
                                </Label>
                                <div className="flex items-center gap-2 px-2.5 pb-2.5">
                                    <p className="min-w-0 flex-1 truncate pl-1.5 text-meta text-ink-subtle">
                                        <span className={cn("hidden", !composerDisabled && "sm:inline")}>
                                            {discovery
                                                ? "Explores within the allowed origin and drafts project context. It cannot create Specs here."
                                                : state.busy
                                                  ? "Messages sent now are queued as follow-ups."
                                                  : "Enter to send · Shift+Enter for a new line"}
                                        </span>
                                    </p>
                                    {state.busy && (
                                        <Button
                                            type="button"
                                            variant="outline"
                                            size="sm"
                                            onClick={() => void stopAgent()}
                                            disabled={stopping}
                                            className="rounded-lg"
                                        >
                                            {stopping ? <LoaderCircle size={13} className="animate-spin" /> : <Square size={11} fill="currentColor" />}
                                            {stopping ? "Stopping" : "Stop"}
                                        </Button>
                                    )}
                                    <Tooltip>
                                        <TooltipTrigger asChild>
                                            <Button
                                                type="submit"
                                                disabled={!text.trim() || sending || composerDisabled}
                                                size="icon-sm"
                                                className="rounded-lg disabled:pointer-events-auto disabled:cursor-not-allowed disabled:opacity-30"
                                                aria-label={state.busy ? "Queue follow-up" : "Send message"}
                                            >
                                                {sending ? <LoaderCircle size={15} className="animate-spin" /> : <ArrowUp size={16} strokeWidth={2.2} />}
                                            </Button>
                                        </TooltipTrigger>
                                        <TooltipContent side="top">{state.busy ? "Queue follow-up" : "Send message"}</TooltipContent>
                                    </Tooltip>
                                </div>
                            </form>
                        </div>
                    </div> : <p className="border-t border-line px-4 py-3 text-control text-ink-muted">This conversation is read-only for your account.</p>}
                </div>

                {browserBeside && state.vncSessionId && (
                    <aside className="flex w-[min(46%,760px)] shrink-0 flex-col border-l border-line bg-canvas p-4" aria-label="Agent browser">
                        <LiveBrowser sessionId={state.vncSessionId} origin={browserOrigin} variant="pane" />
                    </aside>
                )}
            </div>
        </div>
    );
}

export default function ChatPage({ params }: { params: Promise<{ projectId: string; chatId: string }> }) {
    const { projectId, chatId } = use(params);
    return (
        <Suspense fallback={<span className="sr-only" role="status">Loading chat</span>}>
            <ChatContent projectId={projectId} chatId={chatId} />
        </Suspense>
    );
}
