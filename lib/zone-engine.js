// Zone scalping engine: identify support/resistance zones from multiple
// timeframes and detect fades (rejections) at those zones.
//
// Zones are PRICE BANDS, not single levels — width = 0.3 * ATR. We pull from:
//   * PDH / PDL          — strongest, anchors the day
//   * Asian session H/L  — boundary of overnight chop
//   * Round numbers      — $5 increments (psychological levels for gold)
//   * 4H swing pivots    — local highs/lows from higher TF
//
// Confluence: when 2+ zones land within 0.3 * ATR, they merge into one
// stronger zone. Strength = source count.
//
// A "zone fade" fires when the most recent CLOSED 1m bar:
//   1. wicked into a zone (touched within the band)
//   2. closed back outside the band
//   3. wick depth > 30% of candle range
//   4. opposing body — bullish for support fade, bearish for resistance fade
//   5. zone has been touched <= 2 times today (3rd retest usually breaks)

const ATR_PERIOD = 14;
const ZONE_WIDTH_ATR_MULT = 0.3;
const MIN_WICK_PCT = 0.30;
const MAX_PRIOR_TOUCHES = 2;
const ROUND_INCREMENT = 5;

function trueRange(prev, cur) {
  return Math.max(cur.h - cur.l, Math.abs(cur.h - prev.c), Math.abs(cur.l - prev.c));
}

function atr14(bars) {
  if (bars.length < ATR_PERIOD + 1) return null;
  let sum = 0;
  for (let i = bars.length - ATR_PERIOD; i < bars.length; i++) {
    sum += trueRange(bars[i - 1], bars[i]);
  }
  return sum / ATR_PERIOD;
}

function roundLevels(price, range = 25) {
  const lo = Math.floor((price - range) / ROUND_INCREMENT) * ROUND_INCREMENT;
  const hi = Math.ceil((price + range) / ROUND_INCREMENT) * ROUND_INCREMENT;
  const out = [];
  for (let p = lo; p <= hi; p += ROUND_INCREMENT) out.push(p);
  return out;
}

// Find local high/low pivots in a series. A bar is a pivot high if its h
// is greater than the surrounding `look` bars on each side.
function swingPivots(bars, look = 3) {
  const highs = [], lows = [];
  for (let i = look; i < bars.length - look; i++) {
    let isHigh = true, isLow = true;
    for (let k = 1; k <= look; k++) {
      if (bars[i - k].h >= bars[i].h || bars[i + k].h >= bars[i].h) isHigh = false;
      if (bars[i - k].l <= bars[i].l || bars[i + k].l <= bars[i].l) isLow = false;
    }
    if (isHigh) highs.push(bars[i].h);
    if (isLow)  lows.push(bars[i].l);
  }
  return { highs, lows };
}

function utcStartOfDay(ts) {
  const d = new Date(ts);
  d.setUTCHours(0, 0, 0, 0);
  return d.getTime();
}

// Compute the canonical zone set given:
//   bars1m      — recent 1m bars (for current price, ATR, Asian H/L)
//   dailyBars   — recent daily candles (for PDH/PDL)
//   bars4h      — recent 4h candles (for swing pivots)
export function computeZones({ bars1m, dailyBars, bars4h }) {
  if (!bars1m?.length) return { zones: [], atr: null };
  const last = bars1m[bars1m.length - 1];
  const atr = atr14(bars1m) || 1;
  const halfWidth = atr * ZONE_WIDTH_ATR_MULT / 2;
  const candidates = [];

  // PDH / PDL — yesterday's daily candle
  if (dailyBars && dailyBars.length >= 2) {
    const yest = dailyBars[dailyBars.length - 2];
    candidates.push({ price: yest.h, source: 'PDH', type: 'resistance' });
    candidates.push({ price: yest.l, source: 'PDL', type: 'support' });
  }

  // Asian session H/L — bars from 00:00 UTC to 07:00 UTC of current UTC day
  const todayStart = utcStartOfDay(Date.now());
  const asianEnd = todayStart + 7 * 60 * 60 * 1000;
  const asianBars = bars1m.filter(b => b.t >= todayStart && b.t < asianEnd);
  if (asianBars.length >= 30) {
    const ah = Math.max(...asianBars.map(b => b.h));
    const al = Math.min(...asianBars.map(b => b.l));
    candidates.push({ price: ah, source: 'asianH', type: 'resistance' });
    candidates.push({ price: al, source: 'asianL', type: 'support' });
  }

  // Round numbers within ±$25 of current price
  for (const r of roundLevels(last.c, 25)) {
    candidates.push({
      price: r,
      source: 'round',
      type: r >= last.c ? 'resistance' : 'support',
    });
  }

  // 4H swing pivots
  if (bars4h && bars4h.length >= 7) {
    const { highs, lows } = swingPivots(bars4h.slice(-30), 2);
    for (const h of highs.slice(-5)) {
      if (h > last.c) candidates.push({ price: h, source: 'swing4hH', type: 'resistance' });
    }
    for (const l of lows.slice(-5)) {
      if (l < last.c) candidates.push({ price: l, source: 'swing4hL', type: 'support' });
    }
  }

  // Merge candidates within 0.3 * ATR into a single zone (confluence boost)
  candidates.sort((a, b) => a.price - b.price);
  const merged = [];
  for (const c of candidates) {
    const last = merged[merged.length - 1];
    if (last && Math.abs(c.price - last.center) < halfWidth * 2 && c.type === last.type) {
      // Merge: average price, accumulate sources
      last.center = (last.center * last.sources.length + c.price) / (last.sources.length + 1);
      last.sources.push(c.source);
    } else {
      merged.push({
        center: c.price,
        type: c.type,
        sources: [c.source],
      });
    }
  }

  // Finalize zone band + strength
  const zones = merged.map(z => ({
    top: round2(z.center + halfWidth),
    bottom: round2(z.center - halfWidth),
    center: round2(z.center),
    type: z.type,
    sources: z.sources,
    strength: z.sources.length, // 1+ confluences = stronger
    touchesToday: countTouches(bars1m, z.center, halfWidth, todayStart),
  }));

  return { zones, atr };
}

function countTouches(bars1m, center, halfWidth, sinceTs) {
  // A "touch" is a bar whose wick (high or low) entered the zone band.
  let count = 0;
  let inside = false;
  for (const b of bars1m) {
    if (b.t < sinceTs) continue;
    const hit = b.h >= (center - halfWidth) && b.l <= (center + halfWidth);
    if (hit && !inside) { count++; inside = true; }
    if (!hit) inside = false;
  }
  return count;
}

// Detect zone fade on the most recently closed bar. Returns null if no setup.
export function detectZoneFade(bars1m, zones, atr) {
  if (!bars1m?.length || !zones?.length || !atr) return { signal: null, reason: 'no_data' };

  const bar = bars1m[bars1m.length - 1];
  const range = Math.max(0.0001, bar.h - bar.l);
  const bodyTop = Math.max(bar.o, bar.c);
  const bodyBot = Math.min(bar.o, bar.c);
  const upperWick = bar.h - bodyTop;
  const lowerWick = bodyBot - bar.l;
  const bullishBody = bar.c > bar.o;
  const bearishBody = bar.c < bar.o;

  // Resistance fade (short): bar wicked up into a resistance zone, closed back below
  for (const z of zones.filter(z => z.type === 'resistance')) {
    if (z.touchesToday > MAX_PRIOR_TOUCHES) continue;
    const wickedIn = bar.h >= z.bottom && bar.h <= z.top + atr * 0.5;
    const closedBelow = bar.c < z.bottom;
    const wickPct = upperWick / range;
    if (wickedIn && closedBelow && wickPct >= MIN_WICK_PCT && bearishBody) {
      const entry = round2(bar.c);
      const sl = round2(z.top + 0.5 * atr);
      const tp = round2(entry - 1.5 * atr);
      return {
        signal: {
          side: 'short',
          entry, sl, tp,
          atr: round2(atr),
          zone: { top: z.top, bottom: z.bottom, center: z.center, type: z.type, sources: z.sources, strength: z.strength, touchesToday: z.touchesToday },
          wickPct: round3(wickPct),
          barTs: bar.t,
          strategy: 'zone_fade',
        },
        reason: 'resistance_fade',
      };
    }
  }

  // Support fade (long): bar wicked down into a support zone, closed back above
  for (const z of zones.filter(z => z.type === 'support')) {
    if (z.touchesToday > MAX_PRIOR_TOUCHES) continue;
    const wickedIn = bar.l <= z.top && bar.l >= z.bottom - atr * 0.5;
    const closedAbove = bar.c > z.top;
    const wickPct = lowerWick / range;
    if (wickedIn && closedAbove && wickPct >= MIN_WICK_PCT && bullishBody) {
      const entry = round2(bar.c);
      const sl = round2(z.bottom - 0.5 * atr);
      const tp = round2(entry + 1.5 * atr);
      return {
        signal: {
          side: 'long',
          entry, sl, tp,
          atr: round2(atr),
          zone: { top: z.top, bottom: z.bottom, center: z.center, type: z.type, sources: z.sources, strength: z.strength, touchesToday: z.touchesToday },
          wickPct: round3(wickPct),
          barTs: bar.t,
          strategy: 'zone_fade',
        },
        reason: 'support_fade',
      };
    }
  }

  // Build a useful "near zone" message for the AI feed when nothing triggered
  const near = nearestZone(bars1m[bars1m.length - 1].c, zones);
  return { signal: null, reason: 'no_fade', near };
}

function nearestZone(price, zones) {
  if (!zones.length) return null;
  let best = zones[0], bestDist = Math.abs(zones[0].center - price);
  for (const z of zones) {
    const d = Math.abs(z.center - price);
    if (d < bestDist) { best = z; bestDist = d; }
  }
  return { ...best, distance: round2(bestDist) };
}

function round2(n) { return Math.round(n * 100) / 100; }
function round3(n) { return Math.round(n * 1000) / 1000; }
