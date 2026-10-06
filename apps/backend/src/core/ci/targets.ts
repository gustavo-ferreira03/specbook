import { isIP } from "node:net";
import type { RunEnvironment } from "../../infra/db/schema";
import { resolveRunEnvironment } from "../environments";
import { projectsRepository, type Project } from "../../infra/repositories/projects";
import { httpTarget, isPrivateAddress, NetworkTargetError, resolveTarget, type AddressResolver } from "../network/targets";

export interface RunNetworkPolicy {
    origins: string[];
    allowPrivate: boolean;
}

export async function projectRunPolicy(project: Project, baseUrl: string, resolver?: AddressResolver, environment?: RunEnvironment): Promise<RunNetworkPolicy> {
    const target = httpTarget(baseUrl);
    const selected = environment ?? await resolveRunEnvironment(project.id, "Production", baseUrl);
    const base = httpTarget(selected.configuredBaseUrl);
    const origins = [...new Set([base.origin, ...selected.allowedOrigins])];
    if (!origins.includes(target.origin)) throw new NetworkTargetError("Add this origin in Settings → Environments before using it for a deployment or preview run");
    const hostname = base.hostname.replace(/^\[|\]$/g, "");
    // The exception reflects the saved URL, never a public hostname's mutable DNS.
    const allowPrivate = isIP(hostname) ? isPrivateAddress(hostname) : hostname === "localhost" || hostname.endsWith(".localhost");
    await resolveTarget(target, allowPrivate, resolver);
    return { origins, allowPrivate };
}

export async function runNetworkPolicy(projectId: string, baseUrl: string, environment?: RunEnvironment): Promise<RunNetworkPolicy> {
    const project = await projectsRepository.getProject(projectId);
    if (!project) throw new NetworkTargetError("Project not found");
    return projectRunPolicy(project, baseUrl, undefined, environment);
}
