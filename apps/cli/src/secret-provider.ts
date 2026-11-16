import { spawn } from "node:child_process";

import { CodedError } from "@specbook/runtime/errors";
import { httpTarget } from "@specbook/runtime/network/targets";
import { SECRET_NAME_PATTERN } from "@specbook/runtime/specbook/guard";
import { z } from "zod";

const fieldsSchema = z.record(
  z.string().regex(SECRET_NAME_PATTERN),
  z.string().min(1).max(65_536)
);
const originsSchema = z
  .array(
    z.string().refine((value) => {
      try {
        return httpTarget(value).origin === value;
      } catch {
        return false;
      }
    })
  )
  .min(1)
  .max(100);
const profileSchema = z
  .object({
    fields: fieldsSchema,
    origins: originsSchema,
    sensitive: z.array(z.string().regex(SECRET_NAME_PATTERN)).optional(),
  })
  .strict()
  .refine(
    (profile) =>
      profile.sensitive?.every((field) =>
        Object.hasOwn(profile.fields, field)
      ) ?? true
  );
export interface ProviderProfile {
  fields: Record<string, string>;
  origins: string[];
  sensitive?: string[];
}

export const providerProfile = async function providerProfile(
  command: string,
  profile: string,
  signal?: AbortSignal
): Promise<ProviderProfile> {
  if (!command.trim() || command.length > 16_384) {
    throw new CodedError(
      "credentials",
      "Provide a nonempty secret provider command"
    );
  }
  z.string().regex(SECRET_NAME_PATTERN).parse(profile);
  signal?.throwIfAborted();
  let data = "";
  let tooLarge = false;
  let timedOut = false;
  const child =
    process.platform === "win32"
      ? spawn(
          process.env.ComSpec ?? "cmd.exe",
          ["/d", "/s", "/c", `${command} ${profile}`],
          { stdio: ["ignore", "pipe", "ignore"], windowsHide: true }
        )
      : spawn(
          "/bin/sh",
          ["-c", `${command} "$1"`, "specbook-secrets", profile],
          { stdio: ["ignore", "pipe", "ignore"], detached: true }
        );
  const kill = () => {
    if (process.platform !== "win32" && child.pid) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        /* Cleanup is best effort after the operation has completed or failed. */
        /* The command may have already exited. */
      }
    } else {
      child.kill("SIGKILL");
    }
  };
  const timer = setTimeout(() => {
    timedOut = true;
    kill();
  }, 30_000);
  const abort = () => kill();
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) {
    abort();
  }
  child.stdout.setEncoding("utf-8");
  child.stdout.on("data", (chunk: string) => {
    if (tooLarge) {
      return;
    }
    data += chunk;
    if (Buffer.byteLength(data) > 1_048_576) {
      tooLarge = true;
      data = "";
      kill();
    }
  });
  try {
    // oxlint-disable-next-line promise/avoid-new -- Adapt the existing event or callback lifecycle to a promise, including its cancellation and cleanup.
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", () =>
        reject(
          new CodedError(
            "credentials",
            `Could not start the secret provider for profile "${profile}"`
          )
        )
      );
      child.once("close", resolve);
    });
    signal?.throwIfAborted();
    if (timedOut || tooLarge || code !== 0) {
      throw new CodedError(
        "credentials",
        `Secret provider for profile "${profile}" ${(() => {
          if (timedOut) {
            return "timed out";
          }
          if (tooLarge) {
            return "returned too much data";
          }
          return "failed";
        })()}; check the provider configuration`
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      throw new CodedError(
        "credentials",
        `Secret provider for profile "${profile}" must print one JSON object of string fields`
      );
    }
    const scoped = profileSchema.safeParse(parsed);
    if (scoped.success) {
      return scoped.data;
    }
    const fields = fieldsSchema.safeParse(parsed);
    if (!fields.success) {
      throw new CodedError(
        "credentials",
        `Secret provider for profile "${profile}" must print { fields, origins } or valid named, nonempty string fields`
      );
    }
    return { fields: fields.data, origins: [] };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
};
