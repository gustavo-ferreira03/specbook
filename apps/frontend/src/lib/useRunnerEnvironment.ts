"use client";

import { useEffect, useState } from "react";
import { getEnvironments } from "./api";
import { matchesInvalidation, onInvalidate } from "./invalidation";

export function useRunnerEnvironment(projectId: string): boolean {
    const [runner, setRunner] = useState(false);
    const [revision, setRevision] = useState(0);
    useEffect(() => {
        const controller = new AbortController();
        getEnvironments(projectId, controller.signal).then(({ environments }) => {
            setRunner(environments.some((environment) => environment.name === "Production" && environment.executor === "runner"));
        }).catch(() => undefined);
        return () => controller.abort();
    }, [projectId, revision]);
    useEffect(() => onInvalidate((event) => {
        if (matchesInvalidation(event, "projects", projectId)) setRevision((value) => value + 1);
    }), [projectId]);
    return runner;
}
