import fs from "node:fs/promises";
import { projectsRepository, type Project } from "../infra/repositories/projects";
import { repoBare } from "./repo/bare";
import { repoGit } from "./repo/git";

export function publicProject(project: Project) {
    return { id: project.id, name: project.name, baseUrl: project.baseUrl, createdAt: project.createdAt };
}

export async function createProject(name: string, baseUrl: string): Promise<Project> {
    const project = await projectsRepository.createProject(name, baseUrl);
    try {
        await repoGit.ensureProjectRepo(project.id, { create: true });
        await repoBare.ensureBareRepo(project.id, repoGit.getRepoDir(project.id));
    } catch (error) {
        await projectsRepository.deleteProject(project.id);
        await Promise.allSettled([
            fs.rm(repoGit.getRepoDir(project.id), { recursive: true, force: true }),
            repoBare.removeBareRepo(project.id),
        ]);
        throw error;
    }
    return project;
}
