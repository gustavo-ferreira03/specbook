import { packReplayEvents } from "./replay-assets.ts";
import type { ReplayRecording } from "./replay-assets.ts";
import { readReplay } from "./replay.ts";
import type { ReplayEvent } from "./replay.ts";

// oxlint-disable-next-line complexity -- Validate all recording limits before accepting untrusted replay data.
export const offlineReplay = function offlineReplay(value: unknown): unknown {
  if (typeof value === "string") {
    return value
      .replaceAll(/@import\s+(?:url\([^)]*\)|["'][^"']*["'])[^;]*;?/giu, "")
      .replaceAll(
        /url\(\s*(?<capture1>["']?)(?<capture2>.*?)\1\s*\)/giu,
        (_match, _quote, url: string) =>
          /^(?:data:|#)/iu.test(url.trim())
            ? `url("${url.trim().replaceAll('"', "%22")}")`
            : 'url("data:,")'
      );
  }
  if (Array.isArray(value)) {
    return value.map(offlineReplay);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const entry = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(entry)) {
    // Mutation events carry an attribute-change list; snapshot nodes carry the attribute map.
    if (
      key === "attributes" &&
      item &&
      typeof item === "object" &&
      !Array.isArray(item)
    ) {
      const attributes: Record<string, unknown> = {};
      for (const [name, attribute] of Object.entries(item)) {
        if (
          [
            "src",
            "poster",
            "background",
            "xlink:href",
            "srcset",
            "srcdoc",
            "action",
            "formaction",
          ].includes(name)
        ) {
          if (
            name !== "srcdoc" &&
            name !== "srcset" &&
            typeof attribute === "string" &&
            /^data:(?:image|font|audio|video)\//iu.test(attribute)
          ) {
            attributes[name] = attribute;
          }
        } else if (name === "href") {
          if (typeof attribute === "string" && attribute.startsWith("#")) {
            attributes[name] = attribute;
          }
        } else if (
          !name.toLowerCase().startsWith("on") &&
          name !== "http-equiv"
        ) {
          attributes[name] = offlineReplay(attribute);
        }
      }
      result[key] = attributes;
    } else {
      result[key] = offlineReplay(item);
    }
  }
  return result;
};

export const readOfflineReplay = async function readOfflineReplay(
  directory: string
): Promise<ReplayRecording | null> {
  const events = await readReplay(directory);
  return events
    ? packReplayEvents(offlineReplay(events) as ReplayEvent[])
    : null;
};
