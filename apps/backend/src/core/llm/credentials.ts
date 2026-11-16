import { readFile } from "node:fs/promises";

import type {
  Credential,
  CredentialInfo,
  CredentialStore,
} from "@earendil-works/pi-ai";

import { decryptSecret, encryptSecret } from "../credentials/crypto";
import { writeProtectedFile } from "../credentials/files";

export class FileCredentialStore implements CredentialStore {
  private readonly filePath: string;

  private operation = Promise.resolve();

  constructor(filePath: string) {
    /* No action is needed until this callback is replaced or invoked by its owner. */
    this.filePath = filePath;
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.operation;
    let release!: () => void;
    // oxlint-disable-next-line promise/avoid-new -- Bridge an event or callback API to the asynchronous operation.
    this.operation = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async readData(): Promise<CredentialData> {
    try {
      return JSON.parse(
        decryptSecret(await readFile(this.filePath, "utf-8"))
      ) as CredentialData;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return {};
      }
      throw error;
    }
  }

  private async writeData(data: CredentialData): Promise<void> {
    await writeProtectedFile(
      this.filePath,
      encryptSecret(JSON.stringify(data))
    );
  }

  async read(providerId: string): Promise<Credential | undefined> {
    return await this.withLock(
      async () =>
        await (async () => {
          const awaitedValue1416 = await this.readData();
          return awaitedValue1416[providerId];
        })()
    );
  }

  async list(): Promise<readonly CredentialInfo[]> {
    return await this.withLock(async () => {
      const data = await this.readData();
      return Object.entries(data).map(([providerId, credential]) => ({
        providerId,
        type: credential.type,
      }));
    });
  }

  async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>
  ): Promise<Credential | undefined> {
    return await this.withLock(async () => {
      const data = await this.readData();
      const next = await fn(data[providerId]);
      if (next === undefined) {
        return data[providerId];
      }
      data[providerId] = next;
      await this.writeData(data);
      return next;
    });
  }

  async delete(providerId: string): Promise<void> {
    await this.withLock(async () => {
      const data = await this.readData();
      Reflect.deleteProperty(data, providerId);
      await this.writeData(data);
    });
  }
}

type CredentialData = Record<string, Credential>;
