import { parse } from "@babel/parser";
import {
  LOCATOR_ACTIONS,
  LOCATOR_FACTORIES,
  LOCATOR_REFINERS,
} from "@specbook/runtime/specbook/allowlist";

import { jobsRepository } from "../../infra/repositories/jobs";
import type { InboxItem } from "../../infra/repositories/jobs";
import { runsRepository } from "../../infra/repositories/runs";
import { stewardRepository } from "../../infra/repositories/steward";
import { recordAgentMetric } from "../jobs/metrics";
import { isAgentPaused } from "../jobs/pause";
import { applyProposal, isImplementationOnly } from "../jobs/proposals";
import { payloadOf, verificationOf, fixProposalSchema } from "../jobs/schemas";
import { provesExpectedResult } from "../runner/evidence-review";
import { requireValue } from "../utils/require-value";

interface SyntaxNode {
  type?: string;
  name?: string;
  value?: unknown;
  computed?: boolean;
  callee?: SyntaxNode;
  object?: SyntaxNode;
  property?: SyntaxNode;
  argument?: SyntaxNode;
  arguments?: SyntaxNode[];
  [key: string]: unknown;
}

// oxlint-disable-next-line complexity -- Keep the approval decision tree together so state transitions and error ordering remain explicit.
const normalizeAction = (call: SyntaxNode | undefined) => {
  if (
    call?.type !== "CallExpression" ||
    call.callee?.type !== "MemberExpression" ||
    call.callee.computed ||
    !LOCATOR_ACTIONS.includes(call.callee.property?.name ?? "")
  ) {
    return;
  }
  const selectors: SyntaxNode[] = [];
  let target = call.callee.object;
  while (
    target?.type === "CallExpression" &&
    target.callee?.type === "MemberExpression" &&
    !target.callee.computed
  ) {
    const method = target.callee.property?.name ?? "";
    if (![...LOCATOR_FACTORIES, ...LOCATOR_REFINERS].includes(method)) {
      return;
    }
    if (
      ["locator", "getByLabel", "getByTestId", "getByPlaceholder"].includes(
        method
      ) &&
      target.arguments?.length === 1 &&
      target.arguments[0]?.type === "StringLiteral"
    ) {
      selectors.push(target.arguments[0]);
    }
    target = target.callee.object;
  }
  if (target?.type === "Identifier" && target.name === "page") {
    for (const selector of selectors) {
      selector.value = "selector";
    }
  }
};

const normalize = (source: string) => {
  const ast = parse(source, {
    sourceType: "module",
    plugins: ["typescript"],
  });
  const visit = (node: unknown, inAssertion = false): unknown => {
    if (Array.isArray(node)) {
      return node.map((value) => visit(value, inAssertion));
    }
    if (!node || typeof node !== "object") {
      return node;
    }
    const entry = node as SyntaxNode;
    const assertion =
      inAssertion ||
      (entry.type === "CallExpression" &&
        ((entry.callee?.type === "Identifier" &&
          entry.callee.name === "expect") ||
          (entry.callee?.type === "MemberExpression" &&
            entry.callee.object?.type === "Identifier" &&
            entry.callee.object.name === "expect")));
    if (entry.type === "AwaitExpression" && !assertion) {
      normalizeAction(entry.argument);
    }
    return Object.fromEntries(
      Object.entries(entry)
        .filter(
          ([key]) =>
            ![
              "start",
              "end",
              "loc",
              "extra",
              "comments",
              "leadingComments",
              "trailingComments",
              "innerComments",
            ].includes(key)
        )
        .map(([key, value]) => [key, visit(value, assertion)])
    );
  };
  return JSON.stringify(visit(ast));
};

export const isLocatorOnlyFix = function isLocatorOnlyFix(
  item: InboxItem
): boolean {
  if (item.kind !== "spec_fix" || !payloadOf(item).requiresVerification) {
    return false;
  }
  const patch = fixProposalSchema.safeParse(payloadOf(item).params);
  const { before } = payloadOf(item);
  if (
    !patch.success ||
    !isImplementationOnly(patch.data) ||
    typeof before?.testSource !== "string"
  ) {
    return false;
  }

  try {
    return (
      before.testSource !== patch.data.testSource &&
      normalize(before.testSource) === normalize(patch.data.testSource)
    );
  } catch {
    return false;
  }
};

export const isSelfApprovableRepair = async function isSelfApprovableRepair(
  item: InboxItem
): Promise<boolean> {
  if (
    item.kind !== "spec_fix" ||
    item.status !== "pending" ||
    !payloadOf(item).requiresVerification
  ) {
    return false;
  }
  const verification = verificationOf(item);
  if (
    verification?.status !== "passed" ||
    !provesExpectedResult(verification.review)
  ) {
    return false;
  }
  const patch = fixProposalSchema.safeParse(payloadOf(item).params);
  if (!patch.success || !isImplementationOnly(patch.data)) {
    return false;
  }
  const job = await jobsRepository.get(item.jobId);
  if (job?.kind === "regenerate") {
    return true;
  }
  return (
    job?.kind === "failure_triage" &&
    job.classification === "test_drift" &&
    (isLocatorOnlyFix(item) ||
      (!!job.specId && !(await runsRepository.hasPassed(job.specId))))
  );
};

export const applyVerifiedRepairs = async function applyVerifiedRepairs(
  projectId: string
): Promise<void> {
  if (
    (await isAgentPaused(projectId)) ||
    (await (async () => {
      const awaitedValue5063 = await stewardRepository.get(projectId);
      return awaitedValue5063.autonomy;
    })()) === "observe"
  ) {
    return;
  }
  const pending = await jobsRepository.itemsByKind(projectId, "spec_fix", [
    "pending",
  ]);
  const newestBySpec = new Map<string, InboxItem>();
  for (const item of [...pending].toSorted((a, b) =>
    b.createdAt.localeCompare(a.createdAt)
  )) {
    const specId = fixProposalSchema.safeParse(payloadOf(item).params).data
      ?.specId;
    if (!specId) {
      continue;
    }
    if (!newestBySpec.has(specId)) {
      newestBySpec.set(specId, item);
      continue;
    }
    // oxlint-disable-next-line no-await-in-loop -- Apply dependent state changes in order and keep resource use bounded.
    await jobsRepository.updateItem(item.id, {
      status: "dismissed",
      payload: {
        ...item.payload,
        supersededBy: requireValue(newestBySpec.get(specId)).id,
      },
    });
  }
  for (const item of newestBySpec.values()) {
    if (
      // oxlint-disable-next-line no-await-in-loop -- Apply dependent state changes in order and keep resource use bounded.
      !(await isSelfApprovableRepair(item)) ||
      // oxlint-disable-next-line no-await-in-loop -- Apply dependent state changes in order and keep resource use bounded.
      !(await jobsRepository.claimItem(item.id))
    ) {
      continue;
    }
    // oxlint-disable-next-line no-await-in-loop -- Apply dependent state changes in order and keep resource use bounded.
    const job = await jobsRepository.get(item.jobId);
    try {
      // oxlint-disable-next-line no-await-in-loop -- Apply dependent state changes in order and keep resource use bounded.
      const commitSha = await applyProposal(item, async () => {
        if (await isAgentPaused(projectId)) {
          throw new Error("The agent was paused");
        }
      });
      // oxlint-disable-next-line no-await-in-loop -- Apply dependent state changes in order and keep resource use bounded.
      await jobsRepository.updateItem(item.id, {
        status: "approved",
        commitSha,
        payload: { ...item.payload, appliedBy: "agent" },
      });
      if (job) {
        // oxlint-disable-next-line no-await-in-loop -- Apply dependent state changes in order and keep resource use bounded.
        await recordAgentMetric(job, "decision", {
          itemId: item.id,
          itemKind: item.kind,
          decision: "approve",
          actor: "agent",
        });
      }
      // oxlint-disable-next-line no-await-in-loop -- Apply dependent state changes in order and keep resource use bounded.
      await jobsRepository.log(
        item.jobId,
        "auto_approved",
        "Verified implementation-only repair; the behavior contract is unchanged."
      );
    } catch {
      // oxlint-disable-next-line no-await-in-loop -- Apply dependent state changes in order and keep resource use bounded.
      await jobsRepository.updateItem(item.id, { status: "pending" });
    }
  }
};
