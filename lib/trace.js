// 5000-event ring buffer, periodically flushed to chrome.storage.local.
// Exportable as JSON from the popup Logs tab.

const TRACE_KEY = 'exscalp_trace_v1';
const CAP = 5000;
const FLUSH_INTERVAL_MS = 2000;

let buffer = [];
let loaded = false;
let flushScheduled = false;

async function ensureLoaded() {
  if (loaded) return;
  try {
    const stash = await chrome.storage.local.get(TRACE_KEY);
    buffer = Array.isArray(stash[TRACE_KEY]) ? stash[TRACE_KEY] : [];
  } catch {
    buffer = [];
  }
  loaded = true;
}

function scheduleFlush() {
  if (flushScheduled) return;
  flushScheduled = true;
  setTimeout(async () => {
    flushScheduled = false;
    try {
      await chrome.storage.local.set({ [TRACE_KEY]: buffer });
    } catch (e) {
      console.warn('[ExScalp trace] flush failed', e);
    }
  }, FLUSH_INTERVAL_MS);
}

function safeStringifyValue(v, depth = 0) {
  if (v == null) return v;
  if (typeof v === 'string') return v.length > 1000 ? v.slice(0, 1000) + '…' : v;
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  if (depth > 4) return '[depth]';
  if (Array.isArray(v)) return v.slice(0, 50).map(x => safeStringifyValue(x, depth + 1));
  if (typeof v === 'object') {
    const out = {};
    let count = 0;
    for (const k of Object.keys(v)) {
      if (count++ > 50) { out['…'] = `(${Object.keys(v).length - 50} more)`; break; }
      if (/api[_-]?key|password|token|secret|authorization|cookie|sessionkey/i.test(k)) {
        out[k] = '[REDACTED]';
        continue;
      }
      out[k] = safeStringifyValue(v[k], depth + 1);
    }
    return out;
  }
  return String(v);
}

export async function trace(src, type, data, level = 'info') {
  await ensureLoaded();
  const entry = {
    ts: Date.now(),
    src,
    type,
    level,
    data: data === undefined ? null : safeStringifyValue(data),
  };
  buffer.push(entry);
  if (buffer.length > CAP) buffer = buffer.slice(buffer.length - CAP);
  scheduleFlush();
}

export async function traceError(src, type, err, extra) {
  await trace(src, type, {
    message: err?.message || String(err),
    stack: err?.stack ? String(err.stack).split('\n').slice(0, 6).join('\n') : null,
    ...(extra || {}),
  }, 'error');
}

export async function getTrace() {
  await ensureLoaded();
  return buffer.slice();
}

export async function clearTrace() {
  buffer = [];
  loaded = true;
  await chrome.storage.local.set({ [TRACE_KEY]: [] });
}

export async function getTraceStats() {
  await ensureLoaded();
  return {
    count: buffer.length,
    cap: CAP,
    earliest: buffer[0]?.ts || null,
    latest:   buffer[buffer.length - 1]?.ts || null,
  };
}
