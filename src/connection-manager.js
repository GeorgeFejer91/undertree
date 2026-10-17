// Rust owns the process and grants. The dialog holds only a transient status snapshot.
import { setupPdfExportConsent } from './pdf-export-consent.js';
import { setupMcpHub } from './mcp-hub.js';
import selectiveEditor from '../modules/review/selective-editor-contract.json' with { type: 'json' };
export function setupConnectionManager({ request, controlRequest, onRevoked, onShares, status }) {
  const $ = id => document.getElementById(id);
  const dialog = $('connection-dialog');
  $('connection-context-help').textContent = selectiveEditor.labels.contextHelp;
  $('connection-context-read-help').textContent = selectiveEditor.labels.contextReadHelp;
  $('connection-start').textContent = selectiveEditor.labels.startAccess;
  $('connection-copy').textContent = selectiveEditor.labels.copyAddress;
  dialog.querySelector('.connection-tabs').insertAdjacentHTML('beforeend', '<button id="connection-tab-app" role="tab" aria-label="App controls" aria-controls="connection-panel-app" aria-selected="false" tabindex="-1" data-connection-tab="app" data-measure>App</button>');
  $('connection-tab-shared').textContent = 'Shared';
  $('connection-tab-shared').setAttribute('aria-label', 'Shared manuscripts');
  $('connection-refresh').textContent = 'Refresh';
  $('tunnel-stop').textContent = selectiveEditor.labels.stopAccess;
  $('tunnel-stop').setAttribute('aria-label', 'Stop tunnel and revoke all access');
  $('connection-panel-shared').insertAdjacentHTML('afterend', `
    <section id="connection-panel-app" role="tabpanel" aria-labelledby="connection-tab-app" hidden>
      <label class="checkbox-label"><input id="connection-app-enabled" type="checkbox"><span data-measure>App controls · no file editing</span></label>
      <p id="connection-app-status" role="status" data-measure>App controls are off.</p>
      <details id="connection-app-result" hidden>
        <summary data-measure>URL</summary>
        <label><span data-measure>App controls URL</span><textarea id="connection-app-url" readonly rows="2" spellcheck="false"></textarea></label>
        <button id="connection-app-copy" type="button" data-measure>Copy app controls URL</button>
        <p id="connection-app-url-help" data-measure>Add this separate URL in ChatGPT. Keep it private. Turning off app controls revokes it; the Review URL keeps its separate editing and color-only tools. Client identity and the public route are unverified.</p>
      </details>
      <details><summary data-measure>Help</summary><p data-measure>Enable after starting the tunnel. Control views, selection and preview. Navigation, builds and closing leave local buffers untouched. File editing and suggestion acceptance stay in UnderTree. Access ends when you turn this off or stop the tunnel.</p></details>
    </section>`);
  const pdfExport = setupPdfExportConsent({ container: $('connection-panel-app'), request: controlRequest, run });
  const hub = setupMcpHub({ dialog, request, run, copyUrl });
  const tabs = [...dialog.querySelectorAll('[data-connection-tab]')];
  let snapshot = null;
  let busy = false;
  let pending = null;
  let timer = null;
  let configured = false;
  let toolsKey = '';
  let sharesKey = '';

  function selectTab(name, focus = false) {
    for (const tab of tabs) {
      const selected = !tab.disabled && tab.dataset.connectionTab === name;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
      $(tab.getAttribute('aria-controls')).hidden = !selected;
      if (selected && focus) tab.focus();
    }
    if (name === 'apps' && dialog.open) refresh().catch(failure => error(failure.message || String(failure)));
  }
  function controls() {
    pdfExport.setBusy(busy);
    hub.setBusy(busy);
    const running = Boolean(snapshot?.running);
    const textOnly = snapshot?.textOnlyConnector && !snapshot?.gateway?.enabled;
    $('connection-tab-app').disabled = Boolean(textOnly);
    $('connection-tab-app').title = textOnly ? 'Enable the shared app gateway to allow App controls through this connector.' : '';
    if (textOnly && $('connection-tab-app').getAttribute('aria-selected') === 'true') selectTab('mcp');
    $('tunnel-start').disabled = busy || running || !snapshot;
    $('connection-start').disabled = busy || running || !snapshot;
    $('tunnel-stop').disabled = busy || !snapshot || !(running || snapshot.sharedCount || snapshot.lastError);
    $('connection-refresh').disabled = busy;
    $('zrok-name').disabled = busy || running;
    $('zrok-origin').disabled = busy || running;
    $('connection-app-enabled').disabled = busy || !running || !controlRequest || !snapshot?.appControls || textOnly;
    $('connection-app-copy').disabled = busy || !snapshot?.appControls?.enabled;
    $('connection-copy').disabled = busy || !running;
    for (const button of $('connection-shares').querySelectorAll('button')) button.disabled = busy;
    dialog.setAttribute('aria-busy', String(busy));
  }
  function error(message = '') {
    $('connection-error').textContent = message;
    $('connection-error').hidden = !message;
  }
  function render(result) {
    snapshot = result;
    hub.update(result);
    const gateway = result.gateway?.enabled ? result.gateway : null;
    const initialized = gateway ? Boolean(gateway.mcpInitialized) : Boolean(result.mcpInitialized);
    onShares(result.shared || []);
    const state = result.lastError || (result.running ? 'zrok running' : 'Tunnel stopped');
    $('connection-status').textContent = state;
    $('connection-overview-tunnel').textContent = result.running ? 'zrok running' : 'Stopped';
    $('connection-overview-mcp').textContent = initialized ? 'Initialized · public route unverified' : 'No initialization observed';
    $('tunnel-label').textContent = result.running ? (initialized ? 'MCP client initialized' : 'zrok running · waiting for MCP client') : 'ChatGPT disconnected';
    $('connection-mcp-status').textContent = initialized
      ? `MCP client initialized · ${result.toolCalls} tool calls · last request ${new Date(result.lastActivityMs).toLocaleTimeString()}. Client identity and public route are unverified.`
      : 'No MCP initialization received in this session. Connect and test the endpoint in ChatGPT.';
    $('connection-result').hidden = !result.running;
    // Keep selection intact while the user copies the capability URL.
    const endpoint = gateway ? gateway.endpoint || '' : result.endpoint || '';
    if ($('connection-url').value !== endpoint) $('connection-url').value = endpoint;
    $('connection-review-address').hidden = !gateway || !result.endpoint || gateway.endpoint === result.endpoint;
    if ($('connection-review-url').value !== (result.endpoint || '')) $('connection-review-url').value = result.endpoint || '';
    const appControls = result.appControls;
    pdfExport.update(appControls);
    $('connection-app-enabled').checked = Boolean(appControls?.enabled);
    $('connection-app-result').hidden = !appControls?.enabled;
    const appUrl = appControls?.enabled ? appControls.endpoint || '' : '';
    if ($('connection-app-url').value !== appUrl) $('connection-app-url').value = appUrl;
    $('connection-app-status').textContent = !controlRequest || !appControls
      ? 'Unavailable'
      : appControls.enabled ? 'Enabled' : 'Off';
    $('connection-app-url-help').textContent = gateway
      ? 'Use the shared gateway address in ChatGPT. App controls are included while this local permission is enabled. File editing stays local. The public route is unverified.'
      : 'Add this separate URL in ChatGPT. Keep it private. Turning off app controls revokes it; the Review URL keeps its separate editing and color-only tools. Client identity and the public route are unverified.';
    if (!configured || result.running) {
      $('zrok-name').value = result.config?.reservation || '';
      $('zrok-origin').value = result.config?.publicUrl || '';
      configured = true;
    }
    $('connection-protocol').textContent = `Streamable HTTP · MCP ${result.protocolVersion}`;
    const tools = gateway ? gateway.tools || [] : result.tools || [];
    if (JSON.stringify(tools) !== toolsKey) $('connection-tools').replaceChildren(...tools.map(tool => {
      const item = document.createElement('li'); item.textContent = tool.name; item.dataset.measure = ''; return item;
    }));
    toolsKey = JSON.stringify(tools);
    const shared = result.shared || [];
    $('connection-share-summary').textContent = `${shared.length} manuscript${shared.length === 1 ? '' : 's'} shared in this session.`;
    if (JSON.stringify(shared) !== sharesKey) $('connection-shares').replaceChildren(...shared.map(share => {
      const item = document.createElement('li');
      const label = document.createElement('span'); label.textContent = `${share.projectName} / ${share.path}`; label.dataset.measure = '';
      const revoke = document.createElement('button'); revoke.type = 'button'; revoke.textContent = selectiveEditor.labels.revoke; revoke.dataset.measure = '';
      revoke.setAttribute('aria-label', `Revoke access to ${share.path}`);
      revoke.onclick = () => run(async () => {
        await request({ action: 'share', project: share.project, path: share.path, enabled: false });
        onRevoked(share);
        $('connection-share-summary').focus();
      });
      item.append(label, revoke); return item;
    }));
    sharesKey = JSON.stringify(shared);
    controls();
  }
  async function refresh() {
    if (pending) return pending;
    pending = request({ action: 'connection' }).then(async result => { render(result); await hub.refresh(); });
    try { await pending; } finally { pending = null; }
  }
  async function run(action) {
    if (busy) return;
    busy = true; controls(); error();
    try {
      await pending;
      await action();
      await refresh();
    } catch (failure) {
      error(failure.message || String(failure));
    } finally { busy = false; controls(); }
  }
  for (const tab of tabs) {
    tab.onclick = () => selectTab(tab.dataset.connectionTab);
    tab.onkeydown = event => {
      const enabled = tabs.filter(tab => !tab.disabled);
      let index = enabled.indexOf(tab);
      if (event.key === 'ArrowRight') index = (index + 1) % enabled.length;
      else if (event.key === 'ArrowLeft') index = (index + enabled.length - 1) % enabled.length;
      else if (event.key === 'Home') index = 0;
      else if (event.key === 'End') index = enabled.length - 1;
      else return;
      event.preventDefault(); selectTab(enabled[index].dataset.connectionTab, true);
    };
  }
  async function open(tab) {
    if (dialog.open) return;
    selectTab(tab || 'mcp');
    dialog.showModal();
    timer = setInterval(() => {
      if (!busy && !document.hidden) refresh().catch(failure => error(failure.message || String(failure)));
    }, 2000);
    try { await refresh(); error(); } catch (failure) { error(failure.message || String(failure)); }
  }
  $('connection-open').onclick = () => open();
  $('chatgpt-open').onclick = () => open('mcp');
  $('connection-configure').onclick = () => selectTab('zrok', true);
  dialog.addEventListener('close', () => { clearInterval(timer); timer = null; });
  $('connection-refresh').onclick = () => run(async () => {});
  function startTunnel() {
    if (!$('connection-form').checkValidity()) {
      selectTab('zrok');
      $('connection-form').reportValidity();
      return;
    }
    return run(async () => {
      await request({ action: 'tunnel', enabled: true, reservation: $('zrok-name').value.trim(), public_url: $('zrok-origin').value.trim() });
      selectTab('mcp');
    });
  }
  $('connection-start').onclick = startTunnel;
  $('connection-form').onsubmit = event => { event.preventDefault(); startTunnel(); };
  $('tunnel-stop').onclick = () => run(async () => {
    await request({ action: 'tunnel', enabled: false, reservation: '', public_url: '' });
    onRevoked();
    status('Tunnel stopped. All manuscript access revoked.');
  });
  $('connection-app-enabled').onchange = () => {
    const enabled = $('connection-app-enabled').checked;
    run(async () => {
      try {
        await controlRequest({ action: 'control_enable', enabled });
        status('App control permissions updated. File editing stays local.');
      } catch (failure) {
        $('connection-app-enabled').checked = Boolean(snapshot?.appControls?.enabled);
        throw failure;
      }
    });
  };
  function copyUrl(id) { return async () => {
    try {
      await navigator.clipboard.writeText($(id).value);
      status('Private connection URL copied.');
    } catch {
      $(id).focus(); $(id).select();
      error('Copy the selected URL with your keyboard or context menu.');
    }
  }; }
  $('connection-copy').onclick = copyUrl('connection-url');
  $('connection-app-copy').onclick = copyUrl('connection-app-url');
  controls();
  return { refresh };
}
