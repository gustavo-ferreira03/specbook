"use client";

import { Check, LoaderCircle, MessageSquareText, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { useAuth } from "@/components/auth-provider";
import { FileDiff } from "@/components/file-diff";
import { SpecBatchDecision } from "@/components/spec-batch-decision";
import { StoryTimeline } from "@/components/story-details";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { api, apiPath, API_URL } from "@/lib/api";
import type { ActivityStory, PresentedInboxItem } from "@/lib/types";
import { cn } from "@/lib/utils";

const url = (value: string) =>
  value.startsWith("/") ? `${API_URL}${value}` : value;

type ReviewAction =
  | "approve"
  | "reject"
  | "answer"
  | "dismiss"
  | "report_bug"
  | "ignore";
type InboxAction = ReviewAction | "promote" | "discuss";

const Screenshots = function Screenshots({
  item,
}: {
  item: PresentedInboxItem;
}) {
  const [selected, setSelected] = useState<{
    url: string;
    label: string;
  } | null>(null);
  const [unavailable, setUnavailable] = useState<string[]>([]);
  const shots: [string, { url: string; label: string } | null][] =
    Object.entries(item.presentation.screenshots).filter(
      (entry): entry is [string, { url: string; label: string }] =>
        Boolean(entry[1])
    );
  if (
    item.presentation.type === "update" &&
    item.presentation.screenshots.after &&
    !item.presentation.screenshots.before
  ) {
    shots.unshift(["before", null]);
  }
  if (!shots.length) {
    return null;
  }

  return (
    <>
      <div className={cn("grid gap-4", shots.length > 1 && "sm:grid-cols-2")}>
        {shots.map(([side, shot]) => (
          <figure key={side} className="min-w-0">
            <figcaption className="text-body text-ink mb-2 font-medium">
              {(() => {
                if (item.presentation.type === "update") {
                  if (side === "before") {
                    return "Before";
                  }
                  return "After";
                }
                if (side === "before") {
                  return "What happened";
                }
                return "What Specbook checked";
              })()}
            </figcaption>
            {(() => {
              if (shot) {
                if (unavailable.includes(shot.url)) {
                  return (
                    <p className="border-line bg-surface-soft text-body text-ink-muted rounded-lg border p-4">
                      This screenshot is unavailable.
                    </p>
                  );
                }
                return (
                  <button
                    type="button"
                    className="border-line bg-surface-soft focus-visible:ring-ring block w-full overflow-hidden rounded-lg border outline-none focus-visible:ring-2"
                    aria-label={`Enlarge screenshot: ${shot.label}`}
                    onClick={() => setSelected({ ...shot, url: url(shot.url) })}
                  >
                    {/* oxlint-disable next/no-img-element -- Evidence URLs and CSS-sized SVG icons must load directly without an image optimization proxy. */}
                    <img
                      src={url(shot.url)}
                      alt={shot.label}
                      loading="lazy"
                      onError={() =>
                        setUnavailable((current) => [...current, shot.url])
                      }
                      className="max-h-64 w-full object-contain"
                    />
                    {/* oxlint-enable next/no-img-element */}
                  </button>
                );
              }
              return (
                <p className="border-line bg-surface-soft text-body text-ink-muted rounded-lg border p-4">
                  No screenshot was captured for the earlier test run.
                </p>
              );
            })()}
            {shot && (
              <p className="text-meta text-ink-subtle mt-1.5">{shot.label}</p>
            )}
          </figure>
        ))}
      </div>
      <Dialog
        open={Boolean(selected)}
        onOpenChange={(open) => {
          if (!open) {
            setSelected(null);
          }
        }}
      >
        <DialogContent className="max-w-data sm:max-w-data">
          <DialogTitle>{selected?.label}</DialogTitle>
          <DialogDescription className="sr-only">
            Screenshot captured during the run.
          </DialogDescription>
          {selected && (
            /* oxlint-disable next/no-img-element -- Evidence URLs and CSS-sized SVG icons must load directly without an image optimization proxy. */
            <img
              src={selected.url}
              alt={selected.label}
              className="border-line bg-surface-soft max-h-[calc(100dvh-150px)] w-full rounded-lg border object-contain"
            />
            /* oxlint-enable next/no-img-element */
          )}
        </DialogContent>
      </Dialog>
    </>
  );
};

const SuggestedBehavior = function SuggestedBehavior({
  item,
}: {
  item: PresentedInboxItem;
}) {
  if (!["update", "new_check", "feature"].includes(item.presentation.type)) {
    return null;
  }
  const { humanSpec, description } = item.payload.params ?? {};
  if (!humanSpec && !description) {
    return null;
  }
  return (
    <div className="max-w-reading border-line space-y-4 border-t pt-4">
      {description && (
        <p className="text-body text-ink break-words whitespace-pre-wrap">
          {description}
        </p>
      )}
      {humanSpec && (
        <>
          {humanSpec.preconditions.length > 0 && (
            <section>
              <h3 className="text-body text-ink font-medium">Before the run</h3>
              <ul className="text-body text-ink-muted mt-2 list-disc space-y-1.5 pl-5">
                {humanSpec.preconditions.map((condition, index) => (
                  <li key={index}>{condition}</li>
                ))}
              </ul>
            </section>
          )}
          <section>
            <h3 className="text-body text-ink font-medium">
              What this Spec will do
            </h3>
            <ol className="mt-3 space-y-3">
              {humanSpec.steps.map((step, index) => (
                <li key={index} className="flex gap-3.5">
                  <span
                    aria-hidden="true"
                    className="border-line-strong bg-surface text-meta text-ink-muted tabular flex size-6 shrink-0 items-center justify-center rounded-md border font-semibold"
                  >
                    {index + 1}
                  </span>
                  <span className="text-body text-ink min-w-0 pt-0.5 break-words">
                    <span className="sr-only">Step {index + 1}: </span>
                    {step}
                  </span>
                </li>
              ))}
            </ol>
          </section>
          <section className="border-line bg-surface-soft rounded-lg border px-4 py-3">
            <h3 className="text-body text-ink font-medium">Expected result</h3>
            <p className="text-body text-ink mt-1.5 break-words whitespace-pre-wrap">
              {humanSpec.expectedResult}
            </p>
          </section>
          {humanSpec.postconditions.length > 0 && (
            <section>
              <h3 className="text-body text-ink font-medium">After the run</h3>
              <ul className="text-body text-ink-muted mt-2 list-disc space-y-1.5 pl-5">
                {humanSpec.postconditions.map((condition, index) => (
                  <li key={index}>{condition}</li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </div>
  );
};

const ProposedChanges = function ProposedChanges({
  item,
}: {
  item: PresentedInboxItem;
}) {
  if (!item.payload.files?.length) {
    return null;
  }
  return (
    <section className="space-y-3">
      <h3 className="text-body text-ink font-medium">Proposed changes</h3>
      {item.payload.files.map((file) => (
        <FileDiff key={file.path} file={file} />
      ))}
    </section>
  );
};

export const DecisionDetails = function DecisionDetails({
  projectId,
  item,
  story,
  onChange,
}: {
  projectId: string;
  item: PresentedInboxItem;
  story?: ActivityStory;
  onChange: () => Promise<void>;
}) {
  const { canEdit } = useAuth();
  const router = useRouter();
  const [actionError, setActionError] = useState<{
    id: string;
    message: string;
  } | null>(null);
  const [busy, setBusy] = useState<{ id: string; action: InboxAction } | null>(
    null
  );
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const view = item.presentation;
  const pending = item.status === "pending";
  const stateLabel = (() => {
    if (item.status === "approved") {
      return "Saved";
    }
    if (item.status === "rejected") {
      return "Kept unchanged";
    }
    if (item.status === "answered") {
      return "Answered";
    }
    if (item.status === "dismissed") {
      return "Reviewed";
    }
    return "Saving";
  })();

  const act = async function act(
    itemValue: PresentedInboxItem,
    action: InboxAction
  ) {
    setBusy({ id: itemValue.id, action });
    setActionError(null);
    try {
      if (action === "discuss") {
        const result = await api<{ chatId: string }>(
          apiPath`/projects/${projectId}/inbox/${itemValue.id}/discuss`,
          { method: "POST" }
        );
        router.push(`/p/${projectId}/chats/${result.chatId}`);
      } else if (action === "promote") {
        await api(
          apiPath`/projects/${projectId}/inbox/${itemValue.id}/promote`,
          {
            method: "POST",
          }
        );
        await onChange();
      } else {
        const answer = itemValue.presentation.credentialRequest
          ? "Credentials have been updated. Check the available access and continue."
          : answers[itemValue.id];
        await api(
          apiPath`/projects/${projectId}/inbox/${itemValue.id}/review`,
          {
            method: "POST",
            body: JSON.stringify({ action, answer }),
          }
        );
        await onChange();
      }
    } catch {
      setActionError({
        id: itemValue.id,
        message:
          action === "discuss"
            ? "The conversation could not open. Try again in a moment."
            : "Your decision could not be saved. Refresh the page and try again.",
      });
      // oxlint-disable-next-line react/todo -- Oxlint React Compiler cannot analyze this supported JavaScript syntax; preserve its cleanup and error behavior.
    } finally {
      setBusy(null);
    }
  };

  const actions = function actions(itemValue: PresentedInboxItem) {
    if (!canEdit) {
      return (
        <p className="text-body text-ink-muted">
          An editor can answer or review this decision.
        </p>
      );
    }
    const { type, credentialRequest } = itemValue.presentation;
    const active = busy?.id === itemValue.id;
    const label = (action: InboxAction, ready: string, working: string) =>
      active && busy?.action === action ? working : ready;
    return (
      <>
        {type === "update" && (
          <>
            <Button
              size="sm"
              disabled={busy !== null}
              onClick={() => act(itemValue, "approve")}
            >
              {label("approve", "Update the Spec", "Saving…")}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={busy !== null}
              onClick={() => act(itemValue, "report_bug")}
            >
              {label(
                "report_bug",
                "No, this is a bug in the app",
                "Recording the bug…"
              )}
            </Button>
          </>
        )}
        {(type === "new_check" || type === "feature") && (
          <>
            <Button
              size="sm"
              disabled={busy !== null}
              onClick={() => act(itemValue, "approve")}
            >
              {label(
                "approve",
                type === "feature" ? "Add this feature" : "Add this Spec",
                "Saving…"
              )}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={busy !== null}
              onClick={() => act(itemValue, "reject")}
            >
              {label("reject", "Not now", "Saving your decision…")}
            </Button>
          </>
        )}
        {type === "question" &&
          (credentialRequest ? (
            <>
              <Button asChild size="sm">
                <Link href={`/p/${projectId}/settings#credentials-heading`}>
                  Open credentials
                </Link>
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={busy !== null}
                onClick={() => act(itemValue, "answer")}
              >
                {label("answer", "Check access again", "Continuing…")}
              </Button>
            </>
          ) : (
            <Button
              size="sm"
              disabled={busy !== null || !answers[itemValue.id]?.trim()}
              onClick={() => act(itemValue, "answer")}
            >
              {label("answer", "Send answer and continue", "Sending…")}
            </Button>
          ))}
        {type === "bug" && (
          <>
            {itemValue.payload.regressionIntentId ? (
              <Button asChild variant="outline" size="sm">
                <Link
                  href={`/p/${projectId}#${itemValue.presentation.activityId}`}
                >
                  Follow the new Spec
                </Link>
              </Button>
            ) : (
              <Button
                size="sm"
                disabled={busy !== null}
                onClick={() => act(itemValue, "promote")}
              >
                {label("promote", "Add a regression Spec", "Preparing a Spec…")}
              </Button>
            )}
            <Button
              variant="outline"
              size="sm"
              disabled={busy !== null}
              onClick={() => act(itemValue, "dismiss")}
            >
              {label("dismiss", "Mark as reviewed", "Saving…")}
            </Button>
          </>
        )}
        {type === "help" && (
          <>
            <Button
              size="sm"
              disabled={busy !== null}
              onClick={() => act(itemValue, "discuss")}
            >
              <MessageSquareText size={13} />
              {label("discuss", "Look at it together", "Opening chat…")}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={busy !== null}
              onClick={() => act(itemValue, "ignore")}
            >
              {label("ignore", "Ignore this Spec for now", "Saving…")}
            </Button>
          </>
        )}
        {type !== "help" && (
          <Button
            variant="ghost"
            size="sm"
            disabled={busy !== null}
            onClick={() => act(itemValue, "discuss")}
          >
            <MessageSquareText size={13} />
            {label("discuss", "Discuss in chat", "Opening chat…")}
          </Button>
        )}
      </>
    );
  };

  return (
    <div className="space-y-5">
      {!pending && view.type !== "batch" && (
        <Badge
          variant={(() => {
            if (item.status === "applying") {
              return "running";
            }
            if (item.status === "approved" || item.status === "answered") {
              return "success";
            }
            return "neutral";
          })()}
        >
          {(() => {
            if (item.status === "applying") {
              return (
                <LoaderCircle
                  size={12}
                  className="animate-spin motion-reduce:animate-none"
                />
              );
            }
            if (item.status === "rejected") {
              return <X size={12} />;
            }
            return <Check size={12} />;
          })()}
          {stateLabel}
        </Badge>
      )}
      <div className="space-y-2">
        <p className="text-body text-ink">{view.summary}</p>
        {view.workDone && (
          <p className="text-body text-ink-muted">{view.workDone}</p>
        )}
      </div>
      <Screenshots item={item} />
      <SuggestedBehavior item={item} />
      {view.type === "batch" && (
        <SpecBatchDecision
          key={item.id}
          projectId={projectId}
          item={item}
          onChange={onChange}
        />
      )}
      {item.answer && (
        <p className="text-body text-ink-muted break-words whitespace-pre-wrap">
          <span className="font-medium">Your answer: </span>
          {item.answer}
        </p>
      )}
      {actionError && (
        <Alert variant="danger" role="alert">
          <AlertDescription>{actionError.message}</AlertDescription>
        </Alert>
      )}
      {pending && view.type !== "batch" && (
        <div className="space-y-3">
          {canEdit && view.type === "question" && !view.credentialRequest && (
            <div className="space-y-2">
              <Label htmlFor={`answer-${item.id}`} className="text-body">
                Your answer
              </Label>
              <Textarea
                id={`answer-${item.id}`}
                className="text-body"
                value={answers[item.id] ?? ""}
                onChange={(event) =>
                  setAnswers((current) => ({
                    ...current,
                    [item.id]: event.target.value,
                  }))
                }
                disabled={busy !== null}
                aria-describedby={`answer-help-${item.id}`}
              />
              <p
                id={`answer-help-${item.id}`}
                className="text-meta text-ink-subtle"
              >
                Keep passwords in{" "}
                <Link
                  className="hover:text-ink underline underline-offset-2"
                  href={`/p/${projectId}/settings#credentials-heading`}
                >
                  Settings → Credentials
                </Link>
                .
              </p>
            </div>
          )}
          <div className="flex flex-wrap gap-2">{actions(item)}</div>
          <p className="text-meta text-ink-subtle">{view.consequence}</p>
        </div>
      )}
      {story?.timeline.some(
        (event) =>
          ![view.title, view.summary, view.workDone].includes(event.detail)
      ) && (
        <section className="border-line space-y-3 border-t pt-4">
          <h3 className="text-body text-ink font-medium">What happened</h3>
          <StoryTimeline
            story={story}
            projectId={projectId}
            omit={[view.title, view.summary, view.workDone]}
          />
        </section>
      )}
      <ProposedChanges item={item} />
    </div>
  );
};
