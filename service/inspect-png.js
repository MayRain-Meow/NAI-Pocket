import { normalizeNovelAiMetadata, metadataValue } from '../public/png-metadata.js';
import { redactPersistedApiPayload } from '../public/persistence-utils.js';
// Reads PNG, WebP and JPEG (extractStandardImageMetadata); hosts without it fall back to PNG only.
// extractStealthMetadata(buffer, width, height, format) decodes the pixels for the alpha-LSB record.
export function createPngInspector({ extractStandardImageMetadata, extractStandardPngMetadata, extractStealthMetadata }) {
const asString = value => typeof value === 'string' ? value : '';
const FORMAT_LABEL = { png: 'PNG', webp: 'WebP', jpeg: 'JPEG' };
async function inspectNovelAiPng(buffer) {
  const standard = extractStandardImageMetadata ? extractStandardImageMetadata(buffer) : { ...extractStandardPngMetadata(buffer), format: 'png' };
  const format = standard.format || 'png';
  let metadata = standard.metadata;
  let metadataSource = format === 'png' ? 'png-text' : `${format}-exif`;
  let stealthFound = false;
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
    const stealth = await extractStealthMetadata(buffer, standard.width, standard.height, format);
    if (stealth && typeof stealth === 'object') {
      stealthFound = true;
      metadata = { ...metadata, ...stealth };
      metadataSource = standardHasUsefulData ? `${metadataSource}+stealth` : 'stealth';
    }
  }
  if (!standardHasUsefulData && !stealthFound && !metadataValue(metadata, 'parameters')) {
    // Nothing NovelAI-like at all: say why instead of opening an empty reader full of warnings.
    const kind = FORMAT_LABEL[format] || '图片';
    const error = new Error(format === 'png'
      ? '这张 PNG 里没有 NovelAI 参数：可能不是 NovelAI 生成的，或保存 / 转发时参数被去掉了。'
      : `这张 ${kind} 里没有 NovelAI 参数：网站转存、截图和有损压缩通常会把参数去掉。请用 NovelAI 下载的 PNG 原图，或保留透明通道的 WebP。`);
    error.status = 422;
    throw error;
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
