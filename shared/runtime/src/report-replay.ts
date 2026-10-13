export const REPORT_REPLAY_SCRIPT = String.raw`
(() => {
  const instances = new WeakMap();
  const starts = new WeakMap();
  const kindLabels = { precondition: 'Precondition', expected: 'Expected result', postcondition: 'Postcondition' };
  const stepName = (step, ordinal) => step.kind === 'step' ? 'Step ' + ordinal : kindLabels[step.kind] || 'Step';
  async function load(section) {
    if (instances.has(section)) return instances.get(section);
    const task = (async () => {
      const replay = section.querySelector('.replay');
      const status = replay.querySelector('.replay-status');
      try {
        if (!window.rrwebPlayer || !window.DecompressionStream) throw new Error('unsupported browser');
        const bytes = Uint8Array.from(atob(replay.querySelector('.replay-data').textContent.trim()), (char) => char.charCodeAt(0));
        const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
        const events = JSON.parse(await new Response(stream).text());
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
        replay.querySelector('.replay-status').hidden = true;
        const buttons = replay.querySelector('.replay-steps');
        for (const [number, marker] of markers) {
          const button = document.createElement('button');
          button.type = 'button';
          button.dataset.replayStep = number;
          button.textContent = marker.name;
          button.title = marker.title;
          button.setAttribute('aria-label', 'Replay ' + marker.name + ': ' + marker.title);
          buttons.append(button);
        }
        const resize = () => {
          const nextWidth = Math.floor(target.getBoundingClientRect().width);
          if (!section.open || nextWidth < 1) return;
          player.$set({ width: nextWidth, height: Math.max(180, Math.round(nextWidth * Math.min(1, viewport.height / viewport.width))) });
          player.triggerResize();
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
      event.preventDefault();
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
