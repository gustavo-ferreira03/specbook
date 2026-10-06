import { isIP } from "node:net";
import { projectsRepository, type Project } from "../../infra/repositories/projects";
import { httpTarget, isPrivateAddress, NetworkTargetError, resolveTarget, type AddressResolver } from "../network/targets";

export interface RunNetworkPolicy {
    origins: string[];
    allowPrivate: boolean;
}

export async function projectRunPolicy(project: Project, baseUrl: string, resolver?: AddressResolver): Promise<RunNetworkPolicy> {
    const target = httpTarget(baseUrl);
    const base = httpTarget(project.baseUrl);
    const origins = [...new Set([base.origin, ...project.ciAllowedOrigins])];
    if (!origins.includes(target.origin)) throw new NetworkTargetError("Add this origin in Settings → CI/CD before using it for a deployment or preview run");
    const hostname = base.hostname.replace(/^\[|\]$/g, "");
    // The exception reflects the saved URL, never a public hostname's mutable DNS.
    const allowPrivate = isIP(hostname) ? isPrivateAddress(hostname) : hostname === "localhost" || hostname.endsWith(".localhost");
    await resolveTarget(target, allowPrivate, resolver);
    return { origins, allowPrivate };
}

export async function runNetworkPolicy(projectId: string, baseUrl: string): Promise<RunNetworkPolicy> {
    const project = await projectsRepository.getProject(projectId);
    if (!project) throw new NetworkTargetError("Project not found");
    return projectRunPolicy(project, baseUrl);
}
