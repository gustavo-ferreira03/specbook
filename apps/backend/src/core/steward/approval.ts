import { parse } from "@babel/parser";
import { jobsRepository, type InboxItem } from "../../infra/repositories/jobs";
import { applyProposal } from "../jobs/proposals";
import { fixProposalSchema } from "../jobs/schemas";
import { isAgentPaused } from "../jobs/pause";

/** Only selector literals may differ. No new calls, behavior, input values or assertions. */
export function isLocatorOnlyFix(item: InboxItem): boolean {
    if (item.kind !== "spec_fix" || !item.payload.requiresVerification) return false;
    const patch = fixProposalSchema.safeParse(item.payload.params);
    const before = item.payload.before as { testSource?: unknown } | undefined;
    if (!patch.success || !patch.data.testSource || patch.data.humanSpec || patch.data.title !== undefined || patch.data.description !== undefined || typeof before?.testSource !== "string") return false;
    const normalize = (source: string) => {
        const ast = parse(source, { sourceType: "module", plugins: ["typescript"] });
        const visit = (node: unknown): unknown => {
            if (Array.isArray(node)) return node.map(visit);
            if (!node || typeof node !== "object") return node;
            const entry = node as Record<string, any>;
            if (entry.type === "CallExpression" && entry.callee?.type === "MemberExpression" && !entry.callee.computed
                && ["locator", "getByLabel", "getByTestId", "getByPlaceholder"].includes(entry.callee.property?.name)
                && entry.arguments?.length === 1 && entry.arguments[0]?.type === "StringLiteral") {
                entry.arguments[0].value = "selector";
            }
            return Object.fromEntries(Object.entries(entry).filter(([key]) => !["start", "end", "loc", "extra", "comments", "leadingComments", "trailingComments", "innerComments"].includes(key)).map(([key, value]) => [key, visit(value)]));
        };
        return JSON.stringify(visit(ast));
    };
    try { return before.testSource !== patch.data.testSource && normalize(before.testSource) === normalize(patch.data.testSource); }
    catch { return false; }
}

export async function applyTrustedFixes(projectId: string): Promise<void> {
    const items = await jobsRepository.inbox(projectId);
    const trusted = items.filter((item) => item.status === "approved" && isLocatorOnlyFix(item));
    if (trusted.length < 3 || items.some((item) => item.status === "rejected" && isLocatorOnlyFix(item))) return;
    for (const item of items.filter((item) => item.status === "pending" && isLocatorOnlyFix(item))) {
        if (await isAgentPaused(projectId)) return;
        const verification = item.payload.verification as { status?: string } | undefined;
        const job = await jobsRepository.get(item.jobId);
        if (verification?.status !== "passed" || job?.status !== "completed" || job.classification !== "test_drift") continue;
        if (!await jobsRepository.claimItem(item.id)) continue;
        try {
            if (await isAgentPaused(projectId)) { await jobsRepository.updateItem(item.id, { status: "pending" }); return; }
            const commitSha = await applyProposal(item);
            await jobsRepository.updateItem(item.id, { status: "approved", commitSha });
            await jobsRepository.log(item.jobId, "auto_approved", "Act policy: verified selector-only change after three human-approved locator fixes.");
        } catch (error) {
            await jobsRepository.updateItem(item.id, { status: "pending" });
            await jobsRepository.log(item.jobId, "auto_approval_skipped", "The proposal could not be applied; human review is still available.");
        }
    }
}
