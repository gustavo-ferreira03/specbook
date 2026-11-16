"use client";

import {
  Check,
  CircleDashed,
  KeyRound,
  LoaderCircle,
  MessageSquareText,
  X,
} from "lucide-react";
import { useState } from "react";

import { useAuth } from "@/components/auth-provider";
import { CredentialProfilesCard } from "@/components/credential-profiles-card";
import { FileDiff } from "@/components/file-diff";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button, focusRing } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { api, apiPath, API_URL, errorMessage } from "@/lib/api";
import { requiredValue } from "@/lib/required-value";
import type { PresentedInboxItem, SpecCandidate } from "@/lib/types";
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
type DecisionAction = ReviewAction | "promote" | "discuss";

export interface ChatDecisionDetailsProps {
  projectId: string;
  item: PresentedInboxItem;
  onChange: () => Promise<void>;
  onDiscuss: (item: PresentedInboxItem) => Promise<void>;
  onReviewContext?: () => void;
  onViewSpec?: (specId: string, runId?: string) => void;
  onAnswerQuestion?: (itemId: string) => void;
}

const CandidateStatus = function CandidateStatus({
  candidate,
}: {
  candidate: SpecCandidate;
}) {
  if (candidate.state === "passed") {
    return (
      <Badge variant="success" size="sm">
        <Check size={12} aria-hidden="true" />
        Passed
      </Badge>
    );
  }
  if (candidate.state === "failed") {
    return (
      <Badge variant="danger" size="sm">
        <X size={12} aria-hidden="true" />
        First run failed
      </Badge>
    );
  }
  if (candidate.state === "generating") {
    return (
      <Badge variant="running" size="sm">
        <LoaderCircle
          size={12}
          aria-hidden="true"
          className="animate-spin motion-reduce:animate-none"
        />
        Creating
      </Badge>
    );
  }
  if (candidate.state === "needs_answer") {
    return (
      <Badge variant="warning" size="sm">
        <MessageSquareText size={12} aria-hidden="true" />
        Needs your answer
      </Badge>
    );
  }
  return (
    <Badge variant="neutral" size="sm">
      <CircleDashed size={12} aria-hidden="true" />
      {candidate.state === "stopped" ? "Needs review" : "Waiting"}
    </Badge>
  );
};

const ChatSpecBatch = function ChatSpecBatch({
  projectId,
  item,
  onChange,
  onDiscuss,
  onReviewContext,
  onViewSpec,
  onAnswerQuestion,
}: ChatDecisionDetailsProps) {
  const { canEdit } = useAuth();
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const batch = item.payload.specBatch;
  if (!batch) {
    return (
      <p className="text-body text-ink-muted">
        This list could not load. Reload the conversation to try again.
      </p>
    );
  }
  const pending = item.status === "pending";
  const selectedCandidates = batch.candidates.filter(
    (candidate) => candidate.selected
  );
  const selectedIds = selected.filter((id) =>
    batch.candidates.some((candidate) => candidate.id === id)
  );
  const finished = selectedCandidates.filter((candidate) =>
    ["passed", "failed", "stopped"].includes(candidate.state)
  ).length;

  const save = async function save(
    action: string,
    path: string,
    body: unknown
  ) {
    setBusy(action);
    setError("");
    try {
      await api(path, { method: "POST", body: JSON.stringify(body) });
      await onChange();
    } catch (error_) {
      setError(errorMessage(error_));
      // oxlint-disable-next-line react/todo -- Oxlint React Compiler cannot analyze this supported JavaScript syntax; preserve its cleanup and error behavior.
    } finally {
      setBusy(null);
    }
  };

  const discuss = async function discuss() {
    setBusy("discuss");
    setError("");
    try {
      await onDiscuss(item);
    } catch (error_) {
      setError(errorMessage(error_));
      // oxlint-disable-next-line react/todo -- Oxlint React Compiler cannot analyze this supported JavaScript syntax; preserve its cleanup and error behavior.
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-4">
      {error && (
        <Alert variant="danger" role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {(() => {
        if (pending) {
          return (
            <>
              {batch.contextReviewRequired && (
                <Alert variant="info">
                  <AlertDescription>
                    {batch.contextStatus === "discarded" ? (
                      "These suggestions belong to discarded findings. Use Discuss these Specs to request fresh suggestions in this conversation."
                    ) : (
                      <>
                        Confirm the discovery findings before adding Specs.
                        {onReviewContext && (
                          <Button
                            variant="link"
                            className="ml-1 text-left whitespace-normal"
                            onClick={onReviewContext}
                          >
                            Review findings in this chat
                          </Button>
                        )}
                      </>
                    )}
                  </AlertDescription>
                </Alert>
              )}
              <fieldset
                disabled={!canEdit || busy !== null}
                className="min-w-0"
              >
                <legend className="sr-only">Choose Specs to create</legend>
                {canEdit && (
                  <label className="text-body text-ink-muted mb-2 flex min-h-9 w-fit cursor-pointer items-center gap-2.5">
                    <input
                      type="checkbox"
                      checked={
                        batch.candidates.length > 0 &&
                        selectedIds.length === batch.candidates.length
                      }
                      onChange={(event) =>
                        setSelected(
                          event.target.checked
                            ? batch.candidates.map((candidate) => candidate.id)
                            : []
                        )
                      }
                      className={cn(
                        "accent-primary size-4 shrink-0",
                        focusRing
                      )}
                    />
                    Select all Specs
                  </label>
                )}
                <ul className="divide-line border-line divide-y border-y">
                  {batch.candidates.map((candidate) => (
                    <li key={candidate.id} className="min-w-0 py-3">
                      <label
                        className={cn(
                          "flex items-start gap-3",
                          canEdit && "cursor-pointer"
                        )}
                      >
                        <input
                          type="checkbox"
                          checked={selectedIds.includes(candidate.id)}
                          onChange={(event) =>
                            setSelected((current) =>
                              event.target.checked
                                ? [...current, candidate.id]
                                : current.filter((id) => id !== candidate.id)
                            )
                          }
                          aria-label={`Add ${candidate.title}`}
                          className={cn(
                            "accent-primary mt-1 size-4 shrink-0",
                            focusRing
                          )}
                        />
                        <span className="min-w-0 space-y-1">
                          <span className="text-body text-ink block font-medium break-words">
                            {candidate.title}
                          </span>
                          <span className="text-body text-ink-muted block break-words">
                            {candidate.goal}
                          </span>
                          <span className="text-meta text-ink-subtle block break-words">
                            {candidate.feature}
                          </span>
                          <span className="text-body text-ink-muted block break-words">
                            {candidate.why}
                          </span>
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
              </fieldset>
              {canEdit ? (
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    disabled={
                      !selectedIds.length ||
                      busy !== null ||
                      batch.contextReviewRequired
                    }
                    onClick={() =>
                      save(
                        "select",
                        apiPath`/projects/${projectId}/inbox/${item.id}/select`,
                        { candidateIds: selectedIds }
                      )
                    }
                  >
                    {busy === "select" ? (
                      <>
                        <LoaderCircle
                          size={14}
                          className="animate-spin motion-reduce:animate-none"
                        />
                        Creating selected Specs…
                      </>
                    ) : (
                      `Add selected Specs${selectedIds.length ? ` (${selectedIds.length})` : ""}`
                    )}
                  </Button>
                  <Button
                    variant="ghost"
                    disabled={busy !== null}
                    onClick={() =>
                      save(
                        "dismiss",
                        apiPath`/projects/${projectId}/inbox/${item.id}/review`,
                        { action: "dismiss" }
                      )
                    }
                  >
                    Not now
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy !== null}
                    onClick={() => discuss()}
                  >
                    <MessageSquareText size={13} aria-hidden="true" />
                    {busy === "discuss" ? "Preparing…" : "Discuss these Specs"}
                  </Button>
                </div>
              ) : (
                <p className="text-body text-ink-muted">
                  An editor can select which Specs to add.
                </p>
              )}
              <p className="text-meta text-ink-subtle">
                Each selected Spec is created, validated and run once. Results
                and follow-up questions appear here.
              </p>
            </>
          );
        }
        if (item.status === "approved") {
          return (
            <>
              <output className="text-body text-ink-muted block">
                {finished} of {selectedCandidates.length} selected Specs
                finished.
              </output>
              <ul className="divide-line border-line divide-y border-y">
                {selectedCandidates.map((candidate) => (
                  <li key={candidate.id} className="min-w-0 space-y-2 py-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-body text-ink min-w-0 flex-1 font-medium break-words">
                        {candidate.title}
                      </span>
                      <CandidateStatus candidate={candidate} />
                    </div>
                    <p className="text-body text-ink-muted break-words">
                      {candidate.goal}
                    </p>
                    {candidate.error && (
                      <p className="text-meta text-ink-muted break-words whitespace-pre-wrap">
                        {candidate.error}
                      </p>
                    )}
                    <div className="flex flex-wrap gap-2">
                      {candidate.specId && onViewSpec && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() =>
                            onViewSpec(
                              requiredValue(candidate.specId),
                              candidate.runId
                            )
                          }
                        >
                          Review Spec
                          {candidate.runId ? " and first result" : ""}
                        </Button>
                      )}
                      {candidate.questionId && onAnswerQuestion && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() =>
                            onAnswerQuestion(
                              requiredValue(candidate.questionId)
                            )
                          }
                        >
                          Answer question
                        </Button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            </>
          );
        }
        if (item.status === "applying") {
          return (
            <output className="text-body text-ink-muted flex items-center gap-2">
              <LoaderCircle
                size={14}
                className="animate-spin motion-reduce:animate-none"
              />
              Saving your selection…
            </output>
          );
        }
        return (
          <p className="text-body text-ink-muted">
            These suggestions were set aside. No Specs were created.
          </p>
        );
      })()}
    </div>
  );
};

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
                    className={cn(
                      "border-line bg-surface-soft block w-full overflow-hidden rounded-lg border",
                      focusRing
                    )}
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
                  No screenshot was captured for the earlier run.
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
    <div className="border-line space-y-4 border-t pt-4">
      {description && (
        <p className="text-body text-ink break-words whitespace-pre-wrap">
          {description}
        </p>
      )}
      {humanSpec && (
        <>
          {humanSpec.preconditions.length > 0 && (
            <section>
              <h4 className="text-body text-ink font-medium">Before the run</h4>
              <ul className="text-body text-ink-muted mt-2 list-disc space-y-1.5 pl-5">
                {humanSpec.preconditions.map((condition, index) => (
                  <li key={index}>{condition}</li>
                ))}
              </ul>
            </section>
          )}
          <section>
            <h4 className="text-body text-ink font-medium">
              What this Spec will do
            </h4>
            <ol className="text-body text-ink mt-2 list-decimal space-y-1.5 pl-5">
              {humanSpec.steps.map((step, index) => (
                <li key={index}>{step}</li>
              ))}
            </ol>
          </section>
          <section className="border-line bg-surface-soft rounded-lg border px-4 py-3">
            <h4 className="text-body text-ink font-medium">Expected result</h4>
            <p className="text-body text-ink mt-1.5 break-words whitespace-pre-wrap">
              {humanSpec.expectedResult}
            </p>
          </section>
          {humanSpec.postconditions.length > 0 && (
            <section>
              <h4 className="text-body text-ink font-medium">After the run</h4>
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

export const ChatDecisionDetails =
  /* oxlint-disable eslint/complexity -- Keep the existing render states and their coordinated actions together during the lint migration. */
  function ChatDecisionDetails(props: ChatDecisionDetailsProps) {
    const { projectId, item, onChange, onDiscuss } = props;
    const { canEdit } = useAuth();
    const [busy, setBusy] = useState<DecisionAction | null>(null);
    const [answer, setAnswer] = useState("");
    const [error, setError] = useState("");
    const [credentialsOpen, setCredentialsOpen] = useState(false);
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

    const act = async function act(action: DecisionAction) {
      setBusy(action);
      setError("");
      try {
        if (action === "discuss") {
          await onDiscuss(item);
        } else if (action === "promote") {
          await api(apiPath`/projects/${projectId}/inbox/${item.id}/promote`, {
            method: "POST",
          });
          await onChange();
        } else {
          const response = (() => {
            if (action === "answer") {
              if (view.credentialRequest) {
                return "Credentials have been updated. Check the available access and continue.";
              }
              return answer.trim();
            }
          })();
          await api(apiPath`/projects/${projectId}/inbox/${item.id}/review`, {
            method: "POST",
            body: JSON.stringify({ action, answer: response }),
          });
          await onChange();
        }
      } catch (error_) {
        setError(errorMessage(error_));
        // oxlint-disable-next-line react/todo -- Oxlint React Compiler cannot analyze this supported JavaScript syntax; preserve its cleanup and error behavior.
      } finally {
        setBusy(null);
      }
    };

    const label = (action: DecisionAction, ready: string, working: string) =>
      busy === action ? working : ready;

    return (
      <section
        id={`chat-result-${item.id}`}
        aria-labelledby={`chat-result-title-${item.id}`}
        className="border-line min-w-0 space-y-4 border-y py-4"
      >
        <div className="flex flex-wrap items-center gap-2">
          <h3
            id={`chat-result-title-${item.id}`}
            className="text-body text-ink min-w-0 flex-1 font-semibold break-words"
          >
            {view.title}
          </h3>
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
        </div>
        <div className="space-y-2">
          <p className="text-body text-ink break-words whitespace-pre-wrap">
            {view.summary}
          </p>
          {view.workDone && (
            <p className="text-body text-ink-muted break-words whitespace-pre-wrap">
              {view.workDone}
            </p>
          )}
        </div>
        <Screenshots item={item} />
        <SuggestedBehavior item={item} />
        {view.type === "batch" && <ChatSpecBatch {...props} />}
        {item.answer && (
          <p className="text-body text-ink-muted break-words whitespace-pre-wrap">
            <span className="font-medium">Your answer: </span>
            {item.answer}
          </p>
        )}
        {error && (
          <Alert variant="danger" role="alert">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        {pending && view.type !== "batch" && (
          <div className="space-y-3">
            {canEdit && view.type === "question" && !view.credentialRequest && (
              <div className="space-y-2">
                <Label htmlFor={`chat-answer-${item.id}`} className="text-body">
                  Your answer
                </Label>
                <Textarea
                  id={`chat-answer-${item.id}`}
                  className="text-body"
                  value={answer}
                  onChange={(event) => setAnswer(event.target.value)}
                  disabled={busy !== null}
                  aria-describedby={`chat-answer-help-${item.id}`}
                />
                <p
                  id={`chat-answer-help-${item.id}`}
                  className="text-meta text-ink-subtle"
                >
                  For passwords, use Update credentials. Its encrypted form
                  keeps values out of messages and the model.
                </p>
              </div>
            )}
            {canEdit ? (
              <div className="flex flex-wrap gap-2">
                {view.type === "update" && (
                  <>
                    <Button
                      size="sm"
                      disabled={busy !== null}
                      onClick={() => act("approve")}
                    >
                      {label("approve", "Update the Spec", "Saving…")}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy !== null}
                      onClick={() => act("reject")}
                    >
                      {label("reject", "Keep the current Spec", "Saving…")}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy !== null}
                      onClick={() => act("report_bug")}
                    >
                      {label(
                        "report_bug",
                        "This is a bug in the app",
                        "Recording the bug…"
                      )}
                    </Button>
                  </>
                )}
                {(view.type === "new_check" || view.type === "feature") && (
                  <>
                    <Button
                      size="sm"
                      disabled={busy !== null}
                      onClick={() => act("approve")}
                    >
                      {label(
                        "approve",
                        view.type === "feature"
                          ? "Add this feature"
                          : "Add this Spec",
                        "Saving…"
                      )}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy !== null}
                      onClick={() => act("reject")}
                    >
                      {label("reject", "Not now", "Saving…")}
                    </Button>
                  </>
                )}
                {view.type === "question" && (
                  <>
                    <Button
                      size="sm"
                      disabled={
                        busy !== null ||
                        (!view.credentialRequest && !answer.trim())
                      }
                      onClick={() => act("answer")}
                    >
                      {label(
                        "answer",
                        view.credentialRequest
                          ? "Check access again"
                          : "Send answer and continue",
                        "Continuing…"
                      )}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy !== null}
                      onClick={() => setCredentialsOpen(true)}
                    >
                      <KeyRound size={13} />
                      Update credentials
                    </Button>
                  </>
                )}
                {view.type === "bug" && (
                  <>
                    {item.payload.regressionIntentId ? (
                      <output className="text-body text-ink-muted block">
                        A regression Spec was requested. Its results and
                        questions appear in this chat.
                      </output>
                    ) : (
                      <Button
                        size="sm"
                        disabled={busy !== null}
                        onClick={() => act("promote")}
                      >
                        {label(
                          "promote",
                          "Add a regression Spec",
                          "Preparing a Spec…"
                        )}
                      </Button>
                    )}
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy !== null}
                      onClick={() => act("dismiss")}
                    >
                      {label("dismiss", "Mark as reviewed", "Saving…")}
                    </Button>
                  </>
                )}
                {view.type === "help" && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy !== null}
                    onClick={() => act("ignore")}
                  >
                    {label("ignore", "Ignore this Spec for now", "Saving…")}
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy !== null}
                  onClick={() => act("discuss")}
                >
                  <MessageSquareText size={13} />
                  {label(
                    "discuss",
                    view.type === "help"
                      ? "Look at it together"
                      : "Discuss here",
                    "Preparing…"
                  )}
                </Button>
              </div>
            ) : (
              <p className="text-body text-ink-muted">
                An editor can answer or review this decision.
              </p>
            )}
            <p className="text-meta text-ink-subtle">{view.consequence}</p>
          </div>
        )}
        {item.payload.files?.length ? (
          <section className="space-y-3">
            <h3 className="text-body text-ink font-medium">Proposed changes</h3>
            {item.payload.files.map((file) => (
              <FileDiff key={file.path} file={file} />
            ))}
          </section>
        ) : null}
        <Dialog open={credentialsOpen} onOpenChange={setCredentialsOpen}>
          <DialogContent className="sm:max-w-reading max-h-[85dvh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>Update access</DialogTitle>
              <DialogDescription>
                Save credentials securely, then check access again in this
                conversation.
              </DialogDescription>
            </DialogHeader>
            <CredentialProfilesCard projectId={projectId} />
          </DialogContent>
        </Dialog>
      </section>
    );
  };
/* oxlint-enable eslint/complexity */
