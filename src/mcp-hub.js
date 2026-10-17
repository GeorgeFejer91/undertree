export function setupMcpHub({ dialog, request, run, copyUrl }) {
  const $ = id => document.getElementById(id);
  $('connection-tab-app').insertAdjacentHTML('beforebegin', '<button id="connection-tab-apps" role="tab" aria-controls="connection-panel-apps" aria-selected="false" tabindex="-1" data-connection-tab="apps" data-measure>Apps</button>');
  $('connection-panel-app').insertAdjacentHTML('beforebegin', `
    <section id="connection-panel-apps" role="tabpanel" aria-labelledby="connection-tab-apps" hidden>
      <label class="checkbox-label"><input id="connection-hub-enabled" type="checkbox"><span data-measure>Enable shared app gateway</span></label>
      <p id="connection-hub-status" role="status" data-measure>Start the tunnel to enable the gateway.</p>
      <div id="connection-hub-result" hidden>
        <label><span data-measure>Shared gateway MCP address</span><textarea id="connection-hub-url" readonly rows="3" spellcheck="false"></textarea></label>
        <button id="connection-hub-copy" type="button" data-measure>Copy gateway address</button>
        <p data-measure>Add this one private address to ChatGPT to reach the linked apps. Each app keeps its own permissions.</p>
      </div>
      <form id="connection-hub-form">
        <label><span data-measure>App name</span><input id="connection-hub-label" required maxlength="100" autocomplete="off"></label>
        <label><span data-measure>Existing app MCP address</span><input id="connection-hub-upstream" type="url" required maxlength="8192" autocomplete="off" spellcheck="false" placeholder="https://…"></label>
        <p data-measure>Paste a Secret Tunnel or another app's MCP address. Linking allows all tools currently offered by that app for this session. Remove and link it again to refresh its tools.</p>
        <button id="connection-hub-link" type="submit" data-measure>Link app and allow its tools</button>
      </form>
      <p id="connection-hub-summary" tabindex="-1" data-measure>No apps linked.</p>
      <ul id="connection-hub-apps" aria-label="Linked apps"></ul>
      <p data-measure>Stopping the tunnel or restarting UnderTree clears the gateway and every app link.</p>
    </section>`);
  $('connection-result').insertAdjacentHTML('beforeend', '<details id="connection-review-address" hidden><summary data-measure>Review-only address</summary><label><span data-measure>Marked-text review access</span><textarea id="connection-review-url" readonly rows="3" spellcheck="false"></textarea></label></details>');
  let snapshot = null, running = false, busy = false, pending = null, appsKey = '';
  function controls() {
    $('connection-hub-enabled').disabled = busy || !running || !snapshot;
    $('connection-hub-enabled').checked = Boolean(snapshot?.enabled);
    $('connection-hub-copy').disabled = busy || !running || !snapshot?.enabled;
    for (const id of ['connection-hub-label', 'connection-hub-upstream', 'connection-hub-link']) $(id).disabled = busy || !running || !snapshot?.enabled;
    for (const button of $('connection-hub-apps').querySelectorAll('button')) button.disabled = busy || !running || !snapshot?.enabled;
  }
  function render(result) {
    snapshot = result;
    $('connection-hub-result').hidden = !running || !result.enabled;
    const endpoint = running && result.enabled ? result.endpoint || '' : '';
    if ($('connection-hub-url').value !== endpoint) $('connection-hub-url').value = endpoint;
    $('connection-hub-status').textContent = !running ? 'Start the tunnel to enable the gateway.' : result.enabled ? 'Gateway enabled · public route unverified' : 'Gateway off.';
    const apps = result.apps || [];
    $('connection-hub-summary').textContent = `${apps.length} app${apps.length === 1 ? '' : 's'} linked for this session.`;
    if (JSON.stringify(apps) !== appsKey) $('connection-hub-apps').replaceChildren(...apps.map(app => {
      const item = document.createElement('li');
      const label = document.createElement('span'); label.textContent = `${app.label} · ${app.toolCount} tools`; label.dataset.measure = '';
      const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = 'Remove'; remove.dataset.measure = ''; remove.setAttribute('aria-label', `Remove ${app.label}`);
      remove.onclick = () => run(async () => { await request({ action: 'hub_unlink', id: app.id }); await refresh(); $('connection-hub-summary').focus(); });
      item.append(label, remove); return item;
    }));
    appsKey = JSON.stringify(apps); controls();
  }
  async function refresh() {
    if (pending) return pending;
    if ($('connection-panel-apps').hidden) return;
    pending = request({ action: 'hub_status' }).then(render);
    try { await pending; } finally { pending = null; }
  }
  $('connection-hub-enabled').onchange = () => {
    const enabled = $('connection-hub-enabled').checked;
    run(async () => { try { await request({ action: 'hub_enable', enabled }); await refresh(); } catch (failure) { controls(); throw failure; } });
  };
  $('connection-hub-form').onsubmit = event => {
    event.preventDefault();
    run(async () => {
      await request({ action: 'hub_link', label: $('connection-hub-label').value.trim(), url: $('connection-hub-upstream').value.trim() });
      $('connection-hub-label').value = ''; $('connection-hub-upstream').value = ''; await refresh();
    });
  };
  $('connection-hub-copy').onclick = copyUrl('connection-hub-url');
  dialog.addEventListener('close', () => { $('connection-hub-upstream').value = ''; $('connection-hub-label').value = ''; });
  controls();
  return {
    refresh,
    setBusy(value) { busy = value; controls(); },
    update(connection) {
      running = Boolean(connection.running);
      if (connection.gateway) render(connection.gateway);
      else if (!running) render({ enabled: false, endpoint: '', apps: [] });
      else controls();
    },
  };
}
