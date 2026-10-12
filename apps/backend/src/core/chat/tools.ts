import { z } from "zod";
import { featureProposalSchema, newSpecProposalSchema, fixProposalSchema } from "../jobs/schemas";
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { HumanSpec, RunEnvironment } from "../../infra/db/schema";
import { featuresRepository } from "../../infra/repositories/features";
import { specsRepository } from "../../infra/repositories/specs";
import { readSpecRawFiles } from "../repo/manual";
import { createFeatureInRepo, createSpecInRepo, updateSpecInRepo } from "../repo/writer";
import { parseSpecYaml } from "@specbook/runtime/yaml";
import { executeSpec } from "../runner/run";
import { reviewNextStep, reviewRunEvidence } from "../runner/evidence-review";
import { runsDir } from "../paths";
import path from "node:path";
import { analyzeSpecSource, stepTitlesError } from "@specbook/runtime/validate";
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

function failedStepOf(run: object): string | null {
    const { failedStep } = run as { failedStep?: unknown };
    return typeof failedStep === "string" && failedStep.trim() ? failedStep.trim() : null;
}

function sourceRejection(testSource: string, humanSpec: HumanSpec): { rule: ValidatorRejection["rule"]; error: string } | null {
    const analysis = analyzeSpecSource(testSource);
    if (!analysis.ok) return { rule: "source_validation", error: analysis.error };
    const stepsError = stepTitlesError(analysis.analysis.steps, humanSpec);
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
            description: "List the project's features: id, parent id, title, description.",
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
            description: "List the project's Specs: id, featureId, title, description, status.",
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
            description: "Read a Spec's contract (humanSpec) and spec.ts (testSource). Call before changing it.",
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
            description: "Create a feature. Name it exactly after its project context area; reuse an existing one from list_features.",
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
            description: "Create a Spec: its contract (humanSpec) and spec.ts (testSource) under a feature. spec.ts must pass the validator and its step() titles must follow the contract.",
            parameters: Type.Unsafe<z.infer<typeof newSpecProposalSchema>>(newSpecProposalSchema.toJSONSchema()),
            async execute(_id, params) {
                const feature = await featuresRepository.getFeature(params.featureId);
                if (!feature || feature.projectId !== projectId) {
                    return text(`Feature ${params.featureId} not found in this project.`);
                }
                const rejection = sourceRejection(params.testSource, params.humanSpec);
                if (rejection) {
                    metrics?.validatorRejection({ tool: "create_spec", specId: null, rule: rejection.rule });
                    return text(rejectionText("create_spec", rejection.error));
                }
                const { spec } = await createSpecInRepo({
                    projectId,
                    featureId: feature.id,
                    title: params.title,
                    description: params.description,
                    humanSpec: params.humanSpec,
                    testSource: params.testSource,
                });
                return text(JSON.stringify({ specId: spec.id }));
            },
        }),
        defineTool({
            name: "update_spec",
            label: "update_spec",
            description: "Update a Spec and commit it. Call get_spec first. Omitted fields keep their values; the status resets to unverified. Send the matching testSource whenever the contract changes.",
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
                    const humanSpec = params.humanSpec ?? (raw.yaml === null ? null : parseSpecYaml(raw.yaml).humanSpec);
                    const rejection = sourceRejection(testSource, humanSpec ?? { preconditions: [], steps: [], expectedResult: "", postconditions: [] });
                    if (rejection) {
                        metrics?.validatorRejection({ tool: "update_spec", specId: spec.id, rule: rejection.rule });
                        return text(rejectionText("update_spec", rejection.error));
                    }
                    const { spec: updated } = await updateSpecInRepo(spec, {
                        title: params.title,
                        description: params.description,
                        humanSpec: params.humanSpec,
                        testSource: params.testSource,
                    });
                    return text(JSON.stringify({ specId: updated.id, path: updated.path }));
                });
            },
        }),
        defineTool({
            name: "run_spec",
            label: "run_spec",
            description: "Run a Spec in a fresh headless browser. Returns runId, status, duration, failReason, failedStep and evidenceReview.",
            parameters: Type.Unsafe<{ specId: string }>(z.object({ specId: z.string() }).toJSONSchema()),
            async execute(_id, params, signal) {
                const spec = await specsRepository.getSpec(params.specId);
                if (!spec || spec.projectId !== projectId) {
                    return text(`Spec ${params.specId} not found in this project.`);
                }
                try {
                    const run = await executeSpec(spec.id, { baseUrl: options.baseUrl, environment: options.environment, signal });
                    metrics?.runSpecOutcome({
                        specId: spec.id,
                        runId: run.id,
                        status: run.status,
                        durationMs: run.durationMs,
                    });
                    const failedStep = failedStepOf(run);
                    const failReason = run.failReason ? truncate(await scrub(run.failReason), RUN_SPEC_FAIL_REASON_LIMIT) : null;
                    const evidenceReview = await reviewRunEvidence(path.join(runsDir, run.id), { status: run.status, failReason, failedStep });
                    return text(
                        JSON.stringify({
                            runId: run.id,
                            specId: spec.id,
                            status: run.status,
                            durationMs: run.durationMs,
                            failReason,
                            failedStep: failedStep ? truncate(await scrub(failedStep), 200) : null,
                            evidenceReview,
                            nextStep: (() => { const next = reviewNextStep(evidenceReview); return next && `${next} Then update the Spec and run it again.`; })(),
                            persisted: true,
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
