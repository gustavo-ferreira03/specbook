import { payloadOf, verificationOf } from "../jobs/schemas";
import { parse } from "@babel/parser";
import { jobsRepository, type InboxItem } from "../../infra/repositories/jobs";
import { runsRepository } from "../../infra/repositories/runs";
import { stewardRepository } from "../../infra/repositories/steward";
import { applyProposal, isImplementationOnly } from "../jobs/proposals";
import { fixProposalSchema } from "../jobs/schemas";
import { provesExpectedResult } from "../runner/evidence-review";
import { isAgentPaused } from "../jobs/pause";
import { recordAgentMetric } from "../jobs/metrics";
import { LOCATOR_ACTIONS, LOCATOR_FACTORIES, LOCATOR_REFINERS } from "../runner/specbook/allowlist";

export function isLocatorOnlyFix(item: InboxItem): boolean {
    if (item.kind !== "spec_fix" || !payloadOf(item).requiresVerification) return false;
    const patch = fixProposalSchema.safeParse(payloadOf(item).params);
    const before = payloadOf(item).before;
    if (!patch.success || !isImplementationOnly(patch.data) || typeof before?.testSource !== "string") return false;
    const normalize = (source: string) => {
        const ast = parse(source, { sourceType: "module", plugins: ["typescript"] });
        const normalizeAction = (call: Record<string, any>) => {
            if (call.type !== "CallExpression" || call.callee?.type !== "MemberExpression" || call.callee.computed
                || !LOCATOR_ACTIONS.includes(call.callee.property?.name)) return;
            const selectors: Record<string, any>[] = [];
            let target = call.callee.object;
            while (target?.type === "CallExpression" && target.callee?.type === "MemberExpression" && !target.callee.computed) {
                const method = target.callee.property?.name;
                if (![...LOCATOR_FACTORIES, ...LOCATOR_REFINERS].includes(method)) return;
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

export async function isSelfApprovableRepair(item: InboxItem): Promise<boolean> {
    if (item.kind !== "spec_fix" || item.status !== "pending" || !payloadOf(item).requiresVerification) return false;
    const verification = verificationOf(item);
    if (verification?.status !== "passed" || !provesExpectedResult(verification.review)) return false;
    const patch = fixProposalSchema.safeParse(payloadOf(item).params);
    if (!patch.success || !isImplementationOnly(patch.data)) return false;
    const job = await jobsRepository.get(item.jobId);
    if (job?.kind === "regenerate") return true;
    return job?.kind === "failure_triage" && job.classification === "test_drift"
        && (isLocatorOnlyFix(item) || !!job.specId && !await runsRepository.hasPassed(job.specId));
}

export async function applyVerifiedRepairs(projectId: string): Promise<void> {
    if (await isAgentPaused(projectId) || (await stewardRepository.get(projectId)).autonomy === "observe") return;
    const pending = await jobsRepository.itemsByKind(projectId, "spec_fix", ["pending"]);
    const newestBySpec = new Map<string, InboxItem>();
    for (const item of [...pending].sort((a, b) => b.createdAt.localeCompare(a.createdAt))) {
        const specId = fixProposalSchema.safeParse(payloadOf(item).params).data?.specId;
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
            await jobsRepository.updateItem(item.id, { status: "pending" });
        }
    }
}
