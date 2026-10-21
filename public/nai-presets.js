// NovelAI's Quality Tags, Undesired Content presets, Furry mode and V5 Full's Medium effort, composed
// the way NovelAI's own client does it before a request leaves the browser. The backend expands
// none of these: the official client appends the quality tags to the prompt, puts the UC preset in
// front of the UC (on Full models also `nsfw` when the prompt does not ask for it), and sends only
// the `tag_hint_*` numbers alongside. Texts follow docs.novelai.net/en/image/qualitytags and
// /undesiredcontent (2026-10-21). Pure; shared by the server, the browser and the app.


// Our stored `ucPreset` uses NovelAI's own index order (what its images record as `ucPreset`).
export const UC_PRESET = Object.freeze({ HEAVY: 0, LIGHT: 1, FURRY_FOCUS: 2, HUMAN_FOCUS: 3, NONE: 4 });
export const UC_PRESET_LABELS = Object.freeze(['Heavy', 'Light', 'Furry Focus', 'Human Focus', 'None']);
export const UC_PRESET_MAX = UC_PRESET.NONE;
// NovelAI's tag hint ids (`tag_hint_qt`, `tag_hint_uc_preset`).
const HINT = Object.freeze({ NONE: 0, STANDARD: 1, HEAVY: 2, LIGHT: 3, HUMAN_FOCUS: 4, FURRY_FOCUS: 5 });
const UC_HINT = Object.freeze([HINT.HEAVY, HINT.LIGHT, HINT.FURRY_FOCUS, HINT.HUMAN_FOCUS, HINT.NONE]);

export const FURRY_TAG = 'fur dataset';
export const MEDIUM_EFFORT = Object.freeze({ steps: 14, sampler: 'k_euler_ancestral', ucPreset: UC_PRESET.HEAVY, cfgRescale: 0 });

const V5_HEAVY = 'lowres, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, dithering, halftone, screentone, multiple views, logo, too many watermarks, negative space, blank page';
const V5_LIGHT = 'lowres, bad hands, bad anatomy, artistic error, sepia, white haze, worst quality, very displeasing, jpeg artifacts, 0::ai-generated::';
const V5_HUMAN = `${V5_HEAVY}, @_@, mismatched pupils, glowing eyes, bad anatomy`;
const FURRY_FOCUS = '{worst quality}, distracting watermark, unfinished, bad quality, {widescreen}, upscale, {sequence}, {{grandfathered content}}, blurred foreground, chromatic aberration, sketch, everyone, [sketch background], simple, [flat colors], ych (character), outline, multiple scenes, [[horror (theme)]], comic';
const V45_FULL_LIGHT = 'lowres, artistic error, scan artifacts, worst quality, bad quality, jpeg artifacts, multiple views, very displeasing, too many watermarks, negative space, blank page';
const V45_CURATED_HEAVY = 'blurry, lowres, upscaled, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, halftone, multiple views, logo, too many watermarks, negative space, blank page';
const V45_CURATED_LIGHT = 'blurry, lowres, upscaled, artistic error, scan artifacts, jpeg artifacts, logo, too many watermarks, negative space, blank page';
const V45_CURATED_HUMAN = 'blurry, lowres, upscaled, artistic error, film grain, scan artifacts, bad anatomy, bad hands, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, halftone, multiple views, logo, too many watermarks, @_@, mismatched pupils, glowing eyes, negative space, blank page';
const V4_FULL_HEAVY = 'blurry, lowres, error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, multiple views, logo, too many watermarks';
const V4_FULL_LIGHT = 'blurry, lowres, error, worst quality, bad quality, jpeg artifacts, very displeasing';
const V4_CURATED_HEAVY = 'blurry, lowres, error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, logo, dated, signature, multiple views, gigantic breasts';
const V4_CURATED_LIGHT = 'blurry, lowres, error, worst quality, bad quality, jpeg artifacts, very displeasing, logo, dated, signature';
const V3_HEAVY = 'lowres, {bad}, error, fewer, extra, missing, worst quality, jpeg artifacts, bad quality, watermark, unfinished, displeasing, chromatic aberration, signature, extra digits, artistic error, username, scan, [abstract]';
const V3_LIGHT = 'lowres, jpeg artifacts, worst quality, watermark, blurry, very displeasing';
const V3_HUMAN = `${V3_HEAVY}, bad anatomy, bad hands, @_@, mismatched pupils, heart-shaped pupils, glowing eyes`;

// [model, quality tags, [Heavy, Light, Furry Focus, Human Focus], full model (gets the nsfw guard), furry mode]
const MODELS = new Map([
  ['nai-diffusion-5-full', ['very aesthetic, masterpiece, no text', [V5_HEAVY, V5_LIGHT, FURRY_FOCUS, V5_HUMAN], true, true]],
  ['nai-diffusion-5-curated', ['very aesthetic, masterpiece, no text', [V5_HEAVY, V5_LIGHT, FURRY_FOCUS, V5_HUMAN], false, true]],
  ['nai-diffusion-4-5-full', ['location, very aesthetic, masterpiece, no text', [V5_HEAVY, V45_FULL_LIGHT, FURRY_FOCUS, V5_HUMAN], true, true]],
  ['nai-diffusion-4-5-curated', ['location, masterpiece, no text, -0.8::feet::, rating:general', [V45_CURATED_HEAVY, V45_CURATED_LIGHT, null, V45_CURATED_HUMAN], false, true]],
  ['nai-diffusion-4-full', ['no text, best quality, very aesthetic, absurdres', [V4_FULL_HEAVY, V4_FULL_LIGHT, null, null], true, true]],
  ['nai-diffusion-4-curated-preview', ['rating:general, amazing quality, very aesthetic, absurdres', [V4_CURATED_HEAVY, V4_CURATED_LIGHT, null, null], false, true]],
  ['nai-diffusion-3', ['best quality, amazing quality, very aesthetic, absurdres', [V3_HEAVY, V3_LIGHT, null, V3_HUMAN], true, false]]
]);

const modelEntry = model => MODELS.get(String(model || '')) || null;
export const supportsFurryMode = model => modelEntry(model)?.[3] === true;
export const supportsMediumEffort = model => String(model || '') === 'nai-diffusion-5-full';
export const usesMediumEffort = (model, effort) => effort === 'medium' && supportsMediumEffort(model);

// Reading a record back: the Medium checkpoint names itself by model id or by its Source hashes
// (93F4BD30 / 70AB5786, as NovelAI writes them), and Furry mode leaves `fur dataset` first.
export const recordedMediumEffort = (...values) => values.some(value => /nai-diffusion-5-full-medium|\b(?:93F4BD30|70AB5786)\b/i.test(String(value ?? '')));
export const recordedFurryMode = prompt => /^\s*fur dataset\s*(?:,|$)/i.test(String(prompt || ''));

export function normalizeUcPreset(value) {
  const index = Math.trunc(Number(value));
  return Number.isFinite(index) && index >= 0 && index <= UC_PRESET_MAX ? index : UC_PRESET.HEAVY;
}

// A preset the model lacks falls back the way NovelAI's client resolves it (focus presets to Heavy).
export function resolveUcPreset(model, value) {
  const index = normalizeUcPreset(value);
  if (index === UC_PRESET.NONE) return { index, text: '' };
  const texts = modelEntry(model)?.[1];
  if (!texts) return { index: UC_PRESET.NONE, text: '' };
  if (texts[index]) return { index, text: texts[index] };
  return { index: UC_PRESET.HEAVY, text: texts[0] };
}

export const ucPresetHint = index => UC_HINT[normalizeUcPreset(index)];
export function ucPresetFromHint(hint) {
  const index = UC_HINT.indexOf(Math.trunc(Number(hint)));
  return index >= 0 ? index : null;
}

// The `Text:` lettering block of a V5 prompt must stay last, whether it starts a line or follows a
// comma (`…, Text: Hello`); tags go in front of it and the original separator is kept.
function splitTextBlock(prompt) {
  const match = /(^|[\n,])[ \t]*Text:/.exec(prompt);
  if (!match) return [prompt, '', ''];
  return [prompt.slice(0, match.index), prompt.slice(match.index + match[0].indexOf('Text:')), match[1] === ',' ? ', ' : '\n'];
}

function appendBeforeTextBlock(prompt, tags) {
  const [head, text, separator] = splitTextBlock(String(prompt || ''));
  const trimmed = head.replace(/[\s,]+$/, '');
  const joined = trimmed ? `${trimmed}, ${tags}` : tags;
  return text ? `${joined}${separator}${text}` : joined;
}

const contains = (text, part) => String(text || '').toLowerCase().includes(part.toLowerCase());

// Prompt as sent: `fur dataset, ` in front for Furry mode, quality tags at the end (before Text:).
// Text a user already has (pasted back from a NovelAI image) is not added a second time.
export function composePrompt(prompt, { model, qualityToggle = false, furryMode = false } = {}) {
  let result = String(prompt || '');
  // Furry: NovelAI wants `fur dataset` first. It is an ordinary tag in the editor (1.9.1), so it is
  // moved to the front wherever it sits; `furryMode` (saved by 1.9.0) still adds it.
  if (supportsFurryMode(model)) {
    const [head, text, separator] = splitTextBlock(result);
    const tags = head.split(',');
    const at = tags.findIndex(tag => /^\s*fur dataset\s*$/i.test(tag));
    if (at > 0 || (at < 0 && furryMode)) {
      if (at > 0) tags.splice(at, 1);
      const rest = tags.join(',').trim().replace(/^,\s*|,\s*$/g, '');
      const front = rest ? `${FURRY_TAG}, ${rest}` : FURRY_TAG;
      result = text ? `${front}${separator}${text}` : front;
    }
  }
  const quality = qualityToggle ? modelEntry(model)?.[0] || '' : '';
  if (quality && !contains(splitTextBlock(result)[0], quality)) result = appendBeforeTextBlock(result, quality);
  return { prompt: result, qualityHint: quality ? HINT.STANDARD : HINT.NONE };
}

// Reading a record back (1.9.1): which automatic text really took effect, and the user's own text
// without it. A switch is on only when its text is in what was sent: Pocket before 1.9.0 (and other
// clients that sent only the flags) recorded "Quality on / Heavy" with none of the text, so honouring
// the flags would make a regeneration differ. Text the switches add again is removed, so the editor

export function separateAutoText({ model, prompt = '', negative = '', qualityToggle, ucPreset, furryMode } = {}) {
  let ownPrompt = String(prompt || ''), ownNegative = String(negative || '');
  const notes = [];
  // `fur dataset` stays in the prompt as an ordinary tag (1.9.1); composePrompt puts it first.
  const furry = furryMode === true && !recordedFurryMode(ownPrompt);

  // Quality Tags: on only when they end the tag part of the prompt (where the client puts them).
  const quality = modelEntry(model)?.[0] || '';
  let qualityOn = false;
  if (quality) {
    const [head, text, separator] = splitTextBlock(ownPrompt);
    const trimmed = head.replace(/[\s,]+$/, '');
    if (trimmed.toLowerCase().endsWith(quality.toLowerCase())) {
      const rest = trimmed.slice(0, trimmed.length - quality.length).replace(/[\s,]+$/, '');
      ownPrompt = text ? (rest ? `${rest}${separator}${text}` : text) : rest;
      qualityOn = true;
    }
  }
  if (qualityToggle === true && !qualityOn) notes.push('quality');

  // UC preset: the longest preset text the UC starts with (Human Focus begins with Heavy's text),
  // after the `nsfw, ` a Full model's client puts in front.
  const texts = modelEntry(model)?.[1] || [];
  const body = ownNegative.replace(/^\s*nsfw\s*,\s*/i, '');
  let found = null;
  texts.forEach((text, index) => {
    if (text && body.toLowerCase().startsWith(text.toLowerCase()) && (!found || text.length > found.text.length)) found = { index, text };
  });
  let preset = UC_PRESET.NONE;
  if (found) {
    preset = found.index;
    ownNegative = body.slice(found.text.length).replace(/^[\s,]+/, '');
  }
  if (ucPreset != null && normalizeUcPreset(ucPreset) !== UC_PRESET.NONE && !found) notes.push('ucPreset');
  return { prompt: ownPrompt, negative: ownNegative, qualityToggle: qualityOn, ucPreset: preset, furryMode: furry, notes };
}

// A gallery picture's saved editor state, with the automatic switches corrected to what its stored
// request (apiPayload) really carried. A state saved without the request never had the text sent.
export function effectiveSavedState(state) {
  if (!state || typeof state !== 'object' || !state.params || typeof state.params !== 'object') return state;
  const sent = state.apiPayload?.parameters;
  if (!sent || typeof sent !== 'object') return { ...state, params: { ...state.params, qualityToggle: false, ucPreset: UC_PRESET.NONE } };
  const auto = separateAutoText({
    model: state.model,
    prompt: sent.v4_prompt?.caption?.base_caption ?? sent.prompt ?? state.apiPayload.input ?? '',
    negative: sent.v4_negative_prompt?.caption?.base_caption ?? sent.negative_prompt ?? '',
    qualityToggle: state.params.qualityToggle, ucPreset: state.params.ucPreset
  });
  // 1.9.0's Furry button added the tag only to the request; keep it where it really was sent.
  const sentPrompt = sent.v4_prompt?.caption?.base_caption ?? sent.prompt ?? state.apiPayload.input ?? '';
  return { ...state, params: { ...state.params, qualityToggle: auto.qualityToggle, ucPreset: auto.ucPreset, furryMode: state.params.furryMode === true && recordedFurryMode(sentPrompt) } };
}

// UC as sent: the preset text in front of the user's UC, and on Full models `nsfw` first when the
// prompt does not ask for nsfw (NovelAI's client does the same whenever a preset applies).
export function composeNegative(negative, { model, ucPreset, prompt = '' } = {}) {
  const { index, text } = resolveUcPreset(model, ucPreset);
  const own = String(negative || '').trim();
  if (!text) return { negative: own, ucPreset: index, ucHint: ucPresetHint(index) };
  let result = contains(own, text) ? own : own ? `${text}, ${own}` : text;
  if (modelEntry(model)?.[2] && !contains(prompt, 'nsfw') && !contains(result, 'nsfw')) result = `nsfw, ${result}`;
  return { negative: result, ucPreset: index, ucHint: ucPresetHint(index) };
}
