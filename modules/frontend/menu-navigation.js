export function setupMenuNavigation(menus, { isComposing = () => false, isClosing = () => false } = {}) {
  const document = menus[0].ownerDocument;
  const summary = menu => menu.querySelector('summary');
  const panel = menu => menu.querySelector('.workspace-menu-panel');
  const editable = target => target.closest('input,select,textarea,[contenteditable]:not([contenteditable="false"])');
  const visible = element => !element.closest('[hidden],[inert]') && element.getClientRects().length > 0
    && document.defaultView.getComputedStyle(element).visibility === 'visible';
  const items = menu => [...panel(menu).querySelectorAll('button')].filter(item => !item.matches(':disabled,[aria-disabled="true"]') && visible(item));
  const setOpen = (menu, open) => { menu.open = open; summary(menu).setAttribute('aria-expanded', String(open)); };
  const close = (restoreFocus = false) => {
    if (restoreFocus && (isComposing() || isClosing() || editable(document.activeElement))) return;
    const current = menus.find(menu => menu.open && menu.contains(document.activeElement));
    for (const menu of menus) setOpen(menu, false);
    if (restoreFocus) current && summary(current).focus();
  };
  const open = menu => { for (const other of menus) setOpen(other, other === menu); };
  const desktop = menu => menu.classList.contains('editor-menu') && visible(summary(menu));

  for (const menu of menus) {
    const trigger = summary(menu), popup = panel(menu);
    trigger.id ||= `${menu.id}-toggle`; popup.id ||= `${menu.id}-panel`;
    trigger.setAttribute('aria-controls', popup.id);
    popup.setAttribute('aria-labelledby', trigger.id);
    // Highlight's native combobox remains a disclosure group, with its own keyboard behavior.
    if (popup.querySelector('input,select,textarea,[contenteditable]')) {
      popup.setAttribute('role', 'group'); trigger.removeAttribute('aria-haspopup');
    } else {
      popup.setAttribute('role', 'menu'); trigger.setAttribute('aria-haspopup', 'menu');
      for (const item of popup.querySelectorAll('button')) item.setAttribute('role', 'menuitem');
    }
    trigger.setAttribute('aria-expanded', String(menu.open));
    menu.addEventListener('toggle', () => {
      if (menu.open) for (const other of menus) if (other !== menu) setOpen(other, false);
      trigger.setAttribute('aria-expanded', String(menu.open));
    });
    menu.addEventListener('keydown', event => {
      if (event.defaultPrevented || event.isComposing || event.keyCode === 229 || isComposing() || isClosing()
        || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || editable(event.target)) return;
      const onTrigger = trigger.contains(event.target);
      if (!visible(trigger) || (!onTrigger && (!menu.open || !popup.contains(event.target)))) return;
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault(); open(menu);
        const enabled = items(menu), current = enabled.indexOf(document.activeElement), down = event.key === 'ArrowDown';
        enabled[onTrigger || current < 0 ? (down ? 0 : enabled.length - 1) : Math.max(0, Math.min(current + (down ? 1 : -1), enabled.length - 1))]?.focus();
      } else if ((event.key === 'Home' || event.key === 'End') && menu.open && !onTrigger) {
        event.preventDefault(); const enabled = items(menu); enabled[event.key === 'Home' ? 0 : enabled.length - 1]?.focus();
      } else if (event.key === 'Escape' && menu.open) {
        event.preventDefault(); close(true);
      } else if (onTrigger && (event.key === 'Enter' || event.key === ' ')) {
        event.preventDefault();
        if (menu.open) setOpen(menu, false);
        else { open(menu); items(menu)[0]?.focus(); }
      } else if ((event.key === 'ArrowLeft' || event.key === 'ArrowRight') && desktop(menu)) {
        event.preventDefault();
        const siblings = menus.filter(desktop), next = siblings[(siblings.indexOf(menu) + (event.key === 'ArrowRight' ? 1 : siblings.length - 1)) % siblings.length];
        const wasOpen = menu.open; close(); summary(next).focus();
        if (wasOpen) { open(next); if (!onTrigger) items(next)[0]?.focus(); }
      }
    });
    trigger.addEventListener('pointerenter', event => {
      if (event.pointerType === 'touch' || isComposing() || isClosing() || !desktop(menu)) return;
      const previous = menus.find(other => other !== menu && other.open && desktop(other));
      if (!previous) return;
      const hadFocus = previous.contains(document.activeElement); open(menu);
      if (hadFocus) trigger.focus();
    });
  }
  document.addEventListener('pointerdown', event => {
    for (const menu of menus) if (!menu.contains(event.target)) setOpen(menu, false);
  });
  return { close };
}
