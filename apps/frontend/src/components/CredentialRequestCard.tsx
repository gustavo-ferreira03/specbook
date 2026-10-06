"use client";

import { useState } from "react";
import { AlertCircle, KeyRound, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { errorMessage, resolveChatCredentialRequest } from "@/lib/api";
import type { ChatCredentialRequest } from "@/lib/types";

export function CredentialRequestCard({
    chatId,
    request,
    onResolved,
}: {
    chatId: string;
    request: ChatCredentialRequest;
    onResolved: () => void;
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

    return (
        <article className="mt-5 overflow-hidden rounded-xl border border-line-strong bg-surface shadow-xs md:ml-10" aria-label="Credential request">
            <div className="flex items-start gap-3 border-b border-line bg-surface-soft px-4 py-3">
                <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-surface-hover text-ink-muted" aria-hidden="true">
                    <KeyRound size={15} />
                </span>
                <div className="min-w-0">
                    <p className="text-control font-semibold text-ink">
                        The agent needs the &ldquo;{request.profileName}&rdquo; credential
                    </p>
                    <p className="mt-0.5 flex items-center gap-1.5 text-meta text-ink-muted">
                        <ShieldCheck size={12} className="shrink-0 text-success" aria-hidden="true" />
                        Sent to the encrypted store, never into the conversation or the model.
                    </p>
                </div>
            </div>
            <form className="space-y-3 p-4" onSubmit={submit}>
                {request.fields.map((field) => (
                    <div key={field.key} className="space-y-1.5">
                        <Label htmlFor={`credential-${field.key}`}>{field.label ?? field.key}</Label>
                        <Input
                            id={`credential-${field.key}`}
                            type="password"
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
                    <Button type="button" size="sm" variant="ghost" onClick={() => void dismiss()}>Dismiss</Button>
                    <Button type="submit" size="sm" disabled={sending}>{sending ? "Saving…" : "Save credential"}</Button>
                </div>
            </form>
        </article>
    );
}
