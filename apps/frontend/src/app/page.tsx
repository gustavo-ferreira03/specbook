"use client";

import Link from "next/link";
import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, ArrowRight, ChevronDown, RefreshCw } from "lucide-react";
import { LogoMark } from "@/components/LogoMark";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { api, createContextDiscovery, getLlmRuntimeStatus } from "@/lib/api";
import type { Project } from "@/lib/types";

function parseSafetyNotes(raw: string): string[] {
    return raw
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(0, 20)
        .map((line) => line.slice(0, 200));
}

function HomeContent() {
    const router = useRouter();
    const searchParams = useSearchParams();
    const forceNew = searchParams.get("new") === "1";
    const [projects, setProjects] = useState<Project[] | null>(null);
    const [name, setName] = useState("");
    const [baseUrl, setBaseUrl] = useState("");
    const [loadError, setLoadError] = useState("");
    const [createError, setCreateError] = useState("");
    const [retryKey, setRetryKey] = useState(0);
    const [submitting, setSubmitting] = useState<"discovery" | "plain" | false>(false);
    const [lastProjectId, setLastProjectId] = useState<string | null>(null);
    const [goal, setGoal] = useState("");
    const [startUrl, setStartUrl] = useState("");
    const [startUrlEdited, setStartUrlEdited] = useState(false);
    const [maxActions, setMaxActions] = useState("40");
    const [safetyNotes, setSafetyNotes] = useState("");
    const [advancedOpen, setAdvancedOpen] = useState(false);
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

    useEffect(() => {
        let active = true;
        setProjects(null);
        setLoadError("");
        api<{ projects: Project[] }>("/projects")
            .then((result) => {
                if (!active) return;
                setLastProjectId(localStorage.getItem("specbook:last-project"));
                if (result.projects.length > 0 && !forceNew) {
                    const lastProject = localStorage.getItem("specbook:last-project");
                    const destination = result.projects.find((project) => project.id === lastProject) ?? result.projects[0];
                    router.replace(`/p/${destination.id}`);
                    return;
                }
                setProjects(result.projects);
            })
            .catch((error) => {
                if (!active) return;
                setLoadError(error instanceof Error ? error.message : String(error));
                setProjects([]);
            });
        return () => {
            active = false;
        };
    }, [forceNew, retryKey, router]);

    async function createProjectRecord(): Promise<Project> {
        const result = await api<{ project: Project }>("/projects", {
            method: "POST",
            body: JSON.stringify({ name: name.trim(), baseUrl: baseUrl.trim() }),
        });
        localStorage.setItem("specbook:last-project", result.project.id);
        return result.project;
    }

    async function createWithDiscovery(event: React.FormEvent<HTMLFormElement>) {
        event.preventDefault();
        setCreateError("");
        setSubmitting("discovery");
        let project: Project;
        try {
            project = await createProjectRecord();
        } catch (error) {
            setCreateError(error instanceof Error ? error.message : String(error));
            setSubmitting(false);
            return;
        }
        try {
            const trimmedStart = startUrl.trim();
            const trimmedGoal = goal.trim();
            const discovery = await createContextDiscovery(project.id, {
                ...(trimmedGoal ? { goal: trimmedGoal } : {}),
                ...(startUrlEdited && trimmedStart ? { startUrl: trimmedStart } : {}),
                maxActions: Number(maxActions),
                safetyNotes: parseSafetyNotes(safetyNotes),
            });
            router.push(`/p/${project.id}/chats/${discovery.chat.id}`);
        } catch {
            router.push(`/p/${project.id}?discovery=failed`);
        }
    }

    async function createWithoutDiscovery() {
        if (!name.trim() || !baseUrl.trim()) {
            setCreateError("Project name and base URL are required.");
            return;
        }
        setCreateError("");
        setSubmitting("plain");
        try {
            const project = await createProjectRecord();
            router.push(`/p/${project.id}`);
        } catch (error) {
            setCreateError(error instanceof Error ? error.message : String(error));
            setSubmitting(false);
        }
    }

    if (projects === null) {
        return (
            <main className="min-h-dvh bg-canvas" aria-label="Loading projects" aria-busy="true" role="status">
                <span className="sr-only">Loading projects</span>
                <div className="h-[72px] border-b border-line bg-surface" />
                <div className="mx-auto grid w-full max-w-[860px] gap-12 px-5 py-16 md:grid-cols-[0.8fr_1fr] md:px-8 md:py-24">
                    <div className="space-y-3"><Skeleton className="h-5 w-36" /><Skeleton className="h-3 w-64" /></div>
                    <Skeleton className="h-72 rounded-[13px] border border-line bg-surface" />
                </div>
            </main>
        );
    }

    if (loadError) {
        return (
            <main className="flex min-h-dvh items-center justify-center bg-canvas px-5">
                <Alert variant="destructive" className="w-full max-w-sm bg-transparent p-0 text-center" role="alert">
                    <LogoMark className="mx-auto size-9" />
                    <h1 className="mt-4 text-sm font-bold text-ink">Specbook could not load</h1>
                    <AlertDescription className="mt-2 text-xs leading-5">{loadError}</AlertDescription>
                    <Button type="button" onClick={() => setRetryKey((key) => key + 1)} className="mt-5"><RefreshCw size={14} /> Try again</Button>
                </Alert>
            </main>
        );
    }

    const returnProject = projects.find((project) => project.id === lastProjectId) ?? projects[0];

    return (
        <main className="min-h-dvh bg-canvas">
            <header className="flex h-[72px] items-center justify-between border-b border-line bg-surface px-4 sm:px-6">
                <div className="flex items-center gap-3">
                    <LogoMark className="size-8" />
                    <span><span className="block text-sm font-bold tracking-[-0.015em]">Specbook</span><span className="mt-0.5 block text-[0.625rem] text-ink-faint">living, executable specs</span></span>
                </div>
                {returnProject && (
                    <Button asChild variant="ghost" className="hover:bg-canvas">
                        <Link href={`/p/${returnProject.id}`}><ArrowLeft size={14} /> Return to project</Link>
                    </Button>
                )}
            </header>

            <div className="mx-auto grid w-full max-w-[860px] items-start gap-10 px-5 py-12 sm:px-8 md:grid-cols-[0.78fr_minmax(22rem,1fr)] md:gap-16 md:py-20">
                <div className="pt-2 md:pt-5">
                    <p className="text-[0.625rem] font-bold tracking-[0.08em] text-ink-faint uppercase">New project</p>
                    <h1 className="mt-2 max-w-sm text-xl font-bold tracking-[-0.025em] text-balance">
                        {returnProject ? "Add another application" : "Connect your first application"}
                    </h1>
                    <p className="mt-3 max-w-[44ch] text-xs leading-5 text-ink-soft">
                        Give Specbook an application URL. Chats, browser sessions, and Specs stay grouped inside the project.
                    </p>
                </div>

                <form onSubmit={createWithDiscovery} className="rounded-[13px] border border-line bg-surface p-5">
                    <h2 className="text-[0.8125rem] font-bold">Project details</h2>
                    <p className="mt-1 text-[0.65625rem] leading-4 text-ink-faint">Use a URL the self-hosted runtime can reach.</p>
                    <div className="mt-5">
                        <Label className="mb-1.5" htmlFor="project-name">Project name</Label>
                        <Input id="project-name" value={name} onChange={(event) => setName(event.target.value)} required autoFocus autoComplete="off" placeholder="Customer portal" />
                    </div>
                    <div className="mt-4">
                        <Label className="mb-1.5" htmlFor="base-url">Base URL</Label>
                        <Input
                            id="base-url"
                            value={baseUrl}
                            onChange={(event) => {
                                setBaseUrl(event.target.value);
                                if (!startUrlEdited) setStartUrl(event.target.value);
                            }}
                            required
                            type="url"
                            inputMode="url"
                            placeholder="https://staging.example.com"
                        />
                    </div>
                    <p className="mt-4 text-[0.65625rem] leading-4 text-ink-faint">The agent explores the app on its own with a bounded browser, drafts a project context, and asks for help only when it gets stuck.</p>
                    <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen} className="mt-4">
                        <CollapsibleTrigger asChild>
                            <Button type="button" variant="outline" className="w-full justify-between text-ink-soft hover:text-ink">
                                Advanced discovery settings
                                <ChevronDown size={14} aria-hidden className={`transition-transform duration-150 motion-reduce:transition-none ${advancedOpen ? "rotate-180" : ""}`} />
                            </Button>
                        </CollapsibleTrigger>
                        <CollapsibleContent>
                            <div className="mt-3 space-y-4 rounded-md border border-line bg-canvas p-3">
                                <div>
                                    <Label className="mb-1.5" htmlFor="discovery-goal">Discovery focus (optional)</Label>
                                    <Input id="discovery-goal" value={goal} onChange={(event) => setGoal(event.target.value)} autoComplete="off" placeholder="e.g. Focus on the checkout flow" />
                                    <p className="mt-1.5 text-[0.65625rem] leading-4 text-ink-faint">Leave empty to let the agent explore everything it can reach.</p>
                                </div>
                                <div>
                                    <Label className="mb-1.5" htmlFor="start-url">Start URL</Label>
                                    <Input
                                        id="start-url"
                                        value={startUrl}
                                        onChange={(event) => {
                                            setStartUrl(event.target.value);
                                            setStartUrlEdited(true);
                                        }}
                                        type="url"
                                        inputMode="url"
                                        placeholder={baseUrl || "Same as base URL"}
                                    />
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
                                    <Textarea id="safety-notes" value={safetyNotes} onChange={(event) => setSafetyNotes(event.target.value)} rows={3} placeholder={"Do not submit contact forms\nStay out of the checkout"} />
                                    <p className="mt-1.5 text-[0.65625rem] leading-4 text-ink-faint">One rule per line. The agent follows them during discovery.</p>
                                </div>
                            </div>
                        </CollapsibleContent>
                    </Collapsible>
                    {!llmReady && (
                        <Alert className="mt-4 text-xs" role="status">
                            <AlertDescription>No agent model is configured yet. You can create the project now; discovery will need the agent set up in Settings before it can run.</AlertDescription>
                        </Alert>
                    )}
                    {createError && <Alert variant="destructive" className="mt-4 text-xs" role="alert"><AlertDescription>{createError}</AlertDescription></Alert>}
                    <Button type="submit" disabled={submitting !== false} className="mt-5 w-full">
                        {submitting === "discovery" ? "Creating project..." : "Create project and explore"}{submitting === false && <ArrowRight size={14} />}
                    </Button>
                    <Button type="button" variant="ghost" onClick={createWithoutDiscovery} disabled={submitting !== false} className="mt-2 w-full text-ink-soft hover:bg-canvas">
                        {submitting === "plain" ? "Creating project..." : "Create without discovery"}
                    </Button>
                </form>
            </div>
        </main>
    );
}

export default function Home() {
    return <Suspense fallback={<span className="sr-only" role="status">Loading Specbook</span>}><HomeContent /></Suspense>;
}
