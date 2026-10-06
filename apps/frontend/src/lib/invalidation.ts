export type InvalidationResource = "projects" | "tree" | "chats" | "settings";

export interface Invalidation {
    /** Omitted means every resource. */
    resource?: InvalidationResource;
    /** Omitted means every project. */
    projectId?: string;
}

type Listener = (event: Invalidation) => void;

const listeners = new Set<Listener>();

/** Tells mounted views that server data changed so they refetch now instead of on their next poll. */
export function invalidate(event: Invalidation = {}): void {
    for (const listener of [...listeners]) listener(event);
}

export function onInvalidate(listener: Listener): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

export function matchesInvalidation(event: Invalidation, resource: InvalidationResource, projectId?: string): boolean {
    if (event.resource && event.resource !== resource) return false;
    if (event.projectId && projectId && event.projectId !== projectId) return false;
    return true;
}

/** Best-effort resource for a mutated API path; unknown paths invalidate everything. */
export function resourceForPath(path: string): InvalidationResource | undefined {
    if (path.startsWith("/settings")) return "settings";
    if (path.startsWith("/chats/")) return "chats";
    return undefined;
}
