import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { FileCredentialStore } from "./credentials";
import { piAuthPath } from "../paths";

export const llmCredentials = new FileCredentialStore(piAuthPath);
export const modelRuntimePromise = ModelRuntime.create({ credentials: llmCredentials });
export const modelRegistryPromise = modelRuntimePromise.then((runtime) => new ModelRegistry(runtime));
