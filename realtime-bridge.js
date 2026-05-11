(() => {
  // Runs in ISOLATED world. Bridges window.postMessage events from
  // realtime-hook.js (MAIN world) into chrome.runtime messages for the
  // service worker.
  //
  // Why two scripts: chrome.runtime is unavailable from MAIN world, and
  // window.WebSocket can't be patched from ISOLATED world. So we patch in
  // MAIN, forward via postMessage, and relay from ISOLATED.

  const POST_TYPE = 'exscalp:rt';

  // We're chatty during reconnaissance — throttle relayed messages to once
  // per second so we don't flood the trace ring.
  const RELAY_THROTTLE_MS = 1000;
  let lastRelay = 0;

  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    const m = e.data;
    if (!m || m.type !== POST_TYPE || !m.payload) return;
    const p = m.payload;

    // Connection events are infrequent — always relay.
    if (p.stage !== 'message') {
      chrome.runtime.sendMessage({
        type: 'RT_CONN',
        url: p.url,
        state: p.stage,
        code: p.code,
        reason: p.reason,
      }).catch(() => {});
      return;
    }

    // Price-candidate messages are frequent — throttle.
    const now = Date.now();
    if (now - lastRelay < RELAY_THROTTLE_MS) return;
    lastRelay = now;

    chrome.runtime.sendMessage({
      type: 'RT_TICK',
      url: p.url,
      kind: p.kind,
      len: p.len,
      preview: p.preview,
    }).catch(() => {});
  });
})();
