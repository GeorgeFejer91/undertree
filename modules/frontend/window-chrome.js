import { isTauri } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';

export function createWindowCloseGuard(appWindow, { beforeClose, canClose, onError, onClosing }) {
  let unlisten;
  let closing = false;
  const listenForClose = async () => {
    unlisten = await appWindow.onCloseRequested(event => {
      // The native close request stays blocked until every local buffer is safe.
      event.preventDefault();
      return closeSafely();
    });
  };
  const closeSafely = async (withoutSaveCheck = null) => {
    if (closing) {
      if (withoutSaveCheck) throw { code: 'busy', message: 'A local window close is already pending.' };
      return;
    }
    closing = true;
    let closed = false;
    try {
      onClosing(true);
      if (withoutSaveCheck) withoutSaveCheck();
      else await beforeClose();
      // The pinned API's unlisten returns a promise. Remove the guard before
      // normal close, avoiding the force-destroy permission used by its default.
      const removeListener = unlisten;
      unlisten = null;
      await removeListener?.();
      if (!canClose()) throw new Error('Your manuscript changed while closing. Save or resolve it before closing the window.');
      if (withoutSaveCheck) withoutSaveCheck();
      await appWindow.close();
      closed = true;
    } catch (failure) {
      if (!unlisten) {
        try { await listenForClose(); }
        catch (restoreError) { failure = new Error(`${failure?.message || failure} Window protection could not be restored: ${restoreError?.message || restoreError}`); }
      }
      onError(failure);
      if (withoutSaveCheck) throw failure;
    } finally {
      closing = false;
      if (!closed && unlisten) onClosing(false);
    }
  };
  return {
    listen: listenForClose, close: () => closeSafely(),
    closeWithoutSave: check => {
      if (typeof check !== 'function') return Promise.reject(new Error('A current no-save close check is required.'));
      return closeSafely(check);
    },
  };
}

export async function setupWindowChrome({ beforeClose, canClose, status, onClosing }) {
  if (!isTauri()) return;
  const appWindow = getCurrentWindow();
  const titlebar = document.getElementById('window-titlebar');
  const drag = document.getElementById('window-drag');
  const close = document.getElementById('window-close');
  const maximize = document.getElementById('window-maximize');
  const error = document.getElementById('window-error');
  let lastPress = null;
  const report = failure => {
    error.textContent = failure?.message || String(failure);
    error.hidden = false;
    status(error.textContent, true);
  };
  const run = async action => { try { await action(); } catch (failure) { report(failure); } };
  const syncMaximize = async () => {
    const maximized = await appWindow.isMaximized();
    const label = maximized ? 'Restore window' : 'Maximize window';
    maximize.setAttribute('aria-label', label);
    maximize.title = label;
    maximize.querySelector('path').setAttribute('d', maximized ? 'M8 8V4h12v12h-4M4 8h12v12H4Z' : 'M5 5h14v14H5Z');
  };
  const toggleMaximize = async () => { await appWindow.toggleMaximize(); await syncMaximize(); };
  const guard = createWindowCloseGuard(appWindow, {
    beforeClose, canClose, onError: report,
    onClosing: busy => { close.disabled = busy; if (busy) error.hidden = true; onClosing(busy); },
  });
  await run(guard.listen);
  await run(syncMaximize);
  document.getElementById('review-app').classList.add('native-window');
  titlebar.hidden = false;
  close.addEventListener('click', guard.close);
  document.getElementById('window-minimize').addEventListener('click', () => run(() => appWindow.minimize()));
  maximize.addEventListener('click', () => run(toggleMaximize));
  window.addEventListener('resize', () => { void run(syncMaximize); });
  drag.addEventListener('mousedown', event => {
    if (event.button !== 0) return;
    // GTK's native move can consume click counting; recognize the second press
    // at the same screen point without confusing the end of a drag with a click.
    const twice = event.detail === 2 || (lastPress && event.timeStamp - lastPress.time < 400 && Math.hypot(event.screenX - lastPress.x, event.screenY - lastPress.y) < 5);
    lastPress = twice ? null : { time: event.timeStamp, x: event.screenX, y: event.screenY };
    void run(() => twice ? toggleMaximize() : appWindow.startDragging());
  });
  drag.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      void run(toggleMaximize);
    }
  });
  return { window: appWindow, closeWithoutSave: guard.closeWithoutSave };
}
