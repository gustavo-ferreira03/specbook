import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { HumanSpec } from "../../db/schema";
import { featuresRepository } from "../../repositories/features";
import { specsRepository } from "../../repositories/specs";
import { executeSpec } from "../runner/robot";
import { namedRobotStepsError } from "../runner/evidence";
import { validateRobotSource } from "../runner/validate";
import { readSpecExecutable, removeSpecExecutable, writeSpecExecutable } from "../specs/files";
import { withSpecLock } from "../specs/lifecycle";

function text(value: string) {
    return {
        content: [{ type: "text" as const, text: value }],
        details: undefined,
        terminate: false,
    };
}

const humanSpecType = Type.Object({
    preconditions: Type.Array(Type.String()),
    steps: Type.Array(Type.String()),
    expectedResult: Type.String(),
    postconditions: Type.Array(Type.String()),
});

export function createDomainTools(projectId: string) {
    return [
        defineTool({
            name: "list_features",
            label: "list_features",
            description: "List all features of the current project with their ids, parent ids, titles and descriptions.",
            parameters: Type.Object({}),
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
            parameters: Type.Object({}),
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
            description: "Read the current human-readable and Robot Framework forms of a Spec before changing it.",
            parameters: Type.Object({ specId: Type.String() }),
            async execute(_id, params) {
                const spec = await specsRepository.getSpec(params.specId);
                if (!spec || spec.projectId !== projectId) return text(`Spec ${params.specId} not found in this project.`);
                if (!spec.currentVersionId) return text(JSON.stringify({ spec, version: null }));
                const version = await specsRepository.getSpecVersion(spec.currentVersionId);
                if (!version) return text(JSON.stringify({ spec, version: null }));
                const robotSource = await readSpecExecutable(version.executablePath);
                return text(
                    JSON.stringify({
                        spec,
                        version: {
                            id: version.id,
                            version: version.version,
                            humanSpec: version.humanSpec,
                            robotSource,
                        },
                    }),
                );
            },
        }),
        defineTool({
            name: "create_feature",
            label: "create_feature",
            description: "Create a feature in the current project's Spec tree. Check list_features first and reuse existing features.",
            parameters: Type.Object({
                parentId: Type.Optional(Type.String()),
                title: Type.String(),
                description: Type.String(),
            }),
            async execute(_id, params) {
                if (params.parentId) {
                    const parent = await featuresRepository.getFeature(params.parentId);
                    if (!parent || parent.projectId !== projectId) {
                        return text(`Parent feature ${params.parentId} not found in this project.`);
                    }
                }
                const feature = await featuresRepository.createFeature(
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
            description: "Create a human-readable Spec and its complete Browser-only Robot Framework executable. The Test Case must call business-readable user keywords, while Browser commands and assertions live inside those keywords.",
            parameters: Type.Object({
                featureId: Type.String(),
                title: Type.String(),
                description: Type.String(),
                humanSpec: humanSpecType,
                robotSource: Type.String(),
            }),
            async execute(_id, params) {
                const feature = await featuresRepository.getFeature(params.featureId);
                if (!feature || feature.projectId !== projectId) {
                    return text(`Feature ${params.featureId} not found in this project.`);
                }
                const stepError = namedRobotStepsError(params.robotSource);
                if (stepError) return text(`The Robot source was rejected: ${stepError}`);
                const validation = await validateRobotSource(params.robotSource);
                if (!validation.ok) {
                    return text(`The Robot source was rejected: ${validation.error}\nFix the file and call create_spec again.`);
                }
                const spec = await specsRepository.createSpecRecord({
                    projectId,
                    featureId: feature.id,
                    title: params.title,
                    description: params.description,
                });
                let executablePath: string | null = null;
                let versionId: string | null = null;
                try {
                    const file = await writeSpecExecutable(spec.id, 1, params.robotSource);
                    executablePath = file.executablePath;
                    const version = await specsRepository.addSpecVersion({
                        specId: spec.id,
                        version: 1,
                        humanSpec: params.humanSpec as HumanSpec,
                        executablePath: file.executablePath,
                        executableHash: file.executableHash,
                    });
                    versionId = version.id;
                    await specsRepository.publishSpecVersion(spec.id, version.id);
                    return text(JSON.stringify({ specId: spec.id, version: 1 }));
                } catch (error) {
                    if (versionId) await specsRepository.deleteSpecVersion(versionId).catch(() => undefined);
                    if (executablePath) await removeSpecExecutable(executablePath).catch(() => undefined);
                    await specsRepository.deleteSpecRecord(spec.id).catch(() => undefined);
                    throw error;
                }
            },
        }),
        defineTool({
            name: "update_spec",
            label: "update_spec",
            description: "Create a new immutable version of a Spec. Call get_spec first. Omitted fields keep their current values, and the status resets to unverified.",
            parameters: Type.Object({
                specId: Type.String(),
                title: Type.Optional(Type.String()),
                description: Type.Optional(Type.String()),
                humanSpec: Type.Optional(humanSpecType),
                robotSource: Type.Optional(Type.String()),
            }),
            async execute(_id, params) {
                return withSpecLock(params.specId, async () => {
                    const spec = await specsRepository.getSpec(params.specId);
                    if (!spec || spec.projectId !== projectId) {
                        return text(`Spec ${params.specId} not found in this project.`);
                    }
                    if (!spec.currentVersionId) return text(`Spec ${params.specId} has no version to update.`);
                    const currentVersion = await specsRepository.getSpecVersion(spec.currentVersionId);
                    if (!currentVersion) return text(`Spec ${params.specId} has no current version to update.`);
                    const humanSpec = (params.humanSpec as HumanSpec | undefined) ?? currentVersion.humanSpec;
                    const robotSource = params.robotSource ?? (await readSpecExecutable(currentVersion.executablePath));
                    if (params.robotSource !== undefined) {
                        const stepError = namedRobotStepsError(robotSource);
                        if (stepError) return text(`The Robot source was rejected: ${stepError}`);
                    }
                    const validation = await validateRobotSource(robotSource);
                    if (!validation.ok) {
                        return text(`The Robot source was rejected: ${validation.error}\nFix the file and call update_spec again.`);
                    }
                    const nextVersion = (await specsRepository.latestVersionNumber(spec.id)) + 1;
                    let executablePath: string | null = null;
                    let versionId: string | null = null;
                    try {
                        const file = await writeSpecExecutable(spec.id, nextVersion, robotSource);
                        executablePath = file.executablePath;
                        const version = await specsRepository.addSpecVersion({
                            specId: spec.id,
                            version: nextVersion,
                            humanSpec,
                            executablePath: file.executablePath,
                            executableHash: file.executableHash,
                        });
                        versionId = version.id;
                        await specsRepository.publishSpecVersion(spec.id, version.id, {
                            title: params.title,
                            description: params.description,
                        });
                        return text(JSON.stringify({ specId: spec.id, version: nextVersion }));
                    } catch (error) {
                        if (versionId) await specsRepository.deleteSpecVersion(versionId).catch(() => undefined);
                        if (executablePath) await removeSpecExecutable(executablePath).catch(() => undefined);
                        throw error;
                    }
                });
            },
        }),
        defineTool({
            name: "run_spec",
            label: "run_spec",
            description: "Execute a Spec through Robot Framework and return its status, duration and failure reason.",
            parameters: Type.Object({ specId: Type.String() }),
            async execute(_id, params) {
                const spec = await specsRepository.getSpec(params.specId);
                if (!spec || spec.projectId !== projectId) {
                    return text(`Spec ${params.specId} not found in this project.`);
                }
                try {
                    const run = await executeSpec(spec.id, { persistFailures: false });
                    return text(
                        JSON.stringify({
                            runId: run.id,
                            status: run.status,
                            durationMs: run.durationMs,
                            failReason: run.failReason,
                        }),
                    );
                } catch (error) {
                    return text(`run_spec failed: ${error instanceof Error ? error.message : String(error)}`);
                }
            },
        }),
    ];
}
