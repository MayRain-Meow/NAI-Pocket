export function cleanOuter(value) {
  return String(value ?? '').replace(/^\s+|\s+$/g, '');
}

export function normalizeTagText(value) {
  return cleanOuter(String(value ?? '').replace(/^,+|,+$/g, ''));
}

// NovelAI has no escape character. A backslash in front of ( ) [ ] { } : is the
// Stable Diffusion / Danbooru-copy convention (name_\(series\)); sent as-is it is a
// stray character, and before a closing :: it broke the weight block (…)\:: → ::::).
// A backslash that starts a Tag is kept: it belongs to the tag itself (\(^o^)/).
export const PROMPT_ESCAPE_PATTERN = /(?<!(?:^|[,，;|:])\s*)\\+(?=[()[\]{}:])/g;
export function stripPromptEscapes(value) {
  return String(value ?? '').replace(PROMPT_ESCAPE_PATTERN, '');
}

export function tokenizePrompt(raw) {
  const text = String(raw ?? '').replace(/，/g, ',').replace(/\r/g, '');
  const result = [];
  let buffer = '';
  let weightedScope = false;
  const stack = [];
  const pairs = { '(': ')', '[': ']', '{': '}' };

  const flush = () => {
    const token = normalizeTagText(buffer);
    if (token) result.push(token);
    buffer = '';
  };

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (char === ':' && next === ':') {
      weightedScope = !weightedScope;
      buffer += '::';
      index += 1;
      continue;
    }

    if (pairs[char]) stack.push(pairs[char]);
    else if (stack.length && char === stack[stack.length - 1]) stack.pop();

    if ((char === ',' || char === '\n') && !weightedScope && stack.length === 0) {
      flush();
      continue;
    }

    buffer += char;
  }

  flush();
  return result;
}

export function isNumericArtistTag(text) {
  return /^artist\s*:\s*[^,]+\d$/i.test(String(text ?? '').trim());
}

// Any weighted Tag ending in a digit needs one space before the closing
// delimiter: NovelAI reads "year 2025::" as the start of a new weight block
// ("2025::", weight 2025), which turns the whole image black. 10::year 2025 ::
export function endsWithDigit(text) {
  return /\d$/.test(String(text ?? '').trim());
}

// Legacy NovelAI brackets around a whole token: each { } layer ×1.05, each
// [ ] layer ÷1.05. Returns null unless at least one balanced layer wraps the
// entire token (so "{a} {b}" or "a {b}" stay literal).
export function unwrapLegacyBrackets(value) {
  let text = String(value ?? '').trim();
  let up = 0, down = 0;
  const wrapsWhole = candidate => {
    let depth = 0;
    for (let index = 0; index < candidate.length; index += 1) {
      const char = candidate[index];
      if (char === '\\') { index += 1; continue; }
      if (char === candidate[0]) depth += 1;
      else if (char === (candidate[0] === '{' ? '}' : ']')) depth -= 1;
      if (depth === 0 && index < candidate.length - 1) return false;
    }
    return depth === 0;
  };
  while (text.length >= 3) {
    const open = text[0], close = text[text.length - 1];
    if (!((open === '{' && close === '}') || (open === '[' && close === ']')) || !wrapsWhole(text)) break;
    if (open === '{') up += 1; else down += 1;
    text = text.slice(1, -1).trim();
  }
  if (!up && !down || !text) return null;
  return { text, weight: Number((1.05 ** (up - down)).toFixed(6)) };
}

export function parseTagToken(raw, options = {}) {
  const literal = normalizeTagText(raw);
  const match = literal.match(/^([+-]?(?:\d+(?:\.\d+)?|\.\d+))::([\s\S]*)::$/);

  // Brackets carry a real weight, but the original text is kept (preserveRaw)
  // so imported prompts are reproduced exactly; changing the weight switches
  // the Tag to the numeric form.
  const bracket = match ? null : unwrapLegacyBrackets(literal);
  if (bracket) {
    return {
      text: bracket.text,
      exactText: bracket.text,
      weight: bracket.weight,
      enabled: true,
      translation: '',
      bundle: options.bundle === true || tokenizePrompt(bracket.text).length > 1,
      preserveRaw: true,
      raw: literal,
      originalText: bracket.text,
      originalExactText: bracket.text,
      originalWeight: bracket.weight
    };
  }

  if (!match) {
    return {
      text: literal,
      exactText: literal,
      weight: 1,
      enabled: true,
      translation: '',
      bundle: options.bundle === true,
      preserveRaw: options.preserveRaw === true,
      raw: options.preserveRaw === true ? literal : '',
      originalText: literal,
      originalExactText: literal,
      originalWeight: 1
    };
  }

  const exactText = match[2];
  const text = exactText.trim();
  const parsedWeight = Number(match[1]);
  const weight = Number.isFinite(parsedWeight) ? parsedWeight : 1;

  return {
    text,
    exactText,
    weight,
    enabled: true,
    translation: '',
    bundle: options.bundle === true || tokenizePrompt(exactText).length > 1,
    preserveRaw: true,
    raw: literal,
    originalText: text,
    originalExactText: exactText,
    originalWeight: weight
  };
}

export function splitInputToTags(raw, mode = 'split') {
  if (mode === 'whole') {
    const parsed = parseTagToken(raw, { bundle: true, preserveRaw: true });
    return parsed.text ? [parsed] : [];
  }
  return tokenizePrompt(stripPromptEscapes(raw)).map(token => parseTagToken(token)).filter(tag => tag.text);
}

function weightText(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '1';
  return String(Number(n.toFixed(4)));
}

// True while a Tag still outputs its original { } / [ ] text.
export function hasLegacyBrackets(tag) {
  return Boolean(tag?.preserveRaw && /^[{[]/.test(String(tag.raw || '')) && formatTag(tag) === tag.raw);
}

export function formatTag(tag) {
  if (!tag || tag.enabled === false) return '';
  const text = String(tag.text ?? '').trim();
  if (!text) return '';
  const weight = Number(tag.weight ?? 1);

  const rawStillValid = Boolean(
    tag.preserveRaw &&
    tag.raw &&
    text === String(tag.originalText ?? '').trim() &&
    Number(tag.originalWeight ?? 1) === weight
  );
  if (rawStillValid) {
    if ((isNumericArtistTag(text) && !/ \::$/.test(tag.raw)) || (endsWithDigit(text) && /\d::$/.test(String(tag.raw).trim()))) {
      return `${weightText(weight)}::${text.trimEnd()} ::`;
    }
    return tag.raw;
  }

  if (Math.abs(weight - 1) < 0.0001) return text;

  // Tags ending in a digit keep one space before the closing delimiter,
  // e.g. 2::artist:dishwasher1910 :: or 10::year 2025 ::
  const content = endsWithDigit(text) ? `${text.trimEnd()} ` : text;
  return `${weightText(weight)}::${content}::`;
}

export function cloneTagForStorage(tag) {
  return {
    id: tag.id,
    text: String(tag.text ?? ''),
    exactText: String(tag.exactText ?? tag.text ?? ''),
    weight: Number(tag.weight ?? 1),
    enabled: tag.enabled !== false,
    translation: String(tag.translation ?? ''),
    bundle: tag.bundle === true,
    preserveRaw: tag.preserveRaw === true,
    raw: String(tag.raw ?? ''),
    originalText: String(tag.originalText ?? tag.text ?? ''),
    originalExactText: String(tag.originalExactText ?? tag.exactText ?? tag.text ?? ''),
    originalWeight: Number(tag.originalWeight ?? tag.weight ?? 1),
    originalOrder: tag.originalOrder === null || tag.originalOrder === undefined || tag.originalOrder === ''
      ? null
      : (Number.isFinite(Number(tag.originalOrder)) ? Number(tag.originalOrder) : null)
  };
}

export function parseStructuredPrompt(raw) {
  const lines = String(raw ?? '').replace(/\r/g, '').split('\n');
  const characterMap = new Map();
  const globalPromptLines = [];
  const globalUcLines = [];
  let section = { type: 'global-prompt' };

  const ensureCharacter = number => {
    if (!characterMap.has(number)) {
      characterMap.set(number, { number, name: '', promptRaw: '', ucRaw: '', enabled: true });
    }
    return characterMap.get(number);
  };

  const append = (target, value) => {
    if (!value) return target;
    return target ? `${target}\n${value}` : value;
  };

  for (const originalLine of lines) {
    const trimmed = originalLine.trim();
    const header = trimmed.match(/^(?:Character|角色)\s*(\d+)\s*(Name|Prompt|UC|名称|正向|负面)\s*[:：]\s*(.*)$/i);
    if (header) {
      const number = Math.max(1, Number(header[1]) || 1);
      const fieldRaw = header[2].toLowerCase();
      const field = ['name', '名称'].includes(fieldRaw) ? 'name' : ['uc', '负面'].includes(fieldRaw) ? 'uc' : 'prompt';
      const character = ensureCharacter(number);
      section = { type: `character-${field}`, number };
      const rest = header[3].trim();
      if (field === 'name') character.name = rest;
      else if (field === 'prompt') character.promptRaw = append(character.promptRaw, rest);
      else character.ucRaw = append(character.ucRaw, rest);
      // When the header already contains content, treat it as a complete inline
      // character block. The next unlabelled line returns to the global prompt.
      if (rest) section = { type: 'global-prompt' };
      continue;
    }

    const globalHeader = trimmed.match(/^(?:Global|Base|全局)\s*(Prompt|UC|正向|负面)\s*[:：]\s*(.*)$/i);
    if (globalHeader) {
      const fieldRaw = globalHeader[1].toLowerCase();
      const isUc = ['uc', '负面'].includes(fieldRaw);
      section = { type: isUc ? 'global-uc' : 'global-prompt' };
      const rest = globalHeader[2].trim();
      if (rest) (isUc ? globalUcLines : globalPromptLines).push(rest);
      continue;
    }

    // A blank line ends an implicit character block. Subsequent unlabelled
    // content returns to the global prompt instead of being swallowed by the character.
    if (!trimmed) {
      if (section.type.startsWith('character-')) section = { type: 'global-prompt' };
      continue;
    }

    if (section.type === 'global-uc') {
      globalUcLines.push(trimmed);
    } else if (section.type === 'global-prompt') {
      globalPromptLines.push(trimmed);
    } else {
      const character = ensureCharacter(section.number);
      if (section.type === 'character-name') character.name = append(character.name, trimmed);
      else if (section.type === 'character-uc') character.ucRaw = append(character.ucRaw, trimmed);
      else character.promptRaw = append(character.promptRaw, trimmed);
    }
  }

  return {
    characters: [...characterMap.values()].sort((a, b) => a.number - b.number),
    globalPrompt: globalPromptLines.join('\n'),
    globalUc: globalUcLines.join('\n')
  };
}
