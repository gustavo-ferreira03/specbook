"use client";

import { Suspense, type ReactNode, use, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { AlertCircle, ArrowUp, Check, Compass, Copy, ExternalLink, LoaderCircle, Monitor, Pencil, RefreshCw, RotateCcw, Square, X } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { CredentialRequestCard } from "@/components/CredentialRequestCard";
import { LogoMark } from "@/components/LogoMark";
import { PageHeader } from "@/components/PageHeader";
import { VncViewer } from "@/components/VncViewer";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { API_URL, abortChatTurn, api, editChatMessage, queueChatFollowUp, retryChatMessage } from "@/lib/api";
import type { ChatState } from "@/lib/types";

function MessageContent({ content, user }: { content: string; user: boolean }) {
    return (
        <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
                p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
                strong: ({ children }) => <strong className="font-bold">{children}</strong>,
                a: ({ children, href }) => (
                    <a href={href} target="_blank" rel="noreferrer" className={`inline-flex items-center gap-1 font-semibold underline underline-offset-2 ${user ? "message-link-user" : ""}`}>
                        {children}<ExternalLink size={11} />
                    </a>
                ),
                code: ({ children }) => (
                    <code className={`rounded-sm px-1 py-0.5 font-mono text-[0.92em] ${user ? "bg-white/15" : "bg-primary-soft"}`}>
                        {children}
                    </code>
                ),
                pre: ({ children }) => <pre className="my-3 overflow-x-auto rounded-lg bg-primary p-3 font-mono text-xs leading-5 text-white">{children}</pre>,
                ul: ({ children }) => <ul className="my-2 list-disc space-y-1 pl-5">{children}</ul>,
                ol: ({ children }) => <ol className="my-2 list-decimal space-y-1 pl-5">{children}</ol>,
                table: ({ children }) => <table className="my-3 w-full border-collapse text-xs">{children}</table>,
                th: ({ children }) => <th className="border-b border-current/20 px-2 py-1.5 text-left font-bold">{children}</th>,
                td: ({ children }) => <td className="border-b border-current/10 px-2 py-1.5 align-top">{children}</td>,
            }}
        >
            {content}
        </ReactMarkdown>
    );
}

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

function LiveBrowserCard({ sessionId }: { sessionId: string }) {
    return (
        <article className="my-5 overflow-hidden rounded-[13px] border border-line bg-surface md:ml-[38px]" aria-label="Live browser session">
            <div className="flex min-h-[43px] items-center justify-between gap-3 border-b border-line bg-surface-soft px-3.5">
                <div className="min-w-0">
                    <p className="flex items-center gap-2 text-xs font-bold"><Monitor size={14} className="text-ink-faint" /> Live browser</p>
                    <p className="mt-0.5 truncate text-[0.625rem] text-ink-faint">The agent is inspecting the application</p>
                </div>
            </div>
            <div className="h-[220px] w-full bg-browser sm:h-[280px]">
                <VncViewer vncSessionId={sessionId} />
            </div>
        </article>
    );
}

function readableToolName(toolName: string): string {
    return toolName
        .replace(/^browser_/, "")
        .replace(/[_-]+/g, " ")
        .replace(/\b\w/g, (character) => character.toUpperCase());
}

function MessageActions({
    userMessage,
    retryable,
    disabled,
    copied,
    onCopy,
    onEdit,
    onRetry,
}: {
    userMessage: boolean;
    retryable: boolean;
    disabled: boolean;
    copied: boolean;
    onCopy: () => void;
    onEdit: () => void;
    onRetry: () => void;
}) {
    const tone = userMessage
        ? "bg-transparent text-white/65 hover:text-white focus-visible:bg-white/15"
        : "bg-transparent text-ink-faint hover:text-ink focus-visible:bg-surface-hover";
    function ActionButton({
        label,
        children,
        onClick,
    }: {
        label: string;
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
                        className={`size-7 rounded-md ${tone}`}
                        aria-label={label}
                    >
                        {children}
                    </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom" sideOffset={5}>{label}</TooltipContent>
            </Tooltip>
        );
    }
    return (
        <div className={`relative z-10 mt-1 flex min-h-8 items-center gap-0.5 ${userMessage ? "justify-end" : "justify-start"}`}>
            <ActionButton label={copied ? "Message copied" : "Copy message"} onClick={onCopy}>
                {copied ? <Check size={13} /> : <Copy size={13} />}
            </ActionButton>
            {userMessage && (
                <>
                    <ActionButton label="Edit message" onClick={onEdit}>
                        <Pencil size={13} />
                    </ActionButton>
                </>
            )}
            {retryable && (
                <ActionButton label={userMessage ? "Retry message" : "Retry response"} onClick={onRetry}>
                    <RotateCcw size={13} />
                </ActionButton>
            )}
        </div>
    );
}

function ChatContent({ projectId, chatId }: { projectId: string; chatId: string }) {
    const searchParams = useSearchParams();
    const specId = searchParams.get("specId");
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
    const [streamingText, setStreamingText] = useState("");
    const [activeTool, setActiveTool] = useState("");
    const [agentStatus, setAgentStatus] = useState("");
    const [stopping, setStopping] = useState(false);
    const [beginning, setBeginning] = useState(false);
    const [beginError, setBeginError] = useState("");
    const [retryKey, setRetryKey] = useState(0);
    const scrollRef = useRef<HTMLDivElement>(null);
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const stickToBottomRef = useRef(true);

    useEffect(() => {
        setText(specId ? `I want to change the Spec ${specId}. ` : "");
    }, [chatId, specId]);

    useEffect(() => {
        let active = true;
        let loaded = false;
        setState(null);
        setLoadError("");
        setPollError("");
        setActionError("");
        setActionMessageId("");
        setEditingMessageId("");
        setStreamingText("");
        setActiveTool("");
        setAgentStatus("");

        async function refresh() {
            try {
                const result = await api<ChatState>(`/chats/${chatId}`);
                if (!active) return;
                loaded = true;
                setState((current) => (current && sameChatState(current, result) ? current : result));
                if (!result.busy) {
                    setStreamingText("");
                    setActiveTool("");
                    setAgentStatus("");
                }
                setLoadError("");
                setPollError("");
            } catch (error) {
                if (!active) return;
                const message = error instanceof Error ? error.message : String(error);
                if (loaded) setPollError(message);
                else setLoadError(message);
            }
        }

        void refresh();
        const events = new EventSource(`${API_URL}/chats/${encodeURIComponent(chatId)}/events`);
        events.addEventListener("updated", () => void refresh());
        const readEvent = (event: Event) => {
            try {
                return JSON.parse((event as MessageEvent<string>).data) as {
                    delta?: string;
                    toolName?: string;
                    status?: "working" | "retrying" | "idle";
                    message?: string;
                    steering?: number;
                    followUp?: number;
                };
            } catch {
                return null;
            }
        };
        const onDelta = (event: Event) => {
            const data = readEvent(event);
            if (data?.delta) setStreamingText((current) => current + data.delta);
        };
        const onToolStart = (event: Event) => {
            const data = readEvent(event);
            if (data?.toolName) setActiveTool(data.toolName);
        };
        const onToolEnd = () => setActiveTool("");
        const onAgentStatus = (event: Event) => {
            const data = readEvent(event);
            if (data?.status === "retrying") setAgentStatus(data.message || "Retrying the response");
            else if (data?.status === "working") setAgentStatus("Thinking through the request");
            else setAgentStatus("");
        };
        const onQueueUpdate = (event: Event) => {
            const data = readEvent(event);
            if (typeof data?.steering !== "number" || typeof data.followUp !== "number") return;
            setState((current) => current ? { ...current, queue: { steering: data.steering!, followUp: data.followUp! } } : current);
        };
        events.addEventListener("assistant_delta", onDelta);
        events.addEventListener("tool_start", onToolStart);
        events.addEventListener("tool_end", onToolEnd);
        events.addEventListener("agent_status", onAgentStatus);
        events.addEventListener("queue_update", onQueueUpdate);
        return () => {
            active = false;
            events.close();
        };
    }, [chatId, retryKey]);

    useEffect(() => {
        const container = scrollRef.current?.querySelector<HTMLElement>("[data-slot=scroll-area-viewport]");
        if (container && stickToBottomRef.current) container.scrollTop = container.scrollHeight;
    }, [state?.busy, state?.messages.length, state?.vncSessionId]);

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
            await api<{ ok: true }>(`/chats/${chatId}/message`, {
                method: "POST",
                body: JSON.stringify({
                    text: "Begin the discovery. Follow the saved brief: explore from the start URL within the allowed origin, respect the safety notes, then propose the project context.",
                }),
            });
            stickToBottomRef.current = true;
            setState((current) => current ? { ...current, busy: true } : current);
        } catch (error) {
            setBeginError(error instanceof Error ? error.message : String(error));
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
                await api<{ ok: true }>(`/chats/${chatId}/message`, {
                    method: "POST",
                    body: JSON.stringify({ text: value }),
                });
                setState((current) => current ? { ...current, busy: true } : current);
            }
            if (followUp) {
                setState((current) => current ? { ...current, queue: { ...current.queue, followUp: current.queue.followUp + 1 } } : current);
            }
            setPollError("");
            if (textareaRef.current) textareaRef.current.style.height = "auto";
        } catch (error) {
            setSendError(error instanceof Error ? error.message : String(error));
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
            setStreamingText("");
            setActiveTool("");
        } catch (error) {
            setActionError(error instanceof Error ? error.message : String(error));
        } finally {
            setStopping(false);
        }
    }

    async function copyMessage(messageId: string, content: string) {
        try {
            await navigator.clipboard.writeText(content);
            setCopiedMessageId(messageId);
            window.setTimeout(() => setCopiedMessageId((current) => current === messageId ? "" : current), 1600);
        } catch {
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
            setActionError(error instanceof Error ? error.message : String(error));
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
            setActionError(error instanceof Error ? error.message : String(error));
        } finally {
            setActionMessageId("");
        }
    }

    if (loadError && !state) {
        return (
            <div className="flex min-h-full flex-col bg-surface">
                <PageHeader title="Chat" eyebrow="Chats" />
                <div className="flex flex-1 items-center justify-center px-5 py-12">
                    <Alert variant="destructive" className="w-full max-w-sm bg-transparent p-0 text-center" role="alert">
                        <span className="mx-auto flex size-9 items-center justify-center rounded-lg bg-danger-soft text-danger"><AlertCircle size={18} /></span>
                        <h2 className="mt-4 text-sm font-bold text-ink">Chat could not load</h2>
                        <AlertDescription className="mt-2 text-xs leading-5">{loadError}</AlertDescription>
                        <Button type="button" onClick={() => setRetryKey((key) => key + 1)} className="mt-5">
                            <RefreshCw size={14} /> Try again
                        </Button>
                    </Alert>
                </div>
            </div>
        );
    }

    if (!state) {
        return (
            <div className="flex h-full min-h-0 flex-col bg-surface" aria-label="Loading chat" aria-busy="true" role="status">
                <div className="relative h-16 shrink-0 md:h-[72px]"><Separator className="absolute inset-x-0 bottom-0" /></div>
                <div className="min-h-0 flex-1 overflow-hidden px-5 py-7">
                    <div className="mx-auto w-full max-w-[780px] space-y-4">
                        <Skeleton className="h-14 w-3/4 rounded-[13px] bg-surface-soft" />
                        <Skeleton className="ml-auto h-16 w-3/5 rounded-[13px]" />
                        <Skeleton className="h-24 w-4/5 rounded-[13px] bg-surface-soft" />
                    </div>
                </div>
                <div className="relative h-24 shrink-0"><Separator className="absolute inset-x-0 top-0" /></div>
            </div>
        );
    }

    return (
        <div className="flex h-full min-h-0 flex-col bg-surface">
            <PageHeader
                title={state.title}
                eyebrow="Chat"
                actions={
                    <Badge variant="outline" className="gap-1.5 px-2.5 py-1.5 text-[0.65625rem]">
                        <span className={`size-1.5 rounded-full ${state.busy ? "status-pulse bg-pending" : "bg-success"}`} />
                        {state.busy ? "Agent working" : "Ready"}
                    </Badge>
                }
            />

            {discovery && revisionInfo && (
                <div className="shrink-0 border-b border-line bg-surface-soft px-4 py-2" role="note" aria-label="Project discovery status">
                    <div className="mx-auto flex max-w-[780px] flex-wrap items-center gap-x-3 gap-y-1 text-[0.6875rem]">
                        <span className="flex items-center gap-1.5 font-bold"><Compass size={13} className="text-ink-faint" /> Project discovery</span>
                        <span className="min-w-0 flex-1 truncate text-ink-soft" title={revisionInfo.brief.goal}>{revisionInfo.brief.goal}</span>
                        {revisionInfo.hasProposal && revisionInfo.status === "draft" && (
                            <Link href={`/p/${projectId}`} className="shrink-0 font-bold underline underline-offset-2">Review project context</Link>
                        )}
                        {!revisionInfo.hasProposal && (
                            <Link href={`/p/${projectId}`} className="shrink-0 text-ink-faint underline underline-offset-2">Project overview</Link>
                        )}
                    </div>
                </div>
            )}

            {pollError && (
                <Alert variant="destructive" className="shrink-0 rounded-none border-b border-danger/15 px-4 py-2 text-xs" role="alert">
                    <div className="mx-auto flex max-w-[780px] items-center gap-2">
                        <AlertCircle size={13} className="shrink-0" />
                        <span className="min-w-0 flex-1 break-words">Updates paused: {pollError}</span>
                        <Button type="button" variant="link" size="sm" onClick={() => setRetryKey((key) => key + 1)} className="h-auto min-h-9 shrink-0 px-0 text-danger">Retry</Button>
                    </div>
                </Alert>
            )}

            <ScrollArea ref={scrollRef} role="log" aria-live="polite" className="min-h-0 flex-1">
                <div className="px-4 py-6 sm:px-7 sm:py-9">
                    <div className="mx-auto w-full max-w-[780px]">
                        {awaitingDiscoveryStart && revisionInfo && (
                            <div className="border-b border-line pb-7 pt-3 sm:pb-10 sm:pt-5">
                                <p className="text-[0.625rem] font-bold tracking-[0.08em] text-ink-faint uppercase">Project discovery</p>
                                <h2 className="mt-2 max-w-[24ch] text-2xl font-bold tracking-[-0.03em] text-balance">Ready to explore this application</h2>
                                <p className="mt-3 max-w-[58ch] text-[0.75rem] leading-5 text-ink-soft">
                                    The agent will browse from <span className="font-mono text-[0.6875rem] [overflow-wrap:anywhere]">{revisionInfo.brief.startUrl}</span>, following the saved goal, and draft a project context for your review.
                                </p>
                                {beginError && (
                                    <Alert variant="destructive" className="mt-4 max-w-md text-xs" role="alert">
                                        <AlertDescription>{beginError}</AlertDescription>
                                    </Alert>
                                )}
                                <Button type="button" onClick={() => void beginDiscovery()} disabled={beginning} className="mt-6">
                                    <Compass size={14} /> {beginning ? "Starting..." : "Begin discovery"}
                                </Button>
                            </div>
                        )}

                        {!discovery && state.messages.length === 0 && !state.busy && (
                            <div className="border-b border-line pb-7 pt-3 sm:pb-10 sm:pt-5">
                                <p className="text-[0.625rem] font-bold tracking-[0.08em] text-ink-faint uppercase">New chat</p>
                                <h2 className="mt-2 max-w-[24ch] text-2xl font-bold tracking-[-0.03em] text-balance">What should this application do?</h2>
                                <p className="mt-3 max-w-[58ch] text-[0.75rem] leading-5 text-ink-soft">
                                    Describe a flow or point the agent to an area of the application. It will browse, clarify the behavior, and save the verified result as a Spec.
                                </p>
                                <div className="mt-7 grid gap-2 sm:grid-cols-2">
                                    <Button type="button" variant="outline" onClick={() => setText("A user should be able to ")} className="h-auto min-h-20 flex-col items-stretch justify-start gap-0 whitespace-normal rounded-[11px] border-line bg-transparent p-3.5 text-left font-normal hover:border-line-strong hover:bg-surface-soft">
                                        <span className="block text-xs font-bold">Describe a flow</span>
                                        <span className="mt-1 block text-[0.6875rem] leading-5 text-ink-faint">State what should happen and how success is recognized.</span>
                                    </Button>
                                    <Button type="button" variant="outline" onClick={() => setText("Explore the ")} className="h-auto min-h-20 flex-col items-stretch justify-start gap-0 whitespace-normal rounded-[11px] border-line bg-transparent p-3.5 text-left font-normal hover:border-line-strong hover:bg-surface-soft">
                                        <span className="block text-xs font-bold">Explore a feature</span>
                                        <span className="mt-1 block text-[0.6875rem] leading-5 text-ink-faint">Let the agent inspect an area and propose useful coverage.</span>
                                    </Button>
                                </div>
                            </div>
                        )}

                        <div className="flex flex-col gap-2 pt-2 sm:gap-3 sm:pt-4">
                            {state.messages.map((message) => {
                                const userMessage = message.role === "user";
                                const editing = editingMessageId === message.id;
                                const actionBusy = actionMessageId === message.id;
                                return (
                                    <article key={message.id} className={`group flex items-start gap-2.5 ${userMessage ? "justify-end" : ""}`}>
                                        {!userMessage && (
                                            <LogoMark inverse className="mt-1 size-6 shrink-0 rounded-md" />
                                        )}
                                        <div className={`flex min-w-0 max-w-[min(100%,680px)] flex-col ${userMessage ? "items-end" : "items-start"}`}>
                                            <div className={`w-fit max-w-full overflow-x-auto rounded-[13px] px-3.5 py-2.5 text-[0.75rem] leading-[1.65] break-words select-text [overflow-wrap:anywhere] sm:px-4 sm:py-3 ${
                                                userMessage ? "chat-message-user rounded-br-sm bg-primary text-primary-foreground" : "rounded-bl-sm border border-line bg-surface-soft text-ink"
                                            }`}>
                                                <p className={`mb-1.5 text-[0.5625rem] font-bold tracking-[0.05em] uppercase ${userMessage ? "text-white/60" : "text-ink-faint"}`}>
                                                    {userMessage ? "You" : "Specbook agent"}
                                                </p>
                                                {editing ? (
                                                    <form onSubmit={editMessage} className="min-w-[min(100%,420px)]">
                                                        <Textarea
                                                            value={editingText}
                                                            onChange={(event) => setEditingText(event.target.value)}
                                                            rows={3}
                                                            autoFocus
                                                            className="min-h-20 resize-y border-white/25 bg-white/10 text-xs leading-5 text-white placeholder:text-white/55 focus-visible:border-white/45 focus-visible:ring-white/25"
                                                            aria-label="Edit message"
                                                        />
                                                        <div className="mt-2 flex items-center justify-end gap-1.5">
                                                            <Button type="button" variant="ghost" size="sm" onClick={() => setEditingMessageId("")} className="text-white/75 hover:bg-white/15 hover:text-white">
                                                                <X size={12} /> Cancel
                                                            </Button>
                                                            <Button type="submit" size="sm" disabled={!editingText.trim() || actionBusy} className="bg-white text-primary hover:bg-white/90">
                                                                {actionBusy ? "Saving..." : "Save and retry"}
                                                            </Button>
                                                        </div>
                                                    </form>
                                                ) : (
                                                    <MessageContent content={message.content} user={userMessage} />
                                                )}
                                            </div>
                                            {!editing && (
                                                 <MessageActions
                                                     userMessage={userMessage}
                                                     retryable={userMessage || message.canRetry !== false}
                                                     disabled={Boolean(state.busy || actionMessageId || discoveryTerminal)}
                                                    copied={copiedMessageId === message.id}
                                                    onCopy={() => void copyMessage(message.id, message.content)}
                                                    onEdit={() => {
                                                        setEditingMessageId(message.id);
                                                        setEditingText(message.content);
                                                        setActionError("");
                                                    }}
                                                    onRetry={() => void retryMessage(message.id)}
                                                />
                                            )}
                                        </div>
                                    </article>
                                );
                            })}
                        </div>

                        {streamingText && state.busy && (
                            <article className="mt-2 flex items-start gap-2.5 sm:mt-3">
                                <LogoMark inverse className="mt-1 size-6 shrink-0 rounded-md" />
                                <div className="min-w-0 max-w-[min(100%,680px)] rounded-[13px] rounded-bl-sm border border-line bg-surface-soft px-3.5 py-2.5 text-[0.75rem] leading-[1.65] text-ink sm:px-4 sm:py-3">
                                    <p className="mb-1.5 text-[0.5625rem] font-bold tracking-[0.05em] text-ink-faint uppercase">Specbook agent</p>
                                    <MessageContent content={streamingText} user={false} />
                                    <span className="ml-0.5 inline-block h-3.5 w-px animate-pulse bg-primary align-[-2px]" aria-hidden="true" />
                                </div>
                            </article>
                        )}

                        {state.vncSessionId && <LiveBrowserCard sessionId={state.vncSessionId} />}

                        {state.credentialRequest && (
                            <CredentialRequestCard
                                chatId={chatId}
                                request={state.credentialRequest}
                                onResolved={() =>
                                    setState((prev) => (prev ? { ...prev, credentialRequest: null } : prev))
                                }
                            />
                        )}

                        {state.busy && (
                            <Badge variant="secondary" className="mt-3 flex gap-2 rounded-none bg-transparent p-0 pl-[38px] text-[0.6875rem] font-semibold whitespace-normal text-ink-faint" role="status">
                                <LoaderCircle size={12} className="status-pulse shrink-0 text-primary" />
                                <span>
                                    {activeTool ? `Using ${readableToolName(activeTool)}` : agentStatus || "Thinking through the request"}
                                    {state.queue.followUp > 0 && <span className="font-normal text-ink-faint"> · {state.queue.followUp} follow-up queued</span>}
                                </span>
                            </Badge>
                        )}
                    </div>
                </div>
            </ScrollArea>

            <div className="shrink-0 border-t border-line bg-surface px-3 pt-3 pb-[max(14px,env(safe-area-inset-bottom))] sm:px-6 sm:pt-4">
                <div className="mx-auto w-full max-w-[780px]">
                    {discoveryTerminal && revisionInfo && (
                        <Alert className="mb-2 text-xs" role="status">
                            <AlertDescription>
                                This discovery is closed: its context was {revisionInfo.status}.{" "}
                                <Link href={`/p/${projectId}`} className="font-bold underline underline-offset-2">Open the project overview</Link> to see the current context.
                            </AlertDescription>
                        </Alert>
                    )}
                    {sendError && (
                        <Alert variant="destructive" className="mb-2 flex items-start gap-2 bg-transparent p-0 text-xs leading-5" role="alert">
                            <AlertCircle size={13} className="mt-1 shrink-0" />
                            <AlertDescription>{sendError}</AlertDescription>
                        </Alert>
                    )}
                    {actionError && (
                        <Alert variant="destructive" className="mb-2 flex items-start gap-2 bg-transparent p-0 text-xs leading-5" role="alert">
                            <AlertCircle size={13} className="mt-1 shrink-0" />
                            <AlertDescription>{actionError}</AlertDescription>
                        </Alert>
                    )}
                    <form onSubmit={sendMessage} className="rounded-[13px] border border-line-strong bg-surface p-2 shadow-composer">
                        <div className="flex items-end gap-2">
                            <Label className="min-w-0 flex-1">
                                <span className="sr-only">Message Specbook</span>
                                <Textarea
                                    ref={textareaRef}
                                    value={text}
                                    onChange={(event) => setText(event.target.value)}
                                    onInput={(event) => {
                                        event.currentTarget.style.height = "auto";
                                        event.currentTarget.style.height = `${Math.min(event.currentTarget.scrollHeight, 112)}px`;
                                    }}
                                    onKeyDown={(event) => {
                                        if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                                            event.preventDefault();
                                            event.currentTarget.form?.requestSubmit();
                                        }
                                    }}
                                    rows={1}
                                    disabled={discoveryTerminal}
                                    placeholder={
                                        discoveryTerminal
                                            ? "This discovery is closed"
                                            : discovery
                                              ? "Guide the discovery or ask about what was found..."
                                              : "Describe what to explore or verify..."
                                    }
                                    className="max-h-28 min-h-10 resize-none rounded-none border-0 bg-transparent px-2 py-2 text-[0.78125rem] leading-5 shadow-none hover:border-transparent focus-visible:border-transparent focus-visible:ring-0"
                                />
                            </Label>
                             {state.busy && (
                                 <Button
                                     type="button"
                                     variant="outline"
                                     size="icon-lg"
                                     onClick={() => void stopAgent()}
                                     disabled={stopping}
                                     className="rounded-[9px]"
                                     aria-label="Stop agent"
                                 >
                                     {stopping ? <LoaderCircle size={15} className="animate-spin" /> : <Square size={14} fill="currentColor" />}
                                 </Button>
                             )}
                             <Button
                                 type="submit"
                                 disabled={!text.trim() || sending || discoveryTerminal}
                                 size="icon-lg"
                                 className="rounded-[9px] disabled:pointer-events-auto disabled:cursor-not-allowed disabled:opacity-35"
                                 aria-label={state.busy ? "Queue follow-up" : "Send message"}
                             >
                                 <ArrowUp size={16} strokeWidth={2.2} />
                             </Button>
                        </div>
                    </form>
                    <p className="mt-2 hidden text-center text-[0.59375rem] text-ink-faint sm:block">
                         {discovery
                             ? "The agent explores within the allowed origin and drafts project context. It cannot create Specs here."
                             : state.busy
                               ? "Your message will be added as a follow-up. Stop the agent at any time."
                               : "Enter to send. Shift+Enter adds a new line. Edit or retry any message from its actions."}
                    </p>
                </div>
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
