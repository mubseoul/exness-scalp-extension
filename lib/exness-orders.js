// Direct order placement via Exness's REST API — same endpoint the page's
// own Confirm button hits. Bypasses fragile DOM clicks entirely.
//
// Endpoint (captured from realtime-hook):
//   POST https://rtapi-dx.exweb.mobi/rtapi/mt5/{trial}/v1/accounts/{id}/orders
//   Headers: Authorization: Bearer ..., Content-Type: application/json
//   Body (guessed — Exness MT5 REST is loosely documented; iterate from
//   the response code if the first try fails):
//     {
//       "instrument": "XAUUSDr",
//       "type": "BUY" | "SELL" | "BUY_LIMIT" | "SELL_LIMIT" | "BUY_STOP" | "SELL_STOP",
//       "volume": 0.01,
//       "stop_loss": 4669.50,
//       "take_profit": 4671.50,
//       "price": 4670.50,            // only for non-market types
//       "deviation": 100              // max slippage in points
//     }
//
// Runs in the Exness tab's MAIN world so it inherits cookies + uses the
// JWT we sniffed in realtime-hook.

import { trace, traceError } from './trace.js';

const TRIAL = 'trial15';

export async function placeMarketOrder({ tabId, accountId, instrument = 'XAUUSDr', side, volume, stopLoss, takeProfit }) {
  if (!tabId)     throw new Error('placeMarketOrder: tabId required');
  if (!accountId) throw new Error('placeMarketOrder: accountId required');
  if (!side)      throw new Error('placeMarketOrder: side required (long/short)');

  const url = `https://rtapi-dx.exweb.mobi/rtapi/mt5/${TRIAL}/v1/accounts/${accountId}/orders`;
  const type = side === 'long' ? 'BUY' : 'SELL';
  const body = {
    instrument,
    type,
    volume,
    stop_loss: stopLoss,
    take_profit: takeProfit,
    deviation: 100,
  };

  trace('exness_orders', 'placing', { side, volume, instrument, hasSL: stopLoss != null, hasTP: takeProfit != null });

  let results;
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: async (u, b) => {
        try {
          const auth = window.__exscalpAuthHeader;
          if (!auth) return { ok: false, status: 0, text: 'no_auth_header', noAuth: true };
          const res = await fetch(u, {
            method: 'POST',
            credentials: 'include',
            headers: { 'Authorization': auth, 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: JSON.stringify(b),
          });
          const text = await res.text();
          return { ok: res.ok, status: res.status, text };
        } catch (e) {
          return { ok: false, status: 0, text: String(e?.message || e) };
        }
      },
      args: [url, body],
    });
  } catch (e) {
    traceError('exness_orders', 'execute_script_failed', e);
    return { ok: false, reason: 'execute_script_failed', error: e.message };
  }

  const r = results?.[0]?.result;
  if (!r) return { ok: false, reason: 'no_result' };

  if (!r.ok) {
    if (r.noAuth) return { ok: false, reason: 'no_auth_yet', hint: 'reload Exness tab, wait 5s, retry' };
    traceError('exness_orders', 'http_error', null, { status: r.status, body: r.text.slice(0, 400) });
    return { ok: false, reason: `http_${r.status}`, error: r.text.slice(0, 400) };
  }

  let parsed = null;
  try { parsed = JSON.parse(r.text); } catch {}
  trace('exness_orders', 'placed', { status: r.status, parsed });
  return { ok: true, response: parsed, raw: r.text };
}

// Move SL on an open position. Endpoint is a best-guess based on the
// existing /close pattern: PUT /positions/{id} with the new levels.
// If Exness wants a different shape we'll see the error in the trace
// and iterate.
export async function modifyPositionSl({ tabId, accountId, positionId, stopLoss, takeProfit }) {
  if (!tabId || !accountId || !positionId) throw new Error('modifyPositionSl: all args required');
  const url = `https://rtapi-dx.exweb.mobi/rtapi/mt5/${TRIAL}/v2/accounts/${accountId}/positions/${positionId}`;
  const body = {};
  if (typeof stopLoss   === 'number') body.stop_loss   = stopLoss;
  if (typeof takeProfit === 'number') body.take_profit = takeProfit;

  trace('exness_orders', 'modify_attempt', { positionId, body });

  const results = await chrome.scripting.executeScript({
    target: { tabId }, world: 'MAIN',
    func: async (u, b) => {
      const auth = window.__exscalpAuthHeader;
      if (!auth) return { ok: false, status: 0, text: 'no_auth' };
      const res = await fetch(u, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Authorization': auth, 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify(b),
      });
      return { ok: res.ok, status: res.status, text: await res.text() };
    },
    args: [url, body],
  });
  const r = results?.[0]?.result;
  if (!r?.ok) {
    traceError('exness_orders', 'modify_failed', null, { status: r?.status, text: (r?.text || '').slice(0, 300) });
    return { ok: false, status: r?.status, error: r?.text };
  }
  trace('exness_orders', 'modify_ok', { positionId });
  return { ok: true, response: r.text };
}

export async function closePosition({ tabId, accountId, positionId }) {
  if (!tabId || !accountId || !positionId) throw new Error('closePosition: all args required');
  const url = `https://rtapi-dx.exweb.mobi/rtapi/mt5/${TRIAL}/v2/accounts/${accountId}/positions/${positionId}/close`;
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: async (u) => {
      const auth = window.__exscalpAuthHeader;
      if (!auth) return { ok: false, status: 0, text: 'no_auth' };
      const res = await fetch(u, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Authorization': auth, 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({ deviation: 100 }),
      });
      return { ok: res.ok, status: res.status, text: await res.text() };
    },
    args: [url],
  });
  const r = results?.[0]?.result;
  return r;
}
