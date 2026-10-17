import { observeReviewText } from '../modules/frontend/review-text-layout.js';

export function createLegacyDialog(dialog) {
  observeReviewText(dialog);
  const form = dialog.querySelector('form');
  const message = dialog.querySelector('[data-dialog-message]');
  const field = dialog.querySelector('input');
  const label = dialog.querySelector('label');
  const accept = dialog.querySelector('[data-dialog-accept]');
  const cancel = dialog.querySelector('[data-dialog-cancel]');
  let finish;
  form.addEventListener('submit', event => {
    event.preventDefault();
    dialog.close('accept');
  });
  cancel.addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => {
    const resolve = finish;
    finish = null;
    resolve?.(dialog.returnValue === 'accept' ? (field.hidden ? true : field.value) : null);
  });
  return (text, { value, action = 'OK' } = {}) => {
    if (finish) return Promise.resolve(null);
    const prompting = value !== undefined;
    message.textContent = text;
    message.hidden = prompting;
    label.textContent = prompting ? text : '';
    label.hidden = field.hidden = !prompting;
    field.value = value ?? '';
    accept.textContent = action;
    dialog.returnValue = '';
    return new Promise(resolve => {
      finish = resolve;
      try { dialog.showModal(); }
      catch (error) { finish = null; throw error; }
      (prompting ? field : cancel).focus();
      if (prompting) field.select();
    });
  };
}
