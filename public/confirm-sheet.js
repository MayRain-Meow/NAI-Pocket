// Confirmations and short text prompts in the app's own look, instead of window.confirm /
// window.prompt (a plain system box, and an Android dialog inside the app). Both return a
// Promise: confirmAction → true/false, promptText → the entered text or null. A bottom sheet
// on phones, a centred card elsewhere; Esc, the backdrop and Android back all cancel.

function sheet(doc, build) {
  return new Promise(resolve => {
    const dialog = doc.createElement('dialog');
    dialog.className = 'confirm-sheet';
    let result;
    const finish = value => { result = value; dialog.close(); };
    const { body, accept, cancel, focus, valueOf } = build(doc, finish);
    dialog.append(body);
    dialog.addEventListener('click', event => {
      if (event.target !== dialog) return;
      const box = dialog.getBoundingClientRect();
      if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) dialog.close();
    });
    dialog.addEventListener('close', () => { dialog.remove(); resolve(result === undefined ? cancel : result); });
    accept.addEventListener('click', () => finish(valueOf()));
    doc.body.append(dialog);
    dialog.showModal();
    (focus || accept).focus();
  });
}

function actionsRow(doc, { confirmLabel, cancelLabel, danger }, finish, cancelValue) {
  const row = doc.createElement('div');
  row.className = 'confirm-sheet-actions';
  const cancel = doc.createElement('button');
  cancel.type = 'button';
  cancel.className = 'confirm-sheet-cancel';
  cancel.dataset.confirmCancel = '';
  cancel.textContent = cancelLabel;
  cancel.addEventListener('click', () => finish(cancelValue));
  const accept = doc.createElement('button');
  accept.type = 'button';
  accept.className = danger ? 'confirm-sheet-accept is-danger' : 'confirm-sheet-accept';
  accept.dataset.confirmAccept = '';
  accept.textContent = confirmLabel;
  row.append(cancel, accept);
  return { row, accept };
}

export function confirmAction(message, { title = '', confirmLabel = '确定', cancelLabel = '取消', danger = false, doc = document } = {}) {
  return sheet(doc, (d, finish) => {
    const body = d.createElement('div');
    body.className = 'confirm-sheet-body';
    if (title) body.append(Object.assign(d.createElement('strong'), { className: 'confirm-sheet-title', textContent: title }));
    body.append(Object.assign(d.createElement('p'), { className: 'confirm-sheet-message', textContent: message }));
    const { row, accept } = actionsRow(d, { confirmLabel, cancelLabel, danger }, finish, false);
    body.append(row);
    return { body, accept, cancel: false, valueOf: () => true };
  });
}

export function promptText(message, value = '', { confirmLabel = '确定', cancelLabel = '取消', maxLength = 120, doc = document } = {}) {
  return sheet(doc, (d, finish) => {
    const body = d.createElement('form');
    body.className = 'confirm-sheet-body';
    body.method = 'dialog';
    body.append(Object.assign(d.createElement('strong'), { className: 'confirm-sheet-title', textContent: message }));
    const input = Object.assign(d.createElement('input'), { className: 'confirm-sheet-input', type: 'text', value: String(value || ''), maxLength });
    input.id = 'confirmSheetInput';
    body.append(input);
    const { row, accept } = actionsRow(d, { confirmLabel, cancelLabel, danger: false }, finish, null);
    body.append(row);
    body.addEventListener('submit', event => { event.preventDefault(); finish(input.value); });
    queueMicrotask(() => input.select());
    return { body, accept, cancel: null, focus: input, valueOf: () => input.value };
  });
}
