// Orchestrator: poll Yahoo for bars -> detectBreakout -> risk gate -> Claude
// veto -> dispatch to content script overlay -> on user-approval, run the
// order-execution script in the Exness tab.
//
// Why poll from the service worker:
//  - It's authoritative across multiple tabs (only one signal at a time).
//  - The content script runs only when an Exness tab is open; the SW runs
//    whenever the extension is installed.

import { getSettings, pushHistory, updateState, saveSettings } from './lib/storage.js';
import { trace, traceError } from './lib/trace.js';
import { fetchBarsWithFallback } from './lib/price-feed.js';
import { detectBreakout } from './lib/signal-engine.js';
import { computeZones, detectZoneFade } from './lib/zone-engine.js';
import { vetoOrApprove, marketCommentary } from './lib/claude-trade.js';
import { assess, recordSignalAccepted, detectAccountType, classifyAccountFromApi } from './lib/risk-manager.js';
import { LIVE_UNLOCK_PHRASE, DEFAULTS } from './lib/defaults.js';
import { addTicks, buildBars, getTickStats, getLatestTick } from './lib/tick-store.js';
import { fetchExnessCandles, barsToSyntheticTicks } from './lib/exness-history.js';

const ALARM_NAME = 'exscalp_poll';

chrome.runtime.onInstalled.addListener(async () => {
  await migrateSelectorsIfNeeded();
  await ensureAlarm();
  trace('lifecycle', 'installed', { version: chrome.runtime.getManifest().version });
});

chrome.runtime.onStartup.addListener(async () => {
  await migrateSelectorsIfNeeded();
  await ensureAlarm();
  trace('lifecycle', 'startup', {});
});

// deepMerge preserves stored user values over new defaults. v0.1 stored
// nulls for every selector, so the v0.2 defaults wouldn't take effect on
// upgrade. Backfill any null selector from defaults — but ONLY if the user
// has never run calibration (calibratedAt = null).
async function migrateSelectorsIfNeeded() {
  const s = await getSettings();
  if (s.exness.calibratedAt) return;
  const cur = s.exness.selectors || {};
  const def = DEFAULTS.exness.selectors;
  const patched = {};
  let changed = false;
  for (const k of Object.keys(def)) {
    if (cur[k] == null && def[k] != null) {
      patched[k] = def[k];
      changed = true;
    } else {
      patched[k] = cur[k];
    }
  }
  if (changed) {
    await saveSettings({ exness: { selectors: patched } });
    trace('lifecycle', 'selectors_backfilled', { keys: Object.keys(patched).filter(k => cur[k] == null && def[k] != null) });
  }
}

async function ensureAlarm() {
  const s = await getSettings();
  const periodMin = Math.max(0.5, Math.round((s.signal.pollEverySec / 60) * 10) / 10);
  await chrome.alarms.clear(ALARM_NAME);
  await chrome.alarms.create(ALARM_NAME, { periodInMinutes: periodMin });
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM_NAME) return;
  try {
    await runCycle();
  } catch (e) {
    traceError('cycle', 'unhandled', e);
  }
});

// Find an Exness webtrading tab (live or demo).
async function findExnessTab() {
  const tabs = await chrome.tabs.query({
    url: [
      'https://my.exness.global/webtrading/*',
      'https://my.exness.com/webtrading/*',
    ],
  });
  // prefer active+focused; otherwise first
  const active = tabs.find(t => t.active);
  return active || tabs[0] || null;
}

async function sendToContent(tabId, msg) {
  try {
    return await chrome.tabs.sendMessage(tabId, msg);
  } catch (e) {
    traceError('bg', 'sendMessage_failed', e, { type: msg?.type });
    return null;
  }
}

async function broadcastCommentary(tabId, entry) {
  return sendToContent(tabId, { type: 'AI_FEED', entry: { ...entry, at: Date.now() } });
}

async function maybeNarrateMarket(tabId, bars, s) {
  if (!s.claude.enabled) return;
  const everyMin = s.claude.commentaryEveryMin || 5;
  const cur = await getSettings();
  const lastAt = cur.state.lastCommentaryAt || 0;
  if (Date.now() - lastAt < everyMin * 60 * 1000) return;
  // Need enough bars + a meaningful range to talk about
  if (bars.length < s.signal.rangeMinutes + 16) return;
  const rangeBars = bars.slice(-1 - s.signal.rangeMinutes, -1);
  const range = {
    high: Math.max(...rangeBars.map(b => b.h)),
    low:  Math.min(...rangeBars.map(b => b.l)),
  };
  const closed = bars[bars.length - 1];
  // Quick ATR(14) for the prompt
  let atr = 0;
  for (let i = bars.length - 14; i < bars.length; i++) {
    const cur = bars[i], prev = bars[i - 1];
    if (!prev) continue;
    atr += Math.max(cur.h - cur.l, Math.abs(cur.h - prev.c), Math.abs(cur.l - prev.c));
  }
  atr /= 14;

  await updateState({ lastCommentaryAt: Date.now() });
  const note = await marketCommentary(bars, { range, atr, lastClose: closed.c }, {
    model: s.claude.model,
    timeoutSec: s.claude.timeoutSec,
  });
  if (!note) return;
  await updateState({ lastClaudeOkTs: Date.now() });
  await broadcastCommentary(tabId, {
    kind: 'analysis',
    message: `Claude: ${note.reason}  →  Watch: ${note.watch}`,
  });
}

function prettyNoSignal(reason, bars, s) {
  const last = bars.at(-1);
  switch (reason) {
    case 'out_of_session':
      return `Outside London/NY hours (UTC ${new Date().getUTCHours()}). Toggle 24/7 in Settings to override.`;
    case 'low_atr':
      return `Range too tight — ATR < $${s.signal.minAtrUsd}. Waiting for volatility.`;
    case 'no_break':
      return `Scanning… price ${last?.c?.toFixed(2)} inside ${s.signal.rangeMinutes}-min range. No breakout.`;
    case 'insufficient_bars':
      return `Building bar history from live ticks.`;
    default:
      return reason;
  }
}

async function runCycle() {
  const s = await getSettings();
  if (!s.enabled || s.paused) return;

  const tab = await findExnessTab();
  if (!tab) {
    trace('cycle', 'no_exness_tab', {});
    return;
  }
  const acctType = s.exness.accountTypeOverride || s.state.detectedAccountType || detectAccountType(tab.url);
  if (acctType === 'live' && !s.liveAccountUnlocked) {
    trace('cycle', 'live_locked', { url: tab.url, detected: acctType });
    await sendToContent(tab.id, { type: 'STATUS', state: 'live_locked' });
    await broadcastCommentary(tab.id, {
      kind: 'blocked',
      message: 'Live account detected — type the unlock phrase in Settings to enable trading.',
    });
    return;
  }

  // 1) Bars — prefer live Exness ticks aggregated into 1m bars; fall back to
  // Yahoo only if we don't have enough ticks buffered yet (cold start).
  // The +16 matches signal-engine's internal minimum (ATR(14) + 2 buffer).
  const minBarsNeeded = s.signal.rangeMinutes + 16;
  let bars = [];
  let source = null;
  try {
    bars = await buildBars(Math.max(s.signal.rangeMinutes + 30, 45));
    if (bars.length >= minBarsNeeded) {
      source = 'exness-ws';
    } else {
      // Not enough ticks yet. Bootstrap from Exness's own historical candles
      // endpoint — same data source the chart uses. Requires us to have seen
      // the WS to know the accountId.
      trace('cycle', 'tick_history_thin', { count: bars.length, needed: minBarsNeeded });
      const accountId = (await getSettings()).state.exnessAccountId;
      if (accountId) {
        try {
          const historical = await fetchExnessCandles({
            tabId: tab.id,
            accountId,
            symbol: 'XAUUSDr',
            timeFrameMin: 1,
            count: 200,
          });
          if (historical && historical.length) {
            await addTicks(barsToSyntheticTicks(historical));
            bars = await buildBars(Math.max(s.signal.rangeMinutes + 30, 45));
            if (bars.length >= minBarsNeeded) source = 'exness-history';
          }
        } catch (e) {
          traceError('cycle', 'exness_history_fallback_failed', e);
        }
      }
      // Final fallback: Yahoo (now mostly 404, kept for completeness)
      if (!source) {
        try {
          const bundle = await fetchBarsWithFallback(
            s.signal.instrument,
            s.signal.fallbackInstrument,
            s.signal.interval,
            Math.max(s.signal.rangeMinutes + 30, 60),
          );
          if (bundle?.bars?.length >= minBarsNeeded) {
            bars = bundle.bars;
            source = bundle.source || bundle.symbol;
          }
        } catch (e) {
          traceError('cycle', 'yahoo_fallback_failed', e);
        }
      }
    }
  } catch (e) {
    traceError('cycle', 'bars_build_failed', e);
    return;
  }
  if (!bars.length) {
    const tickStats = await getTickStats();
    trace('cycle', 'no_bars', { tickStats });
    await broadcastCommentary(tab.id, {
      kind: 'waiting',
      message: `Waiting for tick history — ${tickStats.count} ticks buffered (${tickStats.spanMin}min), need ~${minBarsNeeded}min.`,
    });
    return;
  }
  if (bars.length < minBarsNeeded) {
    const minutesLeft = Math.max(1, minBarsNeeded - bars.length);
    await broadcastCommentary(tab.id, {
      kind: 'waiting',
      message: `Warming up: ${bars.length} of ${minBarsNeeded} bars built from ticks. ~${minutesLeft} min until first signal possible.`,
    });
    return;
  }
  const lastBar = bars[bars.length - 1];
  const cur = await getSettings();
  await updateState({
    lastBarTs: lastBar.t,
    lastBar,
    lastFetchOkTs: Date.now(),
    lastFetchSource: source,
    cycleCount: (cur.state.cycleCount || 0) + 1,
  });

  // 2) Signal — run breakout and/or zone fade depending on strategy
  const strategy = s.strategy || 'both';
  let signal = null, reason = '', signalKind = '';

  if (strategy === 'breakout' || strategy === 'both') {
    const bo = detectBreakout(bars, s.signal);
    if (bo.signal) {
      signal = bo.signal;
      reason = bo.reason;
      signalKind = 'breakout';
    } else if (strategy === 'breakout') {
      reason = bo.reason;
    }
  }

  if (!signal && (strategy === 'zone_fade' || strategy === 'both')) {
    // Fetch supporting timeframes (cached opportunistically — same auth path)
    const accountId = (await getSettings()).state.exnessAccountId;
    let dailyBars = [], bars4h = [];
    if (accountId) {
      try {
        const { fetchExnessCandles } = await import('./lib/exness-history.js');
        const [d, h4] = await Promise.all([
          fetchExnessCandles({ tabId: tab.id, accountId, symbol: 'XAUUSDr', timeFrameMin: 1440, count: 5 }),
          fetchExnessCandles({ tabId: tab.id, accountId, symbol: 'XAUUSDr', timeFrameMin: 240,  count: 40 }),
        ]);
        dailyBars = d || []; bars4h = h4 || [];
      } catch (e) {
        traceError('cycle', 'zone_history_fetch_failed', e);
      }
    }
    const { zones, atr } = computeZones({ bars1m: bars, dailyBars, bars4h });
    const zf = detectZoneFade(bars, zones, atr);
    if (zf.signal) {
      signal = zf.signal;
      reason = zf.reason;
      signalKind = 'zone_fade';
    } else if (!signal) {
      // include near-zone info in the scanning commentary
      reason = reason || zf.reason;
      if (zf.near) {
        await broadcastCommentary(tab.id, {
          kind: 'scanning',
          message: `Scanning… price ${lastBar.c.toFixed(2)} • nearest ${zf.near.type} zone ${zf.near.bottom}-${zf.near.top} (sources: ${zf.near.sources.join(',')}, touches ${zf.near.touchesToday}). ${zf.near.distance.toFixed(2)} away.`,
        });
        await maybeNarrateMarket(tab.id, bars, s);
        await sendToContent(tab.id, { type: 'TICK', reason: 'no_zone_fade', lastBar });
        return;
      }
    }
  }

  if (!signal) {
    trace('cycle', 'no_signal', { reason, strategy });
    await sendToContent(tab.id, { type: 'TICK', reason, lastBar });
    await broadcastCommentary(tab.id, {
      kind: 'scanning',
      message: prettyNoSignal(reason, bars, s),
    });
    await maybeNarrateMarket(tab.id, bars, s);
    return;
  }
  await updateState({ lastAtr: signal.atr });
  trace('cycle', 'signal_detected', { kind: signalKind, side: signal.side, entry: signal.entry, atr: signal.atr });
  if (signalKind === 'zone_fade') {
    const z = signal.zone;
    await broadcastCommentary(tab.id, {
      kind: 'breakout',
      message: `Zone fade: ${signal.side.toUpperCase()} @ ${signal.entry} • ${z.type} ${z.bottom}-${z.top} (${z.sources.join(',')}, touches ${z.touchesToday}), wick ${(signal.wickPct*100).toFixed(0)}%, ATR $${signal.atr.toFixed(2)}`,
    });
  } else {
    await broadcastCommentary(tab.id, {
      kind: 'breakout',
      message: `Breakout: ${signal.side.toUpperCase()} @ ${signal.entry} • range ${signal.range.low}-${signal.range.high}, ATR $${signal.atr.toFixed(2)}`,
    });
  }

  // 3) Risk gate
  const verdict = await assess();
  if (!verdict.allow) {
    trace('cycle', 'risk_blocked', verdict);
    await sendToContent(tab.id, { type: 'BLOCKED', verdict, signal });
    await broadcastCommentary(tab.id, {
      kind: 'blocked',
      message: `Risk gate blocked: ${verdict.reason}`,
    });
    return;
  }

  // 4) Cross-check (only meaningful when bars came from Yahoo; if bars came
  // from the Exness WS feed we ARE the source of truth, skip).
  if (source !== 'exness-ws') {
    const pageState = await sendToContent(tab.id, { type: 'GET_PAGE_PRICE' });
    const exnessMid = pageState?.mid;
    if (exnessMid && Math.abs(signal.entry - exnessMid) > 5.0) {
      trace('cycle', 'cross_check_failed', { exnessMid, yahoo: signal.entry });
      await sendToContent(tab.id, { type: 'BLOCKED', verdict: { allow: false, reason: 'price_diverged' }, signal });
      await broadcastCommentary(tab.id, {
        kind: 'blocked',
        message: `Price diverged from Exness DOM ($${Math.abs(signal.entry - exnessMid).toFixed(2)}). Skipping.`,
      });
      return;
    }
  }

  // 5) Claude veto (optional)
  let claudeVerdict = { verdict: 'go', confidence: 100, reason: 'veto_disabled' };
  if (s.claude.enabled) {
    await broadcastCommentary(tab.id, {
      kind: 'asking',
      message: 'Asking Claude to confirm or veto…',
    });
    claudeVerdict = await vetoOrApprove(signal, bars, {
      model: s.claude.model,
      timeoutSec: s.claude.timeoutSec,
    });
    await updateState({
      lastClaudeMs: claudeVerdict.tookMs,
      lastClaudeOkTs: claudeVerdict.confidence > 0 ? Date.now() : (await getSettings()).state.lastClaudeOkTs,
      lastClaudeVerdict: claudeVerdict,
    });
    await broadcastCommentary(tab.id, {
      kind: claudeVerdict.verdict === 'go' ? 'claude_go' : 'claude_skip',
      message: `Claude: ${claudeVerdict.verdict.toUpperCase()} (${claudeVerdict.confidence}%) — ${claudeVerdict.reason}`,
    });
    if (claudeVerdict.verdict !== 'go' || claudeVerdict.confidence < s.claude.minConfidence) {
      trace('cycle', 'claude_skipped', { signal, claudeVerdict });
      await sendToContent(tab.id, { type: 'BLOCKED', verdict: { allow: false, reason: 'claude_skip', ...claudeVerdict }, signal });
      return;
    }
  }

  // 6) Pending trade
  const pending = {
    id: crypto.randomUUID(),
    side: signal.side,
    entry: signal.entry,
    sl: signal.sl,
    tp: signal.tp,
    atr: signal.atr,
    range: signal.range,
    claude: claudeVerdict,
    lot: s.risk.lotSize,
    accountType: acctType,
    createdAt: Date.now(),
    confirmTimeoutSec: s.autoConfirmTimeoutSec,
  };
  await updateState({ pending });
  await recordSignalAccepted();
  trace('cycle', 'awaiting_confirm', { id: pending.id, ...signal });

  // If confirm required -> overlay; otherwise execute directly.
  if (s.confirmEachTrade) {
    await sendToContent(tab.id, { type: 'CONFIRM', pending });
    if (s.notify.desktopOnSignal) {
      notify(`${signal.side.toUpperCase()} XAUUSD @ ${signal.entry}`,
        `SL ${signal.sl} / TP ${signal.tp} • conf ${claudeVerdict.confidence}%`);
    }
  } else {
    await executePending(tab.id, pending);
  }
}

async function executePending(tabId, pending) {
  trace('exec', 'begin', { id: pending.id, side: pending.side });
  await broadcastCommentary(tabId, {
    kind: 'placing',
    message: `Placing order: ${pending.side.toUpperCase()} ${pending.lot} lot @ ${pending.entry} • SL ${pending.sl} / TP ${pending.tp}`,
  });
  try {
    const res = await sendToContent(tabId, { type: 'EXECUTE', pending });
    if (res?.ok) {
      await pushHistory({ kind: 'placed', pending, exec: res });
      trace('exec', 'placed', { id: pending.id, exec: res });
      await broadcastCommentary(tabId, {
        kind: 'placed',
        message: `Order placed ${pending.side.toUpperCase()} ${pending.lot} lot @ ${pending.entry}. Risking $${(pending.atr).toFixed(2)} to ${pending.side === 'long' ? 'make' : 'make'} $${(pending.atr * 1.5).toFixed(2)} (R:R 1.5).`,
      });
      if (await wantNotify('desktopOnFill')) notify('Order placed', `${pending.side} @ ${pending.entry}`);
    } else {
      await pushHistory({ kind: 'failed', pending, exec: res });
      trace('exec', 'failed', { id: pending.id, exec: res });
      await broadcastCommentary(tabId, {
        kind: 'failed',
        message: `Order placement FAILED: ${res?.reason || 'unknown'}${res?.missing ? ' (missing: ' + res.missing.join(', ') + ')' : ''}`,
      });
    }
  } catch (e) {
    traceError('exec', 'threw', e, { id: pending.id });
    await pushHistory({ kind: 'errored', pending, error: e?.message });
    await broadcastCommentary(tabId, {
      kind: 'errored',
      message: `Order execution errored: ${e?.message || String(e)}`,
    });
  } finally {
    await updateState({ pending: null });
  }
}

async function wantNotify(key) {
  const s = await getSettings();
  return !!s.notify[key];
}

function notify(title, message) {
  try {
    chrome.notifications.create({
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title,
      message,
      priority: 2,
    });
  } catch (e) {
    // Silent — notifications permission may be revoked; trace it.
    traceError('notify', 'create_failed', e);
  }
}

// --- Message router (from content script & popup) ---

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg?.type) {
        case 'USER_APPROVE': {
          const s = await getSettings();
          const pending = s.state.pending;
          if (!pending || pending.id !== msg.id) {
            sendResponse({ ok: false, reason: 'no_pending_or_id_mismatch' });
            return;
          }
          const tab = sender.tab || await findExnessTab();
          if (!tab) { sendResponse({ ok: false, reason: 'no_tab' }); return; }
          await broadcastCommentary(tab.id, {
            kind: 'approve',
            message: `You approved ${pending.side.toUpperCase()} @ ${pending.entry}. Submitting…`,
          });
          await executePending(tab.id, pending);
          sendResponse({ ok: true });
          return;
        }
        case 'USER_REJECT': {
          await pushHistory({ kind: 'rejected', pendingId: msg.id, by: msg.by || 'user' });
          await updateState({ pending: null });
          const tab = sender.tab || await findExnessTab();
          if (tab) {
            await broadcastCommentary(tab.id, {
              kind: 'rejected',
              message: `Signal rejected (by ${msg.by || 'user'}). Back to scanning.`,
            });
          }
          sendResponse({ ok: true });
          return;
        }
        case 'RUN_NOW': {
          await runCycle();
          sendResponse({ ok: true });
          return;
        }
        case 'FORCE_TEST_SIGNAL': {
          // Manufacture a synthetic signal so the user can verify the full
          // approve -> place -> close pipeline on demo without waiting for
          // a real breakout. Uses the latest tick as entry, tiny SL/TP.
          const s = await getSettings();
          const tab = await findExnessTab();
          if (!tab) { sendResponse({ ok: false, reason: 'no_tab' }); return; }
          const latest = await getLatestTick();
          if (!latest) { sendResponse({ ok: false, reason: 'no_ticks' }); return; }
          const price = (latest.b + latest.a) / 2;
          const side = msg.side || 'long';
          const pending = {
            id: crypto.randomUUID(),
            side,
            entry: Math.round(price * 100) / 100,
            sl: Math.round((side === 'long' ? price - 0.5 : price + 0.5) * 100) / 100,
            tp: Math.round((side === 'long' ? price + 0.75 : price - 0.75) * 100) / 100,
            atr: 0.5,
            lot: s.risk.lotSize,
            accountType: 'demo',
            claude: { verdict: 'go', confidence: 100, reason: 'TEST signal (forced by user)' },
            createdAt: Date.now(),
            confirmTimeoutSec: 0,
          };
          await updateState({ pending });
          await broadcastCommentary(tab.id, {
            kind: 'breakout',
            message: `TEST signal: ${side.toUpperCase()} @ ${pending.entry} (forced, no real edge — verifying pipeline)`,
          });
          // Test trade always bypasses confirmation — we want to see the
          // place→close result NOW, not wait on a click that confuses the
          // diagnostic. If placement fails the AI feed will say exactly why.
          await executePending(tab.id, pending);
          sendResponse({ ok: true });
          return;
        }
        case 'REBUILD_ALARM': {
          await ensureAlarm();
          sendResponse({ ok: true });
          return;
        }
        case 'UNLOCK_LIVE': {
          if (msg.phrase === LIVE_UNLOCK_PHRASE) {
            const cur = await getSettings();
            await chrome.storage.local.set({
              exscalp_v1: { ...cur, liveAccountUnlocked: true },
            });
            sendResponse({ ok: true });
          } else {
            sendResponse({ ok: false, reason: 'wrong_phrase' });
          }
          return;
        }
        case 'PAGE_PRICE': {
          // content script can also push price unsolicited; we just trace it.
          trace('bg', 'page_price', msg.payload || null);
          sendResponse({ ok: true });
          return;
        }
        case 'RT_CONN': {
          // WebSocket lifecycle event from realtime-hook. We sniff the URL
          // for the account ID, which we need to call the candles endpoint.
          trace('rt', `conn_${msg.state || 'unknown'}`, { url: msg.url, code: msg.code, reason: msg.reason });
          const m = String(msg.url || '').match(/\/accounts\/(\d+)/);
          if (m) {
            const accountId = m[1];
            const s = await getSettings();
            if (s.state.exnessAccountId !== accountId) {
              await updateState({ exnessAccountId: accountId });
              trace('bg', 'account_id_captured', { accountId });
            }
          }
          sendResponse({ ok: true });
          return;
        }
        case 'RT_TICK': {
          // Legacy single-tick path from v0.5. Treat as a 1-tick batch.
          trace('rt', 'tick_sample', { url: msg.url, kind: msg.kind, len: msg.len, preview: msg.preview });
          sendResponse({ ok: true });
          return;
        }
        case 'RT_TICK_BATCH': {
          await addTicks(msg.ticks || []);
          sendResponse({ ok: true });
          return;
        }
        case 'RT_HTTP': {
          trace('rt', 'http_capture', {
            url: msg.url,
            method: msg.method,
            status: msg.status,
            contentType: msg.contentType,
            bodyLen: msg.bodyLen,
            tookMs: msg.tookMs,
            error: msg.error,
            bodyPreview: msg.bodyPreview,
            requestBody: msg.requestBody,
          });
          // Parse the account info response to determine demo vs live.
          // URL pattern: .../rtapi/mt5/{trial}/v1/accounts/{id}  (no trailing /balance etc.)
          if (msg.status === 200 && msg.bodyPreview && /\/accounts\/\d+$/.test(String(msg.url || '').split('?')[0])) {
            try {
              const acct = JSON.parse(msg.bodyPreview);
              const classified = classifyAccountFromApi(acct);
              const cur = await getSettings();
              if (cur.state.detectedAccountType !== classified) {
                await updateState({ detectedAccountType: classified });
                trace('bg', 'account_classified', { type: classified, fname: acct?.personal?.first_name, emailHost: (acct?.personal?.email || '').split('@')[1] });
              }
            } catch {
              // bodyPreview is truncated to 800 chars; the full account JSON
              // fits comfortably under that, so a parse failure is rare.
            }
          }
          sendResponse({ ok: true });
          return;
        }
        default:
          sendResponse({ ok: false, reason: 'unknown_message' });
      }
    } catch (e) {
      traceError('bg', 'msg_handler_failed', e, { type: msg?.type });
      sendResponse({ ok: false, reason: e.message });
    }
  })();
  return true; // async sendResponse
});
