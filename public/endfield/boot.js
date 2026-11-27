(() => {
  const root = document.documentElement;
  root.dataset.efAccent = 'yellow'; root.dataset.efPaper = 'neutral';
  root.dataset.efCut = 'tight'; root.dataset.efGround = 'plain';
  root.dataset.efDensity = 'standard'; root.dataset.efMotion = 'calm';
  let preference = 'system';
  try { preference = localStorage.getItem('nai-pocket-theme') || 'system'; } catch {}
  if (!['system', 'light', 'dark', 'blue-coral', 'rose-night'].includes(preference)) preference = 'system';
  root.dataset.efPalette = preference;
  root.dataset.theme = preference === 'dark' || preference === 'rose-night' || preference === 'system' && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
})();
