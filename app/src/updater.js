// App update check against the public GitHub Releases of this project. Pure logic only:
// the HTTP port, the persisted state and the clock are injected, so tests run in Node.
// Downloading and installing are native (AppUpdatePlugin), which re-checks the URL, the
// package name, the versionCode and the signing certificate before the system installer opens.

export const UPDATE_REPOSITORY = 'MayRain-Meow/NAI-Pocket';
export const RELEASES_URL = `https://api.github.com/repos/${UPDATE_REPOSITORY}/releases?per_page=10`;
export const DOWNLOAD_PREFIX = `https://github.com/${UPDATE_REPOSITORY}/releases/download/`;
export const CHECK_INTERVAL_MS = 12 * 3600000;
export const LAST_CHECK_KEY = 'app_update_last_check';
export const SKIPPED_KEY = 'app_update_skipped';

const TAG = /^v(\d+)\.(\d+)\.(\d+)(?:-preview)?$/;

export function parseVersion(text) {
  const match = String(text || '').match(/^v?(\d+)\.(\d+)\.(\d+)(?:-preview)?$/);
  return match ? match.slice(1, 4).map(Number) : null;
}

export function compareVersions(a, b) {
  const left = Array.isArray(a) ? a : parseVersion(a), right = Array.isArray(b) ? b : parseVersion(b);
  if (!left || !right) throw new Error('Invalid version');
  for (let index = 0; index < 3; index++) if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1;
  return 0;
}

// First lines of the release body as plain text (Markdown markers removed).
export function releaseSummary(body, lines = 3) {
  return String(body || '').replace(/\r/g, '').replace(/<!--[\s\S]*?-->/g, '').split('\n')
    .map(line => line
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/, '')
      .replace(/(\*\*|__|`)/g, '')
      .replace(/^[-*_\s]{3,}$/, '')
      .trim())
    .filter(Boolean).slice(0, lines)
    .map(line => line.length > 120 ? `${line.slice(0, 119)}…` : line).join('\n');
}

const asset = (release, name) => (Array.isArray(release.assets) ? release.assets : []).find(item => item?.name === name);

// Newest (highest version) non-draft release with the expected APK asset, if newer than current.
export function selectUpdate(releases, currentVersion) {
  const current = parseVersion(currentVersion);
  if (!current) throw new Error('Invalid current version');
  let best = null;
  for (const release of Array.isArray(releases) ? releases : []) {
    if (!release || release.draft) continue;
    const match = String(release.tag_name || '').match(TAG);
    if (!match) continue;
    const version = match.slice(1, 4).join('.'), name = `NAI-Pocket-v${version}-preview.apk`;
    const apk = asset(release, name);
    const url = String(apk?.browser_download_url || '');
    if (!apk || url !== `${DOWNLOAD_PREFIX}${encodeURIComponent(release.tag_name)}/${name}`) continue;
    if (best && compareVersions(version, best.version) <= 0) continue;
    const checksum = asset(release, `${name}.sha256`);
    const digest = String(apk.digest || '').match(/^sha256:([a-f0-9]{64})$/i)?.[1]?.toLowerCase() || '';
    best = { version, tag: release.tag_name, title: String(release.name || '').trim(), notes: releaseSummary(release.body),
      url, bytes: Number(apk.size) || 0, sha256: digest,
      sha256Url: checksum?.browser_download_url === `${url}.sha256` ? checksum.browser_download_url : '' };
  }
  return best && compareVersions(best.version, current) > 0 ? best : null;
}

export function createUpdater({ fetch, state, currentVersion, now = () => Date.now() }) {
  async function check({ manual = false } = {}) {
    if (!manual) {
      const last = Number(await state.get(LAST_CHECK_KEY, '0')) || 0;
      const elapsed = now() - last;
      if (elapsed >= 0 && elapsed < CHECK_INTERVAL_MS) return { status: 'throttled' };
    }
    // An attempt counts, so an unreachable GitHub is not asked again on every start.
    await state.set(LAST_CHECK_KEY, String(now()));
    let response;
    try {
      response = await fetch(RELEASES_URL, { headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': `NAI-Pocket/${currentVersion}` } });
    } catch (error) { return { status: 'error', error }; }
    if (response.status === 403 || response.status === 429) return { status: 'rate-limited' };
    if (!response.ok) return { status: 'error', error: new Error(`HTTP ${response.status}`) };
    let update;
    try { update = selectUpdate(await response.json(), currentVersion); }
    catch (error) { return { status: 'error', error }; }
    if (!update) return { status: 'none' };
    if (!manual && String(await state.get(SKIPPED_KEY, '')) === update.version) return { status: 'skipped', update };
    return { status: 'available', update };
  }
  return { check, skip: version => state.set(SKIPPED_KEY, String(version)), skipped: () => state.get(SKIPPED_KEY, '') };
}
