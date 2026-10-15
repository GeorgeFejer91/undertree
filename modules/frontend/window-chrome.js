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
  const error = document.getElementById('window-error');
  let lastPress = null;
  const report = failure => {
    error.textContent = failure?.message || String(failure);
    error.hidden = false;
    status(error.textContent, true);
  };
  const run = async action => { try { await action(); } catch (failure) { report(failure); } };
  const guard = createWindowCloseGuard(appWindow, {
    beforeClose, canClose, onError: report,
    onClosing: busy => { close.disabled = busy; if (busy) error.hidden = true; onClosing(busy); },
  });
  await run(guard.listen);
  document.getElementById('review-app').classList.add('native-window');
  titlebar.hidden = false;
  close.addEventListener('click', guard.close);
  document.getElementById('window-minimize').addEventListener('click', () => run(() => appWindow.minimize()));
  drag.addEventListener('mousedown', event => {
    if (event.button !== 0) return;
    // GTK's native move can consume click counting; recognize the second press
    // at the same screen point without confusing the end of a drag with a click.
    const twice = event.detail === 2 || (lastPress && event.timeStamp - lastPress.time < 400 && Math.hypot(event.screenX - lastPress.x, event.screenY - lastPress.y) < 5);
    lastPress = twice ? null : { time: event.timeStamp, x: event.screenX, y: event.screenY };
    void run(() => twice ? appWindow.toggleMaximize() : appWindow.startDragging());
  });
  drag.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      void run(() => appWindow.toggleMaximize());
    }
  });
  return { window: appWindow, closeWithoutSave: guard.closeWithoutSave };
}
