import fs from "node:fs/promises";
import path from "node:path";
import { simpleGit, type SimpleGit } from "simple-git";
import { projectsRepository } from "../../infra/repositories/projects";
import { bareReposDir } from "../paths";

const MAIN_REF = "refs/heads/main";
const BARE_TRACKING_REF = "refs/remotes/specbook/main";
const DEFAULT_MAX_PUSH_BYTES = 200 * 1024 * 1024;

const PRE_RECEIVE_HOOK = `#!/bin/sh
status=0
while read -r old new ref; do
    if [ "$ref" != "${MAIN_REF}" ]; then
        echo "Specbook accepts pushes to ${MAIN_REF} only (rejected $ref)" >&2
        status=1
        continue
    fi
    case "$new" in
        *[!0]*) ;;
        *) continue ;;
    esac
    for commit in $(git rev-list "$new" --not --all); do
        bad=$(git ls-tree -r "$commit" | awk '$1 == "120000" || $1 == "160000" { sub(/^[^\\t]*\\t/, ""); print; exit }')
        if [ -n "$bad" ]; then
            echo "Specbook does not accept symbolic links or submodules (commit $commit, path $bad)" >&2
            status=1
            break
        fi
    done
done
exit $status
`;

export class BareStateError extends Error {}

export type BareRelation = "no-bare-head" | "equal" | "checkout-ahead" | "bare-ahead" | "diverged";

function maxPushBytes(): number {
    const configured = Number.parseInt(process.env.SPECBOOK_GIT_MAX_PUSH_BYTES ?? "", 10);
    return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_MAX_PUSH_BYTES;
}

function checkoutGit(checkoutDir: string): SimpleGit {
    return simpleGit({ baseDir: checkoutDir, timeout: { block: 30_000 }, allowEnvironment: ["GIT_TERMINAL_PROMPT"] }).env("GIT_TERMINAL_PROMPT", "0");
}

class RepoBare {
    getBareRepoDir(projectId: string): string {
        const absoluteRoot = path.resolve(bareReposDir);
        const dir = path.resolve(absoluteRoot, `${projectId}.git`);
        if (path.dirname(dir) !== absoluteRoot) throw new Error("Invalid project bare repo directory");
        return dir;
    }

    private bareGit(projectId: string): SimpleGit {
        return simpleGit({
            baseDir: this.getBareRepoDir(projectId),
            timeout: { block: 30_000 },
            allowEnvironment: ["GIT_TERMINAL_PROMPT"],
        }).env("GIT_TERMINAL_PROMPT", "0");
    }

    async bareExists(projectId: string): Promise<boolean> {
        return fs
            .stat(path.join(this.getBareRepoDir(projectId), "HEAD"))
            .then((stat) => stat.isFile())
            .catch(() => false);
    }

    async ensureBareRepo(projectId: string, checkoutDir: string): Promise<{ checkoutMoved: boolean }> {
        const dir = this.getBareRepoDir(projectId);
        await fs.mkdir(path.resolve(bareReposDir), { recursive: true });
        if (!(await this.bareExists(projectId))) {
            await fs.mkdir(dir, { recursive: true });
            await simpleGit(dir).init(["--bare", "--initial-branch=main"]);
        }
        await this.applyBarePolicy(projectId);
        try {
            return { checkoutMoved: await this.reconcile(projectId, checkoutDir) };
        } catch (error) {
            if (!(error instanceof BareStateError)) throw error;
            console.error(`[specbook] canonical repository for ${projectId} needs attention:`, error.message);
            return { checkoutMoved: false };
        }
    }

    private async checkoutHead(checkoutDir: string): Promise<string | null> {
        return checkoutGit(checkoutDir)
            .raw(["rev-parse", "--verify", "--quiet", MAIN_REF])
            .then((value) => value.trim() || null)
            .catch(() => null);
    }

    private async isAncestor(git: SimpleGit, ancestor: string, descendant: string): Promise<boolean> {
        return git
            .raw(["merge-base", ancestor, descendant])
            .then((value) => value.trim() === ancestor)
            .catch(() => false);
    }

    async recordStateError(projectId: string, message: string | null): Promise<void> {
        try {
            const project = await projectsRepository.getProject(projectId);
            if (!project || project.gitExternalSyncError === message) return;
            await projectsRepository.setGitExternalSyncError(projectId, message);
        } catch (error) {
            console.error(`[specbook] recording the canonical repository state for ${projectId} failed:`, error);
        }
    }

    private async fail(projectId: string, message: string): Promise<never> {
        await this.recordStateError(projectId, message);
        throw new BareStateError(message);
    }

    async compare(projectId: string, checkoutDir: string): Promise<{
        relation: BareRelation;
        checkoutSha: string;
        bareSha: string | null;
    }> {
        const checkoutSha = await this.checkoutHead(checkoutDir);
        if (!checkoutSha) throw new Error(`Project checkout has no ${MAIN_REF} branch`);
        const bareSha = await this.getBareHeadSha(projectId);
        if (!bareSha) return { relation: "no-bare-head", checkoutSha, bareSha };
        if (bareSha === checkoutSha) return { relation: "equal", checkoutSha, bareSha };
        const git = checkoutGit(checkoutDir);
        await git.raw(["fetch", "--no-tags", this.getBareRepoDir(projectId), `+${MAIN_REF}:${BARE_TRACKING_REF}`]);
        if (await this.isAncestor(git, bareSha, checkoutSha)) return { relation: "checkout-ahead", checkoutSha, bareSha };
        if (await this.isAncestor(git, checkoutSha, bareSha)) return { relation: "bare-ahead", checkoutSha, bareSha };
        return { relation: "diverged", checkoutSha, bareSha };
    }

    private async reconcile(projectId: string, checkoutDir: string): Promise<boolean> {
        const { relation } = await this.compare(projectId, checkoutDir);
        if (relation === "bare-ahead") return (await this.fastForwardCheckout(projectId, checkoutDir)).moved;
        await this.publish(projectId, checkoutDir);
        return false;
    }

    private async applyBarePolicy(projectId: string): Promise<void> {
        const git = this.bareGit(projectId);
        await git.addConfig("http.receivepack", "true");
        await git.addConfig("http.uploadpack", "true");
        await git.addConfig("receive.denyNonFastForwards", "true");
        await git.addConfig("receive.denyDeletes", "true");
        await git.addConfig("receive.denyCurrentBranch", "ignore");
        await git.addConfig("receive.fsckObjects", "true");
        await git.addConfig("receive.maxInputSize", String(maxPushBytes()));
        await git.raw(["config", "--unset-all", "gc.auto"]).catch(() => undefined);
        await git.addConfig("receive.autogc", "true");
        await this.writeHook(projectId, "pre-receive", PRE_RECEIVE_HOOK);
    }

    private async writeHook(projectId: string, name: string, content: string): Promise<void> {
        const hooksDir = path.join(this.getBareRepoDir(projectId), "hooks");
        const hookPath = path.join(hooksDir, name);
        const current = await fs.readFile(hookPath, "utf8").catch(() => null);
        const mode = await fs.stat(hookPath).then((stat) => stat.mode & 0o777).catch(() => 0);
        if (current === content && mode === 0o755) return;
        await fs.mkdir(hooksDir, { recursive: true });
        const tmpPath = `${hookPath}.${process.pid}.${Date.now()}.tmp`;
        try {
            await fs.writeFile(tmpPath, content, { encoding: "utf8", mode: 0o755 });
            await fs.chmod(tmpPath, 0o755);
            await fs.rename(tmpPath, hookPath);
        } catch (error) {
            await fs.rm(tmpPath, { force: true });
            throw error;
        }
    }

    private async copyCheckoutIntoBare(projectId: string, checkoutDir: string): Promise<void> {
        await this.bareGit(projectId).raw(["fetch", "--no-tags", checkoutDir, `+${MAIN_REF}:${MAIN_REF}`]);
    }

    async publish(projectId: string, checkoutDir: string): Promise<void> {
        const { relation } = await this.compare(projectId, checkoutDir);
        if (relation === "bare-ahead") {
            await this.fail(
                projectId,
                "The canonical repository has pushed commits the project checkout has not followed yet; Specbook will follow them on the next Git request or sync",
            );
        }
        if (relation === "diverged") {
            await this.fail(
                projectId,
                "The project checkout and its canonical repository have diverged; resolve it manually before Git access can continue",
            );
        }
        if (relation !== "equal") await this.copyCheckoutIntoBare(projectId, checkoutDir);
        await this.recordStateError(projectId, null);
    }

    async getBareHeadSha(projectId: string): Promise<string | null> {
        return this.bareGit(projectId)
            .raw(["rev-parse", "--verify", "--quiet", MAIN_REF])
            .then((value) => value.trim() || null)
            .catch(() => null);
    }

    async fastForwardCheckout(projectId: string, checkoutDir: string): Promise<{ moved: boolean; sha: string | null }> {
        const { relation, bareSha } = await this.compare(projectId, checkoutDir);
        if (relation === "no-bare-head" || relation === "equal" || relation === "checkout-ahead") {
            return { moved: false, sha: bareSha };
        }
        if (relation === "diverged") {
            await this.fail(
                projectId,
                "The project checkout and its canonical repository have diverged; resolve it manually before Specbook can follow the pushed commits",
            );
        }
        const git = checkoutGit(checkoutDir);
        if (!(await git.status()).isClean()) {
            await this.fail(projectId, "The project checkout has uncommitted changes; Specbook cannot follow the pushed commits");
        }
        await git.raw(["reset", "--hard", bareSha as string]);
        await this.recordStateError(projectId, null);
        return { moved: true, sha: bareSha };
    }

    async removeStaleLocks(projectId: string): Promise<void> {
        const dir = this.getBareRepoDir(projectId);
        for (const lock of ["HEAD.lock", "config.lock", "packed-refs.lock", path.join("refs", "heads", "main.lock")]) {
            const target = path.join(dir, lock);
            if (await fs.stat(target).then(() => true).catch(() => false)) {
                console.warn(`[specbook] removing stale lock ${target}`);
                await fs.rm(target, { force: true });
            }
        }
    }

    async removeBareRepo(projectId: string): Promise<void> {
        await fs.rm(this.getBareRepoDir(projectId), { recursive: true, force: true });
    }
}

export const repoBare = new RepoBare();
