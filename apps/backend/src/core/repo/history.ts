import type { Spec } from "../../infra/repositories/specs";
import { projectGit, withRepoLock } from "./git";
import { parseMarkdownIdentity } from "./markdown";

export interface SpecHistoryEntry {
    sha: string;
    date: string;
    message: string;
}

interface HistoryRecord extends SpecHistoryEntry {
    path: string | null;
}

async function historyForPath(spec: Spec, relativePath: string): Promise<HistoryRecord[]> {
    const raw = await projectGit(spec.projectId).raw([
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
    return withRepoLock(spec.projectId, async () => {
        const entries = await Promise.all([
            historyForPath(spec, `${spec.path}.md`),
            historyForPath(spec, `${spec.path}.robot`),
        ]);
        const unique = new Map<string, HistoryRecord>();
        for (const entry of entries.flat()) if (!unique.has(entry.sha)) unique.set(entry.sha, entry);
        const filtered: SpecHistoryEntry[] = [];
        for (const entry of unique.values()) {
            const relativePath = entry.path?.replace(/\.(md|robot)$/, "") ?? null;
            if (!relativePath) continue;
            const markdown = await projectGit(spec.projectId)
                .raw(["show", `${entry.sha}:${relativePath}.md`])
                .catch(() => null);
            if (markdown !== null) {
                try {
                    if (parseMarkdownIdentity(markdown).id !== spec.id) continue;
                } catch {}
            }
            filtered.push({ sha: entry.sha, date: entry.date, message: entry.message });
        }
        return filtered.sort((left, right) => right.date.localeCompare(left.date));
    });
}

async function pathAtCommit(spec: Spec, sha: string): Promise<string | null> {
    const git = projectGit(spec.projectId);
    const records = await Promise.all([
        historyForPath(spec, `${spec.path}.md`),
        historyForPath(spec, `${spec.path}.robot`),
    ]);
    const historical = records.flat().find((entry) => entry.sha === sha)?.path;
    if (historical) return historical.replace(/\.(md|robot)$/, "");

    const paths = (await git.raw(["ls-tree", "-r", "--name-only", sha, "--", "specs"]))
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.endsWith(".md") && !line.endsWith("/feature.md"));

    for (const candidate of paths) {
        const markdown = await git.raw(["show", `${sha}:${candidate}`]).catch(() => null);
        if (markdown === null) continue;
        try {
            if (parseMarkdownIdentity(markdown).id === spec.id) return candidate.slice(0, -3);
        } catch {}
    }
    return null;
}

export async function specAtCommit(
    spec: Spec,
    sha: string,
): Promise<{ markdown: string | null; robot: string | null }> {
    if (!/^[0-9a-f]{4,40}$/i.test(sha)) throw new Error("Invalid commit sha");
    return withRepoLock(spec.projectId, async () => {
        const relativePath = await pathAtCommit(spec, sha);
        if (!relativePath) return { markdown: null, robot: null };
        const git = projectGit(spec.projectId);
        const [markdown, robot] = await Promise.all([
            git.raw(["show", `${sha}:${relativePath}.md`]).catch(() => null),
            git.raw(["show", `${sha}:${relativePath}.robot`]).catch(() => null),
        ]);
        return { markdown, robot };
    });
}
