# Exness XAUUSD Scalp Assistant

Chrome MV3 extension. Watches XAUUSD on a 1-minute timeframe, detects momentum
breakouts in deterministic JS, asks Claude (via your claude.ai session) to veto
or approve, and either prompts you to confirm or auto-places the order on the
Exness web trader.

**Read the safety notes at the bottom before arming it on a live account.**

## Install

1. Open `chrome://extensions`, enable Developer mode, click "Load unpacked".
2. Select this folder.
3. Replace the icons in `icons/` if you want (currently placeholders from the
   Freelancer extension).
4. Open https://claude.ai and log in (the extension uses your session cookie
   for Claude calls — no API key needed).
5. Open https://my.exness.global/webtrading/ (or `.com`).

## First-run calibration (required before trades can be placed)

The extension does not assume any specific Exness DOM structure. Before it can
place orders, teach it which elements are which:

1. On the Exness webtrading page, **inspect** the element you want (right-click → Inspect).
2. In DevTools, right-click the highlighted node → Copy → Copy selector.
3. Open the extension popup → Calibrate tab → paste each selector.
4. Test each in DevTools first with `$$('your-selector')` — must match exactly
   one element.

You need at minimum:

- `bidPrice`, `askPrice` — the live price spans
- `lotInput`, `slInput`, `tpInput` — the order ticket fields
- `buyButton`, `sellButton` — the buy/sell buttons
- `confirmButton` (optional) — the "Confirm" button if Exness shows a dialog

Until all of these are calibrated, the overlay says "no DOM selectors" and the
extension refuses to place orders.

## Arming

1. Popup → Status tab → toggle **Master switch** ON.
2. Demo accounts work immediately. **Live accounts are locked** by default —
   click "Unlock live trading" and type the confirmation phrase exactly.
3. "Confirm each trade" is ON by default. You get an overlay with Approve /
   Reject buttons for every signal. Turn it off to let the extension fire
   trades unattended (not recommended).

## How signals work

1. Every `pollEverySec` (15s default) the service worker fetches 1m OHLC bars
   for `GC=F` (gold futures front-month, Yahoo Finance — close proxy to
   XAUUSD spot).
2. JS engine looks at the most recently CLOSED bar:
   - High of the last 15 minutes (excluding current bar) = `range.high`
   - Low likewise = `range.low`
   - ATR(14) on closed bars
   - If close > range.high + 0.3 × ATR → **long breakout**
   - If close < range.low  − 0.3 × ATR → **short breakout**
   - Skip if ATR < $0.50 (range too tight to scalp)
   - Skip if outside London + NY hours (07–21 UTC)
3. Yahoo's signal entry is cross-checked against the Exness DOM price. Refuses
   to trade if they diverge by > $2 (e.g. weekend, feed lag).
4. Risk gate — daily loss cap, hourly trade cap, cooldown, open positions.
5. Claude veto — sends the candidate trade and last 30 bars to claude.ai via
   your session. Claude returns `{verdict, confidence, reason}`. Trade only
   fires if verdict=go and confidence ≥ `minConfidence` (default 65).
6. SL/TP are fixed off ATR (`slAtrMult` × ATR, `tpAtrMult` × ATR). Claude
   does NOT pick levels — it only decides go/skip.

## Files

```
manifest.json
background.js              service worker — orchestrates polls, calls Claude, dispatches to content
content-exness.js          injected into my.exness.global/webtrading/* — overlay, DOM scrape, order placement
overlay/overlay.css        floating overlay styling

lib/
  defaults.js              all tunables + LIVE_UNLOCK_PHRASE
  storage.js               chrome.storage.local + deepMerge
  trace.js                 5000-event ring buffer; export from Logs tab
  price-feed.js            Yahoo Finance OHLC fetch + cross-check helper
  signal-engine.js         breakout detector + ATR
  claude-trade.js          builds prompt, parses JSON verdict
  claude-web.js            claude.ai session client (Cloudflare-bypass via MAIN-world fetch in a real tab)
  risk-manager.js          per-trade risk gating, daily/hourly counters, account-type detection

popup/                     Status / Settings / Calibrate / Logs tabs
icons/                     16/48/128 (placeholders — replace as you like)
```

## Test commands

```bash
node --check background.js content-exness.js lib/*.js popup/popup.js
python3 -c "import json; json.load(open('manifest.json'))"
```

## Safety notes (read before arming live)

This combination of choices is the highest-risk setup the extension supports:

1. **Live account + auto-execute is a real-money risk.** A misfire during NFP /
   CPI / FOMC can move XAUUSD $20+ in a minute. With 1:500 leverage that's a
   margin call. There is no kill switch that beats reaction time — set
   `maxDailyLossUsd` low enough that you can sleep through a worst case.

2. **Exness ToS.** Automated trading via the web UI (vs. their MT5 API) is
   generally against their terms. They can close the account.

3. **DOM brittleness.** Exness updates their frontend without notice. When
   they do, calibration breaks and orders fail to place. The extension traces
   the failure and surfaces a "blocked" badge — check the popup Status tab
   regularly. Don't assume "no recent trades" means "everything is fine".

4. **Claude can hallucinate the veto reasoning.** It sees compressed OHLC, not
   live ticks. We use it only as a coarse filter; the real signal is the
   deterministic JS engine. If Claude is unreachable (claude.ai down,
   logged-out, Cloudflare challenge), the extension defaults to **skip** for
   that cycle, not "go".

5. **Confirm-per-trade is your friend.** Keep it on. The 8s reaction time
   you'll need to reject a bad trade is a much better safety net than any
   counter in this file.
