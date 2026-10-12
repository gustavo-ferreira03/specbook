import { z } from "zod";
import { issuePrefixedToken, tokenHash } from "../accounts/tokens";
import { runnersRepository, type RunnerToken } from "../../infra/repositories/runners";
import { RUNNER_CLI_VERSION, RUNNER_PROTOCOL_VERSION } from "@specbook/runtime/runner-protocol";
import { projectsRepository } from "../../infra/repositories/projects";
import { HTTPException } from "hono/http-exception";

export const runnerTokenSchema = z.object({
    name: z.string().trim().min(1).max(80),
    group: z.string().trim().max(80).nullable().optional().transform((value) => value || null),
    projectIds: z.array(z.string().uuid()).min(1).max(1000).refine((ids) => new Set(ids).size === ids.length, "Select each project once").nullable().optional().default(null),
}).strict();

export function runnerIsOutdated(version: string | null, protocolVersion: number | null): boolean {
    if (!version) return false;
    if (protocolVersion !== RUNNER_PROTOCOL_VERSION) return true;
    const actual = version.split(/[.-]/).slice(0, 3).map(Number);
    const current = RUNNER_CLI_VERSION.split(".").map(Number);
    for (let index = 0; index < 3; index++) {
        if (actual[index] !== current[index]) return actual[index] < current[index];
    }
    return version.includes("-");
}

export function publicRunner(runner: RunnerToken) {
    return { id: runner.id, name: runner.name, group: runner.group, createdAt: runner.createdAt, lastSeenAt: runner.lastSeenAt,
        cliVersion: runner.cliVersion, protocolVersion: runner.protocolVersion, concurrency: runner.concurrency, projectIds: runner.projectIds,
        outdated: runnerIsOutdated(runner.cliVersion, runner.protocolVersion),
        online: runner.lastSeenAt !== null && Date.now() - Date.parse(runner.lastSeenAt) < 90_000 };
}

export async function issueRunnerToken(name: string, group: string | null, projectIds: string[] | null = null) {
    if (projectIds) {
        const available = new Set((await projectsRepository.listProjects()).map((project) => project.id));
        if (projectIds.some((id) => !available.has(id))) throw new HTTPException(400, { message: "A selected project no longer exists." });
    }
    const issued = issuePrefixedToken("sb_runner_");
    const runner = await runnersRepository.create(name, group, issued.hash, projectIds);
    return { token: issued.token, runner: publicRunner(runner) };
}

export async function authenticateRunnerToken(authorization?: string, touch = true): Promise<RunnerToken | null> {
    const candidate = authorization?.match(/^Bearer (sb_runner_[A-Za-z0-9_-]{43})$/)?.[1];
    if (!candidate) return null;
    const runner = await runnersRepository.token(tokenHash(candidate));
    if (!runner) return null;
    if (touch) await runnersRepository.touch(runner.id);
    return runner;
}
