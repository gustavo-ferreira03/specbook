"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { getOverview } from "./api";
import { invalidate, onInvalidate } from "./invalidation";
import type { OverviewResponse, SpecStatus } from "./types";
import { useVisiblePolling } from "./use-polling";

interface ProjectOverview {
  data: OverviewResponse | null;
  failed: boolean;
  reload: () => Promise<void>;
}

const ProjectOverviewContext = createContext<ProjectOverview | null>(null);

export const ProjectOverviewProvider = function ProjectOverviewProvider({
  projectId,
  children,
}: {
  projectId: string;
  children: React.ReactNode;
}) {
  const [state, setState] = useState<{
    projectId: string;
    data: OverviewResponse | null;
    failed: boolean;
  }>({ projectId, data: null, failed: false });
  const generation = useRef(0);

  const specSet = useRef("");

  const apply = useCallback(
    (data: OverviewResponse) => {
      setState({ projectId, data, failed: false });
      const specs = `${projectId}:${Object.entries(data.specHealth)
        .map(([id, health]) => `${id}=${health.status}`)
        .toSorted()
        .join(",")}`;
      if (
        specSet.current &&
        specSet.current !== specs &&
        specSet.current.startsWith(`${projectId}:`)
      ) {
        invalidate({ resource: "tree", projectId });
      }
      specSet.current = specs;
    },
    [projectId]
  );

  const reload = useCallback(async () => {
    generation.current += 1;
    const { current } = generation;
    try {
      const data = await getOverview(projectId);
      if (current === generation.current) {
        apply(data);
      }
    } catch {
      if (current === generation.current) {
        setState((previous) => ({
          projectId,
          data: previous.projectId === projectId ? previous.data : null,
          failed: true,
        }));
      }
    }
  }, [projectId, apply]);

  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- Reset the previous request or selection when its external key changes before loading fresh state.
    reload();
    return () => {
      generation.current += 1;
    };
  }, [reload]);
  useVisiblePolling(() => reload(), 5000);

  useEffect(
    () =>
      onInvalidate((event) => {
        if (!event.projectId || event.projectId === projectId) {
          reload();
        }
      }),
    [projectId, reload]
  );

  const current = state.projectId === projectId;
  const value = useMemo(
    () => ({
      data: current ? state.data : null,
      failed: current && state.failed,
      reload,
    }),
    [current, state.data, state.failed, reload]
  );
  return (
    <ProjectOverviewContext.Provider value={value}>
      {children}
    </ProjectOverviewContext.Provider>
  );
};

export const useDisplayStatus = function useDisplayStatus(spec: {
  id: string;
  status: SpecStatus;
}): SpecStatus | "repairing" {
  const overview = useContext(ProjectOverviewContext);
  return spec.status === "invalid" &&
    overview?.data?.specHealth[spec.id]?.status === "repairing"
    ? "repairing"
    : spec.status;
};

export const useProjectOverview =
  function useProjectOverview(): ProjectOverview {
    const overview = useContext(ProjectOverviewContext);
    if (!overview) {
      throw new Error(
        "useProjectOverview must be used inside ProjectOverviewProvider"
      );
    }
    return overview;
  };
