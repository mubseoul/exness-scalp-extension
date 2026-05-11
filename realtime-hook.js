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

  // ============================================================
  // HTTP capture — fetch() + XHR
  // ============================================================
  // We want to discover Exness's historical-bar endpoint (TradingView
  // UDF-style) so we can backfill ticks on cold start. The endpoint is
  // hit when the chart loads or pans. We capture URL + method + status +
  // response body (first 800 chars) for any URL that looks chart-related
  // and trace it via the bridge.

  const HTTP_HOST_HINTS = ['exweb.mobi', 'tradingview.com'];
  const HTTP_PATH_RE = /(history|datafeed|udf|\/bars|ohlc|tex-trading|chart|quotes|symbols|resolve)/i;
  const HTTP_DEDUP = new Map();           // url → last-trace ts
  const HTTP_DEDUP_MS = 5000;

  function isInterestingHttp(url) {
    try {
      const u = new URL(url, location.href);
      if (HTTP_HOST_HINTS.some(h => u.host.includes(h))) return true;
      if (HTTP_PATH_RE.test(u.pathname + u.search)) return true;
    } catch {}
    return false;
  }

  function maybeForwardHttp(info) {
    const key = info.url.split('?')[0] + '|' + info.method;
    const now = Date.now();
    const last = HTTP_DEDUP.get(key) || 0;
    if (now - last < HTTP_DEDUP_MS) return;
    HTTP_DEDUP.set(key, now);
    forward({ stage: 'http', ...info });
  }

  // Capture the most recent Authorization header on requests to Exness's
  // REST API. The page uses a bearer JWT that's not in cookies — without it
  // our own service-worker fetches get 401. We stash the latest one so the
  // service worker can replay it for backfill / order placement.
  window.__exscalpAuthHeader = null;

  function extractAuthHeader(init, input) {
    try {
      let h = init && init.headers;
      if (!h && typeof input !== 'string' && input?.headers) h = input.headers;
      if (!h) return null;
      if (h instanceof Headers) return h.get('authorization') || h.get('Authorization');
      if (typeof h.get === 'function') return h.get('authorization') || h.get('Authorization');
      // Plain object
      for (const k of Object.keys(h)) {
        if (k.toLowerCase() === 'authorization') return h[k];
      }
    } catch {}
    return null;
  }

  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    const method = ((init && init.method) || (typeof input !== 'string' && input?.method) || 'GET').toUpperCase();
    if (!isInterestingHttp(url)) return origFetch.apply(this, arguments);

    // Sniff the bearer token if present.
    const auth = extractAuthHeader(init, input);
    if (auth && /^bearer\s/i.test(auth)) {
      window.__exscalpAuthHeader = auth;
    }

    const t0 = Date.now();
    return origFetch.apply(this, arguments).then(async (resp) => {
      try {
        const clone = resp.clone();
        const text = await clone.text().catch(() => '');
        maybeForwardHttp({
          url: String(url),
          method,
          status: resp.status,
          contentType: resp.headers.get('content-type') || null,
          bodyPreview: text.slice(0, 800),
          bodyLen: text.length,
          tookMs: Date.now() - t0,
          authPresent: !!auth,
          authScheme: auth ? auth.split(' ')[0] : null,
          authLen: auth ? auth.length : 0,
        });
      } catch {}
      return resp;
    }).catch((e) => {
      maybeForwardHttp({ url: String(url), method, status: 0, error: String(e?.message || e), tookMs: Date.now() - t0 });
      throw e;
    });
  };

  const OrigXHR = window.XMLHttpRequest;
  function PatchedXHR() {
    const xhr = new OrigXHR();
    let _url = '', _method = 'GET', _t0 = 0, _auth = null;
    const origOpen = xhr.open;
    xhr.open = function (method, url) {
      _method = String(method || 'GET').toUpperCase();
      _url = String(url || '');
      return origOpen.apply(this, arguments);
    };
    const origSetHeader = xhr.setRequestHeader;
    xhr.setRequestHeader = function (name, value) {
      if (String(name).toLowerCase() === 'authorization') {
        _auth = value;
        if (/^bearer\s/i.test(value)) window.__exscalpAuthHeader = value;
      }
      return origSetHeader.apply(this, arguments);
    };
    const origSend = xhr.send;
    xhr.send = function () {
      _t0 = Date.now();
      if (isInterestingHttp(_url)) {
        xhr.addEventListener('loadend', () => {
          try {
            maybeForwardHttp({
              url: _url,
              method: _method,
              status: xhr.status,
              contentType: xhr.getResponseHeader('content-type'),
              bodyPreview: typeof xhr.responseText === 'string' ? xhr.responseText.slice(0, 800) : null,
              bodyLen: typeof xhr.responseText === 'string' ? xhr.responseText.length : null,
              tookMs: Date.now() - _t0,
              authPresent: !!_auth,
              authScheme: _auth ? _auth.split(' ')[0] : null,
            });
          } catch {}
        });
      }
      return origSend.apply(this, arguments);
    };
    return xhr;
  }
  // Preserve statics + prototype so the page sees a normal XHR
  PatchedXHR.prototype = OrigXHR.prototype;
  for (const k of Object.getOwnPropertyNames(OrigXHR)) {
    if (k === 'prototype' || k === 'name' || k === 'length') continue;
    try { PatchedXHR[k] = OrigXHR[k]; } catch {}
  }
  window.XMLHttpRequest = PatchedXHR;

  console.info('[ExScalp hook] WebSocket + HTTP patched at document_start');
})();
