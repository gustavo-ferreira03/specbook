import type { SimpleGit } from "simple-git";
import type { Spec } from "../../infra/repositories/specs";
import { repoGit } from "./git";
import { specTestFile, specYamlFile } from "./writer";

export interface SpecHistoryEntry {
    sha: string;
    date: string;
    message: string;
}

interface HistoryRecord extends SpecHistoryEntry {
    path: string | null;
}

function docBaseOf(filePath: string): string {
    return filePath.replace(/\.(yml|ts)$/, "");
}

async function showAt(git: SimpleGit, sha: string, filePath: string): Promise<string | null> {
    return git.raw(["show", `${sha}:${filePath}`]).catch(() => null);
}

async function documentAt(git: SimpleGit, sha: string, base: string): Promise<string | null> {
    return showAt(git, sha, `${base}.yml`);
}

async function historyForPath(spec: Spec, relativePath: string): Promise<HistoryRecord[]> {
    const raw = await repoGit.getProjectGit(spec.projectId).raw([
        "log",
        "--follow",
        "--format=%x1e%H%x09%cI%x09%s",
        "--name-only",
        "--",
        relativePath,
    ]);
    return raw
        .split("\x1e")
        .map((record) => record.trim())
        .filter(Boolean)
        .map((record) => {
            const [metadata, ...paths] = record.split("\n").map((line) => line.trim()).filter(Boolean);
            const [sha, date, ...message] = metadata.split("\t");
            return { sha, date, message: message.join("\t"), path: paths[0] ?? null };
        });
}

export async function specHistory(spec: Spec): Promise<SpecHistoryEntry[]> {
    return repoGit.withRepoLock(spec.projectId, async () => {
        const entries = await Promise.all([
            historyForPath(spec, specYamlFile(spec.path)),
            historyForPath(spec, specTestFile(spec.path)),
        ]);
        const unique = new Map<string, HistoryRecord>();
        for (const entry of entries.flat()) if (!unique.has(entry.sha)) unique.set(entry.sha, entry);
        return [...unique.values()]
            .filter((entry) => entry.path !== null)
            .map(({ sha, date, message }) => ({ sha, date, message }))
            .sort((left, right) => right.date.localeCompare(left.date));
    });
}

async function pathAtCommit(spec: Spec, sha: string): Promise<string | null> {
    const records = await Promise.all([
        historyForPath(spec, specYamlFile(spec.path)),
        historyForPath(spec, specTestFile(spec.path)),
    ]);
    const historical = records.flat().find((entry) => entry.sha === sha)?.path;
    if (historical) return docBaseOf(historical);
    return null;
}

export async function specAtCommit(
    spec: Spec,
    sha: string,
): Promise<{ yaml: string | null; testSource: string | null }> {
    if (!/^[0-9a-f]{40}$/i.test(sha)) throw new Error("Invalid commit sha");
    return repoGit.withRepoLock(spec.projectId, async () => {
        const base = await pathAtCommit(spec, sha);
        if (!base) return { yaml: null, testSource: null };
        const git = repoGit.getProjectGit(spec.projectId);
        const [document, testSource] = await Promise.all([
            documentAt(git, sha, base),
            showAt(git, sha, `${base}.ts`),
        ]);
        return { yaml: document, testSource };
    });
}
