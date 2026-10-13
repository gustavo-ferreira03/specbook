import { mountReplay, type ReplayController, type ReplayPlayerOptions } from "./replay-player.ts";

declare global {
    interface Window { rrwebPlayer?: { default: ReplayPlayerOptions["Player"] } }
}

const instances = new WeakMap<HTMLDetailsElement, Promise<ReplayController | null>>();
let library: Promise<ReplayPlayerOptions["Player"]> | undefined;

async function decompress(value: string): Promise<string> {
    const bytes = Uint8Array.from(atob(value.trim()), (character) => character.charCodeAt(0));
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
    return new Response(stream).text();
}

function loadLibrary(): Promise<ReplayPlayerOptions["Player"]> {
    return library ??= (async () => {
        const element = document.getElementById("specbook-replay-library");
        const script = document.createElement("script");
        script.textContent = await decompress(element?.textContent ?? "");
        document.head.append(script);
        if (!window.rrwebPlayer) throw new Error("Replay player unavailable");
        return window.rrwebPlayer.default;
    })();
}

function load(section: HTMLDetailsElement): Promise<ReplayController | null> {
    const existing = instances.get(section);
    if (existing) return existing;
    const task = (async () => {
        const replay = section.querySelector<HTMLElement>(".replay")!;
        try {
            const Player = await loadLibrary();
            const recording = JSON.parse(await decompress(replay.querySelector(".replay-data")?.textContent ?? ""));
            return mountReplay(replay, { recording, Player, waitMs: Number(replay.dataset.waitMs) });
        } catch {
            const status = replay.querySelector<HTMLElement>(".replay-status")!;
            status.textContent = "Replay could not be loaded. Open this report in a current browser.";
            status.setAttribute("role", "status");
            return null;
        }
    })();
    instances.set(section, task);
    return task;
}

for (const section of document.querySelectorAll<HTMLDetailsElement>(".spec:has(.replay)")) {
    section.addEventListener("toggle", async () => {
        const controls = section.open ? await load(section) : await instances.get(section);
        if (!section.open) controls?.pause();
        else controls?.resize();
    });
    if (section.open) void load(section);
    section.addEventListener("click", async (event) => {
        const link = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-replay-step]") : null;
        if (!link) return;
        if (!link.classList.contains("zoom")) event.preventDefault();
        const controls = await load(section);
        if (!controls?.seekToStep(Number(link.dataset.replayStep))) return;
        section.querySelectorAll<HTMLElement>("[data-replay-step]").forEach((entry) => entry.classList.toggle("is-current", entry.dataset.replayStep === link.dataset.replayStep));
    });
}
