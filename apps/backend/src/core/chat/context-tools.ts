import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { z } from "zod";
import type { ProjectContext } from "../../infra/db/schema";
import { projectContextsRepository } from "../../infra/repositories/project-contexts";

export const projectContextSchema = z.object({
    summary: z.string(),
    areas: z.array(
        z.object({
            name: z.string(),
            routes: z.array(z.string()),
            description: z.string(),
        }),
    ),
    terminology: z.array(z.object({ term: z.string(), meaning: z.string() })),
    roles: z.array(z.object({ name: z.string(), capabilities: z.array(z.string()) })),
    businessRules: z.array(z.string()),
    uiPatterns: z.array(z.string()),
    executionNotes: z.array(z.string()),
    unknowns: z.array(z.string()),
    sources: z.array(z.object({ url: z.string(), note: z.string() })),
});

export const projectContextJsonSchema = projectContextSchema.toJSONSchema();

const projectContextType = Type.Unsafe(projectContextJsonSchema);

function text(value: string) {
    return {
        content: [{ type: "text" as const, text: value }],
        details: undefined,
        terminate: false,
    };
}

export function createContextTools(revisionId: string, projectId: string) {
    return [
        defineTool({
            name: "get_project_context_draft",
            label: "get_project_context_draft",
            description:
                "Read the current project-context draft for this discovery, including the brief, the saved context, and the action usage.",
            parameters: Type.Object({}),
            async execute() {
                const revision = await projectContextsRepository.getProjectContextRevision(revisionId);
                if (!revision) return text("The discovery draft for this chat no longer exists.");
                return text(
                    JSON.stringify({
                        revisionId: revision.id,
                        status: revision.status,
                        brief: revision.brief,
                        context: revision.context,
                        actionsUsed: revision.actionsUsed,
                    }),
                );
            },
        }),
        defineTool({
            name: "propose_project_context",
            label: "propose_project_context",
            description:
                "Save the complete structured project context as the draft for this discovery. Provide every field; the whole draft content is replaced. The user reviews and confirms it later; this tool never confirms.",
            parameters: Type.Object({ context: projectContextType }),
            async execute(_id, params) {
                const parsed = projectContextSchema.safeParse(params.context);
                if (!parsed.success) {
                    return text(`The proposed context is invalid: ${parsed.error.issues[0]?.message ?? "schema mismatch"}. Provide the complete ProjectContext object.`);
                }
                const revision = await projectContextsRepository.getProjectContextRevision(revisionId);
                if (!revision) return text("The discovery draft for this chat no longer exists.");
                if (revision.status !== "draft") {
                    return text(`This context revision is already ${revision.status} and can no longer be changed from this chat.`);
                }
                const updated = await projectContextsRepository.replaceProjectContextDraft(
                    revisionId,
                    parsed.data as ProjectContext,
                );
                return text(
                    JSON.stringify({
                        revisionId: updated?.id ?? revisionId,
                        status: updated?.status ?? "draft",
                        reviewPath: `/p/${projectId}`,
                        message: "Draft saved. Ask the user to review and confirm it on the project overview page.",
                    }),
                );
            },
        }),
    ];
}
