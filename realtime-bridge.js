(() => {
  // Runs in ISOLATED world. Bridges window.postMessage events from
  // realtime-hook.js (MAIN world) into chrome.runtime messages for the
  // service worker.
  //
  // Why two scripts: chrome.runtime is unavailable from MAIN world, and
  // window.WebSocket can't be patched from ISOLATED world.
  //
  // Tick batching: Exness pushes XAUUSDr ticks at 3-6/sec. One
  // chrome.runtime.sendMessage per tick is wasteful. We accumulate ticks
  // for 500ms and send a single batch.

  const POST_TYPE = 'exscalp:rt';
  const BATCH_MS = 500;

  let tickBatch = [];
  let flushTimer = null;

  function flushBatch() {
    flushTimer = null;
    if (!tickBatch.length) return;
    const batch = tickBatch;
    tickBatch = [];
    chrome.runtime.sendMessage({ type: 'RT_TICK_BATCH', ticks: batch }).catch(() => {});
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    const m = e.data;
    if (!m || m.type !== POST_TYPE || !m.payload) return;
    const p = m.payload;

    if (p.stage === 'tick') {
      tickBatch.push({ t: p.t, b: p.b, a: p.a });
      if (!flushTimer) flushTimer = setTimeout(flushBatch, BATCH_MS);
      return;
    }

    // Connection lifecycle events — always relayed (low frequency)
    chrome.runtime.sendMessage({
      type: 'RT_CONN',
      url: p.url,
      state: p.stage,
      code: p.code,
      reason: p.reason,
    }).catch(() => {});
  });
})();
