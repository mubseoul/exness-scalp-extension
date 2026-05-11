import { DEFAULTS } from './defaults.js';

const ROOT_KEY = 'exscalp_v1';

function deepMerge(base, override) {
  if (Array.isArray(base) || base === null || typeof base !== 'object') {
    return override === undefined ? base : override;
  }
  const out = { ...base };
  if (override && typeof override === 'object') {
    for (const k of Object.keys(override)) {
      out[k] = deepMerge(base[k], override[k]);
    }
  }
  return out;
}

export async function getSettings() {
  const stored = await chrome.storage.local.get(ROOT_KEY);
  return deepMerge(DEFAULTS, stored[ROOT_KEY] || {});
}

export async function saveSettings(partial) {
  const current = await getSettings();
  const merged = deepMerge(current, partial);
  await chrome.storage.local.set({ [ROOT_KEY]: merged });
  return merged;
}

export async function replaceSection(section, value) {
  const current = await getSettings();
  current[section] = value;
  await chrome.storage.local.set({ [ROOT_KEY]: current });
  return current;
}

export async function pushHistory(entry) {
  const s = await getSettings();
  s.state.history = s.state.history || [];
  s.state.history.unshift({ ...entry, at: Date.now() });
  s.state.history = s.state.history.slice(0, 200);
  await chrome.storage.local.set({ [ROOT_KEY]: s });
}

export async function updateState(patch) {
  const s = await getSettings();
  s.state = { ...s.state, ...patch };
  await chrome.storage.local.set({ [ROOT_KEY]: s });
  return s.state;
}
