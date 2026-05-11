// All tunables live here. Existing user settings always win over new defaults
// (see deepMerge in storage.js) — bumping a default doesn't retro-affect users.

export const DEFAULTS = {
  // Master switches
  enabled: false,            // signal engine off until user arms it
  paused: false,             // temporary pause (popup toggle)
  confirmEachTrade: true,    // require user click before order is placed
  autoConfirmTimeoutSec: 0,  // 0 = wait forever for confirmation; >0 = auto-approve after N sec
  liveAccountUnlocked: false, // must be true (with phrase) to allow trading on a non-demo URL

  // Signal generation
  signal: {
    // XAUUSD=X is Yahoo's spot symbol — matches what Exness shows directly.
    // GC=F (gold futures front-month) is the fallback if Yahoo doesn't serve
    // intraday spot data; it sits $3-15 above spot due to cost-of-carry, so
    // cross-check tolerance is widened to absorb that basis.
    instrument: 'XAUUSD=X',
    fallbackInstrument: 'GC=F',
    interval: '1m',           // 1m bars
    rangeMinutes: 15,         // breakout = price exits 15m high/low range
    breakoutAtrMult: 0.3,     // require breakout move >= 0.3 * ATR
    minAtrUsd: 0.5,           // skip if ATR(14) < $0.50 (range too tight)
    confirmationCandles: 1,   // # closed candles past range
    cooldownSec: 90,          // min gap between accepted signals
    pollEverySec: 15,         // bar fetch cadence
    ignoreSession: false,     // override: trade any hour (TEST/MANUAL ONLY)
    sessionUtcHours: [        // London + NY: 07:00–21:00 UTC
      { from: 7, to: 21 }
    ],
  },

  // Risk
  risk: {
    lotSize: 0.01,            // 0.01 lot XAUUSD ≈ $0.10/pip
    tpAtrMult: 1.5,           // TP distance = N x ATR
    slAtrMult: 1.0,           // SL distance = N x ATR
    maxDailyLossUsd: 50,      // auto-pause once realized daily loss crosses this
    maxOpenPositions: 1,
    maxTradesPerHour: 6,
    maxTradesPerDay: 20,
  },

  // Claude veto layer
  claude: {
    enabled: true,            // false = trust JS signal alone (faster, no LLM gate)
    model: null,              // null = claude.ai default model
    minConfidence: 65,        // skip if Claude's confidence < this
    timeoutSec: 12,           // give up on Claude after N sec, fall back to JS-only
  },

  // Exness page interaction. These defaults were derived from a live page
  // snapshot (2026-05) and should work out of the box. The Calibrate tab in
  // the popup lets you override any of them if Exness changes their markup.
  //
  // Positional selectors: prefix "[N]:" picks the Nth match (0-indexed). The
  // three order-ticket inputs (lot/SL/TP) all share the same class, so we
  // disambiguate by DOM order.
  exness: {
    accountTypeOverride: null,   // 'demo' | 'live' | null (null = detect from URL)
    selectors: {
      // Bid and ask are embedded INSIDE the buy/sell button text on Exness's
      // React frontend (e.g. "Sell4,684.758"). Pointing the bid/ask scrape
      // at the same buttons works — the price parser strips non-numeric chars.
      bidPrice: 'button.OrderButton_sell__f2c8b',
      askPrice: 'button.OrderButton_buy__f2c8b',
      instrumentLabel: 'button.InstrumentTab_active__0a3c6',
      lotInput: '[0]:input.InputBox_input__59aa2',
      slInput:  '[1]:input.InputBox_input__59aa2',
      tpInput:  '[2]:input.InputBox_input__59aa2',
      buyButton:  'button.OrderButton_buy__f2c8b',
      sellButton: 'button.OrderButton_sell__f2c8b',
      confirmButton: null,           // Exness places directly on click; no dialog
    },
    calibratedAt: null,
  },

  // Notifications
  notify: {
    desktopOnSignal: true,
    desktopOnFill: true,
    desktopOnLossCap: true,
  },

  // Live state (managed by background)
  state: {
    todayDateUtc: null,       // YYYY-MM-DD of current trading day
    todayLossUsd: 0,
    todayTradeCount: 0,
    hourStartTs: 0,
    tradesThisHour: 0,
    lastSignalTs: 0,
    lastBarTs: 0,
    lastBar: null,            // { t, o, h, l, c, v } most recent bar
    lastAtr: null,            // ATR from most recent signal evaluation
    lastClaudeOkTs: 0,        // most recent successful claude.ai round-trip
    lastClaudeMs: 0,          // duration of last Claude call
    openPositions: 0,
    pending: null,            // { id, side, entry, sl, tp, ts, ... } awaiting confirm
    history: [],              // recent signals/trades, capped 200
  },
};

// Symbol used for Exness web trader — purely informational, doesn't drive Yahoo fetch.
export const EXNESS_SYMBOL_LABEL = 'XAUUSD';

// Confirmation phrase the user must type to enable live-account trading.
export const LIVE_UNLOCK_PHRASE = 'I ACCEPT THE RISK';
