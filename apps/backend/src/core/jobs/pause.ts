import { settingsRepository } from "../../infra/repositories/settings";
import { stewardRepository } from "../../infra/repositories/steward";

export async function isAgentPaused(projectId: string): Promise<boolean> {
    const [globallyPaused, project] = await Promise.all([settingsRepository.getAgentPaused(), stewardRepository.get(projectId)]);
    return globallyPaused || project.paused;
}
