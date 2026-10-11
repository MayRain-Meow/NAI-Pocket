
// One rule for what a generation provider id means, shared by the page, the queue and the
// services. 'official' is NovelAI itself; every other id is a third-party relay: the RBQ
// preset keeps its historical id 'rbq' (stored jobs and schemes carry it), and relays the
// user adds are 'relay:<id>'. Anything unknown falls back to official, as before.

export const OFFICIAL_PROVIDER = 'official';
export const RBQ_PROVIDER = 'rbq';
export const RELAY_PREFIX = 'relay:';
const RELAY_ID = /^relay:[A-Za-z0-9-]{8,80}$/;

export function normalizeProviderId(value) {
  const id = String(value || '');
  if (id === RBQ_PROVIDER) return RBQ_PROVIDER;
  if (RELAY_ID.test(id)) return id;
  return OFFICIAL_PROVIDER;
}

export function isOfficialProvider(value) {
  return normalizeProviderId(value) === OFFICIAL_PROVIDER;
}

export function isRelayProvider(value) {
  return !isOfficialProvider(value);
}

// Relays forward plain generation only: NovelAI's own image tools, Vibe encoding and the
// Anlas balance exist on the official API. A relay's Vibe references are encoded with an
// official account first (see app/src/assets.js), exactly as RBQ always worked.
export function providerCapabilities(value) {
  const official = isOfficialProvider(value);
  return { imageTools: official, vibeEncoding: official, anlasBilling: official };
}
