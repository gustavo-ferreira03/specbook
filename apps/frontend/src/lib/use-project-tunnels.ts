"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { errorMessage, getProjectTunnels, isAbortError } from "./api";
import { matchesInvalidation, onInvalidate } from "./invalidation";
import type { ProjectTunnel } from "./types";
import { useVisiblePolling } from "./use-polling";

export const useProjectTunnels = function useProjectTunnels(
  projectId: string
): {
  tunnels: ProjectTunnel[] | null;
  error: string;
} {
  const [tunnels, setTunnels] = useState<ProjectTunnel[] | null>(null);
  const [error, setError] = useState("");
  const request = useRef<AbortController | null>(null);
  const refresh = useCallback(() => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    (async () => {
      try {
        const resolvedValue = await getProjectTunnels(
          projectId,
          controller.signal
        );
        const { tunnels: tunnelsValue } = resolvedValue;
        if (!controller.signal.aborted) {
          setTunnels(tunnelsValue);
          setError("");
        }
      } catch (error_) {
        if (!isAbortError(error_)) {
          setError(errorMessage(error_));
        }
      }
    })();
  }, [projectId]);
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- Reset the previous request or selection when its external key changes before loading fresh state.
    setTunnels(null);
    setError("");
    refresh();
    return () => request.current?.abort();
  }, [refresh]);
  useEffect(
    () =>
      onInvalidate((event) => {
        if (matchesInvalidation(event, "projects", projectId)) {
          refresh();
        }
      }),
    [projectId, refresh]
  );
  useVisiblePolling(refresh, 5000, tunnels === null || tunnels.length > 0);
  return { tunnels, error };
};
