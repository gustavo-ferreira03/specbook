"use client";


import { useEffect, useState } from "react";
import { Check, ChevronDown, Clock3, RefreshCw, X } from "lucide-react";
import { RelativeTime } from "@/components/RelativeTime";
import { StatusPill } from "@/components/StatusPill";
import { InlineFeedback, SettingsBlock, SettingsFooter, SettingsRow, SettingsSection } from "@/components/SettingsLayout";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { api, apiPath, errorMessage, getProjectTree, isAbortError } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import type { SpecSummary } from "@/lib/types";

interface AutomationSettings {
    projectId: string;
    cron: string | null;
    specIds: string[];
    healFailures: boolean;
    webhookConfigured: boolean;
    allowPrivateWebhook: boolean;
    webhookHost: string | null;
    nextRunAt: string | null;
    lastBatchId: string | null;
    lastBatchStatus: string | null;
    lastError: string | null;
    updatedAt: string;
}

interface AutomationResponse {
    automation: AutomationSettings;
    notifications: { id: string; batchId: string; status: string; attempts: number; nextAttemptAt: string | null; deliveredAt: string | null; lastError: string | null; createdAt: string }[];
}

export function AutomationSettingsCard({ projectId }: { projectId: string }) {
    const [autonomy, setAutonomy] = useState("propose");
    const [savedAutonomy, setSavedAutonomy] = useState("propose");
    const [settings, setSettings] = useState<AutomationSettings | null>(null);
    const [notifications, setNotifications] = useState<AutomationResponse["notifications"]>([]);
    const [specs, setSpecs] = useState<SpecSummary[]>([]);
    const [cron, setCron] = useState("");
    const [specIds, setSpecIds] = useState<string[]>([]);
    const [healFailures, setHealFailures] = useState(true);
    const [allowPrivateWebhook, setAllowPrivateWebhook] = useState(false);
    const [webhookUrl, setWebhookUrl] = useState("");
    const [removeWebhook, setRemoveWebhook] = useState(false);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [loadError, setLoadError] = useState("");
    const [specsError, setSpecsError] = useState("");
    const [feedback, setFeedback] = useState<{ type: "success" | "error"; text: string } | null>(null);
    const [retryKey, setRetryKey] = useState(0);

    function applySettings(value: AutomationSettings) {
        setSettings(value);
        setCron(value.cron ?? "");
        setSpecIds(value.specIds);
        setHealFailures(value.healFailures);
        setAllowPrivateWebhook(value.allowPrivateWebhook);
        setWebhookUrl("");
        setRemoveWebhook(false);
    }

    useEffect(() => {
        const controller = new AbortController();
        setLoading(true);
        setLoadError("");
        setSpecsError("");
        Promise.all([
            api<AutomationResponse>(apiPath`/projects/${projectId}/automation`, { signal: controller.signal }),
            api<{ autonomy: string }>(apiPath`/projects/${projectId}/steward`, { signal: controller.signal }),
        ])
            .then(([result, steward]) => {
                setAutonomy(steward.autonomy);
                setSavedAutonomy(steward.autonomy);
                applySettings(result.automation);
                setNotifications(result.notifications);
            })
            .catch((error) => { if (!isAbortError(error)) setLoadError(errorMessage(error)); })
            .finally(() => { if (!controller.signal.aborted) setLoading(false); });
        getProjectTree(projectId, controller.signal)
            .then((result) => setSpecs(result.specs))
            .catch((error) => { if (!isAbortError(error)) setSpecsError(errorMessage(error)); });
        return () => controller.abort();
    }, [projectId, retryKey]);

    const dirty = settings !== null && (
        autonomy !== savedAutonomy
        || cron.trim() !== (settings.cron ?? "")
        || JSON.stringify([...specIds].sort()) !== JSON.stringify([...settings.specIds].sort())
        || healFailures !== settings.healFailures
        || allowPrivateWebhook !== settings.allowPrivateWebhook
        || Boolean(webhookUrl.trim())
        || removeWebhook
    );
    const runnable = specs.filter((spec) => spec.status !== "invalid");

    async function save() {
        setSaving(true);
        setFeedback(null);
        try {
            await api(apiPath`/projects/${projectId}/steward`, { method: "PUT", body: JSON.stringify({ autonomy }) });
            setSavedAutonomy(autonomy);
            const result = await api<AutomationResponse>(apiPath`/projects/${projectId}/automation`, {
                method: "PUT",
                body: JSON.stringify({
                    cron: cron.trim() || null,
                    specIds,
                    healFailures,
                    allowPrivateWebhook,
                    ...(removeWebhook ? { webhookUrl: null } : webhookUrl.trim() ? { webhookUrl: webhookUrl.trim() } : {}),
                }),
            });
            applySettings(result.automation);
            setNotifications(result.notifications);
            setFeedback({ type: "success", text: "Automation settings saved." });
        } catch (error) {
            setFeedback({ type: "error", text: errorMessage(error) });
        } finally {
            setSaving(false);
        }
    }

    return (
        <div className="space-y-10">
            <SettingsSection id="automation-settings-heading" title="Automation">
                {loading ? (
                    <div aria-label="Loading automation settings" aria-busy="true" role="status">
                        {[0, 1, 2].map((row) => <SettingsBlock key={row} className="grid gap-3 md:grid-cols-[13rem_1fr] md:gap-8"><Skeleton className="h-4 w-24 md:mt-2.5" /><Skeleton className="h-9" /></SettingsBlock>)}
                    </div>
                ) : loadError ? (
                    <SettingsBlock>
                        <Alert variant="danger" role="alert"><AlertTitle>Automation settings could not load</AlertTitle><AlertDescription>{loadError}</AlertDescription></Alert>
                        <Button type="button" variant="outline" size="sm" className="mt-3" onClick={() => setRetryKey((key) => key + 1)}><RefreshCw size={14} /> Try again</Button>
                    </SettingsBlock>
                ) : settings && (
                    <form onSubmit={(event) => { event.preventDefault(); void save(); }}>
                        <SettingsRow label="Autonomy" htmlFor="automation-autonomy" description="The agent watches for changes without a schedule.">
                            <Select value={autonomy} onValueChange={(value) => { setAutonomy(value); setFeedback(null); }} disabled={saving}>
                                <SelectTrigger id="automation-autonomy"><SelectValue /></SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="observe">Observe changes</SelectItem>
                                    <SelectItem value="propose">Investigate and repair</SelectItem>
                                </SelectContent>
                            </Select>
                            <p className="mt-1.5 text-meta text-ink-subtle">Verified repairs that keep the expected behavior are saved automatically. Behavior and assertion changes always need your approval.</p>
                        </SettingsRow>
                        <SettingsRow label="Schedule" htmlFor="automation-cron" description="Optional, in UTC.">
                            <Input id="automation-cron" value={cron} onChange={(event) => { setCron(event.target.value); setFeedback(null); }} placeholder="0 9 * * 1-5" disabled={saving} className="font-mono" autoComplete="off" aria-describedby="automation-cron-help" />
                            <p id="automation-cron-help" className="mt-1.5 text-meta text-ink-subtle">Five cron fields: minute, hour, day, month, weekday. This example runs at 09:00 UTC on weekdays. Leave blank to turn scheduled runs off.</p>
                            {settings.nextRunAt && <p className="mt-2 text-meta text-ink-muted">Next run: <time dateTime={settings.nextRunAt}>{formatDateTime(settings.nextRunAt)}</time> (your local time).</p>}
                        </SettingsRow>
                        <SettingsRow label="Specs to run" description="Runs all valid Specs unless you select a subset.">
                            <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                    <Button type="button" variant="outline" disabled={saving || Boolean(specsError)} className="w-full justify-between" aria-label="Choose Specs for scheduled runs">{specIds.length ? `${specIds.length} selected ${specIds.length === 1 ? "Spec" : "Specs"}` : "All runnable Specs"}<ChevronDown size={14} /></Button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="start" className="max-h-80 max-w-[calc(100vw-3rem)]">
                                    <DropdownMenuCheckboxItem checked={specIds.length === 0} onCheckedChange={() => { setSpecIds([]); setFeedback(null); }}>All runnable Specs</DropdownMenuCheckboxItem>
                                    {runnable.length > 0 && <DropdownMenuSeparator />}
                                    {runnable.map((spec) => <DropdownMenuCheckboxItem key={spec.id} checked={specIds.includes(spec.id)} onSelect={(event) => event.preventDefault()} onCheckedChange={(checked) => { setSpecIds((current) => checked ? [...current, spec.id] : current.filter((id) => id !== spec.id)); setFeedback(null); }}><span className="max-w-reading truncate">{spec.title}</span></DropdownMenuCheckboxItem>)}
                                </DropdownMenuContent>
                            </DropdownMenu>
                            {specsError && <p role="alert" className="mt-1.5 text-meta text-danger">Specs could not load: {specsError}</p>}
                            {specIds.length > 0 && <p className="mt-1.5 break-words text-meta text-ink-subtle">{specIds.map((id) => specs.find((spec) => spec.id === id)?.title ?? "Unavailable Spec").join(", ")}</p>}
                        </SettingsRow>
                        <SettingsRow label="Investigate failures" htmlFor="automation-heal" description="Find suggested updates, app problems, and questions in Overview.">
                            <Select value={healFailures ? "enabled" : "disabled"} onValueChange={(value) => { setHealFailures(value === "enabled"); setFeedback(null); }} disabled={saving}>
                                <SelectTrigger id="automation-heal"><SelectValue /></SelectTrigger>
                                <SelectContent><SelectItem value="enabled">Automatically investigate</SelectItem><SelectItem value="disabled">Review failures manually</SelectItem></SelectContent>
                            </Select>
                        </SettingsRow>
                        <SettingsRow label="Notification webhook" htmlFor="automation-webhook" description="Optional. Receives run status changes, with a Slack-compatible message.">
                            <Input id="automation-webhook" type="password" inputMode="url" autoComplete="new-password" value={webhookUrl} onChange={(event) => { setWebhookUrl(event.target.value); setRemoveWebhook(false); setFeedback(null); }} placeholder="https://hooks.example.com/…" disabled={saving || removeWebhook} aria-describedby="automation-webhook-help" />
                            <p id="automation-webhook-help" className="mt-1.5 text-meta text-ink-subtle">{removeWebhook ? "The webhook will be removed when you save." : settings.webhookConfigured ? `Connected to ${settings.webhookHost ?? "your webhook"}. Leave blank to keep it, or enter a new HTTPS URL.` : "Enter an HTTPS URL to receive notifications."}</p>
                            {settings.webhookConfigured && <Button type="button" variant="ghost" size="sm" className="mt-2" disabled={saving} onClick={() => { setRemoveWebhook((value) => !value); setWebhookUrl(""); setFeedback(null); }}>{removeWebhook ? "Keep webhook" : "Remove webhook"}</Button>}
                        </SettingsRow>
                        <SettingsRow label="Webhook network access" htmlFor="automation-webhook-network" description="Private destinations include internal services and this server's loopback addresses.">
                            <Select value={allowPrivateWebhook ? "private" : "public"} onValueChange={(value) => { setAllowPrivateWebhook(value === "private"); setFeedback(null); }} disabled={saving}>
                                <SelectTrigger id="automation-webhook-network"><SelectValue /></SelectTrigger>
                                <SelectContent><SelectItem value="public">Public destinations only</SelectItem><SelectItem value="private">Allow private destinations</SelectItem></SelectContent>
                            </Select>
                        </SettingsRow>
                        {settings.lastError && <SettingsBlock><Alert variant="warning" role="status"><AlertTitle>Last automation attempt</AlertTitle><AlertDescription>{settings.lastError}</AlertDescription></Alert></SettingsBlock>}
                        <SettingsFooter feedback={feedback ? <InlineFeedback feedback={feedback} /> : dirty ? <span className="text-control text-ink-muted">Unsaved changes</span> : null}>
                            {dirty && <Button type="button" variant="ghost" onClick={() => { applySettings(settings); setAutonomy(savedAutonomy); setFeedback(null); }} disabled={saving}>Cancel</Button>}
                            <Button type="submit" disabled={saving || !dirty}>{saving ? "Saving…" : "Save changes"}</Button>
                        </SettingsFooter>
                    </form>
                )}
            </SettingsSection>
            {!loading && notifications.length > 0 && (
                <SettingsSection id="automation-notifications-heading" title="Notification delivery" description="Recent status changes sent to your webhook.">
                    <ul className="divide-y divide-line" aria-label="Notification deliveries">
                        {notifications.map((notification) => {
                            const delivered = Boolean(notification.deliveredAt);
                            const failed = !delivered && notification.attempts > 0 && !notification.nextAttemptAt;
                            const Icon = delivered ? Check : failed ? X : Clock3;
                            return (
                                <li key={notification.id} className="space-y-2 px-4 py-3 sm:px-5">
                                    <div className="flex flex-wrap items-center justify-between gap-2">
                                        <span className="flex flex-wrap items-center gap-2 text-body text-ink"><span>Run</span><StatusPill status={notification.status} kind="run" size="sm" /><RelativeTime value={notification.createdAt} className="text-meta text-ink-subtle" /></span>
                                        <Badge variant={delivered ? "success" : failed ? "danger" : "neutral"} size="sm"><Icon size={12} aria-hidden="true" />{delivered ? "Delivered" : failed ? "Failed" : "Pending"}</Badge>
                                    </div>
                                    <p className="text-meta text-ink-subtle">{notification.attempts} delivery {notification.attempts === 1 ? "attempt" : "attempts"}{!delivered && notification.nextAttemptAt ? ` · Next attempt ${formatDateTime(notification.nextAttemptAt)}` : ""}</p>
                                    {notification.lastError && <p className="break-words text-meta text-danger">{notification.lastError}</p>}
                                </li>
                            );
                        })}
                    </ul>
                </SettingsSection>
            )}
        </div>
    );
}
