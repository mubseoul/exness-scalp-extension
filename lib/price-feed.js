// OHLC bars from Yahoo Finance. Service-worker fetch works directly because
// the manifest declares host_permissions for query{1,2}.finance.yahoo.com.
//
// We use GC=F (gold futures front-month) as the default — it has reliable 1m
// intraday data. XAUUSD=X (spot) is the fallback. Tracks XAUUSD spot within
// ~$0.30 during regular hours.

import { trace, traceError } from './trace.js';

const HOSTS = ['https://query1.finance.yahoo.com', 'https://query2.finance.yahoo.com'];

export async function fetchBars(symbol, interval = '1m', rangeMinutes = 60) {
  // Yahoo's chart endpoint accepts 'range' as a duration (1d, 5d) but for
  // 1m bars it caps at 7 days and minimum-window 1d. Always request 1d.
  const url = (host) =>
    `${host}/v7/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&range=1d&includePrePost=true`;

  let lastErr;
  for (const host of HOSTS) {
    try {
      const res = await fetch(url(host), { credentials: 'omit' });
      if (!res.ok) {
        lastErr = new Error(`Yahoo ${host} HTTP ${res.status}`);
        continue;
      }
      const json = await res.json();
      const result = json?.chart?.result?.[0];
      if (!result) {
        lastErr = new Error(`Yahoo ${host} empty result`);
        continue;
      }
      const ts = result.timestamp || [];
      const q = result.indicators?.quote?.[0] || {};
      const bars = [];
      for (let i = 0; i < ts.length; i++) {
        const o = q.open?.[i], h = q.high?.[i], l = q.low?.[i], c = q.close?.[i], v = q.volume?.[i];
        if (o == null || h == null || l == null || c == null) continue;
        bars.push({ t: ts[i] * 1000, o, h, l, c, v: v || 0 });
      }
      const trimmedFrom = Math.max(0, bars.length - Math.ceil(rangeMinutes * 1.5));
      const sliced = bars.slice(trimmedFrom);
      return { symbol, interval, bars: sliced, fetchedAt: Date.now() };
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('Yahoo fetch failed');
}

export async function fetchBarsWithFallback(primary, fallback, interval, rangeMinutes) {
  try {
    const r = await fetchBars(primary, interval, rangeMinutes);
    if (r.bars.length >= 10) return r;
    trace('price_feed', 'primary_thin', { primary, count: r.bars.length });
  } catch (e) {
    traceError('price_feed', 'primary_failed', e, { primary });
  }
  return fetchBars(fallback, interval, rangeMinutes);
}

// Cross-check: extension price feed (Yahoo) vs Exness DOM price (delivered
// from content script). Returns { ok, deltaUsd, reason } — we refuse to trade
// if the two diverge beyond `maxSpreadUsd`.
export function crossCheck(yahooClose, exnessPrice, maxSpreadUsd = 2.0) {
  if (yahooClose == null || exnessPrice == null) {
    return { ok: false, deltaUsd: null, reason: 'missing_price' };
  }
  const deltaUsd = Math.abs(yahooClose - exnessPrice);
  if (deltaUsd > maxSpreadUsd) {
    return { ok: false, deltaUsd, reason: 'diverged' };
  }
  return { ok: true, deltaUsd, reason: 'ok' };
}
