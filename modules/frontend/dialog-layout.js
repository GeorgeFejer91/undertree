const bespokeDialogs = '#context-share-dialog, .text-details-dialog';
const structuralGroups = 'div, section, form, ul, ol';
const atomicGroups = '.text-details-slot, .palette-row, dl > div, .color-rule-identity, .color-rule-options, .connection-overview-status';

function measureLabels(dialog) {
  for (const item of dialog.querySelectorAll('li')) if (!item.children.length && item.textContent.trim()) {
    const span = document.createElement('span'); span.textContent = item.textContent; item.replaceChildren(span);
  }
  for (const label of dialog.querySelectorAll('label')) {
    for (const node of [...label.childNodes]) if (node.nodeType === Node.TEXT_NODE && node.textContent.trim()) {
      const span = document.createElement('span');
      span.textContent = node.textContent; span.dataset.measure = ''; node.replaceWith(span);
    }
  }
  for (const element of dialog.querySelectorAll('legend, dt, dd, blockquote, pre, p, li > span:not(.text-details-slot), .pdf-export-project > span:not(.text-details-slot)')) {
    if (!element.hasAttribute('data-measure')) element.dataset.measure = '';
    if (element.matches('blockquote, pre, p, li > span:not(.text-details-slot), .pdf-export-project > span:not(.text-details-slot)') && !element.hasAttribute('data-text-details')) {
      element.id ||= `${dialog.id || 'popup'}-text-${++measureLabels.sequence}`;
      const context = element.getAttribute('aria-label') || dialog.querySelector('h2')?.textContent || 'Dialog';
      element.dataset.textDetails = element.matches('[role="alert"]') ? 'Error details' : `${context} details`;
      if (element.matches('.pdf-export-project > span')) {
        for (const value of element.children) value.dataset.textValue = '';
        element.parentElement.querySelector('input')?.setAttribute('aria-label', [...element.children].map(value => value.textContent).join(' · '));
      }
    }
  }
}
measureLabels.sequence = 0;

function flowGroups(parent, availableHeight) {
  const groups = [];
  for (const child of parent.children) {
    if (child.hidden || getComputedStyle(child).display === 'none') continue;
    const style = getComputedStyle(child);
    const outerHeight = child.getBoundingClientRect().height + (parseFloat(style.marginTop) || 0) + (parseFloat(style.marginBottom) || 0);
    const splitOversize = child.children.length && child.matches('fieldset, details[open], dl, dl > div, li, .palette-row, .color-rule-options') && outerHeight > availableHeight;
    if ((child.matches(structuralGroups) && !child.matches(atomicGroups)) || splitOversize) {
      child.classList.add('popup-flow');
      groups.push(...flowGroups(child, availableHeight));
    } else groups.push(child);
  }
  return groups;
}

function enhanceDialog(dialog) {
  const form = dialog.querySelector(':scope > form');
  const shell = form || dialog;
  const heading = shell.querySelector(':scope > h2, :scope > .connection-heading');
  const actions = shell.querySelector(':scope > .dialog-actions');
  if (!heading || !actions) return () => {};
  dialog.classList.add('stretch-popup'); shell.classList.add('popup-shell');
  const header = document.createElement('div'); header.className = 'popup-heading';
  heading.before(header); header.append(heading);
  const tabs = shell.querySelector(':scope > .connection-tabs');
  if (tabs) header.append(tabs);
  const body = document.createElement('div'); body.className = 'dialog-body popup-body';
  for (const child of [...shell.childNodes]) if (child !== header && child !== actions) body.append(child);
  header.after(body);
  const alerts = document.createElement('div'); alerts.className = 'popup-alerts';
  body.after(alerts);
  for (const alert of body.querySelectorAll('[role="alert"]')) if (alert.parentElement === body || alert.id === 'color-rule-error') alerts.append(alert);
  const pager = document.createElement('nav'); pager.className = 'popup-pager'; pager.setAttribute('aria-label', 'Dialog pages');
  const previous = document.createElement('button'); previous.type = 'button'; previous.textContent = '‹'; previous.setAttribute('aria-label', 'Previous page'); previous.title = 'Previous page';
  const status = document.createElement('span'); status.setAttribute('role', 'status'); status.dataset.measure = '';
  const next = document.createElement('button'); next.type = 'button'; next.textContent = '›'; next.setAttribute('aria-label', 'Next page'); next.title = 'Next page';
  pager.append(previous, status, next); actions.before(pager);
  measureLabels(dialog);
  let frame = 0, page = 0, pages = [], groups = [], disposed = false;

  function showPage(index, focus = false) {
    page = Math.max(0, Math.min(index, pages.length - 1));
    const visible = new Set(pages[page] || []);
    for (const group of groups) group.classList.toggle('popup-page-hidden', !visible.has(group));
    previous.disabled = page === 0; next.disabled = page >= pages.length - 1;
    status.textContent = `${page + 1} / ${Math.max(1, pages.length)}`;
    dialog.dataset.popupPage = String(page + 1); dialog.dataset.popupPages = String(Math.max(1, pages.length));
    const fits = body.scrollHeight <= body.clientHeight + 2 && body.scrollWidth <= body.clientWidth + 2;
    dialog.dataset.popupFit = fits ? 'fit' : 'no-fit';
    if (focus) {
      const target = [...visible].flatMap(group => [group, ...group.querySelectorAll('input, select, textarea, button, summary, [tabindex]')])
        .find(element => element.matches('input, select, textarea, button, summary, [tabindex]') && !element.disabled && element.getClientRects().length);
      if (target) target.focus({ preventScroll: true });
      else { body.tabIndex = -1; body.focus({ preventScroll: true }); }
    }
    dialog.dispatchEvent(new CustomEvent('popuplayout'));
  }

  function layout() {
    frame = 0;
    if (disposed || !dialog.open) return;
    const focused = document.activeElement;
    const previousGroup = groups.find(group => group === focused || group.contains(focused));
    const hasAlert = [...alerts.querySelectorAll('[role="alert"]')].some(alert => !alert.hidden && alert.textContent.trim());
    if (alerts.hidden === hasAlert) alerts.hidden = !hasAlert;
    for (const group of body.querySelectorAll('.popup-page-hidden')) group.classList.remove('popup-page-hidden');
    for (const group of body.querySelectorAll('fieldset.popup-flow, details.popup-flow, dl.popup-flow, dl > div.popup-flow, li.popup-flow, .palette-row.popup-flow, .color-rule-options.popup-flow')) group.classList.remove('popup-flow');
    measureLabels(dialog);
    pager.hidden = false;
    const gap = parseFloat(getComputedStyle(body).rowGap) || 0;
    const bodyStyle = getComputedStyle(body);
    const available = body.clientHeight - parseFloat(bodyStyle.paddingTop) - parseFloat(bodyStyle.paddingBottom) - 1;
    const textareaHeight = `${Math.max(0, available)}px`;
    if (body.style.getPropertyValue('--popup-body-height') !== textareaHeight) body.style.setProperty('--popup-body-height', textareaHeight);
    groups = flowGroups(body, available);
    pages = [[]]; let used = 0;
    for (const group of groups) {
      const style = getComputedStyle(group);
      const height = group.getBoundingClientRect().height + (parseFloat(style.marginTop) || 0) + (parseFloat(style.marginBottom) || 0);
      if (used && used + gap + height > available + 1) { pages.push([]); used = 0; }
      pages.at(-1).push(group); used += height + (used ? gap : 0);
    }
    const focusedPage = previousGroup ? pages.findIndex(items => items.some(group => group === previousGroup || group.contains(focused))) : -1;
    if (focusedPage >= 0) page = focusedPage;
    pager.hidden = pages.length <= 1;
    showPage(page);
  }
  const schedule = () => { if (!frame && !disposed) frame = requestAnimationFrame(layout); };
  previous.onclick = () => showPage(page - 1, true);
  next.onclick = () => showPage(page + 1, true);
  const invalid = event => {
    const index = pages.findIndex(items => items.some(group => group === event.target || group.contains(event.target)));
    if (index >= 0) showPage(index);
  };
  const close = () => { showPage(0); };
  const resize = new ResizeObserver(schedule); resize.observe(dialog); resize.observe(body);
  const mutation = new MutationObserver(records => {
    if (records.some(record => {
      if (pager.contains(record.target) || record.target === pager) return false;
      if (record.attributeName !== 'class') return true;
      const authoredClasses = value => (value || '').split(/\s+/).filter(name => !['popup-page-hidden', 'popup-flow'].includes(name)).join(' ');
      return authoredClasses(record.oldValue) !== authoredClasses(record.target.getAttribute('class'));
    })) schedule();
  });
  mutation.observe(dialog, { subtree: true, childList: true, characterData: true, attributes: true, attributeOldValue: true, attributeFilter: ['open', 'hidden', 'style', 'class'] });
  const typography = new MutationObserver(schedule);
  typography.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class', 'lang'] });
  typography.observe(document.head, { subtree: true, childList: true, characterData: true, attributes: true });
  dialog.addEventListener('invalid', invalid, true); dialog.addEventListener('close', close); dialog.addEventListener('toggle', schedule, true);
  document.fonts?.ready.then(schedule); document.fonts?.addEventListener('loadingdone', schedule);
  schedule();
  return () => {
    disposed = true; cancelAnimationFrame(frame); resize.disconnect(); mutation.disconnect(); typography.disconnect();
    dialog.removeEventListener('invalid', invalid, true); dialog.removeEventListener('close', close); dialog.removeEventListener('toggle', schedule, true);
    document.fonts?.removeEventListener('loadingdone', schedule);
  };
}

export function setupDialogLayout(root = document) {
  const cleanups = new Map();
  const register = dialog => {
    if (!dialog.matches(bespokeDialogs) && !cleanups.has(dialog)) cleanups.set(dialog, enhanceDialog(dialog));
  };
  for (const dialog of root.querySelectorAll('dialog')) register(dialog);
  const observer = new MutationObserver(records => {
    for (const record of records) for (const node of record.addedNodes) if (node instanceof Element) {
      if (node.matches('dialog')) register(node);
      for (const dialog of node.querySelectorAll('dialog')) register(dialog);
    }
    for (const [dialog, cleanup] of cleanups) if (!dialog.isConnected) { cleanup(); cleanups.delete(dialog); }
  });
  observer.observe(root, { childList: true, subtree: true });
  return () => { observer.disconnect(); for (const cleanup of cleanups.values()) cleanup(); cleanups.clear(); };
}
