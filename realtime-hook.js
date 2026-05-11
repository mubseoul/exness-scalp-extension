(() => {
  // Runs in MAIN world at document_start, BEFORE Exness's bundle creates its
  // WebSocket. We monkey-patch window.WebSocket so we can observe (and later
  // forward) the live tick stream that the chart uses.
  //
  // Two things to know:
  //   1. Exness's terminal opens its WS very early. If our content script is
  //      late, we miss it. document_start + MAIN world is the only way.
  //   2. Tick messages may be JSON or binary (msgpack/protobuf). We sample
  //      both as base64 for the user to dump and send to us, then we write
  //      a real parser based on what we observe.
  //
  // The hook does NOT touch the page's normal data flow — we only attach
  // passive listeners to each created socket.

  if (window.__exscalpRealtimeHooked) return;
  window.__exscalpRealtimeHooked = true;

  const POST_TYPE = 'exscalp:rt';
  const TARGET_HOST_HINTS = [
    'exweb.mobi',
    'exness.global',
    'exness.com',
    'tradingview.com',
  ];

  // Bounded ring of recent samples so users can dump them via the popup.
  // Bounded so a chatty 50-tick/s feed doesn't blow out memory.
  const SAMPLES = [];
  const SAMPLE_CAP = 60;

  function isInteresting(url) {
    try {
      const host = new URL(url, location.href).host;
      return TARGET_HOST_HINTS.some(h => host.includes(h));
    } catch { return false; }
  }

  // Best-effort classification of the message payload so we can spot
  // price-bearing messages quickly. Real parsing happens in phase 2.
  function classify(data) {
    if (data == null) return { kind: 'empty' };
    if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
      return { kind: 'binary', byteLen: data.byteLength ?? data.length };
    }
    if (typeof data === 'string') {
      const has = (re) => re.test(data);
      const looksPrice =
        has(/"bid"\s*:/i)  ||
        has(/"ask"\s*:/i)  ||
        has(/"last"\s*:/i) ||
        has(/"price"\s*:/i)||
        has(/XAU(USD)?[a-z]?/i);
      return {
        kind: looksPrice ? 'price_candidate' : (data[0] === '{' || data[0] === '[' ? 'json_other' : 'string_other'),
        len: data.length,
      };
    }
    return { kind: 'other' };
  }

  function bytesToBase64(view) {
    // Truncate to 400 bytes — enough for protocol fingerprinting.
    const buf = view instanceof ArrayBuffer ? new Uint8Array(view) : new Uint8Array(view.buffer || view);
    const slice = buf.subarray(0, 400);
    let s = '';
    for (let i = 0; i < slice.length; i++) s += String.fromCharCode(slice[i]);
    try { return btoa(s); } catch { return null; }
  }

  function sample(direction, url, data, info) {
    if (SAMPLES.length >= SAMPLE_CAP) return;
    let preview = null;
    if (typeof data === 'string') preview = data.slice(0, 500);
    else if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) preview = bytesToBase64(data);
    SAMPLES.push({
      ts: Date.now(),
      direction,           // 'recv' | 'send' | 'meta'
      url: String(url),
      ...info,
      preview,
    });
    // Expose for popup-side dump
    window.__exscalpSamples = SAMPLES;
  }

  function forward(payload) {
    try { window.postMessage({ type: POST_TYPE, payload }, '*'); } catch {}
  }

  const NativeWebSocket = window.WebSocket;
  function PatchedWebSocket(url, protocols) {
    const ws = protocols !== undefined ? new NativeWebSocket(url, protocols) : new NativeWebSocket(url);
    try {
      if (isInteresting(url)) {
        forward({ stage: 'connecting', url: String(url) });
        sample('meta', url, null, { stage: 'connecting' });

        ws.addEventListener('open',  () => { forward({ stage: 'open', url }); sample('meta', url, null, { stage: 'open' }); });
        ws.addEventListener('close', (e) => { forward({ stage: 'close', url, code: e.code, reason: e.reason }); sample('meta', url, null, { stage: 'close', code: e.code }); });
        ws.addEventListener('error', ()  => { forward({ stage: 'error', url }); sample('meta', url, null, { stage: 'error' }); });

        ws.addEventListener('message', (event) => {
          const cls = classify(event.data);
          sample('recv', url, event.data, cls);
          // We only forward price-candidate messages to the bridge so the
          // trace stays useful; the rest is kept in __exscalpSamples for dump.
          if (cls.kind === 'price_candidate') {
            forward({ stage: 'message', url, ...cls, preview: typeof event.data === 'string' ? event.data.slice(0, 500) : null });
          }
        });

        // Wrap send so we can see subscription frames the page issues.
        const origSend = ws.send.bind(ws);
        ws.send = function (data) {
          try { sample('send', url, data, classify(data)); } catch {}
          return origSend(data);
        };
      }
    } catch (e) {
      console.warn('[ExScalp hook] error', e);
    }
    return ws;
  }
  PatchedWebSocket.prototype = NativeWebSocket.prototype;
  PatchedWebSocket.CONNECTING = NativeWebSocket.CONNECTING;
  PatchedWebSocket.OPEN       = NativeWebSocket.OPEN;
  PatchedWebSocket.CLOSING    = NativeWebSocket.CLOSING;
  PatchedWebSocket.CLOSED     = NativeWebSocket.CLOSED;

  window.WebSocket = PatchedWebSocket;
  console.info('[ExScalp hook] WebSocket patched at document_start');
})();
