"use client";

import {
  Check,
  ChevronDown,
  LoaderCircle,
  MessageSquareText,
  PencilLine,
} from "lucide-react";
import { useEffect, useState } from "react";

import { useAuth } from "@/components/auth-provider";
import { ContextReadout } from "@/components/context-readout";
import { ProjectContextEditor } from "@/components/project-context-editor";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  confirmProjectContext,
  discardProjectContext,
  errorMessage,
} from "@/lib/api";
import type { ProjectContextRevision } from "@/lib/types";

export const ChatContextReview =
  /* oxlint-disable eslint/complexity -- Keep the existing render states and their coordinated actions together during the lint migration. */
  function ChatContextReview({
    revision,
    busy,
    onChange,
    onDiscuss,
  }: {
    revision: ProjectContextRevision;
    busy: boolean;
    onChange: () => Promise<void>;
    onDiscuss: (message: string) => Promise<void>;
  }) {
    const { canEdit } = useAuth();
    const [current, setCurrent] = useState(revision);
    const [expanded, setExpanded] = useState(false);
    const [editing, setEditing] = useState(false);
    const [saving, setSaving] = useState<
      "confirm" | "discard" | "discuss" | "refresh" | null
    >(null);
    const [error, setError] = useState("");
    const [feedback, setFeedback] = useState("");
    const pending = current.status === "draft";
    const confirmable =
      current.context.summary.trim().length > 0 &&
      (current.context.areas.length > 0 || current.context.unknowns.length > 0);
    const disabled = busy || saving !== null;

    useEffect(() => {
      // oxlint-disable-next-line react/set-state-in-effect -- Reset the previous request or selection when its external key changes before loading fresh state.
      setCurrent((previous) =>
        revision.id !== previous.id || revision.updatedAt >= previous.updatedAt
          ? revision
          : previous
      );
    }, [revision]);

    const act = async function act(action: "confirm" | "discard" | "discuss") {
      setSaving(action);
      setError("");
      setFeedback("");
      try {
        if (action === "discuss") {
          await onDiscuss(
            "I'd like to review these discovery findings before confirming the project context."
          );
        } else {
          const { revision: updated } = await (action === "confirm"
            ? confirmProjectContext(current.id)
            : discardProjectContext(current.id));
          setCurrent(updated);
          setFeedback(
            action === "confirm"
              ? "Project context confirmed. These findings will guide future Specs and conversations."
              : "This draft was discarded. Previously confirmed context stays active."
          );
          await onChange();
        }
      } catch (error_) {
        setError(errorMessage(error_));
        // oxlint-disable-next-line react/todo -- Oxlint React Compiler cannot analyze this supported JavaScript syntax; preserve its cleanup and error behavior.
      } finally {
        setSaving(null);
      }
    };

    const saved = async function saved(updated: ProjectContextRevision) {
      setCurrent(updated);
      setEditing(false);
      setSaving("refresh");
      setError("");
      setFeedback(
        "Your changes were saved. Review and confirm the context when it is ready."
      );
      try {
        await onChange();
      } catch {
        setError(
          "Your changes were saved, but the conversation could not refresh. Reload it to see the latest state."
        );
        // oxlint-disable-next-line react/todo -- Oxlint React Compiler cannot analyze this supported JavaScript syntax; preserve its cleanup and error behavior.
      } finally {
        setSaving(null);
      }
    };

    return (
      <section
        id="chat-context-review"
        aria-labelledby="chat-context-review-title"
        className="border-line min-w-0 space-y-4 border-y py-4"
      >
        <div className="flex flex-wrap items-center gap-2">
          <h3
            id="chat-context-review-title"
            className="text-body text-ink min-w-0 flex-1 font-semibold"
          >
            {pending
              ? "Are these discovery findings correct?"
              : "Project context"}
          </h3>
          {!pending && (
            <Badge
              variant={current.status === "confirmed" ? "success" : "neutral"}
            >
              {current.status === "confirmed" && (
                <Check size={12} aria-hidden="true" />
              )}
              {current.status === "confirmed" ? "Confirmed" : "Discarded"}
            </Badge>
          )}
        </div>
        {editing && pending ? (
          <fieldset disabled={busy} className="min-w-0">
            <legend className="sr-only">Edit discovery findings</legend>
            <ProjectContextEditor
              key={current.id}
              revision={current}
              onSaved={(updated) => saved(updated)}
              onCancel={() => setEditing(false)}
            />
          </fieldset>
        ) : (
          <>
            {!expanded && (
              <p className="text-body text-ink break-words whitespace-pre-wrap">
                {current.context.summary ||
                  "The discovery has not recorded a summary yet."}
              </p>
            )}
            <Collapsible
              open={expanded}
              onOpenChange={setExpanded}
              className="group/context"
            >
              <CollapsibleTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="-ml-2"
                >
                  <ChevronDown
                    size={13}
                    aria-hidden="true"
                    className="transition-transform group-data-[state=open]/context:rotate-180 motion-reduce:transition-none"
                  />
                  {expanded ? "Hide full context" : "Review full context"}
                </Button>
              </CollapsibleTrigger>
              <CollapsibleContent className="mt-3">
                <ContextReadout context={current.context} />
              </CollapsibleContent>
            </Collapsible>
            {pending &&
              (canEdit ? (
                <>
                  {!confirmable && (
                    <p className="text-meta text-ink-subtle">
                      Confirmation needs a summary and at least one area or
                      unknown.
                    </p>
                  )}
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      size="sm"
                      disabled={disabled || !confirmable}
                      onClick={() => act("confirm")}
                    >
                      {saving === "confirm" ? (
                        <LoaderCircle
                          size={14}
                          className="animate-spin motion-reduce:animate-none"
                        />
                      ) : (
                        <Check size={14} />
                      )}
                      {saving === "confirm" ? "Confirming…" : "Confirm context"}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={disabled}
                      onClick={() => {
                        setError("");
                        setFeedback("");
                        setEditing(true);
                      }}
                    >
                      <PencilLine size={14} />
                      Edit findings
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={disabled}
                      onClick={() => act("discuss")}
                    >
                      <MessageSquareText size={14} />
                      {saving === "discuss" ? "Preparing…" : "Discuss here"}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={disabled}
                      onClick={() => act("discard")}
                    >
                      {saving === "discard" ? "Discarding…" : "Discard draft"}
                    </Button>
                  </div>
                  <p className="text-meta text-ink-subtle">
                    Confirmed context becomes reviewed background knowledge for
                    future Specs and conversations.
                  </p>
                </>
              ) : (
                <p className="text-body text-ink-muted">
                  An editor can confirm or edit these findings.
                </p>
              ))}
          </>
        )}
        {feedback && (
          <output className="text-body text-ink-muted block">{feedback}</output>
        )}
        {error && (
          <Alert variant="danger" role="alert">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
      </section>
    );
  };
/* oxlint-enable eslint/complexity */
