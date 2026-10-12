"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Clipboard, KeyRound, RefreshCw, Trash2 } from "lucide-react";
import { ConfirmDeleteDialog } from "@/components/ConfirmDeleteDialog";
import { RelativeTime } from "@/components/RelativeTime";
import { InlineFeedback, SettingsBlock, SettingsFooter, SettingsRow, SettingsSection, type InlineFeedbackValue } from "@/components/SettingsLayout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { api, apiPath, errorMessage, isAbortError } from "@/lib/api";
import { copyText, selectElementText } from "@/lib/clipboard";

interface AccessToken { id: string; name: string; createdAt: string; lastUsedAt: string | null }

export function AccessTokensSettings() {
    const [tokens, setTokens] = useState<AccessToken[] | null>(null);
    const [name, setName] = useState("");
    const [secret, setSecret] = useState<{ id: string; value: string } | null>(null);
    const [busy, setBusy] = useState(false);
    const [retry, setRetry] = useState(0);
    const [feedback, setFeedback] = useState<InlineFeedbackValue | null>(null);
    const [copied, setCopied] = useState(false);
    const [copyError, setCopyError] = useState(false);
    const [revoke, setRevoke] = useState<AccessToken | null>(null);
    const [revokeError, setRevokeError] = useState("");
    const tokenRef = useRef<HTMLElement | null>(null);
    const triggerRef = useRef<HTMLElement | null>(null);

    useEffect(() => {
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout>;
        async function load() {
            try { setTokens((await api<{ tokens: AccessToken[] }>("/auth/access-tokens", { signal: controller.signal })).tokens); }
            catch (reason) { if (!isAbortError(reason)) setFeedback({ type: "error", text: errorMessage(reason) }); }
            finally { if (!controller.signal.aborted) timer = setTimeout(load, 30_000); }
        }
        void load();
        return () => { controller.abort(); clearTimeout(timer); };
    }, [retry]);

    async function create(event: React.FormEvent) {
        event.preventDefault(); setBusy(true); setFeedback(null); setCopied(false); setCopyError(false);
        try {
            const result = await api<{ token: string; accessToken: AccessToken }>("/auth/access-tokens", { method: "POST", body: JSON.stringify({ name: name.trim() }) });
            setSecret({ id: result.accessToken.id, value: result.token });
            setTokens((current) => [result.accessToken, ...(current ?? [])]);
            setName("");
        } catch (reason) { setFeedback({ type: "error", text: errorMessage(reason) }); }
        finally { setBusy(false); }
    }

    async function copy() {
        if (!secret) return;
        if (await copyText(secret.value)) { setCopied(true); setCopyError(false); }
        else { setCopied(false); setCopyError(true); selectElementText(tokenRef.current); }
    }

    async function revokeToken() {
        if (!revoke) return;
        setBusy(true); setRevokeError("");
        try {
            await api(apiPath`/auth/access-tokens/${revoke.id}`, { method: "DELETE" });
            setTokens((current) => current?.filter((token) => token.id !== revoke.id) ?? []);
            if (secret?.id === revoke.id) setSecret(null);
            setRevoke(null); setFeedback({ type: "success", text: "Access token revoked." });
        } catch (reason) { setRevokeError(errorMessage(reason)); }
        finally { setBusy(false); }
    }

    return <>
        <SettingsSection id="access-tokens-heading" title="Access tokens" description="Connect the CLI to Specbook as your account. Tokens use your current permissions.">
            <form onSubmit={create}>
                <SettingsRow label="Token name" htmlFor="access-token-name" description="Use a name that identifies the device or workflow."><Input id="access-token-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="Work laptop" maxLength={80} required disabled={busy || Boolean(secret)} /></SettingsRow>
                <SettingsFooter feedback={<InlineFeedback feedback={feedback} />}><Button type="submit" disabled={busy || !name.trim() || Boolean(secret)}>{busy && !revoke ? <RefreshCw size={14} className="animate-spin motion-reduce:animate-none" /> : <KeyRound size={14} />}Create token</Button></SettingsFooter>
            </form>
            {secret && <SettingsBlock className="bg-warning-soft/60">
                <div role="status"><p className="flex items-center gap-2 text-body font-semibold text-ink"><KeyRound size={14} className="text-warning-icon" aria-hidden="true" />Copy this token now</p><p className="mt-1 text-meta text-ink-muted">It is shown only once and cannot be recovered.</p></div>
                <div className="mt-3 flex flex-wrap items-stretch gap-2"><code ref={tokenRef} className="flex min-h-9 min-w-0 flex-1 select-all items-center break-all rounded-md border border-warning/25 bg-surface px-3 py-2 font-mono text-meta text-ink">{secret.value}</code><Button type="button" onClick={() => void copy()} aria-live="polite">{copied ? <Check size={14} /> : <Clipboard size={14} />}{copied ? "Copied" : "Copy token"}</Button></div>
                {copyError && <p className="mt-2 text-meta text-danger" role="alert">Clipboard unavailable. The token is selected; press Ctrl+C or Cmd+C to copy it.</p>}
                <p className="mt-3 text-body text-ink-muted">Use <code className="font-mono text-meta">specbook login &lt;server-url&gt;</code> and enter the token when prompted.</p>
                <div className="mt-3 flex justify-end"><Button type="button" variant="outline" size="sm" onClick={() => { setSecret(null); setCopyError(false); }}>I have saved it</Button></div>
            </SettingsBlock>}
            {!tokens ? <SettingsBlock>{feedback?.type === "error" ? <Button type="button" variant="outline" onClick={() => { setFeedback(null); setRetry((value) => value + 1); }}>Try again</Button> : <div role="status" aria-label="Loading access tokens" aria-busy="true"><Skeleton className="h-16 w-full" /></div>}</SettingsBlock>
                : !tokens.length ? <SettingsBlock><p className="text-body text-ink-muted">No access tokens yet. Create one to log in from the CLI.</p></SettingsBlock>
                    : <ul aria-label="Your access tokens">{tokens.map((token) => <li key={token.id} className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-4 last:border-b-0 sm:px-5"><div className="min-w-0"><p className="flex items-center gap-2 break-words text-body font-medium text-ink"><KeyRound size={14} className="shrink-0 text-ink-subtle" aria-hidden="true" />{token.name}</p><p className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-meta text-ink-muted"><RelativeTime value={token.createdAt} prefix="Created" />{token.lastUsedAt ? <RelativeTime value={token.lastUsedAt} prefix="Last used" /> : <span>Never used</span>}</p></div><Button type="button" variant="destructive-soft" size="sm" disabled={busy} aria-label={`Revoke ${token.name}`} onClick={(event) => { triggerRef.current = event.currentTarget; setRevokeError(""); setRevoke(token); }}><Trash2 size={14} />Revoke token</Button></li>)}</ul>}
        </SettingsSection>
        <ConfirmDeleteDialog open={Boolean(revoke)} title="Revoke access token?" description={<>The token named <strong>{revoke?.name}</strong> will stop working immediately. Create a new token to reconnect its CLI.</>} confirmLabel="Revoke token" busyLabel="Revoking…" busy={busy} error={revokeError} returnFocusRef={triggerRef} onCancel={() => { setRevoke(null); setRevokeError(""); }} onConfirm={() => void revokeToken()} />
    </>;
}
