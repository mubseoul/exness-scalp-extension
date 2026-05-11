// Claude as a veto layer over the deterministic JS breakout signal.
// We ask Claude to look at the candidate trade + recent OHLC and return JSON:
//   { verdict: "go" | "skip", confidence: 0-100, reason: "..." }
// Claude does NOT pick entry/SL/TP — JS already computed those from ATR.
// Claude's job: catch obvious bad context (news event, exhaustion, divergence).

import { callClaudeWeb } from './claude-web.js';
import { trace, traceError } from './trace.js';

const SYSTEM = `You are a disciplined XAUUSD scalp-trade gate. Decision: take the candidate
breakout, or skip it. You don't pick levels — entry/SL/TP are fixed from ATR.
The instrument is gold spot. Trades are 0.01 lot, ~$0.10/pip risk.

DECISION FRAMEWORK — apply these in order and skip on any red flag:

1. HIGHER-TIMEFRAME ALIGNMENT (most important)
   - Look at the 15m bars provided. Determine the 15m trend (up / down / range)
     from the last 6-8 closes.
   - Long breakouts only when 15m is up or ranging. Short breakouts only when
     15m is down or ranging. Counter-trend scalps → skip unless extreme.

2. FALSE-BREAKOUT FILTER
   - Real breakouts have a strong-bodied breakout candle (close in upper/lower
     third of its range, for long/short respectively).
   - If the breakout candle has a long opposite wick (> 50% of its range
     against the direction), call it a probable fakeout → skip.
   - If the prior 2-3 candles already had wicks probing the breakout level and
     reversing, the level is "tested and held against" → skip.

3. SESSION QUALITY
   - The UTC hour is provided. Best hours: London open 07-10 UTC, London/NY
     overlap 12-16 UTC, NY open 13-17 UTC.
   - Avoid: 21-06 UTC (Asian-only thin liquidity), the 60 min before/after
     scheduled USD news (the caller does not yet check news — be conservative
     during NFP-window times: every first Friday 13:30 UTC, CPI ~13:30 UTC).

4. EXHAUSTION / OVEREXTENSION
   - If price has already run > 3× ATR from its 30-bar mean in the breakout
     direction without pullback, chasing is high-risk → skip.
   - If the breakout level is right at a prior session high/low that's been
     tested 3+ times today, expect fade → skip.

5. SPREAD/COMMISSION ECONOMICS
   - The TP is 1.5 × ATR; SL is 1.0 × ATR. R:R is fixed at 1.5.
   - Min ATR for the math to work: $0.50. Below that the spread + $3.50/lot
     commission eats the edge — skip.

6. CONFIDENCE CALIBRATION
   - 80-100: textbook setup, trend-aligned, clean breakout candle, room to run
   - 65-79:  good setup with one minor caveat (slight wick, late in session)
   - 40-64:  marginal — prefer to skip
   - 0-39:   obvious red flag

OUTPUT RULES:
- Respond with VALID JSON ONLY, no prose, no markdown fence.
- "reason" must cite the specific filter that drove the verdict (e.g.
  "counter-trend on 15m", "fakeout — long upper wick", "exhausted, > 3 ATR
  extended", "ATR too tight"). Be concrete; no generic "looks risky".
- If uncertain, prefer skip. Scalping rewards selectivity, not activity.

{"verdict": "go" | "skip", "confidence": 0-100, "reason": "specific phrase"}`;

function compactBars(bars) {
  // Compress to "ts,o,h,l,c" per line to save tokens
  return bars.map(b => {
    const m = new Date(b.t).toISOString().slice(11, 16);
    return `${m},${b.o.toFixed(2)},${b.h.toFixed(2)},${b.l.toFixed(2)},${b.c.toFixed(2)}`;
  }).join('\n');
}

// Aggregate 1m bars into a higher timeframe (e.g. 15m) so Claude can read
// the broader direction. Returns oldest-first.
function aggregate(bars, minutes) {
  if (!bars.length) return [];
  const bucketMs = minutes * 60_000;
  const out = new Map();
  for (const b of bars) {
    const k = Math.floor(b.t / bucketMs) * bucketMs;
    let agg = out.get(k);
    if (!agg) {
      agg = { t: k, o: b.o, h: b.h, l: b.l, c: b.c };
      out.set(k, agg);
    } else {
      if (b.h > agg.h) agg.h = b.h;
      if (b.l < agg.l) agg.l = b.l;
      agg.c = b.c;
    }
  }
  return [...out.values()].sort((x, y) => x.t - y.t);
}

function trendLabel(htf) {
  if (htf.length < 5) return 'insufficient_history';
  const recent = htf.slice(-6);
  const first = recent[0].c, last = recent[recent.length - 1].c;
  const range = Math.max(...recent.map(b => b.h)) - Math.min(...recent.map(b => b.l));
  const drift = last - first;
  if (Math.abs(drift) < range * 0.3) return 'range';
  return drift > 0 ? 'up' : 'down';
}

function sessionLabel(utcHour) {
  if (utcHour >= 0 && utcHour < 7)   return 'Asian (thin)';
  if (utcHour >= 7 && utcHour < 12)  return 'London';
  if (utcHour >= 12 && utcHour < 16) return 'London/NY overlap';
  if (utcHour >= 16 && utcHour < 21) return 'NY';
  return 'Post-NY (thin)';
}

function buildUser(signal, bars) {
  const recent = bars.slice(-30);
  const htf15  = aggregate(bars, 15).slice(-8);
  const utcHour = new Date().getUTCHours();

  // Breakout candle quality — look at the most recent closed bar
  const bc = bars[bars.length - 1];
  const bodyTop = Math.max(bc.o, bc.c);
  const bodyBot = Math.min(bc.o, bc.c);
  const upperWick = bc.h - bodyTop;
  const lowerWick = bodyBot - bc.l;
  const candleRange = Math.max(0.0001, bc.h - bc.l);
  const bodyPct = (bodyTop - bodyBot) / candleRange;
  const opposingWickPct = signal.side === 'long' ? upperWick / candleRange : lowerWick / candleRange;

  return `Candidate trade:
  side:  ${signal.side}
  entry: ${signal.entry}
  SL:    ${signal.sl}   (${signal.side === 'long' ? '-' : '+'}${signal.atr.toFixed(2)} = 1.0 × ATR)
  TP:    ${signal.tp}   (${signal.side === 'long' ? '+' : '-'}${(signal.atr * 1.5).toFixed(2)} = 1.5 × ATR; R:R 1.5)
  ATR(14):       $${signal.atr.toFixed(2)}
  8-min range:   ${signal.range.low} – ${signal.range.high}  (width $${(signal.range.high - signal.range.low).toFixed(2)})
  break strength: ${signal.breakStrengthAtr} × ATR past the level

Breakout candle (last closed 1m):
  O=${bc.o.toFixed(2)} H=${bc.h.toFixed(2)} L=${bc.l.toFixed(2)} C=${bc.c.toFixed(2)}
  body = ${(bodyPct * 100).toFixed(0)}% of range
  opposing wick = ${(opposingWickPct * 100).toFixed(0)}% of range  (>50% = likely fakeout)

Context:
  UTC hour:   ${utcHour}  (${sessionLabel(utcHour)})
  15m trend (last 6 bars): ${trendLabel(htf15)}
  15m HTF bars (UTC,O,H,L,C):
${htf15.map(b => `    ${new Date(b.t).toISOString().slice(11,16)},${b.o.toFixed(2)},${b.h.toFixed(2)},${b.l.toFixed(2)},${b.c.toFixed(2)}`).join('\n')}

Last 30 × 1m bars (UTC,O,H,L,C):
${compactBars(recent)}

Apply the decision framework. Return JSON only.`;
}

function tryParseVerdict(text) {
  // Tolerate stray fences or whitespace around JSON
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]);
    if (j.verdict !== 'go' && j.verdict !== 'skip') return null;
    const conf = Number(j.confidence);
    return {
      verdict: j.verdict,
      confidence: Number.isFinite(conf) ? Math.max(0, Math.min(100, conf)) : 0,
      reason: String(j.reason || '').slice(0, 200),
    };
  } catch {
    return null;
  }
}

// Periodic narration: even when there's no breakout to gate, ask Claude
// for a short read of what the market is doing right now and what would
// trigger a trade. Keeps the on-page panel feeling alive without spamming.
const COMMENTARY_SYSTEM = `You are a disciplined XAUUSD scalp commentator. No breakout signal is
firing right now. In ONE short sentence each:
  - WHY no trade: state what price is actually doing (consolidating, drifting,
    rejecting a level, etc.) and the relevant level/range. Be specific.
  - WHAT triggers: name the concrete price level + direction that would
    activate a long or short setup, in the context of the 15m trend.

Anchor your reasoning to:
  - 15m trend direction (we scalp WITH it).
  - The current 8-min range high/low (the breakout levels).
  - The session: liquid (London/NY) or thin (Asian, post-NY).

No hedging, no emojis. Concrete prices, not vague phrases.
Respond with VALID JSON ONLY:
{"reason": "1 sentence with price levels", "watch": "1 sentence with trigger level"}`;

function compactBarsForCommentary(bars) {
  return bars.slice(-20).map(b => {
    const m = new Date(b.t).toISOString().slice(11, 16);
    return `${m},${b.o.toFixed(2)},${b.h.toFixed(2)},${b.l.toFixed(2)},${b.c.toFixed(2)}`;
  }).join('\n');
}

export async function marketCommentary(bars, { range, atr, lastClose }, { model, timeoutSec }) {
  const htf15 = aggregate(bars, 15).slice(-8);
  const utcHour = new Date().getUTCHours();
  const user = `Current price: ${lastClose?.toFixed(2)}
8-min range:    ${range?.low?.toFixed(2)} – ${range?.high?.toFixed(2)}  (width $${(range?.high - range?.low).toFixed(2)})
ATR(14):        $${atr?.toFixed(2)}
UTC hour:       ${utcHour}  (${sessionLabel(utcHour)})
15m trend:      ${trendLabel(htf15)}

15m HTF bars (UTC,O,H,L,C):
${htf15.map(b => `  ${new Date(b.t).toISOString().slice(11,16)},${b.o.toFixed(2)},${b.h.toFixed(2)},${b.l.toFixed(2)},${b.c.toFixed(2)}`).join('\n')}

Last 20 × 1m bars (UTC,O,H,L,C):
${compactBarsForCommentary(bars)}

Return JSON only.`;

  try {
    const text = await callClaudeWeb({
      system: COMMENTARY_SYSTEM,
      user,
      model: model || null,
      conversationName: `xauusd-commentary-${Date.now()}`,
      timeoutMs: (timeoutSec || 12) * 1000,
    });
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const j = JSON.parse(m[0]);
    return {
      reason: String(j.reason || '').slice(0, 220),
      watch:  String(j.watch  || '').slice(0, 220),
    };
  } catch (e) {
    traceError('claude_trade', 'commentary_failed', e);
    return null;
  }
}

const ZONE_FADE_SYSTEM = `You are a disciplined XAUUSD zone-scalping gate. The candidate is a
ZONE FADE — price wicked into a known support/resistance zone and closed
back out. Decision: take the trade, or skip. Levels are fixed by the
caller (entry at the rejection close, SL 0.5 ATR past the zone, TP 1.5 ATR).

DECISION FRAMEWORK for zone fades — apply in order, skip on any red flag:

1. ZONE QUALITY
   - Strength >= 2 (confluence: PDH+round, asianH+swing, etc.) = strong.
     Strength 1 (single source like a lone round number) = weak, prefer
     skip unless other filters are perfect.
   - Touches today: 0 = best (fresh zone), 1-2 = OK, 3+ should already
     be filtered out by the caller.

2. WICK QUALITY
   - Wick into the zone should be > 30% of the candle range (provided).
     Bigger wick = stronger rejection.
   - Body must be opposing the zone direction (bearish body at resistance,
     bullish body at support). The caller already enforces this.

3. HIGHER-TIMEFRAME ALIGNMENT
   - Best zone fades happen WITH the higher-timeframe trend:
     * Short at resistance is best in a 15m down-trend or range
     * Long at support is best in a 15m up-trend or range
   - Counter-trend fades (long at support during 15m downtrend) often
     break — prefer skip unless wick is very strong AND zone strength >= 3.

4. SESSION
   - Zone fades work best in RANGING / chop conditions (Asian session
     is actually FINE for fades, unlike breakouts).
   - Avoid the 60 min before/after scheduled USD news.

5. EXHAUSTION / TRAP CHECK
   - If the zone was just broken cleanly on a prior bar and price is
     retesting, the "fade" is actually a continuation against you. The
     caller's touch counter helps but not perfectly — look at the bars
     before the wick. If the prior 1-2 bars closed BEYOND the zone (broke
     it) and now we're back inside, this is a failed break / retrace,
     not a fade — skip.

6. SPREAD ECONOMICS
   - Min ATR for the math: $0.50. Below that, skip.

7. CONFIDENCE CALIBRATION
   - 80-100: strong zone (3+ sources), 0 prior touches, with-trend, clean
     rejection wick, no recent break
   - 65-79:  decent zone with one caveat
   - 40-64:  marginal — prefer skip
   - 0-39:   red flag

OUTPUT RULES:
- Respond with VALID JSON ONLY, no prose, no markdown fence.
- "reason" cites the specific filter (e.g. "weak zone, single round number",
  "counter-trend fade, 15m up", "failed-break retrace", "ATR too tight").

{"verdict": "go" | "skip", "confidence": 0-100, "reason": "specific phrase"}`;

function buildZoneFadeUser(signal, bars) {
  const recent = bars.slice(-30);
  const htf15  = aggregate(bars, 15).slice(-8);
  const utcHour = new Date().getUTCHours();
  const z = signal.zone;
  return `Candidate ZONE FADE trade:
  side:   ${signal.side}        (${signal.side === 'long' ? 'fading support' : 'fading resistance'})
  entry:  ${signal.entry}
  SL:     ${signal.sl}   (0.5 × ATR past the zone)
  TP:     ${signal.tp}   (1.5 × ATR from entry; R:R ≈ 3)
  ATR:    $${signal.atr.toFixed(2)}
  wick:   ${(signal.wickPct * 100).toFixed(0)}% of candle range into the zone

Zone:
  ${z.type} band ${z.bottom} – ${z.top}  (center ${z.center})
  sources: [${z.sources.join(', ')}]  (strength ${z.strength})
  touches today: ${z.touchesToday}

Context:
  UTC hour:   ${utcHour}  (${sessionLabel(utcHour)})
  15m trend:  ${trendLabel(htf15)}
  15m HTF bars (UTC,O,H,L,C):
${htf15.map(b => `    ${new Date(b.t).toISOString().slice(11,16)},${b.o.toFixed(2)},${b.h.toFixed(2)},${b.l.toFixed(2)},${b.c.toFixed(2)}`).join('\n')}

Last 30 × 1m bars (UTC,O,H,L,C):
${compactBars(recent)}

Apply the zone-fade decision framework. Return JSON only.`;
}

export async function vetoOrApprove(signal, bars, { model, timeoutSec }) {
  const t0 = Date.now();
  try {
    const isFade = signal.strategy === 'zone_fade';
    const text = await callClaudeWeb({
      system: isFade ? ZONE_FADE_SYSTEM : SYSTEM,
      user: isFade ? buildZoneFadeUser(signal, bars) : buildUser(signal, bars),
      model: model || null,
      conversationName: `xauusd-${isFade ? 'zonefade' : 'breakout'}-${signal.side}-${Date.now()}`,
      timeoutMs: (timeoutSec || 12) * 1000,
    });
    const v = tryParseVerdict(text);
    if (!v) {
      trace('claude_trade', 'unparseable', { textHead: text.slice(0, 200) });
      return { verdict: 'skip', confidence: 0, reason: 'unparseable_response', tookMs: Date.now() - t0 };
    }
    trace('claude_trade', 'verdict', { ...v, tookMs: Date.now() - t0 });
    return { ...v, tookMs: Date.now() - t0 };
  } catch (e) {
    traceError('claude_trade', 'failed', e);
    return { verdict: 'skip', confidence: 0, reason: `claude_error: ${e.message}`, tookMs: Date.now() - t0 };
  }
}
