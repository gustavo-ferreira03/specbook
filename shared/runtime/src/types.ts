export interface HumanSpec {
    preconditions: string[];
    steps: string[];
    expectedResult: string;
    postconditions: string[];
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
