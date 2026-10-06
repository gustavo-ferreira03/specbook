import { HTTPException } from "hono/http-exception";
import { projectsRepository, type Project } from "../repositories/projects";

export async function loadProject(id: string): Promise<Project> {
    const project = await projectsRepository.getProject(id);
    if (!project) throw new HTTPException(404, { message: "Project not found" });
    return project;
}
