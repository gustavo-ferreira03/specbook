"use client";

import { Suspense, use, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { AlertCircle, ArrowUp, Compass, ExternalLink, Monitor, RefreshCw } from "lucide-react";
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
import { API_URL, api } from "@/lib/api";
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
            message.createdAt === next.createdAt
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

function ChatContent({ projectId, chatId }: { projectId: string; chatId: string }) {
    const searchParams = useSearchParams();
    const specId = searchParams.get("specId");
    const [state, setState] = useState<ChatState | null>(null);
    const [text, setText] = useState("");
    const [loadError, setLoadError] = useState("");
    const [pollError, setPollError] = useState("");
    const [sendError, setSendError] = useState("");
    const [browserError, setBrowserError] = useState("");
    const [browserAttempt, setBrowserAttempt] = useState(0);
    const [sending, setSending] = useState(false);
    const [beginning, setBeginning] = useState(false);
    const [beginError, setBeginError] = useState("");
    const [retryKey, setRetryKey] = useState(0);
    const scrollRef = useRef<HTMLDivElement>(null);
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const browserStartRef = useRef("");
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

        async function refresh() {
            try {
                const result = await api<ChatState>(`/chats/${chatId}`);
                if (!active) return;
                loaded = true;
                setState((current) => (current && sameChatState(current, result) ? current : result));
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
    const budgetExhausted =
        discovery && revisionInfo ? revisionInfo.actionsUsed >= revisionInfo.brief.maxActions : false;
    const discoveryComposerLocked = budgetExhausted && Boolean(revisionInfo?.hasProposal);
    const awaitingDiscoveryStart =
        discovery && state !== null && state.messages.length === 0 && !state.busy && !discoveryTerminal;

    useEffect(() => {
        if (!state || state.vncSessionId) return;
        if (state.mode === "discovery" && state.messages.length === 0 && !state.busy) return;
        const key = `${chatId}:${browserAttempt}`;
        if (browserStartRef.current === key) return;
        browserStartRef.current = key;
        let active = true;
        setBrowserError("");
        api<{ vncSessionId: string }>(`/chats/${chatId}/browser`, { method: "POST" })
            .then((result) => {
                if (!active) return;
                setState((current) => current ? { ...current, vncSessionId: result.vncSessionId } : current);
            })
            .catch((error) => {
                if (active) setBrowserError(error instanceof Error ? error.message : String(error));
            });
        return () => {
            active = false;
        };
    }, [browserAttempt, chatId, state]);

    async function beginDiscovery() {
        if (beginning) return;
        setBeginning(true);
        setBeginError("");
        try {
            const browser = await api<{ vncSessionId: string }>(`/chats/${chatId}/browser`, {
                method: "POST",
            });
            await api<{ ok: true }>(`/chats/${chatId}/message`, {
                method: "POST",
                body: JSON.stringify({
                    text: "Begin the discovery. Follow the saved brief: explore from the start URL within the allowed origin, respect the safety notes and the action budget, then propose the project context.",
                }),
            });
            stickToBottomRef.current = true;
            setState((current) =>
                current ? { ...current, vncSessionId: browser.vncSessionId, busy: true } : current,
            );
        } catch (error) {
            setBeginError(error instanceof Error ? error.message : String(error));
        } finally {
            setBeginning(false);
        }
    }

    async function sendMessage(event: React.FormEvent<HTMLFormElement>) {
        event.preventDefault();
        const value = text.trim();
        if (!value || !state || state.busy || sending) return;
        setSending(true);
        setSendError("");
        setText("");
        stickToBottomRef.current = true;
        try {
            await api<{ ok: true }>(`/chats/${chatId}/message`, {
                method: "POST",
                body: JSON.stringify({ text: value }),
            });
            setState((current) => current ? { ...current, busy: true } : current);
            setPollError("");
            if (textareaRef.current) textareaRef.current.style.height = "auto";
        } catch (error) {
            setSendError(error instanceof Error ? error.message : String(error));
            setText(value);
        } finally {
            setSending(false);
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
                        <span className="shrink-0 text-ink-faint">{revisionInfo.actionsUsed}/{revisionInfo.brief.maxActions} actions</span>
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
                <div className="px-4 py-6 sm:px-7 sm:py-8">
                    <div className="mx-auto w-full max-w-[780px]">
                        {awaitingDiscoveryStart && revisionInfo && (
                            <div className="py-6 sm:py-10">
                                <p className="text-[0.625rem] font-bold tracking-[0.08em] text-ink-faint uppercase">Project discovery</p>
                                <h2 className="mt-2 text-xl font-bold tracking-[-0.025em] text-balance">Ready to explore this application</h2>
                                <p className="mt-3 max-w-[58ch] text-[0.75rem] leading-5 text-ink-soft">
                                    The agent will browse from <span className="font-mono text-[0.6875rem] [overflow-wrap:anywhere]">{revisionInfo.brief.startUrl}</span> with up to {revisionInfo.brief.maxActions} browser actions, following the saved goal, and draft a project context for your review.
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
                            <div className="py-6 sm:py-10">
                                <p className="text-[0.625rem] font-bold tracking-[0.08em] text-ink-faint uppercase">New chat</p>
                                <h2 className="mt-2 text-xl font-bold tracking-[-0.025em] text-balance">What should this application do?</h2>
                                <p className="mt-3 max-w-[58ch] text-[0.75rem] leading-5 text-ink-soft">
                                    Describe a flow or point the agent to an area of the application. It will browse, clarify the behavior, and save the verified result as a Spec.
                                </p>
                                <div className="mt-6 grid gap-2 sm:grid-cols-2">
                                    <Button type="button" variant="outline" onClick={() => setText("A user should be able to ")} className="h-auto min-h-20 flex-col items-stretch justify-start gap-0 whitespace-normal rounded-[11px] p-3.5 text-left font-normal">
                                        <span className="block text-xs font-bold">Describe a flow</span>
                                        <span className="mt-1 block text-[0.6875rem] leading-5 text-ink-faint">State what should happen and how success is recognized.</span>
                                    </Button>
                                    <Button type="button" variant="outline" onClick={() => setText("Explore the ")} className="h-auto min-h-20 flex-col items-stretch justify-start gap-0 whitespace-normal rounded-[11px] p-3.5 text-left font-normal">
                                        <span className="block text-xs font-bold">Explore a feature</span>
                                        <span className="mt-1 block text-[0.6875rem] leading-5 text-ink-faint">Let the agent inspect an area and propose useful coverage.</span>
                                    </Button>
                                </div>
                            </div>
                        )}

                        <div className="flex flex-col gap-[15px]">
                            {state.messages.map((message) => {
                                const userMessage = message.role === "user";
                                return (
                                    <article key={message.id} className={`flex items-start gap-2.5 ${userMessage ? "justify-end" : ""}`}>
                                        {!userMessage && (
                                            <LogoMark inverse className="size-6 shrink-0 rounded-md" />
                                        )}
                                        <div className={`max-w-[calc(100%-2.5rem)] overflow-x-auto rounded-[13px] px-3.5 py-2.5 text-[0.75rem] leading-[1.6] break-words select-text [overflow-wrap:anywhere] sm:max-w-[84%] ${
                                            userMessage ? "chat-message-user rounded-br-sm bg-primary text-primary-foreground" : "rounded-bl-sm border border-line bg-surface-soft text-ink"
                                        }`}>
                                            <p className={`mb-1 text-[0.5625rem] font-bold tracking-[0.05em] uppercase ${userMessage ? "text-white/60" : "text-ink-faint"}`}>
                                                {userMessage ? "You" : "Specbook agent"}
                                            </p>
                                            <MessageContent content={message.content} user={userMessage} />
                                        </div>
                                    </article>
                                );
                            })}
                        </div>

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

                        {!state.vncSessionId && browserError && (
                            <Alert variant="destructive" className="my-5 flex w-auto items-center justify-between gap-3 md:ml-[38px]" role="alert">
                                <AlertDescription className="min-w-0 flex-1">Live browser could not start: {browserError}</AlertDescription>
                                <Button type="button" variant="link" size="sm" onClick={() => setBrowserAttempt((value) => value + 1)} className="h-auto shrink-0 px-0 text-danger underline underline-offset-2">Try again</Button>
                            </Alert>
                        )}

                        {state.busy && (
                            <Badge variant="secondary" className="mt-4 flex gap-2 rounded-none bg-transparent p-0 pl-[38px] text-[0.6875rem] font-semibold whitespace-normal text-ink-faint" role="status">
                                <span className="status-pulse size-1.5 rounded-full bg-primary" />
                                Agent is working...
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
                    {!discoveryTerminal && budgetExhausted && (
                        <Alert className="mb-2 text-xs" role="status">
                            <AlertDescription>
                                {revisionInfo?.hasProposal ? (
                                    <>
                                        The discovery used all {revisionInfo.brief.maxActions} browser actions.{" "}
                                        <Link href={`/p/${projectId}`} className="font-bold underline underline-offset-2">Review the drafted context</Link> on the project overview.
                                    </>
                                ) : (
                                    <>The discovery used all {revisionInfo?.brief.maxActions} browser actions without saving a draft. Ask the agent to save its current findings.</>
                                )}
                            </AlertDescription>
                        </Alert>
                    )}
                    {sendError && (
                        <Alert variant="destructive" className="mb-2 flex items-start gap-2 bg-transparent p-0 text-xs leading-5" role="alert">
                            <AlertCircle size={13} className="mt-1 shrink-0" />
                            <AlertDescription>{sendError}</AlertDescription>
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
                                    disabled={discoveryTerminal || discoveryComposerLocked}
                                    placeholder={
                                        discoveryTerminal
                                            ? "This discovery is closed"
                                            : discoveryComposerLocked
                                              ? "The discovery action budget is used up"
                                              : discovery
                                                ? "Guide the discovery or ask about what was found..."
                                                : "Describe what to explore or verify..."
                                    }
                                    className="max-h-28 min-h-10 resize-none rounded-none border-0 bg-transparent px-2 py-2 text-[0.78125rem] leading-5 shadow-none hover:border-transparent focus-visible:border-transparent focus-visible:ring-0"
                                />
                            </Label>
                            <Button
                                type="submit"
                                disabled={!text.trim() || state.busy || sending || discoveryTerminal || discoveryComposerLocked}
                                size="icon-lg"
                                className="rounded-[9px] disabled:pointer-events-auto disabled:cursor-not-allowed disabled:opacity-35"
                                aria-label="Send message"
                            >
                                <ArrowUp size={16} strokeWidth={2.2} />
                            </Button>
                        </div>
                    </form>
                    <p className="mt-1.5 hidden text-center text-[0.59375rem] text-ink-faint sm:block">
                        {discovery
                            ? "The agent explores within the allowed origin and drafts project context. It cannot create Specs here."
                            : "The agent can browse the application and create or update Specs."}
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
