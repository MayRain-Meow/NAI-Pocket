
// Default source: the annotation packs (owner decisions 2026-10-10). They carry names, per-image
// annotations and Danbooru CDN links for g/s ratings only, never image files; the earlier
// original-image packs are not distributed. Users may still enter or import their own catalog.
// 0.7.1: the 2026-10-27 packs follow the website's library (2.25 万 artists; same rules: g/s only, no images).
export const DEFAULT_ARTIST_CATALOG_URL = 'https://github.com/MayRain-Meow/NAI-Pocket/releases/download/artist-annotations-2026-10-27/catalog.json';
export const CURRENT_ARTIST_CATALOG_VERSION = '2026-10-27-annotations-gs-1';
// Earlier defaults: a saved one is replaced by the current default (it was never the user's own choice).
export const PREVIOUS_ARTIST_CATALOG_URLS = Object.freeze(['https://github.com/MayRain-Meow/NAI-Pocket/releases/download/artist-annotations-2026-10-10/catalog.json']);
// V5 例图 (0.6.5): one NovelAI V5 picture per artist from a single base prompt, an optional
// examples pack that attaches to whichever artist packs are installed.
export const V5_EXAMPLES_CATALOG_URL = 'https://github.com/MayRain-Meow/NAI-Pocket/releases/download/artist-v5-examples-2026-10-22/catalog.json';

// Expose a host-chosen release source to the shared reader without changing other
// hosts or routing resource requests through a generation account.
export function withArtistCatalogSource(artists, catalogUrl = DEFAULT_ARTIST_CATALOG_URL) {
  if (!catalogUrl) return artists;
  return { ...artists, async list(...args) {
    const result = await artists.list(...args);
    return { ...result, resources: { ...result.resources, defaultCatalogUrl: catalogUrl } };
  } };
}
