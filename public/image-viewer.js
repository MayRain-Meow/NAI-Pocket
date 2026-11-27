// Image-only gestures: the rest of the detail sheet remains normally scrollable.
export function installImageViewer({ stage, image, dialog, navigate }) {
  if (!stage || !image) return null;
  const surface = image.parentElement;
  const pointers = new Map();
  let scale = 1, x = 0, y = 0, gesture = null, lastTap = null, imageId = null, pointerType = '';
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  image.draggable = false;
  surface.classList.add('zoom-surface');
  const toolbar = document.createElement('div');
  toolbar.className = 'image-zoom-controls';
  toolbar.setAttribute('role', 'group');
  toolbar.setAttribute('aria-label', '图片缩放');
  toolbar.innerHTML = '<button type="button" data-zoom="out" aria-label="缩小图片">−</button><button type="button" data-zoom="reset" aria-label="复位图片缩放">100%</button><button type="button" data-zoom="in" aria-label="放大图片">＋</button>';
  stage.after(toolbar);
  const resetButton = toolbar.querySelector('[data-zoom="reset"]');
  const hint = document.createElement('small');
  hint.className = 'image-zoom-hint';
  hint.textContent = '双指或双击放大 · 放大后拖动查看';
  toolbar.append(hint);
  function render() {
    const bounds = surface.getBoundingClientRect();
    const maxX = Math.max(0, (image.offsetWidth * scale - bounds.width) / 2);
    const maxY = Math.max(0, (image.offsetHeight * scale - bounds.height) / 2);
    x = clamp(x, -maxX, maxX); y = clamp(y, -maxY, maxY);
    image.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
    stage.dataset.zoom = scale.toFixed(3);
    surface.classList.toggle('is-zoomed', scale > 1.001);
    resetButton.textContent = `${Math.round(scale * 100)}%`;
    toolbar.querySelector('[data-zoom="out"]').disabled = scale <= 1;
    toolbar.querySelector('[data-zoom="in"]').disabled = scale >= 5;
  }
  function zoom(next, clientX, clientY) {
    const bounds = surface.getBoundingClientRect();
    const px = (clientX ?? bounds.left + bounds.width / 2) - bounds.left - bounds.width / 2;
    const py = (clientY ?? bounds.top + bounds.height / 2) - bounds.top - bounds.height / 2;
    next = clamp(next, 1, 5);
    const ratio = next / scale;
    x = px - (px - x) * ratio; y = py - (py - y) * ratio;
    scale = next; render();
  }
  function reset() {
    pointers.clear(); gesture = null; lastTap = null; scale = 1; x = y = 0; render();
  }
  function pair() {
    const [a, b] = [...pointers.values()];
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, distance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)) };
  }
  surface.addEventListener('pointerdown', event => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    pointerType = event.pointerType;
    surface.setPointerCapture(event.pointerId);
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.size === 1) {
      gesture = { startX: event.clientX, startY: event.clientY, moved: false, noSwipe: scale > 1.001, at: performance.now() };
    } else {
      gesture.noSwipe = true; gesture.moved = true; lastTap = null;
      gesture.pair = pair();
    }
  });
  surface.addEventListener('pointermove', event => {
    const prev = pointers.get(event.pointerId);
    if (!prev || !gesture) return;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (Math.hypot(event.clientX - gesture.startX, event.clientY - gesture.startY) > 8) gesture.moved = true;
    if (pointers.size >= 2) {
      const next = pair(), old = gesture.pair || next;
      zoom(scale * next.distance / old.distance, old.x, old.y);
      x += next.x - old.x; y += next.y - old.y; render();
      gesture.pair = next;
    } else if (scale > 1.001) {
      x += event.clientX - prev.x; y += event.clientY - prev.y; render();
    }
  });
  function end(event) {
    if (!pointers.has(event.pointerId) || !gesture) return;
    pointers.delete(event.pointerId);
    if (event.type === 'pointercancel') { gesture.noSwipe = true; gesture.moved = true; lastTap = null; }
    if (pointers.size) { gesture.pair = pointers.size >= 2 ? pair() : null; return; }
    const finished = gesture; gesture = null;
    if (event.type === 'pointercancel') return;
    const dx = event.clientX - finished.startX, dy = event.clientY - finished.startY;
    if (!finished.noSwipe && Math.abs(dx) >= 60 && Math.abs(dx) > Math.abs(dy) * 1.35) {
      lastTap = null; navigate(dx < 0 ? 1 : -1); return;
    }
    if (!finished.moved && performance.now() - finished.at < 300 && event.pointerType !== 'mouse') {
      const now = performance.now();
      if (lastTap && now - lastTap.at < 320 && Math.hypot(event.clientX - lastTap.x, event.clientY - lastTap.y) < 28) {
        zoom(scale > 1.001 ? 1 : 2.5, event.clientX, event.clientY); lastTap = null;
      } else lastTap = { at: now, x: event.clientX, y: event.clientY };
    } else lastTap = null;
  }
  surface.addEventListener('pointerup', end);
  surface.addEventListener('pointercancel', end);
  surface.addEventListener('lostpointercapture', event => {
    if (pointers.has(event.pointerId)) { pointers.clear(); gesture = null; lastTap = null; }
  });
  surface.addEventListener('dblclick', event => {
    event.preventDefault();
    if (pointerType === 'mouse') zoom(scale > 1.001 ? 1 : 2.5, event.clientX, event.clientY);
  });
  surface.addEventListener('wheel', event => {
    event.preventDefault(); zoom(scale * Math.exp(-event.deltaY * .002), event.clientX, event.clientY);
  }, { passive: false });
  toolbar.addEventListener('click', event => {
    const action = event.target.closest('[data-zoom]')?.dataset.zoom;
    if (action === 'reset') reset();
    else if (action) zoom(scale * (action === 'in' ? 1.5 : 1 / 1.5));
  });
  image.addEventListener('load', render);
  dialog?.addEventListener('close', reset);
  new ResizeObserver(render).observe(surface);
  reset();
  return { reset, setImage(id) { if (imageId !== id) { imageId = id; stage.dataset.imageId = id; reset(); } } };
}
