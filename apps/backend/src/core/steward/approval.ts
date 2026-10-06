import { getSecuritySettings } from "../chat/safety-settings";
import { parse } from "@babel/parser";
import { jobsRepository, type InboxItem } from "../../infra/repositories/jobs";
import { stewardRepository } from "../../infra/repositories/steward";
import { applyProposal } from "../jobs/proposals";
import { fixProposalSchema } from "../jobs/schemas";
import { isAgentPaused } from "../jobs/pause";
import { recordAgentMetric } from "../jobs/metrics";
import { LOCATOR_ACTIONS, LOCATOR_FACTORIES } from "../runner/validate";

/** Only direct action selectors may differ; assertion targets and shared aliases stay exact. */
export function isLocatorOnlyFix(item: InboxItem): boolean {
    if (item.kind !== "spec_fix" || !item.payload.requiresVerification) return false;
    const patch = fixProposalSchema.safeParse(item.payload.params);
    const before = item.payload.before as { testSource?: unknown } | undefined;
    if (!patch.success || !patch.data.testSource || patch.data.humanSpec || patch.data.title !== undefined || patch.data.description !== undefined || typeof before?.testSource !== "string") return false;
    const normalize = (source: string) => {
        const ast = parse(source, { sourceType: "module", plugins: ["typescript"] });
        const normalizeAction = (call: Record<string, any>) => {
            if (call.type !== "CallExpression" || call.callee?.type !== "MemberExpression" || call.callee.computed
                || !LOCATOR_ACTIONS.includes(call.callee.property?.name)) return;
            const selectors: Record<string, any>[] = [];
            let target = call.callee.object;
            while (target?.type === "CallExpression" && target.callee?.type === "MemberExpression" && !target.callee.computed) {
                const method = target.callee.property?.name;
                if (![...LOCATOR_FACTORIES, "first", "last", "nth"].includes(method)) return;
                if (["locator", "getByLabel", "getByTestId", "getByPlaceholder"].includes(method)
                    && target.arguments.length === 1 && target.arguments[0]?.type === "StringLiteral") selectors.push(target.arguments[0]);
                target = target.callee.object;
            }
            if (target?.type === "Identifier" && target.name === "page") for (const selector of selectors) selector.value = "selector";
        };
        const visit = (node: unknown, inAssertion = false): unknown => {
            if (Array.isArray(node)) return node.map((value) => visit(value, inAssertion));
            if (!node || typeof node !== "object") return node;
            const entry = node as Record<string, any>;
            const assertion = inAssertion || entry.type === "CallExpression" && (entry.callee?.type === "Identifier" && entry.callee.name === "expect"
                || entry.callee?.type === "MemberExpression" && entry.callee.object?.type === "Identifier" && entry.callee.object.name === "expect");
            if (entry.type === "AwaitExpression" && !assertion) normalizeAction(entry.argument);
            return Object.fromEntries(Object.entries(entry).filter(([key]) => !["start", "end", "loc", "extra", "comments", "leadingComments", "trailingComments", "innerComments"].includes(key)).map(([key, value]) => [key, visit(value, assertion)]));
        };
        return JSON.stringify(visit(ast));
    };
    try { return before.testSource !== patch.data.testSource && normalize(before.testSource) === normalize(patch.data.testSource); }
    catch { return false; }
}

/**
 * A repair the agent may save on its own: it changes only spec.ts (the behavior contract in spec.yml is
 * untouched), it passed a test run, and it cannot hide a real bug — either the Spec had no working
 * implementation to weaken, or a healer fix kept every assertion and only moved action locators.
 */
export async function isSelfApprovableRepair(item: InboxItem): Promise<boolean> {
    if (item.kind !== "spec_fix" || item.status !== "pending" || !item.payload.requiresVerification) return false;
    if ((item.payload.verification as { status?: string } | undefined)?.status !== "passed") return false;
    const patch = fixProposalSchema.safeParse(item.payload.params);
    if (!patch.success || !patch.data.testSource || patch.data.humanSpec || patch.data.title !== undefined || patch.data.description !== undefined) return false;
    const job = await jobsRepository.get(item.jobId);
    if (job?.kind === "regenerate") return true;
    return job?.kind === "failure_triage" && job.classification === "test_drift" && isLocatorOnlyFix(item);
}

/**
 * Saves verified implementation-only repairs so the agent never waits on a human for them. Only the newest
 * proposal per Spec is applied; older pending ones for the same Spec are superseded.
 */
export async function applyVerifiedRepairs(projectId: string): Promise<void> {
    if (await isAgentPaused(projectId) || (await stewardRepository.get(projectId)).autonomy === "observe") return;
    const pending = (await jobsRepository.inbox(projectId)).filter((item) => item.kind === "spec_fix" && item.status === "pending");
    const newestBySpec = new Map<string, InboxItem>();
    for (const item of [...pending].sort((a, b) => b.createdAt.localeCompare(a.createdAt))) {
        const specId = fixProposalSchema.safeParse(item.payload.params).data?.specId;
        if (!specId) continue;
        if (!newestBySpec.has(specId)) { newestBySpec.set(specId, item); continue; }
        await jobsRepository.updateItem(item.id, { status: "dismissed", payload: { ...item.payload, supersededBy: newestBySpec.get(specId)!.id } });
    }
    for (const item of newestBySpec.values()) {
        if (!await isSelfApprovableRepair(item) || !await jobsRepository.claimItem(item.id)) continue;
        const job = await jobsRepository.get(item.jobId);
        try {
            const commitSha = await applyProposal(item, async () => { if (await isAgentPaused(projectId)) throw new Error("The agent was paused"); });
            await jobsRepository.updateItem(item.id, { status: "approved", commitSha, payload: { ...item.payload, appliedBy: "agent" } });
            if (job) await recordAgentMetric(job, "decision", { itemId: item.id, itemKind: item.kind, decision: "approve", actor: "agent" });
            await jobsRepository.log(item.jobId, "auto_approved", "Verified implementation-only repair; the behavior contract is unchanged.");
        } catch {
            // Stale base or a concurrent edit: leave it for the next pass or for a human.
            await jobsRepository.updateItem(item.id, { status: "pending" });
        }
    }
}

export async function applyTrustedFixes(projectId: string): Promise<void> {
    const permitted = async () => {
        const settings = await stewardRepository.get(projectId);
        return (await getSecuritySettings()).allowAutoApproveFixes && settings.autonomy === "act" && settings.autoApproveFixes && !await isAgentPaused(projectId);
    };
    if (!await permitted()) return;
    const items = await jobsRepository.inbox(projectId);
    const trusted = items.filter((item) => item.status === "approved" && isLocatorOnlyFix(item));
    if (trusted.length < 3 || items.some((item) => item.status === "rejected" && isLocatorOnlyFix(item))) return;
    for (const item of items.filter((item) => item.status === "pending" && isLocatorOnlyFix(item))) {
        if (!await permitted()) return;
        const verification = item.payload.verification as { status?: string } | undefined;
        const job = await jobsRepository.get(item.jobId);
        if (verification?.status !== "passed" || job?.status !== "completed" || job.classification !== "test_drift") continue;
        if (!await jobsRepository.claimItem(item.id)) continue;
        try {
            const checkPolicy = async () => { if (!await permitted()) throw new Error("Automatic approval is disabled or paused"); };
            await checkPolicy();
            const commitSha = await applyProposal(item, checkPolicy);
            await jobsRepository.updateItem(item.id, { status: "approved", commitSha });
            await recordAgentMetric(job, "decision", { itemId: item.id, itemKind: item.kind, decision: "approve", actor: "agent" });
            await jobsRepository.log(item.jobId, "auto_approved", "Act policy: verified selector-only change after three human-approved locator fixes.");
        } catch (error) {
            await jobsRepository.updateItem(item.id, { status: "pending" });
            await jobsRepository.log(item.jobId, "auto_approval_skipped", "The proposal could not be applied; human review is still available.");
        }
    }
}
