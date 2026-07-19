"use client";

import { useState } from "react";
import { KeyRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { resolveChatCredentialRequest } from "@/lib/api";
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
            setError(err instanceof Error ? err.message : String(err));
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
            setError(err instanceof Error ? err.message : String(err));
        }
    }

    return (
        <article className="my-5 overflow-hidden rounded-[13px] border border-line bg-surface md:ml-[38px]" aria-label="Credential request">
            <div className="border-b border-line bg-surface-soft px-3.5 py-2.5">
                <p className="flex items-center gap-2 text-xs font-bold">
                    <KeyRound size={14} className="text-ink-faint" />
                    The agent needs the &ldquo;{request.profileName}&rdquo; credential
                </p>
                <p className="mt-0.5 text-[0.625rem] text-ink-faint">
                    Sent directly to the encrypted store — never into the conversation or the model.
                </p>
            </div>
            <form className="space-y-2.5 p-3.5" onSubmit={submit}>
                {request.fields.map((field) => (
                    <div key={field.key}>
                        <Label htmlFor={`credential-${field.key}`}>{field.label ?? field.key}</Label>
                        <Input
                            id={`credential-${field.key}`}
                            type={field.secret ? "password" : "text"}
                            autoComplete="off"
                            value={values[field.key] ?? ""}
                            onChange={(event) => setValues({ ...values, [field.key]: event.target.value })}
                        />
                    </div>
                ))}
                {error && <p className="text-[0.65625rem] text-danger">{error}</p>}
                <div className="flex justify-end gap-2 pt-1">
                    <Button type="button" size="sm" variant="ghost" onClick={() => void dismiss()}>Dismiss</Button>
                    <Button type="submit" size="sm" disabled={sending}>{sending ? "Saving..." : "Save credential"}</Button>
                </div>
            </form>
        </article>
    );
}
