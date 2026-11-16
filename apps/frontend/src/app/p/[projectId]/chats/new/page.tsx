"use client";

import {
  AlertCircle,
  ArrowUp,
  LoaderCircle,
  MessageSquareText,
  Settings2,
  Sparkles,
} from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, use, useEffect, useRef, useState } from "react";

import { useAuth } from "@/components/auth-provider";
import { ChatSettingsDialog } from "@/components/chat-settings-dialog";
import { EmptyState } from "@/components/empty-state";
import { LogoMark } from "@/components/logo-mark";
import { PageHeader } from "@/components/page-header";
import { RunnerExplorationNotice } from "@/components/runner-exploration-notice";
import { SpecGrid } from "@/components/spec-grid";
import { TunnelConnectionNotice } from "@/components/tunnel-connection-notice";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { errorMessage, getLlmRuntimeStatus, startProjectChat } from "@/lib/api";
import { onInvalidate } from "@/lib/invalidation";
import { useRunnerEnvironment } from "@/lib/use-runner-environment";
import { cn } from "@/lib/utils";

const suggestions = [
  {
    title: "Describe a flow",
    body: "State what should happen and how success is recognized.",
    seed: "A user should be able to ",
    icon: MessageSquareText,
    requiresExploration: false,
  },
  {
    title: "Explore a feature",
    body: "Let the agent inspect an area and propose useful coverage.",
    seed: "Explore the ",
    icon: Sparkles,
    requiresExploration: true,
  },
];

const initialText = function initialText(
  specId: string | null,
  intent: string | null
): string {
  if (!specId) {
    return "";
  }
  return intent === "repair"
    ? `Repair the executable check for Spec ${specId}, keeping its saved steps and expected result unchanged. `
    : `I want to change the Spec ${specId}. `;
};

const NewChatContent = function NewChatContent({
  projectId,
}: {
  projectId: string;
}) {
  const { canEdit, isAdmin } = useAuth();
  const runnerEnvironment = useRunnerEnvironment(projectId);
  const router = useRouter();
  const searchParams = useSearchParams();
  const specId = searchParams.get("specId");
  const intent = searchParams.get("intent");
  const [text, setText] = useState(() => initialText(specId, intent));
  const [draftOrigin, setDraftOrigin] = useState({ specId, intent });
  if (draftOrigin.specId !== specId || draftOrigin.intent !== intent) {
    setDraftOrigin({ specId, intent });
    setText(initialText(specId, intent));
  }
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState("");
  const [modelReady, setModelReady] = useState<boolean | null>(null);
  const [modelSetupOpen, setModelSetupOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const check = () =>
      (async () => {
        try {
          const resolvedValue = await getLlmRuntimeStatus();
          const status = resolvedValue;
          return setModelReady(status.ready);
        } catch {
          return setModelReady(null);
        }
      })();
    check();
    return onInvalidate((event) => {
      if (!event.resource || event.resource === "settings") {
        check();
      }
    });
  }, []);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) {
      return;
    }
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`;
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- This dependency intentionally triggers a retry, navigation reset, or DOM measurement without being read by the effect.
  }, [text]);

  const modelMissing = modelReady === false;
  const visibleSuggestions = suggestions.filter(
    (suggestion) => !runnerEnvironment || !suggestion.requiresExploration
  );

  const send = async function send(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = text.trim();
    if (!value || sending) {
      return;
    }
    setSending(true);
    setSendError("");
    try {
      const { chat } = await startProjectChat(projectId, value);
      router.replace(`/p/${projectId}/chats/${chat.id}`);
    } catch (error) {
      setSendError(errorMessage(error));
      setSending(false);
    }
  };

  if (!canEdit) {
    return (
      <EmptyState
        title="Chats are read-only"
        description="Ask an editor to start a conversation or change a Spec."
      />
    );
  }

  return (
    <div className="bg-surface flex h-full min-h-0 flex-col">
      <PageHeader
        title="New chat"
        breadcrumbs={[{ label: "Chats", href: `/p/${projectId}/chats` }]}
        width="chat"
        className="pt-3 pb-3 md:pt-5 md:pb-4"
      />
      <ScrollArea className="min-h-0 flex-1">
        <div className="px-4 pt-6 pb-10 md:px-8 md:pt-8">
          <section
            className="max-w-chat relative isolate mx-auto w-full pt-2 pb-8 md:pt-6"
            aria-labelledby="chat-intro"
          >
            <SpecGrid
              fade={false}
              className="spec-grid-halo -inset-x-24 -inset-y-10 -z-10"
            />
            <span
              className="border-line-strong bg-surface flex size-11 items-center justify-center rounded-md border"
              aria-hidden="true"
            >
              <LogoMark className="size-5 dark:invert" />
            </span>
            <h2
              id="chat-intro"
              className="text-display text-ink mt-5 font-[650] text-balance"
            >
              What should this application do?
            </h2>
            <p className="text-body text-ink-muted mt-2 max-w-[60ch]">
              {runnerEnvironment
                ? "Discuss saved Specs, review run evidence, or describe changes to a behavior contract."
                : "Describe a flow or point the agent to an area of the application. It will browse, clarify the behavior, and save the verified result as a Spec."}
            </p>
            {runnerEnvironment && <RunnerExplorationNotice className="mt-4" />}
            <TunnelConnectionNotice projectId={projectId} className="mt-4" />
            <div
              className={cn(
                "mt-6 grid gap-2",
                visibleSuggestions.length > 1 && "sm:grid-cols-2"
              )}
            >
              {visibleSuggestions.map((suggestion) => (
                <button
                  key={suggestion.title}
                  aria-label={`${suggestion.title} ${suggestion.body}`}
                  type="button"
                  disabled={modelMissing || sending}
                  onClick={() => {
                    setText(suggestion.seed);
                    textareaRef.current?.focus();
                  }}
                  className="group/suggestion slab slab-lift bg-surface focus-visible:ring-ring focus-visible:ring-offset-surface flex items-start gap-3 rounded-xl p-3.5 text-left focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50"
                >
                  <span
                    className="border-line bg-surface text-ink-muted group-hover/suggestion:text-ink mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg border transition-colors"
                    aria-hidden="true"
                  >
                    <suggestion.icon size={14} />
                  </span>
                  <span>
                    <span className="text-control text-ink block font-semibold">
                      {suggestion.title}
                    </span>
                    <span className="text-meta text-ink-muted mt-0.5 block">
                      {suggestion.body}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          </section>
        </div>
      </ScrollArea>

      <div className="bg-surface relative shrink-0 px-3 pb-[max(12px,env(safe-area-inset-bottom))] md:px-8 md:pb-5">
        <div className="max-w-chat mx-auto w-full">
          {sendError && (
            <Alert
              variant="destructive"
              className="mb-2 flex items-start gap-2"
              role="alert"
            >
              <AlertCircle
                size={14}
                className="mt-0.5 shrink-0"
                aria-hidden="true"
              />
              <AlertDescription>{sendError}</AlertDescription>
            </Alert>
          )}
          <form
            onSubmit={send}
            className={cn(
              "bg-surface shadow-composer overflow-hidden rounded-2xl border transition-colors duration-150",
              modelMissing
                ? "border-line bg-surface-soft"
                : "border-line-strong focus-within:border-line-hover"
            )}
          >
            {modelMissing && (
              <div className="border-line bg-surface-soft flex flex-wrap items-center gap-x-3 gap-y-2 border-b px-4 py-2.5">
                <p className="text-control text-ink-muted flex min-w-0 flex-1 items-center gap-2">
                  <span
                    className="bg-warning-chart size-1.5 shrink-0 rounded-full"
                    aria-hidden="true"
                  />
                  <span>
                    No model is set up yet.
                    <span className="hidden sm:inline">
                      {" "}
                      {isAdmin
                        ? "Choose a provider to chat with the agent."
                        : "Ask an administrator to connect a provider."}
                    </span>
                  </span>
                </p>
                {isAdmin && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setModelSetupOpen(true)}
                  >
                    <Settings2 size={13} /> Set up model
                  </Button>
                )}
              </div>
            )}
            <Label className="block">
              <span className="sr-only">Message Specbook</span>
              <Textarea
                ref={textareaRef}
                value={text}
                onChange={(event) => setText(event.target.value)}
                onKeyDown={(event) => {
                  if (
                    event.key === "Enter" &&
                    !event.shiftKey &&
                    !event.nativeEvent.isComposing
                  ) {
                    event.preventDefault();
                    event.currentTarget.form?.requestSubmit();
                  }
                }}
                rows={1}
                autoFocus
                disabled={modelMissing || sending}
                placeholder={(() => {
                  if (runnerEnvironment) {
                    return "Discuss a Spec or its run evidence…";
                  }
                  if (modelMissing) {
                    return "Describe a behavior to verify…";
                  }
                  return "Describe what to explore or verify…";
                })()}
                className="text-body block max-h-[200px] min-h-12 resize-none rounded-none border-0 bg-transparent px-4 pt-3.5 pb-1 shadow-none hover:border-transparent focus-visible:border-transparent focus-visible:ring-0 disabled:bg-transparent disabled:opacity-100"
              />
            </Label>
            <div className="flex items-center gap-2 px-2.5 pb-2.5">
              <p className="text-meta text-ink-subtle min-w-0 flex-1 truncate pl-1.5">
                <span className={cn("hidden", !modelMissing && "sm:inline")}>
                  Enter to send · Shift+Enter for a new line
                </span>
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
                    {sending ? (
                      <LoaderCircle size={15} className="animate-spin" />
                    ) : (
                      <ArrowUp size={16} strokeWidth={2.2} />
                    )}
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top">Send message</TooltipContent>
              </Tooltip>
            </div>
          </form>
        </div>
      </div>
      {modelSetupOpen && (
        <ChatSettingsDialog
          projectId={projectId}
          tab="model"
          onClose={() => {
            setModelSetupOpen(false);
            (async () => {
              try {
                const resolvedValue = await getLlmRuntimeStatus();
                const status = resolvedValue;
                return setModelReady(status.ready);
              } catch {
                // Keep the last usable state if this optional operation fails.
              }
            })();
          }}
        />
      )}
    </div>
  );
};

const NewChat = function NewChat({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = use(params);
  return (
    <Suspense fallback={<output className="sr-only">Loading</output>}>
      <NewChatContent projectId={projectId} />
    </Suspense>
  );
};
export default NewChat;
