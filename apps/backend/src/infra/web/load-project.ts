import { HTTPException } from "hono/http-exception";

import { projectsRepository } from "../repositories/projects";
import type { Project } from "../repositories/projects";

export const loadProject = async function loadProject(
  id: string
): Promise<Project> {
  const project = await projectsRepository.getProject(id);
  if (!project) {
    throw new HTTPException(404, { message: "Project not found" });
  }
  return project;
};
