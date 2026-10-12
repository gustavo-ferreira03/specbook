"use client";

import { useEffect, useRef, useState } from "react";
import { Check, CircleCheck, CircleMinus, Clipboard, HardDrive, RefreshCw, Trash2 } from "lucide-react";
import { ConfirmDeleteDialog } from "@/components/ConfirmDeleteDialog";
import { RelativeTime } from "@/components/RelativeTime";
import { InlineFeedback, SettingsBlock, SettingsFooter, SettingsRow, SettingsSection, type InlineFeedbackValue } from "@/components/SettingsLayout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { api, apiPath, errorMessage, isAbortError } from "@/lib/api";
import { copyText, selectElementText } from "@/lib/clipboard";

interface Runner {
    id: string;
    name: string;
    group: string | null;
    createdAt: string;
    lastSeenAt: string | null;
    online: boolean;
}

export function RunnersSettings() {
    const [runners, setRunners] = useState<Runner[] | null>(null);
    const [name, setName] = useState("");
    const [group, setGroup] = useState("");
    const [secret, setSecret] = useState<{ id: string; value: string } | null>(null);
    const [busy, setBusy] = useState(false);
    const [retry, setRetry] = useState(0);
    const [feedback, setFeedback] = useState<InlineFeedbackValue | null>(null);
    const [copied, setCopied] = useState(false);
    const [copyError, setCopyError] = useState(false);
    const [revoke, setRevoke] = useState<Runner | null>(null);
    const [revokeError, setRevokeError] = useState("");
    const tokenRef = useRef<HTMLElement | null>(null);
    const triggerRef = useRef<HTMLElement | null>(null);

    useEffect(() => {
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout>;
        async function load() {
            try { setRunners((await api<{ runners: Runner[] }>("/runners", { signal: controller.signal })).runners); }
            catch (reason) { if (!isAbortError(reason)) setFeedback({ type: "error", text: errorMessage(reason) }); }
            finally { if (!controller.signal.aborted) timer = setTimeout(load, 15_000); }
        }
        void load();
        return () => { controller.abort(); clearTimeout(timer); };
    }, [retry]);

    async function create(event: React.FormEvent) {
        event.preventDefault(); setBusy(true); setFeedback(null); setCopied(false); setCopyError(false);
        try {
            const result = await api<{ token: string; runner: Runner }>("/runners", { method: "POST", body: JSON.stringify({ name: name.trim(), group: group.trim() || null }) });
            setSecret({ id: result.runner.id, value: result.token });
            setRunners((current) => [result.runner, ...(current ?? [])]);
            setName(""); setGroup("");
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
            await api(apiPath`/runners/${revoke.id}`, { method: "DELETE" });
            setRunners((current) => current?.filter((runner) => runner.id !== revoke.id) ?? []);
            if (secret?.id === revoke.id) setSecret(null);
            setRevoke(null); setFeedback({ type: "success", text: "Runner token revoked." });
        } catch (reason) { setRevokeError(errorMessage(reason)); }
        finally { setBusy(false); }
    }

    return <>
        <SettingsSection id="runners-heading" title="Runners" description="Run Specs inside your private network. Runners connect outbound to Specbook; credentials stay on their machine.">
            <form onSubmit={create}>
                <SettingsRow label="Runner name" htmlFor="runner-name" description="Identify the machine or service that will use this token."><Input id="runner-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="Office runner" maxLength={80} required disabled={busy || Boolean(secret)} /></SettingsRow>
                <SettingsRow label="Runner group" htmlFor="runner-group" description="Optional. Match an environment's runner group to send its runs to these machines."><Input id="runner-group" value={group} onChange={(event) => setGroup(event.target.value)} placeholder="private-staging" maxLength={80} disabled={busy || Boolean(secret)} /></SettingsRow>
                <SettingsFooter feedback={<InlineFeedback feedback={feedback} />}><Button type="submit" disabled={busy || !name.trim() || Boolean(secret)}>{busy && !revoke ? <RefreshCw size={14} className="animate-spin motion-reduce:animate-none" /> : <HardDrive size={14} />}Create runner token</Button></SettingsFooter>
            </form>
            {secret && <SettingsBlock className="bg-warning-soft/60">
                <div role="status"><p className="flex items-center gap-2 text-body font-semibold text-ink"><HardDrive size={14} className="text-warning-icon" aria-hidden="true" />Copy this token now</p><p className="mt-1 text-meta text-ink-muted">It is shown only once and cannot be recovered.</p></div>
                <div className="mt-3 flex flex-wrap items-stretch gap-2"><code ref={tokenRef} className="flex min-h-9 min-w-0 flex-1 select-all items-center break-all rounded-md border border-warning/25 bg-surface px-3 py-2 font-mono text-meta text-ink">{secret.value}</code><Button type="button" onClick={() => void copy()} aria-live="polite">{copied ? <Check size={14} /> : <Clipboard size={14} />}{copied ? "Copied" : "Copy token"}</Button></div>
                {copyError && <p className="mt-2 text-meta text-danger" role="alert">Clipboard unavailable. The token is selected; press Ctrl+C or Cmd+C to copy it.</p>}
                <p className="mt-3 text-body text-ink-muted">On the runner machine, use <code className="font-mono text-meta">specbook runner --server &lt;server-url&gt;</code> and enter this token at the hidden prompt. Automation can set <code className="font-mono text-meta">SPECBOOK_RUNNER_TOKEN</code>.</p>
                <div className="mt-3 flex justify-end"><Button type="button" variant="outline" size="sm" onClick={() => { setSecret(null); setCopyError(false); }}>I have saved it</Button></div>
            </SettingsBlock>}
            {!runners ? <SettingsBlock>{feedback?.type === "error" ? <Button type="button" variant="outline" onClick={() => { setFeedback(null); setRetry((value) => value + 1); }}>Try again</Button> : <div role="status" aria-label="Loading runners" aria-busy="true"><Skeleton className="h-20 w-full" /></div>}</SettingsBlock>
                : !runners.length ? <SettingsBlock><p className="text-body text-ink-muted">Create a token, start the CLI runner, then choose Runner in your project's environment settings.</p></SettingsBlock>
                    : <ul aria-label="Runner tokens">{runners.map((runner) => <li key={runner.id} className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-4 last:border-b-0 sm:px-5">
                        <div className="min-w-0"><p className="flex items-center gap-2 break-words text-body font-medium text-ink"><HardDrive size={14} className="shrink-0 text-ink-subtle" aria-hidden="true" />{runner.name}</p><p className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-meta text-ink-muted"><span className={`inline-flex items-center gap-1.5 ${runner.online ? "text-success" : "text-ink-muted"}`}>{runner.online ? <CircleCheck size={13} aria-hidden="true" /> : <CircleMinus size={13} aria-hidden="true" />}{runner.online ? "Online" : "Offline"}</span><span>{runner.group ? `Group: ${runner.group}` : "No group"}</span>{runner.lastSeenAt ? <RelativeTime value={runner.lastSeenAt} prefix="Last seen" /> : <span>Never connected</span>}<RelativeTime value={runner.createdAt} prefix="Created" /></p></div>
                        <Button type="button" variant="destructive-soft" size="sm" disabled={busy} aria-label={`Revoke ${runner.name}`} onClick={(event) => { triggerRef.current = event.currentTarget; setRevokeError(""); setRevoke(runner); }}><Trash2 size={14} />Revoke token</Button>
                    </li>)}</ul>}
        </SettingsSection>
        <ConfirmDeleteDialog open={Boolean(revoke)} title="Revoke runner token?" description={<>The runner named <strong>{revoke?.name}</strong> will stop claiming and reporting work. Any unfinished runs return to the queue when their lease expires.</>} confirmLabel="Revoke token" busyLabel="Revoking…" busy={busy} error={revokeError} returnFocusRef={triggerRef} onCancel={() => { setRevoke(null); setRevokeError(""); }} onConfirm={() => void revokeToken()} />
    </>;
}
