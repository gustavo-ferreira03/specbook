import { z } from "zod";
import { issuePrefixedToken, tokenHash } from "../accounts/tokens";
import { runnersRepository, type RunnerToken } from "../../infra/repositories/runners";

export const runnerTokenSchema = z.object({
    name: z.string().trim().min(1).max(80),
    group: z.string().trim().max(80).nullable().optional().transform((value) => value || null),
}).strict();

export function publicRunner(runner: RunnerToken) {
    return { id: runner.id, name: runner.name, group: runner.group, createdAt: runner.createdAt, lastSeenAt: runner.lastSeenAt,
        online: runner.lastSeenAt !== null && Date.now() - Date.parse(runner.lastSeenAt) < 90_000 };
}

export async function issueRunnerToken(name: string, group: string | null) {
    const issued = issuePrefixedToken("sb_runner_");
    const runner = await runnersRepository.create(name, group, issued.hash);
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
