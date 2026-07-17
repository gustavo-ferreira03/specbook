import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { piAuthPath } from "../paths";

export const llmAuth = AuthStorage.create(piAuthPath);
export const modelRegistry = ModelRegistry.create(llmAuth);
