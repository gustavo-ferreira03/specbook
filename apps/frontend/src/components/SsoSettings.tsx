"use client";

import { useCallback, useEffect, useState } from "react";
import { KeyRound } from "lucide-react";
import { InlineFeedback, SettingsBlock, SettingsFooter, SettingsRow, SettingsSection, type InlineFeedbackValue } from "@/components/SettingsLayout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { api, errorMessage } from "@/lib/api";

interface SsoConfig { enabled: boolean; issuer: string; clientId: string; hasClientSecret: boolean; defaultRole: "viewer" | "editor"; allowedEmailDomains: string[]; passwordLoginEnabled: boolean }

export function SsoSettings() {
    const [settings, setSettings] = useState<SsoConfig | null>(null);
    const [domains, setDomains] = useState("");
    const [secret, setSecret] = useState("");
    const [callbackUrl, setCallbackUrl] = useState("");
    const [linked, setLinked] = useState(false);
    const [busy, setBusy] = useState(false);
    const [feedback, setFeedback] = useState<InlineFeedbackValue | null>(null);
    const load = useCallback(async () => {
        try { const result = await api<{ sso: SsoConfig; linked: boolean }>("/settings/sso"); setSettings(result.sso); setLinked(result.linked); setDomains(result.sso.allowedEmailDomains.join("\n")); }
        catch (reason) { setFeedback({ type: "error", text: errorMessage(reason) }); }
    }, []);
    useEffect(() => { setCallbackUrl(`${window.location.origin}/api/auth/oidc/callback`); void load(); }, [load]);
    async function save(event: React.FormEvent) {
        event.preventDefault(); if (!settings) return; setBusy(true); setFeedback(null);
        try {
            const { hasClientSecret: _stored, ...config } = settings;
            const result = await api<{ sso: SsoConfig; linked: boolean }>("/settings/sso", { method: "PUT", body: JSON.stringify({ ...config, allowedEmailDomains: domains.split(/[\n,]/).map((value) => value.trim()).filter(Boolean), ...(secret ? { clientSecret: secret } : {}) }) });
            setSecret(""); setSettings(result.sso); setLinked(result.linked); setDomains(result.sso.allowedEmailDomains.join(", ")); setFeedback({ type: "success", text: "Single sign-on settings saved." });
        } catch (reason) { setFeedback({ type: "error", text: errorMessage(reason) }); }
        finally { setBusy(false); }
    }
    async function linkAccount() {
        setBusy(true); setFeedback(null);
        try { const result = await api<{ url: string }>("/auth/oidc/start", { method: "POST", body: JSON.stringify({ link: true }) }); window.location.assign(result.url); }
        catch (reason) { setFeedback({ type: "error", text: errorMessage(reason) }); setBusy(false); }
    }
    const update = (patch: Partial<SsoConfig>) => { setSettings((current) => current ? { ...current, ...patch } : current); setFeedback(null); };
    return <SettingsSection id="sso-heading" title="Single sign-on" description="Connect an OpenID Connect provider for this instance. Existing accounts must link their provider explicitly.">
        {!settings ? <SettingsBlock>{feedback ? <><InlineFeedback feedback={feedback} /><Button type="button" variant="outline" className="mt-3" onClick={() => void load()}>Try again</Button></> : <Skeleton className="h-40 w-full" />}</SettingsBlock> : <form onSubmit={save}>
            <SettingsRow label="Single sign-on" htmlFor="sso-enabled"><Select value={settings.enabled ? "enabled" : "disabled"} onValueChange={(value) => update({ enabled: value === "enabled" })} disabled={busy}><SelectTrigger id="sso-enabled"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="disabled">Disabled</SelectItem><SelectItem value="enabled">Enabled</SelectItem></SelectContent></Select></SettingsRow>
            <SettingsRow label="Issuer URL" htmlFor="sso-issuer" description="The issuer address provided by your identity service."><Input id="sso-issuer" type="url" value={settings.issuer} onChange={(event) => update({ issuer: event.target.value })} placeholder="https://identity.example.com" required={settings.enabled} disabled={busy} /></SettingsRow>
            <SettingsRow label="Callback URL" htmlFor="sso-callback" description="Register this exact redirect address with your identity provider."><Input id="sso-callback" value={callbackUrl} readOnly onFocus={(event) => event.target.select()} /></SettingsRow>
            <SettingsRow label="Client ID" htmlFor="sso-client"><Input id="sso-client" value={settings.clientId} onChange={(event) => update({ clientId: event.target.value })} required={settings.enabled} disabled={busy} autoComplete="off" /></SettingsRow>
            <SettingsRow label="Client secret" htmlFor="sso-secret" description={settings.hasClientSecret ? "A secret is saved. Leave empty to keep it." : "Stored securely on this server."}><Input id="sso-secret" type="password" value={secret} onChange={(event) => setSecret(event.target.value)} autoComplete="new-password" disabled={busy} /></SettingsRow>
            <SettingsRow label="New account role" htmlFor="sso-role" description="Applies when a person signs in with SSO for the first time."><Select value={settings.defaultRole} onValueChange={(value) => update({ defaultRole: value as "viewer" | "editor" })} disabled={busy}><SelectTrigger id="sso-role"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="viewer">Viewer</SelectItem><SelectItem value="editor">Editor</SelectItem></SelectContent></Select></SettingsRow>
            <SettingsRow label="Allowed email domains" htmlFor="sso-domains" description="Separate domains with commas. Leave empty to allow any verified email from this provider."><Input id="sso-domains" value={domains.replaceAll("\n", ", ")} onChange={(event) => setDomains(event.target.value)} placeholder="example.com, subsidiary.com" disabled={busy} /></SettingsRow>
            <SettingsRow label="Password sign-in" htmlFor="password-sign-in" description="Connect your own SSO account before disabling password sign-in."><Select value={settings.passwordLoginEnabled ? "enabled" : "disabled"} onValueChange={(value) => update({ passwordLoginEnabled: value === "enabled" })} disabled={busy}><SelectTrigger id="password-sign-in"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="enabled">Enabled</SelectItem><SelectItem value="disabled" disabled={!linked}>Disabled</SelectItem></SelectContent></Select></SettingsRow>
            <SettingsRow label="Your SSO account" description={linked ? "Your account is linked to this identity provider." : "Link your current Specbook account to your identity provider."}><Button type="button" variant="outline" disabled={busy || !settings.enabled} onClick={() => void linkAccount()}><KeyRound size={14} />{linked ? "Reconnect your account" : "Connect your account"}</Button></SettingsRow>
            <SettingsFooter feedback={<InlineFeedback feedback={feedback} />}><Button type="submit" disabled={busy}>{busy ? "Saving…" : "Save SSO settings"}</Button></SettingsFooter>
        </form>}
    </SettingsSection>;
}
