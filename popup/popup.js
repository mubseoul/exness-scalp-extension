import { getSettings, saveSettings, replaceSection } from '../lib/storage.js';
import { getTrace, clearTrace, getTraceStats } from '../lib/trace.js';
import { LIVE_UNLOCK_PHRASE } from '../lib/defaults.js';
import { testClaudeWebConnection } from '../lib/claude-web.js';

const $ = (s) => document.querySelector(s);
const REFRESH_MS = 2000;

let settings = null;
let refreshTimer = null;

// ----- Tabs -----

document.querySelectorAll('.tabs .tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tabs .tab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
    if (btn.dataset.tab === 'logs') refreshLogs();
  });
});

// ----- Status painting -----

function statusVerdict(s) {
  if (!s.enabled) return { head: 'Disarmed', body: 'Flip the Armed toggle to start watching for breakouts.', cls: '' };
  if (s.paused)   return { head: 'Paused',   body: 'Signals will run, but no orders will be placed.', cls: 'paused' };
  return { head: 'Armed — watching XAUUSD', body: 'Polling Yahoo every 30s for 15-min range breakouts.', cls: 'active' };
}

function ago(ts) {
  if (!ts) return '—';
  const d = Date.now() - ts;
  if (d < 60_000)  return `${Math.floor(d / 1000)}s ago`;
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m ago`;
  return `${Math.floor(d / 3_600_000)}h ago`;
}

async function findExnessTab() {
  const tabs = await chrome.tabs.query({
    url: [
      'https://my.exness.global/webtrading/*',
      'https://my.exness.com/webtrading/*',
    ],
  });
  return tabs[0] || null;
}

async function paintStatus() {
  settings = await getSettings();
  const st = settings.state || {};
  const verdict = statusVerdict(settings);

  // Header
  $('#statusHead').textContent = verdict.head;
  $('#statusBody').textContent = verdict.body;
  $('#statusCard').className = 'status-card ' + verdict.cls;
  $('#statusDot').className = 'status-dot' + (verdict.cls === 'active' ? ' active' : (verdict.cls === 'paused' ? ' warn' : ''));

  $('#liveBadge').textContent = settings.liveAccountUnlocked ? 'LIVE UNLOCKED' : 'demo-safe';
  $('#liveBadge').style.color = settings.liveAccountUnlocked ? 'var(--warning)' : 'var(--success)';

  const masterBtn = $('#masterToggleBtn');
  masterBtn.textContent = settings.enabled ? 'Armed: ON' : 'Armed: OFF';
  masterBtn.className = 'btn-sm bid-toggle ' + (settings.enabled ? 'is-active' : 'is-paused');

  // Channels
  const exnessTab = await findExnessTab();
  setChannel('Exness', exnessTab ? 'active' : 'danger', exnessTab ? new URL(exnessTab.url).host : 'no tab open');

  // "Fresh" means: we fetched successfully in the last 2 minutes. The bar's
  // own timestamp may lag Yahoo's free-tier FX feed by 15min, but that's
  // about Yahoo's data lag, not whether our extension is alive.
  const fetchedRecently = st.lastFetchOkTs && (Date.now() - st.lastFetchOkTs) < 2 * 60 * 1000;
  const src = st.lastFetchSource || 'unknown';
  const isLive = src === 'exness-ws';
  const detail = !st.lastFetchOkTs
    ? 'no fetches yet'
    : fetchedRecently
      ? (isLive ? `live ticks • ${st.cycleCount || 0} cycles` : `${src} • ${st.cycleCount || 0} cycles`)
      : `last fetch ${ago(st.lastFetchOkTs)}`;
  setChannel('Yahoo', fetchedRecently ? 'active' : 'warn', detail);

  const claudeOk = st.lastClaudeOkTs;
  const claudeFresh = claudeOk && (Date.now() - claudeOk) < 30 * 60 * 1000;
  setChannel('Claude', claudeFresh ? 'active' : 'warn',
    !settings.claude.enabled ? 'veto off'
    : claudeOk ? `OK ${ago(claudeOk)}` : 'untested');

  // Stats
  const history = st.history || [];
  const todayStart = new Date(); todayStart.setUTCHours(0,0,0,0);
  const todays = history.filter(h => h.at >= todayStart.getTime());
  const trades = todays.filter(h => h.kind === 'placed').length;
  // Cycles & signals are approximations — derive from trace later if needed
  $('#statCyclesToday').textContent  = approxCyclesToday(st);
  $('#statSignalsToday').textContent = todays.length;
  $('#statTradesToday').textContent  = trades;

  const loss = st.todayLossUsd || 0;
  const cap  = settings.risk.maxDailyLossUsd;
  $('#statTodayLoss').textContent = `$${loss.toFixed(0)} / $${cap}`;
  $('#statTodayLoss').parentElement.style.borderColor = loss >= cap * 0.7 ? 'var(--danger)' : '';

  // Rate row
  const lastBar = st.lastBar;
  $('#rateXau').textContent = lastBar?.c ? lastBar.c.toFixed(2) : '—';
  $('#rateAtr').textContent = st.lastAtr ? `$${st.lastAtr.toFixed(2)}` : '—';
  const sinceSig = st.lastSignalTs ? Math.max(0, settings.signal.cooldownSec - Math.floor((Date.now() - st.lastSignalTs) / 1000)) : 0;
  $('#rateCooldown').textContent = sinceSig > 0 ? `${sinceSig}s` : 'ready';
  $('#rateClaudeMs').textContent = st.lastClaudeMs ? `${st.lastClaudeMs}` : '—';

  // History list
  renderHistory(history);

  // Live unlock row visibility
  const liveRow = $('#liveRow');
  if (exnessTab && /\/demo/i.test(exnessTab.url) === false) {
    liveRow.style.display = '';
    $('#liveLockState').textContent = settings.liveAccountUnlocked ? 'UNLOCKED' : 'locked';
  } else {
    liveRow.style.display = 'none';
  }
}

function approxCyclesToday(st) {
  if (!st.lastBarTs) return 0;
  // We don't store a counter; estimate from cycle alarm interval
  const today = new Date(); today.setUTCHours(0,0,0,0);
  const dayMs = Date.now() - today.getTime();
  const period = (settings.signal?.pollEverySec || 30) * 1000;
  return Math.floor(dayMs / Math.max(period, 30_000));
}

function setChannel(name, state, detail) {
  const root = $('#channel' + name);
  if (!root) return;
  root.classList.remove('active', 'warn', 'danger');
  if (state) root.classList.add(state);
  $('#channel' + name + 'Detail').textContent = detail;
}

function renderHistory(history) {
  const list = $('#historyList');
  list.innerHTML = '';
  if (!history.length) {
    const p = document.createElement('p');
    p.className = 'empty';
    p.textContent = 'No activity yet. Run a cycle to populate.';
    list.appendChild(p);
    return;
  }
  for (const h of history.slice(0, 8)) {
    const div = document.createElement('div');
    div.className = `history-item ${h.kind || ''}`;
    const t = new Date(h.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const side = h.pending?.side ? h.pending.side.toUpperCase() : '';
    const detail = h.pending
      ? `${side} @ ${h.pending.entry} → SL ${h.pending.sl} / TP ${h.pending.tp}`
      : (h.error || h.pendingId?.slice(0,8) || '');
    div.innerHTML = `
      <span class="h-when">${t}</span>
      <span class="h-kind">${h.kind}</span>
      <span class="h-detail">${detail}</span>
    `;
    list.appendChild(div);
  }
}

// ----- Master / toggles -----

$('#masterToggleBtn').addEventListener('click', async () => {
  const next = !settings.enabled;
  await saveSettings({ enabled: next });
  paintStatus();
});

$('#runNowBtn').addEventListener('click', async () => {
  $('#runNowBtn').textContent = '…';
  await chrome.runtime.sendMessage({ type: 'RUN_NOW' });
  setTimeout(() => { $('#runNowBtn').textContent = 'Run now'; paintStatus(); }, 600);
});

$('#forceTestSignal').addEventListener('click', async () => {
  $('#forceTestSignal').textContent = 'Firing…';
  const r = await chrome.runtime.sendMessage({ type: 'FORCE_TEST_SIGNAL', side: 'long' });
  $('#forceTestSignal').textContent = r?.ok ? 'Fired' : (r?.reason || 'failed');
  setTimeout(() => $('#forceTestSignal').textContent = 'Test trade', 2000);
});

$('#claudeProbe').addEventListener('click', async () => {
  $('#claudeProbe').textContent = 'Testing…';
  try {
    const r = await testClaudeWebConnection();
    $('#claudeProbe').textContent = `OK: ${r.orgName?.slice(0, 14) || 'org'}`;
    // Background also records lastClaudeOkTs when veto succeeds.
    const cur = await getSettings();
    cur.state.lastClaudeOkTs = Date.now();
    await chrome.storage.local.set({ exscalp_v1: cur });
  } catch (e) {
    $('#claudeProbe').textContent = `Fail`;
  }
  setTimeout(() => { $('#claudeProbe').textContent = 'Test Claude'; paintStatus(); }, 2500);
});

// ----- Live unlock -----

$('#unlockLiveBtn').addEventListener('click', () => {
  $('#phraseRef').textContent = LIVE_UNLOCK_PHRASE;
  $('#phraseInput').value = '';
  $('#liveModal').classList.remove('hidden');
});
$('#cancelUnlock').addEventListener('click', () => $('#liveModal').classList.add('hidden'));
$('#confirmUnlock').addEventListener('click', async () => {
  const phrase = $('#phraseInput').value.trim();
  const r = await chrome.runtime.sendMessage({ type: 'UNLOCK_LIVE', phrase });
  if (r?.ok) {
    $('#liveModal').classList.add('hidden');
    paintStatus();
  } else {
    $('#phraseInput').style.borderColor = 'var(--danger)';
  }
});

// ----- Settings tab -----

const SETTINGS_FIELDS = [
  ['confirmEachTrade', 'confirmEachTrade'],
  ['paused',           'paused'],
  ['strategy',         'strategy'],
  ['rangeMinutes',     'signal.rangeMinutes'],
  ['breakoutAtrMult',  'signal.breakoutAtrMult'],
  ['minAtrUsd',        'signal.minAtrUsd'],
  ['cooldownSec',      'signal.cooldownSec'],
  ['pollEverySec',     'signal.pollEverySec'],
  ['ignoreSession',    'signal.ignoreSession'],
  ['lotSize',          'risk.lotSize'],
  ['tpAtrMult',        'risk.tpAtrMult'],
  ['slAtrMult',        'risk.slAtrMult'],
  ['maxDailyLossUsd',  'risk.maxDailyLossUsd'],
  ['maxTradesPerHour', 'risk.maxTradesPerHour'],
  ['maxTradesPerDay',  'risk.maxTradesPerDay'],
  ['claudeEnabled',    'claude.enabled'],
  ['minConfidence',    'claude.minConfidence'],
  ['claudeTimeoutSec', 'claude.timeoutSec'],
];

function get(obj, path) { return path.split('.').reduce((a, k) => a?.[k], obj); }
function setPath(obj, path, value) {
  const parts = path.split('.');
  let o = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    o[parts[i]] = o[parts[i]] || {};
    o = o[parts[i]];
  }
  o[parts[parts.length - 1]] = value;
}

async function paintSettings() {
  const s = await getSettings();
  for (const [id, path] of SETTINGS_FIELDS) {
    const el = $('#' + id);
    if (!el) continue;
    const v = get(s, path);
    if (el.type === 'checkbox') el.checked = !!v;
    else if (el.tagName === 'SELECT') el.value = v ?? '';
    else el.value = v ?? '';
  }
}

$('#saveSettings').addEventListener('click', async () => {
  const patch = {};
  for (const [id, path] of SETTINGS_FIELDS) {
    const el = $('#' + id);
    if (!el) continue;
    let v;
    if (el.type === 'checkbox') v = el.checked;
    else if (el.tagName === 'SELECT') v = el.value;
    else { v = Number(el.value); if (!Number.isFinite(v)) continue; }
    setPath(patch, path, v);
  }
  await saveSettings(patch);
  $('#saveSettings').textContent = 'Saved ✓';
  setTimeout(() => $('#saveSettings').textContent = 'Save settings', 1200);
});

$('#rebuildAlarm').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'REBUILD_ALARM' });
  $('#rebuildAlarm').textContent = 'Rebuilt ✓';
  setTimeout(() => $('#rebuildAlarm').textContent = 'Rebuild alarm', 1200);
});

// ----- Calibration -----

const SELECTOR_FIELDS = [
  'bidPrice','askPrice','lotInput','slInput','tpInput',
  'buyButton','sellButton','confirmButton',
];

async function paintSelectors() {
  const s = await getSettings();
  for (const k of SELECTOR_FIELDS) $('#sel_' + k).value = s.exness.selectors[k] || '';
}

$('#saveSelectors').addEventListener('click', async () => {
  const s = await getSettings();
  const sels = { ...s.exness.selectors };
  for (const k of SELECTOR_FIELDS) sels[k] = $('#sel_' + k).value.trim() || null;
  await replaceSection('exness', { ...s.exness, selectors: sels, calibratedAt: Date.now() });
  $('#saveSelectors').textContent = 'Saved ✓';
  setTimeout(() => $('#saveSelectors').textContent = 'Save selectors', 1200);
});

// ----- Logs -----

async function refreshLogs() {
  const events = await getTrace();
  const stats = await getTraceStats();
  $('#logsCount').textContent = String(stats.count);
  const lines = events.slice(-200).map(e =>
    `${new Date(e.ts).toISOString().slice(11,19)} [${e.src}/${e.type}] ${JSON.stringify(e.data || {}).slice(0, 220)}`
  ).join('\n');
  $('#logsOut').textContent = `# ${stats.count} events (cap ${stats.cap})\n` + lines;
}

$('#refreshLogs').addEventListener('click', refreshLogs);
$('#clearLogs').addEventListener('click', async () => { await clearTrace(); refreshLogs(); });
$('#copyLogs').addEventListener('click', async () => {
  const events = await getTrace();
  await navigator.clipboard.writeText(JSON.stringify(events, null, 2));
  $('#copyLogs').textContent = 'Copied ✓';
  setTimeout(() => $('#copyLogs').textContent = 'Copy JSON', 1200);
});

// ----- Init + auto-refresh -----

(async function init() {
  await paintStatus();
  await paintSettings();
  await paintSelectors();
  refreshTimer = setInterval(paintStatus, REFRESH_MS);
})();

window.addEventListener('unload', () => {
  if (refreshTimer) clearInterval(refreshTimer);
});
