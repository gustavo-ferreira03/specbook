"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import {
    AlertCircle,
    ChevronDown,
    ChevronRight,
    FileCheck2,
    Folder,
    FolderOpen,
    LoaderCircle,
    Menu,
    MessageSquare,
    Play,
    Plus,
    RefreshCw,
    Settings,
    Trash2,
    X,
} from "lucide-react";
import { API_URL, api, getLlmRuntimeStatus, getRunBatch, startRunBatch } from "@/lib/api";
import type { Conversation, Feature, Project, RunBatch, SpecSummary } from "@/lib/types";
import { ConfirmDeleteDialog } from "./ConfirmDeleteDialog";
import { LogoMark } from "./LogoMark";
import { SpecRunDialog, type SpecBatchItem } from "./SpecRunDialog";
import { StatusDot } from "./StatusDot";
import { Alert, AlertDescription, AlertTitle } from "./ui/alert";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./ui/collapsible";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuRadioGroup,
    DropdownMenuRadioItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import { ScrollArea } from "./ui/scroll-area";
import { Separator } from "./ui/separator";
import { Sheet, SheetClose, SheetContent, SheetDescription, SheetTitle, SheetTrigger } from "./ui/sheet";
import { Skeleton } from "./ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

type SidebarTab = "conversations" | "specs";
type RuntimeState = "checking" | "online" | "setup" | "offline";
type DeleteTarget =
    | { kind: "conversation"; item: Conversation }
    | { kind: "spec"; item: SpecSummary }
    | { kind: "feature"; item: Feature };

function conversationDate(value: string) {
    const date = new Date(value);
    const today = new Date();
    const start = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
    const target = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
    const days = Math.round((start - target) / 86_400_000);
    if (days === 0) return "Today";
    if (days === 1) return "Yesterday";
    return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function Sidebar({ projectId }: { projectId: string }) {
    const router = useRouter();
    const pathname = usePathname();
    const [projects, setProjects] = useState<Project[]>([]);
    const [features, setFeatures] = useState<Feature[]>([]);
    const [specs, setSpecs] = useState<SpecSummary[]>([]);
    const [conversations, setConversations] = useState<Conversation[]>([]);
    const [activeTab, setActiveTab] = useState<SidebarTab>(pathname.includes("/specs/") ? "specs" : "conversations");
    const [loaded, setLoaded] = useState(false);
    const [loadError, setLoadError] = useState("");
    const [runtime, setRuntime] = useState<RuntimeState>("checking");
    const [expandedFeatures, setExpandedFeatures] = useState<Set<string>>(new Set());
    const [refreshKey, setRefreshKey] = useState(0);
    const [drawerOpen, setDrawerOpen] = useState(false);
    const [desktopProjectMenuOpen, setDesktopProjectMenuOpen] = useState(false);
    const [mobileProjectMenuOpen, setMobileProjectMenuOpen] = useState(false);
    const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
    const [deletingItem, setDeletingItem] = useState(false);
    const [deleteError, setDeleteError] = useState("");
    const [batchOpen, setBatchOpen] = useState(false);
    const [batchTitle, setBatchTitle] = useState("Run Specs");
    const [batchItems, setBatchItems] = useState<SpecBatchItem[]>([]);
    const [batchRunning, setBatchRunning] = useState(false);
    const [batchReportUrl, setBatchReportUrl] = useState<string | null>(null);
    const deleteTriggerRef = useRef<HTMLElement | null>(null);
    const batchActiveRef = useRef(false);

    useEffect(() => {
        localStorage.setItem("specbook:last-project", projectId);
        setExpandedFeatures(new Set());
    }, [projectId]);

    useEffect(() => {
        setDrawerOpen(false);
        setDesktopProjectMenuOpen(false);
        setMobileProjectMenuOpen(false);
        if (pathname.includes("/specs/")) setActiveTab("specs");
        if (pathname.includes("/conversations/")) setActiveTab("conversations");
    }, [pathname]);

    useEffect(() => {
        const query = window.matchMedia("(min-width: 768px)");
        const handleChange = (event: MediaQueryListEvent) => {
            if (event.matches) setDrawerOpen(false);
        };
        query.addEventListener("change", handleChange);
        return () => query.removeEventListener("change", handleChange);
    }, []);

    useEffect(() => {
        let active = true;
        async function refresh() {
            try {
                const [projectsResult, treeResult, conversationsResult] = await Promise.all([
                    api<{ projects: Project[] }>("/projects"),
                    api<{ features: Feature[]; specs: SpecSummary[] }>(`/projects/${projectId}/tree`),
                    api<{ conversations: Conversation[] }>(`/projects/${projectId}/conversations`),
                ]);
                if (!active) return;
                setProjects(projectsResult.projects);
                setFeatures(treeResult.features);
                setSpecs(treeResult.specs);
                setConversations(conversationsResult.conversations);
                setLoadError("");
                setLoaded(true);
            } catch (error) {
                if (!active) return;
                setLoadError(error instanceof Error ? error.message : String(error));
                setLoaded(true);
            }
        }
        void refresh();
        const interval = window.setInterval(refresh, 5000);
        return () => {
            active = false;
            window.clearInterval(interval);
        };
    }, [pathname, projectId, refreshKey]);

    useEffect(() => {
        let active = true;
        async function checkRuntime() {
            try {
                const [health, llm] = await Promise.all([api<{ ok: boolean }>("/health"), getLlmRuntimeStatus()]);
                if (active) setRuntime(!health.ok ? "offline" : llm.ready ? "online" : "setup");
            } catch {
                if (active) setRuntime("offline");
            }
        }
        void checkRuntime();
        const interval = window.setInterval(checkRuntime, 30000);
        return () => {
            active = false;
            window.clearInterval(interval);
        };
    }, [pathname]);

    const projectName = projects.find((project) => project.id === projectId)?.name ?? "Current project";
    const knownFeatureIds = new Set(features.map((feature) => feature.id));
    const rootFeatures = features.filter((feature) => feature.parentId === null || !knownFeatureIds.has(feature.parentId));
    const ungroupedSpecs = specs.filter((spec) => !knownFeatureIds.has(spec.featureId));

    useEffect(() => {
        const activeSpec = specs.find((spec) => pathname === `/p/${projectId}/specs/${spec.id}`);
        if (!activeSpec) return;
        const ids = new Set<string>();
        let feature = features.find((item) => item.id === activeSpec.featureId);
        while (feature) {
            ids.add(feature.id);
            feature = feature.parentId ? features.find((item) => item.id === feature?.parentId) : undefined;
        }
        setExpandedFeatures((current) => new Set([...current, ...ids]));
    }, [features, pathname, projectId, specs]);

    function featureSpecCount(featureId: string): number {
        const direct = specs.filter((spec) => spec.featureId === featureId).length;
        return direct + features.filter((feature) => feature.parentId === featureId).reduce((total, child) => total + featureSpecCount(child.id), 0);
    }

    function featureDeletionIds(featureId: string): Set<string> {
        const ids = new Set([featureId]);
        let changed = true;
        while (changed) {
            changed = false;
            for (const feature of features) {
                if (feature.parentId && ids.has(feature.parentId) && !ids.has(feature.id)) {
                    ids.add(feature.id);
                    changed = true;
                }
            }
        }
        return ids;
    }

    function setFeatureExpanded(featureId: string, expanded: boolean) {
        setExpandedFeatures((current) => {
            const next = new Set(current);
            if (expanded) next.add(featureId);
            else next.delete(featureId);
            return next;
        });
    }

    function chooseProject(id: string) {
        localStorage.setItem("specbook:last-project", id);
        setDesktopProjectMenuOpen(false);
        setMobileProjectMenuOpen(false);
        router.push(`/p/${id}`);
    }

    function openDelete(target: DeleteTarget) {
        deleteTriggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        setDeleteError("");
        setDeleteTarget(target);
    }

    async function deleteItem() {
        if (!deleteTarget || deletingItem) return;
        setDeletingItem(true);
        setDeleteError("");
        try {
            if (deleteTarget.kind === "conversation") {
                await api<void>(`/conversations/${deleteTarget.item.id}`, { method: "DELETE" });
                setConversations((current) => current.filter((item) => item.id !== deleteTarget.item.id));
                if (pathname === `/p/${projectId}/conversations/${deleteTarget.item.id}`) {
                    router.replace(`/p/${projectId}`);
                }
            } else if (deleteTarget.kind === "spec") {
                await api<void>(`/specs/${deleteTarget.item.id}`, { method: "DELETE" });
                setSpecs((current) => current.filter((item) => item.id !== deleteTarget.item.id));
                if (pathname === `/p/${projectId}/specs/${deleteTarget.item.id}`) {
                    router.replace(`/p/${projectId}`);
                }
            } else {
                const deletedFeatureIds = featureDeletionIds(deleteTarget.item.id);
                const deletedSpecIds = new Set(
                    specs.filter((spec) => deletedFeatureIds.has(spec.featureId)).map((spec) => spec.id),
                );
                await api<void>(`/features/${deleteTarget.item.id}`, { method: "DELETE" });
                setFeatures((current) => current.filter((feature) => !deletedFeatureIds.has(feature.id)));
                setSpecs((current) => current.filter((spec) => !deletedSpecIds.has(spec.id)));
                setExpandedFeatures((current) => new Set([...current].filter((id) => !deletedFeatureIds.has(id))));
                const activeSpecId = pathname.match(/\/specs\/([^/]+)/)?.[1];
                if (activeSpecId && deletedSpecIds.has(activeSpecId)) router.replace(`/p/${projectId}`);
            }
            setDeleteTarget(null);
            setDeletingItem(false);
        } catch (error) {
            setDeleteError(error instanceof Error ? error.message : String(error));
            setDeletingItem(false);
        }
    }

    async function runSpecBatch(title: string, selectedSpecs: SpecSummary[]) {
        if (batchActiveRef.current || selectedSpecs.length === 0) {
            if (batchActiveRef.current) setBatchOpen(true);
            return;
        }
        batchActiveRef.current = true;
        setBatchTitle(title);
        setBatchItems(selectedSpecs.map((spec) => ({
            specId: spec.id,
            title: spec.title,
            status: "running",
            durationMs: null,
            failReason: null,
        })));
        setBatchReportUrl(null);
        setBatchRunning(true);
        setBatchOpen(true);

        try {
            const applyBatch = (batch: RunBatch) => {
                setBatchItems(batch.specs.map((item) => ({
                    specId: item.specId,
                    title: item.title,
                    status: item.status,
                    durationMs: item.durationMs,
                    failReason: item.failReason,
                })));
                setSpecs((current) => current.map((spec) => {
                    const result = batch.specs.find((item) => item.specId === spec.id);
                    return result?.status === "passed" || result?.status === "failed"
                        ? { ...spec, status: result.status }
                        : spec;
                }));
            };
            let { batch } = await startRunBatch(projectId, selectedSpecs.map((spec) => spec.id), title);
            applyBatch(batch);
            do {
                if (batch.status === "running") await new Promise((resolve) => window.setTimeout(resolve, 750));
                const result = await getRunBatch(batch.id);
                batch = result.batch;
                applyBatch(batch);
                setBatchReportUrl(result.reportUrl ? `${API_URL}${result.reportUrl}` : null);
            } while (batch.status === "running");
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            setBatchItems((current) => current.map((item) => item.status === "running" ? { ...item, status: "error", failReason: message } : item));
        } finally {
            batchActiveRef.current = false;
            setBatchRunning(false);
            setRefreshKey((key) => key + 1);
        }
    }

    function renderSpec(spec: SpecSummary, depth: number) {
        const href = `/p/${projectId}/specs/${spec.id}`;
        const selected = pathname === href;
        return (
            <div
                key={spec.id}
                className={`group mb-0.5 flex min-h-10 w-full min-w-0 items-center overflow-hidden rounded-[8px] transition-colors md:min-h-[34px] ${
                    selected ? "bg-surface-selected text-ink" : "text-ink-soft hover:bg-surface-hover hover:text-ink"
                }`}
            >
                <Button
                    asChild
                    variant="ghost"
                    className={`h-auto min-h-10 min-w-0 flex-1 justify-start overflow-hidden whitespace-normal rounded-[8px] py-2 pr-0 text-[0.71875rem] hover:bg-transparent md:min-h-[34px] ${selected ? "font-bold text-ink" : "font-normal text-ink-soft"}`}
                    style={{ paddingLeft: 8 + depth * 12 }}
                >
                    <Link href={href} aria-current={selected ? "page" : undefined}>
                        <StatusDot status={spec.status} />
                        <span className="min-w-0 flex-1 break-words text-left leading-4">{spec.title}</span>
                    </Link>
                </Button>
                <Tooltip>
                    <TooltipTrigger asChild>
                        <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            onClick={() => void runSpecBatch(`Run ${spec.title}`, [spec])}
                            disabled={batchRunning}
                            className="text-ink-faint opacity-70 hover:text-ink group-hover:opacity-100 focus:opacity-100"
                            aria-label={`Run Spec ${spec.title}`}
                        >
                            <Play size={12} />
                        </Button>
                    </TooltipTrigger>
                    <TooltipContent>Run Spec</TooltipContent>
                </Tooltip>
                <Tooltip>
                    <TooltipTrigger asChild>
                        <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            onClick={() => openDelete({ kind: "spec", item: spec })}
                            className="mr-1 text-ink-faint opacity-70 hover:bg-danger-soft hover:text-danger group-hover:opacity-100 focus:opacity-100"
                            aria-label={`Delete Spec ${spec.title}`}
                        >
                            <Trash2 size={12} />
                        </Button>
                    </TooltipTrigger>
                    <TooltipContent>Delete Spec</TooltipContent>
                </Tooltip>
            </div>
        );
    }

    function renderFeature(feature: Feature, depth: number): React.ReactNode {
        const expanded = expandedFeatures.has(feature.id);
        const count = featureSpecCount(feature.id);
        return (
            <Collapsible key={feature.id} open={expanded} onOpenChange={(open) => setFeatureExpanded(feature.id, open)} className="w-full min-w-0 overflow-hidden">
                <div
                    className="group flex min-h-10 items-center rounded-[8px] pr-1 text-ink-soft hover:bg-surface-hover hover:text-ink focus-within:bg-surface-hover md:min-h-[34px]"
                    style={{ paddingLeft: 6 + depth * 12 }}
                >
                    <CollapsibleTrigger asChild>
                        <Button variant="ghost" className="h-auto min-h-10 min-w-0 flex-1 justify-start gap-1.5 rounded-[8px] px-0 text-left text-[0.6875rem] text-ink-soft hover:bg-transparent hover:text-ink md:min-h-[34px]">
                            {expanded ? <ChevronDown size={12} className="text-ink-faint" /> : <ChevronRight size={12} className="text-ink-faint" />}
                            {expanded ? <FolderOpen size={13} className="text-ink-faint" /> : <Folder size={13} className="text-ink-faint" />}
                            <span className="min-w-0 flex-1 truncate">{feature.title}</span>
                            <Badge variant="secondary" className="px-1.5 py-0.5 text-[0.5625rem] text-ink-faint">{count}</Badge>
                        </Button>
                    </CollapsibleTrigger>
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <Button
                                type="button"
                                variant="ghost"
                                size="icon-sm"
                                onClick={() => {
                                    const featureIds = featureDeletionIds(feature.id);
                                    void runSpecBatch(`Run ${feature.title}`, specs.filter((spec) => featureIds.has(spec.featureId)));
                                }}
                                disabled={batchRunning || count === 0}
                                className="text-ink-faint opacity-70 hover:text-ink group-hover:opacity-100 focus:opacity-100"
                                aria-label={`Run all Specs in feature ${feature.title}`}
                            >
                                <Play size={12} />
                            </Button>
                        </TooltipTrigger>
                        <TooltipContent>Run feature</TooltipContent>
                    </Tooltip>
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <Button
                                type="button"
                                variant="ghost"
                                size="icon-sm"
                                onClick={() => openDelete({ kind: "feature", item: feature })}
                                className="text-ink-faint opacity-70 hover:bg-danger-soft hover:text-danger group-hover:opacity-100 focus:opacity-100"
                                aria-label={`Delete feature ${feature.title}`}
                            >
                                <Trash2 size={12} />
                            </Button>
                        </TooltipTrigger>
                            <TooltipContent>Delete feature</TooltipContent>
                    </Tooltip>
                </div>
                <CollapsibleContent>
                    {specs.filter((spec) => spec.featureId === feature.id).map((spec) => renderSpec(spec, depth + 1))}
                    {features.filter((child) => child.parentId === feature.id).map((child) => renderFeature(child, depth + 1))}
                </CollapsibleContent>
            </Collapsible>
        );
    }

    const runtimeCopy = {
        checking: ["Checking runtime", "Connecting to services"],
        online: ["Runtime online", "Agent and runner ready"],
        setup: ["Model setup needed", "Choose a provider in Settings"],
        offline: ["Runtime unavailable", "Backend is not responding"],
    }[runtime];

    function renderLoadError() {
        if (!loadError) return null;
        return (
            <Alert variant="destructive" className="mx-3 mt-3 w-auto">
                <AlertTitle className="flex items-center gap-1.5"><AlertCircle size={13} /> Navigation could not update</AlertTitle>
                <AlertDescription>
                    <Button type="button" variant="link" size="sm" onClick={() => setRefreshKey((key) => key + 1)} className="mt-1 h-9 p-0 text-danger">
                        <RefreshCw size={12} /> Try again
                    </Button>
                </AlertDescription>
            </Alert>
        );
    }

    function renderLoading() {
        if (loaded) return null;
        return (
            <div className="space-y-2 px-1" aria-label="Loading navigation" aria-busy="true" role="status">
                <Skeleton className="h-12 rounded-[9px]" />
                <Skeleton className="h-12 w-4/5 rounded-[9px]" />
            </div>
        );
    }

    function renderNavigationContent(mobile = false) {
        const projectMenuOpen = mobile ? mobileProjectMenuOpen : desktopProjectMenuOpen;
        const setProjectMenuOpen = mobile ? setMobileProjectMenuOpen : setDesktopProjectMenuOpen;
        return (
            <>
                <div className="flex h-[72px] shrink-0 items-center gap-3 border-b border-line px-[17px]">
                    <Button asChild variant="ghost" className="h-auto min-w-0 flex-1 justify-start gap-3 rounded-none p-0 hover:bg-transparent">
                        <Link href={`/p/${projectId}`}>
                            <LogoMark className="size-[34px] shrink-0" />
                            {mobile ? (
                                <SheetTitle asChild>
                                    <span className="truncate text-base font-bold tracking-[-0.022em]">Specbook</span>
                                </SheetTitle>
                            ) : (
                                <span className="truncate text-base font-bold tracking-[-0.022em]">Specbook</span>
                            )}
                        </Link>
                    </Button>
                    {mobile && (
                        <SheetClose asChild>
                            <Button type="button" variant="ghost" size="icon-lg" className="size-11" aria-label="Close navigation">
                                <X size={18} />
                            </Button>
                        </SheetClose>
                    )}
                </div>

                <div className="px-[13px] pt-[13px] pb-2">
                    <DropdownMenu open={projectMenuOpen} onOpenChange={setProjectMenuOpen}>
                        <DropdownMenuTrigger asChild>
                            <Button variant="outline" className="h-[34px] w-full justify-between gap-3 px-2.5 text-left text-[0.71875rem] hover:border-line-hover">
                                <span className="flex min-w-0 items-center gap-2.5">
                                    <span className="size-2 shrink-0 rounded-[3px] bg-primary" />
                                    <span className="truncate">{projectName}</span>
                                </span>
                                <ChevronDown size={14} className={`text-ink-faint transition-transform ${projectMenuOpen ? "rotate-180" : ""}`} />
                            </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="start" sideOffset={4} className="max-h-72 w-[var(--radix-dropdown-menu-trigger-width)]">
                            <DropdownMenuRadioGroup value={projectId} onValueChange={chooseProject}>
                                {projects.map((project) => (
                                    <DropdownMenuRadioItem key={project.id} value={project.id} className={project.id === projectId ? "font-bold" : undefined}>
                                        <span className="truncate">{project.name}</span>
                                    </DropdownMenuRadioItem>
                                ))}
                            </DropdownMenuRadioGroup>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem asChild className="font-semibold">
                                <Link href="/?new=1"><Plus size={12} /> Create project</Link>
                            </DropdownMenuItem>
                        </DropdownMenuContent>
                    </DropdownMenu>
                </div>

                <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as SidebarTab)} className="min-h-0 flex-1">
                    <TabsList className="grid grid-cols-2 gap-1.5 px-[13px] pt-1 pb-[13px]" aria-label="Project content">
                        <TabsTrigger value="conversations" className="min-h-10 px-2 md:min-h-[34px]">
                            <MessageSquare size={15} /> Conversations
                        </TabsTrigger>
                        <TabsTrigger value="specs" className="min-h-10 px-2 md:min-h-[34px]">
                            <FileCheck2 size={15} /> Specs
                        </TabsTrigger>
                    </TabsList>
                    <Separator />

                    <TabsContent value="conversations" className="data-[state=active]:flex data-[state=active]:flex-col">
                        {renderLoadError()}
                        <div className="flex h-12 shrink-0 items-center justify-between px-[14px]">
                            <span className="text-[0.625rem] font-bold tracking-[0.08em] text-ink-faint uppercase">Conversations</span>
                            <Button asChild variant="ghost" size="icon" className="text-ink-faint" aria-label="Start conversation">
                                <Link href={`/p/${projectId}/conversations/new`}><Plus size={14} /></Link>
                            </Button>
                        </div>
                        <ScrollArea className="min-h-0 flex-1">
                            <div className="w-full min-w-0 overflow-hidden px-[9px] pb-3">
                                {renderLoading()}
                                {loaded && conversations.map((conversation) => {
                                    const href = `/p/${projectId}/conversations/${conversation.id}`;
                                    const selected = pathname === href;
                                    return (
                                        <div key={conversation.id} className={`group mb-0.5 flex items-center rounded-[9px] transition-colors ${selected ? "bg-surface-selected" : "hover:bg-surface-hover"}`}>
                                            <Button asChild variant="ghost" className="block h-auto min-w-0 flex-1 overflow-hidden whitespace-normal rounded-[9px] px-2.5 py-2.5 text-left hover:bg-transparent">
                                                <Link href={href} aria-current={selected ? "page" : undefined}>
                                                    <span className="flex min-w-0 items-center gap-2 overflow-hidden">
                                                        <span className={`size-2 shrink-0 rounded-full ${selected ? "bg-primary" : "bg-ink-disabled"}`} />
                                                        <span className={`block min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-[0.78125rem] ${selected ? "font-bold text-ink" : "font-semibold text-ink-soft"}`}>{conversation.title}</span>
                                                    </span>
                                                    <span className="mt-1 block truncate pl-4 text-[0.625rem] font-normal text-ink-faint">Created {conversationDate(conversation.createdAt)}</span>
                                                </Link>
                                            </Button>
                                            <Tooltip>
                                                <TooltipTrigger asChild>
                                                    <Button
                                                        type="button"
                                                        variant="ghost"
                                                        size="icon-sm"
                                                        onClick={() => openDelete({ kind: "conversation", item: conversation })}
                                                        className="mr-1 text-ink-faint opacity-70 hover:bg-danger-soft hover:text-danger group-hover:opacity-100 focus:opacity-100"
                                                        aria-label={`Delete conversation ${conversation.title}`}
                                                    >
                                                        <Trash2 size={12} />
                                                    </Button>
                                                </TooltipTrigger>
                                                <TooltipContent>Delete conversation</TooltipContent>
                                            </Tooltip>
                                        </div>
                                    );
                                })}
                                {loaded && conversations.length === 0 && !loadError && (
                                    <div className="px-2.5 py-4">
                                        <p className="text-[0.75rem] font-bold">No conversations yet</p>
                                        <p className="mt-1 text-[0.6875rem] leading-5 text-ink-faint">Start one to document a behavior.</p>
                                    </div>
                                )}
                            </div>
                        </ScrollArea>
                    </TabsContent>

                    <TabsContent value="specs" className="data-[state=active]:flex data-[state=active]:flex-col">
                        {renderLoadError()}
                        <div className="flex h-12 shrink-0 items-center justify-between gap-2 px-[14px]">
                            <span className="text-[0.625rem] font-bold tracking-[0.08em] text-ink-faint uppercase">Specs</span>
                            <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                onClick={() => batchRunning ? setBatchOpen(true) : void runSpecBatch("Run all Specs", specs)}
                                disabled={specs.length === 0}
                                className="text-ink-soft"
                            >
                                {batchRunning ? <LoaderCircle size={12} className="animate-spin motion-reduce:animate-none" /> : <Play size={12} />}
                                {batchRunning ? "View run" : "Run all"}
                            </Button>
                        </div>
                        <ScrollArea className="min-h-0 flex-1">
                            <div className="w-full min-w-0 overflow-hidden px-[9px] pb-3">
                                {renderLoading()}
                                {loaded && rootFeatures.map((feature) => renderFeature(feature, 0))}
                                {loaded && ungroupedSpecs.map((spec) => renderSpec(spec, 0))}
                                {loaded && features.length === 0 && specs.length === 0 && !loadError && (
                                    <div className="px-2.5 py-4">
                                        <p className="text-[0.75rem] font-bold">No Specs yet</p>
                                        <p className="mt-1 text-[0.6875rem] leading-5 text-ink-faint">Saved behavior will appear here.</p>
                                    </div>
                                )}
                            </div>
                        </ScrollArea>
                    </TabsContent>
                </Tabs>

                <div className="shrink-0 p-3 pt-0">
                    <Button
                        asChild
                        variant="outline"
                        className={`h-auto w-full justify-start gap-3 whitespace-normal rounded-xl p-3 ${
                            pathname === `/p/${projectId}/settings` ? "border-line-strong bg-primary-soft" : "border-line bg-surface hover:border-line-strong"
                        }`}
                    >
                        <Link href={`/p/${projectId}/settings`} aria-current={pathname === `/p/${projectId}/settings` ? "page" : undefined}>
                            <span className={`size-2 rounded-full ${runtime === "online" ? "bg-success" : runtime === "setup" ? "bg-pending" : runtime === "offline" ? "bg-danger" : "status-pulse bg-ink-faint"}`} />
                            <span className="min-w-0 flex-1 text-left">
                                <span className="block truncate text-[0.65625rem] font-bold">{runtimeCopy[0]}</span>
                                <span className="mt-0.5 block truncate text-[0.59375rem] font-normal text-ink-faint">{runtimeCopy[1]}</span>
                            </span>
                            <Settings size={14} className="text-ink-faint" />
                        </Link>
                    </Button>
                </div>
            </>
        );
    }

    return (
        <>
            <Sheet open={drawerOpen} onOpenChange={setDrawerOpen}>
                <header className="flex h-16 shrink-0 items-center gap-2 border-b border-line bg-surface px-2 md:hidden">
                    <SheetTrigger asChild>
                        <Button type="button" variant="ghost" size="icon-lg" className="size-11 hover:bg-canvas" aria-label="Open navigation">
                            <Menu size={19} />
                        </Button>
                    </SheetTrigger>
                    <Button asChild variant="ghost" className="h-auto min-w-0 flex-1 justify-start gap-2.5 px-1 hover:bg-transparent">
                        <Link href={`/p/${projectId}`}>
                            <LogoMark className="size-7 shrink-0" />
                            <span className="truncate text-[0.8125rem] font-bold">{projectName}</span>
                        </Link>
                    </Button>
                    <Button asChild variant="ghost" size="icon-lg" className="size-11 hover:bg-canvas" aria-label="Open settings">
                        <Link href={`/p/${projectId}/settings`}><Settings size={18} /></Link>
                    </Button>
                </header>
                <SheetContent side="left" showCloseButton={false} className="w-[min(276px,88vw)] p-0 md:hidden">
                    <SheetDescription className="sr-only">Project navigation</SheetDescription>
                    {renderNavigationContent(true)}
                </SheetContent>
            </Sheet>
            <aside id="project-navigation" aria-label="Project navigation" className="hidden h-dvh w-[276px] shrink-0 flex-col border-r border-line bg-sidebar md:flex">
                {renderNavigationContent()}
            </aside>
            <ConfirmDeleteDialog
                open={deleteTarget !== null}
                title={deleteTarget?.kind === "conversation" ? "Delete conversation?" : deleteTarget?.kind === "spec" ? "Delete Spec?" : "Delete feature?"}
                description={deleteTarget ? (() => {
                    if (deleteTarget.kind === "conversation") {
                        return <>The conversation <strong className="font-bold text-ink">{deleteTarget.item.title}</strong>, its messages, and browser session will be permanently removed. Specs created from it will remain.</>;
                    }
                    if (deleteTarget.kind === "spec") {
                        return <>The Spec <strong className="font-bold text-ink">{deleteTarget.item.title}</strong>, every version, its verification history, and all evidence will be permanently removed.</>;
                    }
                    const featureIds = featureDeletionIds(deleteTarget.item.id);
                    const specCount = specs.filter((spec) => featureIds.has(spec.featureId)).length;
                    const childCount = featureIds.size - 1;
                    return <>
                        <strong className="font-bold text-ink">{deleteTarget.item.title}</strong> will be permanently removed{childCount ? ` with ${childCount} nested ${childCount === 1 ? "feature" : "features"}` : ""}. This also deletes {specCount} {specCount === 1 ? "Spec" : "Specs"}, every version, run history, and evidence inside it.
                    </>;
                })() : null}
                confirmLabel={deleteTarget?.kind === "conversation" ? "Delete conversation" : deleteTarget?.kind === "spec" ? "Delete Spec" : "Delete feature"}
                busy={deletingItem}
                error={deleteError}
                returnFocusRef={deleteTriggerRef}
                onCancel={() => {
                    setDeleteTarget(null);
                    setDeleteError("");
                }}
                onConfirm={() => void deleteItem()}
            />
            <SpecRunDialog
                open={batchOpen}
                onOpenChange={setBatchOpen}
                title={batchTitle}
                items={batchItems}
                running={batchRunning}
                reportUrl={batchReportUrl}
            />
        </>
    );
}
