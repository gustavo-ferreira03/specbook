"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import {
    AlertCircle,
    LayoutDashboard,
    ChevronRight,
    ChevronsUpDown,
    Compass,
    FileCheck2,
    LoaderCircle,
    Menu,
    MessageSquare,
    Pause,
    Pencil,
    Play,
    Plus,
    RefreshCw,
    Settings,
    Trash2,
    X,
} from "lucide-react";
import {
    deleteChat,
    deleteFeature,
    deleteSpec,
    errorMessage,
    getHealth,
    getLlmRuntimeStatus,
    getProjectTree,
    isAbortError,
    listProjectChats,
    listProjects,
} from "@/lib/api";
import { useRunEnvironment } from "@/lib/useRunEnvironment";
import { useAuth } from "@/components/AuthProvider";
import { UserMenu } from "@/components/UserMenu";
import { matchesInvalidation, onInvalidate } from "@/lib/invalidation";
import { countLabel } from "@/lib/format";
import { useProjectOverview } from "@/lib/projectOverview";
import type { Chat, Feature, Project, RunBatch, SpecSummary } from "@/lib/types";
import { useVisiblePolling } from "@/lib/usePolling";
import { useRunBatch } from "@/lib/useRunBatch";
import { ConfirmDeleteDialog } from "./ConfirmDeleteDialog";
import { FeatureEditDialog } from "./FeatureEditDialog";
import { LogoMark } from "./LogoMark";
import { RelativeTime } from "./RelativeTime";
import { SpecRunDialog } from "./SpecRunDialog";
import { StatusDot } from "./StatusDot";
import { ThemeToggle } from "./ThemeToggle";
import { Alert, AlertDescription, AlertTitle } from "./ui/alert";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./ui/collapsible";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuRadioGroup,
    DropdownMenuRadioItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import { ScrollArea } from "./ui/scroll-area";
import { Sheet, SheetClose, SheetContent, SheetDescription, SheetTitle, SheetTrigger } from "./ui/sheet";
import { Skeleton } from "./ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

type RuntimeState = "checking" | "online" | "setup" | "offline";
type SidebarTab = "specs" | "chats";

type DeleteTarget =
    | { kind: "chat"; item: Chat }
    | { kind: "spec"; item: SpecSummary }
    | { kind: "feature"; item: Feature };

function RowAction({ label, tooltip, onClick, disabled, danger, children }: { label: string; tooltip: string; onClick: () => void; disabled?: boolean; danger?: boolean; children: React.ReactNode }) {
    return (
        <Tooltip>
            <TooltipTrigger asChild>
                <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    onClick={onClick}
                    disabled={disabled}
                    className={`text-ink-subtle ${danger ? "hover:bg-danger-soft hover:text-danger" : "hover:bg-surface-selected hover:text-ink"}`}
                    aria-label={label}
                >
                    {children}
                </Button>
            </TooltipTrigger>
            <TooltipContent>{tooltip}</TooltipContent>
        </Tooltip>
    );
}

export function Sidebar({ projectId }: { projectId: string }) {
    const { canEdit, isAdmin } = useAuth();
    const router = useRouter();
    const pathname = usePathname();
    const [projects, setProjects] = useState<Project[]>([]);
    const [features, setFeatures] = useState<Feature[]>([]);
    const [environment] = useRunEnvironment(projectId);
    const [specs, setSpecs] = useState<SpecSummary[]>([]);
    const { data: overview } = useProjectOverview();
    const [chats, setChats] = useState<Chat[]>([]);
    const [loaded, setLoaded] = useState(false);
    const [loadError, setLoadError] = useState("");
    const [runtime, setRuntime] = useState<RuntimeState>("checking");
    const [expandedFeatures, setExpandedFeatures] = useState<Set<string>>(new Set());
    const [refreshKey, setRefreshKey] = useState(0);
    const [drawerOpen, setDrawerOpen] = useState(false);
    const [desktopProjectMenuOpen, setDesktopProjectMenuOpen] = useState(false);
    const [mobileProjectMenuOpen, setMobileProjectMenuOpen] = useState(false);
    const [chosenTab, setChosenTab] = useState<SidebarTab>("specs");
    const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
    const [deletingItem, setDeletingItem] = useState(false);
    const [deleteError, setDeleteError] = useState("");
    const deleteTriggerRef = useRef<HTMLElement | null>(null);
    const navigationRequestRef = useRef<AbortController | null>(null);
    const runtimeRequestRef = useRef<AbortController | null>(null);
    const runBatch = useRunBatch(projectId, {
        onProgress: (batch: RunBatch) => {
            setSpecs((current) => current.map((spec) => {
                const result = batch.specs.find((item) => item.specId === spec.id);
                return result?.status === "passed" || result?.status === "failed"
                    ? { ...spec, status: result.status }
                    : spec;
            }));
        },
    });
    const batchRunning = runBatch.running;

    useEffect(() => {
        localStorage.setItem("specbook:last-project", projectId);
        setExpandedFeatures(new Set());
    }, [projectId]);

    useEffect(() => {
        setDrawerOpen(false);
        setDesktopProjectMenuOpen(false);
        setMobileProjectMenuOpen(false);
    }, [pathname, projectId]);

    useEffect(() => {
        const query = window.matchMedia("(min-width: 768px)");
        const handleChange = (event: MediaQueryListEvent) => {
            if (event.matches) setDrawerOpen(false);
        };
        query.addEventListener("change", handleChange);
        return () => query.removeEventListener("change", handleChange);
    }, []);

    async function refreshNavigation() {
        navigationRequestRef.current?.abort();
        const controller = new AbortController();
        navigationRequestRef.current = controller;
        const { signal } = controller;
        try {
            const [projectsResult, treeResult, chatsResult] = await Promise.all([
                listProjects(signal),
                getProjectTree(projectId, signal),
                listProjectChats(projectId, signal),
            ]);
            if (signal.aborted) return;
            setProjects(projectsResult.projects);
            setFeatures(treeResult.features);
            setSpecs(treeResult.specs);
            setChats(chatsResult.chats);
            setLoadError("");
            setLoaded(true);
        } catch (error) {
            if (signal.aborted || isAbortError(error)) return;
            setLoadError(errorMessage(error));
            setLoaded(true);
        }
    }

    async function checkRuntime() {
        runtimeRequestRef.current?.abort();
        const controller = new AbortController();
        runtimeRequestRef.current = controller;
        const { signal } = controller;
        try {
            const [health, llm] = await Promise.all([getHealth(signal), getLlmRuntimeStatus()]);
            // Only a model that was set up and stopped working needs attention here; the composer covers a missing one.
            if (!signal.aborted) setRuntime(!health.ok ? "offline" : !llm.ready && llm.provider && llm.model ? "setup" : "online");
        } catch (error) {
            if (!signal.aborted && !isAbortError(error)) setRuntime("offline");
        }
    }

    useEffect(() => {
        void refreshNavigation();
        return () => navigationRequestRef.current?.abort();
    }, [projectId, refreshKey]);

    useEffect(() => {
        void checkRuntime();
        return () => runtimeRequestRef.current?.abort();
    }, []);

    useVisiblePolling(() => void refreshNavigation(), 60_000);
    useVisiblePolling(() => void checkRuntime(), 30000);

    useEffect(() => onInvalidate((event) => {
        if (
            matchesInvalidation(event, "projects", projectId) ||
            matchesInvalidation(event, "tree", projectId) ||
            matchesInvalidation(event, "chats", projectId)
        ) {
            void refreshNavigation();
        }
        if (event.resource === "settings") {
            void checkRuntime();
            void refreshNavigation();
        }
    }), [projectId]);

    const projectName = projects.find((project) => project.id === projectId)?.name ?? "Current project";
    const attentionCount = overview?.summary.attentionCount ?? 0;
    const knownFeatureIds = new Set(features.map((feature) => feature.id));
    const rootFeatures = features.filter((feature) => feature.parentId === null || !knownFeatureIds.has(feature.parentId));
    const ungroupedSpecs = specs.filter((spec) => !knownFeatureIds.has(spec.featureId));
    const sortedChats = chats.toSorted((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    const pathTab: SidebarTab | null = pathname.startsWith(`/p/${projectId}/chats`) ? "chats" : pathname.startsWith(`/p/${projectId}/specs`) ? "specs" : null;
    const overviewHref = `/p/${projectId}/overview`;

    useEffect(() => {
        const activeSpec = specs.find((spec) => pathname === `/p/${projectId}/specs/${spec.id}`);
        const startId = activeSpec?.featureId;
        if (!startId) return;
        const ids = new Set<string>();
        let feature = features.find((item) => item.id === startId);
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
            if (deleteTarget.kind === "chat") {
                await deleteChat(deleteTarget.item.id);
                setChats((current) => current.filter((item) => item.id !== deleteTarget.item.id));
                if (pathname === `/p/${projectId}/chats/${deleteTarget.item.id}`) {
                    router.replace(`/p/${projectId}/chats`);
                }
            } else if (deleteTarget.kind === "spec") {
                await deleteSpec(deleteTarget.item.id);
                setSpecs((current) => current.filter((item) => item.id !== deleteTarget.item.id));
                if (pathname === `/p/${projectId}/specs/${deleteTarget.item.id}`) {
                    router.replace(`/p/${projectId}/specs`);
                }
            } else {
                const deletedFeatureIds = featureDeletionIds(deleteTarget.item.id);
                const deletedSpecIds = new Set(
                    specs.filter((spec) => deletedFeatureIds.has(spec.featureId)).map((spec) => spec.id),
                );
                await deleteFeature(deleteTarget.item.id);
                setFeatures((current) => current.filter((feature) => !deletedFeatureIds.has(feature.id)));
                setSpecs((current) => current.filter((spec) => !deletedSpecIds.has(spec.id)));
                setExpandedFeatures((current) => new Set([...current].filter((id) => !deletedFeatureIds.has(id))));
                const activeSpecId = pathname.match(/\/specs\/([^/]+)/)?.[1];
                const activeFeatureId = pathname.match(/\/features\/([^/]+)/)?.[1];
                if (
                    (activeSpecId && deletedSpecIds.has(activeSpecId)) ||
                    (activeFeatureId && deletedFeatureIds.has(activeFeatureId))
                ) {
                    router.replace(`/p/${projectId}/specs`);
                }
            }
            setDeleteTarget(null);
            setDeletingItem(false);
        } catch (error) {
            setDeleteError(errorMessage(error));
            setDeletingItem(false);
        }
    }

    function runSpecBatch(title: string, selectedSpecs: SpecSummary[]) {
        void runBatch.start(title, selectedSpecs.map((spec) => ({ id: spec.id, title: spec.title })), environment);
    }

    // Row actions are revealed on hover and whenever focus is inside the row, so they stay
    // reachable by keyboard; on touch screens (no hover) they are always visible.
    const rowActionsClass = !canEdit ? "hidden" :
        "flex shrink-0 items-center gap-0.5 pr-1 [@media(hover:hover)]:invisible [@media(hover:hover)]:absolute [@media(hover:hover)]:inset-y-0 [@media(hover:hover)]:right-0 [@media(hover:hover)]:bg-linear-to-l [@media(hover:hover)]:from-(--row-bg) [@media(hover:hover)]:from-65% [@media(hover:hover)]:to-transparent [@media(hover:hover)]:pl-7 [@media(hover:hover)]:group-hover:visible [@media(hover:hover)]:group-focus-within:visible";
    const rowClass = (selected: boolean) =>
        `group relative flex min-h-10 w-full min-w-0 items-center rounded-md transition-colors duration-150 md:min-h-8 ${
            selected
                ? "bg-surface-selected text-ink [--row-bg:var(--color-surface-selected)]"
                : "text-ink-muted [--row-bg:var(--color-sidebar)] hover:bg-surface-hover hover:text-ink hover:[--row-bg:var(--color-surface-hover)] focus-within:bg-surface-hover focus-within:[--row-bg:var(--color-surface-hover)]"
        }`;
    const rowLinkClass = "flex min-h-10 min-w-0 flex-1 items-center gap-2 rounded-md text-control outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset md:min-h-8";

    function renderSpec(spec: SpecSummary) {
        const href = `/p/${projectId}/specs/${spec.id}`;
        const selected = pathname === href;
        const health = overview?.specHealth[spec.id];
        return (
            <div key={spec.id} className={rowClass(selected)}>
                <Link href={href} aria-current={selected ? "page" : undefined} className={`${rowLinkClass} pr-2 pl-2 ${selected ? "font-medium" : ""}`} title={health ? `${spec.title}: ${health.label}` : spec.title}>
                    <StatusDot status={health?.status ?? spec.status} size={14} />
                    <span className="min-w-0 flex-1 truncate">{spec.title}</span>
                </Link>
                <div className={rowActionsClass}>
                    <RowAction label={`Run Spec ${spec.title}`} tooltip="Run Spec" onClick={() => runSpecBatch(`Run ${spec.title}`, [spec])} disabled={batchRunning}>
                        <Play size={13} />
                    </RowAction>
                    <RowAction label={`Delete Spec ${spec.title}`} tooltip="Delete Spec" onClick={() => openDelete({ kind: "spec", item: spec })} danger>
                        <Trash2 size={13} />
                    </RowAction>
                </div>
            </div>
        );
    }

    function renderFeature(feature: Feature): React.ReactNode {
        const expanded = expandedFeatures.has(feature.id);
        const count = featureSpecCount(feature.id);
        const href = `/p/${projectId}/specs#feature-${feature.id}`;
        const childSpecs = specs.filter((spec) => spec.featureId === feature.id);
        const childFeatures = features.filter((child) => child.parentId === feature.id);
        return (
            <Collapsible key={feature.id} open={expanded} onOpenChange={(open) => setFeatureExpanded(feature.id, open)} className="w-full min-w-0">
                <div className={rowClass(false)}>
                    <CollapsibleTrigger asChild>
                        <Button
                            type="button"
                            variant="ghost"
                            size="icon-xs"
                            className="ml-0.5 size-7 shrink-0 text-ink-subtle hover:bg-transparent hover:text-ink"
                            aria-label={expanded ? `Collapse ${feature.title}` : `Expand ${feature.title}`}
                        >
                            <ChevronRight size={14} className={`transition-transform duration-150 ${expanded ? "rotate-90" : ""}`} />
                        </Button>
                    </CollapsibleTrigger>
                    <Link href={href} className={`${rowLinkClass} pr-2 font-medium text-ink`} title={feature.title}>
                        <span className="min-w-0 flex-1 truncate">{feature.title}</span>
                        <span className="tabular text-meta font-normal text-ink-subtle" aria-label={countLabel(count, "Spec")}>{count}</span>
                    </Link>
                    <div className={rowActionsClass}>
                        <RowAction
                            label={`Run all Specs in ${feature.title}`} tooltip="Run feature"
                            onClick={() => {
                                const featureIds = featureDeletionIds(feature.id);
                                runSpecBatch(`Run ${feature.title}`, specs.filter((spec) => featureIds.has(spec.featureId)));
                            }}
                            disabled={batchRunning || count === 0}
                        >
                            <Play size={13} />
                        </RowAction>
                        <FeatureEditDialog
                            feature={feature}
                            onSaved={() => setRefreshKey((key) => key + 1)}
                            renderTrigger={(onClick) => (
                                <RowAction label={`Edit feature ${feature.title}`} tooltip="Edit feature" onClick={onClick}>
                                    <Pencil size={13} />
                                </RowAction>
                            )}
                        />
                        <RowAction label={`Delete feature ${feature.title}`} tooltip="Delete feature" onClick={() => openDelete({ kind: "feature", item: feature })} danger>
                            <Trash2 size={13} />
                        </RowAction>
                    </div>
                </div>
                <CollapsibleContent>
                    {(childSpecs.length > 0 || childFeatures.length > 0) && (
                        <div className="relative ml-[15px] space-y-px border-l border-line py-0.5 pl-1.5">
                            {childSpecs.map((spec) => renderSpec(spec))}
                            {childFeatures.map((child) => renderFeature(child))}
                        </div>
                    )}
                </CollapsibleContent>
            </Collapsible>
        );
    }

    // Only problems the user can act on get a row; a healthy runtime stays silent.
    const runtimeCopy = runtime === "setup"
        ? ["Model unavailable", isAdmin ? "Reconnect the provider" : "Ask an administrator"]
        : runtime === "offline" ? ["Runtime unavailable", "Backend is not responding"] : null;
    const runtimeDot = runtime === "setup" ? "bg-warning-chart" : "bg-danger";
    const settingsHref = `/p/${projectId}/settings`;
    const onSettings = pathname === settingsHref;

    function renderNavLink(href: string, label: string, Icon: typeof Compass, extra?: React.ReactNode) {
        const selected = pathname === href;
        return (
            <div className={`${rowClass(selected)} pr-1`}>
                <Link href={href} onClick={() => setDrawerOpen(false)} aria-current={selected ? "page" : undefined} className={`flex min-h-10 min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-body outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset md:min-h-9 ${selected ? "font-medium" : ""}`}>
                    <Icon size={15} aria-hidden="true" /> {label}
                </Link>
                {extra}
            </div>
        );
    }

    function renderLoadError() {
        if (!loadError) return null;
        return (
            <Alert variant="danger" className="mx-3 mb-2 w-auto">
                <AlertTitle className="flex items-center gap-1.5"><AlertCircle size={14} /> Navigation could not update</AlertTitle>
                <AlertDescription>
                    <Button type="button" variant="link" size="sm" onClick={() => setRefreshKey((key) => key + 1)} className="mt-1 text-danger">
                        <RefreshCw size={13} /> Try again
                    </Button>
                </AlertDescription>
            </Alert>
        );
    }

    function renderLoading() {
        if (loaded) return null;
        return (
            <div className="space-y-1 px-2 pt-1" aria-label="Loading navigation" aria-busy="true" role="status">
                {[72, 58, 84, 64, 50].map((width, index) => (
                    <div key={index} className="flex h-8 items-center gap-2 px-2">
                        <Skeleton className="size-3.5 rounded-full" />
                        <Skeleton className="h-3 rounded-sm" style={{ width: `${width}%` }} />
                    </div>
                ))}
            </div>
        );
    }

    function renderNavigationContent(mobile = false) {
        const projectMenuOpen = mobile ? mobileProjectMenuOpen : desktopProjectMenuOpen;
        const setProjectMenuOpen = mobile ? setMobileProjectMenuOpen : setDesktopProjectMenuOpen;
        const brandLabel = <span className="truncate text-section font-semibold tracking-[-0.01em] text-ink">Specbook</span>;
        return (
            <>
                <div className="flex h-14 shrink-0 items-center gap-2 px-3">
                    <Link href={`/p/${projectId}/overview`} className="flex min-w-0 flex-1 items-center gap-2.5 rounded-md px-1 py-1 outline-none focus-visible:ring-2 focus-visible:ring-ring">
                        <LogoMark className="size-7 dark:invert" />
                        {mobile ? <SheetTitle asChild>{brandLabel}</SheetTitle> : brandLabel}
                    </Link>
                    {mobile && (
                        <SheetClose asChild>
                            <Button type="button" variant="ghost" size="icon-lg" aria-label="Close navigation">
                                <X size={18} />
                            </Button>
                        </SheetClose>
                    )}
                </div>

                <div className="px-3 pb-3">
                    <DropdownMenu open={projectMenuOpen} onOpenChange={setProjectMenuOpen}>
                        <DropdownMenuTrigger asChild>
                            <Button variant="outline" className="h-10 w-full justify-between gap-2 rounded-lg bg-surface px-2 text-left md:h-9">
                                <span className="flex min-w-0 items-center gap-2">
                                    <span className="flex size-5 shrink-0 items-center justify-center rounded-[5px] bg-surface-selected text-label text-ink uppercase" aria-hidden="true">
                                        {projectName.trim().charAt(0) || "P"}
                                    </span>
                                    <span className="truncate font-medium text-ink">{projectName}</span>
                                </span>
                                <ChevronsUpDown size={14} className="text-ink-subtle" />
                            </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="start" sideOffset={4} className="max-h-72 w-[var(--radix-dropdown-menu-trigger-width)]">
                            <DropdownMenuLabel>Projects</DropdownMenuLabel>
                            <DropdownMenuRadioGroup value={projectId} onValueChange={chooseProject}>
                                {projects.map((project) => (
                                    <DropdownMenuRadioItem key={project.id} value={project.id} className={project.id === projectId ? "font-medium" : undefined}>
                                        <span className="truncate">{project.name}</span>
                                    </DropdownMenuRadioItem>
                                ))}
                            </DropdownMenuRadioGroup>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem asChild disabled={!canEdit} className={canEdit ? undefined : "hidden"}>
                                <Link href="/?new=1"><Plus size={14} /> Create project</Link>
                            </DropdownMenuItem>
                        </DropdownMenuContent>
                    </DropdownMenu>
                </div>

                <nav aria-label="Project" className="space-y-px px-2 pb-2">
                    {renderNavLink(overviewHref, "Overview", LayoutDashboard, attentionCount > 0 && (
                        <Badge variant="secondary" size="sm" className="ml-auto" aria-label={`${countLabel(attentionCount, "item needs", "items need")} you`} title={`${countLabel(attentionCount, "needs", "need")} you`}>{attentionCount}</Badge>
                    ))}
                    {renderNavLink(`/p/${projectId}`, "App", Compass)}
                </nav>

                <Tabs value={pathTab ?? chosenTab} onValueChange={(value) => setChosenTab(value as SidebarTab)} className="min-h-0 flex-1">
                    <div className="flex items-center gap-2 px-3 pb-2">
                        <TabsList variant="segmented" className="grid flex-1 grid-cols-2" aria-label="Project content">
                            <TabsTrigger value="specs" className="h-9 md:h-8"><FileCheck2 size={14} /> Specs</TabsTrigger>
                            <TabsTrigger value="chats" className="h-9 md:h-8"><MessageSquare size={14} /> Chats</TabsTrigger>
                        </TabsList>
                    </div>
                    {renderLoadError()}

                    <TabsContent value="specs" className="data-[state=active]:flex data-[state=active]:flex-col">
                        <div className="flex h-9 shrink-0 items-center justify-between gap-2 pr-2 pl-4">
                            <Link href={`/p/${projectId}/specs`} onClick={() => setDrawerOpen(false)} className="text-meta font-medium text-ink-subtle hover:text-ink">All Specs</Link>
                            {batchRunning && (
                                <Button type="button" variant="ghost" size="sm" onClick={() => runBatch.setOpen(true)} className="h-7 gap-1 px-2 text-meta text-ink-muted">
                                    <LoaderCircle size={13} className="animate-spin text-running motion-reduce:animate-none" /> View run
                                </Button>
                            )}
                        </div>
                        <ScrollArea className="min-h-0 flex-1">
                            <div className="w-full min-w-0 space-y-px px-2 pb-3">
                                {renderLoading()}
                                {loaded && rootFeatures.map((feature) => renderFeature(feature))}
                                {loaded && ungroupedSpecs.map((spec) => renderSpec(spec))}
                                {loaded && features.length === 0 && specs.length === 0 && !loadError && <p className="px-2 py-1.5 text-meta text-ink-subtle">No Specs yet</p>}
                            </div>
                        </ScrollArea>
                    </TabsContent>

                    <TabsContent value="chats" className="data-[state=active]:flex data-[state=active]:flex-col">
                        <div className="flex h-9 shrink-0 items-center justify-between gap-2 pr-2 pl-4">
                            <Link href={`/p/${projectId}/chats`} onClick={() => setDrawerOpen(false)} className="text-meta font-medium text-ink-subtle hover:text-ink">All chats</Link>
                            {canEdit && (
                                <Tooltip>
                                    <TooltipTrigger asChild>
                                        <Button asChild variant="ghost" size="icon-xs" className="text-ink-subtle" aria-label="New chat">
                                            <Link href={`/p/${projectId}/chats/new`} onClick={() => setDrawerOpen(false)}><Plus size={15} /></Link>
                                        </Button>
                                    </TooltipTrigger>
                                    <TooltipContent>New chat</TooltipContent>
                                </Tooltip>
                            )}
                        </div>
                        <ScrollArea className="min-h-0 flex-1">
                            <div className="w-full min-w-0 space-y-px px-2 pb-3">
                                {renderLoading()}
                                {loaded && sortedChats.map((chat) => {
                                    const href = `/p/${projectId}/chats/${chat.id}`;
                                    const selected = pathname === href;
                                    return (
                                        <div key={chat.id} className={rowClass(selected)}>
                                            <Link href={href} aria-current={selected ? "page" : undefined} className={`${rowLinkClass} flex-col items-stretch justify-center gap-0 px-2.5 py-1.5`} title={chat.title}>
                                                <span className={`block truncate ${selected ? "font-medium text-ink" : "text-ink"}`}>{chat.title}</span>
                                                <span className={`block truncate text-meta ${selected ? "text-ink-muted" : "text-ink-subtle"}`}>
                                                    <RelativeTime value={chat.createdAt} />
                                                </span>
                                            </Link>
                                            <div className={rowActionsClass}>
                                                <RowAction label={`Delete chat ${chat.title}`} tooltip="Delete chat" onClick={() => openDelete({ kind: "chat", item: chat })} danger>
                                                    <Trash2 size={13} />
                                                </RowAction>
                                            </div>
                                        </div>
                                    );
                                })}
                                {loaded && chats.length === 0 && !loadError && <p className="px-2 py-1.5 text-meta text-ink-subtle">No chats yet</p>}
                            </div>
                        </ScrollArea>
                    </TabsContent>
                </Tabs>

                <div className="shrink-0 space-y-1 border-t border-line p-2">
                    {(overview?.summary.paused || overview?.summary.globallyPaused) && <p className="flex items-center gap-2 px-2 py-1 text-meta text-ink-subtle"><Pause size={13} aria-hidden="true" />{overview.summary.globallyPaused ? "Paused across all projects" : "Paused by you"}</p>}
                    {runtimeCopy && <Link
                        href={isAdmin ? "/settings?tab=model" : `/p/${projectId}/overview`}
                        className="flex min-h-10 items-center gap-2.5 rounded-md px-2 py-1.5 outline-none transition-colors hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-ring"
                    >
                        <span className={`size-2 shrink-0 rounded-full ${runtimeDot}`} aria-hidden="true" />
                        <span className="min-w-0 flex-1">
                            <span className="block truncate text-control font-medium text-ink">{runtimeCopy[0]}</span>
                            <span className="block truncate text-meta text-ink-subtle">{runtimeCopy[1]}</span>
                        </span>
                    </Link>}
                    <div className="flex items-center justify-between gap-2">
                        {canEdit && <Link
                            href={settingsHref}
                            aria-current={onSettings ? "page" : undefined}
                            className={`flex h-9 min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-control outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring md:h-8 ${onSettings ? "bg-surface-selected font-medium text-ink" : "text-ink-muted hover:bg-surface-hover hover:text-ink"}`}
                        >
                            <Settings size={15} /> Settings
                        </Link>}
                        <ThemeToggle />
                    </div>
                    <UserMenu />
                </div>
            </>
        );
    }

    return (
        <>
            <Sheet open={drawerOpen} onOpenChange={setDrawerOpen}>
                <header className="flex h-14 shrink-0 items-center gap-1 border-b border-line bg-sidebar px-2 md:hidden">
                    <SheetTrigger asChild>
                        <Button type="button" variant="ghost" size="icon-lg" aria-label="Open navigation">
                            <Menu size={19} />
                        </Button>
                    </SheetTrigger>
                    <Link href={`/p/${projectId}/overview`} className="flex min-w-0 flex-1 items-center gap-2.5 rounded-md px-1 py-1 outline-none focus-visible:ring-2 focus-visible:ring-ring">
                        <LogoMark className="size-7 dark:invert" />
                        <span className="truncate text-control font-semibold text-ink">{projectName}</span>
                    </Link>
                    {canEdit && <Button asChild variant="ghost" size="icon-lg" aria-label="Open settings">
                        <Link href={settingsHref}><Settings size={18} /></Link>
                    </Button>}
                </header>
                <SheetContent side="left" showCloseButton={false} className="w-[min(288px,88vw)] p-0 md:hidden">
                    <SheetDescription className="sr-only">Project navigation</SheetDescription>
                    {renderNavigationContent(true)}
                </SheetContent>
            </Sheet>
            <aside id="project-navigation" aria-label="Project navigation" className="hidden h-dvh w-sidebar shrink-0 flex-col border-r border-line bg-sidebar md:flex">
                {renderNavigationContent()}
            </aside>
            <ConfirmDeleteDialog
                open={deleteTarget !== null}
                title={deleteTarget?.kind === "chat" ? "Delete chat?" : deleteTarget?.kind === "spec" ? "Delete Spec?" : "Delete feature?"}
                description={deleteTarget ? (() => {
                    if (deleteTarget.kind === "chat") {
                        return <>The chat <strong className="font-semibold text-ink">{deleteTarget.item.title}</strong>, its messages, and browser session will be permanently removed. Specs created from it will remain.</>;
                    }
                    if (deleteTarget.kind === "spec") {
                        return <>The active files for <strong className="font-semibold text-ink">{deleteTarget.item.title}</strong>, its run history, and all evidence will be removed. Earlier file revisions remain in Git history.</>;
                    }
                    const featureIds = featureDeletionIds(deleteTarget.item.id);
                    const specCount = specs.filter((spec) => featureIds.has(spec.featureId)).length;
                    const childCount = featureIds.size - 1;
                    return <>
                        <strong className="font-semibold text-ink">{deleteTarget.item.title}</strong> will be removed{childCount ? ` with ${countLabel(childCount, "nested feature")}` : ""}. This also deletes {countLabel(specCount, "active Spec")}, run history, and evidence inside it. Earlier file revisions remain in Git history.
                    </>;
                })() : null}
                confirmLabel={deleteTarget?.kind === "chat" ? "Delete chat" : deleteTarget?.kind === "spec" ? "Delete Spec" : "Delete feature"}
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
                environment={runBatch.environment ?? undefined}
                open={runBatch.open}
                onOpenChange={runBatch.setOpen}
                title={runBatch.title}
                items={runBatch.items}
                running={runBatch.running}
                reportUrl={runBatch.reportUrl}
                error={runBatch.error}
                warning={runBatch.warning}
            />
        </>
    );
}
