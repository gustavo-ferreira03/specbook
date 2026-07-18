import type { SimpleGit } from "simple-git";
import type { Spec } from "../../infra/repositories/specs";
import { projectGit, withRepoLock } from "./git";
import { parseMarkdownIdentity } from "./markdown";
import { specRobotFile, specYamlFile } from "./writer";
import { parseYamlIdentity } from "./yaml";

export interface SpecHistoryEntry {
    sha: string;
    date: string;
    message: string;
}

interface HistoryRecord extends SpecHistoryEntry {
    path: string | null;
}

function docBaseOf(filePath: string): string {
    return filePath.replace(/\.(yml|md|robot)$/, "");
}

async function showAt(git: SimpleGit, sha: string, filePath: string): Promise<string | null> {
    return git.raw(["show", `${sha}:${filePath}`]).catch(() => null);
}

async function documentAt(git: SimpleGit, sha: string, base: string): Promise<{ source: string; format: "yml" | "md" } | null> {
    const yml = await showAt(git, sha, `${base}.yml`);
    if (yml !== null) return { source: yml, format: "yml" };
    const md = await showAt(git, sha, `${base}.md`);
    if (md !== null) return { source: md, format: "md" };
    return null;
}

function identityOf(document: { source: string; format: "yml" | "md" }): string | null {
    if (document.format === "yml") return parseYamlIdentity(document.source).id;
    try {
        return parseMarkdownIdentity(document.source).id;
    } catch {
        return null;
    }
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
        const git = projectGit(spec.projectId);
        const entries = await Promise.all([
            historyForPath(spec, specYamlFile(spec.path)),
            historyForPath(spec, specRobotFile(spec.path)),
        ]);
        const unique = new Map<string, HistoryRecord>();
        for (const entry of entries.flat()) if (!unique.has(entry.sha)) unique.set(entry.sha, entry);
        const filtered: SpecHistoryEntry[] = [];
        for (const entry of unique.values()) {
            if (!entry.path) continue;
            const document = await documentAt(git, entry.sha, docBaseOf(entry.path));
            if (document !== null) {
                const identity = identityOf(document);
                if (identity !== null && identity !== spec.id) continue;
            }
            filtered.push({ sha: entry.sha, date: entry.date, message: entry.message });
        }
        return filtered.sort((left, right) => right.date.localeCompare(left.date));
    });
}

async function pathAtCommit(spec: Spec, sha: string): Promise<string | null> {
    const git = projectGit(spec.projectId);
    const records = await Promise.all([
        historyForPath(spec, specYamlFile(spec.path)),
        historyForPath(spec, specRobotFile(spec.path)),
    ]);
    const historical = records.flat().find((entry) => entry.sha === sha)?.path;
    if (historical) return docBaseOf(historical);

    const candidates = (await git.raw(["ls-tree", "-r", "--name-only", sha, "--", "specs"]))
        .split("\n")
        .map((line) => line.trim())
        .filter(
            (line) =>
                (line.endsWith(".yml") || line.endsWith(".md")) &&
                !line.endsWith("/feature.yml") &&
                !line.endsWith("/feature.md"),
        );

    for (const candidate of candidates) {
        const base = docBaseOf(candidate);
        const document = await documentAt(git, sha, base);
        if (document !== null && identityOf(document) === spec.id) return base;
    }
    return null;
}

export async function specAtCommit(
    spec: Spec,
    sha: string,
): Promise<{ markdown: string | null; robot: string | null }> {
    if (!/^[0-9a-f]{4,40}$/i.test(sha)) throw new Error("Invalid commit sha");
    return withRepoLock(spec.projectId, async () => {
        const base = await pathAtCommit(spec, sha);
        if (!base) return { markdown: null, robot: null };
        const git = projectGit(spec.projectId);
        const [document, robot] = await Promise.all([
            documentAt(git, sha, base),
            showAt(git, sha, `${base}.robot`),
        ]);
        return { markdown: document?.source ?? null, robot };
    });
}
