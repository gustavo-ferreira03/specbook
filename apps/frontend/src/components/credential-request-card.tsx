"use client";

import { AlertCircle, KeyRound, ShieldCheck } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { errorMessage, resolveChatCredentialRequest } from "@/lib/api";
import type { ChatCredentialRequest } from "@/lib/types";
import { cn } from "@/lib/utils";

export const CredentialRequestCard = function CredentialRequestCard({
  chatId,
  request,
  onResolved,
  nested = false,
}: {
  chatId: string;
  request: ChatCredentialRequest;
  onResolved: () => void;
  nested?: boolean;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);

  const submit = async function submit(
    event: React.FormEvent<HTMLFormElement>
  ) {
    event.preventDefault();
    setSending(true);
    setError("");
    try {
      await resolveChatCredentialRequest(chatId, request.id, {
        action: "submit",
        values,
      });
      onResolved();
    } catch (error_) {
      setError(errorMessage(error_));
      // oxlint-disable-next-line react/todo -- Oxlint React Compiler cannot analyze this supported JavaScript syntax; preserve its cleanup and error behavior.
    } finally {
      setSending(false);
    }
  };

  const dismiss = async function dismiss() {
    setError("");
    try {
      await resolveChatCredentialRequest(chatId, request.id, {
        action: "dismiss",
      });
      onResolved();
    } catch (error_) {
      setError(errorMessage(error_));
    }
  };

  const host = request.origin ? new URL(request.origin).host : null;
  const copy = (() => {
    if (request.kind === "login") {
      return {
        title: `Sign in to ${host}`,
        note: `Filled only on ${request.origin}. The agent sees the email or username; the password is encrypted and never shown to it or in the conversation.`,
        submit: "Save and sign in",
        sending: "Saving…",
        dismiss: "Not now",
      };
    }
    if (request.kind === "code") {
      return {
        title: `Verification code for ${host}`,
        note: "Entered on the page only. Never stored and never sent to the conversation or the model.",
        submit: "Enter code",
        sending: "Entering…",
        dismiss: "Dismiss",
      };
    }
    return {
      title: `The agent needs the \u201C${request.profileName}\u201D credential`,
      note: "Sent to the encrypted store, never into the conversation or the model.",
      submit: "Save credential",
      sending: "Saving…",
      dismiss: "Dismiss",
    };
  })();

  return (
    <article
      className={cn(
        "border-line-strong bg-surface mt-5 overflow-hidden rounded-xl border shadow-xs",
        !nested && "md:ml-10"
      )}
      aria-label="Credential request"
    >
      <div className="border-line bg-surface-soft flex items-start gap-3 border-b px-4 py-3">
        <span
          className="border-line bg-surface text-ink-muted flex size-8 shrink-0 items-center justify-center rounded-full border"
          aria-hidden="true"
        >
          <KeyRound size={15} />
        </span>
        <div className="min-w-0">
          <p className="text-control text-ink font-semibold">{copy.title}</p>
          <p className="text-meta text-ink-muted mt-0.5 flex items-center gap-1.5">
            <ShieldCheck
              size={12}
              className="text-success shrink-0"
              aria-hidden="true"
            />
            {copy.note}
          </p>
        </div>
      </div>
      <form className="space-y-3 p-4" onSubmit={submit}>
        {request.fields.map((field, index) => (
          <div key={field.key} className="space-y-1.5">
            <Label htmlFor={`credential-${field.key}`}>
              {field.label ?? field.key}
            </Label>
            <Input
              id={`credential-${field.key}`}
              type={
                request.kind === "code" ||
                !(
                  field.sensitive ??
                  (request.kind !== "login" || field.key !== "username")
                )
                  ? "text"
                  : "password"
              }
              inputMode={request.kind === "code" ? "numeric" : undefined}
              autoFocus={index === 0}
              autoComplete="off"
              value={values[field.key] ?? ""}
              onChange={(event) =>
                setValues({ ...values, [field.key]: event.target.value })
              }
            />
          </div>
        ))}
        {error && (
          <p
            className="text-meta text-danger flex items-start gap-1.5"
            role="alert"
          >
            <AlertCircle
              size={13}
              className="mt-0.5 shrink-0"
              aria-hidden="true"
            />{" "}
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2 pt-1">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => dismiss()}
          >
            {copy.dismiss}
          </Button>
          <Button type="submit" size="sm" disabled={sending}>
            {sending ? copy.sending : copy.submit}
          </Button>
        </div>
      </form>
    </article>
  );
};
