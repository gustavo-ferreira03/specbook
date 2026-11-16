"use client";

import {
  Check,
  ChevronDown,
  CircleCheck,
  CircleMinus,
  Clipboard,
  HardDrive,
  Network,
  RefreshCw,
  RotateCw,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { ConfirmDeleteDialog } from "@/components/ConfirmDeleteDialog";
import { Dot } from "@/components/Dot";
import { RelativeTime } from "@/components/RelativeTime";
import { RunnerQueueNotice } from "@/components/RunnerQueueNotice";
import { RunStateAnnouncement } from "@/components/RunStateAnnouncement";
import {
  InlineFeedback,
  SettingsBlock,
  SettingsFooter,
  SettingsRow,
  SettingsSection,
} from "@/components/SettingsLayout";
import type { InlineFeedbackValue } from "@/components/SettingsLayout";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  api,
  apiPath,
  errorMessage,
  isAbortError,
  listProjects,
} from "@/lib/api";
import { copyText, selectElementText } from "@/lib/clipboard";
import { countLabel } from "@/lib/format";
import type { Project, RunnerQueueEntry } from "@/lib/types";

interface Runner {
  id: string;
  name: string;
  group: string | null;
  purpose: "runner" | "tunnel";
  createdAt: string;
  lastSeenAt: string | null;
  online: boolean;
  cliVersion: string | null;
  protocolVersion: number | null;
  concurrency: number | null;
  outdated: boolean;
  projectIds: string[] | null;
  instances: {
    id: string;
    runnerId: string;
    mode: "runner" | "tunnel";
    cliVersion: string;
    protocolVersion: number;
    concurrency: number;
    lastSeenAt: string;
    outdated: boolean;
  }[];
}

function RunnerProcesses({ runner }: { runner: Runner }) {
  if (!runner.instances.length) {
    return (
      <p className="text-meta text-ink-muted mt-1 flex flex-wrap gap-x-3 gap-y-1">
        {runner.cliVersion ? (
          <span>
            CLI <span className="tabular">{runner.cliVersion}</span>
          </span>
        ) : (
          <span>Version not reported</span>
        )}
        {runner.protocolVersion !== null && (
          <span>
            Protocol <span className="tabular">{runner.protocolVersion}</span>
          </span>
        )}
        {runner.outdated && (
          <span className="text-ink inline-flex items-center gap-1.5">
            <TriangleAlert
              size={13}
              className="text-warning-icon"
              aria-hidden="true"
            />
            Update the runner CLI
          </span>
        )}
      </p>
    );
  }
  return (
    <ul
      className="mt-2 space-y-2"
      aria-label={`Connected processes using ${runner.name}`}
    >
      {runner.instances.map((instance) => (
        <li key={instance.id}>
          <p className="text-meta text-ink flex flex-wrap items-center gap-x-2 gap-y-1">
            {instance.mode === "tunnel" ? (
              <Network size={13} aria-hidden="true" />
            ) : (
              <HardDrive size={13} aria-hidden="true" />
            )}
            <span>
              {instance.mode === "tunnel" ? "Tunnel" : "Runner"} process{" "}
              <span className="font-mono">{instance.id.slice(0, 8)}</span>
            </span>
            <span className="text-ink-muted">
              Capacity <span className="tabular">{instance.concurrency}</span>
            </span>
          </p>
          <p className="text-meta text-ink-muted mt-0.5 flex flex-wrap gap-x-3 gap-y-1">
            <span>
              CLI <span className="tabular">{instance.cliVersion}</span>
            </span>
            <span>
              Protocol{" "}
              <span className="tabular">{instance.protocolVersion}</span>
            </span>
            <RelativeTime value={instance.lastSeenAt} prefix="Last seen" />
            {instance.outdated && (
              <span className="text-ink inline-flex items-center gap-1.5">
                <TriangleAlert
                  size={13}
                  className="text-warning-icon"
                  aria-hidden="true"
                />
                Update the {instance.mode === "tunnel" ? "tunnel" : "runner"}{" "}
                CLI
              </span>
            )}
          </p>
        </li>
      ))}
    </ul>
  );
}

export function RunnersSettings() {
  const [runners, setRunners] = useState<Runner[] | null>(null);
  const [queues, setQueues] = useState<RunnerQueueEntry[] | null>(null);
  const [queueError, setQueueError] = useState("");
  const [name, setName] = useState("");
  const [group, setGroup] = useState("");
  const [purpose, setPurpose] = useState<Runner["purpose"]>("runner");
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [projectsError, setProjectsError] = useState("");
  const [projectIds, setProjectIds] = useState<string[] | null>(null);
  const [secret, setSecret] = useState<{
    id: string;
    value: string;
    purpose: Runner["purpose"];
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [retry, setRetry] = useState(0);
  const [feedback, setFeedback] = useState<InlineFeedbackValue | null>(null);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const [revoke, setRevoke] = useState<Runner | null>(null);
  const [revokeError, setRevokeError] = useState("");
  const [rotate, setRotate] = useState<Runner | null>(null);
  const [rotateError, setRotateError] = useState("");
  const tokenRef = useRef<HTMLElement | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const rotateTriggerRef = useRef<HTMLElement | null>(null);
  const secretBlockRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function load() {
      const results = await Promise.allSettled([
        api<{ runners: Runner[] }>("/runners", { signal: controller.signal }),
        api<{ queues: RunnerQueueEntry[] }>("/runners/queue", {
          signal: controller.signal,
        }),
      ]);
      if (controller.signal.aborted) {
        return;
      }
      const [runnerResult, queueResult] = results;
      if (runnerResult.status === "fulfilled") {
        setRunners(runnerResult.value.runners);
      } else if (!isAbortError(runnerResult.reason)) {
        setFeedback({ type: "error", text: errorMessage(runnerResult.reason) });
      }
      if (queueResult.status === "fulfilled") {
        setQueues(queueResult.value.queues);
        setQueueError("");
      } else if (!isAbortError(queueResult.reason)) {
        setQueueError(errorMessage(queueResult.reason));
      }
      if (!controller.signal.aborted) {
        timer = setTimeout(load, 5000);
      }
    }
    void load();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [retry]);

  useEffect(() => {
    const controller = new AbortController();
    listProjects(controller.signal)
      .then(({ projects }) => {
        setProjects(projects);
        setProjectsError("");
      })
      .catch((reason) => {
        if (!isAbortError(reason)) {
          setProjectsError(errorMessage(reason));
        }
      });
    return () => controller.abort();
  }, [retry]);

  async function create(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setFeedback(null);
    setCopied(false);
    setCopyError(false);
    try {
      const result = await api<{ token: string; runner: Runner }>("/runners", {
        method: "POST",
        body: JSON.stringify({
          name: name.trim(),
          group: group.trim() || null,
          projectIds,
          purpose,
        }),
      });
      setSecret({
        id: result.runner.id,
        value: result.token,
        purpose: result.runner.purpose,
      });
      setRunners((current) => [
        { ...result.runner, instances: [] },
        ...(current ?? []),
      ]);
      setName("");
      setGroup("");
      setProjectIds(null);
      setPurpose("runner");
      setRotate(null);
    } catch (reason) {
      setFeedback({ type: "error", text: errorMessage(reason) });
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    if (!secret) {
      return;
    }
    if (await copyText(secret.value)) {
      setCopied(true);
      setCopyError(false);
    } else {
      setCopied(false);
      setCopyError(true);
      selectElementText(tokenRef.current);
    }
  }

  async function revokeToken() {
    if (!revoke) {
      return;
    }
    setBusy(true);
    setRevokeError("");
    try {
      await api(apiPath`/runners/${revoke.id}`, { method: "DELETE" });
      setRunners(
        (current) => current?.filter((runner) => runner.id !== revoke.id) ?? []
      );
      if (secret?.id === revoke.id) {
        setSecret(null);
      }
      if (rotate?.id === revoke.id) {
        setRotate(null);
      }
      setRevoke(null);
      setFeedback({ type: "success", text: "Token revoked." });
    } catch (reason) {
      setRevokeError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  }

  async function rotateToken() {
    if (!rotate) {
      return;
    }
    setBusy(true);
    setRotateError("");
    setCopied(false);
    setCopyError(false);
    try {
      const result = await api<{ token: string; runner: Runner }>(
        apiPath`/runners/${rotate.id}/rotate`,
        { method: "POST" }
      );
      setSecret({
        id: result.runner.id,
        value: result.token,
        purpose: result.runner.purpose,
      });
      setRunners(
        (current) =>
          current?.map((runner) =>
            runner.id === result.runner.id
              ? { ...result.runner, instances: [] }
              : runner
          ) ?? [{ ...result.runner, instances: [] }]
      );
      setRotate(null);
      setFeedback({
        type: "success",
        text: "Token rotated. The previous token has been revoked.",
      });
    } catch (reason) {
      setRotateError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  }

  function projectNames(ids: string[]): string {
    if (!projects) {
      return countLabel(ids.length, "selected project");
    }
    return ids
      .map(
        (id) =>
          projects?.find((project) => project.id === id)?.name ??
          "Unavailable project"
      )
      .join(", ");
  }

  return (
    <>
      <RunStateAnnouncement
        message={
          queues
            ?.filter((queue) => queue.queued > 0)
            .map(
              (queue) =>
                `${queue.projectName}, ${queue.environmentName}: Waiting to run. ${queue.reason ?? ""}`
            )
            .join(" ") || (queues ? "No runs are waiting." : "")
        }
      />
      <SettingsSection
        id="runner-queue-heading"
        title="Run queue"
        description="Waiting runs by environment and runner group."
        className="mb-10"
      >
        {queueError ? (
          <SettingsBlock>
            <p role="alert" className="text-control text-danger">
              Queue details are unavailable: {queueError}
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-3"
              onClick={() => setRetry((value) => value + 1)}
            >
              Refresh queue
            </Button>
          </SettingsBlock>
        ) : !queues ? (
          <SettingsBlock>
            <Skeleton
              className="h-16 w-full"
              role="status"
              aria-label="Loading run queue"
              aria-busy="true"
            />
          </SettingsBlock>
        ) : !queues.length ? (
          <SettingsBlock>
            <p className="text-body text-ink-muted">
              No environments use runners or tunnels yet. Choose Runner or
              Server through a tunnel in your project's environment settings.
            </p>
          </SettingsBlock>
        ) : (
          <ul aria-label="Runner queues">
            {queues.map((queue) => (
              <li
                key={queue.environmentId}
                className="border-line border-b px-4 py-4 last:border-b-0 sm:px-5"
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-body text-ink font-medium break-words">
                      <Link
                        href={`/p/${queue.projectId}/settings`}
                        className="focus-visible:ring-ring rounded-sm underline-offset-2 hover:underline focus-visible:ring-2 focus-visible:outline-none"
                      >
                        {queue.projectName}
                      </Link>{" "}
                      · {queue.environmentName}
                    </p>
                    <p className="text-meta text-ink-muted mt-1 flex items-center gap-1.5">
                      {queue.executor === "tunnel" && (
                        <Network size={13} aria-hidden="true" />
                      )}
                      {queue.executor === "tunnel"
                        ? "Server through a tunnel · "
                        : ""}
                      {queue.group ? `Group: ${queue.group}` : "Ungrouped"}
                    </p>
                  </div>
                  <p className="text-meta text-ink-muted">
                    <span className="tabular">{queue.onlineRunners}</span>{" "}
                    online ·{" "}
                    <span className="tabular">{queue.busyRunners}</span> busy
                  </p>
                </div>
                {queue.queued > 0 ? (
                  <RunnerQueueNotice queue={queue} className="mt-3" />
                ) : (
                  <p className="text-control text-ink-muted mt-3 flex items-center gap-1.5">
                    <CircleCheck size={14} aria-hidden="true" />
                    {countLabel(0, "run")} waiting
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </SettingsSection>
      <SettingsSection
        id="runners-heading"
        title="Runners"
        description="Tokens connect runners and tunnels outbound to Specbook. Runner credentials stay on their machine; tunnel environments use the server vault."
      >
        <form onSubmit={create}>
          <SettingsRow
            label="Token name"
            htmlFor="runner-name"
            description="Identify the machine or service that will use this token."
          >
            <Input
              id="runner-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Office runner"
              maxLength={80}
              required
              disabled={busy || Boolean(secret)}
            />
          </SettingsRow>
          <SettingsRow
            label="Token purpose"
            htmlFor="runner-purpose"
            description="Runner tokens execute Specs. Tunnel tokens connect the server's browsers to private apps."
          >
            <Select
              value={purpose}
              onValueChange={(value) => setPurpose(value as Runner["purpose"])}
              disabled={busy || Boolean(secret)}
            >
              <SelectTrigger id="runner-purpose">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="runner">Runner</SelectItem>
                <SelectItem value="tunnel">Tunnel</SelectItem>
              </SelectContent>
            </Select>
          </SettingsRow>
          <SettingsRow
            label="Runner group"
            htmlFor="runner-group"
            description={
              purpose === "tunnel"
                ? "Required. Match the tunnel environment's group."
                : "Optional. Match an environment's runner group to send its runs to these machines. Leave empty for ungrouped environments."
            }
          >
            <Input
              id="runner-group"
              value={group}
              onChange={(event) => setGroup(event.target.value)}
              placeholder="private-staging"
              maxLength={80}
              required={purpose === "tunnel"}
              disabled={busy || Boolean(secret)}
            />
          </SettingsRow>
          <SettingsRow
            label="Project access"
            htmlFor="runner-project-access"
            description="Limit which projects this token can access."
          >
            <Select
              value={projectIds === null ? "all" : "selected"}
              onValueChange={(value) =>
                setProjectIds(value === "all" ? null : [])
              }
              disabled={busy || Boolean(secret)}
            >
              <SelectTrigger id="runner-project-access">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All projects</SelectItem>
                <SelectItem value="selected" disabled={!projects?.length}>
                  Selected projects
                </SelectItem>
              </SelectContent>
            </Select>
            {projectIds !== null && (
              <div className="mt-2">
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      type="button"
                      variant="outline"
                      className="w-full justify-between"
                      aria-label="Choose runner projects"
                      disabled={busy || Boolean(secret) || !projects}
                    >
                      {projectIds.length
                        ? countLabel(projectIds.length, "project") + " selected"
                        : "Choose projects"}
                      <ChevronDown size={14} />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent
                    align="start"
                    className="max-h-80 max-w-[calc(100vw-3rem)]"
                  >
                    {projects?.map((project) => (
                      <DropdownMenuCheckboxItem
                        key={project.id}
                        checked={projectIds.includes(project.id)}
                        onSelect={(event) => event.preventDefault()}
                        onCheckedChange={(checked) =>
                          setProjectIds((current) =>
                            checked
                              ? [...(current ?? []), project.id]
                              : (current?.filter((id) => id !== project.id) ??
                                [])
                          )
                        }
                      >
                        <span className="max-w-reading truncate">
                          {project.name}
                        </span>
                      </DropdownMenuCheckboxItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
                {projectIds.length > 0 && (
                  <p className="text-meta text-ink-muted mt-1.5 break-words">
                    {projectNames(projectIds)}
                  </p>
                )}
              </div>
            )}
            {projectsError && (
              <p role="alert" className="text-meta text-danger mt-1.5">
                Projects could not load: {projectsError}
              </p>
            )}
          </SettingsRow>
          <SettingsFooter feedback={<InlineFeedback feedback={feedback} />}>
            <Button
              type="submit"
              disabled={
                busy ||
                !name.trim() ||
                Boolean(secret) ||
                projectIds?.length === 0 ||
                (purpose === "tunnel" && !group.trim())
              }
            >
              {busy && !revoke && !rotate ? (
                <RefreshCw
                  size={14}
                  className="animate-spin motion-reduce:animate-none"
                />
              ) : purpose === "tunnel" ? (
                <Network size={14} />
              ) : (
                <HardDrive size={14} />
              )}
              Create {purpose} token
            </Button>
          </SettingsFooter>
        </form>
        {secret && (
          <SettingsBlock className="bg-warning-soft/60">
            <div
              ref={secretBlockRef}
              tabIndex={-1}
              role="group"
              aria-label="New token"
              className="focus-visible:ring-ring rounded-sm outline-none focus-visible:ring-2"
            >
              <div role="status">
                <p className="text-body text-ink flex items-center gap-2 font-semibold">
                  {secret.purpose === "tunnel" ? (
                    <Network
                      size={14}
                      className="text-warning-icon"
                      aria-hidden="true"
                    />
                  ) : (
                    <HardDrive
                      size={14}
                      className="text-warning-icon"
                      aria-hidden="true"
                    />
                  )}
                  Copy this token now
                </p>
                <p className="text-meta text-ink-muted mt-1">
                  It is shown only once and cannot be recovered.
                </p>
              </div>
              <div className="mt-3 flex flex-wrap items-stretch gap-2">
                <code
                  ref={tokenRef}
                  className="border-warning/25 bg-surface text-meta text-ink flex min-h-9 min-w-0 flex-1 items-center rounded-md border px-3 py-2 font-mono break-all select-all"
                >
                  {secret.value}
                </code>
                <Button
                  type="button"
                  onClick={() => void copy()}
                  aria-live="polite"
                >
                  {copied ? <Check size={14} /> : <Clipboard size={14} />}
                  {copied ? "Copied" : "Copy token"}
                </Button>
              </div>
              {copyError && (
                <p className="text-meta text-danger mt-2" role="alert">
                  Clipboard unavailable. The token is selected; press Ctrl+C or
                  Cmd+C to copy it.
                </p>
              )}
              <p className="text-body text-ink-muted mt-3">
                Inside the private network, use{" "}
                <code className="text-meta font-mono">
                  specbook {secret.purpose} --server &lt;server-url&gt;
                  --allow-origin &lt;app-origin&gt;
                </code>
                {secret.purpose === "tunnel"
                  ? " with the project and environment flags"
                  : ""}{" "}
                and enter this token at the hidden prompt. Automation can set{" "}
                <code className="text-meta font-mono">
                  SPECBOOK_RUNNER_TOKEN
                </code>
                .
              </p>
              <div className="mt-3 flex justify-end">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setSecret(null);
                    setCopyError(false);
                  }}
                >
                  I have saved it
                </Button>
              </div>
            </div>
          </SettingsBlock>
        )}
        {!runners ? (
          <SettingsBlock>
            {feedback?.type === "error" ? (
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setFeedback(null);
                  setRetry((value) => value + 1);
                }}
              >
                Try again
              </Button>
            ) : (
              <div role="status" aria-label="Loading runners" aria-busy="true">
                <Skeleton className="h-20 w-full" />
              </div>
            )}
          </SettingsBlock>
        ) : !runners.length ? (
          <SettingsBlock>
            <p className="text-body text-ink-muted">
              Create a runner or tunnel token, then start its CLI command inside
              the private network.
            </p>
          </SettingsBlock>
        ) : (
          <ul aria-label="Runner tokens">
            {runners.map((runner) => (
              <li
                key={runner.id}
                className="border-line flex flex-wrap items-center justify-between gap-3 border-b px-4 py-4 last:border-b-0 sm:px-5"
              >
                <div className="min-w-0">
                  <p className="text-body text-ink flex items-center gap-2 font-medium break-words">
                    {runner.purpose === "tunnel" ? (
                      <Network
                        size={14}
                        className="text-ink-subtle shrink-0"
                        aria-hidden="true"
                      />
                    ) : (
                      <HardDrive
                        size={14}
                        className="text-ink-subtle shrink-0"
                        aria-hidden="true"
                      />
                    )}
                    {runner.name}
                  </p>
                  <p className="text-meta text-ink-muted mt-1 flex flex-wrap gap-x-3 gap-y-1">
                    <span
                      className={`inline-flex items-center gap-1.5 ${runner.online ? "text-success" : "text-ink-muted"}`}
                    >
                      {runner.online ? (
                        <CircleCheck size={13} aria-hidden="true" />
                      ) : (
                        <CircleMinus size={13} aria-hidden="true" />
                      )}
                      {runner.online ? "Online" : "Offline"}
                    </span>
                    <span>
                      {runner.purpose === "tunnel"
                        ? "Tunnel token"
                        : "Runner token"}
                    </span>
                    <Dot />
                    <span>
                      {runner.group ? `Group: ${runner.group}` : "Ungrouped"}
                    </span>
                    {runner.lastSeenAt ? (
                      <RelativeTime
                        value={runner.lastSeenAt}
                        prefix="Last seen"
                      />
                    ) : (
                      <span>Never connected</span>
                    )}
                    <RelativeTime value={runner.createdAt} prefix="Created" />
                  </p>
                  <p className="text-meta text-ink-muted mt-1 break-words">
                    {runner.projectIds
                      ? `Projects: ${projectNames(runner.projectIds)}`
                      : "All projects"}
                  </p>
                  <RunnerProcesses runner={runner} />
                </div>
                <div className="flex flex-wrap gap-3">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={busy || Boolean(secret)}
                    aria-label={`Rotate token ${runner.name}`}
                    onClick={(event) => {
                      rotateTriggerRef.current = event.currentTarget;
                      setRotateError("");
                      setRotate(runner);
                    }}
                  >
                    <RotateCw size={14} />
                    Rotate token
                  </Button>
                  <Button
                    type="button"
                    variant="destructive-soft"
                    size="sm"
                    disabled={busy}
                    aria-label={`Revoke token ${runner.name}`}
                    onClick={(event) => {
                      triggerRef.current = event.currentTarget;
                      setRevokeError("");
                      setRevoke(runner);
                    }}
                  >
                    <Trash2 size={14} />
                    Revoke token
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </SettingsSection>
      <ConfirmDeleteDialog
        open={Boolean(rotate)}
        title="Rotate token?"
        description={
          <>
            The previous token for <strong>{rotate?.name}</strong> will stop
            working immediately. Update the {rotate?.purpose ?? "runner"} with
            the replacement token before reconnecting.
          </>
        }
        confirmLabel="Rotate token"
        busyLabel="Rotating…"
        busy={busy}
        error={rotateError}
        returnFocusRef={secret ? secretBlockRef : rotateTriggerRef}
        onCancel={() => {
          setRotate(null);
          setRotateError("");
        }}
        onConfirm={() => void rotateToken()}
      />
      <ConfirmDeleteDialog
        open={Boolean(revoke)}
        title="Revoke token?"
        description={
          <>
            The {revoke?.purpose ?? "runner"} named{" "}
            <strong>{revoke?.name}</strong> will disconnect.{" "}
            {revoke?.purpose === "tunnel"
              ? "New runs wait until a tunnel reconnects."
              : "Runs this runner had started go back to the queue after a short timeout."}
          </>
        }
        confirmLabel="Revoke token"
        busyLabel="Revoking…"
        busy={busy}
        error={revokeError}
        returnFocusRef={triggerRef}
        onCancel={() => {
          setRevoke(null);
          setRevokeError("");
        }}
        onConfirm={() => void revokeToken()}
      />
    </>
  );
}
