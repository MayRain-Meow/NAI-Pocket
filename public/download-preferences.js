export const DOWNLOAD_PREFERENCES_KEY = 'nai-pocket-download-preferences-v1';
export function readDownloadPreferences(storage) {
  let value = {};
  try { value = JSON.parse((storage || globalThis.localStorage).getItem(DOWNLOAD_PREFERENCES_KEY) || '{}'); } catch {}
  return {
    metadata: ['ask', 'original', 'clean'].includes(value?.metadata) ? value.metadata : 'ask',
    destination: ['album', 'folder', 'ask'].includes(value?.destination) ? value.destination : 'album'
  };
}
export function writeDownloadPreferences(patch, storage) {
  const value = { ...readDownloadPreferences(storage), ...patch };
  const valid = {
    metadata: ['ask', 'original', 'clean'].includes(value.metadata) ? value.metadata : 'ask',
    destination: ['album', 'folder', 'ask'].includes(value.destination) ? value.destination : 'album'
  };
  try { (storage || globalThis.localStorage).setItem(DOWNLOAD_PREFERENCES_KEY, JSON.stringify(valid)); } catch {}
  return valid;
}

// Sequential saves bound memory (especially clean PNGs) and preserve accurate partial results.
export async function saveGalleryImages({ ids, mode, destination, download, onProgress = () => {}, cancelled = () => false }) {
  const unique = [...new Set(ids.map(String).filter(Boolean))];
  if (!['original', 'clean'].includes(mode)) throw new TypeError('Invalid image download mode');
  const result = { saved: [], failed: [], cancelled: false, total: unique.length };
  for (const id of unique) {
    if (cancelled()) { result.cancelled = true; break; }
    try {
      const url = `/api/images/${encodeURIComponent(id)}/${mode}${mode === 'original' ? '?download=1' : ''}`;
      const saved = await download(url, { destination });
      if (!saved) { result.cancelled = true; break; }
      result.saved.push(id);
    } catch (error) {
      result.failed.push({ id, message: error?.message || String(error) });
      // A failed destination/permission cannot be fixed by opening more files.
      break;
    }
    onProgress({ ...result, completed: result.saved.length + result.failed.length });
  }
  return result;
}
