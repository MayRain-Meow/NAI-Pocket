// Site tags retain their identity until the user explicitly formats an import.
export const BOORU_CATEGORIES = ['artist', 'copyright', 'character', 'general', 'meta'];
export const BOORU_LABELS = { artist: '画师', copyright: '作品', character: '角色', general: '通用', meta: '元信息' };
export const BOORU_DEFAULTS = Object.freeze({
  timeout: 30, cacheMiB: 32, blacklist: [], outputFilter: [],
  categories: ['copyright', 'character', 'general'], spaces: false, escapeParentheses: false
});
export const booruKey = text => String(text || '').trim().replace(/^artist\s*:\s*/i, '').replace(/\s+/g, '_').toLowerCase();
export function booruRules(value) {
  const values = Array.isArray(value) ? value : String(value || '').split(/[,，\n]+/);
  return [...new Set(values.map(value => booruKey(value).slice(0, 200)).filter(Boolean))].slice(0, 500);
}
export function matchesBooruRule(tag, rules) {
  const key = booruKey(tag);
  return rules.some(rule => {
    // A small, documented wildcard language. No regular expressions from input.
    const pattern = booruKey(rule);
    let i = 0, j = 0, star = -1, matched = 0;
    // Greedy wildcard matching avoids pathological backtracking in user rules.
    while (i < key.length) {
      if (pattern[j] === '*') { star = j++; matched = i; }
      else if (key[i] === pattern[j]) { i++; j++; }
      else if (star >= 0) { j = star + 1; i = ++matched; }
      else return false;
    }
    while (pattern[j] === '*') j++;
    return j === pattern.length;
  });
}
export function booruSelection(post, selected, settings) {
  const seen = new Set(), output = [], rules = [...settings.blacklist, ...settings.outputFilter];
  for (const category of BOORU_CATEGORIES) for (const name of post.tags[category] || []) {
    const key = booruKey(name);
    if (!selected.has(`${category}:${name}`) || seen.has(key) || matchesBooruRule(name, rules)) continue;
    seen.add(key);
    let text = settings.spaces ? name.replace(/_/g, ' ') : name;
    if (settings.escapeParentheses) text = text.replace(/[()]/g, '\\$&');
    output.push({ category, text, raw: name });
  }
  return output;
}
