import { z } from "zod";
import type { HumanSpec } from "./types.ts";

const text = z.string().trim();

export const humanSpecSchema = z.object({
    preconditions: z.array(text.min(1)).describe("Starting state in user terms; each gets a setup step() before the steps."),
    steps: z.array(text.min(1)).min(1),
    expectedResult: text.describe("One sentence: the final state on screen, proven by its own step() after the steps."),
    postconditions: z.array(text.min(1)).describe("Side effects checked after the expected result, each in its own step(). Usually empty."),
}).strict() satisfies z.ZodType<HumanSpec>;

// Agents must state the expected result, so every run has evidence of it.
export const agentHumanSpecSchema = humanSpecSchema.extend({ expectedResult: humanSpecSchema.shape.expectedResult.min(1) });
