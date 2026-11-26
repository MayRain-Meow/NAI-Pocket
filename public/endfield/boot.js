(() => {
  const root = document.documentElement;
  root.dataset.efAccent = 'yellow'; root.dataset.efPaper = 'neutral';
  root.dataset.efCut = 'tight'; root.dataset.efGround = 'plain';
  root.dataset.efDensity = 'standard'; root.dataset.efMotion = 'calm';
  let preference = 'system';
  try { preference = localStorage.getItem('nai-pocket-theme') || 'system'; } catch {}
  root.dataset.theme = preference === 'dark' || preference === 'system' && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
})();
