import { identifyArtistTag, NAX_V5_ARTISTS, normalizeArtistIdentity } from './artist-index-v5.js?v=1.6.81';

// Conservative local vocabulary used only when an entire comma-less phrase can
// be segmented. Unknown text is never split. The artist index supplies the
// larger and more important part of the lookup without a network request.
const COMMON_IMPORT_TAGS = new Set([
  '1girl', '1boy', '2girls', '2boys', '3girls', '3boys', 'solo', 'solo focus', 'multiple girls', 'multiple boys',
  'girl', 'boy', 'woman', 'man', 'female', 'male', 'androgynous', 'child', 'adult',
  'looking at viewer', 'facing viewer', 'looking away', 'looking back', 'eye contact', 'profile', 'from side',
  'smile', 'soft smile', 'grin', 'smirk', 'open mouth', 'closed mouth', 'blush', 'crying', 'tears', 'angry',
  'happy', 'sad', 'serious', 'expressionless', 'surprised', 'sleepy', 'shy', 'embarrassed',
  'long hair', 'short hair', 'medium hair', 'very long hair', 'bob cut', 'ponytail', 'twintails', 'braid',
  'black hair', 'brown hair', 'blonde hair', 'white hair', 'silver hair', 'grey hair', 'red hair', 'orange hair',
  'blue hair', 'green hair', 'purple hair', 'pink hair', 'multicolored hair', 'gradient hair',
  'blue eyes', 'green eyes', 'red eyes', 'brown eyes', 'purple eyes', 'yellow eyes', 'grey eyes', 'heterochromia',
  'large breasts', 'medium breasts', 'small breasts', 'flat chest', 'wide hips', 'narrow waist', 'thick thighs',
  'standing', 'sitting', 'kneeling', 'lying', 'walking', 'running', 'jumping', 'leaning', 'crouching',
  'arms crossed', 'arms behind back', 'hands on hips', 'hand on hip', 'hand to face', 'waving', 'holding',
  'school uniform', 'sailor collar', 'shirt', 't-shirt', 'blouse', 'hoodie', 'sweater', 'jacket', 'coat',
  'dress', 'skirt', 'pleated skirt', 'shorts', 'jeans', 'pants', 'thighhighs', 'stockings', 'boots', 'shoes',
  'fully clothed', 'casual clothes', 'formal wear', 'business suit', 'armor', 'gloves', 'hat', 'glasses',
  'portrait', 'upper body', 'cowboy shot', 'full body', 'close-up', 'extreme close-up', 'wide shot',
  'from above', 'from below', 'dutch angle', 'fisheye', 'depth of field', 'motion blur', 'bokeh',
  'simple background', 'white background', 'black background', 'transparent background', 'gradient background',
  'indoors', 'outdoors', 'bedroom', 'classroom', 'office', 'street', 'city', 'forest', 'beach', 'sky',
  'day', 'night', 'sunset', 'sunrise', 'rain', 'snow', 'fog', 'clouds', 'sunlight', 'moonlight',
  'dramatic', 'cinematic', 'cinematic lighting', 'dramatic lighting', 'soft lighting', 'rim lighting',
  'backlighting', 'volumetric lighting', 'natural lighting', 'studio lighting', 'neon lights', 'sun rays',
  'masterpiece', 'best quality', 'amazing quality', 'great quality', 'good quality', 'normal quality',
  'very aesthetic', 'aesthetic', 'highres', 'absurdres', 'ultra detailed', 'detailed background',
  'anime style', 'anime screencap', 'official art', 'key visual', 'illustration', 'digital art', 'concept art',
  'realistic', 'photorealistic', 'semi-realistic', '2.5d', '3d', 'cel shading', 'flat color',
  'oil painting', 'watercolor', 'sketch', 'lineart', 'monochrome', 'greyscale', 'pixel art',
  'newest', 'recent', 'oldest', 'year 2022', 'year 2023', 'year 2024', 'year 2025', 'year 2026',
  'no text', 'text', 'signature', 'watermark', 'logo', 'english text', 'japanese text'
].map(normalizeArtistIdentity));

const ARTIST_LOOKUP = new Set(NAX_V5_ARTISTS.map(normalizeArtistIdentity));
const PUNCTUATION_MAP = new Map([
  ['，', ','], ['、', ','], ['；', ','], ['｡', '.'], ['：', ':'], ['“', '"'], ['”', '"']
]);

function issueEnabled(issue, disabled) {
  return !disabled.has(issue.id);
}

function addIssue(issues, disabled, input) {
  const issue = { confidence: 'high', defaultApplied: true, ...input };
  issue.applied = issueEnabled(issue, disabled);
  issues.push(issue);
  return issue;
}

function replacePunctuation(raw, disabled, issues) {
  const counts = new Map();
  let output = '';
  for (const char of raw) {
    const replacement = PUNCTUATION_MAP.get(char);
    if (!replacement) { output += char; continue; }
    const type = char === '“' || char === '”' ? 'smart-quote' : 'punctuation';
    const occurrence = (counts.get(type) || 0) + 1;
    counts.set(type, occurrence);
    const issue = addIssue(issues, disabled, {
      id: `${type}-${occurrence}`,
      type,
      message: type === 'smart-quote' ? '弯引号已转换为普通引号' : '全角或非标准分隔符已规范',
      original: char,
      replacement
    });
    output += issue.applied ? replacement : char;
  }
  return output;
}

function unescapedQuoteIndexes(text) {
  const result = [];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== '"') continue;
    let slashes = 0;
    for (let cursor = index - 1; cursor >= 0 && text[cursor] === '\\'; cursor -= 1) slashes += 1;
    if (slashes % 2 === 0) result.push(index);
  }
  return result;
}

function repairUnmatchedQuote(text, disabled, issues) {
  const quotes = unescapedQuoteIndexes(text);
  if (quotes.length % 2 === 0) return text;
  const index = quotes.at(-1);
  const issue = addIssue(issues, disabled, {
    id: 'unmatched-quote-1',
    type: 'unmatched-quote',
    message: '发现未闭合引号，解析时已忽略该引号',
    original: '"',
    replacement: ''
  });
  if (!issue.applied) return text;
  return text.slice(0, index) + text.slice(index + 1);
}

function phraseKind(value) {
  const normalized = normalizeArtistIdentity(value);
  if (!normalized) return null;
  // During missing-comma repair, only accept an artist-prefixed segment when
  // its stripped name is also in the exact local index. Otherwise the prefix
  // could greedily swallow every following word as part of an unknown name.
  if (ARTIST_LOOKUP.has(normalized)) return 'artist';
  if (COMMON_IMPORT_TAGS.has(normalized)) return 'tag';
  return null;
}

function bestKnownSegmentation(segment) {
  const words = String(segment).trim().split(/\s+/).filter(Boolean);
  if (words.length < 2 || words.length > 18) return null;
  const dp = Array(words.length + 1).fill(null);
  dp[words.length] = [];
  for (let start = words.length - 1; start >= 0; start -= 1) {
    let best = null;
    for (let end = words.length; end > start; end -= 1) {
      const literal = words.slice(start, end).join(' ');
      const kind = phraseKind(literal);
      if (!kind || !dp[end]) continue;
      const candidate = [{ literal, kind }, ...dp[end]];
      if (!best || candidate.length < best.length) best = candidate;
    }
    dp[start] = best;
  }
  return dp[0]?.length > 1 ? dp[0] : null;
}

function repairMissingCommas(text, disabled, issues) {
  const chunks = text.split(/([,，、；\n])/);
  let occurrence = 0;
  return chunks.map(chunk => {
    if ([',', '，', '、', '；', '\n'].includes(chunk) || !chunk.trim() || chunk.includes('::')) return chunk;
    const leading = chunk.match(/^\s*/)?.[0] || '';
    const trailing = chunk.match(/\s*$/)?.[0] || '';
    const core = chunk.trim();
    const segmentation = bestKnownSegmentation(core);
    if (!segmentation) return chunk;
    occurrence += 1;
    const replacement = segmentation.map(item => item.literal).join(', ');
    const includesArtist = segmentation.some(item => item.kind === 'artist');
    const issue = addIssue(issues, disabled, {
      id: `missing-comma-${occurrence}`,
      type: 'missing-comma',
      confidence: includesArtist ? 'high' : 'review',
      message: includesArtist ? '画师与相邻 Tag 之间疑似漏逗号' : '多个已知 Tag 之间疑似漏逗号，请审核',
      original: core,
      replacement
    });
    return `${leading}${issue.applied ? replacement : core}${trailing}`;
  }).join('');
}

export function repairImportedPrompt(raw, options = {}) {
  const originalText = String(raw ?? '').replace(/\r/g, '');
  const prefix = options.idPrefix ? `${String(options.idPrefix).replace(/:+$/g, '')}:` : '';
  const disabled = new Set((Array.isArray(options.disabledIssueIds) ? options.disabledIssueIds : [])
    .filter(id => !prefix || String(id).startsWith(prefix))
    .map(id => prefix ? String(id).slice(prefix.length) : String(id)));
  const issues = [];
  // Escape backslashes are kept: import restores the text the image was made with
  // (owner, 2026-10-06). Typed and pasted editor input still drops them (prompt-utils).
  let repairedText = replacePunctuation(originalText, disabled, issues);
  repairedText = repairUnmatchedQuote(repairedText, disabled, issues);
  repairedText = repairMissingCommas(repairedText, disabled, issues);
  if (prefix) issues.forEach(issue => { issue.id = `${prefix}${issue.id}`; });
  return {
    originalText,
    repairedText,
    issues,
    corrections: issues.filter(issue => issue.applied).length,
    pendingReview: issues.filter(issue => issue.confidence === 'review' && issue.applied).length
  };
}

function stripCodeFence(text, disabled, issues) {
  const match = text.match(/^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/i);
  if (!match) return text;
  const issue = addIssue(issues, disabled, {
    id: 'json-code-fence-1', type: 'json-code-fence', message: '已移除 JSON 外层代码块', original: '```', replacement: ''
  });
  return issue.applied ? match[1] : text;
}

function replaceJsonPunctuation(raw, disabled, issues) {
  const counts = new Map();
  let output = '';
  let inString = false;
  let escaped = false;
  for (const char of raw) {
    if (char === '"' && !escaped) {
      inString = !inString;
      output += char;
      escaped = false;
      continue;
    }
    if ((char === '“' || char === '”') && !escaped) {
      const occurrence = (counts.get('smart-quote') || 0) + 1;
      counts.set('smart-quote', occurrence);
      const issue = addIssue(issues, disabled, {
        id: `smart-quote-${occurrence}`, type: 'smart-quote', message: 'JSON 弯引号已转换为普通引号', original: char, replacement: '"'
      });
      output += issue.applied ? '"' : char;
      if (issue.applied) inString = !inString;
      escaped = false;
      continue;
    }
    const replacement = inString ? null : PUNCTUATION_MAP.get(char);
    if (replacement) {
      const occurrence = (counts.get('punctuation') || 0) + 1;
      counts.set('punctuation', occurrence);
      const issue = addIssue(issues, disabled, {
        id: `punctuation-${occurrence}`, type: 'punctuation', message: 'JSON 结构中的全角标点已规范', original: char, replacement
      });
      output += issue.applied ? replacement : char;
    } else {
      output += char;
    }
    escaped = char === '\\' && !escaped;
    if (char !== '\\') escaped = false;
  }
  return output;
}

function repairEscapedJsonKeySeparators(raw, disabled, issues) {
  let occurrence = 0;
  return String(raw).replace(/("(?:\\.|[^"\\])*")(\s*:)/g, (whole, quoted, suffix) => {
    const body = quoted.slice(1, -1);
    if (!/\\_/.test(body)) return whole;
    const fixed = body.replace(/\\_/g, '_');
    const issue = addIssue(issues, disabled, {
      id: `json-escaped-key-${++occurrence}`,
      type: 'json-escaped-key',
      message: 'JSON 字段名中的转义下划线已规范',
      original: quoted,
      replacement: `"${fixed}"`
    });
    return `${issue.applied ? `"${fixed}"` : quoted}${suffix}`;
  });
}

// A few clipboard/Markdown paths escape every underscore, including inside
// JSON string values (`"k\\_euler\\_ancestral"`).  `\\_` is not a legal JSON
// escape, so JSON.parse would otherwise reject an otherwise recoverable Raw
// Parameters record.  Repair only this known-invalid escape; keep `\\\\_`
// (a deliberately encoded literal backslash followed by an underscore)
// untouched by consuming escape pairs in the scanner below.
function repairEscapedJsonStringUnderscores(raw, disabled, issues) {
  let occurrence = 0;
  return String(raw).replace(/"(?:\\.|[^"\\])*"/g, (quoted) => {
    const body = quoted.slice(1, -1);
    let fixed = '';
    let changed = false;
    for (let index = 0; index < body.length; index += 1) {
      const char = body[index];
      if (char === '\\' && body[index + 1] === '_') {
        fixed += '_';
        index += 1;
        changed = true;
        continue;
      }
      fixed += char;
      // Keep ordinary JSON escape pairs byte-for-byte intact.
      if (char === '\\' && index + 1 < body.length) {
        fixed += body[index + 1];
        index += 1;
      }
    }
    if (!changed) return quoted;
    const issue = addIssue(issues, disabled, {
      id: `json-escaped-string-${++occurrence}`,
      type: 'json-escaped-string',
      message: 'JSON 字符串中的非法下划线转义已规范',
      original: quoted,
      replacement: `"${fixed}"`
    });
    return issue.applied ? `"${fixed}"` : quoted;
  });
}

// Temporarily hide JSON string literals while repairing the outer punctuation.
// A plain regexp over the source can mistake a quoted object key for a quoted
// value (and insert commas inside "key":). Keeping the literals in a side
// table makes the repair conservative and reversible.
function maskJsonStrings(text) {
  const strings = [];
  const nul = String.fromCharCode(0);
  let output = '';
  let index = 0;
  while (index < text.length) {
    if (text[index] !== '"') {
      output += text[index++];
      continue;
    }
    const start = index;
    index += 1;
    let escaped = false;
    while (index < text.length) {
      const char = text[index++];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === '\\') {
        escaped = true;
        continue;
      }
      if (char === '"') break;
    }
    const token = nul + 'JSON_STRING_' + strings.length + nul;
    strings.push(text.slice(start, index));
    output += token;
  }
  return { text: output, strings };
}

function unmaskJsonStrings(text, strings) {
  return text.replace(/\u0000JSON_STRING_(\d+)\u0000/g, (whole, index) => strings[Number(index)] || whole);
}

// Return whether an index is inside a JSON string literal.  This is used only
// as a guard around structural repair regexes; the scan intentionally treats
// escaped quotes like JSON does and never changes the source text itself.
function isInsideJsonString(text, targetIndex) {
  let inString = false;
  let escaped = false;
  for (let index = 0; index < targetIndex; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) { escaped = false; continue; }
      if (char === '\\') { escaped = true; continue; }
      if (char === '"') inString = false;
    } else if (char === '"') {
      inString = true;
    }
  }
  return inString;
}

export function repairJsonSyntax(raw, options = {}) {
  const disabled = new Set(Array.isArray(options.disabledIssueIds) ? options.disabledIssueIds : []);
  const issues = [];
  let text = stripCodeFence(String(raw ?? '').trim(), disabled, issues);
  text = repairEscapedJsonKeySeparators(text, disabled, issues);
  text = repairEscapedJsonStringUnderscores(text, disabled, issues);
  text = replaceJsonPunctuation(text, disabled, issues);

  let occurrence = 0;
  // Mask quoted values before looking for unquoted keys.  Prompt strings
  // frequently contain weighted syntax such as `{artist:foo}`; applying the
  // key regex to the raw text would mistake that content for an outer JSON
  // key and corrupt the Prompt while repairing an unrelated field.
  const maskedKeys = maskJsonStrings(text);
  let repairedKeys = maskedKeys.text.replace(/([{,]\s*)([A-Za-z_][\w.-]*)(\s*:)/g, (whole, prefix, key, suffix) => {
    occurrence += 1;
    const issue = addIssue(issues, disabled, {
      id: `json-unquoted-key-${occurrence}`, type: 'json-unquoted-key', message: `JSON 字段 ${key} 缺少引号`, original: key, replacement: `"${key}"`
    });
    return issue.applied ? `${prefix}"${key}"${suffix}` : whole;
  });
  text = unmaskJsonStrings(repairedKeys, maskedKeys.strings);

  occurrence = 0;
  // Some copied Raw Parameters lose the comma and the following key is
  // pasted immediately after a primitive (`null"upscaled_enhance"`).  Allow
  // zero whitespace here, while still requiring a value token followed by a
  // key/colon shape so normal text inside a quoted string is not touched.
  const maskedJson = maskJsonStrings(text);
  let repairedMasked = maskedJson.text.replace(/(-?(?:\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|true|false|null|[}\]])(\s*)(?=(?:\u0000JSON_STRING_\d+\u0000|[A-Za-z_][\w.-]*)\s*:)/g, (whole, value, spacing) => {
    occurrence += 1;
    const issue = addIssue(issues, disabled, {
      id: `json-missing-comma-${occurrence}`, type: 'json-missing-comma', message: 'JSON 字段之间疑似漏逗号', original: spacing, replacement: `,${spacing}`
    });
    return issue.applied ? `${value},${spacing}` : whole;
  });

  text = unmaskJsonStrings(repairedMasked, maskedJson.strings);

  // Also handle a quoted value followed by a key, but only when the value is
  // reached from a colon. This prevents a key's closing quote from being
  // mistaken for the preceding value.
  text = text.replace(/(:\s*)("(?:\\.|[^"\\])*?")(\s*)(?="?[A-Za-z_][\w.-]*"?\s*:)/g, (whole, prefix, value, spacing, offset, fullText) => {
    // A colon/key-shaped sequence inside a Prompt or other string is not a
    // missing JSON delimiter.  Keep it byte-for-byte intact.
    if (isInsideJsonString(fullText, offset)) return whole;
    occurrence += 1;
    const issue = addIssue(issues, disabled, {
      id: 'json-missing-comma-' + occurrence, type: 'json-missing-comma', message: 'JSON 字段之间疑似漏逗号', original: spacing, replacement: ',' + spacing
    });
    return issue.applied ? prefix + value + ',' + spacing : whole;
  });

  // A key after a newly inserted comma was not reachable during the first
  // unquoted-key pass, so quote only those newly exposed keys now.
  let keyOccurrence = issues.filter(issue => issue.type === 'json-unquoted-key').length;
  const maskedFinalKeys = maskJsonStrings(text);
  let repairedFinalKeys = maskedFinalKeys.text.replace(/([{,]\s*)([A-Za-z_][\w.-]*)(\s*:)/g, (whole, prefix, key, suffix) => {
    keyOccurrence += 1;
    const issue = addIssue(issues, disabled, {
      id: `json-unquoted-key-${keyOccurrence}`, type: 'json-unquoted-key', message: `JSON 字段 ${key} 缺少引号`, original: key, replacement: `"${key}"`
    });
    return issue.applied ? `${prefix}"${key}"${suffix}` : whole;
  });
  text = unmaskJsonStrings(repairedFinalKeys, maskedFinalKeys.strings);

  occurrence = 0;
  text = text.replace(/,\s*([}\]])/g, (whole, closing) => {
    occurrence += 1;
    const issue = addIssue(issues, disabled, {
      id: `json-trailing-comma-${occurrence}`, type: 'json-trailing-comma', message: '已移除 JSON 尾部多余逗号', original: whole, replacement: closing
    });
    return issue.applied ? closing : whole;
  });

  const quotes = unescapedQuoteIndexes(text);
  if (quotes.length % 2 === 1 && /[}\]]\s*$/.test(text)) {
    const closingIndex = text.search(/[}\]]\s*$/);
    const issue = addIssue(issues, disabled, {
      id: 'json-unclosed-quote-1', type: 'json-unclosed-quote', confidence: 'review', message: 'JSON 末尾疑似漏写字符串引号', original: '', replacement: '"'
    });
    if (issue.applied && closingIndex >= 0) text = `${text.slice(0, closingIndex)}"${text.slice(closingIndex)}`;
  }

  return { originalText: String(raw ?? ''), repairedText: text, issues, corrections: issues.filter(issue => issue.applied).length };
}

export const __test = { bestKnownSegmentation, COMMON_IMPORT_TAGS };
