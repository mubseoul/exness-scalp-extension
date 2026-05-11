// Pre-trade gating. Every signal passes through assess() before it reaches
// the user/auto-executor. Returns { allow: boolean, reason: string }.

import { getSettings, updateState } from './storage.js';
import { trace } from './trace.js';

function utcDateString(ts = Date.now()) {
  return new Date(ts).toISOString().slice(0, 10);
}

async function rollDailyIfNeeded(s) {
  const today = utcDateString();
  if (s.state.todayDateUtc !== today) {
    await updateState({
      todayDateUtc: today,
      todayLossUsd: 0,
      todayTradeCount: 0,
    });
    return true;
  }
  return false;
}

async function rollHourlyIfNeeded(s) {
  const now = Date.now();
  if (!s.state.hourStartTs || now - s.state.hourStartTs >= 3600 * 1000) {
    await updateState({ hourStartTs: now, tradesThisHour: 0 });
    return true;
  }
  return false;
}

export async function assess() {
  const s = await getSettings();
  await rollDailyIfNeeded(s);
  await rollHourlyIfNeeded(s);
  const fresh = await getSettings();

  if (!fresh.enabled) return { allow: false, reason: 'master_off' };
  if (fresh.paused)   return { allow: false, reason: 'paused' };

  if (fresh.state.todayLossUsd >= fresh.risk.maxDailyLossUsd) {
    return { allow: false, reason: 'daily_loss_cap', loss: fresh.state.todayLossUsd };
  }
  if (fresh.state.todayTradeCount >= fresh.risk.maxTradesPerDay) {
    return { allow: false, reason: 'daily_trade_cap', count: fresh.state.todayTradeCount };
  }
  if (fresh.state.tradesThisHour >= fresh.risk.maxTradesPerHour) {
    return { allow: false, reason: 'hourly_trade_cap', count: fresh.state.tradesThisHour };
  }
  if (fresh.state.openPositions >= fresh.risk.maxOpenPositions) {
    return { allow: false, reason: 'max_open_positions', open: fresh.state.openPositions };
  }
  const sinceLast = Date.now() - (fresh.state.lastSignalTs || 0);
  if (sinceLast < fresh.signal.cooldownSec * 1000) {
    return { allow: false, reason: 'cooldown', sinceLastMs: sinceLast };
  }
  return { allow: true, reason: 'ok' };
}

export async function recordSignalAccepted() {
  const s = await getSettings();
  await updateState({
    lastSignalTs: Date.now(),
    tradesThisHour: (s.state.tradesThisHour || 0) + 1,
    todayTradeCount: (s.state.todayTradeCount || 0) + 1,
  });
}

export async function recordRealizedPnl(pnlUsd) {
  const s = await getSettings();
  if (pnlUsd < 0) {
    const newLoss = (s.state.todayLossUsd || 0) + Math.abs(pnlUsd);
    await updateState({ todayLossUsd: newLoss });
    trace('risk', 'loss_recorded', { pnlUsd, totalDayLoss: newLoss, cap: s.risk.maxDailyLossUsd });
    if (newLoss >= s.risk.maxDailyLossUsd) {
      trace('risk', 'daily_cap_hit_auto_pause', { newLoss });
      await updateState({}); // ensure state flushed
      const cur = await getSettings();
      // auto-pause to stop further entries
      await chrome.storage.local.set({
        exscalp_v1: { ...cur, paused: true },
      });
    }
  }
}

// Account-type gate. The extension refuses to trade on a live URL unless the
// user has explicitly unlocked it (see defaults.LIVE_UNLOCK_PHRASE).
export function detectAccountType(url) {
  if (!url) return 'unknown';
  // Exness URL patterns:
  //   https://my.exness.global/webtrading/...           -> live (real money)
  //   https://my.exness.global/webtrading/demo/...      -> demo
  // Best effort; users should also set exness.accountTypeOverride to be sure.
  try {
    const u = new URL(url);
    if (u.pathname.includes('/demo')) return 'demo';
    if (u.hostname.includes('demo')) return 'demo';
    return 'live';
  } catch {
    return 'unknown';
  }
}
