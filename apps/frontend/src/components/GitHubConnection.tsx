"use client";

import { useEffect, useState } from "react";
import { Check, GitMerge, RefreshCw, Unplug } from "lucide-react";
import { InlineFeedback, SettingsBlock, SettingsFooter, SettingsRow, SettingsSection } from "@/components/SettingsLayout";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
    connectProjectGit,
    disconnectProjectGit,
    getProjectGit,
    resolveProjectGit,
    syncProjectGit,
} from "@/lib/api";
import type { GitStatus } from "@/lib/types";

export function GitHubConnection({ projectId }: { projectId: string }) {
    const [git, setGit] = useState<GitStatus | null>(null);
    const [remoteUrl, setRemoteUrl] = useState("");
    const [token, setToken] = useState("");
    const [busy, setBusy] = useState("");
    const [error, setError] = useState("");
    const [notice, setNotice] = useState("");

    async function refresh() {
        const result = await getProjectGit(projectId);
        setGit(result.git);
        setRemoteUrl(result.git.remoteUrl ?? "");
    }

    useEffect(() => {
        let active = true;
        getProjectGit(projectId)
            .then((result) => {
                if (!active) return;
                setGit(result.git);
                setRemoteUrl(result.git.remoteUrl ?? "");
            })
            .catch((caught: Error) => {
                if (active) setError(caught.message);
            });
        return () => {
            active = false;
        };
    }, [projectId]);

    async function run(key: string, action: () => Promise<void>, successNotice: string) {
        setBusy(key);
        setError("");
        setNotice("");
        try {
            await action();
            await refresh();
            setNotice(successNotice);
        } catch (caught) {
            await refresh().catch(() => undefined);
            setError(caught instanceof Error ? caught.message : String(caught));
        } finally {
            setBusy("");
        }
    }

    if (!git && !error) {
        return (
            <section aria-label="Loading GitHub mirror" aria-busy="true" role="status">
                <Skeleton className="mb-2 h-5 w-32" />
                <Skeleton className="mb-4 h-3.5 w-64" />
                <div className="rounded-xl border border-line">
                    {[0, 1].map((row) => (
                        <div key={row} className="grid gap-3 border-b border-line px-5 py-4 last:border-0 md:grid-cols-[13rem_1fr] md:gap-8">
                            <Skeleton className="h-4 w-24 md:mt-2.5" />
                            <Skeleton className="h-9" />
                        </div>
                    ))}
                </div>
            </section>
        );
    }

    const connected = Boolean(git?.remoteUrl);
    const conflicts = git?.conflictPaths ?? [];
    const reusingSavedToken = Boolean(git?.hasToken && remoteUrl.trim() === git.remoteUrl);

    function resolveAll(keep: "local" | "remote") {
        return run(`resolve-${keep}`, async () => {
            const { outcome } = await resolveProjectGit(
                projectId,
                conflicts.map((path) => ({ path, keep })),
            );
            if (outcome.status === "conflict") {
                throw new Error("More conflicting files need an explicit choice.");
            }
        }, keep === "local" ? "Conflicts resolved with local files." : "Conflicts resolved with remote files.");
    }

    const alerts = [
        git?.pushError && <Alert key="push" variant="danger" role="alert"><AlertTitle>Push failed</AlertTitle><AlertDescription className="break-words">{git.pushError}</AlertDescription></Alert>,
        git?.externalSyncError && <Alert key="external" variant="warning" role="alert"><AlertTitle>Pushed changes need attention</AlertTitle><AlertDescription className="break-words">{git.externalSyncError}</AlertDescription></Alert>,
        git?.contextSyncError && <Alert key="context" variant="warning" role="alert"><AlertTitle>context.yml is invalid</AlertTitle><AlertDescription className="break-words">{git.contextSyncError}</AlertDescription></Alert>,
        conflicts.length > 0 && (
            <Alert key="conflict" variant="conflict" role="alert">
                <div className="flex items-start gap-2.5">
                    <GitMerge size={15} className="mt-0.5 shrink-0" aria-hidden="true" />
                    <div className="min-w-0 flex-1">
                        <AlertTitle>Git sync conflict</AlertTitle>
                        <AlertDescription>Choose which side to keep for these files.</AlertDescription>
                        <ul className="mt-2 space-y-0.5 font-mono text-meta text-ink [overflow-wrap:anywhere]">
                            {conflicts.map((path) => <li key={path}>{path}</li>)}
                        </ul>
                        <div className="mt-3 flex flex-wrap gap-2">
                            <Button type="button" size="sm" variant="outline" disabled={Boolean(busy)} onClick={() => resolveAll("local")}>
                                Keep all local
                            </Button>
                            <Button type="button" size="sm" variant="outline" disabled={Boolean(busy)} onClick={() => resolveAll("remote")}>
                                Keep all remote
                            </Button>
                        </div>
                    </div>
                </div>
            </Alert>
        ),
    ].filter(Boolean);

    return (
        <SettingsSection
            id="github-heading"
            title="GitHub mirror"
            description="Optionally mirror the Specbook repository to GitHub. Specbook pushes changes automatically."
            actions={connected
                ? <Badge variant="success"><Check size={13} strokeWidth={2.25} aria-hidden="true" /> Connected</Badge>
                : <Badge variant="secondary">Not connected</Badge>}
        >
            <form
                onSubmit={(event) => {
                    event.preventDefault();
                    if (busy || !remoteUrl.trim()) return;
                    void run("connect", async () => {
                        const nextToken = token.trim() || undefined;
                        await connectProjectGit(projectId, remoteUrl.trim(), nextToken);
                        setToken("");
                    }, connected ? "Connection updated." : "Repository connected.");
                }}
            >
                {alerts.length > 0 && <SettingsBlock className="space-y-2">{alerts}</SettingsBlock>}
                <SettingsRow label="Repository URL" htmlFor="git-remote-url">
                    <Input
                        id="git-remote-url"
                        value={remoteUrl}
                        onChange={(event) => setRemoteUrl(event.target.value)}
                        placeholder="https://github.com/org/repo.git"
                        disabled={Boolean(busy)}
                        className="font-mono text-meta"
                        inputMode="url"
                        autoComplete="off"
                    />
                </SettingsRow>
                <SettingsRow
                    label="Fine-grained token"
                    htmlFor="git-token"
                    description={reusingSavedToken ? "A token is saved for this URL." : "Used to push to and pull from the mirror."}
                >
                    <Input
                        id="git-token"
                        type="password"
                        value={token}
                        onChange={(event) => setToken(event.target.value)}
                        placeholder={reusingSavedToken ? "Leave blank to keep the saved token" : "github_pat_..."}
                        autoComplete="off"
                        disabled={Boolean(busy)}
                        className="font-mono text-meta"
                    />
                    {reusingSavedToken && (
                        <Button
                            type="button"
                            variant="link"
                            className="mt-2 text-meta text-ink-muted"
                            disabled={Boolean(busy)}
                            onClick={() => run(
                                "remove-token",
                                async () => void (await connectProjectGit(projectId, remoteUrl.trim(), null)),
                                "Saved token removed.",
                            )}
                        >
                            Remove saved token
                        </Button>
                    )}
                </SettingsRow>
                <SettingsFooter
                    feedback={error
                        ? <InlineFeedback feedback={{ type: "error", text: git ? `Git operation failed: ${error}` : `${error} Reload this page to retry.` }} />
                        : notice ? <InlineFeedback feedback={{ type: "success", text: notice }} /> : null}
                >
                    {connected && (
                        <>
                            <Button
                                type="button"
                                variant="ghost"
                                disabled={Boolean(busy)}
                                onClick={() => run("disconnect", () => disconnectProjectGit(projectId), "Repository disconnected.")}
                            >
                                <Unplug size={14} /> Disconnect
                            </Button>
                            <Button
                                type="button"
                                variant="outline"
                                disabled={Boolean(busy)}
                                onClick={() => run("sync", async () => {
                                    const { outcome } = await syncProjectGit(projectId);
                                    if (outcome.status === "conflict") {
                                        throw new Error("Sync paused because files conflict with the remote repository.");
                                    }
                                }, "Local and remote histories reconciled.")}
                            >
                                <RefreshCw size={14} className={busy === "sync" ? "animate-spin motion-reduce:animate-none" : ""} />
                                {busy === "sync" ? "Syncing..." : "Sync now"}
                            </Button>
                        </>
                    )}
                    <Button type="submit" disabled={Boolean(busy) || !remoteUrl.trim()}>
                        {busy === "connect" ? "Checking..." : connected ? "Update connection" : "Connect repository"}
                    </Button>
                </SettingsFooter>
            </form>
        </SettingsSection>
    );
}
