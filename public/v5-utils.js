import { isV5GenerationModel } from './model-utils.js?v=1.9.42';


const V5_PROFILES = Object.freeze({
  'nai-diffusion-5-full': Object.freeze({
    label: 'V5 Full',
    promptTokenLimit: 1471,
    textCharacterLimit: 750
  }),
  'nai-diffusion-5-curated': Object.freeze({
    label: 'V5 Curated',
    promptTokenLimit: 703,
    textCharacterLimit: 374
  })
});

export function v5ModelProfile(model) {
  const value = String(model || '');
  if (V5_PROFILES[value]) return V5_PROFILES[value];
  if (isV5GenerationModel(value)) {
    return value.includes('curated') ? V5_PROFILES['nai-diffusion-5-curated'] : V5_PROFILES['nai-diffusion-5-full'];
  }
  return null;
}

export function estimatePromptTokens(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return 0;

  // V5 uses a private tokenizer. This deliberately conservative estimate is
  // for a UI warning only; the upstream remains the source of truth.
  const cjk = (text.match(/[\u3400-\u9fff\uf900-\ufaff]/gu) || []).length;
  const nonCjk = text.replace(/[\u3400-\u9fff\uf900-\ufaff]/gu, '');
  const latinUnits = (nonCjk.match(/[A-Za-z0-9]+|[^\sA-Za-z0-9]/g) || []).length;
  return cjk + latinUnits;
}

const QUOTED_TEXT_PATTERN = /"([^"\r\n]+)"|“([^”\r\n]+)”|「([^」\r\n]+)」|『([^』\r\n]+)』/gu;

export function extractQuotedText(value) {
  const source = String(value || '');
  const result = [];
  const seen = new Set();
  for (const match of source.matchAll(QUOTED_TEXT_PATTERN)) {
    const text = String(match.slice(1).find(Boolean) || '').trim();
    const key = text.toLocaleLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    result.push(text);
  }
  return result;
}

export function hasExplicitTextBlock(value) {
  return /(?:^|[\s,])text\s*:/iu.test(String(value || ''));
}

export function prepareV5Prompt(value, model, additionalQuotedText = []) {
  const prompt = String(value || '').trim();
  const profile = v5ModelProfile(model);
  if (!profile || (!prompt && !additionalQuotedText.length) || hasExplicitTextBlock(prompt)) {
    return { prompt, quotedText: [], autoTextBlock: false, profile };
  }
  const quotedText = [...new Set([
    ...extractQuotedText(prompt),
    ...(Array.isArray(additionalQuotedText) ? additionalQuotedText : []).map(item => String(item || '').trim()).filter(Boolean)
  ])];
  if (!quotedText.length) return { prompt, quotedText, autoTextBlock: false, profile };
  return {
    prompt: `${prompt ? `${prompt}\n` : ''}Text: ${quotedText.join('\n\n')}`,
    quotedText,
    autoTextBlock: true,
    profile
  };
}
