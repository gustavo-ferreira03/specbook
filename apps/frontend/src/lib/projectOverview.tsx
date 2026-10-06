"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { getOverview } from "./api";
import { invalidate, onInvalidate } from "./invalidation";
import type { OverviewResponse } from "./types";
import { useVisiblePolling } from "./usePolling";

interface ProjectOverview {
    data: OverviewResponse | null;
    /** The latest request failed; `data` keeps the last successful response. */
    failed: boolean;
    reload: () => Promise<void>;
}

const ProjectOverviewContext = createContext<ProjectOverview | null>(null);

/** One overview poll per project, shared by the Sidebar and the Overview page. */
export function ProjectOverviewProvider({ projectId, children }: { projectId: string; children: React.ReactNode }) {
    const [state, setState] = useState<{ projectId: string; data: OverviewResponse | null; failed: boolean }>({ projectId, data: null, failed: false });
    const generation = useRef(0);

    const specSet = useRef("");

    const reload = useCallback(async () => {
        const current = ++generation.current;
        try {
            const data = await getOverview(projectId);
            if (current !== generation.current) return;
            setState({ projectId, data, failed: false });
            // The agent saves and repairs Specs in the background; refresh the Spec tree when the set changes.
            const specs = `${projectId}:${Object.entries(data.specHealth).map(([id, health]) => `${id}=${health.status}`).sort().join(",")}`;
            if (specSet.current && specSet.current !== specs && specSet.current.startsWith(`${projectId}:`)) invalidate({ resource: "tree", projectId });
            specSet.current = specs;
        } catch {
            if (current === generation.current) setState((previous) => ({ projectId, data: previous.projectId === projectId ? previous.data : null, failed: true }));
        }
    }, [projectId]);

    useEffect(() => {
        void reload();
        return () => {
            generation.current++;
        };
    }, [reload]);

    useVisiblePolling(() => void reload(), 5000);

    useEffect(() => onInvalidate((event) => {
        if (!event.projectId || event.projectId === projectId) void reload();
    }), [projectId, reload]);

    const current = state.projectId === projectId;
    return (
        <ProjectOverviewContext.Provider value={{ data: current ? state.data : null, failed: current && state.failed, reload }}>
            {children}
        </ProjectOverviewContext.Provider>
    );
}

export function useProjectOverview(): ProjectOverview {
    const overview = useContext(ProjectOverviewContext);
    if (!overview) throw new Error("useProjectOverview must be used inside ProjectOverviewProvider");
    return overview;
}
