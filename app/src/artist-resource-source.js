// Note: native default source and credential-free optional packs 见 .agents/notes/implemented/architecture/2026-10-10-android-host-and-public-export-boundaries.md
// No built-in source (owner decision 2026-10-10): the prepared packs contain third-party
// Danbooru originals, including explicit ratings, and are not distributed. Users may still
// enter or import a catalog of their own; an empty default leaves the field blank.
export const DEFAULT_ARTIST_CATALOG_URL = '';

// Expose a host-chosen release source to the shared reader without changing other
// hosts or routing resource requests through a generation account.
export function withArtistCatalogSource(artists, catalogUrl = DEFAULT_ARTIST_CATALOG_URL) {
  if (!catalogUrl) return artists;
  return { ...artists, async list(...args) {
    const result = await artists.list(...args);
    return { ...result, resources: { ...result.resources, defaultCatalogUrl: catalogUrl } };
  } };
}
