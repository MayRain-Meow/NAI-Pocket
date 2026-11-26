import { installEndfieldMotion } from './motion.js';

export function installEndfieldUi({ systemBars, appearance } = {}) {
  const root = document.documentElement;
  const media = matchMedia('(prefers-color-scheme: dark)');
  const section = document.createElement('section');
  section.className = 'settings-dialog-section';
  section.innerHTML = '<div class="settings-section-heading"><span class="workspace-eyebrow">// APPEARANCE</span><h2>显示</h2></div><label>颜色主题<select id="appearanceTheme"><option value="system">跟随系统</option><option value="light">浅色</option><option value="dark">深色</option></select></label><p class="hint">Endfield 独立版 / 原项目：MayRain-Meow 的 NAI Pocket。与作者原版分别保存数据。</p>';
  document.querySelector('.settings-dialog-body')?.prepend(section);
  // Keep batch saving discoverable without requiring the overflow menu.
  const batchSelect = document.getElementById('gallerySelectToggle');
  if (batchSelect) document.querySelector('.gallery-title-actions')?.prepend(batchSelect);
  const select = section.querySelector('select');
  try { select.value = localStorage.getItem('nai-pocket-theme') || 'system'; } catch {}
  function applyTheme() {
    const dark = select.value === 'dark' || select.value === 'system' && media.matches;
    root.dataset.theme = dark ? 'dark' : 'light';
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#191919' : '#F4F4F2');
    appearance?.({ dark }).catch(() => {});
    systemBars?.setStyle({ style: dark ? 'DARK' : 'LIGHT' }).catch(() => {});
  }
  select.addEventListener('change', () => {
    try { localStorage.setItem('nai-pocket-theme', select.value); } catch {}
    applyTheme();
  });
  media.addEventListener('change', applyTheme); applyTheme();
  const labels = { editor: 'EDIT', artists: 'ARTISTS', gallery: 'GALLERY', queue: 'QUEUE', reverse: 'REVERSE', codex: 'CODEX', storm: 'STORM', scheme: 'SCHEMES' };
  const nav = document.querySelector('.workspace-nav-list');
  // Keep DOM/keyboard order consistent with the more frequently used Codex.
  nav.insertBefore(nav.querySelector('[data-tab="codex"]'), nav.querySelector('[data-tab="artists"]'));
  const originals = [...nav.querySelectorAll('[data-tab]')];
  const primary = new Set(['editor', 'codex', 'gallery', 'queue']);
  for (const button of originals) {
    button.dataset.efNav = primary.has(button.dataset.tab) ? 'primary' : 'secondary';
    const label = document.createElement('small'); label.className = 'ef-nav-label'; label.textContent = labels[button.dataset.tab];
    button.prepend(label);
  }
  const more = document.createElement('button');
  more.id = 'mobileMoreButton'; more.type = 'button'; more.className = 'tab ef-more-button';
  more.innerHTML = '<small class="ef-nav-label">MORE</small><span>更多</span>';
  more.setAttribute('aria-haspopup', 'dialog'); more.setAttribute('aria-expanded', 'false');
  nav.append(more);
  const dialog = document.createElement('dialog'); dialog.id = 'mobileMoreDialog'; dialog.className = 'ef-more-dialog';
  dialog.setAttribute('aria-labelledby', 'mobileMoreTitle');
  dialog.innerHTML = '<div class="dialog-header"><div><small class="workspace-eyebrow">// MORE</small><h2 id="mobileMoreTitle">更多功能</h2></div><button type="button" aria-label="关闭更多功能">×</button></div><div class="ef-more-grid"></div>';
  dialog.querySelector('button').onclick = () => dialog.close();
  const grid = dialog.querySelector('.ef-more-grid');
  const proxies = new Map();
  for (const original of originals.filter(b => !primary.has(b.dataset.tab))) {
    const button = document.createElement('button'); button.type = 'button';
    button.innerHTML = `<small>${labels[original.dataset.tab]}</small><strong>${original.querySelector('span')?.textContent || original.dataset.tab}</strong>`;
    button.onclick = () => { dialog.close(); original.click(); };
    proxies.set(original, button); grid.append(button);
  }
  const settings = document.createElement('button'); settings.type = 'button';
  settings.innerHTML = '<small>SETTINGS</small><strong>设置</strong>';
  settings.onclick = () => { dialog.close(); document.getElementById('openSettingsButton')?.click(); }; grid.append(settings);
  document.body.append(dialog);
  more.onclick = () => { dialog.showModal(); more.setAttribute('aria-expanded', 'true'); };
  dialog.addEventListener('close', () => more.setAttribute('aria-expanded', 'false'));
  function syncNavigation() {
    let secondaryActive = false;
    for (const button of originals) {
      const active = button.classList.contains('active');
      if (active) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
      const proxy = proxies.get(button);
      if (proxy) {
        // Preserve feature eligibility from the existing app, even while the
        // bottom navigation itself deliberately hides secondary entries.
        proxy.hidden = button.hidden || button.classList.contains('hidden') || button.style.display === 'none';
        proxy.classList.toggle('active', active);
        if (active) secondaryActive = true;
      }
    }
    more.classList.toggle('active', secondaryActive);
    if (secondaryActive) more.setAttribute('aria-current', 'page'); else more.removeAttribute('aria-current');
  }
  const observer = new MutationObserver(syncNavigation);
  originals.forEach(b => observer.observe(b, { attributes: true, attributeFilter: ['class', 'hidden', 'style'] }));
  syncNavigation();
  const dock = document.querySelector('.floating-generate-bar');
  const stormDock = document.querySelector('.storm-actions');
  function measure() {
    const mobile = matchMedia('(max-width: 720px)').matches;
    const navHeight = mobile ? Math.ceil(nav.parentElement.getBoundingClientRect().height) : 0;
    const dockHeight = Math.max(...[dock, stormDock].map(el => el && getComputedStyle(el).display !== 'none' ? Math.ceil(el.getBoundingClientRect().height) : 0));
    root.style.setProperty('--ef-nav-height', `${navHeight}px`);
    root.style.setProperty('--ef-dock-height', `${dockHeight}px`);
  }
  const resize = new ResizeObserver(measure); resize.observe(nav.parentElement); if (dock) resize.observe(dock); if (stormDock) resize.observe(stormDock);
  window.addEventListener('resize', measure); window.visualViewport?.addEventListener('resize', measure); measure();
  document.querySelector('#nativeAlpha')?.closest('label')?.setAttribute('title', '原生透明仅支持 V5；选择 V5 后可开启。');
  document.title = 'NAI Pocket Endfield';
  const brand = document.querySelector('.workspace-brand-copy small'); if (brand) brand.textContent = 'ENDFIELD';
  const crumb = document.querySelector('.workspace-crumb > span'); if (crumb) crumb.textContent = '// NAI POCKET';
  installEndfieldMotion();
}
