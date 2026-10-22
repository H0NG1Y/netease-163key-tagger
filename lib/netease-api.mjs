/**
 * netease-api.mjs — 匿名（无 Cookie）网易云音乐元数据查询，用于生成 163key。
 *
 * 设计约束（与 Lead 冻结的接口一致，见 notes/api.md）：
 *   searchSong({ keyword, limit })                 -> Array<{ id, name, artists:[{id,name}], album:{id,name}, durationMs }>
 *                                                     durationMs 契约：有限正数**毫秒**；接口没给则为 null（绝不为 0）
 *   getSongDetail(id)                              -> meta（14 个字段，顺序固定；format 是占位值）
 *   to163Meta(detail, { format, localDurationMs }) -> meta（14 个字段，顺序固定，纯函数、不做网络请求）
 *
 * 候选打分 / 文件名解析的**唯一权威实现是 lib/match.mjs**（parseFilename / pickBest /
 * DURATION_TOLERANCE_MS / DURATION_RANK_MS），由 apply.mjs 使用。本文件不再自带第二套阈值。
 *
 * 只依赖 Node 内置模块（本环境无任何 npm 依赖）。所有请求都是真实 HTTP。
 *
 * 实测结论（证据在 notes/api.md，样本见 probe/out/*.json）：
 *   - searchSong 主链路  POST /api/cloudsearch/pc        匿名可用，单次响应信息最全
 *                备链路  GET  /api/search/get/web        匿名可用（网页版搜索接口）
 *                备链路  POST /api/search/get
 *   - detail    主链路  GET  /api/v3/song/detail?c=[{"id":N}]   匿名可用
 *               备链路  GET  /api/song/detail/?ids=[N]          匿名可用（唯一给出 transName 的接口）
 *   - mp3DocId  来源    GET  /api/song/enhance/player/url?ids=[N]&br=...  返回的 data[0].md5
 *                      实测：id=1809412694 -> md5=cde6b150f488f81c8f0d9b374d2fe2fb，
 *                      与真实样本 163key 中的 mp3DocId 完全一致；该 md5 同时也是 CDN 对象名。
 *                      匿名拿不到时（VIP/无版权：code 404 / -110，url=null）回退，见 FALLBACK_MD5_KIND。
 *   - albumPicDocId 必须用 al.pic_str / album.picId_str（18 位字符串）。
 *                      数字型 al.pic / album.picId 超出 2^53 会被 JSON 解析成 ...800 这种错值。
 *
 * 环境变量（可选，均有默认值）：
 *   NETEASE_COOKIE              -- 若提供则随请求发送，可提高 player/url 的 md5 命中率
 *   NETEASE_TIMEOUT_MS          -- 单请求超时，默认 10000
 *   NETEASE_MIN_INTERVAL_MS     -- 请求最小间隔（节流），默认 300
 *   NETEASE_RETRIES             -- 失败重试次数，默认 2
 */

import { createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// 常量（供 Lead 的其他模块复用/交叉校验）
// ---------------------------------------------------------------------------

export const NETEASE_BASE = 'https://music.163.com';

/** 163key 明文前缀（明文 = 该前缀 + 紧凑 JSON）。 */
export const NETEASE_163KEY_PLAIN_PREFIX = 'music:';

/** 163key 在标签里的固定前缀。 */
export const NETEASE_163KEY_TAG_PREFIX = "163 key(Don't modify):";

/** meta 字段顺序（冻结，不要改）。 */
export const META_FIELD_ORDER = Object.freeze([
  'musicId',
  'musicName',
  'artist',
  'albumId',
  'album',
  'albumPicDocId',
  'albumPic',
  'bitrate',
  'mp3DocId',
  'duration',
  'mvId',
  'alias',
  'transNames',
  'format',
]);

export const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/**
 * 拿不到真实 mp3DocId 时的回退策略。
 *   'synthetic'（默认）: md5(`netease-163key-tagger|${musicId}|${format}`)
 *                        形状合法（32 位十六进制）、每首歌唯一、可重复（幂等）。
 *                        理由：已知一个"形状合法但与真实对象不符"的 md5 是被客户端接受的
 *                        （163marker 就是写本地文件 md5），而空字符串没有任何先例；
 *                        每首歌唯一可避免客户端按 docId 记账时互相串台。
 *   'empty'            : ''（最诚实的"未知"）
 *   'zeros'            : '0'.repeat(32)
 */
export const FALLBACK_MD5_KIND = 'synthetic';

// ---------------------------------------------------------------------------
// 错误类型：所有可读信息都放在 message 里
// ---------------------------------------------------------------------------

export class NeteaseApiError extends Error {
  constructor(message, { url, status, code, body, attempts, cause } = {}) {
    super(message);
    this.name = 'NeteaseApiError';
    this.url = url;
    this.status = status;
    this.code = code;
    this.body = body;
    this.attempts = attempts;
    if (cause) this.cause = cause;
  }
}

function snippet(s, n = 220) {
  if (typeof s !== 'string') return '';
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}

// ---------------------------------------------------------------------------
// 配置 + 统计（统计通过 getApiStats() 读取，不污染 meta）
// ---------------------------------------------------------------------------

const ENV_INT = (name, dflt) => {
  const v = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(v) && v >= 0 ? v : dflt;
};

const config = {
  cookie: process.env.NETEASE_COOKIE || '',
  timeoutMs: ENV_INT('NETEASE_TIMEOUT_MS', 10_000),
  minIntervalMs: ENV_INT('NETEASE_MIN_INTERVAL_MS', 300),
  retries: ENV_INT('NETEASE_RETRIES', 2),
  /** mp3DocId 回退策略，见 FALLBACK_MD5_KIND 注释 */
  md5Fallback: FALLBACK_MD5_KIND,
};

export function configureNeteaseApi(partial = {}) {
  Object.assign(config, partial);
  return { ...config };
}

const stats = {
  requests: 0,
  retries: 0,
  timeouts: 0,
  byEndpoint: {}, // endpoint -> { ok, fail, totalMs, lastStatus, lastCode }
  warnings: [],
};

function stat(endpoint, { ok, status, code, ms }) {
  const e = (stats.byEndpoint[endpoint] ??= { ok: 0, fail: 0, totalMs: 0, lastStatus: null, lastCode: null });
  if (ok) e.ok++;
  else e.fail++;
  e.totalMs += ms;
  e.lastStatus = status ?? null;
  e.lastCode = code ?? null;
}

function warn(msg) {
  const line = `${new Date().toISOString()} ${msg}`;
  stats.warnings.push(line);
  if (stats.warnings.length > 200) stats.warnings.shift();
  if (process.env.NETEASE_DEBUG) console.warn('[netease-api] ' + msg);
}

/** 运行时统计快照（额外接口，不影响冻结签名）。 */
export function getApiStats() {
  const byEndpoint = {};
  for (const [k, v] of Object.entries(stats.byEndpoint)) {
    byEndpoint[k] = {
      ...v,
      avgMs: v.ok + v.fail > 0 ? Math.round(v.totalMs / (v.ok + v.fail)) : 0,
    };
  }
  return {
    ...config,
    cookieConfigured: Boolean(config.cookie),
    requests: stats.requests,
    retries: stats.retries,
    timeouts: stats.timeouts,
    warnings: [...stats.warnings],
    byEndpoint,
  };
}

export function resetApiStats() {
  stats.requests = 0;
  stats.retries = 0;
  stats.timeouts = 0;
  stats.byEndpoint = {};
  stats.warnings.length = 0;
}

// ---------------------------------------------------------------------------
// 节流：全模块串行，保证两次请求开始之间至少间隔 minIntervalMs
// ---------------------------------------------------------------------------

let gate = Promise.resolve();
let lastStart = 0;

function throttle() {
  const run = gate.then(async () => {
    const wait = lastStart + config.minIntervalMs - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastStart = Date.now();
  });
  // gate 必须在任何情况下都不被 rejected 卡死
  gate = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// 底层请求
// ---------------------------------------------------------------------------

/** 限流/瞬时故障才重试；-110（需登录）、-462（需绑定手机）重试没有意义。 */
const RETRYABLE_CODES = new Set([405]);
const AUTH_CODES = new Map([
  [-110, 'need login'],
  [-462, 'need bind phone'],
  [301, 'need login (download endpoint)'],
]);

function isRetryableStatus(s) {
  return s === 429 || s === 408 || (s >= 500 && s <= 599);
}

async function rawFetch(url, { method = 'GET', form, endpoint, timeoutMs = config.timeoutMs }) {
  const headers = {
    'User-Agent': DEFAULT_USER_AGENT,
    Referer: NETEASE_BASE + '/',
    Accept: 'application/json, text/plain, */*',
  };
  if (config.cookie) headers.Cookie = config.cookie;
  let body;
  if (form) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(form).toString();
  }
  const ac = new AbortController();
  const timer = setTimeout(() => {
    stats.timeouts++;
    ac.abort();
  }, timeoutMs);
  const started = Date.now();
  try {
    const res = await fetch(url, { method, headers, body, signal: ac.signal, redirect: 'follow' });
    const text = await res.text();
    return { res, text, ms: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 请求 + 重试 + 错误包装。返回解析后的 JSON。
 * @param {string} urlWithQuery 完整 URL（已含 query）
 * @param {{method?:string, form?:object, endpoint:string, timeoutMs?:number, retries?:number, allowCodes?:number[]}} opts
 */
async function requestJson(urlWithQuery, opts) {
  const { method = 'GET', form, endpoint, timeoutMs = config.timeoutMs } = opts;
  const retries = opts.retries ?? config.retries;
  const allowCodes = new Set(opts.allowCodes ?? []);
  const attempts = retries + 1;
  let lastErr;

  for (let i = 0; i < attempts; i++) {
    if (i > 0) {
      stats.retries++;
      // 指数退避 + 抖动；被限流时退得更久
      const backoff = Math.min(4000, 400 * 2 ** (i - 1)) + Math.floor(Math.random() * 150);
      const penalty = lastErr && lastErr.retryAfterMs ? lastErr.retryAfterMs : 0;
      await sleep(backoff + penalty);
    }
    await throttle();
    stats.requests++;

    let out;
    try {
      out = await rawFetch(urlWithQuery, { method, form, endpoint, timeoutMs });
    } catch (e) {
      const timedOut = e && (e.name === 'AbortError' || e.code === 'ABORT_ERR');
      lastErr = new NeteaseApiError(
        `${endpoint}: ${timedOut ? `请求超时（>${timeoutMs}ms）` : '网络错误'} ${urlWithQuery} — ${e?.message ?? e}`,
        { url: urlWithQuery, attempts: i + 1, cause: e },
      );
      stat(endpoint, { ok: false, status: null, code: null, ms: timeoutMs });
      if (i === attempts - 1) throw lastErr;
      continue;
    }

    const { res, text, ms } = out;
    const retryAfter = Number.parseInt(res.headers.get('retry-after') ?? '', 10);

    let json = null;
    let parseErr = null;
    try {
      json = JSON.parse(text);
    } catch (e) {
      parseErr = e;
    }

    if (parseErr) {
      const bad = new NeteaseApiError(
        `${endpoint}: 响应不是 JSON（HTTP ${res.status} ${res.statusText}）${urlWithQuery} — 前 220 字符: ${snippet(text)}`,
        { url: urlWithQuery, status: res.status, body: text, attempts: i + 1 },
      );
      stat(endpoint, { ok: false, status: res.status, code: null, ms });
      lastErr = bad;
      if (isRetryableStatus(res.status) && i < attempts - 1) continue;
      throw bad;
    }

    const code = typeof json.code === 'number' ? json.code : null;

    if (!res.ok || (code !== null && code !== 200 && !allowCodes.has(code))) {
      const why = AUTH_CODES.get(code);
      const err = new NeteaseApiError(
        `${endpoint}: 接口返回失败（HTTP ${res.status}${code !== null ? `, code=${code}` : ''}）` +
          `${why ? ` [${why}]` : ''} ${urlWithQuery} — ${snippet(text, 160)}` +
          `${config.cookie ? '' : '（当前未配置 NETEASE_COOKIE）'}`,
        { url: urlWithQuery, status: res.status, code, body: text, attempts: i + 1 },
      );
      if (retryAfter > 0) err.retryAfterMs = retryAfter * 1000;
      stat(endpoint, { ok: false, status: res.status, code, ms });
      lastErr = err;
      const retryable = isRetryableStatus(res.status) || (code !== null && RETRYABLE_CODES.has(code));
      if (retryable && i < attempts - 1) continue;
      throw err;
    }

    stat(endpoint, { ok: true, status: res.status, code, ms });
    return json;
  }
  throw lastErr ?? new NeteaseApiError(`${endpoint}: 未知失败 ${urlWithQuery}`, { url: urlWithQuery });
}

function qs(params) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) sp.set(k, String(v));
  }
  return sp.toString();
}

// ---------------------------------------------------------------------------
// 搜索
// ---------------------------------------------------------------------------

/** 把各接口形态各异的 song 对象统一成 { id, name, artists, album, durationMs }。
 *  durationMs 契约：**有限正数毫秒**；接口没给就是 `null`（不是 0）。
 *  必须是 null 而不是 0 —— 打分层用 `Number.isFinite` 区分「时长未知」与「时长为 0」，
 *  写 0 会被当成「明确对不上」而触发假的 duration-mismatch 闸门。apply.mjs 的时长闸门依赖这个契约。
 */
function mapSong(song) {
  const ar = song.ar ?? song.artists ?? [];
  const al = song.al ?? song.album ?? {};
  const dtRaw = song.dt ?? song.duration;
  const dt = Number(dtRaw);
  return {
    id: Number(song.id),
    name: String(song.name ?? ''),
    artists: (Array.isArray(ar) ? ar : []).map((a) => ({ id: Number(a?.id), name: String(a?.name ?? '') })),
    album: { id: Number(al?.id), name: String(al?.name ?? '') },
    durationMs: Number.isFinite(dt) && dt > 0 ? dt : null,
    // 非冻结附加字段：便于调用方/探针判断来源与排序
    raw: song,
  };
}

const SEARCH_CHAIN = [
  {
    name: 'cloudsearch/pc',
    url: () => `${NETEASE_BASE}/api/cloudsearch/pc`,
    opts: ({ keyword, limit }) => ({
      method: 'POST',
      form: { s: keyword, type: 1, offset: 0, limit, total: true },
    }),
    pick: (json) => json?.result?.songs,
  },
  {
    name: 'search/get/web',
    url: ({ keyword, limit }) => `${NETEASE_BASE}/api/search/get/web?${qs({ s: keyword, type: 1, offset: 0, limit })}`,
    opts: () => ({ method: 'GET' }),
    pick: (json) => json?.result?.songs,
  },
  {
    name: 'search/get',
    url: () => `${NETEASE_BASE}/api/search/get`,
    opts: ({ keyword, limit }) => ({ method: 'POST', form: { s: keyword, type: 1, offset: 0, limit } }),
    pick: (json) => json?.result?.songs,
  },
];

/**
 * 关键字搜索（歌名/歌手/混合）。返回 [] 表示确实没有结果，不抛错。
 * @param {{keyword:string, limit?:number}} p
 */
export async function searchSong({ keyword, limit = 10 } = {}) {
  if (!keyword || !String(keyword).trim()) {
    throw new NeteaseApiError('searchSong: keyword 不能为空', {});
  }
  const kw = String(keyword).trim();
  const args = { keyword: kw, limit: Math.max(1, Math.min(100, Number(limit) || 10)) };
  const failures = [];

  for (const ep of SEARCH_CHAIN) {
    const url = ep.url(args);
    try {
      const json = await requestJson(url, { endpoint: `search:${ep.name}`, ...ep.opts(args) });
      const songs = ep.pick(json);
      if (Array.isArray(songs)) return songs.map(mapSong);
      failures.push(`${ep.name}: 响应里没有 result.songs`);
    } catch (e) {
      failures.push(`${ep.name}: ${e.message}`);
    }
  }
  throw new NeteaseApiError(
    `searchSong("${kw}") 全部搜索链路失败：\n  - ` + failures.join('\n  - '),
    { url: NETEASE_BASE + '/api/cloudsearch/pc' },
  );
}

// ---------------------------------------------------------------------------
// 详情
// ---------------------------------------------------------------------------

/**
 * 三种输入形态统一成一个内部结构（coerceDetail）：
 *   1) "meta 形态"       —— getSongDetail()/to163Meta() 的返回值（有 musicId + mp3DocId + musicName）
 *   2) "normalized 形态" —— 本文件内部结构（有 albumPicDocIdRaw 或 qualities）
 *   3) "raw 形态"        —— 接口原始 song（有 al/ar 或 album/artists）
 * 曾经踩过的坑：把 1) 当成 3) 再 normalize 一次，会把 musicName/artist/albumPicDocId/duration 全部丢成空值。
 */
function coerceDetail(x) {
  if (!x || typeof x !== 'object') throw new NeteaseApiError('to163Meta: detail 必须是对象', {});
  const isMeta = 'musicId' in x && 'mp3DocId' in x && ('musicName' in x || 'albumPic' in x);
  if (isMeta) {
    return {
      id: Number(x.musicId),
      name: String(x.musicName ?? ''),
      artists: (Array.isArray(x.artist) ? x.artist : []).map((a) =>
        Array.isArray(a) ? { id: Number(a[1]), name: String(a[0]) } : { id: Number(a?.id), name: String(a?.name ?? '') },
      ),
      album: { id: Number(x.albumId), name: String(x.album ?? ''), picUrl: String(x.albumPic ?? ''), pic_str: String(x.albumPicDocId ?? '') },
      albumPicDocIdRaw: x.albumPicDocId ? String(x.albumPicDocId) : null,
      albumNumericId: null,
      albumPic: String(x.albumPic ?? ''),
      durationMs: Number.isFinite(Number(x.duration)) && Number(x.duration) > 0 ? Number(x.duration) : null,
      mvId: Number(x.mvId) || 0,
      alias: Array.isArray(x.alias) ? x.alias.map(String) : [],
      songTransNames: Array.isArray(x.transNames) ? x.transNames.map(String) : null,
      transName: null,
      qualities: x.qualities ?? {},
      bitrateHint: Number(x.bitrate) || null,
      md5Hint: isHex32(x.mp3DocId) ? x.mp3DocId.toLowerCase() : null,
    };
  }
  if ('albumPicDocIdRaw' in x || 'qualities' in x || 'durationMs' in x) {
    // 已经是内部结构；只补齐缺的键，避免 undefined 透传
    return {
      ...normalizeRaw({}),
      ...x,
      album: typeof x.album === 'object' && x.album !== null ? x.album : {},
      qualities: x.qualities ?? {},
      bitrateHint: x.bitrateHint ?? null,
      md5Hint: x.md5Hint ?? null,
    };
  }
  return normalizeRaw(x);
}

/** 从 v3/song/detail 或 song/detail 的原始 song 里抽出我们需要的字段（不改变原始数据）。 */
function normalizeRaw(song) {
  const al = (song.al ?? song.album) ?? {};
  const album = typeof al === 'object' && al !== null ? al : {};
  const ar = song.ar ?? song.artists ?? [];
  const dtRaw = song.dt ?? song.duration;
  const dt = Number(dtRaw);
  return {
    id: Number(song.id),
    name: String(song.name ?? ''),
    artists: (Array.isArray(ar) ? ar : []).map((a) => ({ id: Number(a?.id), name: String(a?.name ?? '') })),
    album,
    // 数字型 pic/picId 会丢精度（18 位 > 2^53），只是最后兜底
    albumPicDocIdRaw: album.pic_str ?? album.picId_str ?? null,
    albumNumericId: album.pic ?? album.picId ?? null,
    albumPic: album.picUrl ?? null,
    durationMs: Number.isFinite(dt) && dt > 0 ? dt : null,
    mvId: Number(song.mv ?? song.mvid ?? 0) || 0,
    alias: Array.isArray(song.alia ?? song.alias) ? (song.alia ?? song.alias).map(String) : [],
    songTransNames: Array.isArray(song.transNames) ? song.transNames.map(String) : Array.isArray(song.tns) ? song.tns.map(String) : null,
    transName: typeof song.transName === 'string' && song.transName ? song.transName : null,
    qualities: {
      h: song.h ?? song.hMusic ?? null,
      m: song.m ?? song.mMusic ?? null,
      l: song.l ?? song.lMusic ?? null,
      sq: song.sq ?? null,
      hr: song.hr ?? null,
    },
    privileges: song.privilege ?? song.privileges ?? null,
    bitrateHint: null,
    md5Hint: null,
  };
}

async function fetchDetailRaw(id) {
  const full = [];
  const errors = [];

  // 主链路：v3（现代网页版接口，al 里带 pic_str）
  try {
    const url = `${NETEASE_BASE}/api/v3/song/detail?${qs({ c: JSON.stringify([{ id }]) })}`;
    const json = await requestJson(url, { endpoint: 'detail:v3/song/detail' });
    const songs = json?.songs;
    if (Array.isArray(songs) && songs.length) full.push(normalizeRaw(songs[0]));
    else errors.push('v3/song/detail: songs 为空');
  } catch (e) {
    errors.push(e.message);
  }

  // 备链路：老 song/detail —— 唯一提供 song.transName 的接口
  try {
    const url = `${NETEASE_BASE}/api/song/detail/?${qs({ ids: JSON.stringify([id]) })}`;
    const json = await requestJson(url, { endpoint: 'detail:song/detail' });
    const songs = json?.songs;
    if (Array.isArray(songs) && songs.length) full.push(normalizeRaw(songs[0]));
    else errors.push('song/detail: songs 为空');
  } catch (e) {
    errors.push(e.message);
  }

  if (!full.length) {
    throw new NeteaseApiError(`getSongDetail(${id}): 两条详情链路都失败：\n  - ` + errors.join('\n  - '), {
      url: `${NETEASE_BASE}/api/v3/song/detail`,
    });
  }

  // 合并：前者提供结构，后者补充 transName / 缺失字段
  const merged = { ...full[0] };
  for (const extra of full.slice(1)) {
    for (const [k, v] of Object.entries(extra)) {
      const cur = merged[k];
      const empty = cur === null || cur === undefined || cur === '' || (Array.isArray(cur) && cur.length === 0);
      if (empty && v !== null && v !== undefined && v !== '') merged[k] = v;
    }
  }
  return { raw: merged, sources: full.length, errors };
}

// ---------------------------------------------------------------------------
// mp3DocId：/api/song/enhance/player/url 的 data[0].md5
// ---------------------------------------------------------------------------

/**
 * 尝试拿到真实 mp3DocId（= 服务端 CDN 对象 md5）。
 * 匿名可用性：非 VIP / 有版权的歌会返回 url + md5；VIP 或无版权返回 code 404 / -110，url=null。
 * @returns {Promise<{md5:string|null, br:number|null, type:string|null, timeMs:number|null, level:string|null, endpoint:string, code:number|null}>}
 */
export async function getMp3DocId(id, { br = 320000 } = {}) {
  const attempts = [
    {
      endpoint: 'url:player/url',
      url: `${NETEASE_BASE}/api/song/enhance/player/url?${qs({ ids: JSON.stringify([id]), br })}`,
      allowCodes: [404, -110, 200],
    },
    {
      endpoint: 'url:player/url/v1',
      url: `${NETEASE_BASE}/api/song/enhance/player/url/v1?${qs({ ids: JSON.stringify([id]), level: 'exhigh', encodeType: 'mp3' })}`,
      allowCodes: [404, -110, 200],
    },
  ];
  const tried = [];
  for (const a of attempts) {
    try {
      const json = await requestJson(a.url, { endpoint: a.endpoint, allowCodes: a.allowCodes });
      const d = Array.isArray(json?.data) ? json.data[0] : null;
      const info = {
        md5: d && typeof d.md5 === 'string' && /^[0-9a-f]{32}$/i.test(d.md5) ? d.md5.toLowerCase() : null,
        br: d?.br ?? null,
        type: d?.type ?? null,
        timeMs: d?.time ?? null,
        level: d?.level ?? null,
        code: typeof d?.code === 'number' ? d.code : (json?.code ?? null),
        endpoint: a.endpoint,
      };
      if (info.md5) return info;
      tried.push(`${a.endpoint}: code=${info.code} md5=null`);
    } catch (e) {
      tried.push(`${a.endpoint}: ${e.message}`);
    }
  }
  warn(`getMp3DocId(${id}): 未取得真实 md5 —— ${tried.join(' | ')}`);
  return { md5: null, br: null, type: null, timeMs: null, level: null, code: null, endpoint: 'none', tried };
}

/** 回退值：见 FALLBACK_MD5_KIND。 */
export function md5FallbackFor(musicId, format) {
  switch (config.md5Fallback) {
    case 'empty':
      return '';
    case 'zeros':
      return '0'.repeat(32);
    case 'synthetic':
    default:
      return createHash('md5').update(`netease-163key-tagger|${musicId}|${format}`).digest('hex');
  }
}

// ---------------------------------------------------------------------------
// 组装 meta
// ---------------------------------------------------------------------------

const isHex32 = (s) => typeof s === 'string' && /^[0-9a-f]{32}$/i.test(s);

/** albumPicDocId：pic_str 优先；否则取 picUrl 最后一段数字（实测二者恒等）。 */
function albumPicDocIdOf(detail) {
  if (detail.albumPicDocIdRaw) return String(detail.albumPicDocIdRaw);
  const pic = detail.albumPic ?? '';
  const m = /\/(\d+)\.\w+(?:\?|$)/.exec(pic);
  if (m) return m[1];
  if (detail.albumNumericId !== null && detail.albumNumericId !== undefined) {
    warn(`albumPicDocId: 只有数字型 pic 可用（可能已丢精度）：${detail.albumNumericId}`);
    return String(detail.albumNumericId);
  }
  warn('albumPicDocId: 接口未提供 pic_str / picUrl，回退为空字符串');
  return '';
}

function aliasOf(detail) {
  return Array.isArray(detail.alias) ? detail.alias.map(String) : [];
}

/**
 * transNames：真实样本里是 []。
 * 接口只提供单数的 song.transName（如 347230 -> "Boundless Oceans, Vast Skies"），
 * 没有数组形态的字段；这里按"字段名是 transName 的复数"推断包成数组（标注为推测，可用 opts 覆盖）。
 */
function transNamesOf(detail, opts) {
  if (Array.isArray(opts.transNames)) return opts.transNames.map(String);
  if (detail.songTransNames) return detail.songTransNames;
  if (opts.noTransNames) return [];
  if (detail.transName) return [detail.transName];
  return [];
}

function bitrateOf(detail, format, opts) {
  if (Number.isFinite(opts.bitrate) && opts.bitrate > 0) return Math.round(opts.bitrate);
  // 上游 meta 已经算好的码率（getSongDetail 的返回值里带的）优先复用，避免二次推导漂移
  if (Number.isFinite(detail.bitrateHint) && detail.bitrateHint > 0) return Math.round(detail.bitrateHint);
  const q = detail.qualities ?? {};
  const num = (x) => (x && Number.isFinite(Number(x.bitrate ?? x.br)) ? Number(x.bitrate ?? x.br) : null);
  // FLAC 用无损对象的码率比 320k 更接近真实；仍是服务端值，最准的是本地文件码率（见 notes/api.md）
  const order = format === 'flac' ? [q.sq, q.hr, q.h, q.m, q.l] : [q.h, q.m, q.l];
  for (const x of order) {
    const v = num(x);
    if (v) return v;
  }
  warn(`bitrate: 接口未提供可用码率，回退 320000（format=${format}）`);
  return 320000;
}

/**
 * duration 取值：**接口 dt 优先**，接口拿不到时才用本地实测值。
 * 依据（probe/05 保真度节，两种取法对同一个真实样本做逐字段比对）：
 *   - 只用接口值 → 与真实标签 **14/14** 逐字段一致（含 duration 213702），明文只差 CDN 分片主机名；
 *   - 用本地实测覆盖 → 13/14，duration 变成 213744（差 42ms），反而与真实标签不一致。
 * 接口 dt 还不依赖本地解码精度（MP3 本地时长曾因误同步算出 76 分钟的荒唐值）。
 * 本地实测值仍然重要：它是 apply.mjs 时长闸门（DURATION_TOLERANCE_MS）的输入，只是不该覆盖接口值。
 */
function durationOf(detail, opts, format, musicId) {
  const d = Number(detail.durationMs);
  if (Number.isFinite(d) && d > 0) return Math.round(d);
  if (Number.isFinite(opts.localDurationMs) && opts.localDurationMs > 0) return Math.round(opts.localDurationMs);
  warn(`duration: 接口 dt 与 localDurationMs 均缺失，回退 0（musicId=${musicId}）`);
  return 0;
}

function normalizeFormat(f) {
  const s = String(f ?? '').toLowerCase();
  if (s === 'mp3' || s === 'flac') return s;
  warn(`format: 传入 ${JSON.stringify(f)} 不是 mp3/flac，按 mp3 处理`);
  return 'mp3';
}

/**
 * 数值字段一律走这里：绝不把 NaN 放出去。
 * NaN 是最阴的形态 —— typeof 是 'number'、JSON.stringify 变成 null，
 * 不显式 Number.isFinite 检查根本发现不了（Lead 在 to163Meta 上就踩过这个坑）。
 */
function safeInt(v, fallback, what, warnOnFallback = true) {
  const n = typeof v === 'number' ? v : Number(v);
  if (Number.isFinite(n)) return Math.trunc(n);
  if (warnOnFallback) warn(`to163Meta: ${what} 非有限数值（${JSON.stringify(v)}），回退 ${fallback}`);
  return fallback;
}

/**
 * 由 detail（兼容 getSongDetail 的返回值，或任何原始 song 对象）+ 本地文件信息生成 meta。
 * 纯函数：不发网络请求。字段顺序恒为 META_FIELD_ORDER（14 个键，无多余键）。
 *
 * @param {object} detail getSongDetail() 的返回值，或原始 song 对象（含 al/ar/dt 亦可）
 * @param {{format:'mp3'|'flac', localDurationMs?:number, bitrate?:number, mp3DocId?:string, transNames?:string[], noTransNames?:boolean}} opts
 */
export function to163Meta(detail, opts = {}) {
  const d = coerceDetail(detail);
  const format = normalizeFormat(opts.format ?? detail?.format ?? 'mp3');
  const musicId = safeInt(d.id, 0, 'musicId');

  let docId = null;
  if (isHex32(opts.mp3DocId)) docId = opts.mp3DocId.toLowerCase();
  else if (isHex32(detail?.mp3DocId)) docId = detail.mp3DocId.toLowerCase();
  else if (d.md5Hint) docId = d.md5Hint;
  else docId = md5FallbackFor(musicId, format);

  const meta = {
    musicId,
    musicName: String(d.name ?? ''),
    artist: (Array.isArray(d.artists) ? d.artists : []).map((a) =>
      Array.isArray(a) ? [String(a[0]), safeInt(a[1], 0, 'artist.id', false)] : [String(a?.name ?? ''), safeInt(a?.id, 0, 'artist.id', false)],
    ),
    albumId: safeInt(d.album?.id, 0, 'albumId', false),
    album: String(d.album?.name ?? ''),
    albumPicDocId: albumPicDocIdOf(d),
    albumPic: String(d.albumPic ?? ''),
    bitrate: bitrateOf(d, format, opts),
    mp3DocId: docId,
    duration: durationOf(d, opts, format, musicId),
    mvId: safeInt(d.mvId, 0, 'mvId', false),
    alias: aliasOf(d),
    transNames: transNamesOf(d, opts),
    format,
  };

  // 用固定顺序重建，保证 Object.keys(meta) === META_FIELD_ORDER
  const ordered = {};
  for (const k of META_FIELD_ORDER) ordered[k] = meta[k];
  if (Object.keys(ordered).length !== META_FIELD_ORDER.length) {
    throw new NeteaseApiError('to163Meta: 内部错误，字段数量与 META_FIELD_ORDER 不一致', {});
  }
  // 最后一道自检：NaN / undefined 一律不允许出现在结果里
  for (const k of META_FIELD_ORDER) {
    if (ordered[k] === undefined) throw new NeteaseApiError(`to163Meta: 字段 ${k} 为 undefined`, {});
    if (typeof ordered[k] === 'number' && !Number.isFinite(ordered[k])) {
      throw new NeteaseApiError(`to163Meta: 字段 ${k} 是非法数值 ${ordered[k]}`, {});
    }
  }
  return ordered;
}

// ---------------------------------------------------------------------------
// getSongDetail：网络版 meta（format 为占位值）
// ---------------------------------------------------------------------------

/**
 * 按 songId 取回 meta（14 字段，顺序固定）。
 *
 * 注意：`format` 是占位值 'mp3' —— 真正的容器格式只能从本地文件判断，
 * 请始终用 to163Meta(detail, { format: <本地文件格式>, localDurationMs }) 生成最终写入值。
 *
 * 额外能力（不改变上面的调用方式）：传入数组时返回数组，用于批量。
 *
 * @param {number|number[]} id
 */
export async function getSongDetail(id) {
  if (Array.isArray(id)) {
    const out = [];
    for (const one of id) out.push(await getSongDetail(one));
    return out;
  }
  const numId = Number(id);
  if (!Number.isFinite(numId) || numId <= 0) {
    throw new NeteaseApiError(`getSongDetail: id 非法: ${JSON.stringify(id)}`, {});
  }

  const { raw, sources, errors } = await fetchDetailRaw(numId);
  const doc = await getMp3DocId(numId);

  let format = 'mp3';
  if (doc.type === 'flac') {
    // 服务端对象是无损：只是提示，不代表本地文件是 flac
    warn(`getSongDetail(${numId}): 服务端对象类型为 flac，但本地文件格式未知，format 仍按占位 mp3`);
  }
  const detailForMeta = { ...raw, mp3DocId: doc.md5 ?? undefined };
  const meta = to163Meta(detailForMeta, { format, localDurationMs: undefined });
  if (!doc.md5) {
    warn(
      `getSongDetail(${numId}): mp3DocId 用回退值 ${meta.mp3DocId}（${config.md5Fallback}）；` +
        `接口未返回真实 md5（${doc.tried?.join(' | ') ?? doc.code}）`,
    );
  }
  if (errors.length) warn(`getSongDetail(${numId}): 部分链路失败 ${errors.join(' || ')}（sources=${sources}）`);
  return meta;
}

// ---------------------------------------------------------------------------
// 额外工具（非冻结，方便 Lead/探针复用）
// ---------------------------------------------------------------------------
//
// 【已删除】原 parseFileName() 与 pickBestMatch()：文件名解析与候选打分（含时长阈值）
// 的唯一权威实现是 `lib/match.mjs`（parseFilename / pickBest / DURATION_TOLERANCE_MS / DURATION_RANK_MS），
// 由 apply.mjs 主流程使用。本文件曾自带一套等价实现，导致「第二套阈值」有漂移风险，故整体移除。
// 需要打分请 `import { parseFilename, pickBest, DURATION_TOLERANCE_MS } from './match.mjs'`。

/** 交叉校验用：163key 兼容的紧凑 JSON（无空格、字段顺序固定）。 */
export function metaTo163Plain(meta) {
  const ordered = {};
  for (const k of META_FIELD_ORDER) ordered[k] = meta[k];
  return NETEASE_163KEY_PLAIN_PREFIX + JSON.stringify(ordered);
}
