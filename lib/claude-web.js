// Free Claude backend via the user's logged-in claude.ai session.
// Requires "cookies" permission and "https://claude.ai/*" host_permissions.
// All requests routed through a real claude.ai tab in MAIN world to bypass
// Cloudflare's JS challenge.

import { trace, traceError } from './trace.js';

const CLAUDE_BASE = 'https://claude.ai';
const ORG_CACHE_KEY = 'exscalp_claude_web_org';
const ROOT_MESSAGE_UUID = '00000000-0000-4000-8000-000000000000';

const COMMON_HEADERS = {
  'Content-Type': 'application/json',
  'anthropic-client-platform': 'web_claude_ai',
  'Accept-Language': 'en-US,en;q=0.9',
};

function uuidV4() {
  return crypto.randomUUID();
}

async function getSessionKey() {
  const c = await chrome.cookies.get({ url: CLAUDE_BASE, name: 'sessionKey' });
  if (!c?.value) {
    throw new Error('Not logged in to claude.ai. Open https://claude.ai, log in, then retry.');
  }
  return c.value;
}

function waitForTabComplete(tabId, timeoutMs) {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (err) => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(onUpdated);
      err ? reject(err) : resolve();
    };
    const onUpdated = (id, info) => {
      if (id === tabId && info.status === 'complete') finish();
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.get(tabId).then((t) => {
      if (t && t.status === 'complete') finish();
    }).catch(() => {});
    setTimeout(() => finish(new Error('Timed out waiting for claude.ai tab to load')), timeoutMs);
  });
}

async function getClaudeTabId() {
  const tabs = await chrome.tabs.query({ url: 'https://claude.ai/*' });
  const ready = tabs.find((t) => t && t.id != null && t.status === 'complete');
  if (ready) return ready.id;
  const loading = tabs.find((t) => t && t.id != null);
  if (loading) {
    await waitForTabComplete(loading.id, 30000);
    return loading.id;
  }
  trace('claude_web', 'opening_hidden_tab', {});
  const win = await chrome.windows.create({
    url: 'https://claude.ai/',
    state: 'minimized',
    focused: false,
  });
  const tabId = win?.tabs?.[0]?.id;
  if (tabId == null) throw new Error('Could not open a claude.ai tab.');
  await waitForTabComplete(tabId, 30000);
  return tabId;
}

async function fetchInClaudeTab(path, init = {}) {
  await getSessionKey();
  const tabId = await getClaudeTabId();
  const url = path.startsWith('http') ? path : `${CLAUDE_BASE}${path}`;
  const merged = {
    ...init,
    headers: { ...COMMON_HEADERS, ...(init.headers || {}) },
  };
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: async (u, opts) => {
      try {
        const res = await fetch(u, { ...opts, credentials: 'include' });
        const text = await res.text();
        return { ok: res.ok, status: res.status, statusText: res.statusText, text };
      } catch (e) {
        return { ok: false, status: 0, statusText: String((e && e.message) || e), text: '' };
      }
    },
    args: [url, merged],
  });
  const r = results && results[0] && results[0].result;
  if (!r) throw new Error('claude.ai tab fetch returned no result');
  return r;
}

async function clearOrgCache() {
  await chrome.storage.local.remove(ORG_CACHE_KEY);
}

function tryParseJSON(s) {
  try { return JSON.parse(s); } catch { return null; }
}

async function listOrgs() {
  const r = await fetchInClaudeTab('/api/organizations', { method: 'GET' });
  if (!r.ok) {
    if (r.status === 401 || r.status === 403) {
      throw new Error('claude.ai session is invalid or expired. Re-log in at https://claude.ai.');
    }
    throw new Error(`claude.ai /organizations failed: HTTP ${r.status}`);
  }
  const orgs = tryParseJSON(r.text);
  if (!Array.isArray(orgs) || orgs.length === 0) {
    throw new Error('No organization found on your claude.ai account.');
  }
  return orgs;
}

async function getOrgListOrdered() {
  const [orgs, activeCookie] = await Promise.all([
    listOrgs(),
    chrome.cookies.get({ url: CLAUDE_BASE, name: 'lastActiveOrg' }),
  ]);
  const activeId = activeCookie?.value;
  return [...orgs].sort((a, b) => {
    if (a.uuid === activeId) return -1;
    if (b.uuid === activeId) return 1;
    const aChat = (a.capabilities || []).some(c => /chat|claude_pro|claude_max|raven|sonnet/i.test(String(c))) ? 1 : 0;
    const bChat = (b.capabilities || []).some(c => /chat|claude_pro|claude_max|raven|sonnet/i.test(String(c))) ? 1 : 0;
    return bChat - aChat;
  });
}

function looksLikeOrgError(body, status) {
  if (status === 404 || status === 403) return true;
  if (typeof body !== 'string' || !body) return false;
  return body.includes('permission_error')
      || body.includes('not_found_error')
      || body.includes('Invalid authorization for organization');
}

async function createConversation(orgId, model, name) {
  const newId = uuidV4();
  const body = { uuid: newId, name: name || '' };
  if (model) body.model = model;
  const r = await fetchInClaudeTab(`/api/organizations/${orgId}/chat_conversations`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const err = new Error(`claude.ai create conversation failed (${r.status}): ${r.text.slice(0, 200)}`);
    err.orgError = looksLikeOrgError(r.text, r.status);
    err.httpStatus = r.status;
    throw err;
  }
  const conv = tryParseJSON(r.text) || {};
  return conv.uuid || newId;
}

async function deleteConversation(orgId, convId) {
  if (!orgId || !convId) return;
  try {
    await fetchInClaudeTab(`/api/organizations/${orgId}/chat_conversations/${convId}`, { method: 'DELETE' });
  } catch (e) {
    traceError('claude_web', 'conversation_delete_failed', e);
  }
}

function extractText(event) {
  if (!event || typeof event !== 'object') return '';
  if (typeof event.completion === 'string') return event.completion;
  if (event.delta) {
    if (typeof event.delta.text === 'string') return event.delta.text;
    if (typeof event.delta.completion === 'string') return event.delta.completion;
  }
  if (event.content_block?.text) return event.content_block.text;
  return '';
}

async function streamCompletion(orgId, convId, prompt, model) {
  const body = {
    prompt,
    parent_message_uuid: ROOT_MESSAGE_UUID,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    personalized_styles: [],
    tools: [],
    attachments: [],
    files: [],
    sync_sources: [],
    rendering_mode: 'messages',
  };
  if (model) body.model = model;

  const r = await fetchInClaudeTab(
    `/api/organizations/${orgId}/chat_conversations/${convId}/completion`,
    {
      method: 'POST',
      headers: { 'Accept': 'text/event-stream' },
      body: JSON.stringify(body),
    },
  );
  if (!r.ok) {
    const err = new Error(`claude.ai completion failed (${r.status}): ${r.text.slice(0, 200)}`);
    err.orgError = looksLikeOrgError(r.text, r.status);
    err.httpStatus = r.status;
    throw err;
  }
  if (!r.text) throw new Error('claude.ai completion: empty response body');

  let assembled = '';
  let errored = null;
  for (const block of r.text.split(/\r?\n\r?\n/)) {
    if (!block) continue;
    for (const rawLine of block.split(/\r?\n/)) {
      if (!rawLine.startsWith('data:')) continue;
      const payload = rawLine.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      const parsed = tryParseJSON(payload);
      if (!parsed) continue;
      if (parsed.error) errored = parsed.error.message || String(parsed.error);
      const piece = extractText(parsed);
      if (piece) assembled += piece;
    }
  }
  if (errored) throw new Error(`claude.ai stream error: ${errored}`);
  if (!assembled.trim()) throw new Error(`claude.ai returned empty text (${r.text.length} bytes).`);
  return assembled.trim();
}

async function runOnce(orgId, system, user, model, name) {
  const convId = await createConversation(orgId, model, name);
  try {
    const prompt = system ? `${system}\n\n---\n\n${user}` : user;
    return await streamCompletion(orgId, convId, prompt, model);
  } finally {
    deleteConversation(orgId, convId);
  }
}

async function tryOrgsInOrder(orgs, attempt) {
  let lastErr;
  for (const org of orgs) {
    try {
      const result = await attempt(org.uuid);
      return { result, org };
    } catch (e) {
      lastErr = e;
      if (!e?.orgError) throw e;
    }
  }
  throw lastErr || new Error('No claude.ai org accepted the request');
}

export async function callClaudeWeb({ system, user, model, conversationName, timeoutMs }) {
  trace('claude_web', 'call_begin', { userPromptLength: (user || '').length, hasSystem: !!system });

  const work = (async () => {
    const cached = await chrome.storage.local.get(ORG_CACHE_KEY);
    const cachedOrgId = cached[ORG_CACHE_KEY];
    if (cachedOrgId) {
      try {
        return await runOnce(cachedOrgId, system, user, model, conversationName);
      } catch (e) {
        if (!e?.orgError) throw e;
        await clearOrgCache();
      }
    }
    const orgs = await getOrgListOrdered();
    const { result, org } = await tryOrgsInOrder(orgs, (orgId) => runOnce(orgId, system, user, model, conversationName));
    await chrome.storage.local.set({ [ORG_CACHE_KEY]: org.uuid });
    return result;
  })();

  if (!timeoutMs) return work;
  return Promise.race([
    work,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`claude.ai timed out after ${timeoutMs}ms`)), timeoutMs)),
  ]);
}

export async function testClaudeWebConnection() {
  await getSessionKey();
  await clearOrgCache();
  const orgs = await getOrgListOrdered();
  const { org } = await tryOrgsInOrder(orgs, async (orgId) => {
    const probeId = await createConversation(orgId);
    await deleteConversation(orgId, probeId);
    return true;
  });
  await chrome.storage.local.set({ [ORG_CACHE_KEY]: org.uuid });
  return { ok: true, orgId: org.uuid, orgName: org.name };
}
