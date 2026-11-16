"use client";

import { LoaderCircle, PencilLine, ScanSearch } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";

import { useAuth } from "@/components/auth-provider";
import { Button } from "@/components/ui/button";
import {
  errorMessage,
  getCoverage,
  getProjectContext,
  requestTask,
} from "@/lib/api";
import type { CoverageResponse, ProjectContext } from "@/lib/types";
import { useRunnerEnvironment } from "@/lib/use-runner-environment";
import { cn } from "@/lib/utils";

const coverageLabel: Record<string, string> = {
  covered: "Covered",
  partial: "Partly covered",
  uncovered: "Not covered",
};
const coverageDot: Record<string, string> = {
  covered: "bg-success",
  partial: "bg-warning-icon",
  uncovered: "bg-ink-subtle",
};

export const SpecsFrontMatter = function SpecsFrontMatter({
  projectId,
}: {
  projectId: string;
}) {
  const { canEdit } = useAuth();
  const runnerEnvironment = useRunnerEnvironment(projectId);
  const [context, setContext] = useState<ProjectContext | null>(null);
  const [coverage, setCoverage] = useState<CoverageResponse | null>(null);
  const [finding, setFinding] = useState<"idle" | "requesting" | "requested">(
    "idle"
  );
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const resolvedValue = await getProjectContext(projectId);
        const result = resolvedValue;
        if (active) {
          setContext(result.confirmed?.context ?? null);
        }
      } catch {
        // Keep the last usable state if this optional operation fails.
      }
    })();
    (async () => {
      try {
        const resolvedValue = await getCoverage(projectId);
        const result = resolvedValue;
        if (active) {
          setCoverage(result);
        }
      } catch {
        // Keep the last usable state if this optional operation fails.
      }
    })();
    return () => {
      active = false;
    };
  }, [projectId]);

  const findUncovered = async function findUncovered() {
    setError("");
    setFinding("requesting");
    try {
      await requestTask(projectId, "coverage");
      setFinding("requested");
    } catch (error_) {
      setError(errorMessage(error_));
      setFinding("idle");
    }
  };

  if (!context) {
    return null;
  }
  const areas = coverage?.areas ?? [];
  return (
    <section aria-label="About this app" className="border-line border-b pb-7">
      <p className="text-body text-ink max-w-[72ch]">{context.summary}</p>
      {areas.length > 0 && (
        <ul
          className="mt-4 flex flex-wrap gap-x-6 gap-y-2"
          aria-label="Coverage by area"
        >
          {areas.map((area) => (
            <li key={area.name}>
              <Link
                href={
                  area.featureId
                    ? `#feature-${area.featureId}`
                    : `/p/${projectId}/settings?tab=context`
                }
                className="group text-control inline-flex items-center gap-2"
                title={area.reason}
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    "size-1.5 rounded-full",
                    coverageDot[area.coverage]
                  )}
                />
                <span className="text-ink font-medium group-hover:underline group-hover:underline-offset-4">
                  {area.name}
                </span>
                <span className="text-meta text-ink-muted">
                  {coverageLabel[area.coverage]}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {canEdit && (
        <div className="mt-5 flex flex-wrap items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={finding !== "idle" || runnerEnvironment}
            onClick={() => findUncovered()}
            className="-ml-2.5"
          >
            {finding === "requesting" ? (
              <LoaderCircle
                size={14}
                className="animate-spin motion-reduce:animate-none"
              />
            ) : (
              <ScanSearch size={14} />
            )}
            {finding === "requested"
              ? "Looking for uncovered areas…"
              : "Find uncovered areas"}
          </Button>
          <Button asChild variant="ghost" size="sm">
            <Link href={`/p/${projectId}/settings?tab=context`}>
              <PencilLine size={14} /> Edit context
            </Link>
          </Button>
        </div>
      )}
      {error && (
        <p role="alert" className="text-meta text-danger mt-2">
          {error}
        </p>
      )}
    </section>
  );
};
