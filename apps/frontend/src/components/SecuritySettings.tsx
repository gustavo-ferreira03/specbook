"use client";

import { useCallback, useEffect, useState } from "react";
import { InlineFeedback, SettingsBlock, SettingsFooter, SettingsRow, SettingsSection } from "@/components/SettingsLayout";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { api, errorMessage } from "@/lib/api";

interface SecurityConfig { allowAutoApproveFixes: boolean; sendScreenshotsToModel: boolean }

export function SecuritySettings() {
    const [settings, setSettings] = useState<SecurityConfig | null>(null);
    const [busy, setBusy] = useState(false);
    const [feedback, setFeedback] = useState<{ type: "success" | "error"; text: string } | null>(null);
    const load = useCallback(async () => { try { setSettings(await api<SecurityConfig>("/settings/security")); } catch (reason) { setFeedback({ type: "error", text: errorMessage(reason) }); } }, []);
    useEffect(() => { void load(); }, [load]);
    async function save(event: React.FormEvent) {
        event.preventDefault(); if (!settings) return; setBusy(true); setFeedback(null);
        try { setSettings(await api<SecurityConfig>("/settings/security", { method: "PUT", body: JSON.stringify(settings) })); setFeedback({ type: "success", text: "Agent safety settings saved." }); }
        catch (reason) { setFeedback({ type: "error", text: errorMessage(reason) }); }
        finally { setBusy(false); }
    }
    return <SettingsSection id="agent-safety-heading" title="Agent safety" description="Controls that apply to every project on this instance.">
        {!settings ? <SettingsBlock>{feedback ? <><InlineFeedback feedback={feedback} /><Button type="button" variant="outline" className="mt-3" onClick={() => void load()}>Try again</Button></> : <Skeleton className="h-32 w-full" />}</SettingsBlock> : <form onSubmit={save}>
            <SettingsRow label="Automatic locator fixes" htmlFor="automatic-fixes" description="Allow admins to enable verified locator fixes per project. Behavior changes always require review."><Select value={settings.allowAutoApproveFixes ? "enabled" : "disabled"} onValueChange={(value) => setSettings({ ...settings, allowAutoApproveFixes: value === "enabled" })} disabled={busy}><SelectTrigger id="automatic-fixes"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="disabled">Disabled</SelectItem><SelectItem value="enabled">Allowed per project</SelectItem></SelectContent></Select></SettingsRow>
            <SettingsRow label="Screenshots sent to model" htmlFor="model-screenshots" description="When disabled, screenshots remain local run evidence and are not sent to the model provider."><Select value={settings.sendScreenshotsToModel ? "enabled" : "disabled"} onValueChange={(value) => setSettings({ ...settings, sendScreenshotsToModel: value === "enabled" })} disabled={busy}><SelectTrigger id="model-screenshots"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="enabled">Enabled</SelectItem><SelectItem value="disabled">Disabled</SelectItem></SelectContent></Select></SettingsRow>
            <SettingsFooter feedback={<InlineFeedback feedback={feedback} />}><Button type="submit" disabled={busy}>{busy ? "Saving..." : "Save safety settings"}</Button></SettingsFooter>
        </form>}
    </SettingsSection>;
}
