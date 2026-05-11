// Lightweight Exness account queries — balance + positions — using the
// bearer token captured by realtime-hook. Same auth/MAIN-world pattern as
// exness-history and exness-orders.

import { trace, traceError } from './trace.js';

const TRIAL = 'trial15';

async function authGET(tabId, url) {
  const results = await chrome.scripting.executeScript({
    target: { tabId }, world: 'MAIN',
    func: async (u) => {
      const auth = window.__exscalpAuthHeader;
      if (!auth) return { ok: false, status: 0, text: 'no_auth' };
      try {
        const res = await fetch(u, {
          credentials: 'include',
          headers: { 'Authorization': auth, 'Accept': 'application/json' },
        });
        const text = await res.text();
        return { ok: res.ok, status: res.status, text };
      } catch (e) {
        return { ok: false, status: 0, text: String(e?.message || e) };
      }
    },
    args: [url],
  });
  const r = results?.[0]?.result;
  if (!r?.ok) return null;
  try { return JSON.parse(r.text); } catch { return null; }
}

export async function fetchBalance({ tabId, accountId }) {
  if (!tabId || !accountId) return null;
  const url = `https://rtapi-dx.exweb.mobi/rtapi/mt5/${TRIAL}/v1/accounts/${accountId}/balance`;
  return authGET(tabId, url);
}

export async function fetchPositions({ tabId, accountId }) {
  if (!tabId || !accountId) return null;
  const url = `https://rtapi-dx.exweb.mobi/rtapi/mt5/${TRIAL}/v1/accounts/${accountId}/positions`;
  const r = await authGET(tabId, url);
  return r?.positions || [];
}
