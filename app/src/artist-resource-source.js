
export const DEFAULT_ARTIST_CATALOG_URL = 'https://github.com/MayRain-Meow/NAI-Pocket/releases/download/artist-originals-2026-10-10-1/catalog.json';

// Expose the native release source to the shared reader without changing other
// hosts or routing resource requests through a generation account.
export function withArtistCatalogSource(artists) {
  return { ...artists, async list(...args) {
    const result = await artists.list(...args);
    return { ...result, resources: { ...result.resources, defaultCatalogUrl: DEFAULT_ARTIST_CATALOG_URL } };
  } };
}
