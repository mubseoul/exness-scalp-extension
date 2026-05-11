(() => {
  // Runs in MAIN world at document_start, BEFORE Exness's bundle creates its
  // WebSocket. We monkey-patch window.WebSocket so we can observe (and now
  // also parse) the live XAUUSDr tick stream that the chart uses.
  //
  // Tick format (confirmed v0.5 reconnaissance):
  //   {"i":"XAUUSDr","t":1778472043630,"b":4679.033,"a":4679.147}
  //   i = instrument, t = epoch ms, b = bid, a = ask
  //
  // Two URLs to watch:
  //   wss://rtapi-dx.exweb.mobi/.../v2/ws/ticks/accounts/{id}   ← tick stream
  //   wss://rtapi-dx.exweb.mobi/.../v1/ws/events/accounts/{id}  ← positions/orders/deals
  //
  // The hook is passive — we attach listeners only, never alter outgoing
  // messages or block the page's normal flow.

  if (window.__exscalpRealtimeHooked) return;
  window.__exscalpRealtimeHooked = true;

  const POST_TYPE = 'exscalp:rt';
  const TARGET_INSTRUMENT = 'XAUUSDr';
  const TARGET_HOST_HINTS = ['exweb.mobi', 'exness.global', 'exness.com', 'tradingview.com'];

  // Diagnostic sample ring — keeps last 60 frames for the popup dump.
  const SAMPLES = [];
  const SAMPLE_CAP = 60;
  window.__exscalpSamples = SAMPLES;

  function isInteresting(url) {
    try {
      const host = new URL(url, location.href).host;
      return TARGET_HOST_HINTS.some(h => host.includes(h));
    } catch { return false; }
  }

  // Fast-path: detect XAUUSDr tick without full JSON.parse cost.
  // All ticks start with `{"i":"XAUUSDr",` per the captured samples.
  function tryParseXauTick(data) {
    if (typeof data !== 'string') return null;
    if (data.length < 40 || data.length > 200) return null;
    if (data.charCodeAt(0) !== 123) return null; // '{'
    if (!data.startsWith('{"i":"' + TARGET_INSTRUMENT + '"')) return null;
    try {
      const j = JSON.parse(data);
      if (typeof j.b !== 'number' || typeof j.a !== 'number') return null;
      return { t: j.t || Date.now(), b: j.b, a: j.a };
    } catch { return null; }
  }

  function classifyForDiag(data) {
    if (data == null) return { kind: 'empty' };
    if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
      return { kind: 'binary', byteLen: data.byteLength ?? data.length };
    }
    if (typeof data === 'string') {
      const looksPrice = /"(bid|ask|last|price|i)"\s*:/i.test(data);
      return { kind: looksPrice ? 'price_candidate' : 'json_other', len: data.length };
    }
    return { kind: 'other' };
  }

  function pushSample(direction, url, data, info) {
    if (SAMPLES.length >= SAMPLE_CAP) return;
    let preview = null;
    if (typeof data === 'string') preview = data.slice(0, 500);
    SAMPLES.push({ ts: Date.now(), direction, url: String(url), ...info, preview });
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
        pushSample('meta', url, null, { stage: 'connecting' });

        ws.addEventListener('open',  () => { forward({ stage: 'open', url }); pushSample('meta', url, null, { stage: 'open' }); });
        ws.addEventListener('close', (e) => { forward({ stage: 'close', url, code: e.code, reason: e.reason }); pushSample('meta', url, null, { stage: 'close', code: e.code }); });
        ws.addEventListener('error', ()  => { forward({ stage: 'error', url }); pushSample('meta', url, null, { stage: 'error' }); });

        ws.addEventListener('message', (event) => {
          // Hot path: XAUUSDr tick — parse and forward immediately, NO sample.
          const tick = tryParseXauTick(event.data);
          if (tick) {
            forward({ stage: 'tick', t: tick.t, b: tick.b, a: tick.a });
            return;
          }
          // Cold path: diagnostic sample for everything else.
          const cls = classifyForDiag(event.data);
          pushSample('recv', url, event.data, cls);
        });

        const origSend = ws.send.bind(ws);
        ws.send = function (data) {
          try { pushSample('send', url, data, classifyForDiag(data)); } catch {}
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
  console.info('[ExScalp hook] WebSocket patched at document_start (tick parser active)');
})();
