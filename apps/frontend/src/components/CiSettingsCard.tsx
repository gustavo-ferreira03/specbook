"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Clipboard, ExternalLink, KeyRound, RefreshCw, RotateCw, Trash2, X } from "lucide-react";
import { ConfirmDeleteDialog } from "@/components/ConfirmDeleteDialog";
import { RelativeTime } from "@/components/RelativeTime";
import { InlineFeedback, SettingsBlock, SettingsFooter, SettingsRow, SettingsSection } from "@/components/SettingsLayout";
import { StatusPill } from "@/components/StatusPill";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import Link from "next/link";
import { EnvironmentSelect } from "@/components/EnvironmentSelect";
import type { ProjectEnvironment } from "@/lib/types";
import { Skeleton } from "@/components/ui/skeleton";
import { API_URL, api, apiPath, errorMessage, isAbortError } from "@/lib/api";
import { CI_PROVIDERS, ciSnippet, type CiProvider } from "@/lib/ci-snippets";
import { copyText, selectElementText } from "@/lib/clipboard";
import { countLabel, formatDuration } from "@/lib/format";

interface CiAccess {
    configured: boolean;
    prefix: string | null;
    createdAt: string | null;
    lastUsedAt: string | null;
}

interface CiBatch {
    batch: {
        id: string;
        label: string;
        status: "running" | "passed" | "failed" | "error";
        startedAt: string;
        durationMs: number | null;
        baseUrl: string;
        environment?: ProjectEnvironment;
        ci: { commitSha?: string; ref?: string; buildUrl?: string };
    };
    status: "running" | "passed" | "failed" | "error";
    complete: boolean;
    qualityGate: { passed: boolean; failures: number; flaky: number; knownBugs: number };
    url: string;
    results: { runId: string; title: string; status: "running" | "passed" | "failed" | "error"; url: string; flaky: boolean; knownBug: boolean }[];
}

interface CiSettings {
    environments: ProjectEnvironment[];
    token: CiAccess;
    batches: CiBatch[];
}

export function CiSettingsCard({ projectId, oneTimeToken, onOneTimeTokenChange }: {
    projectId: string;
    oneTimeToken: string | null;
    onOneTimeTokenChange: (token: string | null) => void;
}) {
    const [settings, setSettings] = useState<CiSettings | null>(null);
    const [environment, setEnvironment] = useState("Production");
    const [error, setError] = useState("");
    const [notice, setNotice] = useState("");
    const [busy, setBusy] = useState(false);
    const [retryKey, setRetryKey] = useState(0);
    const [confirmation, setConfirmation] = useState<"rotate" | "revoke" | null>(null);
    const [confirmError, setConfirmError] = useState("");
    const [provider, setProvider] = useState<CiProvider>("github");
    const [failOnFlaky, setFailOnFlaky] = useState(false);
    const [failOnKnownBugs, setFailOnKnownBugs] = useState(false);
    const [copied, setCopied] = useState<"token" | "snippet" | null>(null);
    const [copyError, setCopyError] = useState<"token" | "snippet" | null>(null);
    const tokenRef = useRef<HTMLElement | null>(null);
    const snippetRef = useRef<HTMLPreElement | null>(null);
    const confirmTriggerRef = useRef<HTMLElement | null>(null);
    const [publicApiUrl, setPublicApiUrl] = useState(API_URL);
    useEffect(() => { setPublicApiUrl(`${window.location.origin}${API_URL}`); }, []);
    const snippet = ciSnippet(provider, publicApiUrl, projectId, failOnFlaky, failOnKnownBugs, environment);
    const selectedProvider = CI_PROVIDERS.find(([value]) => value === provider)!;

    useEffect(() => {
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout>;
        async function load() {
            try {
                const result = await api<CiSettings>(apiPath`/projects/${projectId}/ci`, { signal: controller.signal });
                setSettings(result);
                setError("");
            } catch (caught) {
                if (!isAbortError(caught)) setError(errorMessage(caught));
            } finally {
                if (!controller.signal.aborted) timer = setTimeout(load, 15_000);
            }
        }
        void load();
        return () => {
            controller.abort();
            clearTimeout(timer);
        };
    }, [projectId, retryKey]);

    async function copy(value: string, kind: "token" | "snippet") {
        if (await copyText(value)) {
            setCopyError(null);
            setCopied(kind);
            window.setTimeout(() => setCopied((current) => current === kind ? null : current), 1800);
        } else {
            setCopied(null);
            setCopyError(kind);
            selectElementText(kind === "token" ? tokenRef.current : snippetRef.current);
        }
    }

    async function changeToken(action: "create" | "rotate" | "revoke") {
        setBusy(true);
        setError("");
        setNotice("");
        setConfirmError("");
        try {
            if (action === "revoke") {
                await api<void>(apiPath`/projects/${projectId}/ci/token`, { method: "DELETE" });
                onOneTimeTokenChange(null);
                setSettings((current) => current && { ...current, token: { configured: false, prefix: null, createdAt: null, lastUsedAt: null } });
            } else {
                const result = await api<{ token: string; access: CiAccess }>(apiPath`/projects/${projectId}/ci/token`, { method: "POST" });
                onOneTimeTokenChange(result.token);
                setSettings((current) => current && { ...current, token: result.access });
            }
            setConfirmation(null);
            setNotice(action === "rotate" ? "CI token rotated. Update the secret in your pipelines." : action === "revoke" ? "CI token revoked." : "CI token created.");
        } catch (caught) {
            if (action === "create") setError(errorMessage(caught));
            else setConfirmError(errorMessage(caught));
        } finally {
            setBusy(false);
        }
    }

    function openConfirmation(action: "rotate" | "revoke", trigger: HTMLElement) {
        confirmTriggerRef.current = trigger;
        setConfirmError("");
        setConfirmation(action);
    }

    if (!settings && !error) return (
        <section aria-label="Loading CI/CD settings" aria-busy="true" role="status">
            <Skeleton className="mb-2 h-5 w-40" />
            <Skeleton className="mb-4 h-4 w-64" />
            <Skeleton className="h-24 w-full rounded-xl" />
        </section>
    );

    if (!settings) return (
        <Alert variant="danger" role="alert">
            <AlertTitle>CI/CD settings could not load</AlertTitle>
            <AlertDescription>{error}<Button type="button" variant="outline" size="sm" className="mt-3" onClick={() => setRetryKey((value) => value + 1)}><RefreshCw size={14} /> Try again</Button></AlertDescription>
        </Alert>
    );

    return (
        <div className="space-y-10">
            <SettingsSection id="ci-access-heading" title="CI access" description="Run Specs and send deploy events from your pipeline.">
                <SettingsRow label="Project token" description="Store it as SPECBOOK_CI_TOKEN in your CI secret settings.">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                        <div className="min-w-0">
                            {settings.token.configured ? <p className="flex items-center gap-2 text-body text-ink"><KeyRound size={14} className="text-ink-subtle" aria-hidden="true" /><code className="font-mono text-meta">{settings.token.prefix}...</code></p> : <p className="text-body text-ink-muted">No CI token yet</p>}
                            {settings.token.configured && <p className="mt-0.5 text-meta text-ink-subtle">{settings.token.lastUsedAt ? <RelativeTime value={settings.token.lastUsedAt} prefix="Last used" /> : "Never used"}</p>}
                        </div>
                        <div className="flex flex-wrap gap-2">
                            <Button type="button" variant={settings.token.configured ? "outline" : "default"} disabled={busy} onClick={(event) => settings.token.configured ? openConfirmation("rotate", event.currentTarget) : void changeToken("create")}>
                                {busy ? <RefreshCw size={14} className="animate-spin motion-reduce:animate-none" /> : settings.token.configured ? <RotateCw size={14} /> : <KeyRound size={14} />}
                                {settings.token.configured ? "Rotate token" : "Create token"}
                            </Button>
                            {settings.token.configured && <Button type="button" variant="destructive-soft" disabled={busy} onClick={(event) => openConfirmation("revoke", event.currentTarget)}><Trash2 size={14} /> Revoke</Button>}
                        </div>
                    </div>
                </SettingsRow>
                {oneTimeToken && (
                    <SettingsBlock className="bg-warning-soft/60">
                        <div role="alert">
                            <p className="flex items-center gap-2 text-body font-semibold text-ink"><KeyRound size={14} className="text-warning-icon" aria-hidden="true" /> Copy this token now</p>
                            <p className="mt-1 text-meta text-ink-muted">It is shown only once and cannot be recovered.</p>
                        </div>
                        <div className="mt-3 flex flex-wrap items-stretch gap-2">
                            <code ref={tokenRef} className="flex min-h-9 min-w-0 flex-1 select-all items-center break-all rounded-md border border-warning/25 bg-surface px-3 py-2 font-mono text-meta text-ink">{oneTimeToken}</code>
                            <Button type="button" onClick={() => void copy(oneTimeToken, "token")} aria-live="polite">{copied === "token" ? <Check size={14} /> : <Clipboard size={14} />}{copied === "token" ? "Copied" : "Copy token"}</Button>
                        </div>
                        {copyError === "token" && <p className="mt-2 text-meta text-danger" role="alert">Clipboard unavailable. The token is selected; press Ctrl+C or Cmd+C to copy it.</p>}
                        <div className="mt-3 flex justify-end"><Button type="button" variant="outline" size="sm" onClick={() => { onOneTimeTokenChange(null); setCopyError(null); }}>I have saved it</Button></div>
                    </SettingsBlock>
                )}
                {(error || notice) && <SettingsFooter feedback={<InlineFeedback feedback={error ? { type: "error", text: error } : { type: "success", text: notice }} />} />}
            </SettingsSection>

            <SettingsSection id="ci-pipeline-heading" title="Pipeline setup" description="Run this after a deployment is ready. The runner needs access to your Specbook server.">
                <SettingsRow label="CI provider" htmlFor="ci-provider">
                    <Select value={provider} onValueChange={(value) => { setProvider(value as CiProvider); setCopied(null); setCopyError(null); }}><SelectTrigger id="ci-provider"><SelectValue /></SelectTrigger><SelectContent>{CI_PROVIDERS.map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}</SelectContent></Select>
                </SettingsRow>
                <SettingsRow label="Environment"><EnvironmentSelect projectId={projectId} value={environment} onValueChange={setEnvironment} /><p className="mt-1.5 text-meta text-ink-muted">Preview URLs must be allowed in <Link href={`/p/${projectId}/settings#environments-heading`} className="underline underline-offset-2">this environment</Link>.</p></SettingsRow>
                <SettingsRow label="Quality gate" description="These options are included in the snippet below.">
                    <div className="grid gap-3 sm:grid-cols-2">
                        <div className="space-y-1.5"><Label htmlFor="ci-flaky">Passes on retry</Label><Select value={String(failOnFlaky)} onValueChange={(value) => setFailOnFlaky(value === "true")}><SelectTrigger id="ci-flaky"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="false">Allow flaky Specs</SelectItem><SelectItem value="true">Fail the pipeline</SelectItem></SelectContent></Select></div>
                        <div className="space-y-1.5"><Label htmlFor="ci-known-bugs">Open app bug report</Label><Select value={String(failOnKnownBugs)} onValueChange={(value) => setFailOnKnownBugs(value === "true")}><SelectTrigger id="ci-known-bugs"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="false">Allow known failures</SelectItem><SelectItem value="true">Fail the pipeline</SelectItem></SelectContent></Select></div>
                    </div>
                </SettingsRow>
                <SettingsBlock>
                    <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                        <code className="break-all font-mono text-meta text-ink-muted">{selectedProvider[2]}</code>
                        <Button type="button" variant="outline" size="sm" onClick={() => void copy(snippet, "snippet")} aria-live="polite">{copied === "snippet" ? <Check size={14} /> : <Clipboard size={14} />}{copied === "snippet" ? "Copied" : "Copy snippet"}</Button>
                    </div>
                    <pre ref={snippetRef} tabIndex={0} aria-label={`${selectedProvider[1]} pipeline snippet`} className="max-h-96 overflow-auto rounded-md border border-line bg-surface-soft p-3 font-mono text-meta leading-5 text-ink focus-visible:outline-2 focus-visible:outline-ring"><code>{snippet}</code></pre>
                    {copyError === "snippet" && <p className="mt-2 text-meta text-danger" role="alert">Clipboard unavailable. The snippet is selected; press Ctrl+C or Cmd+C to copy it.</p>}
                    <p className="mt-3 text-body text-ink-muted">{provider === "jenkins" ? "Save the token as a secret text credential named specbook-ci-token." : `Save SPECBOOK_CI_TOKEN as a ${provider === "github" ? "repository secret" : provider === "gitlab" ? "masked CI/CD variable" : provider === "bitbucket" ? "secured repository variable" : "project environment variable"}.`} GitHub pull requests receive an updated comment using the job token. GitLab merge request comments require SPECBOOK_GITLAB_TOKEN with API access, saved only in CI. For preview deployments, set <code className="font-mono text-meta">SPECBOOK_BASE_URL</code> in the pipeline.</p>
                </SettingsBlock>
            </SettingsSection>

            <SettingsSection id="ci-batches-heading" title="Recent CI runs" description="Results include the commit and build that requested them.">
                {settings.batches.length === 0 ? <SettingsBlock><p className="text-body text-ink-muted">Your first pipeline run will appear here with its results and evidence.</p></SettingsBlock> : <ul className="divide-y divide-line" aria-label="Recent CI runs">{settings.batches.map((result) => (
                    <li key={result.batch.id} id={`ci-batch-${result.batch.id}`} className="scroll-mt-4 space-y-2 px-4 py-4 sm:px-5">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                            <a href={result.url} className="min-w-0 break-words text-body font-medium text-ink hover:underline">{result.batch.label || "CI runs"}</a>
                            <div className="flex flex-wrap items-center gap-2"><StatusPill status={result.batch.status} kind="run" size="sm" />{result.complete && <Badge variant={result.qualityGate.passed ? "success" : "danger"} size="sm">{result.qualityGate.passed ? <Check size={12} /> : <X size={12} />}Gate {result.qualityGate.passed ? "passed" : "failed"}</Badge>}</div>
                        </div>
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-meta text-ink-subtle">
                            {result.batch.environment && <Badge size="sm">{result.batch.environment.name}</Badge>}
                            <RelativeTime value={result.batch.startedAt} />
                            {result.batch.durationMs !== null && <span>{formatDuration(result.batch.durationMs)}</span>}
                            {result.batch.ci.ref && <span className="break-all">{result.batch.ci.ref}</span>}
                            {result.batch.ci.commitSha && <code title={result.batch.ci.commitSha} className="font-mono">{result.batch.ci.commitSha.slice(0, 8)}</code>}
                            {result.batch.ci.buildUrl && <a href={result.batch.ci.buildUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-ink-muted hover:underline">View build<ExternalLink size={12} /></a>}
                        </div>
                        <p className="break-all font-mono text-meta text-ink-subtle">{result.batch.baseUrl}</p>
                        {(result.qualityGate.flaky > 0 || result.qualityGate.knownBugs > 0) && <p className="text-meta text-ink-muted">{[result.qualityGate.flaky > 0 && `${result.qualityGate.flaky} flaky`, result.qualityGate.knownBugs > 0 && countLabel(result.qualityGate.knownBugs, "known bug")].filter(Boolean).join(" · ")}</p>}
                        <details className="text-body">
                            <summary className="cursor-pointer text-ink-muted hover:text-ink">{countLabel(result.results.length, "Spec")} · View evidence</summary>
                            <ul className="mt-2 space-y-2">{result.results.map((item) => <li key={item.runId} className="flex flex-wrap items-center justify-between gap-2"><a href={item.url} className="min-w-0 break-words text-ink hover:underline">{item.title}</a><StatusPill status={item.status} kind="run" size="sm" /></li>)}</ul>
                        </details>
                    </li>
                ))}</ul>}
            </SettingsSection>

            <ConfirmDeleteDialog open={confirmation !== null} title={confirmation === "rotate" ? "Rotate CI token?" : "Revoke CI token?"} description={confirmation === "rotate" ? "The current token stops working immediately. Update the secret in each pipeline with the new token." : "Pipelines using this token will no longer be able to trigger runs, read results, or send deploy events."} confirmLabel={confirmation === "rotate" ? "Rotate token" : "Revoke token"} busyLabel={confirmation === "rotate" ? "Rotating…" : "Revoking…"} busy={busy} error={confirmError} returnFocusRef={confirmTriggerRef} onCancel={() => { setConfirmation(null); setConfirmError(""); }} onConfirm={() => confirmation && void changeToken(confirmation)} />
        </div>
    );
}
