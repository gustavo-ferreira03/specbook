"use client";

import Link from "next/link";
import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, ArrowRight, RefreshCw } from "lucide-react";
import { LogoMark } from "@/components/LogoMark";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api";
import type { Project } from "@/lib/types";

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
    const [submitting, setSubmitting] = useState(false);
    const [lastProjectId, setLastProjectId] = useState<string | null>(null);

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

    async function createProject(event: React.FormEvent<HTMLFormElement>) {
        event.preventDefault();
        setCreateError("");
        setSubmitting(true);
        try {
            const result = await api<{ project: Project }>("/projects", {
                method: "POST",
                body: JSON.stringify({ name: name.trim(), baseUrl: baseUrl.trim() }),
            });
            localStorage.setItem("specbook:last-project", result.project.id);
            router.push(`/p/${result.project.id}`);
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
                        Give Specbook an application URL. Conversations, browser sessions, and Specs stay grouped inside the project.
                    </p>
                </div>

                <form onSubmit={createProject} className="rounded-[13px] border border-line bg-surface p-5">
                    <h2 className="text-[0.8125rem] font-bold">Project details</h2>
                    <p className="mt-1 text-[0.65625rem] leading-4 text-ink-faint">Use a URL the self-hosted runtime can reach.</p>
                    <div className="mt-5">
                        <Label className="mb-1.5" htmlFor="project-name">Project name</Label>
                        <Input id="project-name" value={name} onChange={(event) => setName(event.target.value)} required autoFocus autoComplete="off" placeholder="Customer portal" />
                    </div>
                    <div className="mt-4">
                        <Label className="mb-1.5" htmlFor="base-url">Base URL</Label>
                        <Input id="base-url" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} required type="url" inputMode="url" placeholder="https://staging.example.com" />
                    </div>
                    {createError && <Alert variant="destructive" className="mt-4 text-xs" role="alert"><AlertDescription>{createError}</AlertDescription></Alert>}
                    <Button type="submit" disabled={submitting} className="mt-5 w-full">
                        {submitting ? "Creating project..." : "Create project"}{!submitting && <ArrowRight size={14} />}
                    </Button>
                </form>
            </div>
        </main>
    );
}

export default function Home() {
    return <Suspense fallback={<span className="sr-only" role="status">Loading Specbook</span>}><HomeContent /></Suspense>;
}
