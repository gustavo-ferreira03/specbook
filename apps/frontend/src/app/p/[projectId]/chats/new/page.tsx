"use client";

import { Suspense, use, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { AlertCircle, ArrowUp, LoaderCircle, MessageSquareText, Settings2, Sparkles } from "lucide-react";
import { useAuth } from "@/components/AuthProvider";
import { ChatSettingsDialog } from "@/components/ChatSettingsDialog";
import { EmptyState } from "@/components/EmptyState";
import { SpecGrid } from "@/components/SpecGrid";
import { LogoMark } from "@/components/LogoMark";
import { PageHeader } from "@/components/PageHeader";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { errorMessage, getLlmRuntimeStatus, startProjectChat } from "@/lib/api";
import { onInvalidate } from "@/lib/invalidation";
import { cn } from "@/lib/utils";

const suggestions = [
    { title: "Describe a flow", body: "State what should happen and how success is recognized.", seed: "A user should be able to ", icon: MessageSquareText },
    { title: "Explore a feature", body: "Let the agent inspect an area and propose useful coverage.", seed: "Explore the ", icon: Sparkles },
];

function initialText(specId: string | null, intent: string | null): string {
    if (!specId) return "";
    return intent === "repair"
        ? `Repair the executable check for Spec ${specId}, keeping its saved steps and expected result unchanged. `
        : `I want to change the Spec ${specId}. `;
}

function NewChatContent({ projectId }: { projectId: string }) {
    const { canEdit, isAdmin } = useAuth();
    const router = useRouter();
    const searchParams = useSearchParams();
    const specId = searchParams.get("specId");
    const intent = searchParams.get("intent");
    const [text, setText] = useState("");
    const [sending, setSending] = useState(false);
    const [sendError, setSendError] = useState("");
    const [modelReady, setModelReady] = useState<boolean | null>(null);
    const [modelSetupOpen, setModelSetupOpen] = useState(false);
    const textareaRef = useRef<HTMLTextAreaElement>(null);

    useEffect(() => {
        const check = () => getLlmRuntimeStatus().then((status) => setModelReady(status.ready)).catch(() => setModelReady(null));
        check();
        return onInvalidate((event) => {
            if (!event.resource || event.resource === "settings") check();
        });
    }, []);

    useEffect(() => {
        setText(initialText(specId, intent));
    }, [specId, intent]);

    useEffect(() => {
        const textarea = textareaRef.current;
        if (!textarea) return;
        textarea.style.height = "auto";
        textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`;
    }, [text]);

    const modelMissing = modelReady === false;

    async function send(event: React.FormEvent<HTMLFormElement>) {
        event.preventDefault();
        const value = text.trim();
        if (!value || sending) return;
        setSending(true);
        setSendError("");
        try {
            const { chat } = await startProjectChat(projectId, value);
            router.replace(`/p/${projectId}/chats/${chat.id}`);
        } catch (error) {
            setSendError(errorMessage(error));
            setSending(false);
        }
    }

    if (!canEdit) return <EmptyState title="Chats are read-only" description="Ask an editor to start a conversation or change a Spec." />;

    return (
        <div className="flex h-full min-h-0 flex-col bg-surface">
            <PageHeader title="New chat" breadcrumbs={[{ label: "Chats", href: `/p/${projectId}/chats` }]} width="chat" className="pt-3 pb-3 md:pt-5 md:pb-4" />
            <ScrollArea className="min-h-0 flex-1">
                <div className="px-4 pt-6 pb-10 md:px-8 md:pt-8">
                    <section className="relative isolate mx-auto w-full max-w-chat pt-2 pb-8 md:pt-6" aria-labelledby="chat-intro">
                        <SpecGrid fade={false} className="spec-grid-halo -inset-x-24 -inset-y-10 -z-10" />
                        <span className="flex size-11 items-center justify-center rounded-md border border-line-strong bg-surface" aria-hidden="true">
                            <LogoMark className="size-5 dark:invert" />
                        </span>
                        <h2 id="chat-intro" className="mt-5 text-display font-[650] text-ink text-balance">What should this application do?</h2>
                        <p className="mt-2 max-w-[60ch] text-body text-ink-muted">
                            Describe a flow or point the agent to an area of the application. It will browse, clarify the behavior, and save the verified result as a Spec.
                        </p>
                        <div className="mt-6 grid gap-2 sm:grid-cols-2">
                            {suggestions.map((suggestion) => (
                                <button
                                    key={suggestion.title}
                                    type="button"
                                    disabled={modelMissing || sending}
                                    onClick={() => {
                                        setText(suggestion.seed);
                                        textareaRef.current?.focus();
                                    }}
                                    className="group/suggestion flex items-start gap-3 rounded-xl border border-line bg-surface p-3.5 text-left transition-colors hover:border-line-strong hover:bg-surface-soft focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-surface focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50"
                                >
                                    <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg border border-line bg-surface text-ink-muted transition-colors group-hover/suggestion:text-ink" aria-hidden="true">
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
                </div>
            </ScrollArea>

            <div className="relative shrink-0 bg-surface px-3 pb-[max(12px,env(safe-area-inset-bottom))] md:px-8 md:pb-5">
                <div className="mx-auto w-full max-w-chat">
                    {sendError && (
                        <Alert variant="destructive" className="mb-2 flex items-start gap-2" role="alert">
                            <AlertCircle size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
                            <AlertDescription>{sendError}</AlertDescription>
                        </Alert>
                    )}
                    <form
                        onSubmit={send}
                        className={cn(
                            "overflow-hidden rounded-2xl border bg-surface shadow-composer transition-colors duration-150",
                            modelMissing ? "border-line bg-surface-soft" : "border-line-strong focus-within:border-line-hover",
                        )}
                    >
                        {modelMissing && (
                            <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line bg-surface-soft px-4 py-2.5">
                                <p className="flex min-w-0 flex-1 items-center gap-2 text-control text-ink-muted">
                                    <span className="size-1.5 shrink-0 rounded-full bg-warning-chart" aria-hidden="true" />
                                    <span>No model is set up yet.<span className="hidden sm:inline"> {isAdmin ? "Choose a provider to chat with the agent." : "Ask an administrator to connect a provider."}</span></span>
                                </p>
                                {isAdmin && <Button type="button" variant="outline" size="sm" onClick={() => setModelSetupOpen(true)}>
                                    <Settings2 size={13} /> Set up model
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
                                autoFocus
                                disabled={modelMissing || sending}
                                placeholder={modelMissing ? "Describe a behavior to verify…" : "Describe what to explore or verify…"}
                                className="block max-h-[200px] min-h-12 resize-none rounded-none border-0 bg-transparent px-4 pt-3.5 pb-1 text-body shadow-none hover:border-transparent focus-visible:border-transparent focus-visible:ring-0 disabled:bg-transparent disabled:opacity-100"
                            />
                        </Label>
                        <div className="flex items-center gap-2 px-2.5 pb-2.5">
                            <p className="min-w-0 flex-1 truncate pl-1.5 text-meta text-ink-subtle">
                                <span className={cn("hidden", !modelMissing && "sm:inline")}>Enter to send · Shift+Enter for a new line</span>
                            </p>
                            <Tooltip>
                                <TooltipTrigger asChild>
                                    <Button
                                        type="submit"
                                        disabled={!text.trim() || sending || modelMissing}
                                        size="icon-sm"
                                        className="rounded-lg disabled:pointer-events-auto disabled:cursor-not-allowed disabled:opacity-30"
                                        aria-label="Send message"
                                    >
                                        {sending ? <LoaderCircle size={15} className="animate-spin" /> : <ArrowUp size={16} strokeWidth={2.2} />}
                                    </Button>
                                </TooltipTrigger>
                                <TooltipContent side="top">Send message</TooltipContent>
                            </Tooltip>
                        </div>
                    </form>
                </div>
            </div>
            {modelSetupOpen && <ChatSettingsDialog projectId={projectId} tab="model" onClose={() => {
                setModelSetupOpen(false);
                getLlmRuntimeStatus().then((status) => setModelReady(status.ready)).catch(() => undefined);
            }} />}
        </div>
    );
}

export default function NewChat({ params }: { params: Promise<{ projectId: string }> }) {
    const { projectId } = use(params);
    return <Suspense fallback={<span className="sr-only" role="status">Loading</span>}><NewChatContent projectId={projectId} /></Suspense>;
}
