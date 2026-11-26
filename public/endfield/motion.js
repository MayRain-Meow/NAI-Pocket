// Motion is presentation-only: existing navigation, focus, dialog and data
// handlers retain ownership of their state and run without animation delays.
let disposeMotion;

export function installEndfieldMotion() {
  if (disposeMotion) return disposeMotion;
  const root = document.documentElement;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const running = new Map();
  const snap = 'cubic-bezier(.16,1,.3,1)';
  const observers = [];
  root.classList.add('ef-motion-ready');

  function cancel(element) {
    const animation = running.get(element);
    if (!animation) return;
    running.delete(element);
    animation.cancel();
  }

  function reveal(element, { slide = false, duration = 200 } = {}) {
    cancel(element);
    if (reduced.matches || !element.isConnected || !element.getClientRects().length || !element.animate) return;
    const frames = slide
      ? [{ opacity: 0, transform: 'translateY(4px)' }, { opacity: 1, transform: 'none' }]
      : [{ opacity: .72 }, { opacity: 1 }];
    const animation = element.animate(frames, { duration, easing: snap });
    running.set(element, animation);
    const release = () => { if (running.get(element) === animation) running.delete(element); };
    animation.addEventListener('finish', release, { once: true });
    animation.addEventListener('cancel', release, { once: true });
  }

  // Never transform a page: several pages contain viewport-fixed action docks.
  // Observe only the existing page roots, not every class change in the app.
  const panels = [...document.querySelectorAll('.workspace-scroll > .tab-panel')];
  const activeState = new Map(panels.map(panel => [panel, panel.classList.contains('active')]));
  const pages = new MutationObserver(records => {
    for (const panel of new Set(records.map(record => record.target))) {
      const active = panel.classList.contains('active');
      const wasActive = activeState.get(panel);
      activeState.set(panel, active);
      if (!active) cancel(panel);
      else if (!wasActive) reveal(panel);
    }
  });
  panels.forEach(panel => pages.observe(panel, { attributes: true, attributeFilter: ['class'] }));
  observers.push(pages);

  const toastHost = document.getElementById('toastHost');
  if (toastHost) {
    const toasts = new MutationObserver(records => {
      for (const record of records) {
        for (const node of record.removedNodes) cancel(node);
        for (const node of record.addedNodes) {
          if (node.nodeType === Node.ELEMENT_NODE && node.matches('.toast')) reveal(node, { slide: true });
        }
      }
    });
    toasts.observe(toastHost, { childList: true });
    observers.push(toasts);
  }

  // Native details keep their keyboard and accessibility behavior. Opacity
  // avoids moving focus targets or re-anchoring any fixed children.
  function onToggle(event) {
    const details = event.target;
    if (!(details instanceof HTMLDetailsElement)) return;
    for (const child of details.children) {
      if (child.tagName === 'SUMMARY') continue;
      if (details.open) reveal(child, { duration: 180 });
      else cancel(child);
    }
  }
  document.addEventListener('toggle', onToggle, true);

  function cancelAll() {
    for (const element of [...running.keys()]) cancel(element);
  }
  function onReducedMotion() {
    if (reduced.matches) cancelAll();
  }
  function onVisibility() {
    if (document.hidden) cancelAll();
  }
  reduced.addEventListener('change', onReducedMotion);
  document.addEventListener('visibilitychange', onVisibility);

  disposeMotion = () => {
    observers.forEach(observer => observer.disconnect());
    cancelAll();
    document.removeEventListener('toggle', onToggle, true);
    document.removeEventListener('visibilitychange', onVisibility);
    reduced.removeEventListener('change', onReducedMotion);
    root.classList.remove('ef-motion-ready');
    disposeMotion = undefined;
  };
  return disposeMotion;
}
