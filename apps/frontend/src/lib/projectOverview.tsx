"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { getOverview, overviewEventsUrl } from "./api";
import { invalidate, onInvalidate } from "./invalidation";
import type { OverviewResponse, SpecStatus } from "./types";

interface ProjectOverview {
    data: OverviewResponse | null;
    /** The latest request failed; `data` keeps the last successful response. */
    failed: boolean;
    reload: () => Promise<void>;
}

const ProjectOverviewContext = createContext<ProjectOverview | null>(null);

/** One overview subscription per project, shared by the Sidebar and the Overview page. */
export function ProjectOverviewProvider({ projectId, children }: { projectId: string; children: React.ReactNode }) {
    const [state, setState] = useState<{ projectId: string; data: OverviewResponse | null; failed: boolean }>({ projectId, data: null, failed: false });
    const generation = useRef(0);

    const specSet = useRef("");

    const apply = useCallback((data: OverviewResponse) => {
        setState({ projectId, data, failed: false });
        // The agent saves and repairs Specs in the background; refresh the Spec tree when the set changes.
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

    // The server pushes the overview whenever it changes; polling covers the gaps while the stream is down.
    useEffect(() => {
        let source: EventSource | null = null;
        let live = false;
        const open = () => {
            if (source || document.hidden) return;
            const current = new EventSource(overviewEventsUrl(projectId));
            source = current;
            current.addEventListener("overview", (event) => {
                live = true;
                generation.current++;
                apply(JSON.parse((event as MessageEvent<string>).data) as OverviewResponse);
            });
            current.onerror = () => {
                live = false;
                if (current.readyState === EventSource.CLOSED && source === current) source = null;
                void reload();
            };
        };
        const close = () => {
            source?.close();
            source = null;
            live = false;
        };
        const handleVisibility = () => document.hidden ? close() : open();
        const fallback = window.setInterval(() => {
            if (document.hidden || live) return;
            void reload();
            open();
        }, 5000);
        if (document.hidden) void reload();
        open();
        document.addEventListener("visibilitychange", handleVisibility);
        return () => {
            close();
            window.clearInterval(fallback);
            document.removeEventListener("visibilitychange", handleVisibility);
            generation.current++;
        };
    }, [projectId, apply, reload]);

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

/** Status to show for a Spec: "repairing" while the agent fixes a broken one, otherwise its own status. */
export function useDisplayStatus(spec: { id: string; status: SpecStatus }): SpecStatus | "repairing" {
    const overview = useContext(ProjectOverviewContext);
    return spec.status === "invalid" && overview?.data?.specHealth[spec.id]?.status === "repairing" ? "repairing" : spec.status;
}

export function useProjectOverview(): ProjectOverview {
    const overview = useContext(ProjectOverviewContext);
    if (!overview) throw new Error("useProjectOverview must be used inside ProjectOverviewProvider");
    return overview;
}
