import { normalizeNovelAiMetadata, metadataValue } from '../public/png-metadata.js';
import { redactPersistedApiPayload } from '../public/persistence-utils.js';
export function createPngInspector({ extractStandardPngMetadata, extractStealthMetadata }) {
const asString = value => typeof value === 'string' ? value : '';
async function inspectNovelAiPng(buffer) {
  const standard = extractStandardPngMetadata(buffer);
  let metadata = standard.metadata;
  let metadataSource = 'png-text';
  const commentValue = metadataValue(metadata, 'Comment', 'parameters', 'rawParameters');
  const softwareValue = asString(metadataValue(metadata, 'Software'));
  const standardHasUsefulData = Boolean(
    commentValue
    || metadataValue(metadata, 'Description', 'prompt')
    || softwareValue.toLowerCase().includes('novelai')
  );
  const standardModel = normalizeNovelAiMetadata(metadata, { width: standard.width, height: standard.height });
  const standardComment = commentValue && typeof commentValue === 'object' && !Array.isArray(commentValue) ? commentValue : null;
  const standardHasCoreParameters = Boolean(
    standardComment && (standardComment.prompt || standardComment.v4_prompt)
      && Number.isFinite(Number(standardComment.steps))
      && Number.isFinite(Number(standardComment.seed))
  );

  // A normal Comment can contain Prompt while the model is stored only in the
  // alpha-channel stealth payload. Read stealth metadata whenever the model is
  // still uncertain, instead of treating any Comment as a complete record.
  if (standard.hasAlpha !== false && (!standardHasUsefulData || !commentValue || (standardModel.modelDetected === false && !standardHasCoreParameters))) {
    const stealth = await extractStealthMetadata(buffer, standard.width, standard.height);
    if (stealth && typeof stealth === 'object') {
      metadata = { ...metadata, ...stealth };
      metadataSource = standardHasUsefulData ? 'png-text+stealth' : 'stealth';
    }
  }

  const normalized = normalizeNovelAiMetadata(metadata, { width: standard.width, height: standard.height });
  // The embedded source/mask (when a third-party exporter really included
  // them) is returned once through the dedicated semantic fields. Do not also
  // echo the potentially multi-megabyte Base64 strings in metadata and
  // rawParameters; that duplication made the first import response slow and
  // left sensitive media in browser memory longer than necessary.
  const safeMetadata = redactPersistedApiPayload(metadata);
  const safeRawParameters = redactPersistedApiPayload(normalized.rawParameters || {});
  return {
    metadataSource,
    width: standard.width,
    height: standard.height,
    ...normalized,
    metadata: safeMetadata,
    rawParameters: safeRawParameters
  };
}

return { inspectNovelAiPng };
}
