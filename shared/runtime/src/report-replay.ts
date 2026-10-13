import { restoreReplayEvents } from "./replay-assets.ts";

export const REPORT_REPLAY_SCRIPT = String.raw`
(() => {
  const instances = new WeakMap();
  const starts = new WeakMap();
  const restoreReplayEvents = ${restoreReplayEvents.toString()};
  let library;
  async function decompress(value) {
    if (!window.DecompressionStream) throw new Error('unsupported browser');
    const bytes = Uint8Array.from(atob(value.trim()), (char) => char.charCodeAt(0));
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new Response(stream).text();
  }
  function loadLibrary() {
    return library ??= (async () => {
      const source = await decompress(document.getElementById('specbook-replay-library').textContent);
      const script = document.createElement('script');
      script.textContent = source;
      document.head.append(script);
      if (!window.rrwebPlayer) throw new Error('player unavailable');
    })();
  }
  const kindLabels = { precondition: 'Precondition', expected: 'Expected result', postcondition: 'Postcondition' };
  const stepName = (step, ordinal) => step.kind === 'step' ? 'Step ' + ordinal : kindLabels[step.kind] || 'Step';
  async function load(section) {
    if (instances.has(section)) return instances.get(section);
    const task = (async () => {
      const replay = section.querySelector('.replay');
      const status = replay.querySelector('.replay-status');
      try {
        await loadLibrary();
        const recorded = restoreReplayEvents(JSON.parse(await decompress(replay.querySelector('.replay-data').textContent)));
        // Recording starts on the blank tab; start the replay at the first real page and keep step markers from before it.
        const page = recorded.findIndex((event) => event.type === 4 && /^https?:/.test(event.data?.href || ''));
        const snapshot = page < 0 ? -1 : recorded.findIndex((event, index) => index > page && event.type === 2);
        const events = snapshot < 0 ? recorded : [
          ...recorded.slice(page, snapshot + 1),
          ...recorded.slice(0, page).filter((event) => event.type === 5).map((event) => ({ ...event, timestamp: recorded[snapshot].timestamp })),
          ...recorded.slice(snapshot + 1),
        ];
        if (!events) throw new Error('invalid recording');
        const first = events[0].timestamp;
        const markers = new Map();
        const tags = {};
        let ordinal = 0;
        for (const event of events) {
          if (event.type !== 5 || event.data.tag !== 'specbook-step') continue;
          const step = event.data.payload;
          if (step.phase === 'start' && step.kind === 'step') ordinal += 1;
          const name = stepName(step, ordinal);
          event.data.tag = name + ': ' + step.title + (step.phase === 'end' ? ' (' + step.outcome + ')' : '');
          tags[event.data.tag] = step.outcome === 'failed' ? '#bd5149' : step.phase === 'end' ? '#1f7a4d' : '#6b6b6b';
          if (step.phase === 'start') markers.set(step.number, { offset: Math.max(0, event.timestamp - first), name, title: step.title });
        }
        starts.set(section, markers);
        const target = replay.querySelector('.replay-player');
        const width = Math.max(280, Math.floor(target.getBoundingClientRect().width));
        const viewport = events.find((event) => event.type === 4)?.data || { width: 1280, height: 720 };
        const height = Math.max(180, Math.round(width * Math.min(1, viewport.height / viewport.width)));
        const Player = window.rrwebPlayer.default;
        const player = new Player({ target, props: { events, width, height, autoPlay: false, skipInactive: true, speedOption: [1, 2, 4, 8], tags, inactiveColor: '#ebebeb', showWarning: false, showDebug: false, UNSAFE_replayCanvas: false } });
        const progress = target.querySelector('.rr-progress');
        const total = player.getMetaData().totalTime;
        const waitMs = Number(replay.dataset.waitMs);
        if (waitMs > 0 && total > 0) {
          const failed = events.find((event) => event.type === 5 && event.data.payload?.phase === 'end' && event.data.payload?.outcome === 'failed');
          const start = failed && markers.get(failed.data.payload.number);
          if (start) {
            const end = Math.min(total, failed.timestamp - first);
            const beginning = Math.max(start.offset, end - waitMs);
            const span = document.createElement('span');
            span.className = 'replay-wait';
            span.style.left = (100 * beginning / total) + '%';
            span.style.width = (100 * (end - beginning) / total) + '%';
            span.setAttribute('aria-hidden', 'true');
            progress.insertBefore(span, progress.querySelector('[title], .rr-progress__handler'));
          }
        }
        progress.tabIndex = 0;
        progress.setAttribute('role', 'slider');
        progress.setAttribute('aria-label', 'Replay timeline');
        progress.setAttribute('aria-valuemin', '0');
        progress.setAttribute('aria-valuemax', String(Math.ceil(total / 1000)));
        progress.setAttribute('aria-valuenow', '0');
        player.addEventListener('ui-update-current-time', (event) => {
          replay.dataset.currentTimeMs = String(event.payload);
          progress.setAttribute('aria-valuenow', String(Math.round(event.payload / 1000)));
        });
        progress.addEventListener('keydown', (event) => {
          const current = player.getReplayer().getCurrentTime();
          const next = event.key === 'ArrowRight' ? current + 1000 : event.key === 'ArrowLeft' ? current - 1000 : event.key === 'Home' ? 0 : event.key === 'End' ? total : null;
          if (next === null) return;
          event.preventDefault();
          player.goto(Math.max(0, Math.min(total, next)), false);
        });
        // The page snapshot is often empty until the app renders; open paused on its first drawn frame.
        const start = events.findIndex((event) => event.type === 2);
        const firstFrame = events.find((event, index) => index > start && event.type === 3 && event.data?.source === 0 && event.data.adds?.length);
        const firstOffset = firstFrame ? firstFrame.timestamp - first + 1 : 0;
        let moved = false;
        player.addEventListener('ui-update-player-state', (event) => { if (event.payload === 'playing') moved = true; });
        // rrweb-player only seeks on click; dragging the handle scrubs, then resumes if it was playing.
        let playing = false;
        player.addEventListener('ui-update-player-state', (event) => { playing = event.payload === 'playing'; });
        let dragging = false;
        let resume = false;
        let pending = 0;
        let frame = 0;
        const scrub = (clientX) => {
          const rect = progress.getBoundingClientRect();
          pending = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)) * total;
          if (!frame) frame = requestAnimationFrame(() => { frame = 0; player.goto(pending, false); });
        };
        progress.addEventListener('pointerdown', (event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          dragging = true;
          moved = true;
          resume = playing;
          progress.setPointerCapture(event.pointerId);
          progress.classList.add('is-dragging');
          scrub(event.clientX);
        });
        progress.addEventListener('pointermove', (event) => { if (dragging) scrub(event.clientX); });
        const release = (event) => {
          if (!dragging) return;
          dragging = false;
          progress.classList.remove('is-dragging');
          if (progress.hasPointerCapture(event.pointerId)) progress.releasePointerCapture(event.pointerId);
          cancelAnimationFrame(frame);
          frame = 0;
          player.goto(pending, resume);
        };
        progress.addEventListener('pointerup', release);
        progress.addEventListener('pointercancel', release);
        const showFirstFrame = () => { if (!moved && player.getReplayer().getCurrentTime() < firstOffset) player.goto(firstOffset, false); };
        showFirstFrame();
        replay.querySelector('.replay-status').hidden = true;
        const resize = () => {
          const nextWidth = Math.floor(target.getBoundingClientRect().width);
          if (!section.open || nextWidth < 1) return;
          player.$set({ width: nextWidth, height: Math.max(180, Math.round(nextWidth * Math.min(1, viewport.height / viewport.width))) });
          player.triggerResize();
          showFirstFrame();
        };
        new ResizeObserver(resize).observe(target);
        section.addEventListener('toggle', () => { if (!section.open) player.pause(); else resize(); });
        const controls = [...target.querySelectorAll('.rr-controller__btns button')];
        for (const [index, button] of controls.entries()) {
          button.setAttribute('aria-label', button.textContent.trim() ? 'Replay speed ' + button.textContent.trim() : index === 0 ? 'Play or pause replay' : 'Full screen replay');
        }
        return player;
      } catch {
        status.textContent = 'Replay could not be loaded. Open this report in a current browser.';
        status.setAttribute('role', 'status');
        return null;
      }
    })();
    instances.set(section, task);
    return task;
  }
  for (const section of document.querySelectorAll('.spec:has(.replay)')) {
    section.addEventListener('toggle', () => { if (section.open) load(section); });
    if (section.open) load(section);
    section.addEventListener('click', async (event) => {
      const link = event.target.closest('[data-replay-step]');
      if (!link) return;
      if (!link.classList.contains('zoom')) event.preventDefault();
      const player = await load(section);
      const marker = starts.get(section)?.get(Number(link.dataset.replayStep));
      if (!player || !marker) return;
      player.goto(marker.offset, false);
      section.querySelectorAll('[data-replay-step]').forEach((entry) => entry.classList.toggle('is-current', entry.dataset.replayStep === link.dataset.replayStep));
      section.querySelector('.replay').dataset.currentStep = link.dataset.replayStep;
    });
  }
})();
`;
