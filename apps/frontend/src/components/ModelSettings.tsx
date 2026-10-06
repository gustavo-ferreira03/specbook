"use client";

import { useEffect, useRef, useState } from "react";
import {
    AlertCircle,
    AlertTriangle,
    Check,
    ChevronRight,
    Clipboard,
    ExternalLink,
    LoaderCircle,
    Eye,
    EyeOff,
    KeyRound,
    Link2,
    RefreshCw,
    Search,
    Settings2,
    Unplug,
    X,
} from "lucide-react";
import { EmptyState } from "@/components/EmptyState";
import { InlineFeedback, SettingsRow, SettingsSection, SettingsFooter } from "@/components/SettingsLayout";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
    Dialog,
    DialogClose,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
    getLlmSettings,
    api,
    pollLlmProviderOAuth,
    removeLlmProviderAuth,
    saveLlmProviderApiKey,
    startLlmProviderOAuth,
    submitLlmProviderOAuthInput,
    updateLlmSettings,
} from "@/lib/api";
import { copyText } from "@/lib/clipboard";
import type { LlmAuthMethod, LlmCurrentSettings, LlmOAuthPrompt, LlmProvider, LlmSettingsResponse } from "@/lib/types";

interface Feedback {
    type: "success" | "error";
    text: string;
}

interface ProviderFeedback extends Feedback {
    providerId: string;
}

interface OAuthState {
    providerId: string;
    sessionId?: string;
    status: "starting" | "pending" | "done" | "error";
    url?: string;
    userCode?: string;
    verificationUri?: string;
    prompt?: LlmOAuthPrompt;
    error?: string;
}

function providerAuthLabel(provider: LlmProvider) {
    if (provider.authMethods.includes("oauth") && provider.authMethods.includes("api_key")) return "Subscription or API key";
    if (provider.authMethods.includes("oauth")) return "Subscription";
    return "API key";
}

function StepNumber({ children }: { children: React.ReactNode }) {
    return <span aria-hidden="true" className="tabular flex size-6 shrink-0 items-center justify-center rounded-full bg-surface-selected text-meta font-semibold text-ink">{children}</span>;
}

function modelCountLabel(count: number) {
    return `${count} ${count === 1 ? "model" : "models"}`;
}

export function ModelSettings({ onConnectionTested }: { onConnectionTested?: () => void }) {
    const [settings, setSettings] = useState<LlmSettingsResponse | null>(null);
    const [draft, setDraft] = useState<LlmCurrentSettings | null>(null);
    const [search, setSearch] = useState("");
    const [expandedProvider, setExpandedProvider] = useState<string | null>(null);
    const [authMethod, setAuthMethod] = useState<LlmAuthMethod>("api_key");
    const [apiKey, setApiKey] = useState("");
    const [showApiKey, setShowApiKey] = useState(false);
    const [manualOAuthInput, setManualOAuthInput] = useState("");
    const [loadError, setLoadError] = useState("");
    const [retryKey, setRetryKey] = useState(0);
    const [savingSettings, setSavingSettings] = useState(false);
    const [testing, setTesting] = useState(false);
    const [providerBusy, setProviderBusy] = useState<string | null>(null);
    const [settingsFeedback, setSettingsFeedback] = useState<Feedback | null>(null);
    const [providerFeedback, setProviderFeedback] = useState<ProviderFeedback | null>(null);
    const [oauthState, setOAuthState] = useState<OAuthState | null>(null);
    const [providersOpen, setProvidersOpen] = useState(false);
    const providerTriggerRef = useRef<HTMLButtonElement | null>(null);
    const manageProvidersRef = useRef<HTMLButtonElement | null>(null);
    const searchInputRef = useRef<HTMLInputElement | null>(null);
    const oauthTimerRef = useRef<number | null>(null);
    const oauthGenerationRef = useRef(0);

    function stopOAuthPolling() {
        oauthGenerationRef.current += 1;
        if (oauthTimerRef.current !== null) {
            window.clearTimeout(oauthTimerRef.current);
            oauthTimerRef.current = null;
        }
    }

    async function refreshSettings() {
        const result = await getLlmSettings();
        setSettings(result);
        return result;
    }

    useEffect(() => {
        let active = true;
        setSettings(null);
        setDraft(null);
        setLoadError("");
        getLlmSettings()
            .then((result) => {
                if (!active) return;
                setSettings(result);
                setDraft(result.current);
            })
            .catch((error) => {
                if (active) setLoadError(error instanceof Error ? error.message : String(error));
            });
        return () => {
            active = false;
            stopOAuthPolling();
        };
    }, [retryKey]);

    function handleProvidersOpenChange(open: boolean) {
        setProvidersOpen(open);
        if (open) {
            setSearch("");
            setExpandedProvider(null);
            setProviderFeedback(null);
            return;
        }
        stopOAuthPolling();
        setOAuthState(null);
        setManualOAuthInput("");
    }

    function openProviders(event: React.MouseEvent<HTMLButtonElement>) {
        providerTriggerRef.current = event.currentTarget;
        handleProvidersOpenChange(true);
    }

    async function saveCurrentSettings(event: React.FormEvent<HTMLFormElement>) {
        event.preventDefault();
        if (!draft) return;
        setSavingSettings(true);
        setSettingsFeedback(null);
        try {
            const current = await updateLlmSettings(draft);
            setDraft(current);
            setSettings((value) => (value ? { ...value, current } : value));
            setSettingsFeedback({ type: "success", text: "Agent model saved." });
        } catch (error) {
            setSettingsFeedback({ type: "error", text: error instanceof Error ? error.message : String(error) });
        } finally {
            setSavingSettings(false);
        }
    }

    function selectProvider(providerId: string) {
        const provider = settings?.providers.find((item) => item.id === providerId);
        if (!provider) return;
        const currentModel = provider.id === draft?.provider ? draft.model : "";
        const model = provider.models.some((item) => item.id === currentModel) ? currentModel : (provider.models[0]?.id ?? "");
        setDraft({ provider: provider.id, model });
        setSettingsFeedback(null);
    }

    function toggleProvider(provider: LlmProvider) {
        const opening = expandedProvider !== provider.id;
        setExpandedProvider(opening ? provider.id : null);
        setApiKey("");
        setShowApiKey(false);
        setManualOAuthInput("");
        setProviderFeedback(null);
        if (opening) setAuthMethod(provider.authMethods[0] ?? "api_key");
    }

    async function saveApiKey(event: React.FormEvent<HTMLFormElement>, providerId: string) {
        event.preventDefault();
        const value = apiKey.trim();
        if (!value) return;
        setProviderBusy(providerId);
        setProviderFeedback(null);
        try {
            await saveLlmProviderApiKey(providerId, value);
            setApiKey("");
            await refreshSettings();
            setProviderFeedback({ providerId, type: "success", text: "API key saved." });
        } catch (error) {
            setProviderFeedback({ providerId, type: "error", text: error instanceof Error ? error.message : String(error) });
        } finally {
            setProviderBusy(null);
        }
    }

    async function removeProvider(providerId: string) {
        if (oauthState?.providerId === providerId) {
            stopOAuthPolling();
            setOAuthState(null);
        }
        setProviderBusy(providerId);
        setProviderFeedback(null);
        try {
            await removeLlmProviderAuth(providerId);
            await refreshSettings();
            setProviderFeedback({ providerId, type: "success", text: "Authentication removed." });
        } catch (error) {
            setProviderFeedback({ providerId, type: "error", text: error instanceof Error ? error.message : String(error) });
        } finally {
            setProviderBusy(null);
        }
    }

    async function startOAuth(providerId: string) {
        stopOAuthPolling();
        const generation = oauthGenerationRef.current;
        setProviderFeedback(null);
        setManualOAuthInput("");
        setOAuthState({ providerId, status: "starting" });
        try {
            const started = await startLlmProviderOAuth(providerId);
            if (generation !== oauthGenerationRef.current) return;
            setOAuthState({ providerId, sessionId: started.sessionId, status: "pending" });
            const poll = async () => {
                if (generation !== oauthGenerationRef.current) return;
                try {
                    const result = await pollLlmProviderOAuth(providerId, started.sessionId);
                    if (generation !== oauthGenerationRef.current) return;
                    setOAuthState((current) => ({ providerId, sessionId: started.sessionId, ...current, ...result }));
                    if (result.status === "done") {
                        await refreshSettings();
                        setProviderFeedback({ providerId, type: "success", text: "Provider connected." });
                        return;
                    }
                    if (result.status === "error") return;
                    oauthTimerRef.current = window.setTimeout(poll, 2000);
                } catch (error) {
                    if (generation !== oauthGenerationRef.current) return;
                    setOAuthState({ providerId, sessionId: started.sessionId, status: "error", error: error instanceof Error ? error.message : String(error) });
                }
            };
            oauthTimerRef.current = window.setTimeout(poll, 500);
        } catch (error) {
            if (generation !== oauthGenerationRef.current) return;
            setOAuthState({ providerId, status: "error", error: error instanceof Error ? error.message : String(error) });
        }
    }

    async function submitOAuthInput(event: React.FormEvent<HTMLFormElement>, providerId: string, sessionId: string) {
        event.preventDefault();
        const input = manualOAuthInput.trim();
        if (!input || providerBusy === providerId) return;
        setProviderBusy(providerId);
        try {
            await submitLlmProviderOAuthInput(providerId, sessionId, input);
            setManualOAuthInput("");
            setProviderFeedback({ providerId, type: "success", text: "Authorization submitted." });
        } catch (error) {
            setProviderFeedback({ providerId, type: "error", text: error instanceof Error ? error.message : String(error) });
        } finally {
            setProviderBusy(null);
        }
    }

    async function selectOAuthOption(providerId: string, sessionId: string, optionId: string) {
        if (providerBusy === providerId) return;
        setProviderBusy(providerId);
        try {
            await submitLlmProviderOAuthInput(providerId, sessionId, optionId);
        } catch (error) {
            setProviderFeedback({ providerId, type: "error", text: error instanceof Error ? error.message : String(error) });
        } finally {
            setProviderBusy(null);
        }
    }

    async function copyDeviceCode(code: string) {
        const copied = await copyText(code);
        if (!oauthState) return;
        setProviderFeedback(copied
            ? { providerId: oauthState.providerId, type: "success", text: "Device code copied." }
            : { providerId: oauthState.providerId, type: "error", text: "Device code could not be copied. Select it and copy it manually." });
    }

    const configuredProviders = settings?.providers.filter((provider) => provider.configured) ?? [];
    const selectedProvider = draft ? settings?.providers.find((provider) => provider.id === draft.provider) : undefined;
    const selectableProviders = configuredProviders.some((provider) => provider.id === draft?.provider)
        ? configuredProviders
        : selectedProvider
          ? [selectedProvider, ...configuredProviders]
          : configuredProviders;
    const filteredProviders = (settings?.providers ?? []).filter((provider) => {
        const query = search.trim().toLowerCase();
        return !query || provider.name.toLowerCase().includes(query) || provider.id.toLowerCase().includes(query) || provider.models.some((model) => model.label.toLowerCase().includes(query));
    });
    const hasChanges = Boolean(settings && draft && (draft.provider !== settings.current.provider || draft.model !== settings.current.model));

    function renderModelUnavailable() {
        if (loadError) {
            return (
                <div className="rounded-xl border border-line">
                    <EmptyState
                        icon={AlertCircle}
                        tone="danger"
                        role="alert"
                        title="Model settings could not load"
                        description={loadError}
                        action={<Button type="button" onClick={() => setRetryKey((key) => key + 1)}><RefreshCw size={14} /> Try again</Button>}
                    />
                </div>
            );
        }
        return (
            <div className="space-y-10" aria-label="Loading model settings" aria-busy="true" role="status">
                {[2, 1].map((rows, index) => (
                    <div key={index}>
                        <Skeleton className="mb-2 h-5 w-32" />
                        <Skeleton className="mb-4 h-3.5 w-64" />
                        <div className="rounded-xl border border-line">
                            {Array.from({ length: rows }, (_, row) => (
                                <div key={row} className="grid gap-3 border-b border-line px-5 py-4 last:border-0 md:grid-cols-[13rem_1fr] md:gap-8">
                                    <Skeleton className="h-4 w-20 md:mt-2.5" />
                                    <Skeleton className="h-9" />
                                </div>
                            ))}
                        </div>
                    </div>
                ))}
            </div>
        );
    }

    const modelReady = Boolean(selectedProvider?.configured && settings?.current.model);

    async function testConnection() {
        if (!draft) return;
        setTesting(true);
        setSettingsFeedback(null);
        try {
            if (hasChanges) {
                const current = await updateLlmSettings(draft);
                setDraft(current);
                setSettings((value) => value ? { ...value, current } : value);
            }
            const result = await api<{ ok: true; message: string }>("/settings/llm/test", { method: "POST" });
            setSettingsFeedback({ type: "success", text: result.message });
            onConnectionTested?.();
        } catch (error) {
            setSettingsFeedback({ type: "error", text: error instanceof Error ? error.message : String(error) });
        } finally {
            setTesting(false);
        }
    }

    return (
        <Dialog open={providersOpen} onOpenChange={handleProvidersOpenChange}>
            {!settings || !draft ? renderModelUnavailable() : (
                <div className="space-y-10">
                    <SettingsSection
                        id="agent-model-heading"
                        title="Agent model"
                        description="The provider and model every chat and discovery uses. Shared by all projects on this server."
                        actions={modelReady
                            ? <Badge variant="success"><Check size={13} strokeWidth={2.25} aria-hidden="true" /> Configured</Badge>
                            : <Badge variant="warning"><AlertTriangle size={13} strokeWidth={2.25} aria-hidden="true" /> Setup needed</Badge>}
                    >
                        <form onSubmit={saveCurrentSettings}>
                            <SettingsRow label="Provider" htmlFor="current-provider" description="Only connected providers are listed.">
                                <Select
                                    value={selectableProviders.some((provider) => provider.id === draft.provider) ? draft.provider : ""}
                                    onValueChange={selectProvider}
                                    disabled={testing || savingSettings || selectableProviders.length === 0}
                                >
                                    <SelectTrigger id="current-provider">
                                        <SelectValue placeholder={selectableProviders.length ? "Select provider" : "No provider connected"} />
                                    </SelectTrigger>
                                    <SelectContent>
                                        {selectableProviders.map((provider) => (
                                            <SelectItem key={provider.id} value={provider.id}>{provider.name}</SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                            </SettingsRow>
                            <SettingsRow label="Model" htmlFor="current-model">
                                <Select
                                    value={selectedProvider?.models.some((model) => model.id === draft.model) ? draft.model : ""}
                                    onValueChange={(model) => {
                                        setDraft((current) => current ? { ...current, model } : current);
                                        setSettingsFeedback(null);
                                    }}
                                    disabled={testing || savingSettings || !selectedProvider?.models.length}
                                >
                                    <SelectTrigger id="current-model">
                                        <SelectValue placeholder={selectedProvider?.models.length ? "Select model" : "No models available"} />
                                    </SelectTrigger>
                                    <SelectContent>
                                        {selectedProvider?.models.map((model) => (
                                            <SelectItem key={model.id} value={model.id}>{model.label}</SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                            </SettingsRow>
                            <SettingsFooter feedback={settingsFeedback ? <InlineFeedback feedback={settingsFeedback} /> : hasChanges ? <span className="text-control text-ink-muted">Unsaved changes</span> : null}>
                                <Button type="submit" variant="outline" disabled={testing || savingSettings || !hasChanges || !draft.provider || !draft.model}>
                                    {savingSettings ? "Saving…" : "Save model"}
                                </Button>
                                <Button type="button" onClick={() => void testConnection()} disabled={testing || savingSettings || !selectedProvider?.configured || !draft.model}>
                                    {testing && <LoaderCircle size={14} className="animate-spin motion-reduce:animate-none" />}
                                    {testing ? "Testing connection…" : onConnectionTested ? "Test connection and continue" : "Test connection"}
                                </Button>
                            </SettingsFooter>
                        </form>
                    </SettingsSection>

                    <SettingsSection
                        id="providers-heading"
                        title="Connected providers"
                        description="API keys and subscription tokens stay in the self-hosted runtime."
                        actions={
                            <Button ref={manageProvidersRef} type="button" variant="outline" onClick={openProviders}>
                                <Settings2 size={14} /> Manage providers
                            </Button>
                        }
                    >
                        {configuredProviders.length ? (
                            <ul>
                                {configuredProviders.map((provider) => (
                                    <li key={provider.id} className="flex min-h-14 items-center gap-3 border-b border-line px-4 py-2.5 last:border-0 sm:px-5">
                                        <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-success-soft text-success">
                                            <Check size={15} strokeWidth={2.25} aria-hidden="true" />
                                        </span>
                                        <div className="min-w-0 flex-1">
                                            <p className="truncate text-control font-medium text-ink">{provider.name}</p>
                                            <p className="truncate text-meta text-ink-subtle">{modelCountLabel(provider.models.length)} · {providerAuthLabel(provider)}</p>
                                        </div>
                                        {provider.id === settings.current.provider && <Badge variant="secondary" size="sm">In use</Badge>}
                                    </li>
                                ))}
                            </ul>
                        ) : (
                            <EmptyState
                                size="compact"
                                icon={KeyRound}
                                title="No provider connected"
                                description="Connect one to let the agent chat, explore, and write Specs."
                                action={<Button type="button" variant="outline" size="sm" onClick={openProviders}>Open provider manager</Button>}
                            />
                        )}
                    </SettingsSection>
                </div>
            )}
            <DialogContent
                showCloseButton={false}
                className="h-[min(82dvh,660px)] w-[min(640px,calc(100%-24px))] max-w-[640px] overflow-hidden p-0 sm:p-0"
                onPointerDownOutside={(event) => event.preventDefault()}
                onOpenAutoFocus={(event) => {
                    event.preventDefault();
                    requestAnimationFrame(() => searchInputRef.current?.focus());
                }}
                onCloseAutoFocus={(event) => {
                    event.preventDefault();
                    const trigger = providerTriggerRef.current;
                    if (trigger?.isConnected) trigger.focus();
                    else manageProvidersRef.current?.focus();
                    providerTriggerRef.current = null;
                }}
            >
                <div className="flex h-full min-h-0 flex-col">
                    <DialogHeader className="shrink-0 gap-0 px-5 pt-5 pb-4 pr-5">
                        <div className="flex items-start justify-between gap-4">
                            <div>
                                <DialogTitle>Provider manager</DialogTitle>
                                <DialogDescription className="mt-1">
                                    Connect an API key or a supported subscription.
                                </DialogDescription>
                            </div>
                            <Tooltip>
                                <TooltipTrigger asChild>
                                    <DialogClose asChild>
                                        <Button type="button" variant="ghost" size="icon-sm" aria-label="Close provider manager" className="-mt-1 -mr-1">
                                            <X size={16} />
                                        </Button>
                                    </DialogClose>
                                </TooltipTrigger>
                                <TooltipContent>Close provider manager</TooltipContent>
                            </Tooltip>
                        </div>
                        <div className="relative mt-3">
                            <Label className="sr-only" htmlFor="provider-search">Search providers</Label>
                            <Search size={14} aria-hidden="true" className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-ink-subtle" />
                            <Input
                                ref={searchInputRef}
                                id="provider-search"
                                type="search"
                                value={search}
                                onChange={(event) => setSearch(event.target.value)}
                                className="pl-9"
                                placeholder="Search providers or models"
                            />
                        </div>
                    </DialogHeader>
                    <Separator />
                    <ScrollArea className="min-h-0 flex-1">
                        <div className="p-2">
                            {filteredProviders.map((provider) => {
                                const expanded = expandedProvider === provider.id;
                                const oauth = oauthState?.providerId === provider.id ? oauthState : null;
                                const feedback = providerFeedback?.providerId === provider.id ? providerFeedback : null;
                                const busy = providerBusy === provider.id;
                                return (
                                    <Collapsible
                                        key={provider.id}
                                        asChild
                                        open={expanded}
                                        onOpenChange={(open) => {
                                            if (open !== expanded) toggleProvider(provider);
                                        }}
                                    >
                                        <section className="border-b border-line py-1 last:border-0">
                                            <CollapsibleTrigger asChild>
                                                <Button type="button" variant="ghost" className="h-auto min-h-14 w-full justify-start gap-3 rounded-lg px-3 py-2.5 text-left text-ink hover:text-ink">
                                                    <span className="min-w-0 flex-1">
                                                        <span className="block truncate text-control font-medium">{provider.name}</span>
                                                        <span className="mt-0.5 block truncate text-meta font-normal text-ink-subtle">{modelCountLabel(provider.models.length)} · {providerAuthLabel(provider)}</span>
                                                    </span>
                                                    {provider.configured ? (
                                                        <Badge variant="success" size="sm"><Check size={12} strokeWidth={2.25} aria-hidden="true" /> Connected</Badge>
                                                    ) : (
                                                        <span className="text-meta font-normal text-ink-subtle">Not connected</span>
                                                    )}
                                                    <ChevronRight size={14} aria-hidden="true" className={`text-ink-subtle transition-transform duration-150 motion-reduce:transition-none ${expanded ? "rotate-90" : ""}`} />
                                                </Button>
                                            </CollapsibleTrigger>
                                            <CollapsibleContent className="mx-1 mb-2 rounded-lg border border-line bg-surface-soft p-4">
                                                <Tabs
                                                    value={authMethod}
                                                    onValueChange={(method) => {
                                                        setAuthMethod(method as LlmAuthMethod);
                                                        setProviderFeedback(null);
                                                    }}
                                                >
                                                    {provider.authMethods.length > 1 && (
                                                        <TabsList variant="segmented" aria-label="Authentication method" className="mb-4 w-fit self-start">
                                                            {provider.authMethods.map((method) => (
                                                                <TabsTrigger
                                                                    key={method}
                                                                    value={method}
                                                                >
                                                                    {method === "api_key" ? "API key" : "Subscription"}
                                                                </TabsTrigger>
                                                            ))}
                                                        </TabsList>
                                                    )}
                                                    <TabsContent value="api_key">
                                                        <form onSubmit={(event) => saveApiKey(event, provider.id)}>
                                                            <Label className="mb-1.5" htmlFor={`api-key-${provider.id}`}>API key</Label>
                                                            <div className="flex gap-2">
                                                                <div className="relative min-w-0 flex-1">
                                                                    <Input
                                                                        id={`api-key-${provider.id}`}
                                                                        type={showApiKey ? "text" : "password"}
                                                                        value={apiKey}
                                                                        onChange={(event) => setApiKey(event.target.value)}
                                                                        autoComplete="off"
                                                                        className="pr-9"
                                                                        placeholder="Enter API key"
                                                                    />
                                                                    <Tooltip>
                                                                        <TooltipTrigger asChild>
                                                                            <Button
                                                                                type="button"
                                                                                variant="ghost"
                                                                                onClick={() => setShowApiKey((value) => !value)}
                                                                                className="absolute inset-y-0 right-0 h-auto w-9 px-0"
                                                                                aria-label={showApiKey ? "Hide API key" : "Show API key"}
                                                                            >
                                                                                {showApiKey ? <EyeOff size={13} /> : <Eye size={13} />}
                                                                            </Button>
                                                                        </TooltipTrigger>
                                                                        <TooltipContent>{showApiKey ? "Hide API key" : "Show API key"}</TooltipContent>
                                                                    </Tooltip>
                                                                </div>
                                                                <Button type="submit" variant={provider.configured ? "outline" : "default"} disabled={!apiKey.trim() || busy}>
                                                                    {busy ? "Saving…" : provider.configured ? "Replace" : "Save key"}
                                                                </Button>
                                                            </div>
                                                        </form>
                                                    </TabsContent>
                                                    <TabsContent value="oauth">
                                                        {!oauth && (
                                                            <div className="space-y-3">
                                                                <p className="text-control text-ink-muted">Sign in with your {provider.name} subscription in a new browser tab. Specbook stores the resulting token in the runtime.</p>
                                                                <Button type="button" onClick={() => startOAuth(provider.id)}>
                                                                    <Link2 size={14} /> Connect subscription
                                                                </Button>
                                                            </div>
                                                        )}
                                                        {oauth?.status === "starting" && (
                                                            <p className="flex items-center gap-2 text-control text-ink-muted" role="status">
                                                                <LoaderCircle size={14} className="animate-spin motion-reduce:animate-none" aria-hidden="true" /> Starting authentication...
                                                            </p>
                                                        )}
                                                        {oauth?.status === "pending" && (
                                                            <div className="space-y-4">
                                                                {(oauth.url || oauth.verificationUri) && (
                                                                    <div className="flex gap-3">
                                                                        <StepNumber>1</StepNumber>
                                                                        <div className="min-w-0 flex-1">
                                                                            <p className="text-control font-medium text-ink">Open the authorization page</p>
                                                                            <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2">
                                                                                {oauth.url && (
                                                                                    <Button asChild>
                                                                                        <a href={oauth.url} target="_blank" rel="noopener noreferrer">
                                                                                            Open authorization page <ExternalLink size={13} />
                                                                                        </a>
                                                                                    </Button>
                                                                                )}
                                                                                {oauth.verificationUri && (
                                                                                    <Button asChild variant={oauth.url ? "link" : "default"} className={oauth.url ? "text-control" : undefined}>
                                                                                        <a href={oauth.verificationUri} target="_blank" rel="noopener noreferrer">
                                                                                            Open verification page <ExternalLink size={13} />
                                                                                        </a>
                                                                                    </Button>
                                                                                )}
                                                                            </div>
                                                                        </div>
                                                                    </div>
                                                                )}
                                                                {oauth.userCode && (
                                                                    <div className="flex gap-3">
                                                                        <StepNumber>{oauth.url || oauth.verificationUri ? 2 : 1}</StepNumber>
                                                                        <div className="min-w-0 flex-1">
                                                                            <p className="text-control font-medium text-ink">Enter this device code</p>
                                                                            <div className="mt-2 flex max-w-sm gap-2">
                                                                                <code className="flex min-h-11 min-w-0 flex-1 select-all items-center justify-center break-all rounded-md border border-line-strong bg-surface px-3 font-mono text-section tracking-[0.18em] text-ink">
                                                                                    {oauth.userCode}
                                                                                </code>
                                                                                <Tooltip>
                                                                                    <TooltipTrigger asChild>
                                                                                        <Button type="button" variant="outline" size="icon" onClick={() => copyDeviceCode(oauth.userCode!)} className="size-11" aria-label="Copy device code">
                                                                                            <Clipboard size={15} />
                                                                                        </Button>
                                                                                    </TooltipTrigger>
                                                                                    <TooltipContent>Copy device code</TooltipContent>
                                                                                </Tooltip>
                                                                            </div>
                                                                        </div>
                                                                    </div>
                                                                )}
                                                                {oauth.prompt?.type === "select" && oauth.sessionId && (
                                                                    <div className="max-w-sm space-y-1.5">
                                                                        <Label>{oauth.prompt.message}</Label>
                                                                        <Select onValueChange={(value) => selectOAuthOption(provider.id, oauth.sessionId!, value)}>
                                                                            <SelectTrigger>
                                                                                <SelectValue placeholder="Choose an option" />
                                                                            </SelectTrigger>
                                                                            <SelectContent>
                                                                                {oauth.prompt.options.map((option) => (
                                                                                    <SelectItem key={option.id} value={option.id}>{option.label}</SelectItem>
                                                                                ))}
                                                                            </SelectContent>
                                                                        </Select>
                                                                    </div>
                                                                )}
                                                                {(oauth.prompt?.type === "text" || oauth.prompt?.type === "secret" || oauth.prompt?.type === "manual_code") && oauth.sessionId && (
                                                                    <form onSubmit={(event) => submitOAuthInput(event, provider.id, oauth.sessionId!)} className="max-w-sm space-y-1.5">
                                                                        <Label htmlFor={`oauth-input-${provider.id}`}>{oauth.prompt.message}</Label>
                                                                        <div className="flex gap-2">
                                                                            <Input id={`oauth-input-${provider.id}`} type={oauth.prompt.type === "secret" ? "password" : "text"} value={manualOAuthInput} onChange={(event) => setManualOAuthInput(event.target.value)} className="min-w-0 flex-1" placeholder={oauth.prompt.placeholder} />
                                                                            <Button type="submit" variant="outline" disabled={!manualOAuthInput.trim() || busy}>{busy ? "Submitting…" : "Submit"}</Button>
                                                                        </div>
                                                                    </form>
                                                                )}
                                                                <p className="flex items-center gap-2 text-meta text-ink-muted" role="status">
                                                                    <LoaderCircle size={13} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
                                                                    {!oauth.url && !oauth.userCode && !oauth.prompt ? "Waiting for authentication instructions…" : "Waiting for you to finish in the browser…"}
                                                                </p>
                                                            </div>
                                                        )}
                                                        {oauth?.status === "done" && (
                                                            <InlineFeedback feedback={{ type: "success", text: "Provider connected." }} />
                                                        )}
                                                        {oauth?.status === "error" && (
                                                            <div className="space-y-3">
                                                                <Alert variant="danger" role="alert">
                                                                    <AlertTitle>Authentication failed</AlertTitle>
                                                                    <AlertDescription>{oauth.error ?? "The provider did not complete the sign-in."}</AlertDescription>
                                                                </Alert>
                                                                <Button type="button" variant="outline" onClick={() => startOAuth(provider.id)}>
                                                                    <RefreshCw size={14} /> Try again
                                                                </Button>
                                                            </div>
                                                        )}
                                                    </TabsContent>
                                                </Tabs>
                                                {(feedback || provider.configured) && (
                                                    <div className="mt-4 flex min-h-8 flex-wrap items-center justify-between gap-3 border-t border-line pt-3">
                                                        <div className="min-w-0 flex-1">
                                                            {feedback && !(oauth?.status === "done" && feedback.type === "success") && <InlineFeedback feedback={feedback} />}
                                                        </div>
                                                        {provider.configured && (
                                                            <Button
                                                                type="button"
                                                                variant="destructive-soft"
                                                                size="sm"
                                                                onClick={() => removeProvider(provider.id)}
                                                                disabled={busy}
                                                            >
                                                                <Unplug size={13} /> Remove authentication
                                                            </Button>
                                                        )}
                                                    </div>
                                                )}
                                            </CollapsibleContent>
                                        </section>
                                    </Collapsible>
                                );
                            })}
                            {filteredProviders.length === 0 && (
                                <EmptyState size="compact" icon={Search} title="No providers found" description="Try another provider or model name." className="py-10" />
                            )}
                        </div>
                    </ScrollArea>
                    <Separator />
                    <DialogFooter className="flex-row justify-end gap-0 bg-surface-soft px-5 py-3">
                        <DialogClose asChild>
                            <Button type="button" variant="outline">Close</Button>
                        </DialogClose>
                    </DialogFooter>
                </div>
            </DialogContent>
        </Dialog>
    );
}
