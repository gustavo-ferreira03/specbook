"use client";

import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  BookOpenCheck,
  Compass,
  Globe,
  KeyRound,
  LoaderCircle,
  RefreshCw,
} from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";

import { useAuth } from "@/components/AuthProvider";
import { EmptyState } from "@/components/EmptyState";
import { InstanceHeader } from "@/components/InstanceHeader";
import { Brand } from "@/components/LogoMark";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { api, getLlmRuntimeStatus } from "@/lib/api";
import type { Project } from "@/lib/types";

function HomeContent() {
  const { canEdit, isAdmin } = useAuth();
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
  const [llmReady, setLlmReady] = useState(false);

  useEffect(() => {
    let active = true;
    getLlmRuntimeStatus()
      .then((status) => {
        if (active) {
          setLlmReady(status.ready);
        }
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
        if (!active) {
          return;
        }
        setLastProjectId(localStorage.getItem("specbook:last-project"));
        if (result.projects.length > 0 && (!forceNew || !canEdit)) {
          const lastProject = localStorage.getItem("specbook:last-project");
          const destination =
            result.projects.find((project) => project.id === lastProject) ??
            result.projects[0];
          router.replace(`/p/${destination.id}`);
          return;
        }
        setProjects(result.projects);
      })
      .catch((error) => {
        if (!active) {
          return;
        }
        setLoadError(error instanceof Error ? error.message : String(error));
        setProjects([]);
      });
    return () => {
      active = false;
    };
  }, [forceNew, retryKey, router, canEdit]);

  async function createProject(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setCreateError("");
    setSubmitting(true);
    try {
      const result = await api<{
        project: Project;
        discoveryChatId: string | null;
      }>("/projects", {
        method: "POST",
        body: JSON.stringify({ name: name.trim(), baseUrl: baseUrl.trim() }),
      });
      localStorage.setItem("specbook:last-project", result.project.id);
      router.push(
        result.discoveryChatId
          ? `/p/${result.project.id}/chats/${result.discoveryChatId}`
          : `/p/${result.project.id}`
      );
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : String(error));
      setSubmitting(false);
    }
  }

  if (projects === null) {
    return (
      <main
        className="bg-canvas min-h-dvh"
        aria-label="Loading projects"
        aria-busy="true"
        role="status"
      >
        <span className="sr-only">Loading projects</span>
        <div className="border-line bg-surface flex h-14 items-center border-b px-4 sm:px-6">
          <Skeleton className="h-6 w-28" />
        </div>
        <div className="mx-auto grid w-full max-w-[1040px] items-start gap-10 px-4 py-10 sm:px-8 md:grid-cols-[minmax(0,1fr)_minmax(0,27rem)] md:gap-16 md:py-20">
          <div className="space-y-4 md:pt-6">
            <Skeleton className="h-3.5 w-24" />
            <Skeleton className="h-8 w-80 max-w-full" />
            <Skeleton className="h-4 w-96 max-w-full" />
            <div className="space-y-3 pt-4">
              {[0, 1, 2].map((row) => (
                <Skeleton key={row} className="h-10 w-full max-w-sm" />
              ))}
            </div>
          </div>
          <Skeleton className="h-[26rem] rounded-xl" />
        </div>
      </main>
    );
  }

  if (loadError) {
    return (
      <main className="bg-canvas flex min-h-dvh items-center justify-center px-4">
        <div className="border-line bg-surface w-full max-w-sm rounded-xl border p-2 shadow-xs">
          <EmptyState
            icon={AlertCircle}
            tone="danger"
            role="alert"
            title="Specbook could not load"
            description={loadError}
            action={
              <Button
                type="button"
                onClick={() => setRetryKey((key) => key + 1)}
              >
                <RefreshCw size={14} /> Try again
              </Button>
            }
            className="py-8"
          />
        </div>
      </main>
    );
  }

  if (!canEdit) {
    return (
      <main className="bg-surface min-h-dvh">
        <InstanceHeader />
        <EmptyState
          title="No projects available"
          description="An administrator or editor can create the first project. You will be able to read its Specs and results here."
        />
      </main>
    );
  }
  const returnProject =
    projects.find((project) => project.id === lastProjectId) ?? projects[0];
  const steps = [
    {
      icon: Globe,
      title: "Point it at your app",
      text: "Any URL the self-hosted runtime can reach, such as a staging site.",
    },
    {
      icon: Compass,
      title: "Let the agent explore",
      text: "A bounded browser maps areas, terms, and roles into the project context.",
    },
    {
      icon: BookOpenCheck,
      title: "Write executable Specs",
      text: "Describe behavior in a chat. Specs stay readable and run on demand.",
    },
  ];

  return (
    <main className="bg-canvas min-h-dvh">
      <header className="border-line bg-surface flex h-14 items-center justify-between border-b px-4 sm:px-6">
        <Brand />
        {returnProject && (
          <Button asChild variant="ghost" size="sm">
            <Link href={`/p/${returnProject.id}`}>
              <ArrowLeft size={14} />{" "}
              <span className="max-w-[12rem] truncate">
                Back to {returnProject.name}
              </span>
            </Link>
          </Button>
        )}
      </header>

      <div className="mx-auto grid w-full max-w-[1040px] items-start gap-10 px-4 py-10 sm:px-8 md:grid-cols-[minmax(0,1fr)_minmax(0,27rem)] md:gap-16 md:py-20">
        <div className="md:pt-6">
          <p className="eyebrow text-ink-subtle">
            {returnProject ? "New project" : "Welcome to Specbook"}
          </p>
          <h1 className="text-display text-ink mt-2 max-w-md text-balance">
            {returnProject
              ? "Add another application"
              : "Connect your first application"}
          </h1>
          <p className="text-body text-ink-muted mt-3 max-w-[46ch]">
            Living, executable Specs for web applications. Chats, browser
            sessions, and Specs stay grouped inside the project.
          </p>
          <ol className="mt-8 hidden max-w-md space-y-5 md:block">
            {steps.map((step) => (
              <li key={step.title} className="flex gap-3.5">
                <span className="bg-surface text-ink ring-line flex size-9 shrink-0 items-center justify-center rounded-full ring-1">
                  <step.icon size={16} aria-hidden="true" />
                </span>
                <div className="min-w-0">
                  <p className="text-control text-ink font-medium">
                    {step.title}
                  </p>
                  <p className="text-control text-ink-muted mt-0.5">
                    {step.text}
                  </p>
                </div>
              </li>
            ))}
          </ol>
        </div>

        <form
          onSubmit={createProject}
          className="border-line bg-surface overflow-hidden rounded-xl border shadow-xs"
          aria-labelledby="new-project-heading"
        >
          <div className="border-line border-b px-5 py-4">
            <h2 id="new-project-heading" className="text-section text-ink">
              Project details
            </h2>
            <p className="text-control text-ink-muted mt-0.5">
              You can change these later in settings.
            </p>
          </div>
          <div className="space-y-5 px-5 py-5">
            <div>
              <Label className="mb-1.5" htmlFor="project-name">
                Project name
              </Label>
              <Input
                id="project-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                required
                autoFocus
                autoComplete="off"
                placeholder="Customer portal"
                disabled={submitting}
              />
            </div>
            <div>
              <Label className="mb-1.5" htmlFor="base-url">
                Base URL
              </Label>
              <Input
                id="base-url"
                value={baseUrl}
                onChange={(event) => setBaseUrl(event.target.value)}
                required
                type="url"
                inputMode="url"
                placeholder="https://staging.example.com"
                className="text-meta font-mono"
                aria-describedby="base-url-help"
                disabled={submitting}
              />
              <p
                id="base-url-help"
                className="text-meta text-ink-subtle mt-1.5"
              >
                Use a URL the self-hosted runtime can reach. Chats and runs
                start here.
              </p>
            </div>
            {!llmReady && (
              <Alert
                variant="warning"
                role="status"
                className="flex items-start gap-2.5"
              >
                <KeyRound
                  size={15}
                  aria-hidden="true"
                  className="mt-0.5 shrink-0"
                />
                <div className="min-w-0">
                  <AlertTitle>No agent model is configured</AlertTitle>
                  <AlertDescription>
                    You can create the project now. The agent explores it as
                    soon as a model is connected
                    {isAdmin ? (
                      <>
                        :{" "}
                        <Link href="/settings?tab=model">
                          connect one in instance settings
                        </Link>
                        .
                      </>
                    ) : (
                      ". Ask an administrator to connect a model."
                    )}
                  </AlertDescription>
                </div>
              </Alert>
            )}
            {createError && (
              <Alert variant="danger" role="alert">
                <AlertDescription>{createError}</AlertDescription>
              </Alert>
            )}
          </div>
          <div className="border-line bg-surface-soft flex flex-col gap-2 border-t px-5 py-4">
            <Button
              type="submit"
              size="lg"
              disabled={submitting}
              className="w-full"
            >
              {submitting ? (
                <>
                  <LoaderCircle
                    size={15}
                    className="animate-spin motion-reduce:animate-none"
                  />{" "}
                  Creating project…
                </>
              ) : (
                <>
                  {llmReady ? "Create project and explore" : "Create project"}{" "}
                  <ArrowRight size={15} />
                </>
              )}
            </Button>
          </div>
        </form>
      </div>
    </main>
  );
}

export default function Home() {
  return (
    <Suspense
      fallback={
        <main className="bg-canvas min-h-dvh" role="status">
          <span className="sr-only">Loading Specbook</span>
        </main>
      }
    >
      <HomeContent />
    </Suspense>
  );
}
