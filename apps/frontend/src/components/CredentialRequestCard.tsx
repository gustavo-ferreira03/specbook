"use client";

import { useState } from "react";
import { AlertCircle, KeyRound, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { errorMessage, resolveChatCredentialRequest } from "@/lib/api";
import type { ChatCredentialRequest } from "@/lib/types";
import { cn } from "@/lib/utils";

export function CredentialRequestCard({
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

    async function submit(event: React.FormEvent<HTMLFormElement>) {
        event.preventDefault();
        setSending(true);
        setError("");
        try {
            await resolveChatCredentialRequest(chatId, request.id, { action: "submit", values });
            onResolved();
        } catch (err) {
            setError(errorMessage(err));
        } finally {
            setSending(false);
        }
    }

    async function dismiss() {
        setError("");
        try {
            await resolveChatCredentialRequest(chatId, request.id, { action: "dismiss" });
            onResolved();
        } catch (err) {
            setError(errorMessage(err));
        }
    }

    const host = request.origin ? new URL(request.origin).host : null;
    const copy = request.kind === "login"
        ? { title: `Sign in to ${host}`, note: `Filled only on ${request.origin}. The agent sees the email or username; the password is encrypted and never shown to it or in the conversation.`, submit: "Save and sign in", sending: "Saving…", dismiss: "Not now" }
        : request.kind === "code"
            ? { title: `Verification code for ${host}`, note: "Entered on the page only. Never stored and never sent to the conversation or the model.", submit: "Enter code", sending: "Entering…", dismiss: "Dismiss" }
            : { title: `The agent needs the \u201c${request.profileName}\u201d credential`, note: "Sent to the encrypted store, never into the conversation or the model.", submit: "Save credential", sending: "Saving…", dismiss: "Dismiss" };

    return (
        <article className={cn("mt-5 overflow-hidden rounded-xl border border-line-strong bg-surface shadow-xs", !nested && "md:ml-10")} aria-label="Credential request">
            <div className="flex items-start gap-3 border-b border-line bg-surface-soft px-4 py-3">
                <span className="flex size-8 shrink-0 items-center justify-center rounded-full border border-line bg-surface text-ink-muted" aria-hidden="true">
                    <KeyRound size={15} />
                </span>
                <div className="min-w-0">
                    <p className="text-control font-semibold text-ink">{copy.title}</p>
                    <p className="mt-0.5 flex items-center gap-1.5 text-meta text-ink-muted">
                        <ShieldCheck size={12} className="shrink-0 text-success" aria-hidden="true" />
                        {copy.note}
                    </p>
                </div>
            </div>
            <form className="space-y-3 p-4" onSubmit={submit}>
                {request.fields.map((field, index) => (
                    <div key={field.key} className="space-y-1.5">
                        <Label htmlFor={`credential-${field.key}`}>{field.label ?? field.key}</Label>
                        <Input
                            id={`credential-${field.key}`}
                            type={request.kind === "login" && field.key === "username" || request.kind === "code" ? "text" : "password"}
                            inputMode={request.kind === "code" ? "numeric" : undefined}
                            autoFocus={index === 0}
                            autoComplete="off"
                            value={values[field.key] ?? ""}
                            onChange={(event) => setValues({ ...values, [field.key]: event.target.value })}
                        />
                    </div>
                ))}
                {error && (
                    <p className="flex items-start gap-1.5 text-meta text-danger" role="alert">
                        <AlertCircle size={13} className="mt-0.5 shrink-0" aria-hidden="true" /> {error}
                    </p>
                )}
                <div className="flex justify-end gap-2 pt-1">
                    <Button type="button" size="sm" variant="ghost" onClick={() => void dismiss()}>{copy.dismiss}</Button>
                    <Button type="submit" size="sm" disabled={sending}>{sending ? copy.sending : copy.submit}</Button>
                </div>
            </form>
        </article>
    );
}
