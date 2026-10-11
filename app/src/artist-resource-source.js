
// Default source: the annotation packs (owner decisions 2026-10-10). They carry names, per-image
// annotations and Danbooru CDN links for g/s ratings only, never image files; the earlier
// original-image packs are not distributed. Users may still enter or import their own catalog.
export const DEFAULT_ARTIST_CATALOG_URL = 'https://github.com/MayRain-Meow/NAI-Pocket/releases/download/artist-annotations-2026-10-10/catalog.json';

// Expose a host-chosen release source to the shared reader without changing other
// hosts or routing resource requests through a generation account.
export function withArtistCatalogSource(artists, catalogUrl = DEFAULT_ARTIST_CATALOG_URL) {
  if (!catalogUrl) return artists;
  return { ...artists, async list(...args) {
    const result = await artists.list(...args);
    return { ...result, resources: { ...result.resources, defaultCatalogUrl: catalogUrl } };
  } };
}
