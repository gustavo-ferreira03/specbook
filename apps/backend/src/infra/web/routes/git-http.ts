import { buildHostAllowlist, frontendProxyOrigin } from "../security";
import { spawn } from "node:child_process";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Hono } from "hono";
import type { Context } from "hono";
import {
    noteGitAccessTokenUse,
    verifyGitAccessToken,
} from "../../../core/repo/access";
import { BareStateError, repoBare } from "../../../core/repo/bare";
import { repoGit } from "../../../core/repo/git";
import { reindexProjectUnlocked } from "../../../core/repo/indexer";
import { bareReposDir } from "../../../core/paths";
import { projectsRepository, type Project } from "../../repositories/projects";

const GIT_PATH = /^\/git\/([0-9a-fA-F-]{36})\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SERVICES = new Set(["git-upload-pack", "git-receive-pack"]);
const REALM = 'Basic realm="Specbook project repository", charset="UTF-8"';
const BACKEND_TIMEOUT_MS = 300_000;
const MAX_CGI_HEAD_BYTES = 64 * 1024;

interface CgiHead {
    status: number;
    headers: Record<string, string>;
}

function unauthorized(): Response {
    return new Response("Specbook requires a project access token\n", {
        status: 401,
        headers: { "www-authenticate": REALM, "content-type": "text/plain; charset=utf-8" },
    });
}

function trustProxy(): boolean {
    const value = (process.env.TRUST_PROXY ?? "").trim().toLowerCase();
    return value === "1" || value === "true";
}

/**
 * The public base URL clients should clone from. Forwarded headers are only
 * honoured when TRUST_PROXY says a reverse proxy sets them; otherwise any
 * client could choose the URL shown to users. Without them the request's own
 * host is used.
 */
export function publicGitOrigin(c: Context): string {
    const configured = process.env.SPECBOOK_PUBLIC_API_URL;
    if (configured) return configured.replace(/\/$/, "");
    const proxied = frontendProxyOrigin(c.req.raw.headers, buildHostAllowlist(Number(process.env.PORT ?? 4000)));
    if (proxied) return `${proxied}/api`;
    const requestUrl = new URL(c.req.url);
    const forwarded = trustProxy();
    const forwardedHost = forwarded ? c.req.header("x-forwarded-host")?.split(",")[0]?.trim() : undefined;
    const forwardedProto = forwarded ? c.req.header("x-forwarded-proto")?.split(",")[0]?.trim() : undefined;
    const host = forwardedHost || c.req.header("host") || requestUrl.host;
    const protocol = forwardedProto || requestUrl.protocol.replace(":", "");
    return `${protocol}://${host}`;
}

export function gitCloneUrl(c: Context, projectId: string): string {
    return `${publicGitOrigin(c)}/git/${projectId}.git`;
}

function parseBasicAuth(header: string | undefined): { username: string; password: string } | null {
    if (!header) return null;
    const [scheme, value] = header.split(" ");
    if (!scheme || scheme.toLowerCase() !== "basic" || !value) return null;
    const decoded = Buffer.from(value, "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    if (separator < 0) return null;
    return { username: decoded.slice(0, separator), password: decoded.slice(separator + 1) };
}

function splitCgiHead(buffer: Buffer): { head: CgiHead; rest: Buffer } | null {
    const crlf = buffer.indexOf("\r\n\r\n");
    const lf = buffer.indexOf("\n\n");
    let index = -1;
    let separator = 0;
    if (crlf >= 0 && (lf < 0 || crlf <= lf)) {
        index = crlf;
        separator = 4;
    } else if (lf >= 0) {
        index = lf;
        separator = 2;
    }
    if (index < 0) return null;

    const headers: Record<string, string> = {};
    let status = 200;
    for (const line of buffer.subarray(0, index).toString("utf8").split(/\r?\n/)) {
        const colon = line.indexOf(":");
        if (colon < 0) continue;
        const name = line.slice(0, colon).trim();
        const value = line.slice(colon + 1).trim();
        if (name.toLowerCase() === "status") status = Number.parseInt(value, 10) || 200;
        else headers[name.toLowerCase()] = value;
    }
    return { head: { status, headers }, rest: buffer.subarray(index + separator) };
}

function readCgiHead(stdout: Readable): Promise<CgiHead> {
    return new Promise((resolve, reject) => {
        let buffer = Buffer.alloc(0);
        const cleanup = () => {
            stdout.off("readable", onReadable);
            stdout.off("end", onEnd);
            stdout.off("error", reject);
        };
        const onReadable = () => {
            let chunk: Buffer | null;
            while ((chunk = stdout.read() as Buffer | null) !== null) {
                buffer = Buffer.concat([buffer, chunk]);
                const parsed = splitCgiHead(buffer);
                if (parsed) {
                    cleanup();
                    if (parsed.rest.length > 0) stdout.unshift(parsed.rest);
                    resolve(parsed.head);
                    return;
                }
                if (buffer.length > MAX_CGI_HEAD_BYTES) {
                    cleanup();
                    reject(new Error("git-http-backend produced an oversized header block"));
                    return;
                }
            }
        };
        const onEnd = () => {
            cleanup();
            reject(new Error("git-http-backend exited without a response"));
        };
        stdout.on("readable", onReadable);
        stdout.once("end", onEnd);
        stdout.once("error", reject);
    });
}

interface BackendRequest {
    projectId: string;
    endpoint: string;
    method: string;
    query: string;
    contentType?: string;
    contentEncoding?: string;
    gitProtocol?: string;
    contentLength?: string;
    chunked: boolean;
    body: ReadableStream<Uint8Array> | null;
}

function buildEnv(request: BackendRequest): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
        PATH: process.env.PATH,
        GIT_PROJECT_ROOT: path.resolve(bareReposDir),
        GIT_HTTP_EXPORT_ALL: "1",
        // PATH_INFO is rebuilt from validated parts, never from the raw URL.
        PATH_INFO: `/${request.projectId}.git/${request.endpoint}`,
        REQUEST_METHOD: request.method,
        QUERY_STRING: request.query,
        // git-http-backend only serves receive-pack to an authenticated user.
        REMOTE_USER: "specbook",
        REMOTE_ADDR: "127.0.0.1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_SYSTEM: "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
    };
    if (request.contentType) env.CONTENT_TYPE = request.contentType;
    if (request.contentEncoding) env.HTTP_CONTENT_ENCODING = request.contentEncoding;
    if (request.gitProtocol) env.GIT_PROTOCOL = request.gitProtocol;
    // A chunked body has no length; http-backend then reads stdin until EOF.
    if (!request.chunked && request.contentLength) env.CONTENT_LENGTH = request.contentLength;
    return env;
}

function spawnBackend(request: BackendRequest) {
    const child = spawn("git", ["http-backend"], { env: buildEnv(request), stdio: ["pipe", "pipe", "pipe"] });
    const timer = setTimeout(() => child.kill("SIGKILL"), BACKEND_TIMEOUT_MS);
    timer.unref();
    child.once("close", () => clearTimeout(timer));

    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
        stderr = (stderr + chunk).slice(-4096);
    });

    // A spawn failure (e.g. git missing) is emitted as 'error'; without a
    // listener it would crash the process. stdout then ends and callers fail.
    child.once("error", (error) => {
        console.error(`[specbook] git-http-backend could not run for ${request.projectId}:`, error);
    });
    child.stdin.on("error", () => undefined);
    if (request.body) {
        // A client abort errors the request stream; pipeline surfaces that
        // instead of an unhandled 'error', and the backend is stopped.
        pipeline(Readable.fromWeb(request.body as Parameters<typeof Readable.fromWeb>[0]), child.stdin).catch(() => {
            child.kill("SIGKILL");
        });
    } else {
        child.stdin.end();
    }

    return { child, readStderr: () => stderr };
}

/** Streams the backend's output. Used for clone and fetch, whose payloads are unbounded. */
async function streamBackend(request: BackendRequest): Promise<Response> {
    const { child, readStderr } = spawnBackend(request);
    try {
        const head = await readCgiHead(child.stdout);
        const body = Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>;
        return new Response(body, { status: head.status, headers: head.headers });
    } catch (error) {
        child.kill("SIGKILL");
        console.error(`[specbook] git-http-backend failed for ${request.projectId}:`, error, readStderr());
        return new Response("Git backend failed\n", { status: 500, headers: { "content-type": "text/plain" } });
    }
}

/** Buffers the backend's output so the repository lock can be held until the push settles. */
async function runBackendBuffered(request: BackendRequest): Promise<{ head: CgiHead; body: Buffer }> {
    const { child, readStderr } = spawnBackend(request);
    const head = await readCgiHead(child.stdout).catch((error: unknown) => {
        child.kill("SIGKILL");
        throw new Error(`${error instanceof Error ? error.message : String(error)} ${readStderr()}`.trim());
    });
    const chunks: Buffer[] = [];
    for await (const chunk of child.stdout) chunks.push(chunk as Buffer);
    return { head, body: Buffer.concat(chunks) };
}

/**
 * Publishes anything the instance has not committed yet, so a client pushing on
 * top of the advertised refs is pushing on top of the real project state.
 */
async function alignBareWithCheckoutUnlocked(projectId: string): Promise<void> {
    const status = await repoGit.getProjectGit(projectId).status();
    if (status.conflicted.length > 0) throw new Error("conflict");
    // First catch up with pushes the checkout has not followed yet (a failed
    // followExternalPush). Throws, and records, when that is not a clean
    // fast-forward, so a stale bare is surfaced instead of served silently.
    const { moved } = await repoBare.fastForwardCheckout(projectId, repoGit.getRepoDir(projectId));
    if (moved) {
        await reindexProjectUnlocked(projectId);
    }
    if (!status.isClean()) await repoGit.commitAll(projectId, "specbook: import working tree changes");
    // commitAll only logs publish failures; this one must fail the request.
    await repoGit.publishToBareUnlocked(projectId);
}

function stateErrorResponse(error: unknown): Response | null {
    if (error instanceof Error && error.message === "conflict") {
        return new Response("The project has an unresolved git conflict\n", {
            status: 409,
            headers: { "content-type": "text/plain; charset=utf-8" },
        });
    }
    if (error instanceof BareStateError) {
        return new Response(`${error.message}\n`, {
            status: 409,
            headers: { "content-type": "text/plain; charset=utf-8" },
        });
    }
    return null;
}

/** Applies whatever a client just pushed to the working checkout and the index. */
async function followExternalPush(projectId: string): Promise<void> {
    try {
        // fastForwardCheckout records and clears gitExternalSyncError itself.
        const { moved } = await repoBare.fastForwardCheckout(projectId, repoGit.getRepoDir(projectId));
        if (!moved) return;
        await reindexProjectUnlocked(projectId);
    } catch (error) {
        // The push itself succeeded and must not be rolled back; surface the
        // follow-up failure instead so the project can be repaired.
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[specbook] following an external push for ${projectId} failed:`, message);
        await projectsRepository
            .setGitExternalSyncError(projectId, message)
            .catch((dbError: unknown) => console.error(dbError));
    }
}

export function createGitHttpRouter(): Hono {
    const router = new Hono();

    router.all("/git/*", async (c) => {
        const url = new URL(c.req.url);
        const match = GIT_PATH.exec(url.pathname);
        if (!match) return c.text("Not found\n", 404);
        const [, projectId, endpoint] = match;
        if (!UUID.test(projectId)) return c.text("Not found\n", 404);

        const query = url.search.replace(/^\?/, "");
        const service = url.searchParams.get("service");
        if (endpoint === "info/refs") {
            if (c.req.method !== "GET") return c.text("Method not allowed\n", 405);
            // Only the smart protocol is served; the dumb one would expose the
            // repository over plain file reads.
            if (!service || !SERVICES.has(service)) return c.text("Smart HTTP is required\n", 403);
        } else if (c.req.method !== "POST") {
            return c.text("Method not allowed\n", 405);
        }

        const credentials = parseBasicAuth(c.req.header("authorization"));
        if (!credentials) return unauthorized();

        let project: Project | null = null;
        try {
            project = await projectsRepository.getProject(projectId);
        } catch (error) {
            console.error(`[specbook] git http lookup failed for ${projectId}:`, error);
            return c.text("Git backend failed\n", 500);
        }
        // An unknown project answers exactly like a wrong token, so the endpoint
        // does not disclose which project ids exist.
        if (!project || !verifyGitAccessToken(project, credentials.password)) return unauthorized();
        await noteGitAccessTokenUse(projectId).catch((error: unknown) => console.error(error));

        const request: BackendRequest = {
            projectId,
            endpoint,
            method: c.req.method,
            query,
            contentType: c.req.header("content-type"),
            contentEncoding: c.req.header("content-encoding"),
            gitProtocol: c.req.header("git-protocol"),
            contentLength: c.req.header("content-length"),
            chunked: (c.req.header("transfer-encoding") ?? "").toLowerCase().includes("chunked"),
            body: c.req.method === "POST" ? c.req.raw.body : null,
        };

        try {
            // Hot path: only a cheap existence check. Policy and hook are
            // applied when the bare is created and at boot, under the lock.
            if (!(await repoBare.bareExists(projectId))) {
                await repoGit.withRepoLock(projectId, async () => {
                    await repoGit.ensureProjectRepo(projectId, { create: true });
                    if (!(await repoBare.bareExists(projectId))) {
                        await repoBare.ensureBareRepo(projectId, repoGit.getRepoDir(projectId));
                    }
                });
            }
        } catch (error) {
            console.error(`[specbook] preparing the canonical repository for ${projectId} failed:`, error);
            return c.text("Git backend failed\n", 500);
        }

        if (endpoint !== "git-receive-pack") {
            // Advertising refs is the first request of every clone and fetch, so
            // it is the point where the bare repository is refreshed.
            if (endpoint === "info/refs") {
                try {
                    await repoGit.withRepoLock(projectId, () => alignBareWithCheckoutUnlocked(projectId));
                } catch (error) {
                    const stateResponse = stateErrorResponse(error);
                    if (stateResponse) return stateResponse;
                    console.error(`[specbook] refreshing the canonical repository for ${projectId} failed:`, error);
                    return c.text("Git backend failed\n", 500);
                }
            }
            return streamBackend(request);
        }

        // A push runs alone: the lock is held from the pre-flight publish until
        // the checkout has followed the new commits.
        return repoGit.withRepoLock(projectId, async () => {
            try {
                await alignBareWithCheckoutUnlocked(projectId);
            } catch (error) {
                const stateResponse = stateErrorResponse(error);
                if (stateResponse) return stateResponse;
                console.error(`[specbook] preparing a push to ${projectId} failed:`, error);
                return c.text("Git backend failed\n", 500);
            }
            let result;
            try {
                result = await runBackendBuffered(request);
            } catch (error) {
                console.error(`[specbook] git-receive-pack failed for ${projectId}:`, error);
                return c.text("Git backend failed\n", 500);
            }
            await followExternalPush(projectId);
            return new Response(Readable.toWeb(Readable.from([result.body])) as ReadableStream<Uint8Array>, {
                status: result.head.status,
                headers: result.head.headers,
            });
        });
    });

    return router;
}
