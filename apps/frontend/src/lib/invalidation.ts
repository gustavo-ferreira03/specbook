export type InvalidationResource = "projects" | "tree" | "chats" | "settings";

export interface Invalidation {
  resource?: InvalidationResource;
  projectId?: string;
}

type Listener = (event: Invalidation) => void;

const listeners = new Set<Listener>();

export const invalidate = function invalidate(event: Invalidation = {}): void {
  // oxlint-disable-next-line unicorn/no-useless-spread -- Snapshot the collection before callbacks or deletions can change it during iteration.
  for (const listener of [...listeners]) {
    listener(event);
  }
};

export const onInvalidate = function onInvalidate(
  listener: Listener
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export const matchesInvalidation = function matchesInvalidation(
  event: Invalidation,
  resource: InvalidationResource,
  projectId?: string
): boolean {
  if (event.resource && event.resource !== resource) {
    return false;
  }
  if (event.projectId && projectId && event.projectId !== projectId) {
    return false;
  }
  return true;
};

export const resourceForPath = function resourceForPath(
  path: string
): InvalidationResource | undefined {
  if (path.startsWith("/settings")) {
    return "settings";
  }
  if (path.startsWith("/chats/")) {
    return "chats";
  }
  return undefined;
};
