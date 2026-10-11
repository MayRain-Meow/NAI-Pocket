import postcss from 'postcss';
import { parse, serialize } from 'parse5';

export function publicCss(source) {
  const root = postcss.parse(source);
  root.walkComments(comment => { if (!/^!|license|copyright/i.test(comment.text.trim())) comment.remove(); });
  // The artist-library UI ships in the app (owner decision 2026-10-10); management panels do not.
  const privateSelector = /artist-automation|artist-ingestion|nax-mirror|annotation-settings|visitor-settings|renewal-settings/i;
  root.walkRules(rule => { rule.selectors = rule.selectors.filter(selector => !privateSelector.test(selector)); if (!rule.selectors.length) rule.remove(); });
  root.walkAtRules(rule => { if (rule.nodes && !rule.nodes.length) rule.remove(); });
  return root.toString();
}

export function publicHtml(source) {
  const root = parse(source);
  const privateIds = new Set(['stormTab','artistAnnotationSettings','renewalDialog','storageAuditButton','galleryScopeRotation','dialogSimilarFromImage','installButton','logoutButton']);
  const privateClasses = new Set(['annotation-settings-section','visitor-settings-section','renewal-settings-section','account-settings-section']);
  function walk(node) {
    if (!node.childNodes) return;
    node.childNodes = node.childNodes.filter(child => {
      if (child.nodeName === '#comment') return false;
      const attrs = Object.fromEntries((child.attrs || []).map(attr => [attr.name, attr.value]));
      if (privateIds.has(attrs.id) || String(attrs.class || '').split(/\s+/).some(value => privateClasses.has(value))) return false;
      if (attrs['data-tab'] === 'storm' || attrs['data-menu-action'] === 'renewal' || attrs['data-gallery-proxy'] === 'storageAuditButton' || attrs['data-proxy'] === '#logoutButton') return false;
      if (child.tagName === 'link' && /manifest\.webmanifest/.test(attrs.href || '')) return false;
      if (child.tagName === 'link' && /^\/artist-library\.css/.test(attrs.href || '')) child.attrs.find(attr => attr.name === 'href').value = '/artist-library.css';
      if (child.tagName === 'script' && /^\/app\.js/.test(attrs.src || '')) child.attrs.find(attr => attr.name === 'src').value = '/main.js';
      // The app never logs in: start with the login view hidden and a launch screen until
      // the local database is open (main.js removes native-booting), so nothing flashes.
      const setClass = value => { const attr = child.attrs.find(item => item.name === 'class'); if (attr) attr.value = value; else child.attrs.push({ name: 'class', value }); };
      if (child.tagName === 'body') setClass(`${attrs.class ? attrs.class + ' ' : ''}native-mode native-booting`);
      if (attrs.id === 'loginView') setClass(`${attrs.class || ''} hidden`.trim());
      walk(child); return true;
    });
  }
  walk(root);
  let html = serialize(root);
  for (const file of ['native.css','artist-browser.css']) if (!html.includes(`href="/${file}"`)) html=html.replace('</head>',`<link rel="stylesheet" href="/${file}">\n</head>`);
  return html.replace('私人 NovelAI 双语 Tag 编辑、后台队列与云端图库', 'NovelAI 双语 Tag 编辑、本机队列与离线图库');
}
