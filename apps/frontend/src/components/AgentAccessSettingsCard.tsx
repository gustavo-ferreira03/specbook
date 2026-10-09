"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Clipboard, KeyRound, RefreshCw, RotateCw, Trash2 } from "lucide-react";
import { ConfirmDeleteDialog } from "@/components/ConfirmDeleteDialog";
import { RelativeTime } from "@/components/RelativeTime";
import { InlineFeedback, SettingsBlock, SettingsFooter, SettingsRow, SettingsSection } from "@/components/SettingsLayout";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { API_URL, api, apiPath, errorMessage, isAbortError } from "@/lib/api";
import { mcpSnippet } from "@/lib/ci-snippets";
import { copyText, selectElementText } from "@/lib/clipboard";

interface AgentSettings {
    token: { configured: boolean; prefix: string | null; createdAt: string | null; lastUsedAt: string | null };
    agentContractPolicy: "apply_declared" | "propose_only";
    agentsMayProvideCredentials: boolean;
}

export function AgentAccessSettingsCard({ projectId, oneTimeToken, onOneTimeTokenChange }: {
    projectId: string;
    oneTimeToken: string | null;
    onOneTimeTokenChange: (token: string | null) => void;
}) {
    const [settings, setSettings] = useState<AgentSettings | null>(null);
    const [savedPolicy, setSavedPolicy] = useState("");
    const [error, setError] = useState("");
    const [notice, setNotice] = useState("");
    const [busy, setBusy] = useState(false);
    const [retryKey, setRetryKey] = useState(0);
    const [confirmation, setConfirmation] = useState<"rotate" | "revoke" | null>(null);
    const [confirmError, setConfirmError] = useState("");
    const [copied, setCopied] = useState<"token" | "command" | null>(null);
    const [copyError, setCopyError] = useState<"token" | "command" | null>(null);
    const tokenRef = useRef<HTMLElement | null>(null);
    const commandRef = useRef<HTMLPreElement | null>(null);
    const confirmTriggerRef = useRef<HTMLElement | null>(null);
    const [publicApiUrl, setPublicApiUrl] = useState(API_URL);
    useEffect(() => { setPublicApiUrl(`${window.location.origin}${API_URL}`); }, []);
    const command = mcpSnippet(publicApiUrl, projectId, oneTimeToken);
    const policyKey = (value: AgentSettings) => JSON.stringify([value.agentContractPolicy, value.agentsMayProvideCredentials]);

    useEffect(() => {
        const controller = new AbortController();
        void api<AgentSettings>(apiPath`/projects/${projectId}/agent-access`, { signal: controller.signal }).then((result) => {
            setSettings(result);
            setSavedPolicy(JSON.stringify([result.agentContractPolicy, result.agentsMayProvideCredentials]));
            setError("");
        }).catch((caught) => { if (!isAbortError(caught)) setError(errorMessage(caught)); });
        return () => controller.abort();
    }, [projectId, retryKey]);

    async function copy(value: string, kind: "token" | "command") {
        if (await copyText(value)) {
            setCopyError(null);
            setCopied(kind);
            window.setTimeout(() => setCopied((current) => current === kind ? null : current), 1800);
        } else {
            setCopied(null);
            setCopyError(kind);
            selectElementText(kind === "token" ? tokenRef.current : commandRef.current);
        }
    }

    async function changeToken(action: "create" | "rotate" | "revoke") {
        setBusy(true);
        setError("");
        setNotice("");
        setConfirmError("");
        try {
            if (action === "revoke") {
                await api(apiPath`/projects/${projectId}/agent-access/token`, { method: "DELETE" });
                onOneTimeTokenChange(null);
                setSettings((current) => current && { ...current, token: { configured: false, prefix: null, createdAt: null, lastUsedAt: null } });
            } else {
                const result = await api<{ token: string; access: AgentSettings["token"] }>(apiPath`/projects/${projectId}/agent-access/token`, { method: "POST" });
                onOneTimeTokenChange(result.token);
                setSettings((current) => current && { ...current, token: result.access });
            }
            setConfirmation(null);
            setNotice(action === "revoke" ? "Agent token revoked." : action === "rotate" ? "Agent token rotated. Update your coding agents." : "Agent token created.");
        } catch (caught) {
            if (action === "create") setError(errorMessage(caught));
            else setConfirmError(errorMessage(caught));
        } finally { setBusy(false); }
    }

    async function savePolicy() {
        if (!settings) return;
        setBusy(true);
        setError("");
        setNotice("");
        try {
            await api(apiPath`/projects/${projectId}/agent-access`, { method: "PATCH", body: JSON.stringify({ agentContractPolicy: settings.agentContractPolicy, agentsMayProvideCredentials: settings.agentsMayProvideCredentials }) });
            setSavedPolicy(policyKey(settings));
            setNotice("Agent access settings saved.");
        } catch (caught) { setError(errorMessage(caught)); }
        finally { setBusy(false); }
    }

    if (!settings) return <SettingsSection id="agent-access-heading" title="Agent access"><SettingsBlock>{error ? <p role="alert" className="text-body text-danger">{error}<Button variant="outline" size="sm" className="mt-3" onClick={() => setRetryKey((value) => value + 1)}>Try again</Button></p> : <Skeleton className="h-32 w-full" />}</SettingsBlock></SettingsSection>;
    return <SettingsSection id="agent-access-heading" title="Agent access" description="Connect a coding agent to Specbook as its QA subagent. Conversations appear in Chats.">
        <SettingsRow label="Project agent token" description="Agent tokens are separate from CI tokens and allow conversations and Spec changes.">
            <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0"><p className="text-body text-ink">{settings.token.configured ? <code className="font-mono text-meta">{settings.token.prefix}...</code> : "No agent token yet"}</p>{settings.token.configured && <p className="mt-0.5 text-meta text-ink-subtle">{settings.token.lastUsedAt ? <RelativeTime value={settings.token.lastUsedAt} prefix="Last used" /> : "Never used"}</p>}</div>
                <div className="flex flex-wrap gap-2">
                    <Button variant={settings.token.configured ? "outline" : "default"} disabled={busy} onClick={(event) => { if (!settings.token.configured) void changeToken("create"); else { confirmTriggerRef.current = event.currentTarget; setConfirmError(""); setConfirmation("rotate"); } }}>{settings.token.configured ? <RotateCw size={14} /> : <KeyRound size={14} />}{settings.token.configured ? "Rotate token" : "Create token"}</Button>
                    {settings.token.configured && <Button variant="destructive-soft" disabled={busy} onClick={(event) => { confirmTriggerRef.current = event.currentTarget; setConfirmError(""); setConfirmation("revoke"); }}><Trash2 size={14} />Revoke</Button>}
                </div>
            </div>
        </SettingsRow>
        {oneTimeToken && <SettingsBlock className="bg-warning-soft/60"><p role="alert" className="text-body font-semibold text-ink">Copy this token now</p><p className="mt-1 text-meta text-ink-muted">It is shown only once and cannot be recovered.</p><div className="mt-3 flex flex-wrap items-stretch gap-2"><code ref={tokenRef} className="flex min-w-0 flex-1 select-all items-center break-all rounded-md border border-warning/25 bg-surface px-3 py-2 font-mono text-meta text-ink">{oneTimeToken}</code><Button onClick={() => void copy(oneTimeToken, "token")} aria-live="polite">{copied === "token" ? <Check size={14} /> : <Clipboard size={14} />}{copied === "token" ? "Copied" : "Copy token"}</Button></div>{copyError === "token" && <p role="alert" className="mt-2 text-meta text-danger">Clipboard unavailable. The token is selected; press Ctrl+C or Cmd+C to copy it.</p>}<div className="mt-3 flex justify-end"><Button variant="outline" size="sm" onClick={() => onOneTimeTokenChange(null)}>I have saved it</Button></div></SettingsBlock>}
        <SettingsRow label="Coding agent (MCP)" description="Run this command in your terminal to connect Claude Code.">
            <div className="space-y-3"><pre ref={commandRef} tabIndex={0} aria-label="Claude Code MCP setup command" className="overflow-auto rounded-md border border-line bg-surface-soft p-3 font-mono text-meta leading-5 text-ink focus-visible:outline-2 focus-visible:outline-ring"><code>{command}</code></pre><div className="flex flex-wrap items-center justify-between gap-3"><p className="min-w-0 flex-1 text-meta text-ink-muted">{oneTimeToken ? "The command includes your new agent token." : settings.token.configured ? "Replace <token> with your saved agent token." : "Create an agent token above to connect."}</p><Button variant="outline" size="sm" disabled={!settings.token.configured || busy} onClick={() => void copy(command, "command")} aria-live="polite">{copied === "command" ? <Check size={14} /> : <Clipboard size={14} />}{copied === "command" ? "Copied" : "Copy command"}</Button></div>{copyError === "command" && <p role="alert" className="text-meta text-danger">Clipboard unavailable. The command is selected; press Ctrl+C or Cmd+C to copy it.</p>}</div>
        </SettingsRow>
        <SettingsRow label="Contract changes requested by agents" htmlFor="agent-contract-policy" description="Choose how intentional behaviour changes affect existing Specs."><Select value={settings.agentContractPolicy} disabled={busy} onValueChange={(value) => setSettings({ ...settings, agentContractPolicy: value as AgentSettings["agentContractPolicy"] })}><SelectTrigger id="agent-contract-policy"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="apply_declared">Apply declared changes</SelectItem><SelectItem value="propose_only">Propose for approval</SelectItem></SelectContent></Select><p className="mt-1.5 text-meta text-ink-muted">{settings.agentContractPolicy === "apply_declared" ? "Agents may update contracts for behaviour changes they explicitly declare. Other failures are reported as possible app bugs." : "Updates to existing Specs become proposals. An agent or human must approve each change."}</p></SettingsRow>
        <SettingsRow label="Agents may provide credentials" htmlFor="agent-credentials" description="Credential values go through secure actions and stay outside chat messages and model context."><Select value={String(settings.agentsMayProvideCredentials)} disabled={busy} onValueChange={(value) => setSettings({ ...settings, agentsMayProvideCredentials: value === "true" })}><SelectTrigger id="agent-credentials"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="true">Allowed</SelectItem><SelectItem value="false">Human only</SelectItem></SelectContent></Select></SettingsRow>
        <SettingsFooter feedback={<InlineFeedback feedback={error ? { type: "error", text: error } : notice ? { type: "success", text: notice } : null} />}><Button disabled={busy || policyKey(settings) === savedPolicy} onClick={() => void savePolicy()}>{busy && <RefreshCw size={14} className="animate-spin motion-reduce:animate-none" />}Save changes</Button></SettingsFooter>
        <ConfirmDeleteDialog open={confirmation !== null} title={confirmation === "rotate" ? "Rotate agent token?" : "Revoke agent token?"} description={confirmation === "rotate" ? "The current token stops working immediately. Update each coding agent with the new token." : "Coding agents using this token will lose access to this project."} confirmLabel={confirmation === "rotate" ? "Rotate token" : "Revoke token"} busyLabel={confirmation === "rotate" ? "Rotating…" : "Revoking…"} busy={busy} error={confirmError} returnFocusRef={confirmTriggerRef} onCancel={() => { setConfirmation(null); setConfirmError(""); }} onConfirm={() => confirmation && void changeToken(confirmation)} />
    </SettingsSection>;
}
