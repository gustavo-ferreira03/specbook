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
        const trimmed = snapshot < 0 ? recorded : [
          ...recorded.slice(page, snapshot + 1),
          ...recorded.slice(0, page).filter((event) => event.type === 5).map((event) => ({ ...event, timestamp: recorded[snapshot].timestamp })),
          ...recorded.slice(snapshot + 1),
        ];
        if (!trimmed) throw new Error('invalid recording');
        // The page snapshot is often empty until the app renders; collapse the time before its first drawn frame so every replay opens on it at 00:00.
        const fullSnapshot = trimmed.findIndex((event) => event.type === 2);
        const drawsContent = (node) => (node.type === 3 && node.textContent?.trim()) || (node.type === 2 && /^(img|svg|input|button|canvas|video)$/.test(node.tagName));
        const mutations = trimmed.filter((event, index) => index > fullSnapshot && event.type === 3 && event.data?.source === 0 && event.data.adds?.length);
        // Frameworks add invisible nodes (e.g. Next's route announcer) before the page renders.
        const drawn = mutations.find((event) => event.data.adds.some((add) => drawsContent(add.node))) || mutations[0];
        // Let images and loading states settle briefly so the opening frame isn't mid-render.
        let firstFrame = drawn;
        for (let index = trimmed.indexOf(drawn) + 1; drawn && index < trimmed.length; index++) {
          const event = trimmed[index];
          if (event.type === 2 || event.type === 4 || event.timestamp > drawn.timestamp + 100) break;
          if (event.type === 3 && event.data?.source === 0) firstFrame = event;
        }
        const opening = firstFrame?.timestamp ?? trimmed[0].timestamp;
        const events = trimmed.map((event) => event.timestamp < opening ? { ...event, timestamp: opening } : event);
        const first = opening;
        const markers = new Map();
        // One marker per step, at its start and colored by its outcome.
        const outcomes = new Map(events.filter((event) => event.type === 5 && event.data.tag === 'specbook-step' && event.data.payload.phase === 'end').map((event) => [event.data.payload.number, event.data.payload.outcome]));
        let ordinal = 0;
        for (const event of events) {
          if (event.type !== 5 || event.data.tag !== 'specbook-step' || event.data.payload.phase !== 'start') continue;
          const step = event.data.payload;
          if (step.kind === 'step') ordinal += 1;
          const name = stepName(step, ordinal);
          const outcome = outcomes.get(step.number);
          markers.set(step.number, { offset: Math.max(0, event.timestamp - first), name, title: step.title, outcome });
        }
        const playerEvents = events.filter((event) => !(event.type === 5 && event.data.tag === 'specbook-step'));
        starts.set(section, markers);
        const target = replay.querySelector('.replay-player');
        const width = Math.max(280, Math.floor(target.getBoundingClientRect().width));
        const viewport = events.find((event) => event.type === 4)?.data || { width: 1280, height: 720 };
        const height = Math.max(180, Math.round(width * Math.min(1, viewport.height / viewport.width)));
        const Player = window.rrwebPlayer.default;
        const player = new Player({ target, props: { events: playerEvents, width, height, autoPlay: false, skipInactive: true, showController: false, showWarning: false, showDebug: false, UNSAFE_replayCanvas: false } });
        const replayer = player.getReplayer();
        const total = player.getMetaData().totalTime;
        const icons = {
          play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l10.5-6.5z"/></svg>',
          pause: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z"/></svg>',
          replay: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5V2L7 6l5 4V7a5 5 0 1 1-5 5H5a7 7 0 1 0 7-7z"/></svg>',
          expand: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5h5v2H7v3H5zm9 0h5v5h-2V7h-3zM5 14h2v3h3v2H5zm12 0h2v5h-5v-2h3z"/></svg>',
          collapse: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5h2v5H5V8h3zm6 0h2v3h3v2h-5zM5 14h5v5H8v-3H5zm9 0h5v2h-3v3h-2z"/></svg>',
        };
        const element = (tag, className, attributes = {}) => Object.assign(document.createElement(tag), { className }, attributes);
        // Clicking the frame plays or pauses; before the first play and at the end it shows a large play or replay button.
        const hit = element('button', 'replay-hit', { type: 'button' });
        const big = element('span', 'replay-big');
        hit.append(big);
        target.querySelector('.rr-player__frame').append(hit);
        const bar = element('div', 'replay-bar');
        const seek = element('div', 'replay-seek', { tabIndex: 0 });
        seek.setAttribute('role', 'slider');
        seek.setAttribute('aria-label', 'Replay timeline');
        seek.setAttribute('aria-valuemin', '0');
        seek.setAttribute('aria-valuemax', String(Math.ceil(total / 1000)));
        const track = element('div', 'replay-track');
        const fill = element('span', 'replay-fill');
        const knob = element('span', 'replay-knob');
        const percent = (offset) => (total > 0 ? 100 * Math.max(0, Math.min(total, offset)) / total : 0) + '%';
        const waitMs = Number(replay.dataset.waitMs);
        const failed = events.find((event) => event.type === 5 && event.data.payload?.phase === 'end' && event.data.payload?.outcome === 'failed');
        const failedStart = failed && markers.get(failed.data.payload.number);
        if (waitMs > 0 && failedStart) {
          const end = Math.min(total, failed.timestamp - first);
          const beginning = Math.max(failedStart.offset, end - waitMs);
          const span = element('span', 'replay-wait');
          span.style.left = percent(beginning);
          span.style.width = percent(end - beginning);
          track.append(span);
        }
        track.append(fill);
        const steps = [...markers.values()].sort((a, b) => a.offset - b.offset);
        for (const step of steps) {
          const mark = element('span', 'replay-mark is-' + (step.outcome || 'pending'));
          mark.style.left = percent(step.offset);
          mark.replayStep = step;
          track.append(mark);
        }
        track.append(knob);
        seek.append(track);
        const row = element('div', 'replay-row');
        const toggle = element('button', 'replay-button', { type: 'button' });
        const time = element('span', 'replay-time');
        const label = element('span', 'replay-label');
        const speed = element('button', 'replay-speed', { type: 'button', textContent: '1×' });
        speed.setAttribute('aria-label', 'Playback speed 1×');
        const expand = element('button', 'replay-button', { type: 'button', innerHTML: icons.expand });
        expand.setAttribute('aria-label', 'Full screen');
        row.append(toggle, time, label, element('span', 'replay-spacer'), speed, expand);
        bar.append(seek, row);
        target.after(bar);
        const clock = (ms) => { const seconds = Math.floor(Math.max(0, ms) / 1000); return Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0'); };
        let playing = false;
        let shownStep = null;
        const current = () => Math.max(0, Math.min(total, replayer.getCurrentTime()));
        const render = () => {
          const now = current();
          const ended = !playing && now >= total - 100;
          const idle = !playing && now < 50;
          replay.dataset.currentTimeMs = String(Math.round(now));
          fill.style.width = percent(now);
          knob.style.left = percent(now);
          seek.setAttribute('aria-valuenow', String(Math.round(now / 1000)));
          seek.setAttribute('aria-valuetext', clock(now) + ' of ' + clock(total));
          time.textContent = clock(now) + ' / ' + clock(total);
          const state = playing ? 'pause' : ended ? 'replay' : 'play';
          if (toggle.dataset.state !== state) {
            toggle.dataset.state = state;
            toggle.innerHTML = icons[state];
            toggle.setAttribute('aria-label', state === 'pause' ? 'Pause replay' : state === 'replay' ? 'Replay from the start' : 'Play replay');
          }
          hit.classList.toggle('is-idle', idle);
          hit.classList.toggle('is-ended', ended);
          big.innerHTML = ended ? icons.replay : idle ? icons.play : '';
          hit.setAttribute('aria-label', playing ? 'Pause replay' : ended ? 'Replay from the start' : 'Play replay');
          const step = steps.filter((entry) => entry.offset <= now + 1).pop() || null;
          if (step !== shownStep) {
            shownStep = step;
            label.replaceChildren();
            if (step) label.append(element('b', '', { textContent: step.name }), ' · ' + step.title);
          }
        };
        let frame = 0;
        const loop = () => { render(); frame = playing ? requestAnimationFrame(loop) : 0; };
        const setPlaying = (value) => { playing = value; if (playing && !frame) frame = requestAnimationFrame(loop); render(); };
        replayer.on('start', () => setPlaying(true));
        replayer.on('resume', () => setPlaying(true));
        replayer.on('pause', () => setPlaying(false));
        replayer.on('finish', () => setPlaying(false));
        // rrweb only rebuilds the opening frame for offsets after its first event.
        const goto = (offset, play = false) => { player.goto(Math.max(1, Math.min(total, offset)), play); requestAnimationFrame(render); };
        const playPause = () => {
          if (playing) player.pause();
          else if (current() >= total - 100) goto(0, true);
          else player.play();
        };
        toggle.addEventListener('click', playPause);
        hit.addEventListener('click', playPause);
        const speeds = [1, 2, 4];
        speed.addEventListener('click', () => {
          const next = speeds[(speeds.indexOf(Number(speed.dataset.speed || 1)) + 1) % speeds.length];
          speed.dataset.speed = String(next);
          speed.textContent = next + '×';
          speed.setAttribute('aria-label', 'Playback speed ' + next + '×');
          player.setSpeed(next);
        });
        expand.addEventListener('click', () => { if (document.fullscreenElement === replay) document.exitFullscreen(); else replay.requestFullscreen?.(); });
        seek.addEventListener('keydown', (event) => {
          const now = current();
          const next = event.key === 'ArrowRight' ? now + 1000 : event.key === 'ArrowLeft' ? now - 1000 : event.key === 'Home' ? 0 : event.key === 'End' ? total : null;
          if (next === null) return;
          event.preventDefault();
          goto(next, playing);
        });
        // Dragging scrubs, then resumes if it was playing.
        let dragging = false;
        let resume = false;
        let pending = 0;
        let scrubFrame = 0;
        const scrub = (clientX) => {
          const rect = track.getBoundingClientRect();
          pending = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)) * total;
          fill.style.width = percent(pending);
          knob.style.left = percent(pending);
          if (!scrubFrame) scrubFrame = requestAnimationFrame(() => { scrubFrame = 0; player.goto(Math.max(1, pending), false); render(); });
        };
        seek.addEventListener('pointerdown', (event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          seek.focus();
          dragging = true;
          resume = playing;
          if (playing) player.pause();
          seek.setPointerCapture(event.pointerId);
          seek.classList.add('is-dragging');
          scrub(event.clientX);
        });
        seek.addEventListener('pointermove', (event) => { if (dragging) scrub(event.clientX); });
        const release = (event) => {
          if (!dragging) return;
          dragging = false;
          seek.classList.remove('is-dragging');
          if (seek.hasPointerCapture(event.pointerId)) seek.releasePointerCapture(event.pointerId);
          cancelAnimationFrame(scrubFrame);
          scrubFrame = 0;
          goto(pending, resume);
        };
        seek.addEventListener('pointerup', release);
        seek.addEventListener('pointercancel', release);
        const tip = element('div', 'replay-tip');
        tip.setAttribute('role', 'tooltip');
        replay.append(tip);
        seek.addEventListener('pointerover', (event) => {
          const mark = event.target.closest('.replay-mark');
          if (!mark) return;
          const step = mark.replayStep;
          tip.replaceChildren(element('b', '', { textContent: step.name }), ' ' + step.title);
          if (step.outcome) tip.append(element('span', 'replay-tip-' + step.outcome, { textContent: step.outcome[0].toUpperCase() + step.outcome.slice(1) }));
          tip.classList.add('is-visible');
          const box = mark.getBoundingClientRect();
          const area = replay.getBoundingClientRect();
          tip.style.left = Math.max(tip.offsetWidth / 2, Math.min(area.width - tip.offsetWidth / 2, box.left + box.width / 2 - area.left)) + 'px';
          tip.style.top = (box.top - area.top - tip.offsetHeight - 8) + 'px';
        });
        seek.addEventListener('pointerout', (event) => { if (event.target.closest('.replay-mark')) tip.classList.remove('is-visible'); });
        goto(0);
        replay.querySelector('.replay-status').hidden = true;
        const resize = () => {
          let nextWidth = Math.floor(target.getBoundingClientRect().width);
          if (!section.open || nextWidth < 1) return;
          const ratio = Math.min(1, viewport.height / viewport.width);
          if (document.fullscreenElement === replay) nextWidth = Math.min(nextWidth, Math.floor((window.innerHeight - bar.offsetHeight - 32) / ratio));
          player.$set({ width: nextWidth, height: Math.max(180, Math.round(nextWidth * ratio)) });
          replay.style.setProperty('--replay-width', (nextWidth + 2) + 'px');
          player.triggerResize();
          render();
        };
        new ResizeObserver(resize).observe(target);
        document.addEventListener('fullscreenchange', () => {
          const full = document.fullscreenElement === replay;
          expand.innerHTML = full ? icons.collapse : icons.expand;
          expand.setAttribute('aria-label', full ? 'Exit full screen' : 'Full screen');
          resize();
        });
        section.addEventListener('toggle', () => { if (!section.open) player.pause(); else resize(); });
        return { goto };
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
      const controls = await load(section);
      const marker = starts.get(section)?.get(Number(link.dataset.replayStep));
      if (!controls || !marker) return;
      controls.goto(marker.offset);
      section.querySelectorAll('[data-replay-step]').forEach((entry) => entry.classList.toggle('is-current', entry.dataset.replayStep === link.dataset.replayStep));
      section.querySelector('.replay').dataset.currentStep = link.dataset.replayStep;
    });
  }
})();
`;
