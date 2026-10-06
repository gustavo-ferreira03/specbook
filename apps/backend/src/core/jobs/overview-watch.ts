import { projectOverview } from "./overview";

const RECOMPUTE_MS = 2_000;

type Listener = (overview: string) => void;
interface Watch {
    listeners: Set<Listener>;
    latest?: string;
    timer?: NodeJS.Timeout;
}

const watches = new Map<string, Watch>();

/** One recomputation loop per watched project; listeners receive the serialized overview only when it changes. */
async function recompute(projectId: string, watch: Watch): Promise<void> {
    try {
        const overview = JSON.stringify(await projectOverview(projectId));
        if (watches.get(projectId) === watch && overview !== watch.latest) {
            watch.latest = overview;
            for (const listener of watch.listeners) listener(overview);
        }
    } catch {
        // A failed computation is retried on the next tick.
    }
    if (watches.get(projectId) === watch) watch.timer = setTimeout(() => void recompute(projectId, watch), RECOMPUTE_MS);
}

export function watchProjectOverview(projectId: string, listener: Listener): () => void {
    let watch = watches.get(projectId);
    if (!watch) {
        watch = { listeners: new Set() };
        watches.set(projectId, watch);
        void recompute(projectId, watch);
    } else if (watch.latest) listener(watch.latest);
    const current = watch;
    current.listeners.add(listener);
    return () => {
        current.listeners.delete(listener);
        if (current.listeners.size || watches.get(projectId) !== current) return;
        clearTimeout(current.timer);
        watches.delete(projectId);
    };
}
