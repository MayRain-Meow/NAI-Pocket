// Keep passive notifications above the actual fixed generation bar, not a guessed height.
export function observeToastClearance(host, bar) {
  if (!host || !bar) return () => {};
  let frame = 0;
  function update() {
    frame = 0;
    const rect = bar.getBoundingClientRect();
    const visible = bar.isConnected && rect.width > 0 && rect.height > 0;
    if (visible) host.style.setProperty('--toast-bottom', `${Math.max(0, window.innerHeight - rect.top) + 12}px`);
    else host.style.removeProperty('--toast-bottom');
  }
  const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
  const resize = typeof ResizeObserver === 'function' ? new ResizeObserver(schedule) : null;
  resize?.observe(bar);
  const mutation = new MutationObserver(schedule);
  mutation.observe(bar, { attributes: true, attributeFilter: ['class', 'style', 'hidden'] });
  mutation.observe(document.body, { attributes: true, attributeFilter: ['class'] });
  window.addEventListener('resize', schedule);
  window.visualViewport?.addEventListener('resize', schedule);
  window.visualViewport?.addEventListener('scroll', schedule);
  update();
  return () => {
    resize?.disconnect(); mutation.disconnect(); if (frame) cancelAnimationFrame(frame);
    window.removeEventListener('resize', schedule);
    window.visualViewport?.removeEventListener('resize', schedule);
    window.visualViewport?.removeEventListener('scroll', schedule);
    host.style.removeProperty('--toast-bottom');
  };
}
