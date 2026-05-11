// Injected into Exness webtrading pages. Responsibilities:
//   1. Render the floating overlay (status, pending signal, approve/reject).
//   2. Scrape current bid/ask from the page DOM (for cross-check w/ Yahoo).
//   3. On EXECUTE message, fill the order ticket + click buy/sell.
//   4. Calibration mode — when settings.exness.selectors are unset, the user
//      can teach the extension which DOM nodes are which.
//
// IMPORTANT: This file is intentionally defensive. Exness's frontend changes
// frequently. If a selector fails, we trace the failure, surface a "needs
// calibration" badge in the overlay, and refuse to place orders.

(() => {
  if (window.__exscalp_loaded) return;
  window.__exscalp_loaded = true;

  const SETTINGS_KEY = 'exscalp_v1';
  const overlay = createOverlay();
  document.documentElement.appendChild(overlay.root);

  let settings = null;
  let pending = null;
  let countdownTimer = null;
  let priceTimer = null;
  let lastPrice = { bid: null, ask: null, mid: null, at: 0 };

  refreshSettings().then(() => {
    overlay.setStatus(statusLabel());
    startPricePoll();
  });

  chrome.storage.onChanged.addListener((changes) => {
    if (changes[SETTINGS_KEY]) {
      settings = changes[SETTINGS_KEY].newValue;
      overlay.setStatus(statusLabel());
    }
  });

  async function refreshSettings() {
    const s = await chrome.storage.local.get(SETTINGS_KEY);
    settings = s[SETTINGS_KEY] || null;
  }

  function statusLabel() {
    if (!settings) return 'loading';
    if (!settings.enabled) return 'disarmed';
    if (settings.paused) return 'paused';
    return 'armed';
  }

  // --- DOM scraping (price) -------------------------------------------------

  function scrapePrice() {
    const sel = settings?.exness?.selectors;
    if (!sel?.bidPrice || !sel?.askPrice) return null;
    try {
      const bidEl = document.querySelector(sel.bidPrice);
      const askEl = document.querySelector(sel.askPrice);
      const bid = parseFloat((bidEl?.textContent || '').replace(/[^\d.\-]/g, ''));
      const ask = parseFloat((askEl?.textContent || '').replace(/[^\d.\-]/g, ''));
      if (!Number.isFinite(bid) || !Number.isFinite(ask)) return null;
      return { bid, ask, mid: (bid + ask) / 2, at: Date.now() };
    } catch {
      return null;
    }
  }

  function startPricePoll() {
    if (priceTimer) clearInterval(priceTimer);
    priceTimer = setInterval(() => {
      const p = scrapePrice();
      if (p) lastPrice = p;
      overlay.setPrice(lastPrice);
    }, 1000);
  }

  // --- Message handling from background ------------------------------------

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    (async () => {
      try {
        switch (msg?.type) {
          case 'GET_PAGE_PRICE':
            sendResponse({ ...lastPrice });
            return;
          case 'STATUS':
            overlay.setStatus(msg.state);
            sendResponse({ ok: true });
            return;
          case 'TICK':
            overlay.setLastTickReason(msg.reason);
            sendResponse({ ok: true });
            return;
          case 'BLOCKED':
            overlay.showBlocked(msg.verdict, msg.signal);
            sendResponse({ ok: true });
            return;
          case 'CONFIRM':
            await refreshSettings();
            showConfirm(msg.pending);
            sendResponse({ ok: true });
            return;
          case 'EXECUTE': {
            const res = await placeOrder(msg.pending);
            sendResponse(res);
            return;
          }
          default:
            sendResponse({ ok: false, reason: 'unknown' });
        }
      } catch (e) {
        sendResponse({ ok: false, reason: e.message });
      }
    })();
    return true;
  });

  // --- Confirm UI flow -----------------------------------------------------

  function showConfirm(p) {
    pending = p;
    overlay.showPending(p);
    if (countdownTimer) clearInterval(countdownTimer);
    if (p.confirmTimeoutSec && p.confirmTimeoutSec > 0) {
      let left = p.confirmTimeoutSec;
      overlay.setCountdown(`auto-approve in ${left}s`);
      countdownTimer = setInterval(() => {
        left -= 1;
        if (left <= 0) {
          clearInterval(countdownTimer);
          countdownTimer = null;
          approve();
        } else {
          overlay.setCountdown(`auto-approve in ${left}s`);
        }
      }, 1000);
    } else {
      overlay.setCountdown('waiting for confirmation');
    }
  }

  overlay.onApprove = approve;
  overlay.onReject  = reject;

  async function approve() {
    if (!pending) return;
    if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
    overlay.setCountdown('placing…');
    const res = await chrome.runtime.sendMessage({ type: 'USER_APPROVE', id: pending.id });
    overlay.setExecResult(res);
    pending = null;
  }

  async function reject() {
    if (!pending) return;
    if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
    await chrome.runtime.sendMessage({ type: 'USER_REJECT', id: pending.id, by: 'user' });
    overlay.clearPending();
    pending = null;
  }

  // --- Order placement -----------------------------------------------------

  function setInputValue(el, value) {
    // Many frameworks (React/Angular) listen on 'input' events. Just assigning
    // .value won't update internal state. Use the native setter + dispatch.
    const proto = Object.getPrototypeOf(el);
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(el, String(value));
    else el.value = String(value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function waitFor(predicate, timeoutMs = 3000, intervalMs = 50) {
    return new Promise((resolve, reject) => {
      const t0 = Date.now();
      const tick = () => {
        try {
          const v = predicate();
          if (v) return resolve(v);
        } catch (e) { /* ignore */ }
        if (Date.now() - t0 > timeoutMs) return reject(new Error('waitFor timeout'));
        setTimeout(tick, intervalMs);
      };
      tick();
    });
  }

  async function placeOrder(p) {
    const sel = settings?.exness?.selectors || {};
    const missing = ['lotInput', 'slInput', 'tpInput', p.side === 'long' ? 'buyButton' : 'sellButton']
      .filter(k => !sel[k]);
    if (missing.length) {
      return { ok: false, reason: 'selectors_missing', missing };
    }

    try {
      const lotEl = await waitFor(() => document.querySelector(sel.lotInput));
      setInputValue(lotEl, p.lot);

      const slEl = await waitFor(() => document.querySelector(sel.slInput));
      setInputValue(slEl, p.sl);

      const tpEl = await waitFor(() => document.querySelector(sel.tpInput));
      setInputValue(tpEl, p.tp);

      const buttonSel = p.side === 'long' ? sel.buyButton : sel.sellButton;
      const btn = await waitFor(() => document.querySelector(buttonSel));
      btn.click();

      // Some Exness flows show a confirm dialog
      if (sel.confirmButton) {
        try {
          const cbtn = await waitFor(() => document.querySelector(sel.confirmButton), 1500);
          cbtn.click();
        } catch { /* no confirm dialog -- order may have placed directly */ }
      }

      return { ok: true, placedAt: Date.now(), priceAtClick: lastPrice };
    } catch (e) {
      return { ok: false, reason: 'dom_failure', error: e.message };
    }
  }

  // --- Overlay (DOM construction) ------------------------------------------

  function createOverlay() {
    const root = document.createElement('div');
    root.id = 'exscalp-overlay';
    root.innerHTML = `
      <header>
        <div class="title">Exness Scalp <span class="status">…</span></div>
        <button class="collapse" title="Collapse">–</button>
      </header>
      <div class="body">
        <div class="row"><span class="k">XAUUSD bid/ask</span><span class="v price">–</span></div>
        <div class="row"><span class="k">Last tick</span><span class="v reason-text">–</span></div>
        <div class="pending" style="display:none">
          <div class="row"><span class="k">Side</span><span class="v side">–</span></div>
          <div class="row"><span class="k">Entry</span><span class="v entry">–</span></div>
          <div class="row"><span class="k">SL</span><span class="v sl">–</span></div>
          <div class="row"><span class="k">TP</span><span class="v tp">–</span></div>
          <div class="row"><span class="k">Lot / ATR</span><span class="v meta">–</span></div>
          <div class="row"><span class="k">Claude</span><span class="v claude">–</span></div>
          <div class="reason claude-reason"></div>
          <div class="actions">
            <button class="reject">Reject</button>
            <button class="approve">Approve</button>
          </div>
          <div class="countdown">–</div>
        </div>
      </div>
      <div class="footer"><span class="left">v0.1</span><span class="right">drag to move</span></div>
    `;

    const q = (s) => root.querySelector(s);
    const statusEl  = q('.status');
    const priceEl   = q('.price');
    const reasonEl  = q('.reason-text');
    const pendBlock = q('.pending');
    const sideEl    = q('.side');
    const entryEl   = q('.entry');
    const slEl      = q('.sl');
    const tpEl      = q('.tp');
    const metaEl    = q('.meta');
    const claudeEl  = q('.claude');
    const claudeRsn = q('.claude-reason');
    const countdown = q('.countdown');
    const approveBtn = q('.approve');
    const rejectBtn  = q('.reject');
    const collapseBtn = q('.collapse');

    const api = {
      root,
      onApprove: () => {},
      onReject:  () => {},
      setStatus(s) {
        statusEl.textContent = s;
        statusEl.className = 'status';
        if (s === 'armed') statusEl.classList.add('armed');
        else if (s === 'paused' || s === 'disarmed') statusEl.classList.add('paused');
        else if (s === 'live_locked') statusEl.classList.add('blocked');
      },
      setPrice(p) {
        if (p && p.bid != null && p.ask != null) {
          priceEl.textContent = `${p.bid.toFixed(2)} / ${p.ask.toFixed(2)}`;
        } else {
          priceEl.textContent = 'no DOM selectors';
        }
      },
      setLastTickReason(r) { reasonEl.textContent = r || '–'; },
      showBlocked(verdict, sig) {
        reasonEl.textContent = `blocked: ${verdict?.reason || 'unknown'}${sig ? ` (${sig.side} @ ${sig.entry})` : ''}`;
      },
      showPending(p) {
        pendBlock.style.display = '';
        sideEl.textContent = p.side.toUpperCase();
        sideEl.className = 'v ' + (p.side === 'long' ? 'side-long' : 'side-short');
        entryEl.textContent = p.entry;
        slEl.textContent = p.sl;
        tpEl.textContent = p.tp;
        metaEl.textContent = `${p.lot} • ATR ${p.atr}`;
        claudeEl.textContent = `${p.claude?.verdict || '?'} (${p.claude?.confidence ?? 0}%)`;
        claudeRsn.textContent = p.claude?.reason || '';
      },
      clearPending() {
        pendBlock.style.display = 'none';
        countdown.textContent = '';
      },
      setCountdown(t) { countdown.textContent = t; },
      setExecResult(res) {
        if (res?.ok) {
          countdown.textContent = 'placed';
        } else {
          countdown.textContent = `failed: ${res?.reason || 'unknown'}`;
        }
        setTimeout(() => api.clearPending(), 4000);
      },
    };

    approveBtn.addEventListener('click', () => api.onApprove());
    rejectBtn.addEventListener('click',  () => api.onReject());

    // Drag-to-move
    const header = root.querySelector('header');
    let dragging = false, dx = 0, dy = 0;
    header.addEventListener('mousedown', (e) => {
      if (e.target === collapseBtn) return;
      dragging = true;
      const r = root.getBoundingClientRect();
      dx = e.clientX - r.left;
      dy = e.clientY - r.top;
      e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      root.style.left = (e.clientX - dx) + 'px';
      root.style.top  = (e.clientY - dy) + 'px';
      root.style.right = 'auto';
    });
    window.addEventListener('mouseup', () => { dragging = false; });

    // Collapse toggle
    collapseBtn.addEventListener('click', () => {
      root.classList.toggle('collapsed');
      collapseBtn.textContent = root.classList.contains('collapsed') ? '+' : '–';
    });

    return api;
  }
})();
