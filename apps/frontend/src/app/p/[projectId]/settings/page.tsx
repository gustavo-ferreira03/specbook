"use client";

import { useParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import {
    AlertCircle,
    Check,
    ChevronDown,
    ChevronRight,
    Clipboard,
    ExternalLink,
    Eye,
    EyeOff,
    KeyRound,
    Link2,
    RefreshCw,
    Search,
    Settings2,
    X,
} from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { GitHubConnection } from "@/components/GitHubConnection";
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
    pollLlmProviderOAuth,
    removeLlmProviderAuth,
    saveLlmProviderApiKey,
    startLlmProviderOAuth,
    submitLlmProviderOAuthManual,
    updateLlmSettings,
} from "@/lib/api";
import type { LlmAuthMethod, LlmCurrentSettings, LlmProvider, LlmSettingsResponse } from "@/lib/types";

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
    type?: "browser" | "device_code";
    status: "starting" | "pending" | "done" | "error";
    url?: string;
    userCode?: string;
    verificationUri?: string;
    error?: string;
}

function providerAuthLabel(provider: LlmProvider) {
    if (provider.authMethods.includes("oauth") && provider.authMethods.includes("api_key")) return "Subscription or API key";
    if (provider.authMethods.includes("oauth")) return "Subscription";
    return "API key";
}

function modelCountLabel(count: number) {
    return `${count} ${count === 1 ? "model" : "models"}`;
}

export default function SettingsPage() {
    const { projectId } = useParams<{ projectId: string }>();
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
            setOAuthState({ providerId, sessionId: started.sessionId, type: started.type, status: "pending" });
            const poll = async () => {
                if (generation !== oauthGenerationRef.current) return;
                try {
                    const result = await pollLlmProviderOAuth(providerId, started.sessionId);
                    if (generation !== oauthGenerationRef.current) return;
                    setOAuthState((current) => ({ providerId, sessionId: started.sessionId, type: started.type, ...current, ...result }));
                    if (result.status === "done") {
                        await refreshSettings();
                        setProviderFeedback({ providerId, type: "success", text: "Provider connected." });
                        return;
                    }
                    if (result.status === "error") return;
                    oauthTimerRef.current = window.setTimeout(poll, 2000);
                } catch (error) {
                    if (generation !== oauthGenerationRef.current) return;
                    setOAuthState({ providerId, sessionId: started.sessionId, type: started.type, status: "error", error: error instanceof Error ? error.message : String(error) });
                }
            };
            oauthTimerRef.current = window.setTimeout(poll, 500);
        } catch (error) {
            if (generation !== oauthGenerationRef.current) return;
            setOAuthState({ providerId, status: "error", error: error instanceof Error ? error.message : String(error) });
        }
    }

    async function submitManualOAuth(event: React.FormEvent<HTMLFormElement>, providerId: string, sessionId: string) {
        event.preventDefault();
        const input = manualOAuthInput.trim();
        if (!input || providerBusy === providerId) return;
        setProviderBusy(providerId);
        try {
            await submitLlmProviderOAuthManual(providerId, sessionId, input);
            setManualOAuthInput("");
            setProviderFeedback({ providerId, type: "success", text: "Authorization submitted." });
        } catch (error) {
            setProviderFeedback({ providerId, type: "error", text: error instanceof Error ? error.message : String(error) });
        } finally {
            setProviderBusy(null);
        }
    }

    async function copyDeviceCode(code: string) {
        try {
            await navigator.clipboard.writeText(code);
            if (oauthState) setProviderFeedback({ providerId: oauthState.providerId, type: "success", text: "Device code copied." });
        } catch {
            if (oauthState) setProviderFeedback({ providerId: oauthState.providerId, type: "error", text: "Device code could not be copied." });
        }
    }

    if (loadError) {
        return (
            <div className="flex min-h-full flex-col bg-surface">
                <PageHeader title="Agent settings" eyebrow="Settings" />
                <div className="flex flex-1 items-center justify-center px-5 py-10">
                    <Alert variant="destructive" className="max-w-sm bg-transparent p-0 text-center" role="alert">
                        <span className="mx-auto flex size-9 items-center justify-center rounded-lg bg-danger-soft text-danger">
                            <AlertCircle size={18} />
                        </span>
                        <AlertTitle className="mt-4 text-sm text-ink">Settings could not load</AlertTitle>
                        <AlertDescription className="mt-2 text-xs leading-5">{loadError}</AlertDescription>
                        <Button type="button" onClick={() => setRetryKey((key) => key + 1)} className="mt-5">
                            <RefreshCw size={13} /> Try again
                        </Button>
                    </Alert>
                </div>
            </div>
        );
    }

    if (!settings || !draft) {
        return (
            <div className="min-h-full bg-surface" aria-label="Loading agent settings" aria-busy="true" role="status">
                <div className="h-16 border-b border-line md:h-[72px]" />
                <div className="mx-auto w-full max-w-[720px] space-y-4 px-5 py-8">
                    <Skeleton className="h-4 w-28 rounded-sm" />
                    <Skeleton className="h-28 rounded-[11px] bg-surface-soft" />
                    <Skeleton className="h-20 rounded-[11px] bg-surface-soft" />
                </div>
            </div>
        );
    }

    const configuredProviders = settings.providers.filter((provider) => provider.configured);
    const selectedProvider = settings.providers.find((provider) => provider.id === draft.provider);
    const selectableProviders = configuredProviders.some((provider) => provider.id === draft.provider)
        ? configuredProviders
        : selectedProvider
          ? [selectedProvider, ...configuredProviders]
          : configuredProviders;
    const filteredProviders = settings.providers.filter((provider) => {
        const query = search.trim().toLowerCase();
        return !query || provider.name.toLowerCase().includes(query) || provider.id.toLowerCase().includes(query) || provider.models.some((model) => model.label.toLowerCase().includes(query));
    });
    const hasChanges = draft.provider !== settings.current.provider || draft.model !== settings.current.model;

    return (
        <Dialog open={providersOpen} onOpenChange={handleProvidersOpenChange}>
            <div className="min-h-full bg-surface">
                <PageHeader title="Agent settings" eyebrow="Settings" />
                <div className="mx-auto w-full max-w-[720px] px-4 py-7 sm:px-6 sm:py-8">
                    <section aria-labelledby="agent-model-heading">
                        <div className="flex items-end justify-between gap-4">
                            <div>
                                <h2 id="agent-model-heading" className="text-[0.8125rem] font-bold">Agent model</h2>
                                <p className="mt-1 text-[0.65625rem] text-ink-faint">Provider and model used for every chat.</p>
                            </div>
                            <Badge variant={selectedProvider?.configured ? "success" : "pending"} className="gap-1.5 rounded-none bg-transparent p-0">
                                <span className={`size-1.5 rounded-full ${selectedProvider?.configured ? "bg-success" : "bg-pending"}`} />
                                {selectedProvider?.configured ? "Ready" : "Setup needed"}
                            </Badge>
                        </div>
                        <Separator className="mt-3" />
                        <form onSubmit={saveCurrentSettings} className="py-4">
                            {configuredProviders.length === 0 && (
                                <Alert variant="warning" className="mb-3 flex items-center gap-2 py-2">
                                    <KeyRound size={13} />
                                    <AlertDescription>Connect a provider before selecting a model.</AlertDescription>
                                </Alert>
                            )}
                            <div className="grid gap-3 sm:grid-cols-2">
                                <div>
                                    <Label htmlFor="current-provider" className="mb-1.5">Provider</Label>
                                    <Select
                                        value={selectableProviders.some((provider) => provider.id === draft.provider) ? draft.provider : ""}
                                        onValueChange={selectProvider}
                                        disabled={savingSettings || selectableProviders.length === 0}
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
                                </div>
                                <div>
                                    <Label htmlFor="current-model" className="mb-1.5">Model</Label>
                                    <Select
                                        value={selectedProvider?.models.some((model) => model.id === draft.model) ? draft.model : ""}
                                        onValueChange={(model) => {
                                            setDraft((current) => current ? { ...current, model } : current);
                                            setSettingsFeedback(null);
                                        }}
                                        disabled={savingSettings || !selectedProvider?.models.length}
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
                                </div>
                            </div>
                            <div className="mt-3 flex min-h-8 items-center justify-between gap-3">
                                <div className="min-w-0 flex-1">
                                    {settingsFeedback && (
                                        <Alert
                                            variant={settingsFeedback.type === "error" ? "destructive" : "default"}
                                            className={`bg-transparent p-0 text-[0.65625rem] ${settingsFeedback.type === "success" ? "text-success" : ""}`}
                                            role={settingsFeedback.type === "error" ? "alert" : "status"}
                                        >
                                            <AlertDescription className="flex items-center gap-1.5">
                                                {settingsFeedback.type === "success" ? <Check size={12} /> : <AlertCircle size={12} />}
                                                {settingsFeedback.text}
                                            </AlertDescription>
                                        </Alert>
                                    )}
                                </div>
                                <Button type="submit" disabled={savingSettings || !hasChanges || !draft.provider || !draft.model}>
                                    {savingSettings ? "Saving..." : "Save model"}
                                </Button>
                            </div>
                        </form>
                        <Separator />
                    </section>

                    <section className="mt-7" aria-labelledby="providers-heading">
                        <div className="flex items-end justify-between gap-4">
                            <div>
                                <h2 id="providers-heading" className="text-[0.8125rem] font-bold">Connected providers</h2>
                                <p className="mt-1 text-[0.65625rem] text-ink-faint">Credentials stay in the self-hosted runtime.</p>
                            </div>
                            <Button ref={manageProvidersRef} type="button" variant="outline" onClick={openProviders} className="shrink-0">
                                <Settings2 size={13} />
                                <span className="sm:hidden">Manage</span>
                                <span className="hidden sm:inline">Manage providers</span>
                            </Button>
                        </div>
                        <div className="mt-3 border-y border-line">
                            {configuredProviders.length ? configuredProviders.map((provider) => (
                                <div key={provider.id} className="flex min-h-11 items-center gap-3 border-b border-line px-1 last:border-0">
                                    <span className="size-2 rounded-full bg-success" />
                                    <span className="min-w-0 flex-1 truncate text-[0.71875rem] font-bold">{provider.name}</span>
                                    <span className="text-[0.625rem] text-ink-faint">{modelCountLabel(provider.models.length)}</span>
                                </div>
                            )) : (
                                <div className="py-5 text-center">
                                    <p className="text-[0.71875rem] font-bold">No provider connected</p>
                                    <Button type="button" variant="link" size="sm" onClick={openProviders} className="mt-1 h-auto p-0 text-[0.65625rem] text-ink-soft">
                                        Open provider manager
                                    </Button>
                                </div>
                            )}
                        </div>
                    </section>
                    <GitHubConnection projectId={projectId} />
                </div>
            </div>

            <DialogContent
                showCloseButton={false}
                className="h-[min(82dvh,660px)] w-[min(640px,calc(100%-24px))] max-w-[640px] overflow-hidden p-0"
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
                    <DialogHeader className="shrink-0 gap-0 bg-surface px-4 py-3.5">
                        <div className="flex items-start justify-between gap-4">
                            <div>
                                <DialogTitle>Provider manager</DialogTitle>
                                <DialogDescription className="mt-1 text-[0.65625rem] leading-normal text-ink-faint">
                                    Connect an API key or supported subscription.
                                </DialogDescription>
                            </div>
                            <Tooltip>
                                <TooltipTrigger asChild>
                                    <DialogClose asChild>
                                        <Button type="button" variant="ghost" size="icon" aria-label="Close provider manager">
                                            <X size={16} />
                                        </Button>
                                    </DialogClose>
                                </TooltipTrigger>
                                <TooltipContent>Close provider manager</TooltipContent>
                            </Tooltip>
                        </div>
                        <div className="relative mt-3">
                            <Label className="sr-only" htmlFor="provider-search">Search providers</Label>
                            <Search size={13} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-ink-faint" />
                            <Input
                                ref={searchInputRef}
                                id="provider-search"
                                type="search"
                                value={search}
                                onChange={(event) => setSearch(event.target.value)}
                                className="pl-8"
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
                                        <section className="border-b border-line last:border-0">
                                            <CollapsibleTrigger asChild>
                                                <Button type="button" variant="ghost" className="h-auto min-h-11 w-full justify-start gap-2.5 px-2 text-left">
                                                    <span className={`size-2 shrink-0 rounded-full ${provider.configured ? "bg-success" : "bg-line-strong"}`} />
                                                    <span className="min-w-0 flex-1">
                                                        <span className="block truncate text-[0.71875rem] font-bold">{provider.name}</span>
                                                        <span className="mt-0.5 block text-[0.59375rem] font-normal text-ink-faint">
                                                            <span className="block truncate">{modelCountLabel(provider.models.length)} · {providerAuthLabel(provider)}</span>
                                                        </span>
                                                    </span>
                                                    <Badge
                                                        variant={provider.configured ? "success" : "secondary"}
                                                        className={`rounded-none bg-transparent p-0 text-[0.59375rem] ${provider.configured ? "text-success" : "text-ink-faint"}`}
                                                    >
                                                        {provider.configured ? "Connected" : "Not connected"}
                                                    </Badge>
                                                    {expanded ? <ChevronDown size={13} className="text-ink-faint" /> : <ChevronRight size={13} className="text-ink-faint" />}
                                                </Button>
                                            </CollapsibleTrigger>
                                            <CollapsibleContent className="mx-2 mb-2 rounded-lg bg-surface-soft p-3">
                                                <Tabs
                                                    value={authMethod}
                                                    onValueChange={(method) => {
                                                        setAuthMethod(method as LlmAuthMethod);
                                                        setProviderFeedback(null);
                                                    }}
                                                >
                                                    {provider.authMethods.length > 1 && (
                                                        <TabsList className="mb-3 w-full justify-start gap-1 border-b border-line">
                                                            {provider.authMethods.map((method) => (
                                                                <TabsTrigger
                                                                    key={method}
                                                                    value={method}
                                                                    className="min-h-8 rounded-none px-2 text-[0.65625rem] data-[state=active]:bg-transparent data-[state=active]:text-ink data-[state=active]:shadow-[inset_0_-2px_0_var(--color-primary)]"
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
                                                                <Button type="submit" disabled={!apiKey.trim() || busy}>
                                                                    {busy ? "Saving..." : provider.configured ? "Replace" : "Save key"}
                                                                </Button>
                                                            </div>
                                                        </form>
                                                    </TabsContent>
                                                    <TabsContent value="oauth">
                                                        {!oauth && (
                                                            <Button type="button" onClick={() => startOAuth(provider.id)}>
                                                                <Link2 size={13} /> Connect subscription
                                                            </Button>
                                                        )}
                                                        {oauth?.status === "starting" && (
                                                            <p className="flex items-center gap-2 text-[0.65625rem] text-ink-soft">
                                                                <span className="status-pulse size-1.5 rounded-full bg-ink" /> Starting authentication
                                                            </p>
                                                        )}
                                                        {oauth?.status === "pending" && oauth.type === "browser" && (
                                                            <div className="space-y-2">
                                                                <p className="text-[0.65625rem] text-ink-soft">Authorize this provider in your browser.</p>
                                                                {oauth.url ? (
                                                                    <Button asChild>
                                                                        <a href={oauth.url} target="_blank" rel="noopener noreferrer">
                                                                            Open authorization page <ExternalLink size={12} />
                                                                        </a>
                                                                    </Button>
                                                                ) : (
                                                                    <p className="text-[0.625rem] text-ink-faint">Waiting for authorization link...</p>
                                                                )}
                                                                {oauth.sessionId && (
                                                                    <form onSubmit={(event) => submitManualOAuth(event, provider.id, oauth.sessionId!)} className="pt-1">
                                                                        <Label htmlFor={`oauth-manual-${provider.id}`} className="mb-1.5">Remote redirect URL or code</Label>
                                                                        <div className="flex gap-2">
                                                                            <Input
                                                                                id={`oauth-manual-${provider.id}`}
                                                                                value={manualOAuthInput}
                                                                                onChange={(event) => setManualOAuthInput(event.target.value)}
                                                                                className="min-w-0 flex-1"
                                                                                placeholder="Paste the final redirect URL"
                                                                            />
                                                                            <Button type="submit" variant="outline" disabled={!manualOAuthInput.trim() || busy}>{busy ? "Submitting..." : "Submit"}</Button>
                                                                        </div>
                                                                    </form>
                                                                )}
                                                            </div>
                                                        )}
                                                        {oauth?.status === "pending" && oauth.type === "device_code" && (
                                                            <div className="max-w-sm">
                                                                <p className="text-[0.65625rem] font-bold">Enter this device code</p>
                                                                {oauth.userCode ? (
                                                                    <div className="mt-2 flex gap-2">
                                                                        <code className="flex min-h-9 min-w-0 flex-1 items-center justify-center break-all rounded-md bg-primary-soft px-3 font-mono text-[0.875rem] font-bold tracking-[0.14em]">
                                                                            {oauth.userCode}
                                                                        </code>
                                                                        <Tooltip>
                                                                            <TooltipTrigger asChild>
                                                                                <Button
                                                                                    type="button"
                                                                                    variant="outline"
                                                                                    size="icon-lg"
                                                                                    onClick={() => copyDeviceCode(oauth.userCode!)}
                                                                                    className="size-9"
                                                                                    aria-label="Copy device code"
                                                                                >
                                                                                    <Clipboard size={13} />
                                                                                </Button>
                                                                            </TooltipTrigger>
                                                                            <TooltipContent>Copy device code</TooltipContent>
                                                                        </Tooltip>
                                                                    </div>
                                                                ) : (
                                                                    <p className="mt-2 text-[0.625rem] text-ink-faint">Waiting for device code...</p>
                                                                )}
                                                                {oauth.verificationUri && (
                                                                    <Button asChild variant="link" className="mt-2 h-8 px-0 text-[0.65625rem]">
                                                                        <a href={oauth.verificationUri} target="_blank" rel="noopener noreferrer">
                                                                            Open verification page <ExternalLink size={11} />
                                                                        </a>
                                                                    </Button>
                                                                )}
                                                            </div>
                                                        )}
                                                        {oauth?.status === "done" && (
                                                            <Alert className="bg-transparent p-0 text-[0.65625rem] font-bold text-success" role="status">
                                                                <AlertDescription className="flex items-center gap-1.5">
                                                                    <Check size={12} /> Provider connected
                                                                </AlertDescription>
                                                            </Alert>
                                                        )}
                                                        {oauth?.status === "error" && (
                                                            <div>
                                                                <Alert variant="destructive" className="bg-transparent p-0 text-[0.65625rem]" role="alert">
                                                                    <AlertDescription>{oauth.error ?? "Authentication failed."}</AlertDescription>
                                                                </Alert>
                                                                <Button type="button" variant="outline" onClick={() => startOAuth(provider.id)} className="mt-2">
                                                                    <RefreshCw size={12} /> Try again
                                                                </Button>
                                                            </div>
                                                        )}
                                                    </TabsContent>
                                                </Tabs>
                                                <div className="mt-3 flex min-h-7 items-center justify-between gap-3 border-t border-line pt-2">
                                                    <div className="min-w-0 flex-1">
                                                        {feedback && (
                                                            <Alert
                                                                variant={feedback.type === "error" ? "destructive" : "default"}
                                                                className={`bg-transparent p-0 text-[0.625rem] ${feedback.type === "success" ? "text-success" : ""}`}
                                                                role={feedback.type === "error" ? "alert" : "status"}
                                                            >
                                                                <AlertDescription>{feedback.text}</AlertDescription>
                                                            </Alert>
                                                        )}
                                                    </div>
                                                    {provider.configured && (
                                                        <Button
                                                            type="button"
                                                            variant="link"
                                                            size="sm"
                                                            onClick={() => removeProvider(provider.id)}
                                                            disabled={busy}
                                                            className="px-1 text-[0.625rem] text-danger"
                                                        >
                                                            Remove authentication
                                                        </Button>
                                                    )}
                                                </div>
                                            </CollapsibleContent>
                                        </section>
                                    </Collapsible>
                                );
                            })}
                            {filteredProviders.length === 0 && (
                                <div className="py-10 text-center">
                                    <Search size={18} className="mx-auto text-ink-faint" />
                                    <p className="mt-3 text-xs font-bold">No providers found</p>
                                    <p className="mt-1 text-[0.65625rem] text-ink-faint">Try another name or model.</p>
                                </div>
                            )}
                        </div>
                    </ScrollArea>
                    <Separator />
                    <DialogFooter className="flex-row justify-end gap-0 bg-surface px-4 py-3">
                        <DialogClose asChild>
                            <Button type="button" variant="outline">Close</Button>
                        </DialogClose>
                    </DialogFooter>
                </div>
            </DialogContent>
        </Dialog>
    );
}
