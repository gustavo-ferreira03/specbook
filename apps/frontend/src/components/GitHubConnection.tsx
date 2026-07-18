"use client";

import { useEffect, useState } from "react";
import { AlertCircle, Check, GitBranch, GitMerge, RefreshCw, Unplug } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
            <section className="mt-7" aria-labelledby="github-heading" aria-busy="true">
                <Skeleton className="h-4 w-32" />
                <Skeleton className="mt-3 h-20 rounded-[9px]" />
            </section>
        );
    }

    const connected = Boolean(git?.remoteUrl);
    const conflicts = git?.conflictPaths ?? [];
    const reusingSavedToken = Boolean(git?.hasToken && remoteUrl.trim() === git.remoteUrl);

    return (
        <section className="mt-7" aria-labelledby="github-heading">
            <div className="flex items-end justify-between gap-4">
                <div>
                    <h2 id="github-heading" className="flex items-center gap-1.5 text-[0.8125rem] font-bold">
                        <GitBranch size={14} /> GitHub repository
                    </h2>
                    <p className="mt-1 text-[0.65625rem] text-ink-faint">
                        Specs always use local git history. Connect a remote to sync them with GitHub.
                    </p>
                </div>
                {connected && <span className="shrink-0 text-[0.625rem] font-bold text-success">Connected</span>}
            </div>

            <div className="mt-3 border-y border-line py-4">
                <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,0.8fr)]">
                    <div>
                        <Label htmlFor="git-remote-url" className="mb-1.5">Repository URL</Label>
                        <Input
                            id="git-remote-url"
                            value={remoteUrl}
                            onChange={(event) => setRemoteUrl(event.target.value)}
                            placeholder="https://github.com/org/repo.git"
                            disabled={Boolean(busy)}
                        />
                    </div>
                    <div>
                        <Label htmlFor="git-token" className="mb-1.5">
                            Fine-grained token{reusingSavedToken ? " (saved)" : ""}
                        </Label>
                        <Input
                            id="git-token"
                            type="password"
                            value={token}
                            onChange={(event) => setToken(event.target.value)}
                            placeholder={reusingSavedToken ? "Leave blank to keep it" : "github_pat_..."}
                            autoComplete="off"
                            disabled={Boolean(busy)}
                        />
                    </div>
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                    <Button
                        type="button"
                        disabled={Boolean(busy) || !remoteUrl.trim()}
                        onClick={() => run("connect", async () => {
                            const nextToken = token.trim() || undefined;
                            await connectProjectGit(projectId, remoteUrl.trim(), nextToken);
                            setToken("");
                        }, connected ? "Connection updated." : "Repository connected.")}
                    >
                        <Check size={13} /> {busy === "connect" ? "Checking..." : connected ? "Update connection" : "Connect repository"}
                    </Button>
                    {connected && (
                        <>
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
                                <RefreshCw size={13} className={busy === "sync" ? "animate-spin motion-reduce:animate-none" : ""} />
                                {busy === "sync" ? "Syncing..." : "Sync now"}
                            </Button>
                            <Button
                                type="button"
                                variant="ghost"
                                disabled={Boolean(busy)}
                                onClick={() => run("disconnect", () => disconnectProjectGit(projectId), "Repository disconnected.")}
                            >
                                <Unplug size={13} /> Disconnect
                            </Button>
                            {reusingSavedToken && (
                                <Button
                                    type="button"
                                    variant="ghost"
                                    disabled={Boolean(busy)}
                                    onClick={() => run(
                                        "remove-token",
                                        async () => void (await connectProjectGit(projectId, remoteUrl.trim(), null)),
                                        "Saved token removed.",
                                    )}
                                >
                                    Remove token
                                </Button>
                            )}
                        </>
                    )}
                </div>
            </div>

            {notice && <p className="mt-3 flex items-center gap-1.5 text-[0.65625rem] font-bold text-success" role="status"><Check size={12} /> {notice}</p>}
            {error && <Alert variant="destructive" className="mt-3" role="alert"><AlertTitle>Git operation failed</AlertTitle><AlertDescription>{error}</AlertDescription></Alert>}
            {git?.pushError && <Alert variant="destructive" className="mt-3" role="alert"><AlertTitle>Push failed</AlertTitle><AlertDescription className="break-words">{git.pushError}</AlertDescription></Alert>}
            {git?.contextSyncError && <Alert variant="warning" className="mt-3" role="alert"><AlertTitle>context.yml is invalid</AlertTitle><AlertDescription>{git.contextSyncError}</AlertDescription></Alert>}
            {conflicts.length > 0 && (
                <Alert variant="conflict" className="mt-3" role="alert">
                    <div className="flex items-start gap-2">
                        <GitMerge size={14} className="mt-0.5 shrink-0" />
                        <div className="min-w-0 flex-1">
                            <AlertTitle>Git sync conflict</AlertTitle>
                            <AlertDescription className="mt-1 break-words">{conflicts.join(", ")}</AlertDescription>
                            <div className="mt-2 flex flex-wrap gap-2">
                                <Button
                                    type="button"
                                    size="sm"
                                    variant="outline"
                                    disabled={Boolean(busy)}
                                    onClick={() => run("resolve-local", async () => {
                                        const { outcome } = await resolveProjectGit(
                                            projectId,
                                            conflicts.map((path) => ({ path, keep: "local" as const })),
                                        );
                                        if (outcome.status === "conflict") {
                                            throw new Error("More conflicting files need an explicit choice.");
                                        }
                                    }, "Conflicts resolved with local files.")}
                                >
                                    Keep all local
                                </Button>
                                <Button
                                    type="button"
                                    size="sm"
                                    variant="outline"
                                    disabled={Boolean(busy)}
                                    onClick={() => run("resolve-remote", async () => {
                                        const { outcome } = await resolveProjectGit(
                                            projectId,
                                            conflicts.map((path) => ({ path, keep: "remote" as const })),
                                        );
                                        if (outcome.status === "conflict") {
                                            throw new Error("More conflicting files need an explicit choice.");
                                        }
                                    }, "Conflicts resolved with remote files.")}
                                >
                                    Keep all remote
                                </Button>
                            </div>
                        </div>
                    </div>
                </Alert>
            )}
            {!git && error && <p className="mt-3 flex items-center gap-1.5 text-[0.65625rem] text-danger"><AlertCircle size={12} /> Retry by reloading this page.</p>}
        </section>
    );
}
