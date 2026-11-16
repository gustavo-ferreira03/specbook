import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";

import { settingsRepository } from "../../infra/repositories/settings";
import { piAuthPath } from "../paths";
import { FileCredentialStore } from "./credentials";

export const configuredModel = async function configuredModel() {
  const [registry, settings] = await Promise.all([
    modelRegistryPromise,
    settingsRepository.getLlmSettings(),
  ]);
  const model =
    settings.provider && settings.model
      ? // oxlint-disable-next-line unicorn/no-array-method-this-argument -- ModelRegistry.find accepts provider and model identifiers; it is not Array.find.
        registry.find(settings.provider, settings.model)
      : undefined;
  return {
    ...settings,
    model,
    ready: Boolean(model && registry.hasConfiguredAuth(model)),
  };
};

export const llmCredentials = new FileCredentialStore(piAuthPath);
export const modelRuntimePromise = ModelRuntime.create({
  credentials: llmCredentials,
});
export const modelRegistryPromise = modelRuntimePromise.then(
  (runtime) => new ModelRegistry(runtime)
);
