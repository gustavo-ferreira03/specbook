"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { getOverview } from "./api";
import { invalidate, onInvalidate } from "./invalidation";
import type { OverviewResponse, SpecStatus } from "./types";
import { useVisiblePolling } from "./usePolling";

interface ProjectOverview {
    data: OverviewResponse | null;
    failed: boolean;
    reload: () => Promise<void>;
}

const ProjectOverviewContext = createContext<ProjectOverview | null>(null);

export function ProjectOverviewProvider({ projectId, children }: { projectId: string; children: React.ReactNode }) {
    const [state, setState] = useState<{ projectId: string; data: OverviewResponse | null; failed: boolean }>({ projectId, data: null, failed: false });
    const generation = useRef(0);

    const specSet = useRef("");

    const apply = useCallback((data: OverviewResponse) => {
        setState({ projectId, data, failed: false });
        const specs = `${projectId}:${Object.entries(data.specHealth).map(([id, health]) => `${id}=${health.status}`).sort().join(",")}`;
        if (specSet.current && specSet.current !== specs && specSet.current.startsWith(`${projectId}:`)) invalidate({ resource: "tree", projectId });
        specSet.current = specs;
    }, [projectId]);

    const reload = useCallback(async () => {
        const current = ++generation.current;
        try {
            const data = await getOverview(projectId);
            if (current === generation.current) apply(data);
        } catch {
            if (current === generation.current) setState((previous) => ({ projectId, data: previous.projectId === projectId ? previous.data : null, failed: true }));
        }
    }, [projectId, apply]);

    useEffect(() => {
        void reload();
        return () => { generation.current++; };
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

export function useDisplayStatus(spec: { id: string; status: SpecStatus }): SpecStatus | "repairing" {
    const overview = useContext(ProjectOverviewContext);
    return spec.status === "invalid" && overview?.data?.specHealth[spec.id]?.status === "repairing" ? "repairing" : spec.status;
}

export function useProjectOverview(): ProjectOverview {
    const overview = useContext(ProjectOverviewContext);
    if (!overview) throw new Error("useProjectOverview must be used inside ProjectOverviewProvider");
    return overview;
}
