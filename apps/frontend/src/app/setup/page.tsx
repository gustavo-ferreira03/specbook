"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { AlertCircle, ArrowLeft, ArrowRight, Check, LoaderCircle, RefreshCw } from "lucide-react";
import { useAuth } from "@/components/AuthProvider";
import { EmptyState } from "@/components/EmptyState";
import { InstanceHeader } from "@/components/InstanceHeader";
import { ModelSettings } from "@/components/ModelSettings";
import { PageContainer, PageHeader } from "@/components/PageHeader";
import { InlineFeedback, SettingsBlock, SettingsFooter, SettingsRow, SettingsSection } from "@/components/SettingsLayout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { api, createContextDiscovery, errorMessage } from "@/lib/api";
import type { Project, SetupStatus } from "@/lib/types";

type SetupStep = "admin" | "model" | "project";

export default function SetupPage() {
    const router = useRouter();
    const { refresh } = useAuth();
    const [status, setStatus] = useState<SetupStatus | null>(null);
    const [step, setStep] = useState<SetupStep>("model");
    const [error, setError] = useState("");
    const [loadError, setLoadError] = useState("");
    const [busy, setBusy] = useState(false);
    const [adminName, setAdminName] = useState("");
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [projectName, setProjectName] = useState("");
    const [baseUrl, setBaseUrl] = useState("");
    const [demo, setDemo] = useState(false);
    const [createdProject, setCreatedProject] = useState<Project | null>(null);

    const load = useCallback(async () => {
        setLoadError("");
        try {
            const result = await api<SetupStatus>("/setup/status");
            if (result.authenticated === false && !result.needsAdmin) { router.replace("/login"); return; }
            if (result.authenticated) {
                const currentUser = await refresh();
                if (currentUser && currentUser.role !== "admin") { router.replace("/"); return; }
            }
            if (result.completed) { router.replace("/"); return; }
            setStatus(result);
            setStep(result.needsAdmin ? "admin" : "model");
        } catch (reason) { setLoadError(errorMessage(reason)); }
    }, [router, refresh]);

    useEffect(() => { void load(); }, [load]);

    async function createAdmin(event: React.FormEvent) {
        event.preventDefault();
        setBusy(true);
        setError("");
        try {
            await api("/setup/admin", { method: "POST", body: JSON.stringify({ name: adminName.trim(), email: email.trim(), password }) });
            setPassword("");
            await refresh();
            await load();
        } catch (reason) { setError(errorMessage(reason)); }
        finally { setBusy(false); }
    }

    function connectionTested() {
        if (!status?.needsProject) { router.replace("/"); return; }
        setError("");
        setStep("project");
    }

    function tryDemo() {
        setDemo(true);
        setProjectName("Sauce Demo");
        setBaseUrl("https://www.saucedemo.com");
        setError("");
    }

    async function createProject(explore: boolean) {
        if (!demo && (!projectName.trim() || !baseUrl.trim())) {
            setError("Enter a project name and the address of your app.");
            return;
        }
        setBusy(true);
        setError("");
        let project = createdProject;
        try {
            if (!project) {
                const result = demo
                    ? await api<{ project: Project }>("/setup/demo", { method: "POST" })
                    : await api<{ project: Project }>("/projects", { method: "POST", body: JSON.stringify({ name: projectName.trim(), baseUrl: baseUrl.trim() }) });
                project = result.project;
                setCreatedProject(project);
            }
            try { localStorage.setItem("specbook:last-project", project.id); } catch {}
            if (explore) {
                const discovery = await createContextDiscovery(project.id, {});
                router.push(`/p/${project.id}/chats/${discovery.chat.id}`);
            } else router.push(`/p/${project.id}`);
        } catch (reason) {
            setError(project ? `Your project was saved, but exploration could not start. ${errorMessage(reason)}` : errorMessage(reason));
            setBusy(false);
        }
    }

    const steps: { id: SetupStep; title: string }[] = [
        ...(status?.needsAdmin ? [{ id: "admin" as const, title: "Create admin" }] : []),
        { id: "model", title: "Connect model" },
        ...(status?.needsProject ? [{ id: "project" as const, title: "First project" }] : []),
    ];

    return <main className="min-h-dvh bg-surface">
        <InstanceHeader setup />
        <PageHeader title="Set up Specbook" description="Create the administrator account, then connect a model." width="reading" />
        <PageContainer width="reading" className="pb-16" innerClassName="space-y-8">
            {loadError ? <EmptyState icon={AlertCircle} tone="danger" role="alert" title="Setup could not load" description={loadError} action={<Button onClick={() => void load()}><RefreshCw size={14} /> Try again</Button>} /> : !status ? <div role="status" aria-label="Loading setup" aria-busy="true" className="space-y-5"><Skeleton className="h-5 w-60" /><Skeleton className="h-48 w-full" /></div> : <>
                <ol aria-label="Setup progress" className="flex flex-wrap items-center gap-x-6 gap-y-3 text-body">
                    {steps.map((item, index) => <li key={item.id} aria-current={step === item.id ? "step" : undefined} className={`flex items-center gap-2 ${step === item.id ? "font-medium text-ink" : "text-ink-muted"}`}>
                        <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-surface-selected text-meta tabular" aria-hidden="true">{index < steps.findIndex((item) => item.id === step) ? <Check size={14} /> : index + 1}</span>{item.title}
                    </li>)}
                </ol>
                {step === "admin" && <SettingsSection id="setup-admin-heading" title="Create the administrator" description="This account manages access and settings for this Specbook instance.">
                    <form onSubmit={createAdmin}>
                        <SettingsRow label="Name" htmlFor="admin-name"><Input id="admin-name" value={adminName} onChange={(event) => setAdminName(event.target.value)} required autoComplete="name" disabled={busy} /></SettingsRow>
                        <SettingsRow label="Email" htmlFor="admin-email"><Input id="admin-email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} required autoComplete="email" disabled={busy} /></SettingsRow>
                        <SettingsRow label="Password" htmlFor="admin-password" description="Use at least 12 characters."><Input id="admin-password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} minLength={12} maxLength={128} required autoComplete="new-password" disabled={busy} /></SettingsRow>
                        <SettingsFooter feedback={<InlineFeedback feedback={error ? { type: "error", text: error } : null} />}><Button type="submit" disabled={busy}>{busy ? "Creating account…" : "Create admin and continue"}<ArrowRight size={14} /></Button></SettingsFooter>
                    </form>
                </SettingsSection>}
                {step === "model" && <ModelSettings onConnectionTested={connectionTested} />}
                {step === "project" && <>
                    <SettingsSection id="setup-project-heading" title="Your first project" description="Use an app your Specbook server can reach. You can change these details later."
                        actions={!createdProject && <Button variant="outline" onClick={demo ? () => { setDemo(false); setProjectName(""); setBaseUrl(""); } : tryDemo} disabled={busy}>{demo ? "Use my own app" : "Try with a demo app"}</Button>}>
                        <form onSubmit={(event) => { event.preventDefault(); void createProject(true); }}>
                            <SettingsRow label="Project name" htmlFor="setup-project-name"><Input id="setup-project-name" value={projectName} onChange={(event) => setProjectName(event.target.value)} placeholder="Customer portal" required disabled={busy || demo || Boolean(createdProject)} /></SettingsRow>
                            <SettingsRow label="App URL" htmlFor="setup-base-url"><Input id="setup-base-url" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} type="url" inputMode="url" placeholder="https://staging.example.com" required disabled={busy || demo || Boolean(createdProject)} /></SettingsRow>
                            {demo && <SettingsBlock><p className="text-body text-ink">Sauce Demo is a public practice store. Specbook will save its public login for the agent to use.</p><p className="mt-2 text-body text-ink-muted">Username: <code className="text-meta">standard_user</code><br />Password: <code className="text-meta">secret_sauce</code></p></SettingsBlock>}
                            <SettingsFooter feedback={<InlineFeedback feedback={error ? { type: "error", text: error } : null} />}>
                                <Button type="submit" disabled={busy}>{busy && <LoaderCircle size={14} className="animate-spin motion-reduce:animate-none" />}{busy ? "Preparing your project…" : createdProject ? "Retry exploration" : "Create project and explore"}<ArrowRight size={14} /></Button>
                            </SettingsFooter>
                        </form>
                    </SettingsSection>
                    <div className="flex flex-wrap justify-between gap-3">
                        <Button variant="ghost" onClick={() => { setError(""); setStep("model"); }} disabled={busy}><ArrowLeft size={14} /> Model settings</Button>
                        {createdProject ? <Button asChild variant="outline"><Link href={`/p/${createdProject.id}`}>Open saved project</Link></Button> : <Button variant="ghost" onClick={() => void createProject(false)} disabled={busy}>Create without discovery</Button>}
                    </div>
                </>}
            </>}
        </PageContainer>
    </main>;
}
