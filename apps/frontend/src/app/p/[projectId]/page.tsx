"use client";

import {
  AlertCircle,
  Check,
  ChevronRight,
  Clock3,
  Compass,
  ExternalLink,
  CircleHelp,
  Eye,
  LoaderCircle,
  ScanSearch,
  MessageSquareText,
  Pause,
  Play,
  RefreshCw,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import Link from "next/link";
import { use, useMemo, useEffect, useRef, useState } from "react";

import { useAuth } from "@/components/auth-provider";
import { DecisionDetails } from "@/components/decision-details";
import { EmptyState } from "@/components/empty-state";
import { PageContainer } from "@/components/page-header";
import { RelativeTime } from "@/components/relative-time";
import { RunnerExplorationNotice } from "@/components/runner-exploration-notice";
import { SectionHeader } from "@/components/section-header";
import { InlineFeedback } from "@/components/settings-layout";
import type { InlineFeedbackValue } from "@/components/settings-layout";
import { SpecGrid } from "@/components/spec-grid";
import { StatusPill } from "@/components/status-pill";
import { StoryDetails } from "@/components/story-details";
import { TunnelConnectionNotice } from "@/components/tunnel-connection-notice";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import {
  getProject,
  getProjectContext,
  requestTask as requestProjectTask,
  setStewardPaused,
} from "@/lib/api";
import { environmentLabel, formatDateTime } from "@/lib/format";
import { useProjectOverview } from "@/lib/project-overview";
import type { OverviewResponse, Project, RecentRun } from "@/lib/types";
import { useRunnerEnvironment } from "@/lib/use-runner-environment";

interface Selection {
  type: "item" | "story" | "failure";
  id: string;
}

const RUN_TRIGGERS: Record<RecentRun["trigger"], string> = {
  deploy: "Deployments",
  ci: "CI",
  schedule: "Scheduled",
  manual: "Manual",
  spec_change: "Spec changes",
};
const LOAD_ERROR =
  "The latest project overview could not load. Check your connection and try again.";

const OverviewRow = function OverviewRow({
  icon,
  title,
  time,
  action = "Details",
  onClick,
  annotation,
  detail,
}: {
  icon: React.ReactNode;
  title: string;
  time?: string;
  action?: string;
  onClick: () => void;
  annotation?: string;
  detail?: string;
}) {
  return (
    <li className="min-w-0">
      <Button
        type="button"
        variant="ghost"
        onClick={onClick}
        className="text-body h-auto w-full justify-start gap-3 rounded-none px-4 py-3 text-left font-normal"
      >
        <span className="flex shrink-0 items-center" aria-hidden="true">
          {icon}
        </span>
        <span className="min-w-0 flex-1">
          <span
            className={
              annotation
                ? "block truncate"
                : "block break-words whitespace-normal sm:truncate"
            }
            title={title}
          >
            {title}
          </span>
          {detail && (
            <span className="text-meta text-ink-subtle mt-0.5 block whitespace-normal">
              {detail}
            </span>
          )}
        </span>
        {annotation && (
          <span
            className="text-meta text-ink-muted max-w-[45%] shrink-0 truncate"
            title={annotation}
          >
            {annotation}
          </span>
        )}
        {time && (
          <RelativeTime
            value={time}
            className="text-meta text-ink-subtle hidden shrink-0 sm:block"
          />
        )}
        <span className="text-meta text-ink-muted flex shrink-0 items-center gap-1 font-medium">
          <span className={annotation ? "hidden sm:inline" : undefined}>
            {action}
          </span>
          <ChevronRight size={13} />
        </span>
      </Button>
    </li>
  );
};

const OverviewSection = function OverviewSection({
  id,
  title,
  count,
  children,
}: {
  id: string;
  title: string;
  count?: number;
  children: React.ReactNode;
}) {
  return (
    <section aria-labelledby={id}>
      <SectionHeader id={id} title={title} count={count} className="mb-2" />
      {children}
    </section>
  );
};

const RowList = function RowList({ children }: { children: React.ReactNode }) {
  return (
    <ul className="sheet divide-line bg-surface divide-y overflow-hidden rounded-xl">
      {children}
    </ul>
  );
};

const ShowMore = function ShowMore({
  label = "Show more",
  onClick,
}: {
  label?: string;
  onClick: () => void;
}) {
  return (
    <Button variant="ghost" size="sm" className="mt-2" onClick={onClick}>
      {label}
    </Button>
  );
};

const BusyButton = function BusyButton({
  busy,
  icon: Icon,
  variant = "outline",
  disabled,
  onClick,
  children,
}: {
  busy: boolean;
  icon: LucideIcon;
  variant?: "outline" | "ghost";
  disabled: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Button variant={variant} size="sm" disabled={disabled} onClick={onClick}>
      {busy ? (
        <LoaderCircle
          size={14}
          className="animate-spin motion-reduce:animate-none"
        />
      ) : (
        <Icon size={14} />
      )}
      {children}
    </Button>
  );
};

const RunOutcome = function RunOutcome({ run }: { run: RecentRun }) {
  if (run.counts.running > 0) {
    return (
      <LoaderCircle
        size={15}
        className="text-running animate-spin motion-reduce:animate-none"
      />
    );
  }
  if (run.outcome === "failed" || run.counts.failed > 0) {
    return <AlertCircle size={15} className="text-danger" />;
  }
  if (run.outcome === "flaky" || run.counts.flaky > 0) {
    return <RefreshCw size={15} className="text-warning" />;
  }
  if (run.counts.awaiting_deploy > 0) {
    return <Clock3 size={15} className="text-ink-subtle" />;
  }
  if (run.outcome === "passed") {
    return <Check size={15} className="text-success" />;
  }
  return <Check size={15} className="text-ink-subtle" />;
};

const runCounts = function runCounts(run: RecentRun) {
  if (run.counts.total <= 1) {
    return run.counts.awaiting_deploy ? "Waiting for deploy" : "";
  }
  return `${run.counts.passed} passed · ${run.counts.failed} failed${run.counts.flaky ? ` · ${run.counts.flaky} flaky` : ""}${run.counts.running ? ` · ${run.counts.running} running` : ""}${run.counts.awaiting_deploy ? ` · ${run.counts.awaiting_deploy} waiting for deploy` : ""}`;
};

const _healthStatus = function _healthStatus(
  health: OverviewResponse["summary"]["specHealth"]
) {
  if (health.failing > 0) {
    return "failing";
  }
  if (health.running > 0) {
    return "running";
  }
  if (health.invalid > 0) {
    return "invalid";
  }
  if (health.repairing > 0) {
    return "repairing";
  }
  if (health.flaky > 0) {
    return "flaky";
  }
  if (health.passing > 0) {
    return "passing";
  }
  return "not_checked";
};

const HomeHero =
  /* oxlint-disable eslint/complexity -- Keep the existing render states and their coordinated actions together during the lint migration. */
  function HomeHero({
    projectName,
    baseUrl,
    summary,
    actions,
  }: {
    projectName?: string;
    baseUrl?: string;
    summary?: OverviewResponse["summary"];
    actions?: React.ReactNode;
  }) {
    const paused = summary?.globallyPaused || summary?.paused;
    const [headline, ...details] = (summary?.verdict ?? "").split(" · ");
    const agentLine = (() => {
      if (summary?.globallyPaused) {
        return "Specbook is paused across all projects.";
      }
      if (summary?.paused) {
        return "Paused by you. Nothing runs until you resume.";
      }
      return summary?.nextCheck;
    })();
    return (
      <header className="border-line bg-surface relative isolate shrink-0 overflow-hidden border-b px-4 pt-8 pb-7 md:px-8 md:pt-10 md:pb-8">
        <SpecGrid fade={false} className="spec-grid-header -z-10" />
        <div className="max-w-data mx-auto w-full">
          <p className="text-meta text-ink-muted flex min-w-0 items-center gap-2 font-mono">
            <span className="truncate">{projectName ?? "Project"}</span>
            {baseUrl && (
              <>
                <span aria-hidden="true">·</span>
                <a
                  href={baseUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="hover:text-ink inline-flex min-w-0 items-center gap-1"
                >
                  <span className="truncate">
                    {baseUrl.replace(/^https?:\/\//u, "").replace(/\/$/u, "")}
                  </span>
                  <ExternalLink
                    size={11}
                    aria-hidden="true"
                    className="shrink-0"
                  />
                  <span className="sr-only">(opens in a new tab)</span>
                </a>
              </>
            )}
          </p>
          {summary ? (
            <>
              <h1 className="text-display text-ink mt-2 font-[650]">
                {headline}
              </h1>
              {(details.length > 0 || summary.lastCheckedAt) && (
                <p className="text-control text-ink-muted mt-2 flex flex-wrap items-center gap-x-2">
                  {details.length > 0 && (
                    <span className="text-ink font-medium">
                      {details.join(" · ")}
                    </span>
                  )}
                  {details.length > 0 && summary.lastCheckedAt && (
                    <span aria-hidden="true">·</span>
                  )}
                  {summary.lastCheckedAt && (
                    <RelativeTime
                      value={summary.lastCheckedAt}
                      prefix="last checked"
                    />
                  )}
                  {summary.nextCheckAt && (
                    <>
                      <span aria-hidden="true">·</span>
                      <span>
                        next run{" "}
                        <time dateTime={summary.nextCheckAt}>
                          {formatDateTime(summary.nextCheckAt)}
                        </time>
                      </span>
                    </>
                  )}
                </p>
              )}
              {summary.specHealth.awaiting_deploy > 0 && (
                <div className="text-control mt-2 flex items-center gap-2">
                  <StatusPill status="awaiting_deploy" />
                  <span className="text-ink-muted">
                    {summary.specHealth.awaiting_deploy}{" "}
                    {summary.specHealth.awaiting_deploy === 1
                      ? "Spec"
                      : "Specs"}
                  </span>
                </div>
              )}
              <div className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-2">
                <p className="text-control text-ink flex min-w-0 items-center gap-2">
                  <span
                    aria-hidden="true"
                    className={
                      paused
                        ? "bg-ink-subtle size-2 shrink-0 rounded-full"
                        : "bg-success status-pulse size-2 shrink-0 rounded-full"
                    }
                  />
                  <span className="min-w-0">{agentLine}</span>
                </p>
                {actions && (
                  <div className="flex flex-wrap items-center gap-1">
                    {actions}
                  </div>
                )}
              </div>
              {summary.systemHealth && (
                /* oxlint-disable jsx-a11y/prefer-tag-over-role -- Alert forwards live-region semantics to its shared native wrapper; preserve the component structure. */
                <Alert variant="warning" role="status" className="mt-4">
                  <AlertDescription>
                    {summary.systemHealth.message}
                  </AlertDescription>
                </Alert>
                /* oxlint-enable jsx-a11y/prefer-tag-over-role */
              )}
            </>
          ) : (
            <Skeleton className="mt-3 h-10 w-80 max-w-full" />
          )}
        </div>
      </header>
    );
  };
/* oxlint-enable eslint/complexity */

const NeedsYou = function NeedsYou({
  items,
  onOpen,
}: {
  items: OverviewResponse["needsYou"];
  onOpen: (selection: Selection) => void;
}) {
  const [limit, setLimit] = useState(5);
  return (
    <OverviewSection
      id="needs-you"
      title="Waiting for you"
      count={items.length}
    >
      <RowList>
        {items.slice(0, limit).map((item) => (
          <OverviewRow
            key={item.id}
            icon={<CircleHelp size={16} className="text-warning-icon" />}
            title={item.presentation.title}
            time={item.createdAt}
            action="Review"
            onClick={() => onOpen({ type: "item", id: item.id })}
          />
        ))}
      </RowList>
      {items.length > limit && (
        <ShowMore onClick={() => setLimit((count) => count + 5)} />
      )}
    </OverviewSection>
  );
};

const SelectedSpecs = function SelectedSpecs({
  items,
  onOpen,
}: {
  items: OverviewResponse["items"];
  onOpen: (selection: Selection) => void;
}) {
  return (
    <OverviewSection id="selected-specs" title="In progress">
      <RowList>
        {items.slice(0, 5).map((item) => (
          <OverviewRow
            key={item.id}
            icon={<LoaderCircle size={16} className="text-ink-subtle" />}
            title={item.presentation.title}
            annotation={item.presentation.summary}
            time={item.createdAt}
            action="View results"
            onClick={() => onOpen({ type: "item", id: item.id })}
          />
        ))}
      </RowList>
    </OverviewSection>
  );
};

const Failing = function Failing({
  failing,
  onOpen,
}: {
  failing: OverviewResponse["failing"];
  onOpen: (selection: Selection) => void;
}) {
  const [limit, setLimit] = useState(5);
  return (
    <OverviewSection id="failing" title="Failing" count={failing.length}>
      <RowList>
        {failing.slice(0, limit).map((failure) => (
          <OverviewRow
            key={failure.specId}
            icon={<AlertCircle size={16} className="text-danger" />}
            title={failure.title}
            annotation={failure.triageStatus}
            time={failure.updatedAt}
            onClick={() => onOpen({ type: "failure", id: failure.specId })}
          />
        ))}
      </RowList>
      {failing.length > limit && (
        <ShowMore onClick={() => setLimit((count) => count + 5)} />
      )}
    </OverviewSection>
  );
};

const RecentRuns = function RecentRuns({
  runs,
  onOpen,
}: {
  runs: RecentRun[];
  onOpen: (selection: Selection) => void;
}) {
  const [limit, setLimit] = useState(10);
  const groups = new Map<RecentRun["trigger"], RecentRun[]>();
  for (const run of runs.slice(0, limit)) {
    groups.set(run.trigger, [...(groups.get(run.trigger) ?? []), run]);
  }
  return (
    <OverviewSection id="recent-runs" title="Recently">
      {[...groups].map(([trigger, group]) => (
        <div key={trigger} className="mt-4 first:mt-0">
          <h3 className="text-meta text-ink-subtle mb-1 font-medium">
            {RUN_TRIGGERS[trigger]}
          </h3>
          <RowList>
            {group.map((run) => (
              <OverviewRow
                key={run.id}
                icon={<RunOutcome run={run} />}
                title={run.subject.name}
                annotation={[
                  environmentLabel(run.environment?.name),
                  runCounts(run),
                ]
                  .filter(Boolean)
                  .join(" · ")}
                detail={`${run.occurrences > 1 ? `${run.occurrences} runs · Last ` : ""}${formatDateTime(run.updatedAt, { seconds: true })}`}
                onClick={() => onOpen({ type: "story", id: run.id })}
              />
            ))}
          </RowList>
        </div>
      ))}
      {runs.length > limit && (
        <ShowMore
          label="Show more runs"
          onClick={() => setLimit((count) => count + 10)}
        />
      )}
    </OverviewSection>
  );
};

const HomePage =
  /* oxlint-disable eslint/complexity -- Keep the existing render states and their coordinated actions together during the lint migration. */
  function HomePage({ params }: { params: Promise<{ projectId: string }> }) {
    const { canEdit, isAdmin } = useAuth();
    const { projectId } = use(params);
    const runnerEnvironment = useRunnerEnvironment(projectId);
    const { data, failed, reload } = useProjectOverview();
    const [project, setProject] = useState<Project | null>(null);
    const [needsContext, setNeedsContext] = useState(false);
    useEffect(() => {
      let active = true;
      (async () => {
        try {
          const resolvedValue = await getProject(projectId);
          const result = resolvedValue;
          if (active) {
            setProject(result.project);
          }
        } catch {
          // Keep the last usable state if this optional operation fails.
        }
      })();
      (async () => {
        try {
          const resolvedValue = await getProjectContext(projectId);
          const result = resolvedValue;
          if (active) {
            setNeedsContext(!result.confirmed && !result.draft);
          }
        } catch {
          // Keep the last usable state if this optional operation fails.
        }
      })();
      return () => {
        active = false;
      };
    }, [projectId]);
    const [selected, setSelected] = useState<Selection | null>(null);
    const [requestingTask, setRequestingTask] = useState<
      "coverage" | "explore" | null
    >(null);
    const [savingPause, setSavingPause] = useState(false);
    const [feedback, setFeedback] = useState<InlineFeedbackValue | null>(null);
    const openedAnchor = useRef("");
    const returnFocus = useRef<HTMLElement | null>(null);

    const stories = useMemo(
      () => (data ? [...data.stories, ...data.recentRuns] : []),
      [data]
    );
    const item =
      selected?.type === "item"
        ? data?.items.find((itemValue) => itemValue.id === selected.id)
        : undefined;
    const story =
      selected?.type === "story"
        ? stories.find((storyValue) => storyValue.id === selected.id)
        : undefined;
    const failure =
      selected?.type === "failure"
        ? data?.failing.find((entry) => entry.specId === selected.id)
        : undefined;
    const failureStory = failure?.storyId
      ? data?.stories.find((storyValue) => storyValue.id === failure.storyId)
      : undefined;

    useEffect(() => {
      const fromHash = function fromHash() {
        let anchor: string;
        try {
          anchor = decodeURIComponent(window.location.hash.slice(1));
        } catch {
          return;
        }
        if (!anchor || anchor === openedAnchor.current || !data) {
          return;
        }
        const itemValue = data.items.find((entry) => entry.id === anchor);
        const storyValue = stories.find(
          (entry) =>
            entry.id === anchor ||
            entry.jobIds.includes(anchor) ||
            entry.timeline.some((event) => event.id === anchor)
        );
        if (itemValue) {
          setSelected({ type: "item", id: itemValue.id });
        } else if (storyValue) {
          setSelected({ type: "story", id: storyValue.id });
        } else if (data.failing.some((entry) => entry.specId === anchor)) {
          setSelected({ type: "failure", id: anchor });
        } else {
          return;
        }
        openedAnchor.current = anchor;
      };
      fromHash();
      window.addEventListener("hashchange", fromHash);
      return () => window.removeEventListener("hashchange", fromHash);
    }, [data, stories]);

    const open = function open(selection: Selection) {
      if (!selected) {
        returnFocus.current =
          document.activeElement instanceof HTMLElement
            ? document.activeElement
            : null;
      }
      const anchor = selection.id;
      openedAnchor.current = anchor;
      window.history.replaceState(
        window.history.state,
        "",
        `#${encodeURIComponent(anchor)}`
      );
      setSelected(selection);
    };

    const close = function close() {
      setSelected(null);
      openedAnchor.current = "";
      window.history.replaceState(
        window.history.state,
        "",
        `${window.location.pathname}${window.location.search}`
      );
    };

    const togglePause = async function togglePause() {
      if (!data) {
        return;
      }
      const paused = !data.summary.paused;
      setSavingPause(true);
      setFeedback(null);
      try {
        await setStewardPaused(projectId, paused);
        await reload();
        setFeedback({
          type: "success",
          text: paused
            ? "Specbook is paused for this project. Current work will stop safely."
            : "Specbook has resumed this project.",
        });
      } catch {
        setFeedback({
          type: "error",
          text: "The pause setting could not be saved. Try again in a moment.",
        });
        // oxlint-disable-next-line react/todo -- Oxlint React Compiler cannot analyze this supported JavaScript syntax; preserve its cleanup and error behavior.
      } finally {
        setSavingPause(false);
      }
    };

    const requestTask = async function requestTask(
      kind: "coverage" | "explore"
    ) {
      setRequestingTask(kind);
      setFeedback(null);
      try {
        const result = await requestProjectTask(projectId, kind);
        setFeedback({
          type: "success",
          text: (() => {
            if (result.status === "paused") {
              return "Requested. Resume Specbook to start.";
            }
            if (kind === "coverage") {
              return "Coverage review requested. Suggestions will appear in Needs you.";
            }
            return "Exploration requested. Findings will appear in Needs you.";
          })(),
        });
        await reload();
      } catch {
        setFeedback({
          type: "error",
          text: "The request could not start. Try again in a moment.",
        });
        // oxlint-disable-next-line react/todo -- Oxlint React Compiler cannot analyze this supported JavaScript syntax; preserve its cleanup and error behavior.
      } finally {
        setRequestingTask(null);
      }
    };

    const selectedSpecs =
      data?.items.filter(
        (itemValue) =>
          itemValue.kind === "spec_batch" && itemValue.status === "approved"
      ) ?? [];
    const hasActivity =
      data &&
      (data.needsYou.length || data.failing.length || data.recentRuns.length);
    const emptyProject =
      data && !hasActivity && data.summary.specHealth.total === 0;
    const panelTitle =
      item?.presentation.title ?? story?.title ?? failure?.title ?? "Details";
    const panelTime = item?.createdAt ?? story?.updatedAt ?? failure?.updatedAt;
    const tryAgain = () => reload();

    const agentActions = data && canEdit && (
      <>
        <BusyButton
          busy={requestingTask === "explore"}
          icon={ScanSearch}
          variant="ghost"
          disabled={requestingTask !== null || runnerEnvironment}
          onClick={() => requestTask("explore")}
        >
          Explore app
        </BusyButton>
        {data.summary.globallyPaused ? (
          isAdmin && (
            <Button asChild variant="ghost" size="sm">
              <Link href="/settings?tab=agent#agent-pause-heading">
                <Play size={14} /> Resume in settings
              </Link>
            </Button>
          )
        ) : (
          <BusyButton
            busy={savingPause}
            icon={data.summary.paused ? Play : Pause}
            variant="ghost"
            disabled={savingPause}
            onClick={() => togglePause()}
          >
            {(() => {
              if (savingPause) {
                return "Saving…";
              }
              if (data.summary.paused) {
                return "Resume";
              }
              return "Pause";
            })()}
          </BusyButton>
        )}
      </>
    );

    return (
      <div className="bg-surface flex min-h-full flex-col">
        <HomeHero
          projectName={project?.name}
          baseUrl={project?.baseUrl}
          summary={data && !emptyProject ? data.summary : undefined}
          actions={agentActions}
        />
        <PageContainer width="data" innerClassName="space-y-9">
          {runnerEnvironment && <RunnerExplorationNotice />}
          <TunnelConnectionNotice projectId={projectId} />
          {failed && data && (
            <Alert
              variant="danger"
              role="alert"
              className="flex flex-wrap items-center justify-between gap-3"
            >
              <AlertDescription>{LOAD_ERROR}</AlertDescription>
              <Button variant="outline" size="sm" onClick={tryAgain}>
                <RefreshCw size={13} /> Try again
              </Button>
            </Alert>
          )}
          {needsContext && canEdit && !runnerEnvironment && (
            <section
              aria-label="Map your app"
              className="sheet bg-surface flex flex-wrap items-center gap-4 rounded-xl p-5"
            >
              <div className="min-w-0 flex-1">
                <p className="text-section text-ink">Map your app first</p>
                <p className="text-body text-ink-muted mt-1">
                  Specbook explores {project?.baseUrl ?? "your app"} and drafts
                  what it does: areas, roles and rules. Every Spec and chat
                  starts from that map.
                </p>
              </div>
              <Button asChild>
                <Link href={`/p/${projectId}/settings?tab=context`}>
                  <Compass size={14} /> Start mapping
                </Link>
              </Button>
            </section>
          )}
          {(() => {
            if (failed && !data) {
              return (
                <EmptyState
                  role="alert"
                  tone="danger"
                  icon={AlertCircle}
                  title="Home could not load"
                  description={LOAD_ERROR}
                  action={
                    <Button onClick={tryAgain}>
                      <RefreshCw size={14} /> Try again
                    </Button>
                  }
                />
              );
            }
            if (data) {
              return (
                <>
                  {feedback && <InlineFeedback feedback={feedback} />}
                  {data.needsYou.length > 0 && (
                    <NeedsYou items={data.needsYou} onOpen={open} />
                  )}
                  {selectedSpecs.length > 0 && (
                    <SelectedSpecs items={selectedSpecs} onOpen={open} />
                  )}
                  {data.failing.length > 0 && (
                    <Failing failing={data.failing} onOpen={open} />
                  )}
                  {data.recentRuns.length > 0 && (
                    <RecentRuns runs={data.recentRuns} onOpen={open} />
                  )}
                  {emptyProject && (
                    <EmptyState
                      icon={Eye}
                      title="Your project starts here"
                      description="Describe a behavior in a chat. Spec results and anything that needs you will appear here."
                      action={
                        canEdit && (
                          <Button asChild variant="outline">
                            <Link href={`/p/${projectId}/chats/new`}>
                              <MessageSquareText size={14} /> Tell Specbook
                              about your app
                            </Link>
                          </Button>
                        )
                      }
                    />
                  )}
                </>
              );
            }
            return (
              <output
                className="block space-y-6"

                aria-busy="true"
                aria-label="Loading Home"
              >
                {[0, 1, 2].map((row) => (
                  <Skeleton key={row} className="h-11 w-full" />
                ))}
              </output>
            );
          })()}
        </PageContainer>
        <Sheet
          open={Boolean(selected)}
          onOpenChange={(value) => {
            if (!value) {
              close();
            }
          }}
        >
          <SheetContent
            side="right"
            className="bg-surface sm:max-w-reading w-full"
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              const target = returnFocus.current?.isConnected
                ? returnFocus.current
                : document.querySelector<HTMLElement>("#main-content");
              target?.focus();
            }}
          >
            <SheetHeader className="border-line shrink-0 border-b px-5 py-5 pr-14">
              <SheetTitle className="text-section break-words">
                {panelTitle}
              </SheetTitle>
              <SheetDescription asChild>
                <p className="text-meta">
                  {panelTime ? (
                    <RelativeTime value={panelTime} />
                  ) : (
                    "Details for this Spec."
                  )}
                </p>
              </SheetDescription>
            </SheetHeader>
            <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-5 py-5">
              {item && (
                <DecisionDetails
                  key={item.id}
                  projectId={projectId}
                  item={item}
                  story={data?.stories.find(
                    (storyValue) =>
                      storyValue.id === item.presentation.activityId
                  )}
                  onChange={reload}
                />
              )}
              {story && (
                <StoryDetails
                  story={story}
                  projectId={projectId}
                  onDecision={(id) => open({ type: "item", id })}
                />
              )}
              {failure && (
                <>
                  <p className="text-body text-ink">{failure.triageStatus}</p>
                  {failure.inboxIds
                    .flatMap(
                      (id) =>
                        data?.items.find((itemValue) => itemValue.id === id) ??
                        []
                    )
                    .map((itemValue) => (
                      <Button
                        key={itemValue.id}
                        variant="outline"
                        className="h-auto max-w-full text-left whitespace-normal"
                        onClick={() => open({ type: "item", id: itemValue.id })}
                      >
                        {itemValue.presentation.type === "bug"
                          ? "View the bug report"
                          : "Review the suggestion"}
                        <ChevronRight size={14} />
                      </Button>
                    ))}
                  {failureStory ? (
                    <StoryDetails
                      story={failureStory}
                      showDecisions={false}
                      projectId={projectId}
                      onDecision={(id) => open({ type: "item", id })}
                    />
                  ) : (
                    <Button asChild variant="outline">
                      <Link
                        href={`/p/${projectId}/specs/${failure.specId}${failure.runId ? `#run-${failure.runId}` : ""}`}
                      >
                        View the Spec and evidence
                      </Link>
                    </Button>
                  )}
                </>
              )}
            </div>
          </SheetContent>
        </Sheet>
      </div>
    );
  };
/* oxlint-enable eslint/complexity */
export default HomePage;
