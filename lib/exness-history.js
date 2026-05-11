// Historical 1m XAUUSDr candles via Exness's MT5 REST API.
//
// Endpoint discovered through realtime-hook HTTP capture:
//   https://rtapi-dx.exweb.mobi/rtapi/mt5/trial15/v2/accounts/{accountId}/
//     instruments/XAUUSDr/candles?time_frame=1&from=9007199254740991&count=-N&price=bid
//
// time_frame: 1=1m, 30=30m, 60=1h, 120=2h, 240=4h, 1440=1d
// from:       epoch ms; Number.MAX_SAFE_INTEGER means "most recent"
// count:      negative = N bars backwards from `from`
// price:      "bid" or "ask"
//
// The endpoint requires cookies set by the user's login session on
// my.exness.global. Calling it from the service worker directly (no cookies,
// wrong Origin) returns 401. Same pattern as claude-web.js — we execute the
// fetch inside the page's MAIN world via chrome.scripting.executeScript so
// the request inherits the user's authenticated session.

import { trace, traceError } from './trace.js';

const TRIAL = 'trial15';   // discovered in URL; could be different per-account

export async function fetchExnessCandles({ tabId, accountId, symbol = 'XAUUSDr', timeFrameMin = 1, count = 200, price = 'bid' }) {
  if (!tabId)     throw new Error('fetchExnessCandles: tabId required');
  if (!accountId) throw new Error('fetchExnessCandles: accountId required');

  const url = `https://rtapi-dx.exweb.mobi/rtapi/mt5/${TRIAL}/v2/accounts/${accountId}`
            + `/instruments/${symbol}/candles?time_frame=${timeFrameMin}`
            + `&from=9007199254740991&count=-${count}&price=${price}`;

  const t0 = Date.now();
  let results;
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: async (u) => {
        try {
          const res = await fetch(u, { credentials: 'include' });
          const text = await res.text();
          return { ok: res.ok, status: res.status, text };
        } catch (e) {
          return { ok: false, status: 0, text: String(e?.message || e) };
        }
      },
      args: [url],
    });
  } catch (e) {
    traceError('exness_history', 'execute_script_failed', e);
    return null;
  }

  const r = results?.[0]?.result;
  if (!r || !r.ok) {
    traceError('exness_history', 'fetch_failed', null, { status: r?.status, head: (r?.text || '').slice(0, 150) });
    return null;
  }
  let data;
  try { data = JSON.parse(r.text); }
  catch (e) {
    traceError('exness_history', 'parse_failed', e, { head: r.text.slice(0, 150) });
    return null;
  }
  const bars = Array.isArray(data?.price_history) ? data.price_history : null;
  if (!bars) {
    trace('exness_history', 'no_price_history', { keys: Object.keys(data || {}) });
    return null;
  }
  trace('exness_history', 'fetched', {
    symbol, timeFrameMin, count: bars.length,
    firstTs: bars[0]?.t, lastTs: bars[bars.length - 1]?.t,
    tookMs: Date.now() - t0,
  });
  return bars;
}

// Convert bars into synthetic ticks (one per bar's close) so we can feed the
// existing tick-store and let buildBars re-bucket them. Loses intra-minute
// detail but signal engine only looks at 1m OHLC anyway.
export function barsToSyntheticTicks(bars) {
  if (!Array.isArray(bars)) return [];
  return bars.map(b => ({ t: b.t, b: b.c, a: b.c }));
}
