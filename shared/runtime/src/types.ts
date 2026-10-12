export interface HumanSpec {
    preconditions: string[];
    steps: string[];
    expectedResult: string;
    postconditions: string[];
}

export type ExecutionStepKind = "precondition" | "step" | "expected" | "postcondition";

// spec.ts runs one step() per precondition (set up and check that state), one per step, one that proves the expected result, then one per postcondition (clean up and check).
export function executionPlan(human: HumanSpec): { title: string; kind: ExecutionStepKind; ordinal: number | null }[] {
    const plan: { title: string; kind: ExecutionStepKind }[] = [
        ...human.preconditions.map((title) => ({ title, kind: "precondition" as const })),
        ...human.steps.map((title) => ({ title, kind: "step" as const })),
        { title: human.expectedResult, kind: "expected" as const },
        ...human.postconditions.map((title) => ({ title, kind: "postcondition" as const })),
    ].map((entry) => ({ ...entry, title: entry.title.trim() })).filter((entry) => entry.title);
    let ordinal = 0;
    return plan.map((entry) => ({ ...entry, ordinal: entry.kind === "step" ? ++ordinal : null }));
}

export function executionSteps(human: HumanSpec): string[] {
    return executionPlan(human).map((entry) => entry.title);
}

export type RunStatus = "running" | "passed" | "failed" | "error";

export interface ProjectContext {
    summary: string;
    areas: { name: string; routes: string[]; description: string }[];
    terminology: { term: string; meaning: string }[];
    roles: { name: string; capabilities: string[] }[];
    businessRules: string[];
    uiPatterns: string[];
    executionNotes: string[];
    unknowns: string[];
    sources: { url: string; note: string }[];
}

export const EMPTY_PROJECT_CONTEXT: ProjectContext = {
    summary: "",
    areas: [],
    terminology: [],
    roles: [],
    businessRules: [],
    uiPatterns: [],
    executionNotes: [],
    unknowns: [],
    sources: [],
};
