// Rust owns the process and grants. The dialog holds only a transient status snapshot.
export function setupConnectionManager({ request, onRevoked, onShares, status }) {
  const $ = id => document.getElementById(id);
  const dialog = $('connection-dialog');
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
      const selected = tab.dataset.connectionTab === name;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
      $(tab.getAttribute('aria-controls')).hidden = !selected;
      if (selected && focus) tab.focus();
    }
  }
  function controls() {
    const running = Boolean(snapshot?.running);
    $('tunnel-start').disabled = busy || running || !snapshot;
    $('tunnel-stop').disabled = busy || !snapshot || !(running || snapshot.sharedCount || snapshot.lastError);
    $('connection-refresh').disabled = busy;
    $('zrok-name').disabled = busy || running;
    $('zrok-origin').disabled = busy || running;
    for (const button of $('connection-shares').querySelectorAll('button')) button.disabled = busy;
    dialog.setAttribute('aria-busy', String(busy));
  }
  function error(message = '') {
    $('connection-error').textContent = message;
    $('connection-error').hidden = !message;
  }
  function render(result) {
    snapshot = result;
    onShares(result.shared || []);
    const state = result.lastError || (result.running ? 'zrok process running · public reachability unverified' : 'Tunnel stopped · offline editing available');
    $('connection-status').textContent = state;
    $('tunnel-label').textContent = result.running ? (result.mcpInitialized ? 'MCP client initialized' : 'zrok running · waiting for MCP client') : 'ChatGPT disconnected';
    $('connection-mcp-status').textContent = result.mcpInitialized
      ? `MCP client initialized · ${result.toolCalls} tool calls · last request ${new Date(result.lastActivityMs).toLocaleTimeString()}. Client identity and public route are unverified.`
      : 'No MCP initialization received in this session. Connect and test the endpoint in ChatGPT.';
    $('connection-result').hidden = !result.running;
    // Keep selection intact while the user copies the capability URL.
    if ($('connection-url').value !== result.endpoint) $('connection-url').value = result.endpoint || '';
    if (!configured || result.running) {
      $('zrok-name').value = result.config?.reservation || '';
      $('zrok-origin').value = result.config?.publicUrl || '';
      configured = true;
    }
    $('connection-protocol').textContent = `Streamable HTTP · MCP ${result.protocolVersion}`;
    const tools = result.tools || [];
    if (JSON.stringify(tools) !== toolsKey) $('connection-tools').replaceChildren(...tools.map(tool => {
      const item = document.createElement('li'); item.textContent = tool.name; item.dataset.measure = ''; return item;
    }));
    toolsKey = JSON.stringify(tools);
    const shared = result.shared || [];
    $('connection-share-summary').textContent = `${shared.length} manuscript${shared.length === 1 ? '' : 's'} shared in this session.`;
    if (JSON.stringify(shared) !== sharesKey) $('connection-shares').replaceChildren(...shared.map(share => {
      const item = document.createElement('li');
      const label = document.createElement('span'); label.textContent = `${share.projectName} / ${share.path}`; label.dataset.measure = '';
      const revoke = document.createElement('button'); revoke.type = 'button'; revoke.textContent = 'Revoke'; revoke.dataset.measure = '';
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
    pending = request({ action: 'connection' }).then(render);
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
      let index = tabs.indexOf(tab);
      if (event.key === 'ArrowRight') index = (index + 1) % tabs.length;
      else if (event.key === 'ArrowLeft') index = (index + tabs.length - 1) % tabs.length;
      else if (event.key === 'Home') index = 0;
      else if (event.key === 'End') index = tabs.length - 1;
      else return;
      event.preventDefault(); selectTab(tabs[index].dataset.connectionTab, true);
    };
  }
  $('connection-open').onclick = async () => {
    if (dialog.open) return;
    dialog.showModal();
    timer = setInterval(() => {
      if (!busy && !document.hidden) refresh().catch(failure => error(failure.message || String(failure)));
    }, 2000);
    try { await refresh(); error(); } catch (failure) { error(failure.message || String(failure)); }
  };
  dialog.addEventListener('close', () => { clearInterval(timer); timer = null; });
  $('connection-refresh').onclick = () => run(async () => {});
  $('connection-form').onsubmit = event => {
    event.preventDefault();
    run(async () => {
      await request({ action: 'tunnel', enabled: true, reservation: $('zrok-name').value.trim(), public_url: $('zrok-origin').value.trim() });
      selectTab('mcp');
    });
  };
  $('tunnel-stop').onclick = () => run(async () => {
    await request({ action: 'tunnel', enabled: false, reservation: '', public_url: '' });
    onRevoked();
    status('Tunnel stopped. All manuscript access revoked.');
  });
  $('connection-copy').onclick = async () => {
    try {
      await navigator.clipboard.writeText($('connection-url').value);
      status('Private connection URL copied.');
    } catch {
      $('connection-url').focus(); $('connection-url').select();
      error('Copy the selected URL with your keyboard or context menu.');
    }
  };
  controls();
  return { refresh };
}
