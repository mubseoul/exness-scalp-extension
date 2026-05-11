import { getSettings, saveSettings, replaceSection } from '../lib/storage.js';
import { getTrace, clearTrace, getTraceStats } from '../lib/trace.js';
import { LIVE_UNLOCK_PHRASE } from '../lib/defaults.js';
import { testClaudeWebConnection } from '../lib/claude-web.js';

const $ = (s) => document.querySelector(s);

// --- Tabs ----------------------------------------------------------------

document.querySelectorAll('.tabs button').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tabs button').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('.tab').forEach(t => t.classList.add('hidden'));
    document.querySelector(`.tab[data-tab="${btn.dataset.tab}"]`).classList.remove('hidden');
    if (btn.dataset.tab === 'logs') refreshLogs();
    if (btn.dataset.tab === 'status') paintStatus();
  });
});

// --- Status --------------------------------------------------------------

async function paintStatus() {
  const s = await getSettings();
  $('#enabled').checked          = !!s.enabled;
  $('#paused').checked           = !!s.paused;
  $('#confirmEachTrade').checked = !!s.confirmEachTrade;
  $('#liveLockState').textContent = s.liveAccountUnlocked ? 'UNLOCKED' : 'locked';
  $('#liveLockState').style.color = s.liveAccountUnlocked ? 'var(--warn)' : 'var(--fg-dim)';

  $('#lastBar').textContent     = s.state.lastBarTs    ? new Date(s.state.lastBarTs).toLocaleTimeString()    : '–';
  $('#lastSignal').textContent  = s.state.lastSignalTs ? new Date(s.state.lastSignalTs).toLocaleTimeString() : '–';
  $('#hourTrades').textContent  = `${s.state.tradesThisHour || 0} / ${s.risk.maxTradesPerHour}`;
  $('#todayLoss').textContent   = `$${(s.state.todayLossUsd || 0).toFixed(2)} / $${s.risk.maxDailyLossUsd}`;

  const recent = $('#recent');
  recent.innerHTML = '';
  (s.state.history || []).slice(0, 6).forEach(h => {
    const d = document.createElement('div');
    d.className = 'item';
    const t = new Date(h.at).toLocaleTimeString();
    const side = h.pending?.side ? h.pending.side.toUpperCase() : '';
    const detail = h.pending ? `@ ${h.pending.entry}` : '';
    d.textContent = `${t} • ${h.kind} ${side} ${detail}`;
    recent.appendChild(d);
  });
}

$('#enabled').addEventListener('change', async (e) => {
  await saveSettings({ enabled: e.target.checked });
  paintStatus();
});
$('#paused').addEventListener('change', async (e) => {
  await saveSettings({ paused: e.target.checked });
  paintStatus();
});
$('#confirmEachTrade').addEventListener('change', async (e) => {
  await saveSettings({ confirmEachTrade: e.target.checked });
});
$('#runNowBtn').addEventListener('click', async () => {
  $('#runNowBtn').textContent = 'Running…';
  await chrome.runtime.sendMessage({ type: 'RUN_NOW' });
  $('#runNowBtn').textContent = 'Run cycle now';
  paintStatus();
});
$('#claudeProbe').addEventListener('click', async () => {
  $('#claudeProbe').textContent = 'Testing…';
  try {
    const r = await testClaudeWebConnection();
    $('#claudeProbe').textContent = `OK: ${r.orgName}`;
  } catch (e) {
    $('#claudeProbe').textContent = `Fail: ${e.message.slice(0, 30)}…`;
  }
});

// --- Live unlock ---------------------------------------------------------

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
    $('#phraseInput').style.borderColor = 'var(--short)';
  }
});

// --- Settings ------------------------------------------------------------

const SETTINGS_FIELDS = [
  ['rangeMinutes',     'signal.rangeMinutes'],
  ['breakoutAtrMult',  'signal.breakoutAtrMult'],
  ['minAtrUsd',        'signal.minAtrUsd'],
  ['cooldownSec',      'signal.cooldownSec'],
  ['pollEverySec',     'signal.pollEverySec'],
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
    else el.value = v ?? '';
  }
}

$('#saveSettings').addEventListener('click', async () => {
  const patch = {};
  for (const [id, path] of SETTINGS_FIELDS) {
    const el = $('#' + id);
    if (!el) continue;
    const v = el.type === 'checkbox' ? el.checked : Number(el.value);
    if (el.type === 'number' && !Number.isFinite(v)) continue;
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

// --- Calibration ---------------------------------------------------------

const SELECTOR_FIELDS = [
  'bidPrice','askPrice','lotInput','slInput','tpInput',
  'buyButton','sellButton','confirmButton',
];

async function paintSelectors() {
  const s = await getSettings();
  for (const k of SELECTOR_FIELDS) {
    $('#sel_' + k).value = s.exness.selectors[k] || '';
  }
}

$('#saveSelectors').addEventListener('click', async () => {
  const s = await getSettings();
  const sels = { ...s.exness.selectors };
  for (const k of SELECTOR_FIELDS) sels[k] = $('#sel_' + k).value.trim() || null;
  await replaceSection('exness', { ...s.exness, selectors: sels, calibratedAt: Date.now() });
  $('#saveSelectors').textContent = 'Saved ✓';
  setTimeout(() => $('#saveSelectors').textContent = 'Save selectors', 1200);
});

// --- Logs ----------------------------------------------------------------

async function refreshLogs() {
  const events = await getTrace();
  const stats = await getTraceStats();
  const lines = events.slice(-200).map(e =>
    `${new Date(e.ts).toISOString().slice(11,19)} [${e.src}/${e.type}] ${JSON.stringify(e.data || {}).slice(0, 220)}`
  ).join('\n');
  $('#logsOut').textContent = `# ${stats.count} events (cap ${stats.cap})\n` + lines;
}

$('#refreshLogs').addEventListener('click', refreshLogs);
$('#clearLogs').addEventListener('click', async () => {
  await clearTrace();
  refreshLogs();
});
$('#copyLogs').addEventListener('click', async () => {
  const events = await getTrace();
  await navigator.clipboard.writeText(JSON.stringify(events, null, 2));
  $('#copyLogs').textContent = 'Copied ✓';
  setTimeout(() => $('#copyLogs').textContent = 'Copy JSON', 1200);
});

// --- Init ---------------------------------------------------------------

(async function init() {
  await paintStatus();
  await paintSettings();
  await paintSelectors();
})();
