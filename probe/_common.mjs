// Shared helpers for the netease-163key-tagger probes.
// No npm dependencies: only Node built-ins (global fetch is available in Node >=18).
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const NODE_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export const BASE = 'https://music.163.com';

// Resolve relative to this file so the probe suite survives a directory rename.
// NOTE: this runtime's node:path has no `fileURLToPath`, so use import.meta.dirname.
export const OUT_DIR = join(import.meta.dirname, 'out');

export function saveJson(name, obj) {
  const p = join(OUT_DIR, name);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(obj, null, 2), 'utf8');
  return p;
}

/** One raw probe: returns status, timing, headers subset and a text preview. */
export async function probe(label, url, opts = {}) {
  const { method = 'GET', body, headers = {}, cookie, referer = BASE + '/', timeoutMs = 12000 } = opts;
  const h = {
    'User-Agent': NODE_UA,
    Accept: '*/*',
    ...(referer ? { Referer: referer } : {}),
    ...(cookie ? { Cookie: cookie } : {}),
    ...headers,
  };
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error('timeout')), timeoutMs);
  const t0 = Date.now();
  const rec = { label, url, method, sentHeaders: h, hasCookie: Boolean(cookie) };
  try {
    const init = { method, headers: h, signal: ac.signal, redirect: 'follow' };
    if (body !== undefined) {
      if (typeof body === 'string') init.body = body;
      else {
        init.body = new URLSearchParams(body).toString();
        init.headers['Content-Type'] = 'application/x-www-form-urlencoded';
      }
    }
    const res = await fetch(url, init);
    const text = await res.text();
    rec.status = res.status;
    rec.ms = Date.now() - t0;
    rec.contentType = res.headers.get('content-type');
    rec.setCookie = res.headers.getSetCookie ? res.headers.getSetCookie() : undefined;
    rec.bytes = text.length;
    rec.text = text.length > 6000 ? text.slice(0, 6000) + `…[truncated ${text.length - 6000}B]` : text;
    try {
      rec.json = JSON.parse(text);
    } catch {
      rec.json = null;
    }
  } catch (e) {
    rec.ms = Date.now() - t0;
    rec.error = `${e.name}: ${e.message}${e.cause ? ' | cause=' + (e.cause.message || e.cause.code) : ''}`;
  } finally {
    clearTimeout(timer);
  }
  return rec;
}

export function summarize(rec) {
  const code =
    rec.json && typeof rec.json === 'object'
      ? rec.json.code !== undefined
        ? `json.code=${rec.json.code}`
        : Object.keys(rec.json).slice(0, 6).join(',')
      : (rec.error ?? 'non-json');
  return `${rec.status ?? 'ERR'} ${rec.ms}ms ${rec.bytes ?? 0}B  ${code}`;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
