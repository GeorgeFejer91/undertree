// Keep unbounded status messages out of finite chrome without losing their full value.
export function createTextDetails(source) {
  const slot = document.createElement('span');
  slot.className = 'text-details-slot';
  source.before(slot);
  slot.append(source);
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'text-details-button';
  button.setAttribute('aria-haspopup', 'dialog');
  button.hidden = true;
  slot.append(button);
  const dialog = document.createElement('dialog');
  dialog.className = 'text-details-dialog';
  const heading = document.createElement('h2');
  const message = document.createElement('p');
  message.className = 'text-details-message';
  message.tabIndex = 0;
  const close = document.createElement('button');
  close.type = 'button';
  close.textContent = 'Close';
  heading.id = `${source.id}-details-title`;
  dialog.setAttribute('aria-labelledby', heading.id);
  dialog.append(heading, message, close);
  let destroying = false;
  button.onclick = () => { dialog.showModal(); message.focus({ preventScroll: true }); dialog.scrollTop = 0; };
  close.onclick = () => dialog.close();
  dialog.addEventListener('close', () => {
    if (destroying) return;
    if (button.isConnected && !button.hidden) button.focus();
    else if (source.isConnected) { source.tabIndex = -1; source.focus(); }
  });
  let active = false;
  const fullText = () => {
    const values = [...source.querySelectorAll('[data-text-value]')];
    return values.length ? values.map(value => value.textContent || '').join('\n') : source.textContent || '';
  };
  return {
    slot,
    get active() { return active; },
    get text() { return fullText(); },
    present(result) {
      const text = fullText();
      const title = source.dataset.textDetails;
      if (heading.textContent !== title) heading.textContent = title;
      if (message.textContent !== text) message.textContent = text;
      const hidden = source.hidden;
      if (slot.hidden !== hidden) slot.hidden = hidden;
      const next = !hidden && (result === 'no-fit' || (active && result === 'unavailable'));
      if (next && !dialog.isConnected) document.body.append(dialog);
      const error = source.classList.contains('error') || source.getAttribute('role') === 'alert' || Boolean(source.querySelector('.error'));
      const label = error ? 'Error details' : title;
      if (button.textContent !== label) button.textContent = label;
      const name = `${label}: ${text}`;
      if (button.getAttribute('aria-label') !== name) button.setAttribute('aria-label', name);
      slot.classList.toggle('error', error);
      if (active !== next) {
        const restoreFocus = document.hasFocus() && (next ? source.contains(document.activeElement) : document.activeElement === button);
        active = next;
        slot.classList.toggle('text-details-active', active);
        button.hidden = !active;
        if (restoreFocus) {
          if (!active) source.tabIndex = -1;
          (active ? button : source).focus();
        }
      }
      const role = active ? source.getAttribute('role') || source.querySelector('[role="status"], [role="alert"]')?.getAttribute('role') || null : null;
      if (slot.getAttribute('role') !== role) {
        if (role) slot.setAttribute('role', role);
        else slot.removeAttribute('role');
      }
      return active ? 'details' : result;
    },
    destroy() {
      destroying = true;
      if (dialog.open) dialog.close();
      dialog.remove();
      if (source.parentElement === slot) slot.replaceWith(source);
      else slot.replaceWith(...[...slot.childNodes].filter(node => node !== button));
    },
  };
}
