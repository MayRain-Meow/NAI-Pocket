// Fit a prefix into measured rows, including room for the remaining-count chip.
export function fitChipCount(widths, { width, height, rowHeight, gap = 5, overflowWidth = 30 }) {
  if (!(width > 0 && rowHeight > 0 && height >= rowHeight)) return 0;
  const rows = Math.floor((height + gap) / (rowHeight + gap));
  for (let count = widths.length; count >= 0; count--) {
    const items = widths.slice(0, count); if (count < widths.length) items.push(overflowWidth);
    let row = 1, used = 0;
    for (const value of items) {
      const size = Math.min(width, value);
      if (used && used + gap + size > width + .5) { row++; used = size; }
      else used += (used ? gap : 0) + size;
    }
    if (row <= rows) return count;
  }
  return 0;
}

export function observeFittedChips(container) {
  if (typeof ResizeObserver !== 'function') return () => {};
  let active = true, frame = 0;
  const fit = () => {
    frame = 0; if (!active || !container.isConnected || !container.clientWidth || !container.clientHeight) return;
    const chips = [...container.querySelectorAll('[data-fit-chip]')], more = container.querySelector('[data-fit-more]');
    if (!chips.length || !more) return;
    chips.forEach(chip => { chip.hidden = false; }); more.hidden = false; more.textContent = `+${chips.length}`;
    const rects = chips.map(chip => chip.getBoundingClientRect());
    const count = fitChipCount(rects.map(rect => rect.width), { width: container.clientWidth, height: container.clientHeight,
      rowHeight: Math.max(...rects.map(rect => rect.height), more.getBoundingClientRect().height),
      gap: parseFloat(getComputedStyle(container).gap) || 0, overflowWidth: more.getBoundingClientRect().width });
    chips.forEach((chip, index) => { chip.hidden = index >= count; });
    more.hidden = count === chips.length; more.textContent = `+${chips.length - count}`;
  };
  const schedule = () => { if (active && !frame) frame = requestAnimationFrame(fit); };
  const observer = new ResizeObserver(schedule); observer.observe(container); schedule();
  document.fonts?.ready.then(schedule);
  return () => { active = false; observer.disconnect(); if (frame) cancelAnimationFrame(frame); };
}
