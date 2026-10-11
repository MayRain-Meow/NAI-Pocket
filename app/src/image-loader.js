// Loads /api/ images for <img> elements created by the shared UI. The app answers /api/ in
// process, which an <img> request cannot reach, so visible images are fetched through the
// local API and shown as object URLs. Only images near the viewport load, a few at a time,
// and a bounded cache revokes the oldest object URLs.
export function createImageLoader(fetchApi, { concurrency = 4, cacheSize = 240 } = {}) {
  const cache = new Map(), pending = new Map(), queue = [];
  let active = 0;
  function remember(url, objectUrl) {
    cache.set(url, objectUrl);
    while (cache.size > cacheSize) { const [oldest, value] = cache.entries().next().value; cache.delete(oldest); URL.revokeObjectURL(value); }
  }
  function pump() {
    while (active < concurrency && queue.length) {
      const { url, resolve } = queue.shift();
      active++;
      fetchApi(url).then(async response => {
        if (!response.ok) throw new Error(String(response.status));
        const objectUrl = URL.createObjectURL(await response.blob());
        remember(url, objectUrl); resolve(objectUrl);
      }).catch(() => resolve('')).finally(() => { active--; pending.delete(url); pump(); });
    }
  }
  function objectUrlFor(url) {
    if (cache.has(url)) return Promise.resolve(cache.get(url));
    if (!pending.has(url)) pending.set(url, new Promise(resolve => { queue.push({ url, resolve }); pump(); }));
    return pending.get(url);
  }
  const visible = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      visible.unobserve(entry.target);
      const image = entry.target, url = image.dataset.apiSrc;
      objectUrlFor(url).then(objectUrl => {
        if (image.dataset.apiSrc !== url) return;
        if (objectUrl) image.src = objectUrl;
        else image.replaceWith(Object.assign(document.createElement('div'), { className: `${image.className} artist-library-image-placeholder`, textContent: '例图读取失败' }));
      });
    }
  }, { rootMargin: '300px 0px' });
  return function loadImage(image, url) {
    image.dataset.apiSrc = url;
    if (cache.has(url)) { image.src = cache.get(url); return; }
    visible.observe(image);
  };
}
