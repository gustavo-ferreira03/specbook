"use client";

import Link from "next/link";
import { use, useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
    AlertCircle,
    ArrowRight,
    BookOpenCheck,
    Check,
    ChevronDown,
    ChevronRight,
    Compass,
    ExternalLink,
    LoaderCircle,
    MessageSquareText,
    PencilLine,
    RefreshCw,
    SearchX,
    Trash2,
    X,
} from "lucide-react";
import { ConfirmDeleteDialog } from "@/components/ConfirmDeleteDialog";
import { ContextReadout } from "@/components/ContextReadout";
import { DraftReview } from "@/components/DraftReview";
import { EmptyState } from "@/components/EmptyState";
import { PageContainer, PageHeader } from "@/components/PageHeader";
import { RelativeTime } from "@/components/RelativeTime";
import { SectionHeader } from "@/components/SectionHeader";
import { StatusPill } from "@/components/StatusPill";
import { SummaryStrip } from "@/components/SummaryStrip";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import {
    ApiError,
    errorMessage,
    getProject,
    getProjectTree,
    listProjectChats,
    createContextDiscovery,
    discardProjectContext,
    getProjectContext,
    getLlmRuntimeStatus,
    patchProjectContext,
} from "@/lib/api";
import { matchesInvalidation, onInvalidate } from "@/lib/invalidation";
import { countStatuses } from "@/lib/status";
import { useVisiblePolling } from "@/lib/usePolling";
import type { Chat, Project, ProjectContext, ProjectContextRevision, ProjectContextState, ProjectTree, SpecStatus } from "@/lib/types";

function parseSafetyNotes(raw: string): string[] {
    return raw
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(0, 20)
        .map((line) => line.slice(0, 200));
}

function DiscoveryStartForm({
    projectId,
    baseUrl,
    initialError,
    seedContext,
}: {
    projectId: string;
    baseUrl: string;
    initialError?: string;
    seedContext?: ProjectContext;
}) {
    const router = useRouter();
    const [goal, setGoal] = useState(seedContext ? "Update the confirmed project context" : "");
    const [startUrl, setStartUrl] = useState("");
    const [safetyNotes, setSafetyNotes] = useState("");
    const [advancedOpen, setAdvancedOpen] = useState(false);
    const [error, setError] = useState(initialError ?? "");
    const [submitting, setSubmitting] = useState(false);

    async function startDiscovery(event: React.FormEvent<HTMLFormElement>) {
        event.preventDefault();
        setError("");
        setSubmitting(true);
        try {
            const trimmedStart = startUrl.trim();
            const trimmedGoal = goal.trim();
            const discovery = await createContextDiscovery(projectId, {
                ...(trimmedGoal ? { goal: trimmedGoal } : {}),
                ...(trimmedStart ? { startUrl: trimmedStart } : {}),
                safetyNotes: parseSafetyNotes(safetyNotes),
            });
            if (seedContext) {
                try {
                    await patchProjectContext(discovery.revision.id, { context: seedContext });
                } catch (error) {
                    await discardProjectContext(discovery.revision.id).catch(() => undefined);
                    throw error;
                }
            }
            router.push(`/p/${projectId}/chats/${discovery.chat.id}`);
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
            setSubmitting(false);
        }
    }

    return (
        <form onSubmit={startDiscovery} className="space-y-4">
            <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
                <CollapsibleTrigger asChild>
                    <Button type="button" variant="ghost" size="sm" className="-ml-2 text-ink-muted">
                        <ChevronRight size={14} aria-hidden className={`transition-transform duration-150 motion-reduce:transition-none ${advancedOpen ? "rotate-90" : ""}`} />
                        Discovery settings
                        <span className="font-normal text-ink-subtle">Optional</span>
                    </Button>
                </CollapsibleTrigger>
                <CollapsibleContent>
                    <div className="mt-2 space-y-4 rounded-lg border border-line bg-surface p-4">
                        <div>
                            <Label className="mb-1.5" htmlFor="discovery-goal">Focus</Label>
                            <Input id="discovery-goal" value={goal} onChange={(event) => setGoal(event.target.value)} autoComplete="off" placeholder="e.g. Focus on the checkout flow" />
                            <p className="mt-1.5 text-meta text-ink-subtle">Leave empty to let the agent explore everything it can reach.</p>
                        </div>
                        <div>
                            <Label className="mb-1.5" htmlFor="start-url">Start URL</Label>
                            <Input id="start-url" value={startUrl} onChange={(event) => setStartUrl(event.target.value)} type="url" inputMode="url" placeholder={baseUrl} className="font-mono text-meta" />
                            <p className="mt-1.5 text-meta text-ink-subtle">Must stay on the base URL origin.</p>
                        </div>
                        <div>
                            <Label className="mb-1.5" htmlFor="safety-notes">Safety notes</Label>
                            <Textarea id="safety-notes" value={safetyNotes} onChange={(event) => setSafetyNotes(event.target.value)} rows={3} placeholder={"Do not submit contact forms"} />
                            <p className="mt-1.5 text-meta text-ink-subtle">One rule per line. The agent follows them during discovery.</p>
                        </div>
                    </div>
                </CollapsibleContent>
            </Collapsible>
            {error && <Alert variant="danger" role="alert"><AlertDescription>{error}</AlertDescription></Alert>}
            <Button type="submit" disabled={submitting}>
                <Compass size={14} /> {submitting ? "Starting discovery..." : seedContext ? "Start update discovery" : "Start discovery"}
            </Button>
        </form>
    );
}

const ATTENTION_STATUSES: SpecStatus[] = ["failed", "invalid"];
const ATTENTION_LIMIT = 6;
const CHAT_LIMIT = 5;

function ListSkeleton({ rows }: { rows: number }) {
    return (
        <div className="rounded-xl border border-line">
            {Array.from({ length: rows }, (_, index) => (
                <div key={index} className="flex items-center gap-3 border-b border-line px-4 py-3 last:border-0">
                    <Skeleton className="h-4 flex-1" />
                    <Skeleton className="h-5 w-16 rounded-full" />
                </div>
            ))}
        </div>
    );
}

function SpecsOverview({ projectId, tree, error }: { projectId: string; tree: ProjectTree | null; error: string }) {
    const specsHref = `/p/${projectId}/specs`;
    if (!tree) {
        return (
            <section aria-labelledby="overview-specs-heading">
                <SectionHeader id="overview-specs-heading" title="Specs" className="mb-3" />
                {error ? (
                    <Alert variant="danger" role="alert"><AlertDescription>{error}</AlertDescription></Alert>
                ) : (
                    <div aria-busy="true" className="space-y-4">
                        <Skeleton className="h-4 w-80 max-w-full" />
                        <Skeleton className="h-1.5 w-full rounded-full" />
                        <ListSkeleton rows={3} />
                    </div>
                )}
            </section>
        );
    }

    const counts = countStatuses(tree.specs);
    const featureTitles = new Map(tree.features.map((feature) => [feature.id, feature.title]));
    const attention = tree.specs
        .filter((spec) => ATTENTION_STATUSES.includes(spec.status))
        .sort((a, b) => ATTENTION_STATUSES.indexOf(a.status) - ATTENTION_STATUSES.indexOf(b.status));
    const notRun = counts.unverified ?? 0;

    return (
        <section aria-labelledby="overview-specs-heading">
            <SectionHeader
                id="overview-specs-heading"
                title="Specs"
                actions={tree.specs.length > 0 && (
                    <Button asChild variant="ghost" size="sm" className="-mr-2">
                        <Link href={specsHref}>View all <ArrowRight size={14} /></Link>
                    </Button>
                )}
                className="mb-3"
            />
            {tree.syncError && (
                <Alert variant="warning" role="alert" className="mb-4">
                    <AlertTitle>The repository could not be read</AlertTitle>
                    <AlertDescription className="break-words">{tree.syncError}</AlertDescription>
                </Alert>
            )}
            {tree.specs.length === 0 ? (
                <div className="rounded-xl border border-line">
                    <EmptyState
                        size="compact"
                        icon={BookOpenCheck}
                        title="No Specs yet"
                        description="Describe a behavior in a chat and the agent drafts an executable Spec for it."
                        action={<Button asChild variant="outline" size="sm"><Link href={`/p/${projectId}/chats/new`}><MessageSquareText size={14} /> Start chat</Link></Button>}
                        className="py-8"
                    />
                </div>
            ) : (
                <>
                    <SummaryStrip counts={counts} />
                    <div className="mt-5">
                        {attention.length > 0 ? (
                            <>
                                <h3 className="mb-2 text-control font-medium text-ink-muted">
                                    Needs attention <span className="tabular font-normal text-ink-subtle">{attention.length}</span>
                                </h3>
                                <ul className="overflow-hidden rounded-xl border border-line">
                                    {attention.slice(0, ATTENTION_LIMIT).map((spec) => (
                                        <li key={spec.id} className="border-b border-line last:border-0">
                                            <Link
                                                href={`/p/${projectId}/specs/${spec.id}`}
                                                className="flex min-h-12 items-center gap-3 px-4 py-2.5 transition-colors outline-none hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                                            >
                                                <span className="min-w-0 flex-1">
                                                    <span className="block truncate text-control font-medium text-ink">{spec.title}</span>
                                                    {featureTitles.get(spec.featureId) && <span className="block truncate text-meta text-ink-subtle">{featureTitles.get(spec.featureId)}</span>}
                                                </span>
                                                <StatusPill status={spec.status} size="sm" />
                                            </Link>
                                        </li>
                                    ))}
                                </ul>
                                {attention.length > ATTENTION_LIMIT && (
                                    <p className="mt-2 text-meta text-ink-subtle">
                                        And {attention.length - ATTENTION_LIMIT} more. <Link href={specsHref} className="text-ink underline-offset-2 hover:underline">Open Specs</Link>
                                    </p>
                                )}
                            </>
                        ) : (
                            <p className="flex items-center gap-2 rounded-lg bg-success-soft px-3.5 py-2.5 text-control text-success" role="status">
                                <Check size={14} strokeWidth={2.25} aria-hidden="true" />
                                {notRun > 0 ? `Nothing is failing. ${notRun} ${notRun === 1 ? "Spec has" : "Specs have"} not been run yet.` : "Every Spec passed its last verification."}
                            </p>
                        )}
                    </div>
                </>
            )}
        </section>
    );
}

function RecentChats({ projectId, chats, error }: { projectId: string; chats: Chat[] | null; error: string }) {
    const recent = chats ? [...chats].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, CHAT_LIMIT) : [];
    return (
        <section aria-labelledby="overview-chats-heading">
            <SectionHeader
                id="overview-chats-heading"
                title="Recent chats"
                actions={chats && chats.length > 0 && (
                    <Button asChild variant="ghost" size="sm" className="-mr-2">
                        <Link href={`/p/${projectId}/chats`}>View all <ArrowRight size={14} /></Link>
                    </Button>
                )}
                className="mb-3"
            />
            {!chats ? (
                error ? <Alert variant="danger" role="alert"><AlertDescription>{error}</AlertDescription></Alert> : <div aria-busy="true"><ListSkeleton rows={3} /></div>
            ) : recent.length === 0 ? (
                <div className="rounded-xl border border-line">
                    <EmptyState size="compact" icon={MessageSquareText} title="No chats yet" description="Start one to explore the app or describe a behavior." className="py-8" />
                </div>
            ) : (
                <ul className="overflow-hidden rounded-xl border border-line">
                    {recent.map((chat) => (
                        <li key={chat.id} className="border-b border-line last:border-0">
                            <Link
                                href={`/p/${projectId}/chats/${chat.id}`}
                                className="flex min-h-12 items-start gap-3 px-4 py-2.5 transition-colors outline-none hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                            >
                                <MessageSquareText size={14} aria-hidden="true" className="mt-1 shrink-0 text-ink-subtle" />
                                <span className="min-w-0 flex-1">
                                    <span className="line-clamp-2 text-control text-ink">{chat.title || "Untitled chat"}</span>
                                    <RelativeTime value={chat.createdAt} className="text-meta text-ink-subtle" />
                                </span>
                            </Link>
                        </li>
                    ))}
                </ul>
            )}
        </section>
    );
}

function ConfirmedContextSummary({ context }: { context: ProjectContext }) {
    const [open, setOpen] = useState(false);
    const facts = [
        context.areas.length > 0 && `${context.areas.length} ${context.areas.length === 1 ? "area" : "areas"}`,
        context.terminology.length > 0 && `${context.terminology.length} ${context.terminology.length === 1 ? "term" : "terms"}`,
        context.roles.length > 0 && `${context.roles.length} ${context.roles.length === 1 ? "role" : "roles"}`,
        context.businessRules.length > 0 && `${context.businessRules.length} business ${context.businessRules.length === 1 ? "rule" : "rules"}`,
        context.unknowns.length > 0 && `${context.unknowns.length} ${context.unknowns.length === 1 ? "unknown" : "unknowns"}`,
    ].filter(Boolean) as string[];
    return (
        <Collapsible open={open} onOpenChange={setOpen}>
            {!open && (
                <div className="px-4 py-4 sm:px-5">
                    <p className="line-clamp-3 max-w-[70ch] text-body text-ink-muted">{context.summary}</p>
                    {facts.length > 0 && <p className="mt-2 text-meta text-ink-subtle">{facts.join(" · ")}</p>}
                </div>
            )}
            <CollapsibleContent>
                <div className="px-4 py-4 sm:px-5">
                    <ContextReadout context={context} />
                </div>
            </CollapsibleContent>
            <div className="border-t border-line px-2 py-1.5 sm:px-3">
                <CollapsibleTrigger asChild>
                    <Button type="button" variant="ghost" size="sm" className="text-ink-muted">
                        <ChevronDown size={14} aria-hidden className={`transition-transform duration-150 motion-reduce:transition-none ${open ? "rotate-180" : ""}`} />
                        {open ? "Show less" : "Show full context"}
                    </Button>
                </CollapsibleTrigger>
            </div>
        </Collapsible>
    );
}

function ContextPanel({
    projectId,
    project,
    contextState,
    discoveryFailed,
    onReload,
    onDraftSaved,
}: {
    projectId: string;
    project: Project;
    contextState: ProjectContextState;
    discoveryFailed: boolean;
    onReload: () => void;
    onDraftSaved: (draft: ProjectContextRevision) => void;
}) {
    const [discardingDiscovery, setDiscardingDiscovery] = useState(false);
    const [discardDiscoveryOpen, setDiscardDiscoveryOpen] = useState(false);
    const [discardDiscoveryError, setDiscardDiscoveryError] = useState("");
    const [updateMode, setUpdateMode] = useState(false);
    const discardDiscoveryTriggerRef = useRef<HTMLButtonElement>(null);

    async function discardUnfinishedDiscovery(revisionId: string) {
        setDiscardDiscoveryError("");
        setDiscardingDiscovery(true);
        try {
            await discardProjectContext(revisionId);
            setDiscardDiscoveryOpen(false);
            onReload();
        } catch (error) {
            setDiscardDiscoveryError(error instanceof Error ? error.message : String(error));
        } finally {
            setDiscardingDiscovery(false);
        }
    }

    const [llmReady, setLlmReady] = useState(true);
    useEffect(() => {
        let active = true;
        getLlmRuntimeStatus()
            .then((status) => {
                if (active) setLlmReady(status.ready);
            })
            .catch(() => undefined);
        return () => {
            active = false;
        };
    }, []);

    const { confirmed, draft } = contextState;
    const draftHasProposal = draft ? draft.context.summary.trim().length > 0 : false;
    const draftChatHref = draft?.sourceChatId ? `/p/${projectId}/chats/${draft.sourceChatId}` : null;

    if (!draft && !confirmed) {
        return (
            <section aria-labelledby="overview-context-heading" className="rounded-xl border border-line bg-surface-soft">
                <div className="flex flex-col gap-4 p-5 sm:flex-row sm:p-6">
                    <span className="hidden size-10 shrink-0 items-center justify-center rounded-full bg-surface text-ink shadow-xs ring-1 ring-line sm:flex">
                        <Compass size={18} aria-hidden="true" />
                    </span>
                    <div className="min-w-0 flex-1">
                        <h2 id="overview-context-heading" className="text-section text-ink">Teach Specbook this application</h2>
                        <p className="mt-1 max-w-[62ch] text-body text-ink-muted">
                            The agent explores the app in a bounded browser and drafts a structured project context. You review and confirm it, and every future chat receives it.
                        </p>
                        <ol className="mt-4 grid gap-2 text-control text-ink-muted sm:grid-cols-3">
                            {["Agent explores the app", "You review the draft", "Chats use the context"].map((step, index) => (
                                <li key={step} className="flex items-center gap-2">
                                    <span aria-hidden="true" className="tabular flex size-5 shrink-0 items-center justify-center rounded-full bg-surface-selected text-label text-ink">{index + 1}</span>
                                    {step}
                                </li>
                            ))}
                        </ol>
                        {!llmReady && (
                            <Alert variant="warning" role="status" className="mt-4">
                                <AlertTitle>No agent model is configured</AlertTitle>
                                <AlertDescription>Discovery needs one. <Link href={`/p/${projectId}/settings?tab=model`}>Set up a model in Settings</Link>.</AlertDescription>
                            </Alert>
                        )}
                        <div className="mt-5">
                            <DiscoveryStartForm
                                projectId={projectId}
                                baseUrl={project.baseUrl}
                                initialError={discoveryFailed ? "Discovery setup failed after the project was created. Retry it here." : undefined}
                            />
                        </div>
                    </div>
                </div>
            </section>
        );
    }

    return (
        <div className="space-y-6">
            {discoveryFailed && !draft && (
                <Alert variant="danger" role="alert"><AlertDescription>Discovery setup failed after the project was created.</AlertDescription></Alert>
            )}

            {draft && !draftHasProposal && (
                <section aria-labelledby="overview-context-heading">
                    <SectionHeader id="overview-context-heading" title="Project context" className="mb-3" />
                    <div className="rounded-xl border border-line p-4 sm:p-5">
                        <div className="flex items-center gap-2 text-control font-medium text-ink">
                            <LoaderCircle size={14} className="animate-spin text-ink-muted motion-reduce:animate-none" aria-hidden="true" />
                            Discovery in progress
                        </div>
                        {draft.brief.goal && <p className="mt-2 line-clamp-2 text-body text-ink-muted" title={draft.brief.goal}>{draft.brief.goal}</p>}
                        {draft.brief.safetyNotes.length > 0 && (
                            <div className="mt-3">
                                <p className="text-meta text-ink-subtle">{draft.brief.safetyNotes.length} safety {draft.brief.safetyNotes.length === 1 ? "note" : "notes"}</p>
                                <ul className="mt-1 list-disc space-y-0.5 pl-4 text-meta text-ink-muted">
                                    {draft.brief.safetyNotes.map((note, index) => <li key={index}>{note}</li>)}
                                </ul>
                            </div>
                        )}
                        <div className="mt-4 flex flex-wrap gap-2">
                            {draftChatHref && (
                                <Button asChild size="sm">
                                    <Link href={draftChatHref}><Compass size={14} /> Continue discovery</Link>
                                </Button>
                            )}
                            <Button
                                ref={discardDiscoveryTriggerRef}
                                type="button"
                                variant="ghost"
                                size="sm"
                                onClick={() => setDiscardDiscoveryOpen(true)}
                                disabled={discardingDiscovery}
                            >
                                <Trash2 size={14} /> Discard discovery
                            </Button>
                            <ConfirmDeleteDialog
                                open={discardDiscoveryOpen}
                                title="Discard this discovery?"
                                description="The discovery draft is discarded. The chat stays in your history, and any confirmed context stays active."
                                confirmLabel="Discard discovery"
                                busyLabel="Discarding..."
                                busy={discardingDiscovery}
                                error={discardDiscoveryError}
                                returnFocusRef={discardDiscoveryTriggerRef}
                                onCancel={() => {
                                    setDiscardDiscoveryOpen(false);
                                    setDiscardDiscoveryError("");
                                }}
                                onConfirm={() => void discardUnfinishedDiscovery(draft.id)}
                            />
                        </div>
                    </div>
                </section>
            )}

            {draft && draftHasProposal && (
                <section aria-labelledby="overview-context-heading">
                    <SectionHeader id="overview-context-heading" title="Review project context" description="Drafted from discovery. Edit anything before confirming." className="mb-3" />
                    <div className="rounded-xl border border-line p-4 sm:p-5">
                        <DraftReview
                            revision={draft}
                            chatHref={draftChatHref}
                            onSaved={onDraftSaved}
                            onConfirmed={() => {
                                setUpdateMode(false);
                                onReload();
                            }}
                            onDiscarded={() => onReload()}
                        />
                    </div>
                </section>
            )}

            {confirmed && (
                <section aria-labelledby="overview-confirmed-heading">
                    <SectionHeader
                        id="overview-confirmed-heading"
                        title={draft ? "Currently confirmed context" : "Project context"}
                        description={draft
                            ? "Stays active until the draft above replaces it."
                            : <>{confirmed.confirmedAt ? <RelativeTime value={confirmed.confirmedAt} prefix="Confirmed" /> : "Confirmed"} · supplied to every new chat</>}
                        actions={!draft && (
                            <Button type="button" variant="outline" size="sm" onClick={() => setUpdateMode((value) => !value)} aria-expanded={updateMode}>
                                {updateMode ? <><X size={14} /> Cancel update</> : <><PencilLine size={14} /> Update context</>}
                            </Button>
                        )}
                        className="mb-3"
                    />
                    <div className="overflow-hidden rounded-xl border border-line">
                        {updateMode && !draft && (
                            <div className="border-b border-line bg-surface-soft p-4 sm:p-5">
                                <p className="mb-3 max-w-[64ch] text-control text-ink-muted">
                                    A new discovery drafts an updated context seeded with the confirmed one. The current context stays active until you confirm the replacement.
                                </p>
                                <DiscoveryStartForm projectId={projectId} baseUrl={project.baseUrl} seedContext={confirmed.context} />
                            </div>
                        )}
                        <ConfirmedContextSummary context={confirmed.context} />
                    </div>
                </section>
            )}
        </div>
    );
}

function OverviewSkeleton() {
    return (
        <div className="flex min-h-full flex-col bg-surface" aria-busy="true" role="status">
            <span className="sr-only">Loading project</span>
            <div className="border-b border-line px-4 pt-5 pb-4 md:px-8 md:pt-6 md:pb-5">
                <div className="mx-auto flex max-w-data items-start justify-between gap-6">
                    <div className="space-y-2.5 pt-1"><Skeleton className="h-6 w-48" /><Skeleton className="h-3.5 w-56" /></div>
                    <Skeleton className="h-9 w-28" />
                </div>
            </div>
            <PageContainer width="data">
                <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_20rem]">
                    <div className="space-y-10">
                        <div className="space-y-4"><Skeleton className="h-5 w-20" /><Skeleton className="h-4 w-80 max-w-full" /><Skeleton className="h-1.5 w-full rounded-full" /><ListSkeleton rows={3} /></div>
                        <Skeleton className="h-48 rounded-xl" />
                    </div>
                    <div className="space-y-4"><Skeleton className="h-5 w-32" /><ListSkeleton rows={4} /></div>
                </div>
            </PageContainer>
        </div>
    );
}

export default function ProjectHome({ params }: { params: Promise<{ projectId: string }> }) {
    const { projectId } = use(params);
    const searchParams = useSearchParams();
    const discoveryFailed = searchParams.get("discovery") === "failed";
    const [project, setProject] = useState<Project | null>(null);
    const [contextState, setContextState] = useState<ProjectContextState | null>(null);
    const [tree, setTree] = useState<ProjectTree | null>(null);
    const [treeError, setTreeError] = useState("");
    const [chats, setChats] = useState<Chat[] | null>(null);
    const [chatsError, setChatsError] = useState("");
    const [loadError, setLoadError] = useState("");
    const [notFound, setNotFound] = useState(false);
    const [retryKey, setRetryKey] = useState(0);

    const reload = useCallback(() => setRetryKey((key) => key + 1), []);

    useEffect(() => {
        let active = true;
        setLoadError("");
        setNotFound(false);
        Promise.all([
            getProject(projectId),
            getProjectContext(projectId),
        ])
            .then(([projectResult, contextResult]) => {
                if (!active) return;
                setProject(projectResult.project);
                setContextState(contextResult);
            })
            .catch((error) => {
                if (!active) return;
                if (error instanceof ApiError && error.status === 404) setNotFound(true);
                else setLoadError(errorMessage(error));
            });
        return () => {
            active = false;
        };
    }, [projectId, retryKey]);

    const loadTree = useCallback(() => {
        getProjectTree(projectId)
            .then((result) => {
                setTree(result);
                setTreeError("");
            })
            .catch((error) => setTreeError(errorMessage(error)));
    }, [projectId]);

    const loadChats = useCallback(() => {
        listProjectChats(projectId)
            .then((result) => {
                setChats(result.chats);
                setChatsError("");
            })
            .catch((error) => setChatsError(errorMessage(error)));
    }, [projectId]);

    useEffect(() => {
        setTree(null);
        setChats(null);
        loadTree();
        loadChats();
        return onInvalidate((event) => {
            if (matchesInvalidation(event, "tree", projectId)) loadTree();
            if (matchesInvalidation(event, "chats", projectId)) loadChats();
            if (matchesInvalidation(event, "projects", projectId)) {
                getProject(projectId).then((result) => setProject(result.project)).catch(() => undefined);
            }
        });
    }, [projectId, loadTree, loadChats]);

    useVisiblePolling(loadTree, 15_000);

    if (notFound) {
        return (
            <div className="flex min-h-full flex-col bg-surface">
                <div className="flex flex-1 items-center justify-center px-5 py-10">
                    <EmptyState
                        icon={SearchX}
                        title="Project not found"
                        description="This project may have been deleted."
                        action={<Button asChild><Link href="/?new=1">Create a project</Link></Button>}
                    />
                </div>
            </div>
        );
    }

    if (loadError) {
        return (
            <div className="flex min-h-full flex-col bg-surface">
                <div className="flex flex-1 items-center justify-center px-5 py-10">
                    <EmptyState
                        icon={AlertCircle}
                        tone="danger"
                        role="alert"
                        title="The project could not load"
                        description={loadError}
                        action={<Button type="button" onClick={reload}><RefreshCw size={14} /> Try again</Button>}
                    />
                </div>
            </div>
        );
    }

    if (!project || !contextState) return <OverviewSkeleton />;

    const hasContext = Boolean(contextState.confirmed || contextState.draft);

    return (
        <div className="flex min-h-full flex-col bg-surface">
            <PageHeader
                title={project.name}
                width="data"
                meta={
                    <a href={project.baseUrl} target="_blank" rel="noopener noreferrer" className="inline-flex max-w-full items-center gap-1 rounded-sm font-mono text-meta text-ink-muted transition-colors hover:text-ink">
                        <span className="truncate">{project.baseUrl}</span>
                        <ExternalLink size={12} aria-hidden="true" className="shrink-0" />
                        <span className="sr-only">(opens in a new tab)</span>
                    </a>
                }
                actions={
                    <>
                        <Button asChild variant={hasContext ? "default" : "outline"}>
                            <Link href={`/p/${projectId}/chats/new`}><MessageSquareText size={14} /> Start chat</Link>
                        </Button>
                    </>
                }
            />
            <PageContainer width="data" className="flex-1">
                <div className="grid items-start gap-10 lg:grid-cols-[minmax(0,1fr)_20rem] lg:gap-12">
                    <div className="min-w-0 space-y-10">
                        {!hasContext && (
                            <ContextPanel
                                projectId={projectId}
                                project={project}
                                contextState={contextState}
                                discoveryFailed={discoveryFailed}
                                onReload={reload}
                                onDraftSaved={(updated) => setContextState((current) => (current ? { ...current, draft: updated } : current))}
                            />
                        )}
                        <SpecsOverview projectId={projectId} tree={tree} error={treeError} />
                        {hasContext && (
                            <ContextPanel
                                projectId={projectId}
                                project={project}
                                contextState={contextState}
                                discoveryFailed={discoveryFailed}
                                onReload={reload}
                                onDraftSaved={(updated) => setContextState((current) => (current ? { ...current, draft: updated } : current))}
                            />
                        )}
                    </div>
                    <RecentChats projectId={projectId} chats={chats} error={chatsError} />
                </div>
            </PageContainer>
        </div>
    );
}
