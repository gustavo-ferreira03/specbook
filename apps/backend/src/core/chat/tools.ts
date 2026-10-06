import { z } from "zod";
import { featureProposalSchema, newSpecProposalSchema, fixProposalSchema } from "../jobs/schemas";
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { HumanSpec, RunEnvironment } from "../../infra/db/schema";
import { featuresRepository } from "../../infra/repositories/features";
import { specsRepository } from "../../infra/repositories/specs";
import { readSpecRawFiles } from "../repo/manual";
import { createFeatureInRepo, createSpecInRepo, updateSpecInRepo } from "../repo/writer";
import { parseSpecYaml } from "../repo/yaml";
import { executeSpec } from "../runner/run";
import { analyzeSpecSource, stepTitlesError } from "../runner/validate";
import { withSpecLock } from "../specs/lifecycle";
import { createProjectScrubber } from "../credentials/scrub";
import type { TurnMetricsRecorder, ValidatorRejection } from "./metrics";

const RUN_SPEC_FAIL_REASON_LIMIT = 2000;

function text(value: string) {
    return {
        content: [{ type: "text" as const, text: value }],
        details: undefined,
        terminate: false,
    };
}

function truncate(value: string, limit: number): string {
    return value.length > limit ? `${value.slice(0, limit)}... (truncated)` : value;
}

/** The failed step title is not stored in the Run row; executeSpec returns it in memory. */
function failedStepOf(run: object): string | null {
    const { failedStep } = run as { failedStep?: unknown };
    return typeof failedStep === "string" && failedStep.trim() ? failedStep.trim() : null;
}

/**
 * The tools validate spec.ts themselves so they can report the rejection (with the
 * line and the rule) to the agent instead of storing an invalid Spec.
 */
function sourceRejection(testSource: string, steps: string[]): { rule: ValidatorRejection["rule"]; error: string } | null {
    const analysis = analyzeSpecSource(testSource);
    if (!analysis.ok) return { rule: "source_validation", error: analysis.error };
    const stepsError = stepTitlesError(analysis.analysis.steps, steps);
    return stepsError ? { rule: "named_steps", error: stepsError } : null;
}

function rejectionText(tool: string, error: string): string {
    return `The spec.ts source was rejected: ${error}\nOnly the Playwright subset described in your Playwright rules is allowed. Fix the file and call ${tool} again.`;
}

export interface DomainToolOptions {
    baseUrl?: string;
    environment?: RunEnvironment;
    scrub?: (value: string) => Promise<string>;
    metrics?: TurnMetricsRecorder;
}

export function createDomainTools(projectId: string, options: DomainToolOptions = {}) {
    const scrub = options.scrub ?? createProjectScrubber(projectId);
    const metrics = options.metrics;
    return [
        defineTool({
            name: "list_features",
            label: "list_features",
            description: "List all features of the current project with their ids, parent ids, titles and descriptions.",
            parameters: Type.Unsafe(z.object({}).toJSONSchema()),
            async execute() {
                const rows = await featuresRepository.listFeatures(projectId);
                return text(
                    JSON.stringify(
                        rows.map((feature) => ({
                            id: feature.id,
                            parentId: feature.parentId,
                            title: feature.title,
                            description: feature.description,
                        })),
                    ),
                );
            },
        }),
        defineTool({
            name: "list_specs",
            label: "list_specs",
            description: "List all specs of the current project with id, featureId, title, description and status.",
            parameters: Type.Unsafe(z.object({}).toJSONSchema()),
            async execute() {
                const rows = await specsRepository.listSpecs(projectId);
                return text(
                    JSON.stringify(
                        rows.map((spec) => ({
                            id: spec.id,
                            featureId: spec.featureId,
                            title: spec.title,
                            description: spec.description,
                            status: spec.status,
                        })),
                    ),
                );
            },
        }),
        defineTool({
            name: "get_spec",
            label: "get_spec",
            description: "Read the current human-readable form (humanSpec) and the Playwright executable (testSource, the spec.ts file) of a Spec before changing it.",
            parameters: Type.Unsafe<{ specId: string }>(z.object({ specId: z.string() }).toJSONSchema()),
            async execute(_id, params) {
                const spec = await specsRepository.getSpec(params.specId);
                if (!spec || spec.projectId !== projectId) return text(`Spec ${params.specId} not found in this project.`);
                try {
                    const raw = await readSpecRawFiles(spec);
                    const humanSpec = raw.yaml === null ? null : parseSpecYaml(raw.yaml).humanSpec;
                    return text(JSON.stringify({ spec, humanSpec, testSource: raw.testSource }));
                } catch (error) {
                    return text(JSON.stringify({ spec, error: error instanceof Error ? error.message : String(error) }));
                }
            },
        }),
        defineTool({
            name: "create_feature",
            label: "create_feature",
            description: "Create a feature in the current project's Spec tree. Check list_features first and reuse existing features.",
            parameters: Type.Unsafe<z.infer<typeof featureProposalSchema>>(featureProposalSchema.toJSONSchema()),
            async execute(_id, params) {
                if (params.parentId) {
                    const parent = await featuresRepository.getFeature(params.parentId);
                    if (!parent || parent.projectId !== projectId) {
                        return text(`Parent feature ${params.parentId} not found in this project.`);
                    }
                }
                const feature = await createFeatureInRepo(
                    projectId,
                    params.parentId ?? null,
                    params.title,
                    params.description,
                );
                return text(JSON.stringify({ id: feature.id, title: feature.title }));
            },
        }),
        defineTool({
            name: "create_spec",
            label: "create_spec",
            description: "Create a human-readable Spec and its executable spec.ts (testSource), written in the restricted Playwright Test subset of your Playwright rules. spec.ts must contain one test() whose step() titles are exactly humanSpec.steps, in order.",
            parameters: Type.Unsafe<z.infer<typeof newSpecProposalSchema>>(newSpecProposalSchema.toJSONSchema()),
            async execute(_id, params) {
                const feature = await featuresRepository.getFeature(params.featureId);
                if (!feature || feature.projectId !== projectId) {
                    return text(`Feature ${params.featureId} not found in this project.`);
                }
                const rejection = sourceRejection(params.testSource, (params.humanSpec as HumanSpec).steps);
                if (rejection) {
                    metrics?.validatorRejection({ tool: "create_spec", specId: null, rule: rejection.rule });
                    return text(rejectionText("create_spec", rejection.error));
                }
                const { spec } = await createSpecInRepo({
                    projectId,
                    featureId: feature.id,
                    title: params.title,
                    description: params.description,
                    humanSpec: params.humanSpec as HumanSpec,
                    testSource: params.testSource,
                });
                return text(JSON.stringify({ specId: spec.id }));
            },
        }),
        defineTool({
            name: "update_spec",
            label: "update_spec",
            description: "Update a Spec and commit the change to its git history. Call get_spec first. Omitted fields keep their current values, and the status resets to unverified. When humanSpec.steps change, send the matching testSource too: step() titles must equal humanSpec.steps.",
            parameters: Type.Unsafe<z.infer<typeof fixProposalSchema>>(fixProposalSchema.toJSONSchema()),
            async execute(_id, params) {
                return withSpecLock(params.specId, async () => {
                    const spec = await specsRepository.getSpec(params.specId);
                    if (!spec || spec.projectId !== projectId) {
                        return text(`Spec ${params.specId} not found in this project.`);
                    }
                    const raw = await readSpecRawFiles(spec);
                    const testSource = params.testSource ?? raw.testSource;
                    if (testSource === null) {
                        return text(`Spec ${params.specId} has no spec.ts; send the complete file as testSource.`);
                    }
                    const humanSpec = (params.humanSpec as HumanSpec | undefined) ?? (raw.yaml === null ? null : parseSpecYaml(raw.yaml).humanSpec);
                    const rejection = sourceRejection(testSource, humanSpec?.steps ?? []);
                    if (rejection) {
                        metrics?.validatorRejection({ tool: "update_spec", specId: spec.id, rule: rejection.rule });
                        return text(rejectionText("update_spec", rejection.error));
                    }
                    const { spec: updated } = await updateSpecInRepo(spec, {
                        title: params.title,
                        description: params.description,
                        humanSpec: params.humanSpec as HumanSpec | undefined,
                        testSource: params.testSource,
                    });
                    return text(JSON.stringify({ specId: updated.id, path: updated.path }));
                });
            },
        }),
        defineTool({
            name: "run_spec",
            label: "run_spec",
            description: "Execute a Spec's spec.ts with Playwright Test (headless Chromium) and return its runId, status, duration, failure reason and failed step title (when known).",
            parameters: Type.Unsafe<{ specId: string }>(z.object({ specId: z.string() }).toJSONSchema()),
            async execute(_id, params, signal) {
                const spec = await specsRepository.getSpec(params.specId);
                if (!spec || spec.projectId !== projectId) {
                    return text(`Spec ${params.specId} not found in this project.`);
                }
                try {
                    const run = await executeSpec(spec.id, { persistFailures: false, baseUrl: options.baseUrl, environment: options.environment, signal });
                    metrics?.runSpecOutcome({
                        specId: spec.id,
                        runId: run.id,
                        status: run.status,
                        durationMs: run.durationMs,
                    });
                    const failedStep = failedStepOf(run);
                    return text(
                        JSON.stringify({
                            runId: run.id,
                            specId: spec.id,
                            status: run.status,
                            durationMs: run.durationMs,
                            failReason: run.failReason
                                ? truncate(await scrub(run.failReason), RUN_SPEC_FAIL_REASON_LIMIT)
                                : null,
                            failedStep: failedStep ? truncate(await scrub(failedStep), 200) : null,
                            persisted: run.status === "passed",
                        }),
                    );
                } catch (error) {
                    metrics?.runSpecOutcome({ specId: spec.id, runId: null, status: "not_started", durationMs: null });
                    const message = error instanceof Error ? error.message : String(error);
                    return text(`run_spec failed: ${truncate(await scrub(message), RUN_SPEC_FAIL_REASON_LIMIT)}`);
                }
            },
        }),
    ];
}
