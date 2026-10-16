import { popupProperties, windowGeometry } from './native-move-select-guards.mjs';

// Passive metadata only. Existing popup acceptance, input and inspection bounds
// remain in native-move-select-contract.mjs and native-move-select-inspection.mjs.
export function observeNativeMoveWindows(ids, { phase, appPid, inspectNative, now = () => performance.now() }) {
  const report = { phase: ['before-first-popup', 'popup-failure'].includes(phase) ? phase : 'unavailable',
    inventoryCount: Array.isArray(ids) ? ids.length : null, rows: [], attemptedRows: 0, skippedIds: [], skippedCount: 0, unavailableRows: 0,
    complete: false, budgetMs: 8000, pairReserveMs: 4000, startedMs: null, finishedMs: null, elapsedMs: null, unavailable: null };
  try {
    const xid = value => typeof value === 'string' && /^0x[0-9a-f]{1,16}$/.test(value);
    if (report.phase === 'unavailable' || !Number.isSafeInteger(appPid) || appPid <= 0 ||
        !Array.isArray(ids) || ids.length > 128 || !ids.every(xid) || new Set(ids).size !== ids.length ||
        typeof inspectNative !== 'function' || typeof now !== 'function') {
      report.unavailable = 'invalid-input'; return report;
    }
    let last = null;
    const stamp = () => {
      const value = now();
      if (!Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER / 1000 ||
          (last !== null && value < last)) throw new Error('clock');
      last = value; return value;
    };
    const start = stamp(), deadline = start + 8000;
    report.startedMs = Math.round(start * 1000) / 1000;
    const relative = value => Math.round((value - start) * 1000) / 1000;
    const errorMeta = error => ({ code: ['ETIMEDOUT', 'ENOENT', 'EACCES', 'ESRCH'].includes(error?.code) ? error.code : 'unavailable',
      signal: ['SIGKILL', 'SIGTERM'].includes(error?.signal) ? error.signal : null,
      status: Number.isInteger(error?.status) && error.status >= 0 && error.status <= 255 ? error.status : null });
    for (let i = 0; i < ids.length; i++) {
      const admitted = stamp();
      if (deadline - admitted < 4000) { report.skippedIds = ids.slice(i); report.skippedCount = ids.length - i; break; }
      if (report.rows.length >= 128) throw new Error('row-cap');
      report.attemptedRows++;
      const row = { id: ids[i], startedMs: relative(admitted), endedMs: null,
        pid: null, sameAppPid: null, popupTypes: [], typeClass: 'unavailable', transient: null,
        mapState: null, geometry: null, propertiesAvailable: false, geometryAvailable: false, errors: [] };
      try {
        const text = inspectNative('/usr/bin/xprop', ['-id', ids[i], '_NET_WM_PID', '_NET_WM_WINDOW_TYPE', 'WM_TRANSIENT_FOR']);
        const properties = popupProperties(text);
        if (properties.pid !== null && (!Number.isSafeInteger(properties.pid) || properties.pid <= 0)) throw new Error('pid');
        if (properties.transient !== null && !xid(properties.transient)) throw new Error('transient');
        row.pid = properties.pid; row.sameAppPid = properties.pid === null ? null : properties.pid === appPid;
        row.popupTypes = ['COMBO', 'DROPDOWN_MENU', 'POPUP_MENU'].filter(type =>
          new RegExp('(?:^|,\\s*)_NET_WM_WINDOW_TYPE_' + type + '(?:,|$)').test(properties.type || ''));
        row.typeClass = properties.type === null ? 'missing' : row.popupTypes.length ? 'recognized-popup' : 'other';
        row.transient = properties.transient; row.propertiesAvailable = true;
      } catch (error) { row.errors.push({ part: 'properties', ...errorMeta(error) }); }
      try {
        const text = inspectNative('/usr/bin/xwininfo', ['-id', ids[i]]), geometry = windowGeometry(text);
        if (![geometry.left, geometry.top, geometry.width, geometry.height].every(Number.isSafeInteger) ||
            geometry.width < 0 || geometry.height < 0) throw new Error('geometry');
        row.mapState = text.match(/Map State:\s*(\S+)/)?.[1];
        row.geometry = { left: geometry.left, top: geometry.top, width: geometry.width, height: geometry.height };
        row.geometryAvailable = true;
      } catch (error) { row.errors.push({ part: 'geometry', ...errorMeta(error) }); }
      row.endedMs = relative(stamp());
      if (row.errors.length) report.unavailableRows++;
      report.rows.push(row);
    }
    const finished = stamp();
    report.finishedMs = Math.round(finished * 1000) / 1000;
    report.elapsedMs = relative(finished);
    report.complete = report.rows.length === ids.length && report.unavailableRows === 0 && report.elapsedMs <= 8000;
    if (report.skippedIds.length || report.elapsedMs > 8000) report.unavailable = 'budget';
    else if (report.unavailableRows) report.unavailable = 'partial-inspection';
  } catch { report.unavailable = 'observer'; report.unavailableRows += report.attemptedRows - report.rows.length; report.complete = false; }
  return report;
}
