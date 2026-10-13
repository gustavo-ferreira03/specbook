import type RRWebPlayer from "rrweb-player";
import { restoreReplayEvents, type ReplayEvent } from "./replay-assets.ts";
import { REPLAY_MASK_ATTRIBUTE } from "./replay-constants.ts";

export interface ReplayStepMarker {
    number: number;
    offset: number;
    name: string;
    title: string;
    outcome?: string;
}

export interface ReplayPlayerOptions {
    recording: unknown;
    Player: typeof RRWebPlayer;
    waitMs?: number;
    onStep?: (step: ReplayStepMarker | null) => void;
}

export interface ReplayController {
    seekToStep(number: number): boolean;
    pause(): void;
    resize(): void;
    destroy(): void;
}

interface RecordedNode {
    type: number;
    textContent?: string;
    tagName?: string;
}

interface StepEvent {
    phase: string;
    number: number;
    kind: string;
    title: string;
    outcome?: string;
}

type RecordedEvent = ReplayEvent & {
    data: {
        href?: string;
        width?: number;
        height?: number;
        source?: number;
        adds?: { node: RecordedNode }[];
        tag?: string;
        payload?: StepEvent;
    };
};

const KIND_LABELS: Record<string, string> = { precondition: "Precondition", expected: "Expected result", postcondition: "Postcondition" };

export function stepName(step: { kind: string }, ordinal: number): string {
    return step.kind === "step" ? `Step ${ordinal}` : KIND_LABELS[step.kind] || "Step";
}

export function assertionWait(reason: string | null): { ms: number; summary: string } | null {
    if (!reason?.includes("expect(locator).toHaveCount(expected) failed")) return null;
    const expected = reason.match(/^Expected:\s*(\d+)\s*$/m)?.[1];
    const received = reason.match(/^Received:\s*(\d+)\s*$/m)?.[1];
    const timeout = reason.match(/^Timeout:\s*(\d+)ms\s*$/m)?.[1];
    if (expected === undefined || received === undefined || timeout === undefined) return null;
    const ms = Number(timeout);
    if (!Number.isSafeInteger(ms) || ms < 1) return null;
    const elapsed = ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
    return { ms, summary: `Waited ${elapsed} for ${expected} element${expected === "1" ? "" : "s"}; saw ${received}` };
}

function prepareRecording(recording: unknown): { events: RecordedEvent[]; markers: Map<number, ReplayStepMarker>; opening: number } {
    const restored = restoreReplayEvents(recording);
    if (!restored) throw new Error("Invalid replay recording");
    const recorded = restored as RecordedEvent[];
    // Preserve step markers from the blank tab, but open on the first real page.
    const page = recorded.findIndex((event) => event.type === 4 && /^https?:/.test(event.data?.href || ""));
    const snapshot = page < 0 ? -1 : recorded.findIndex((event, index) => index > page && event.type === 2);
    const trimmed = snapshot < 0 ? recorded : [
        ...recorded.slice(page, snapshot + 1),
        ...recorded.slice(0, page).filter((event) => event.type === 5).map((event) => ({ ...event, timestamp: recorded[snapshot].timestamp })),
        ...recorded.slice(snapshot + 1),
    ];
    const fullSnapshot = trimmed.findIndex((event) => event.type === 2);
    const drawsContent = (node: RecordedNode) => node.type === 3 && node.textContent?.trim()
        || node.type === 2 && /^(img|svg|input|button|canvas|video)$/.test(node.tagName || "");
    const mutations = trimmed.filter((event, index) => index > fullSnapshot && event.type === 3 && event.data?.source === 0 && event.data.adds?.length);
    // Frameworks can add invisible nodes before the first drawn frame.
    const drawn = mutations.find((event) => event.data.adds!.some((add) => drawsContent(add.node))) || mutations[0];
    let firstFrame = drawn;
    for (let index = trimmed.indexOf(drawn) + 1; drawn && index < trimmed.length; index++) {
        const event = trimmed[index];
        if (event.type === 2 || event.type === 4 || event.timestamp > drawn.timestamp + 100) break;
        if (event.type === 3 && event.data?.source === 0) firstFrame = event;
    }
    const opening = firstFrame?.timestamp ?? trimmed[0].timestamp;
    const events = trimmed.map((event) => event.timestamp < opening ? { ...event, timestamp: opening } : event);
    const markers = new Map<number, ReplayStepMarker>();
    const outcomes = new Map(events
        .filter((event) => event.type === 5 && event.data?.tag === "specbook-step" && event.data.payload?.phase === "end")
        .map((event) => [event.data.payload!.number, event.data.payload!.outcome]));
    let ordinal = 0;
    for (const event of events) {
        if (event.type !== 5 || event.data?.tag !== "specbook-step" || event.data.payload?.phase !== "start") continue;
        const step = event.data.payload;
        if (step.kind === "step") ordinal += 1;
        markers.set(step.number, { number: step.number, offset: Math.max(0, event.timestamp - opening), name: stepName(step, ordinal), title: step.title, outcome: outcomes.get(step.number) });
    }
    return { events, markers, opening };
}

const ICONS = {
    play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l10.5-6.5z"/></svg>',
    pause: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z"/></svg>',
    replay: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5V2L7 6l5 4V7a5 5 0 1 1-5 5H5a7 7 0 1 0 7-7z"/></svg>',
    expand: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5h5v2H7v3H5zm9 0h5v5h-2V7h-3zM5 14h2v3h3v2H5zm12 0h2v5h-5v-2h3z"/></svg>',
    collapse: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5h2v5H5V8h3zm6 0h2v3h3v2h-5zM5 14h5v5H8v-3H5zm9 0h5v2h-3v3h-2z"/></svg>',
};

export function mountReplay(container: HTMLElement, options: ReplayPlayerOptions): ReplayController {
    const { events, markers, opening } = prepareRecording(options.recording);
    const document = container.ownerDocument;
    const window = document.defaultView!;
    const controller = new AbortController();
    const element = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string, attributes: Partial<HTMLElementTagNameMap[K]> = {}): HTMLElementTagNameMap[K] => Object.assign(document.createElement(tag), { className }, attributes);
    const listen = <K extends keyof HTMLElementEventMap>(node: HTMLElement, type: K, callback: (event: HTMLElementEventMap[K]) => void) => node.addEventListener(type, callback, { signal: controller.signal });
    container.classList.add("replay");
    let target = container.querySelector<HTMLElement>(".replay-player");
    const createdTarget = !target;
    if (!target) {
        target = element("div", "replay-player");
        container.append(target);
    }
    const width = Math.max(280, Math.floor(target.getBoundingClientRect().width));
    const viewport = events.find((event) => event.type === 4)?.data;
    const ratio = Math.min(1, (viewport?.height || 720) / (viewport?.width || 1280));
    const height = Math.max(180, Math.round(width * ratio));
    const playerEvents = events.filter((event) => !(event.type === 5 && event.data?.tag === "specbook-step"));
    const player = new options.Player({ target, props: {
        events: playerEvents as ConstructorParameters<typeof RRWebPlayer>[0]["props"]["events"], width, height,
        insertStyleRules: [`[${REPLAY_MASK_ATTRIBUTE}]{-webkit-text-security:disc!important}`],
        autoPlay: false, skipInactive: true, showController: false, showWarning: false, showDebug: false, UNSAFE_replayCanvas: false,
    } }) as RRWebPlayer & { $set(props: { width: number; height: number }): void; $destroy(): void };
    const replayer = player.getReplayer();
    const total = player.getMetaData().totalTime;
    const hit = element("button", "replay-hit", { type: "button" });
    const big = element("span", "replay-big");
    hit.append(big);
    target.querySelector(".rr-player__frame")!.append(hit);
    const bar = element("div", "replay-bar");
    const seek = element("div", "replay-seek", { tabIndex: 0 });
    seek.setAttribute("role", "slider");
    seek.setAttribute("aria-label", "Replay timeline");
    seek.setAttribute("aria-valuemin", "0");
    seek.setAttribute("aria-valuemax", String(Math.ceil(total / 1000)));
    const track = element("div", "replay-track");
    const fill = element("span", "replay-fill");
    const knob = element("span", "replay-knob");
    const percent = (offset: number) => `${total > 0 ? 100 * Math.max(0, Math.min(total, offset)) / total : 0}%`;
    const failed = events.find((event) => event.type === 5 && event.data?.payload?.phase === "end" && event.data.payload.outcome === "failed");
    const failedStart = failed && markers.get(failed.data.payload!.number);
    if ((options.waitMs || 0) > 0 && failedStart) {
        const end = Math.min(total, failed!.timestamp - opening);
        const beginning = Math.max(failedStart.offset, end - options.waitMs!);
        const span = element("span", "replay-wait");
        span.style.left = percent(beginning);
        span.style.width = percent(end - beginning);
        track.append(span);
    }
    track.append(fill);
    const steps = [...markers.values()].sort((a, b) => a.offset - b.offset);
    const markSteps = new WeakMap<Element, ReplayStepMarker>();
    for (const step of steps) {
        const mark = element("span", `replay-mark is-${step.outcome || "pending"}`);
        mark.style.left = percent(step.offset);
        markSteps.set(mark, step);
        track.append(mark);
    }
    track.append(knob);
    seek.append(track);
    const row = element("div", "replay-row");
    const toggle = element("button", "replay-button", { type: "button" });
    const time = element("span", "replay-time");
    const label = element("span", "replay-label");
    const speed = element("button", "replay-speed", { type: "button", textContent: "1×" });
    speed.setAttribute("aria-label", "Playback speed 1×");
    const expand = element("button", "replay-button", { type: "button", innerHTML: ICONS.expand });
    expand.setAttribute("aria-label", "Full screen");
    row.append(toggle, time, label, element("span", "replay-spacer"), speed, expand);
    bar.append(seek, row);
    target.after(bar);
    const clock = (ms: number) => {
        const seconds = Math.floor(Math.max(0, ms) / 1000);
        return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
    };
    let destroyed = false;
    let playing = false;
    let shownStep: ReplayStepMarker | null = null;
    const current = () => Math.max(0, Math.min(total, replayer.getCurrentTime()));
    const render = () => {
        if (destroyed) return;
        const now = current();
        const ended = !playing && now >= total - 100;
        const idle = !playing && now < 50;
        container.dataset.currentTimeMs = String(Math.round(now));
        fill.style.width = percent(now);
        knob.style.left = percent(now);
        seek.setAttribute("aria-valuenow", String(Math.round(now / 1000)));
        seek.setAttribute("aria-valuetext", `${clock(now)} of ${clock(total)}`);
        time.textContent = `${clock(now)} / ${clock(total)}`;
        const state = playing ? "pause" : ended ? "replay" : "play";
        if (toggle.dataset.state !== state) {
            toggle.dataset.state = state;
            toggle.innerHTML = ICONS[state];
            toggle.setAttribute("aria-label", state === "pause" ? "Pause replay" : state === "replay" ? "Replay from the start" : "Play replay");
        }
        hit.classList.toggle("is-idle", idle);
        hit.classList.toggle("is-ended", ended);
        big.innerHTML = ended ? ICONS.replay : idle ? ICONS.play : "";
        hit.setAttribute("aria-label", playing ? "Pause replay" : ended ? "Replay from the start" : "Play replay");
        const step = steps.filter((entry) => entry.offset <= now + 1).pop() || null;
        if (step !== shownStep) {
            shownStep = step;
            label.replaceChildren();
            if (step) label.append(element("b", "", { textContent: step.name }), ` · ${step.title}`);
            options.onStep?.(step);
        }
    };
    let frame = 0;
    let renderFrame = 0;
    const loop = () => { render(); frame = playing && !destroyed ? window.requestAnimationFrame(loop) : 0; };
    const setPlaying = (value: boolean) => {
        if (destroyed) return;
        playing = value;
        if (playing && !frame) frame = window.requestAnimationFrame(loop);
        render();
    };
    const onStart = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    replayer.on("start", onStart);
    replayer.on("resume", onStart);
    replayer.on("pause", onPause);
    replayer.on("finish", onPause);
    // rrweb rebuilds the opening frame only after the first event.
    const goto = (offset: number, play = false) => {
        if (destroyed) return;
        player.goto(Math.max(1, Math.min(total, offset)), play);
        window.cancelAnimationFrame(renderFrame);
        renderFrame = window.requestAnimationFrame(() => { renderFrame = 0; render(); });
    };
    const playPause = () => {
        if (playing) player.pause();
        else if (current() >= total - 100) goto(0, true);
        else player.play();
    };
    listen(toggle, "click", playPause);
    listen(hit, "click", playPause);
    const speeds = [1, 2, 4];
    listen(speed, "click", () => {
        const next = speeds[(speeds.indexOf(Number(speed.dataset.speed || 1)) + 1) % speeds.length];
        speed.dataset.speed = String(next);
        speed.textContent = `${next}×`;
        speed.setAttribute("aria-label", `Playback speed ${next}×`);
        player.setSpeed(next);
    });
    listen(expand, "click", () => {
        if (document.fullscreenElement === container) void document.exitFullscreen();
        else void container.requestFullscreen?.();
    });
    listen(seek, "keydown", (event) => {
        const now = current();
        const next = event.key === "ArrowRight" ? now + 1000 : event.key === "ArrowLeft" ? now - 1000 : event.key === "Home" ? 0 : event.key === "End" ? total : null;
        if (next === null) return;
        event.preventDefault();
        goto(next, playing);
    });
    let dragging = false;
    let resume = false;
    let pending = 0;
    let scrubFrame = 0;
    const scrub = (clientX: number) => {
        const rect = track.getBoundingClientRect();
        pending = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)) * total;
        fill.style.width = percent(pending);
        knob.style.left = percent(pending);
        if (!scrubFrame) scrubFrame = window.requestAnimationFrame(() => {
            scrubFrame = 0;
            if (destroyed) return;
            player.goto(Math.max(1, pending), false);
            render();
        });
    };
    listen(seek, "pointerdown", (event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        seek.focus();
        dragging = true;
        resume = playing;
        if (playing) player.pause();
        seek.setPointerCapture(event.pointerId);
        seek.classList.add("is-dragging");
        scrub(event.clientX);
    });
    listen(seek, "pointermove", (event) => { if (dragging) scrub(event.clientX); });
    const release = (event: PointerEvent) => {
        if (!dragging) return;
        dragging = false;
        seek.classList.remove("is-dragging");
        if (seek.hasPointerCapture(event.pointerId)) seek.releasePointerCapture(event.pointerId);
        window.cancelAnimationFrame(scrubFrame);
        scrubFrame = 0;
        goto(pending, resume);
    };
    listen(seek, "pointerup", release);
    listen(seek, "pointercancel", release);
    const tip = element("div", "replay-tip");
    tip.setAttribute("role", "tooltip");
    container.append(tip);
    listen(seek, "pointerover", (event) => {
        const mark = event.target instanceof Element ? event.target.closest(".replay-mark") : null;
        const step = mark && markSteps.get(mark);
        if (!mark || !step) return;
        tip.replaceChildren(element("b", "", { textContent: step.name }), ` ${step.title}`);
        if (step.outcome) tip.append(element("span", `replay-tip-${step.outcome}`, { textContent: step.outcome[0].toUpperCase() + step.outcome.slice(1) }));
        tip.classList.add("is-visible");
        const box = mark.getBoundingClientRect();
        const area = container.getBoundingClientRect();
        tip.style.left = `${Math.max(tip.offsetWidth / 2, Math.min(area.width - tip.offsetWidth / 2, box.left + box.width / 2 - area.left))}px`;
        tip.style.top = `${box.top - area.top - tip.offsetHeight - 8}px`;
    });
    listen(seek, "pointerout", (event) => {
        if (event.target instanceof Element && event.target.closest(".replay-mark")) tip.classList.remove("is-visible");
    });
    const resize = () => {
        if (destroyed) return;
        let nextWidth = Math.floor(target.getBoundingClientRect().width);
        if (nextWidth < 1) return;
        if (document.fullscreenElement === container) nextWidth = Math.min(nextWidth, Math.floor((window.innerHeight - bar.offsetHeight - 32) / ratio));
        player.$set({ width: nextWidth, height: Math.max(180, Math.round(nextWidth * ratio)) });
        container.style.setProperty("--replay-width", `${nextWidth + 2}px`);
        player.triggerResize();
        render();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(target);
    document.addEventListener("fullscreenchange", () => {
        const full = document.fullscreenElement === container;
        expand.innerHTML = full ? ICONS.collapse : ICONS.expand;
        expand.setAttribute("aria-label", full ? "Exit full screen" : "Full screen");
        resize();
    }, { signal: controller.signal });
    goto(0);
    const status = container.querySelector<HTMLElement>(".replay-status");
    if (status) status.hidden = true;
    return {
        seekToStep(number) {
            const marker = markers.get(number);
            if (!marker || destroyed) return false;
            goto(marker.offset);
            container.dataset.currentStep = String(number);
            return true;
        },
        pause() { if (!destroyed) player.pause(); },
        resize,
        destroy() {
            if (destroyed) return;
            destroyed = true;
            controller.abort();
            observer.disconnect();
            window.cancelAnimationFrame(frame);
            window.cancelAnimationFrame(renderFrame);
            window.cancelAnimationFrame(scrubFrame);
            replayer.off("start", onStart);
            replayer.off("resume", onStart);
            replayer.off("pause", onPause);
            replayer.off("finish", onPause);
            if (document.fullscreenElement === container) void document.exitFullscreen();
            replayer.destroy();
            player.$destroy();
            bar.remove();
            tip.remove();
            if (createdTarget) target.remove();
            delete container.dataset.currentTimeMs;
            delete container.dataset.currentStep;
            container.style.removeProperty("--replay-width");
        },
    };
}
