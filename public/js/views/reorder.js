// Stopps per Griff umsortieren (Touch und Maus), mit automatischem Scrollen
export function enableReorder(list, scroller, { onDrop }) {
  let drag = null;

  function onDown(e) {
    const handle = e.target.closest('.handle');
    if (!handle || !list.contains(handle)) return;
    const item = handle.closest('.stop');
    if (!item) return;
    e.preventDefault();
    list.classList.add('sorting');
    const items = [...list.querySelectorAll('.stop')];
    const index = items.indexOf(item);
    const slot = items.length > 1 ? items[1].offsetTop - items[0].offsetTop : item.offsetHeight + 8;
    drag = { item, items, index, target: index, slot, startY: e.clientY, startScroll: scroller.scrollTop, pointerId: e.pointerId, y: e.clientY, raf: 0 };
    item.classList.add('drag');
    handle.setPointerCapture?.(e.pointerId);
    navigator.vibrate?.(12);
    drag.raf = requestAnimationFrame(tick);
  }

  function update() {
    const d = drag;
    const dy = d.y - d.startY + (scroller.scrollTop - d.startScroll);
    d.item.style.transform = `translateY(${dy}px)`;
    const target = Math.max(0, Math.min(d.items.length - 1, Math.round(d.index + dy / d.slot)));
    d.target = target;
    d.items.forEach((el, i) => {
      if (el === d.item) return;
      let shift = 0;
      if (d.index < target && i > d.index && i <= target) shift = -d.slot;
      if (d.index > target && i < d.index && i >= target) shift = d.slot;
      el.style.transform = shift ? `translateY(${shift}px)` : '';
    });
  }

  function tick() {
    if (!drag) return;
    const r = scroller.getBoundingClientRect();
    const edge = 56;
    if (drag.y < r.top + edge) scroller.scrollTop -= Math.ceil((r.top + edge - drag.y) / 6);
    else if (drag.y > r.bottom - edge) scroller.scrollTop += Math.ceil((drag.y - (r.bottom - edge)) / 6);
    update();
    drag.raf = requestAnimationFrame(tick);
  }

  function onMove(e) {
    if (!drag || e.pointerId !== drag.pointerId) return;
    drag.y = e.clientY;
  }

  function end(e) {
    if (!drag || (e && e.pointerId !== drag.pointerId)) return;
    const d = drag;
    drag = null;
    cancelAnimationFrame(d.raf);
    d.items.forEach((el) => { el.style.transform = ''; el.classList.remove('drag'); });
    list.classList.remove('sorting');
    if (d.target !== d.index) {
      const ids = d.items.map((el) => el.dataset.id);
      const [moved] = ids.splice(d.index, 1);
      ids.splice(d.target, 0, moved);
      onDrop(ids);
    }
  }

  list.addEventListener('pointerdown', onDown);
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', end);
  window.addEventListener('pointercancel', end);
  return () => {
    list.removeEventListener('pointerdown', onDown);
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', end);
    window.removeEventListener('pointercancel', end);
  };
}
