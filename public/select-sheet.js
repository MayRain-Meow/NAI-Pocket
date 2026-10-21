// Single-choice <select> elements open this picker instead of the system dropdown, which
// ignores the app's look (a plain white list on Windows, an OS dialog in some WebViews).
// The <select> stays the source of truth: choosing sets its value and fires the same
// input/change events, so every existing listener and test keeps working. Phones get a
// bottom sheet, wider screens a popover under the field. A <select data-native-select>
// keeps the system dropdown.

export function installSelectSheets({ doc = document, isEnabled = () => true } = {}) {
  let sheet = null, list = null, title = null, active = null, fromKeyboard = false;

  const eligible = node => node instanceof HTMLSelectElement && !node.multiple && node.size <= 1 && !node.disabled
    && !node.hasAttribute('data-native-select') && isEnabled(node);

  function labelFor(select) {
    const aria = select.getAttribute('aria-label');
    if (aria) return aria;
    const label = select.closest('label') || (select.id && doc.querySelector(`label[for="${CSS.escape(select.id)}"]`));
    if (!label) return '';
    const own = [...label.childNodes].filter(node => node.nodeType === Node.TEXT_NODE).map(node => node.textContent.trim()).join(' ').trim();
    return own || label.querySelector('span, small')?.textContent.trim() || '';
  }

  function build() {
    sheet = doc.createElement('dialog');
    sheet.className = 'select-sheet';
    title = doc.createElement('div');
    title.className = 'select-sheet-title';
    list = doc.createElement('div');
    list.className = 'select-sheet-list';
    list.setAttribute('role', 'listbox');
    sheet.append(title, list);
    // A tap on the backdrop lands on the dialog itself, outside its content box.
    sheet.addEventListener('click', event => {
      if (event.target !== sheet) return;
      const box = sheet.getBoundingClientRect();
      if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) sheet.close();
    });
    sheet.addEventListener('close', () => {
      const select = active;
      active = null;
      // Focus returns to the field only for keyboard users; after a tap it would just show a focus ring.
      if (fromKeyboard) select?.focus({ preventScroll: true });
    });
    doc.body.append(sheet);
  }

  function optionButton(option, select) {
    const item = doc.createElement('button');
    item.type = 'button';
    item.className = 'select-sheet-option';
    item.setAttribute('role', 'option');
    item.textContent = option.textContent;
    item.disabled = option.disabled;
    const selected = option.selected;
    item.setAttribute('aria-selected', String(selected));
    // By option, not value: two options may share a value (V5 Full and V5 Full · Medium, 1.9.1).
    item.addEventListener('click', () => choose(option));
    return item;
  }

  function place(select) {
    sheet.classList.remove('is-popover');
    if (matchMedia('(max-width: 640px)').matches) {
      sheet.style.removeProperty('top'); sheet.style.removeProperty('left'); sheet.style.removeProperty('width');
      return;
    }
    sheet.classList.add('is-popover');
    const box = select.getBoundingClientRect();
    const width = Math.min(Math.max(box.width, 220), innerWidth - 24);
    const left = Math.min(Math.max(12, box.left), innerWidth - width - 12);
    const height = Math.min(sheet.scrollHeight || 320, innerHeight * 0.6);
    const below = innerHeight - box.bottom - 12;
    const top = below >= height || box.top < height ? Math.min(box.bottom + 6, innerHeight - height - 12) : box.top - height - 6;
    sheet.style.left = `${Math.round(left)}px`;
    sheet.style.top = `${Math.round(Math.max(12, top))}px`;
    sheet.style.width = `${Math.round(width)}px`;
  }

  function open(select, keyboard = false) {
    fromKeyboard = keyboard;
    if (!sheet) build();
    if (sheet.open) sheet.close();
    active = select;
    title.textContent = labelFor(select);
    title.hidden = !title.textContent;
    list.replaceChildren();
    for (const child of select.children) {
      if (child instanceof HTMLOptGroupElement) {
        if (child.hidden || !child.children.length) continue;
        const group = doc.createElement('div');
        group.className = 'select-sheet-group';
        group.textContent = child.label;
        list.append(group);
        for (const option of child.children) if (!option.hidden) list.append(optionButton(option, select));
      } else if (child instanceof HTMLOptionElement && !child.hidden) {
        list.append(optionButton(child, select));
      }
    }
    sheet.showModal();
    place(select);
    const current = list.querySelector('[aria-selected="true"]') || list.querySelector('.select-sheet-option:not(:disabled)');
    current?.scrollIntoView({ block: 'nearest' });
    current?.focus({ preventScroll: true });
  }

  function choose(option) {
    const select = active;
    if (select && !option.selected) {
      option.selected = true;
      select.dispatchEvent(new Event('input', { bubbles: true }));
      select.dispatchEvent(new Event('change', { bubbles: true }));
    }
    sheet.close();
  }

  // Mouse: the system dropdown opens on mousedown. Touch: it opens from the tap, so the
  // touchend is cancelled (no click, no system picker) and the sheet opens instead.
  doc.addEventListener('mousedown', event => {
    const select = event.target instanceof Element ? event.target.closest('select') : null;
    if (!eligible(select) || event.button !== 0) return;
    event.preventDefault();
    open(select);
  }, true);
  // A finger that scrolls the page also ends on the field; only a tap (little movement) opens it.
  let touchStart = null;
  doc.addEventListener('touchstart', event => {
    const touch = event.touches[0];
    touchStart = touch ? { x: touch.clientX, y: touch.clientY } : null;
  }, { capture: true, passive: true });
  doc.addEventListener('touchend', event => {
    const select = event.target instanceof Element ? event.target.closest('select') : null;
    if (!eligible(select)) return;
    const touch = event.changedTouches[0];
    const moved = touchStart && touch ? Math.hypot(touch.clientX - touchStart.x, touch.clientY - touchStart.y) : 0;
    event.preventDefault();
    if (moved > 10) return;
    open(select);
  }, { capture: true, passive: false });
  doc.addEventListener('keydown', event => {
    const select = event.target;
    if (!eligible(select)) return;
    if (event.key === ' ' || event.key === 'Enter' || event.key === 'F4' || (event.altKey && event.key === 'ArrowDown')) {
      event.preventDefault();
      open(select, true);
    }
  }, true);
  return { open, close: () => sheet?.open && sheet.close() };
}
