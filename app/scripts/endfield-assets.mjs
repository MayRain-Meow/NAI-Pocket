import fs from 'node:fs/promises';
import path from 'node:path';
import postcss from 'postcss';

// Category colors carry meaning. Preserve those relationships while choosing
// readable shades for each theme; neutralize decorative legacy colors below.
const semanticHues = {
  '#8fbf9f': '--ef-scene', '#86aee0': '--ef-camera',
  '#d6b38a': '--ef-style', '#b0a4d6': '--ef-misc',
  '#e2a6bb': '--ef-character', '#d98a8a': '--ef-negative',
  '#e98a8a': '--ef-negative', '#7fc4b8': '--ef-params'
};

// An optional visual adapter for the inherited component styles. Layout, image
// pixels, masks and editing canvases are not transformed. Theme tokens live in
// public/endfield/theme.css; removing this adapter restores the original skin.
export async function writeEndfieldAssets(project, out) {
  const source = path.join(project, 'public/endfield');
  await fs.cp(source, path.join(out, 'endfield'), { recursive: true });
  const sheets = ['styles.css', 'workspace.css', 'tag-chips.css', 'artist-browser.css', 'artist-library.css', 'native.css'];
  const result = postcss.root();
  for (const name of sheets) {
    const root = postcss.parse(await fs.readFile(path.join(out, name), 'utf8'));
    root.walkRules(rule => {
      if (!rule.parent || rule.parent.type === 'atrule' && /keyframes/.test(rule.parent.name)) return;
      if (/:root|canvas|mask-canvas|brush-cursor|inpaint-mask|color-swatch/.test(rule.selector)) { rule.remove(); return; }
      rule.walkDecls(decl => {
        const p = decl.prop;
        if (p.startsWith('--') && /#[0-9a-f]{3,8}\b|rgba?\(/i.test(decl.value)) {
          if (p === '--chip-hue') { decl.value = 'var(--hue, var(--ef-muted))'; return; }
          const semantic = /^--hue2?$/.test(p) && semanticHues[decl.value.trim().toLowerCase()];
          if (semantic) { decl.value = `var(${semantic})`; return; }
          decl.value = /surface|field|panel/.test(p) ? 'var(--ef-surface)'
            : /line/.test(p) ? 'var(--ef-line)' : /muted|faint/.test(p) ? 'var(--ef-muted)'
              : /danger/.test(p) ? 'var(--ef-delete)' : 'var(--ef-ink)';
          return;
        }
        if (/^(border.*radius|box-shadow|text-shadow|backdrop-filter)$/.test(p)) {
          decl.value = p.includes('radius') ? '0' : 'none'; return;
        }
        if (!/^(color|background(-color)?|border(-[\w-]+)?|outline(-color)?|fill|stroke|scrollbar-color)$/.test(p) || !/#(?:[0-9a-f]{3,8})\b|rgba?\(/i.test(decl.value)) { decl.remove(); return; }
        if (/gradient\(/.test(decl.value)) { decl.value = 'var(--ef-surface)'; return; }
        decl.value = decl.value.replace(/#[0-9a-f]{3,8}\b|rgba?\([^)]*\)/gi, token => {
          let rgb, alpha = 1;
          if (token[0] === '#') {
            let h = token.slice(1); if (h.length < 5) h = [...h].map(c => c + c).join('');
            rgb = [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16));
            if (h.length === 8) alpha = parseInt(h.slice(6), 16) / 255;
          } else {
            const nums = token.match(/[\d.]+/g)?.map(Number) || [0, 0, 0];
            rgb = nums.slice(0, 3); alpha = nums[3] ?? 1;
          }
          if (alpha === 0) return 'transparent';
          if (p.startsWith('border') || p.startsWith('outline')) return 'var(--ef-line)';
          if (rule.selector.includes('::backdrop')) return 'rgb(0 0 0 / .55)';
          if (p === 'color' || p === 'fill' || p === 'stroke') {
            const l = Math.max(...rgb);
            return l < 60 ? 'var(--ef-ink)' : l < 190 ? 'var(--ef-muted)' : 'var(--ef-ink)';
          }
          return alpha < .25 ? 'var(--ef-soft)' : Math.max(...rgb) < 30 ? 'var(--ef-paper)' : 'var(--ef-surface)';
        });
      });
      if (!rule.nodes.length) rule.remove();
    });
    root.walkAtRules(rule => { if (/keyframes|font-face/.test(rule.name) || !rule.nodes?.length) rule.remove(); });
    result.append(root.nodes);
  }
  await fs.writeFile(path.join(out, 'endfield/compat.css'), result.toString());
}
