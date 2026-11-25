import { cleanText, hasCjk, getBuiltin } from './translation-core.js?v=1.9.48';

export const translationKey = text => cleanText(text).toLowerCase();
export const hasTagMeaning = tag => Boolean(tag?.translation && (hasCjk(tag.translation) || getBuiltin(tag.text, 'en', 'zh-CN') === tag.translation));
export const needsTagMeaning = (tag, isArtist = () => false) => Boolean(tag?.text && !hasCjk(tag.text) && !isArtist(tag.text) && !hasTagMeaning(tag));

// One bounded batch; preserve target references and text across the async request.

export async function fillTagMeanings(tags, { request, apply, isArtist }) {
  const pending = tags.filter(tag => needsTagMeaning(tag, isArtist)).map(tag => ({ tag, text: tag.text }));
  const items = [...new Set(pending.filter(({text}) => text.trim().replace(/\s+/g, ' ').length <= 500).map(({text}) => cleanText(text)))];
  if (!pending.length) return { changed: 0, missing: 0, failed: 0 };
  const results = items.length ? await request(items) : [];
  const map = new Map(results.map(item => [translationKey(item.sourceText), item]));
  let changed = 0, missing = 0, failed = 0;
  for (const {tag, text} of pending) {
    if (tag.text !== text) { missing++; continue; }
    const result = text.trim().replace(/\s+/g, ' ').length <= 500 ? map.get(translationKey(text)) : null;
    if (!result?.text || !hasTagMeaning({text, translation:result.text})) {
      if (result?.status === 'error') failed++; else missing++;
      continue;
    }
    tag.translation = result.text;
    apply(tag, result.text);
    changed++;
  }
  return { changed, missing, failed };
}
