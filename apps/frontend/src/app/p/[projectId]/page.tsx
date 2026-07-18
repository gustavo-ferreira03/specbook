"use client";

import Link from "next/link";
import { use, useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
    ArrowRight,
    BookOpenCheck,
    ChevronDown,
    Compass,
    MessageSquareText,
    PencilLine,
    RefreshCw,
    Trash2,
} from "lucide-react";
import { ConfirmDeleteDialog } from "@/components/ConfirmDeleteDialog";
import { ContextReadout } from "@/components/ContextReadout";
import { DraftReview } from "@/components/DraftReview";
import { LogoMark } from "@/components/LogoMark";
import { PageHeader } from "@/components/PageHeader";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import {
    api,
    createContextDiscovery,
    discardProjectContext,
    getProjectContext,
    patchProjectContext,
} from "@/lib/api";
import type { Project, ProjectContext, ProjectContextRevision, ProjectContextState } from "@/lib/types";

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
    const [maxActions, setMaxActions] = useState("40");
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
                maxActions: Number(maxActions),
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
        <form onSubmit={startDiscovery} className="rounded-[13px] border border-line bg-canvas p-4">
            <p className="text-[0.65625rem] leading-4 text-ink-faint">The agent explores the app on its own with a bounded browser and asks for help only when it gets stuck.</p>
            <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen} className="mt-3">
                <CollapsibleTrigger asChild>
                    <Button type="button" variant="outline" className="w-full justify-between text-ink-soft hover:text-ink">
                        Advanced discovery settings
                        <ChevronDown size={14} aria-hidden className={`transition-transform duration-150 motion-reduce:transition-none ${advancedOpen ? "rotate-180" : ""}`} />
                    </Button>
                </CollapsibleTrigger>
                <CollapsibleContent>
                    <div className="mt-3 space-y-4 rounded-md border border-line bg-surface p-3">
                        <div>
                            <Label className="mb-1.5" htmlFor="discovery-goal">Discovery focus (optional)</Label>
                            <Input id="discovery-goal" value={goal} onChange={(event) => setGoal(event.target.value)} autoComplete="off" placeholder="e.g. Focus on the checkout flow" />
                            <p className="mt-1.5 text-[0.65625rem] leading-4 text-ink-faint">Leave empty to let the agent explore everything it can reach.</p>
                        </div>
                        <div>
                            <Label className="mb-1.5" htmlFor="start-url">Start URL</Label>
                            <Input id="start-url" value={startUrl} onChange={(event) => setStartUrl(event.target.value)} type="url" inputMode="url" placeholder={baseUrl} />
                            <p className="mt-1.5 text-[0.65625rem] leading-4 text-ink-faint">Must stay on the base URL origin.</p>
                        </div>
                        <div>
                            <Label className="mb-1.5" htmlFor="max-actions">Maximum browser actions</Label>
                            <Select value={maxActions} onValueChange={setMaxActions}>
                                <SelectTrigger id="max-actions" className="w-full"><SelectValue /></SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="20">20 actions · quick pass</SelectItem>
                                    <SelectItem value="40">40 actions · balanced</SelectItem>
                                    <SelectItem value="60">60 actions · deeper exploration</SelectItem>
                                </SelectContent>
                            </Select>
                        </div>
                        <div>
                            <Label className="mb-1.5" htmlFor="safety-notes">Additional safety notes</Label>
                            <Textarea id="safety-notes" value={safetyNotes} onChange={(event) => setSafetyNotes(event.target.value)} rows={3} placeholder={"Do not submit contact forms"} />
                            <p className="mt-1.5 text-[0.65625rem] leading-4 text-ink-faint">One rule per line.</p>
                        </div>
                    </div>
                </CollapsibleContent>
            </Collapsible>
            {error && <Alert variant="destructive" className="mt-3 text-xs" role="alert"><AlertDescription>{error}</AlertDescription></Alert>}
            <Button type="submit" disabled={submitting} className="mt-4">
                <Compass size={14} /> {submitting ? "Starting discovery..." : seedContext ? "Start update discovery" : "Start discovery"}
            </Button>
        </form>
    );
}

export default function ProjectHome({ params }: { params: Promise<{ projectId: string }> }) {
    const { projectId } = use(params);
    const searchParams = useSearchParams();
    const discoveryFailed = searchParams.get("discovery") === "failed";
    const [project, setProject] = useState<Project | null>(null);
    const [contextState, setContextState] = useState<ProjectContextState | null>(null);
    const [loadError, setLoadError] = useState("");
    const [notFound, setNotFound] = useState(false);
    const [retryKey, setRetryKey] = useState(0);
    const [discardingDiscovery, setDiscardingDiscovery] = useState(false);
    const [discardDiscoveryOpen, setDiscardDiscoveryOpen] = useState(false);
    const [discardDiscoveryError, setDiscardDiscoveryError] = useState("");
    const [updateMode, setUpdateMode] = useState(false);
    const discardDiscoveryTriggerRef = useRef<HTMLButtonElement>(null);

    const reload = useCallback(() => setRetryKey((key) => key + 1), []);

    useEffect(() => {
        let active = true;
        setLoadError("");
        setNotFound(false);
        Promise.all([
            api<{ project: Project }>(`/projects/${projectId}`),
            getProjectContext(projectId),
        ])
            .then(([projectResult, contextResult]) => {
                if (!active) return;
                setProject(projectResult.project);
                setContextState(contextResult);
            })
            .catch((error) => {
                if (!active) return;
                const message = error instanceof Error ? error.message : String(error);
                if (message.toLowerCase().includes("not found")) setNotFound(true);
                else setLoadError(message);
            });
        return () => {
            active = false;
        };
    }, [projectId, retryKey]);

    async function discardUnfinishedDiscovery(revisionId: string) {
        setDiscardDiscoveryError("");
        setDiscardingDiscovery(true);
        try {
            await discardProjectContext(revisionId);
            setDiscardDiscoveryOpen(false);
            reload();
        } catch (error) {
            setDiscardDiscoveryError(error instanceof Error ? error.message : String(error));
        } finally {
            setDiscardingDiscovery(false);
        }
    }

    if (notFound) {
        return (
            <div className="flex min-h-full flex-col bg-surface">
                <PageHeader title="Project overview" eyebrow="Project" />
                <div className="flex flex-1 items-center justify-center px-5 py-10">
                    <div className="text-center">
                        <LogoMark className="mx-auto size-9" />
                        <h2 className="mt-4 text-sm font-bold">Project not found</h2>
                        <p className="mt-2 text-xs text-ink-soft">This project may have been deleted.</p>
                        <Button asChild className="mt-5"><Link href="/?new=1">Create a project</Link></Button>
                    </div>
                </div>
            </div>
        );
    }

    if (loadError) {
        return (
            <div className="flex min-h-full flex-col bg-surface">
                <PageHeader title="Project overview" eyebrow="Project" />
                <div className="flex flex-1 items-center justify-center px-5 py-10">
                    <Alert variant="destructive" className="w-full max-w-sm bg-transparent text-center" role="alert">
                        <AlertDescription className="text-xs leading-5">{loadError}</AlertDescription>
                        <Button type="button" onClick={reload} className="mx-auto mt-4"><RefreshCw size={14} /> Try again</Button>
                    </Alert>
                </div>
            </div>
        );
    }

    if (!project || !contextState) {
        return (
            <div className="flex min-h-full flex-col bg-surface" aria-busy="true" role="status">
                <span className="sr-only">Loading project</span>
                <PageHeader title="Project overview" eyebrow="Project" />
                <div className="mx-auto w-full max-w-[720px] space-y-4 px-5 py-10">
                    <Skeleton className="h-6 w-48" />
                    <Skeleton className="h-3 w-72" />
                    <Skeleton className="h-56 rounded-[13px]" />
                </div>
            </div>
        );
    }

    const { confirmed, draft } = contextState;
    const draftHasProposal = draft ? draft.context.summary.trim().length > 0 : false;
    const draftChatHref = draft?.sourceChatId
        ? `/p/${projectId}/chats/${draft.sourceChatId}`
        : null;

    return (
        <div className="flex min-h-full flex-col bg-surface">
            <PageHeader title="Project overview" eyebrow="Project" />
            <div className="mx-auto w-full max-w-[720px] flex-1 px-5 py-8">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <div>
                        <h2 className="text-lg font-bold tracking-[-0.02em]">{project.name}</h2>
                        <p className="mt-0.5 font-mono text-[0.65625rem] text-ink-faint [overflow-wrap:anywhere]">{project.baseUrl}</p>
                    </div>
                    <Button asChild variant="outline" size="sm">
                        <Link href={`/p/${projectId}/chats/new`}>
                            <MessageSquareText size={13} /> Start chat
                        </Link>
                    </Button>
                </div>

                <Separator className="my-6" />

                {discoveryFailed && !draft && (
                    <Alert variant="destructive" className="mb-5 text-xs" role="alert">
                        <AlertDescription>Discovery setup failed after the project was created. Retry it below.</AlertDescription>
                    </Alert>
                )}

                {draft && !draftHasProposal && (
                    <section aria-label="Discovery in progress" className="rounded-[13px] border border-line bg-canvas p-4">
                        <div className="flex items-center gap-2 text-xs font-bold"><Compass size={14} className="text-ink-faint" /> Discovery in progress</div>
                        <p className="mt-2 line-clamp-2 text-xs leading-5 text-ink-soft" title={draft.brief.goal}>{draft.brief.goal}</p>
                        <p className="mt-1 text-[0.65625rem] text-ink-faint">
                            {draft.actionsUsed} of {draft.brief.maxActions} browser actions used
                            {draft.brief.safetyNotes.length > 0 && ` · ${draft.brief.safetyNotes.length} safety ${draft.brief.safetyNotes.length === 1 ? "note" : "notes"}`}
                        </p>
                        {draft.brief.safetyNotes.length > 0 && (
                            <ul className="mt-2 list-disc pl-4 text-[0.65625rem] leading-4 text-ink-soft">
                                {draft.brief.safetyNotes.map((note, index) => (
                                    <li key={index}>{note}</li>
                                ))}
                            </ul>
                        )}
                        <div className="mt-4 flex flex-wrap gap-2">
                            {draftChatHref && (
                                <Button asChild size="sm">
                                    <Link href={draftChatHref}><Compass size={13} /> Continue discovery</Link>
                                </Button>
                            )}
                            <Button
                                ref={discardDiscoveryTriggerRef}
                                type="button"
                                variant="ghost"
                                size="sm"
                                onClick={() => setDiscardDiscoveryOpen(true)}
                                disabled={discardingDiscovery}
                                className="text-ink-soft"
                            >
                                <Trash2 size={13} /> Discard discovery
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
                    </section>
                )}

                {draft && draftHasProposal && (
                    <section aria-label="Project context draft" className="rounded-[13px] border border-line bg-surface">
                        <div className="border-b border-line px-4 py-3">
                            <h3 className="text-[0.8125rem] font-bold">Review project context</h3>
                            <p className="mt-0.5 text-[0.65625rem] leading-4 text-ink-faint">
                                Drafted from discovery ({draft.actionsUsed} of {draft.brief.maxActions} actions). Edit anything before confirming.
                            </p>
                        </div>
                        <div className="p-4">
                            <DraftReview
                                revision={draft}
                                chatHref={draftChatHref}
                                onSaved={(updated) =>
                                    setContextState((current) => (current ? { ...current, draft: updated } : current))
                                }
                                onConfirmed={() => {
                                    setUpdateMode(false);
                                    reload();
                                }}
                                onDiscarded={() => reload()}
                            />
                        </div>
                    </section>
                )}

                {!draft && confirmed && (
                    <section aria-label="Confirmed project context" className="rounded-[13px] border border-line bg-surface">
                        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3">
                            <div>
                                <h3 className="text-[0.8125rem] font-bold">Project context</h3>
                                <p className="mt-0.5 text-[0.65625rem] text-ink-faint">
                                    Confirmed {confirmed.confirmedAt ? new Date(confirmed.confirmedAt).toLocaleString() : ""} · supplied to every new chat
                                </p>
                            </div>
                            <Button type="button" variant="outline" size="sm" onClick={() => setUpdateMode((value) => !value)}>
                                <PencilLine size={13} /> {updateMode ? "Cancel update" : "Update context"}
                            </Button>
                        </div>
                        {updateMode && (
                            <div className="border-b border-line p-4">
                                <p className="mb-3 text-xs leading-5 text-ink-soft">
                                    A new discovery drafts an updated context seeded with the confirmed one. The current context stays active until you confirm the replacement.
                                </p>
                                <DiscoveryStartForm projectId={projectId} baseUrl={project.baseUrl} seedContext={confirmed.context} />
                            </div>
                        )}
                        <div className="p-4">
                            <ContextReadout context={confirmed.context} />
                        </div>
                    </section>
                )}

                {!draft && !confirmed && (
                    <section aria-label="Set up project context">
                        <div className="max-w-[560px]">
                            <LogoMark className="size-10" />
                            <h2 className="mt-5 text-xl font-bold tracking-[-0.025em]">Teach Specbook this application</h2>
                            <p className="mt-3 max-w-[62ch] text-xs leading-5 text-ink-soft">
                                Run a guided discovery: the agent explores the app in a bounded browser, drafts a structured project context, and you review and confirm it. Confirmed context is supplied to every future chat.
                            </p>
                        </div>
                        <div className="mt-5">
                            <DiscoveryStartForm projectId={projectId} baseUrl={project.baseUrl} initialError={discoveryFailed ? "Discovery setup failed after the project was created. Retry it here." : undefined} />
                        </div>
                        <div className="mt-8 max-w-[560px]">
                            <Separator className="mb-4" />
                            <div className="flex items-center gap-3 py-2 text-[0.6875rem] text-ink-soft"><MessageSquareText size={14} className="text-ink-faint" /> Or skip ahead and describe a behavior in a chat</div>
                            <div className="flex items-center gap-3 py-2 text-[0.6875rem] text-ink-soft"><BookOpenCheck size={14} className="text-ink-faint" /> Keep the readable behavior, verification, and evidence together</div>
                            <Button asChild variant="outline" size="sm" className="mt-2">
                                <Link href={`/p/${projectId}/chats/new`}>
                                    Start chat <ArrowRight size={13} />
                                </Link>
                            </Button>
                        </div>
                    </section>
                )}

                {draft && confirmed && (
                    <section aria-label="Currently confirmed context" className="mt-6 rounded-[13px] border border-line bg-surface">
                        <div className="border-b border-line px-4 py-3">
                            <h3 className="text-[0.8125rem] font-bold">Currently confirmed context</h3>
                            <p className="mt-0.5 text-[0.65625rem] text-ink-faint">Stays active until the draft above replaces it.</p>
                        </div>
                        <div className="p-4">
                            <ContextReadout context={confirmed.context} />
                        </div>
                    </section>
                )}
            </div>
        </div>
    );
}
