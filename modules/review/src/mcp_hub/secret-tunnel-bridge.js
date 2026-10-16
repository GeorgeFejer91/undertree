(() => {
  const aliases = __UNDERTREE_SECRET_TUNNEL_ALIASES__;
  const calls = new Map();
  const uiMethods = new Set([
    'ui/initialize', 'ui/notifications/initialized',
    'ui/notifications/size-changed', 'ui/update-model-context',
  ]);
  const post = window.parent.postMessage.bind(window.parent);
  function refuse(message) {
    if (typeof message?.id !== 'string' && typeof message?.id !== 'number') return;
    queueMicrotask(() => window.dispatchEvent(new MessageEvent('message', {
      source: window.parent,
      data: { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'This widget request is unavailable.' } },
    })));
  }
  Object.defineProperty(window, '__undertreeSecretTunnelPostMessage', {
    value(message, targetOrigin) {
      if (message?.jsonrpc !== '2.0' || targetOrigin !== '*') return refuse(message);
      if (uiMethods.has(message.method)) return post(message, targetOrigin);
      const params = message.params;
      if (message.method !== 'tools/call' || !Object.hasOwn(aliases, params?.name)
        || (typeof message.id !== 'string' && typeof message.id !== 'number')
        || !params.arguments || typeof params.arguments !== 'object' || Array.isArray(params.arguments)) {
        return refuse(message);
      }
      const key = JSON.stringify(message.id);
      if (!calls.has(key)) {
        if (calls.size >= 128) return refuse(message);
        calls.set(key, crypto.randomUUID());
      }
      return post({
        ...message,
        params: {
          name: aliases[params.name],
          arguments: { requestId: calls.get(key), arguments: params.arguments },
        },
      }, targetOrigin);
    },
  });
})();
