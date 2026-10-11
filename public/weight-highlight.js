// Weighted spans in a prompt textarea get a tinted background: warm for raised weight
// (`1.2::…::`, `{…}`), cool for lowered weight (`0.8::…::`, `[…]`), stronger tint for a
// stronger weight. A mirror div behind the textarea paints only the backgrounds (its text is
// transparent) and the textarea itself turns transparent, so typing, selection and the caret
// stay native. Programmatic value changes are caught by wrapping the element's value setter.

const SEGMENT = /(-?\d+(?:\.\d+)?)::([\s\S]*?)::|(\{+)([^{}]*?)(\}+)|(\[+)([^[\]]*?)(\]+)/g;

const escape = text => text.replace(/[&<>]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[char]);

function strength(delta) {
  return Math.max(1, Math.min(3, Math.ceil(Math.abs(delta) / 0.15)));
}

export function weightHighlightHtml(text) {
  let html = '', last = 0;
  for (const match of String(text).matchAll(SEGMENT)) {
    html += escape(text.slice(last, match.index));
    let tone = '', level = 1;
    if (match[1] !== undefined) {
      const weight = Number(match[1]);
      if (weight > 1) { tone = 'up'; level = strength(weight - 1); }
      else if (weight < 1) { tone = 'down'; level = strength(1 - weight); }
    } else if (match[3] !== undefined) {
      tone = 'up'; level = Math.min(3, Math.min(match[3].length, match[5].length));
    } else {
      tone = 'down'; level = Math.min(3, Math.min(match[6].length, match[8].length));
    }
    html += tone ? `<mark class="weight-${tone} weight-${level}">${escape(match[0])}</mark>` : escape(match[0]);
    last = match.index + match[0].length;
  }
  // A trailing newline needs a character after it to keep its line height in the mirror.
  return html + escape(text.slice(last)) + '\u200b';
}

export function attachWeightHighlight(textarea, { isEnabled = () => true } = {}) {
  if (!textarea || textarea.dataset.weightHighlight) return null;
  textarea.dataset.weightHighlight = '1';
  const wrap = document.createElement('div');
  wrap.className = 'weight-highlight-wrap';
  const mirror = document.createElement('div');
  mirror.className = 'weight-highlight-mirror';
  mirror.setAttribute('aria-hidden', 'true');
  textarea.before(wrap);
  wrap.append(mirror, textarea);
  // The mirror must lay text out exactly like the textarea, or the tints drift off the words.
  const METRICS = ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'lineHeight', 'letterSpacing', 'wordSpacing', 'textIndent', 'tabSize',
    'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth', 'boxSizing'];
  const render = () => {
    const on = isEnabled();
    wrap.classList.toggle('is-active', on);
    if (!on) return;
    const style = getComputedStyle(textarea);
    for (const key of METRICS) mirror.style[key] = style[key];
    mirror.innerHTML = weightHighlightHtml(textarea.value);
    mirror.scrollTop = textarea.scrollTop;
  };
  const native = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
  Object.defineProperty(textarea, 'value', {
    configurable: true,
    get() { return native.get.call(this); },
    set(value) { native.set.call(this, value); render(); }
  });
  textarea.addEventListener('input', render);
  textarea.addEventListener('scroll', () => { mirror.scrollTop = textarea.scrollTop; });
  render();
  return { render };
}
