// Verschiebbares Bedienfeld am unteren Rand (wie in Karten-Apps): Mini, halb, voll
import { h } from './ui.js';

export function createDock({ header, body, onChange }) {
  const grab = h('div', { class: 'grab' }, h('i'));
  const head = h('div', { class: 'dock-head' }, header);
  const bodyEl = h('div', { class: 'dock-body' }, body);
  const el = h('div', { class: 'dock' }, grab, head, bodyEl);
  let state = 'peek';
  let container = null;

  const heights = () => {
    const total = (el.parentElement?.clientHeight || window.innerHeight) - 0;
    const bar = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--tabbar-h')) || 62;
    const avail = total - bar - (parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--safe-bottom')) || 0);
    return { peek: 88, half: Math.round(avail * 0.46), full: Math.round(avail - 74) };
  };

  function apply(s, animate = true) {
    state = s;
    const hs = heights();
    el.classList.toggle('dragging', !animate);
    el.style.height = hs[s] + 'px';
    el.classList.toggle('full', s === 'full');
    document.documentElement.style.setProperty('--dock-h', hs[s] + 'px');
    document.body.dataset.dock = s;
    onChange?.(s, hs[s]);
  }

  let drag = null;
  const down = (e) => {
    if (e.target.closest('button, a, input')) return;
    drag = { y: e.clientY, h: el.getBoundingClientRect().height, moved: false, t: Date.now(), lastY: e.clientY, lastT: Date.now(), v: 0 };
    el.setPointerCapture?.(e.pointerId);
  };
  const move = (e) => {
    if (!drag) return;
    const dy = drag.y - e.clientY;
    if (Math.abs(dy) > 4) drag.moved = true;
    const hs = heights();
    const nh = Math.max(hs.peek - 10, Math.min(hs.full + 10, drag.h + dy));
    el.classList.add('dragging');
    el.style.height = nh + 'px';
    const now = Date.now();
    drag.v = (drag.lastY - e.clientY) / Math.max(1, now - drag.lastT);
    drag.lastY = e.clientY; drag.lastT = now;
  };
  const up = () => {
    if (!drag) return;
    const hs = heights();
    const cur = el.getBoundingClientRect().height;
    const d = drag;
    drag = null;
    el.classList.remove('dragging');
    if (!d.moved) { apply(state === 'peek' ? 'half' : state === 'full' ? 'half' : 'peek'); return; }
    const projected = cur + d.v * 220;
    let best = 'peek', bd = Infinity;
    for (const k of ['peek', 'half', 'full']) {
      const dist = Math.abs(hs[k] - projected);
      if (dist < bd) { bd = dist; best = k; }
    }
    apply(best);
  };
  for (const part of [grab, head]) part.addEventListener('pointerdown', down);
  // Der Zeiger wird am Dock „festgehalten“, deshalb kommen Bewegung und Loslassen dort an
  el.addEventListener('pointermove', move);
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
  window.addEventListener('resize', () => apply(state, false));

  return {
    el, head, body: bodyEl,
    get state() { return state; },
    set: apply,
    height: () => heights()[state],
    heights,
    destroy() { document.documentElement.style.removeProperty('--dock-h'); delete document.body.dataset.dock; },
  };
}
