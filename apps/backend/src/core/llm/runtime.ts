import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { FileCredentialStore } from "./credentials";
import { piAuthPath } from "../paths";
import { settingsRepository } from "../../infra/repositories/settings";

export const llmCredentials = new FileCredentialStore(piAuthPath);
export const modelRuntimePromise = ModelRuntime.create({ credentials: llmCredentials });
export const modelRegistryPromise = modelRuntimePromise.then((runtime) => new ModelRegistry(runtime));

export async function configuredModel() {
    const [registry, settings] = await Promise.all([modelRegistryPromise, settingsRepository.getLlmSettings()]);
    const model = settings.provider && settings.model ? registry.find(settings.provider, settings.model) : undefined;
    return { ...settings, model, ready: Boolean(model && registry.hasConfiguredAuth(model)) };
}
