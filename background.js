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
import { fetchBarsWithFallback, crossCheck } from './lib/price-feed.js';
import { detectBreakout } from './lib/signal-engine.js';
import { vetoOrApprove } from './lib/claude-trade.js';
import { assess, recordSignalAccepted, detectAccountType } from './lib/risk-manager.js';
import { LIVE_UNLOCK_PHRASE, DEFAULTS } from './lib/defaults.js';

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

async function runCycle() {
  const s = await getSettings();
  if (!s.enabled || s.paused) return;

  const tab = await findExnessTab();
  if (!tab) {
    trace('cycle', 'no_exness_tab', {});
    return;
  }
  const acctType = s.exness.accountTypeOverride || detectAccountType(tab.url);
  if (acctType === 'live' && !s.liveAccountUnlocked) {
    trace('cycle', 'live_locked', { url: tab.url });
    await sendToContent(tab.id, { type: 'STATUS', state: 'live_locked' });
    return;
  }

  // 1) Bars
  let bundle;
  try {
    bundle = await fetchBarsWithFallback(
      s.signal.instrument,
      s.signal.fallbackInstrument,
      s.signal.interval,
      Math.max(s.signal.rangeMinutes + 30, 60),
    );
  } catch (e) {
    traceError('cycle', 'bars_fetch_failed', e);
    return;
  }
  if (!bundle.bars.length) {
    trace('cycle', 'no_bars', {});
    return;
  }
  await updateState({ lastBarTs: bundle.bars[bundle.bars.length - 1].t });

  // 2) Signal
  const { signal, reason } = detectBreakout(bundle.bars, s.signal);
  if (!signal) {
    trace('cycle', 'no_signal', { reason });
    await sendToContent(tab.id, { type: 'TICK', reason, lastBar: bundle.bars.at(-1) });
    return;
  }
  trace('cycle', 'signal_detected', { side: signal.side, entry: signal.entry, atr: signal.atr });

  // 3) Risk gate
  const verdict = await assess();
  if (!verdict.allow) {
    trace('cycle', 'risk_blocked', verdict);
    await sendToContent(tab.id, { type: 'BLOCKED', verdict, signal });
    return;
  }

  // 4) Cross-check with Exness DOM price (content script holds it).
  // Threshold of $5 absorbs GC=F basis if we fell back to futures; for spot
  // XAUUSD=X the typical delta is < $0.50.
  const pageState = await sendToContent(tab.id, { type: 'GET_PAGE_PRICE' });
  const exnessMid = pageState?.mid;
  const xcheck = crossCheck(signal.entry, exnessMid, 5.0);
  if (!xcheck.ok) {
    trace('cycle', 'cross_check_failed', { xcheck, exnessMid, yahoo: signal.entry });
    await sendToContent(tab.id, { type: 'BLOCKED', verdict: { allow: false, reason: 'price_diverged', ...xcheck }, signal });
    return;
  }

  // 5) Claude veto (optional)
  let claudeVerdict = { verdict: 'go', confidence: 100, reason: 'veto_disabled' };
  if (s.claude.enabled) {
    claudeVerdict = await vetoOrApprove(signal, bundle.bars, {
      model: s.claude.model,
      timeoutSec: s.claude.timeoutSec,
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
  try {
    const res = await sendToContent(tabId, { type: 'EXECUTE', pending });
    if (res?.ok) {
      await pushHistory({ kind: 'placed', pending, exec: res });
      trace('exec', 'placed', { id: pending.id, exec: res });
      if (await wantNotify('desktopOnFill')) notify('Order placed', `${pending.side} @ ${pending.entry}`);
    } else {
      await pushHistory({ kind: 'failed', pending, exec: res });
      trace('exec', 'failed', { id: pending.id, exec: res });
    }
  } catch (e) {
    traceError('exec', 'threw', e, { id: pending.id });
    await pushHistory({ kind: 'errored', pending, error: e?.message });
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
          await executePending(tab.id, pending);
          sendResponse({ ok: true });
          return;
        }
        case 'USER_REJECT': {
          await pushHistory({ kind: 'rejected', pendingId: msg.id, by: msg.by || 'user' });
          await updateState({ pending: null });
          sendResponse({ ok: true });
          return;
        }
        case 'RUN_NOW': {
          await runCycle();
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
