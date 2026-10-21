import { buildPayload } from '../public/generation-payload.js';
import { sanitizeInpaintRegion } from '../public/focused-inpaint.js';
import { redactPersistedApiPayload } from '../public/persistence-utils.js';


const SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const encoder = new TextEncoder();
const decoder = new TextDecoder('ascii');
const MAX_TEXT_BYTES = 4 * 1024 * 1024;
const NUMBER_KEYS = [
  'params_version', 'width', 'height', 'steps', 'scale', 'n_samples', 'ucPreset', 'uc_preset',
  'cfg_rescale', 'seed', 'extra_noise_seed', 'skip_cfg_above_sigma', 'controlnet_strength'
];
const BOOLEAN_KEYS = [
  'qualityToggle', 'quality_toggle', 'sm', 'sm_dyn', 'prefer_brownian',
  'deliberate_euler_ancestral_bug', 'dynamic_thresholding', 'legacy', 'legacy_v3_extend',
  'straight_alpha', 'tag_hint_transparent_background'
];
const STRING_KEYS = ['sampler', 'noise_schedule', 'image_format', 'controlnet_model'];
const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) value = crcTable[(value ^ byte) & 255] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function concatenate(parts) {
  const output = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) { output.set(part, offset); offset += part.length; }
  return output;
}

function textChunk(key, value) {
  // iTXt: keyword, NUL, compression flag/method, empty language, empty translated keyword, UTF-8.
  const data = concatenate([encoder.encode(key), new Uint8Array(5), encoder.encode(value)]);
  if (data.length > MAX_TEXT_BYTES) throw new Error('框选重绘元数据过大，无法保存。');
  const output = new Uint8Array(data.length + 12);
  const view = new DataView(output.buffer);
  view.setUint32(0, data.length);
  output.set(encoder.encode('iTXt'), 4);
  output.set(data, 8);
  view.setUint32(output.length - 4, crc32(output.subarray(4, output.length - 4)));
  return output;
}

function readChunks(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 33 || !SIGNATURE.every((byte, index) => bytes[index] === byte)) {
    throw new Error('框选重绘合成结果不是有效 PNG。');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunks = [];
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset);
    const end = offset + length + 12;
    if (end > bytes.length) throw new Error('框选重绘 PNG 数据不完整。');
    const type = decoder.decode(bytes.subarray(offset + 4, offset + 8));
    chunks.push({ type, bytes: bytes.subarray(offset, end), data: bytes.subarray(offset + 8, end - 4) });
    offset = end;
    if (type === 'IEND') break;
  }
  if (chunks[0]?.type !== 'IHDR' || chunks[0].data.length !== 13
    || !chunks.some(chunk => chunk.type === 'IDAT') || chunks.at(-1)?.type !== 'IEND') {
    throw new Error('框选重绘 PNG 缺少图像数据。');
  }
  const header = new DataView(chunks[0].data.buffer, chunks[0].data.byteOffset, 13);
  return { chunks, width: header.getUint32(0), height: header.getUint32(4) };
}

function safeParameters(actual, original) {
  const output = {};
  // An allowlist is deliberate: transport tokens, signed_hash, Base64 media and
  // arbitrary advanced objects must not be copied into a newly authored PNG.
  for (const key of NUMBER_KEYS) {
    const value = actual[key] ?? original[key];
    if (typeof value === 'number' && Number.isFinite(value)) output[key] = value;
  }
  for (const key of BOOLEAN_KEYS) {
    const value = actual[key] ?? original[key];
    if (typeof value === 'boolean') output[key] = value;
  }
  for (const key of STRING_KEYS) {
    const value = actual[key] ?? original[key];
    if (typeof value === 'string' && /^[a-z0-9_.-]{1,128}$/i.test(value)) output[key] = value;
  }
  return output;
}

/** Synchronously add importable full-canvas metadata without decoding or changing any pixels. */
export function attachFocusedInpaintMetadata(pngBytes, { state, payload, seed, plan }, binary = Buffer) {
  const { chunks, width, height } = readChunks(pngBytes);
  const region = sanitizeInpaintRegion(plan?.region ?? state?.imageWorkflow?.inpaintRegion);
  if (!region || region.sourceWidth !== width || region.sourceHeight !== height
    || (plan?.sourceWidth != null && plan.sourceWidth !== width)
    || (plan?.sourceHeight != null && plan.sourceHeight !== height)) {
    throw new Error('框选重绘合成图尺寸与原图记录不一致。');
  }
  const finalSeed = Number.isInteger(seed) ? seed : (payload?.parameters?.seed ?? state.seed);
  const media = redactPersistedApiPayload({ image: 'resolved', mask: 'resolved' }, state);
  const original = buildPayload(state, finalSeed, { baseImage: media.image, maskImage: media.mask }).parameters;
  const actual = payload?.parameters || {};
  const comment = {
    ...safeParameters(actual, original),
    width, height, seed: finalSeed,
    model: state.model,
    prompt: state.prompt,
    negative_prompt: state.negativePrompt,
    request_type: 'NativeInpaintingRequest',
    action: 'infill',
    image: media.image,
    mask: media.mask,
    add_original_image: false,
    img2img: {
      strength: state.imageWorkflow.strength,
      noise: state.imageWorkflow.noise,
      color_correct: state.imageWorkflow.colorCorrect === true,
      extra_noise_seed: finalSeed
    },
    // Keep both prompt/UC arrays from the original state, including people
    // outside the crop; the actual request's local coordinates are a different record.
    ...(original.v4_prompt ? {
      v4_prompt: { ...original.v4_prompt, caption: { ...original.v4_prompt.caption, base_caption: state.prompt } },
      // The editor's own UC, like the prompt above; the sent UC also carries the preset text (1.9.0).
      v4_negative_prompt: { ...original.v4_negative_prompt, caption: { ...original.v4_negative_prompt.caption, base_caption: state.negativePrompt } }
    } : {}),
    focused_inpaint: {
      version: 1,
      composite: true,
      coordinateSpace: 'original',
      sourceWidth: width,
      sourceHeight: height,
      region: { x: region.x, y: region.y, width: region.width, height: region.height },
      workWidth: Number.isSafeInteger(plan?.workWidth ?? plan?.width) ? (plan.workWidth ?? plan.width) : actual.width,
      workHeight: Number.isSafeInteger(plan?.workHeight ?? plan?.height) ? (plan.workHeight ?? plan.height) : actual.height
    }
  };
  // References describe missing media on import. ROI provenance is record-only;
  // restoring a paid inpaint still requires the original source and mask.
  const metadata = [
    textChunk('Software', 'NovelAI / NAI Pocket'),
    textChunk('Source', 'NAI Pocket focused inpaint composite'),
    textChunk('Description', String(state.prompt || '')),
    textChunk('Comment', JSON.stringify(comment))
  ];
  const output = [SIGNATURE];
  for (const chunk of chunks) {
    // Drop upstream/original text and EXIF signatures rather than falsely
    // attributing the newly composed full image to a signed crop response.
    if (['tEXt', 'zTXt', 'iTXt', 'eXIf'].includes(chunk.type)) continue;
    if (chunk.type === 'IEND') output.push(...metadata);
    output.push(chunk.bytes);
  }
  return binary.from(concatenate(output));
}
