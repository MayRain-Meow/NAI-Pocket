// Narrow edge zones and time-based movement keep 60/120 Hz devices consistent.
export function tagDragEdgeSpeed(y, top, bottom, band = 36) {
  if (bottom - top < band * 2) return 0;
  const depth = y < top + band ? -Math.min(1, Math.max(0, (top + band - y) / band))
    : y > bottom - band ? Math.min(1, Math.max(0, (y - bottom + band) / band)) : 0;
  return Math.sign(depth) * 420 * depth ** 2;
}

export function tagDragScrollStep(state, speed, now) {
  const direction = Math.sign(speed);
  if (!direction || direction !== state.direction) {
    state.direction = direction;
    state.enteredAt = now;
  }
  const elapsed = Math.max(0, Math.min(40, now - (state.lastAt ?? now)));
  state.lastAt = now;
  const ramp = Math.max(0, Math.min(1, (now - state.enteredAt - 160) / 240));
  return ramp ? speed * ramp * elapsed / 1000 : 0;
}
