// Deterministic breakout detector for XAUUSD scalp.
// Inputs:  array of 1m OHLC bars (oldest -> newest), recent N bars
// Outputs: null (no signal) OR { side, entry, sl, tp, range, atr, reason }
//
// Strategy (momentum breakout):
//   1. Define the "range" from the last `rangeMinutes` bars BEFORE the current bar.
//   2. ATR(14) on closed bars.
//   3. If the most recent CLOSED bar's close is above range.high by >= breakoutAtrMult * ATR
//      -> long. Symmetric for shorts below range.low.
//   4. SL = entry - slAtrMult*ATR (long) / entry + slAtrMult*ATR (short).
//   5. TP = entry + tpAtrMult*ATR (long) / entry - tpAtrMult*ATR (short).
//   6. Skip if ATR < minAtrUsd (range too tight) or session filter excludes now.

function trueRange(prev, cur) {
  const a = cur.h - cur.l;
  const b = Math.abs(cur.h - prev.c);
  const d = Math.abs(cur.l - prev.c);
  return Math.max(a, b, d);
}

export function atr(bars, period = 14) {
  if (bars.length < period + 1) return null;
  const trs = [];
  for (let i = bars.length - period; i < bars.length; i++) {
    trs.push(trueRange(bars[i - 1], bars[i]));
  }
  return trs.reduce((a, b) => a + b, 0) / period;
}

function rangeOf(bars) {
  let hi = -Infinity, lo = Infinity;
  for (const b of bars) {
    if (b.h > hi) hi = b.h;
    if (b.l < lo) lo = b.l;
  }
  return { high: hi, low: lo };
}

function inSession(nowUtcHour, sessionHours) {
  if (!Array.isArray(sessionHours) || sessionHours.length === 0) return true;
  return sessionHours.some(w => nowUtcHour >= w.from && nowUtcHour < w.to);
}

export function detectBreakout(bars, cfg) {
  const {
    rangeMinutes,
    breakoutAtrMult,
    minAtrUsd,
    tpAtrMult,
    slAtrMult,
    sessionUtcHours,
  } = cfg;

  if (!Array.isArray(bars) || bars.length < rangeMinutes + 20) {
    return { signal: null, reason: 'insufficient_bars', barCount: bars?.length || 0 };
  }

  const nowUtcHour = new Date().getUTCHours();
  if (!inSession(nowUtcHour, sessionUtcHours)) {
    return { signal: null, reason: 'out_of_session', utcHour: nowUtcHour };
  }

  // Use the most recent CLOSED bar for the breakout check, so we wait for
  // confirmation rather than chasing intra-bar spikes.
  const closed = bars[bars.length - 1];
  const rangeBars = bars.slice(-1 - rangeMinutes, -1);
  if (rangeBars.length < rangeMinutes) {
    return { signal: null, reason: 'insufficient_range_bars' };
  }
  const range = rangeOf(rangeBars);
  const atrVal = atr(bars.slice(0, -1), 14);
  if (atrVal == null || atrVal < minAtrUsd) {
    return { signal: null, reason: 'low_atr', atr: atrVal };
  }

  const upBreak  = closed.c > range.high + breakoutAtrMult * atrVal;
  const dnBreak  = closed.c < range.low  - breakoutAtrMult * atrVal;

  if (!upBreak && !dnBreak) {
    return {
      signal: null,
      reason: 'no_break',
      close: closed.c,
      range,
      atr: atrVal,
    };
  }

  const side = upBreak ? 'long' : 'short';
  const entry = closed.c;
  const sl = side === 'long' ? entry - slAtrMult * atrVal : entry + slAtrMult * atrVal;
  const tp = side === 'long' ? entry + tpAtrMult * atrVal : entry - tpAtrMult * atrVal;
  const moveUsd = side === 'long' ? entry - range.high : range.low - entry;
  const moveAtr = moveUsd / atrVal;

  return {
    signal: {
      side,
      entry: round2(entry),
      sl: round2(sl),
      tp: round2(tp),
      atr: round2(atrVal),
      range: { high: round2(range.high), low: round2(range.low) },
      breakStrengthAtr: round3(moveAtr),
      barTs: closed.t,
    },
    reason: 'breakout',
  };
}

function round2(n) { return Math.round(n * 100) / 100; }
function round3(n) { return Math.round(n * 1000) / 1000; }
