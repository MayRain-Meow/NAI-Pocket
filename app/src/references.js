import { Buffer } from 'buffer';
import { Filesystem, Directory } from '@capacitor/filesystem';
import { createTranslationService } from '../../service/translations.js';
import { createTranslationStore } from '../../service/storage/translation.js';
import { createSearchService } from '../../service/search.js';
import { createSearchCacheStore } from '../../service/storage/search.js';
import { createCodexService } from '../../service/codex.js';
import { createTaggerService } from '../../service/tagger.js';
import { createTranslationRefresh } from '../../service/translation-refresh.js';
import { createPngInspector } from '../../service/inspect-png.js';
import { createNaxPreviewClient } from '../../service/nax-preview.js';
import { createArtistBrowserService } from '../../service/artist-browser.js';
import { createArtistBrowserStore } from '../../service/storage/artist-browser.js';
import { createArtistResourceService, artistResourceImageUrl } from '../../service/artist-resources.js';
import { createArtistLibraryView } from '../../service/artist-library-view.js';
import { createArtistDanbooruStats } from '../../service/artist-danbooru-stats.js';
import { createArtistDanbooruStatsStore } from '../../service/storage/artist-danbooru-stats.js';
import { createArtistLibraryViewStore } from '../../service/storage/artist-library-view.js';
import { createArtistResourceStore } from '../../service/storage/artist-resources.js';
import { extractStandardPngMetadata, decodeRgbaPng, extractStealthMetadataFromRgba } from '../../public/png-metadata.js';
import { nativeFiles, localPath } from './files.js';
import { hashBytes } from './codecs.js';
import { openArtistPacks } from './artist-packs.js';
import { openStylePack } from './style-pack.js';
import { openStyleImages } from './style-images.js';
import artistRoster from './artist-roster.json';
import { withArtistCatalogSource } from './artist-resource-source.js';

export function openReferences(database, settings, http) {
  const stylePack = openStylePack();
  const styleImages = openStyleImages();
  const artistDanbooru = createArtistDanbooruStats({ store: database.store(createArtistDanbooruStatsStore(database.db)), http });
  const artistResources = createArtistResourceService({ store:database.store(createArtistResourceStore(database.db)), files:nativeFiles, http });
  const translations = createTranslationService({ store: database.store(createTranslationStore(database.db)), settings, http });
  const search = createSearchService({ settings, http, cache: database.store(createSearchCacheStore(database.db)), hash: hashBytes, recordPublicTagNames: translations.recordPublicTagNames });
  const cache = {
    async read(name) {
      let bytes;
      try { bytes = await nativeFiles.read(localPath('codex-cache', name)); }
      catch (error) { if (error.code === 'OS-PLUG-FILE-0008' || /does not exist|not found/i.test(error.message)) return null; throw error; }
      return JSON.parse(bytes.toString('utf8'));
    },
    write: (name, value) => nativeFiles.write(localPath('codex-cache', name), Buffer.from(JSON.stringify(value))),
    async replace(prefix, name, value) {
      await cache.write(name, value);
      const entries = await Filesystem.readdir({ path: 'codex-cache', directory: Directory.Data });
      for (const old of entries.files) if (old.name !== name && old.name.startsWith(prefix)) await nativeFiles.remove(localPath('codex-cache', old.name));
    }
  };
  const inspector = createPngInspector({ extractStandardPngMetadata,
    async extractStealthMetadata(bytes, width, height) {
      if (!width || !height || width * height > 20000000) return null;
      // The shared decoder preserves RGBA bytes, including hidden alpha bits.
      const rgba = decodeRgbaPng(bytes, width, height);
      if (rgba) return extractStealthMetadataFromRgba(rgba, width, height);
      return null;
    }
  });
  return { translations, search, codex: createCodexService({ cache, http }), tagger: createTaggerService({ hash: hashBytes, http }),
    naxPreview: createNaxPreviewClient({ binary: Buffer, http }),
    artistResources, artistPacks:openArtistPacks(database), stylePack, styleImages,
    artistDanbooru,
    artistLibrary: createArtistLibraryView({ store: database.store(createArtistLibraryViewStore(database.db)), danbooru: artistDanbooru,
      preferences: database.store(createArtistBrowserStore(database.db)), roster: artistRoster.artists, imageUrl: artistResourceImageUrl, styleIndex: stylePack.index, styleImages }),
    artists: withArtistCatalogSource(createArtistBrowserService({ store: database.store(createArtistBrowserStore(database.db)), resources:artistResources,
      names:[], roster:artistRoster.artists })),
    ...createTranslationRefresh({ semanticSearch: search.semanticSearch, translateText: translations.translateText }), ...inspector };
}
