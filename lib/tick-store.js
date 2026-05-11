// In-memory tick ring buffer + 1m OHLC bar builder.
//
// Ticks flow in from the page's WebSocket via realtime-bridge -> background.
// We keep the last MAX_TICKS in memory in the service worker, periodically
// flush to chrome.storage.local so they survive SW termination (Chrome
// reclaims service workers aggressively in MV3).
//
// Bars are built on demand from the ring — bucket each tick by floor(t/60s),
// take first as open, last as close, max as high, min as low, count as
// volume proxy. Bars older than the lookback window are filtered out.

import { trace, traceError } from './trace.js';

const TICK_KEY = 'exscalp_ticks_v1';
const MAX_TICKS = 5000;       // ~17 min at 5 ticks/sec; ~250 KB serialized
const FLUSH_MS = 10_000;      // persist every 10s

let ticks = [];
let loaded = false;
let dirty = false;
let flushTimer = null;

async function ensureLoaded() {
  if (loaded) return;
  try {
    const r = await chrome.storage.local.get(TICK_KEY);
    ticks = Array.isArray(r[TICK_KEY]) ? r[TICK_KEY] : [];
  } catch {
    ticks = [];
  }
  loaded = true;
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(async () => {
    flushTimer = null;
    if (!dirty) return;
    dirty = false;
    try {
      await chrome.storage.local.set({ [TICK_KEY]: ticks });
    } catch (e) {
      traceError('tick_store', 'flush_failed', e);
    }
  }, FLUSH_MS);
}

export async function addTicks(batch) {
  await ensureLoaded();
  if (!Array.isArray(batch) || !batch.length) return;
  for (const t of batch) {
    if (typeof t.b !== 'number' || typeof t.a !== 'number') continue;
    ticks.push({ t: t.t || Date.now(), b: t.b, a: t.a, m: (t.b + t.a) / 2 });
  }
  if (ticks.length > MAX_TICKS) ticks = ticks.slice(-MAX_TICKS);
  dirty = true;
  scheduleFlush();
}

export async function getTickStats() {
  await ensureLoaded();
  return {
    count: ticks.length,
    oldest: ticks[0]?.t || null,
    newest: ticks[ticks.length - 1]?.t || null,
    ageSecs: ticks.length ? Math.floor((Date.now() - ticks[ticks.length - 1].t) / 1000) : null,
    spanMin: ticks.length ? Math.floor((ticks[ticks.length - 1].t - ticks[0].t) / 60000) : 0,
  };
}

export async function getLatestTick() {
  await ensureLoaded();
  return ticks.length ? ticks[ticks.length - 1] : null;
}

// Build 1m OHLC bars from the ring. Returns oldest-first array.
// We bucket by minute boundary so bars align with Yahoo's bar timestamps.
export async function buildBars(minutesBack = 30) {
  await ensureLoaded();
  if (ticks.length < 30) return [];
  const cutoff = Date.now() - minutesBack * 60 * 1000;

  const buckets = new Map();
  for (const t of ticks) {
    if (t.t < cutoff) continue;
    const minute = Math.floor(t.t / 60_000) * 60_000;
    let b = buckets.get(minute);
    if (!b) {
      b = { t: minute, o: t.m, h: t.m, l: t.m, c: t.m, v: 0 };
      buckets.set(minute, b);
    }
    if (t.m > b.h) b.h = t.m;
    if (t.m < b.l) b.l = t.m;
    b.c = t.m;
    b.v += 1;
  }
  return [...buckets.values()].sort((x, y) => x.t - y.t);
}

export async function clearTicks() {
  ticks = [];
  loaded = true;
  dirty = false;
  try {
    await chrome.storage.local.remove(TICK_KEY);
  } catch {}
}
