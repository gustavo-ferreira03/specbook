"use client";

import { useEffect, useState } from "react";

import { getEnvironments } from "./api";
import { matchesInvalidation, onInvalidate } from "./invalidation";

export const useRunnerEnvironment = function useRunnerEnvironment(
  projectId: string
): boolean {
  const [runner, setRunner] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      try {
        const resolvedValue = await getEnvironments(
          projectId,
          controller.signal
        );
        const { environments } = resolvedValue;
        setRunner(
          environments.some(
            (environment) =>
              environment.name === "Production" &&
              environment.executor === "runner"
          )
        );
      } catch {
        // Keep the last usable state if this optional operation fails.
      }
    })();
    return () => controller.abort();
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- This dependency intentionally triggers a retry, navigation reset, or DOM measurement without being read by the effect.
  }, [projectId, revision]);
  useEffect(
    () =>
      onInvalidate((event) => {
        if (matchesInvalidation(event, "projects", projectId)) {
          setRevision((value) => value + 1);
        }
      }),
    [projectId]
  );
  return runner;
};
