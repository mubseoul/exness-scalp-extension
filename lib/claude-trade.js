// Claude as a veto layer over the deterministic JS breakout signal.
// We ask Claude to look at the candidate trade + recent OHLC and return JSON:
//   { verdict: "go" | "skip", confidence: 0-100, reason: "..." }
// Claude does NOT pick entry/SL/TP — JS already computed those from ATR.
// Claude's job: catch obvious bad context (news event, exhaustion, divergence).

import { callClaudeWeb } from './claude-web.js';
import { trace, traceError } from './trace.js';

const SYSTEM = `You are a scalp-trade gate. You receive a candidate XAUUSD breakout trade
and the last 30 one-minute bars. Decide ONLY whether to take the trade or skip it.

Rules:
- You do NOT propose entry, SL, or TP. Those are fixed by the caller from ATR.
- "go" means the setup looks clean. "skip" means there is a real reason to pass
  (exhaustion, obvious fakeout, divergence vs higher-timeframe trend visible in
  the bars, end-of-session drift, etc).
- If you are uncertain, prefer "skip". Scalping rewards selectivity.
- Confidence 0–100 reflects how strongly you believe the verdict.

Respond with VALID JSON ONLY, no prose, no markdown fence:
{"verdict": "go" | "skip", "confidence": 0-100, "reason": "short phrase"}`;

function compactBars(bars) {
  // Compress to "ts,o,h,l,c" per line to save tokens
  return bars.map(b => {
    const m = new Date(b.t).toISOString().slice(11, 16);
    return `${m},${b.o.toFixed(2)},${b.h.toFixed(2)},${b.l.toFixed(2)},${b.c.toFixed(2)}`;
  }).join('\n');
}

function buildUser(signal, bars) {
  const recent = bars.slice(-30);
  return `Candidate trade:
  side:  ${signal.side}
  entry: ${signal.entry}
  sl:    ${signal.sl}   (${signal.side === 'long' ? '-' : '+'}${(signal.atr).toFixed(2)})
  tp:    ${signal.tp}   (${signal.side === 'long' ? '+' : '-'}${(signal.atr * 1.5).toFixed(2)})
  atr:   ${signal.atr}
  range: high=${signal.range.high} low=${signal.range.low}
  breakStrengthAtr: ${signal.breakStrengthAtr}

Last 30 bars (UTC time, O, H, L, C):
${compactBars(recent)}

Return JSON only.`;
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

export async function vetoOrApprove(signal, bars, { model, timeoutSec }) {
  const t0 = Date.now();
  try {
    const text = await callClaudeWeb({
      system: SYSTEM,
      user: buildUser(signal, bars),
      model: model || null,
      conversationName: `xauusd-scalp-${signal.side}-${Date.now()}`,
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
