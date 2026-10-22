// Probe 10 — 搜索深度 / total(offset) 语义 / 归一化保真度
//
// 背景：Lead 发现匿名搜索是「UGC 优先」，原唱被埋在 20~100 名。本脚本把这件事
// 变成可复跑的数字，并回答三个问题：
//   1) limit 变化时 songCount 为什么跟着变？offset 能不能翻页？100 是不是硬上限？
//   2) 五个搜索端点返回的「结果集」是否一致，字段覆盖是否一致？
//   3) searchSong({limit:100}) 的归一化有没有丢字段 / 产生 NaN？
//
// Run: node probe/10-depth-limit.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { searchSong, NETEASE_BASE } from '../lib/netease-api.mjs';

const OUT_DIR = join(import.meta.dirname, 'out');
const HEADERS = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0 Safari/537.36', Referer: NETEASE_BASE + '/' };
const KEYWORD = '简单爱 周杰伦';
const ARTIST = '周杰伦';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const report = { keyword: KEYWORD, artist: ARTIST, at: new Date().toISOString(), limitSweep: [], offsetSweep: [], endpointCompare: [], fidelity: null };

async function form(cfg, { s, limit, offset = 0, type = 1 }) {
  const body = new URLSearchParams({ s, type: String(type), offset: String(offset), limit: String(limit), total: 'true' });
  const t0 = Date.now();
  const res = await fetch(cfg.url, { method: 'POST', headers: { ...HEADERS, 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  return { cfg, ms: Date.now() - t0, status: res.status, bytes: Buffer.byteLength(text), json, text };
}

const songsOf = (cfg, json) => (cfg.pick ? cfg.pick(json) : json?.result?.songs) ?? [];
const realArtistCount = (songs) =>
  songs.filter((s) => (s.ar ?? s.artists ?? []).some((a) => String(a?.name) === ARTIST)).length;
const firstRealIdx = (songs) => songs.findIndex((s) => (s.ar ?? s.artists ?? []).some((a) => String(a?.name) === ARTIST));

const CS = {
  name: 'POST /api/cloudsearch/pc',
  url: `${NETEASE_BASE}/api/cloudsearch/pc`,
  pick: (j) => j?.result?.songs,
};
const OTHER_ENDPOINTS = [
  { name: 'GET /api/search/get/web', url: `${NETEASE_BASE}/api/search/get/web`, method: 'GET', pick: (j) => j?.result?.songs },
  { name: 'POST /api/search/get/web', url: `${NETEASE_BASE}/api/search/get/web`, method: 'POST', pick: (j) => j?.result?.songs },
  { name: 'GET /api/search/get', url: `${NETEASE_BASE}/api/search/get`, method: 'GET', pick: (j) => j?.result?.songs },
  { name: 'POST /api/search/get', url: `${NETEASE_BASE}/api/search/get`, method: 'POST', pick: (j) => j?.result?.songs },
];

// ── 1. limit 扫描 ────────────────────────────────────────────
console.log(`\n===== 1. limit 扫描（关键字「${KEYWORD}」）=====`);
console.log('limit | songCount | 返回条数 | 真·' + ARTIST + ' 条数 | 首个真·' + ARTIST + ' 在第几位 | 耗时');
for (const limit of [10, 30, 100, 200, 500]) {
  const r = await form(CS, { s: KEYWORD, limit });
  const songs = songsOf(CS, r.json);
  const row = {
    limit,
    status: r.status,
    code: r.json?.code,
    ms: r.ms,
    bytes: r.bytes,
    songCount: r.json?.result?.songCount ?? null,
    returned: songs.length,
    realArtist: realArtistCount(songs),
    firstRealArtistIdx: firstRealIdx(songs),
    top5: songs.slice(0, 5).map((s) => ({ id: s.id, name: s.name, artists: (s.ar ?? []).map((a) => a.name) })),
    realArtistIds: songs.filter((s) => (s.ar ?? []).some((a) => a.name === ARTIST)).map((s) => s.id),
  };
  report.limitSweep.push(row);
  console.log(`${String(limit).padStart(5)} | ${String(row.songCount).padStart(9)} | ${String(row.returned).padStart(8)} | ${String(row.realArtist).padStart(12)} | ${String(row.firstRealArtistIdx).padStart(24)} | ${r.ms}ms`);
  console.log(`        top5: ${row.top5.map((t) => `「${t.name}」/${t.artists.join(',')}`).join(' | ')}`);
  await sleep(300);
}

// ── 2. offset 翻页 ──────────────────────────────────────────
console.log(`\n===== 2. offset 翻页（limit=100）=====`);
let prevIds = null;
for (const offset of [0, 100, 200, 300, 400, 500]) {
  const r = await form(CS, { s: KEYWORD, limit: 100, offset });
  const songs = songsOf(CS, r.json);
  const ids = songs.map((s) => s.id);
  const overlapPrev = prevIds ? ids.filter((id) => prevIds.includes(id)).length : null;
  const row = {
    offset, status: r.status, code: r.json?.code, ms: r.ms, returned: songs.length,
    songCount: r.json?.result?.songCount ?? null, realArtist: realArtistCount(songs),
    overlapWithPrevPage: overlapPrev, hasMore: r.json?.result?.hasMore ?? null,
    first3: songs.slice(0, 3).map((s) => `${s.name}/${(s.ar ?? []).map((a) => a.name).join(',')}`),
  };
  report.offsetSweep.push(row);
  console.log(`offset=${String(offset).padStart(4)} 返回 ${String(row.returned).padStart(3)} 条 songCount=${row.songCount} 真·${ARTIST}=${row.realArtist} 与上一页重叠=${overlapPrev} hasMore=${row.hasMore}`);
  if (row.returned) console.log(`        ${row.first3.join(' | ')}`);
  prevIds = ids;
  await sleep(300);
}

// ── 3. 五端点结果集/字段覆盖对比 ─────────────────────────────
console.log(`\n===== 3. 五个搜索端点的结果集与字段覆盖（limit=30）=====`);
const base = await form(CS, { s: KEYWORD, limit: 30 });
const baseIds = songsOf(CS, base.json).map((s) => s.id);
const fieldProbe = (songs) => {
  const s0 = songs[0] ?? {};
  const al = s0.al ?? s0.album ?? {};
  return {
    hasAlPicUrl: Boolean(al.picUrl),
    hasAlPicStr: Boolean(al.pic_str ?? al.picId_str),
    hasAlia: Array.isArray(s0.alia ?? s0.alias),
    hasMv: s0.mv !== undefined || s0.mvid !== undefined,
    hasDt: s0.dt !== undefined || s0.duration !== undefined,
    keys: Object.keys(s0).sort(),
  };
};
report.endpointCompare.push({ name: CS.name, ms: base.ms, code: base.json?.code, returned: baseIds.length, ...fieldProbe(songsOf(CS, base.json)), idsEqualBase: true, firstDiffIdx: -1 });
for (const cfg of OTHER_ENDPOINTS) {
  const r = cfg.method === 'GET'
    ? await (async () => {
        const u = `${cfg.url}?${new URLSearchParams({ s: KEYWORD, type: '1', offset: '0', limit: '30', total: 'true' })}`;
        const t0 = Date.now();
        const res = await fetch(u, { headers: HEADERS });
        const text = await res.text();
        let json = null; try { json = JSON.parse(text); } catch { /* ignore */ }
        return { json, ms: Date.now() - t0, status: res.status, bytes: Buffer.byteLength(text) };
      })()
    : await form(cfg, { s: KEYWORD, limit: 30 });
  const songs = songsOf(cfg, r.json);
  const ids = songs.map((s) => s.id);
  const diffIdx = ids.findIndex((id, i) => baseIds[i] !== id);
  report.endpointCompare.push({ name: cfg.name, ms: r.ms, code: r.json?.code, returned: ids.length, ...fieldProbe(songs), idsEqualBase: diffIdx === -1 && ids.length === baseIds.length, firstDiffIdx: diffIdx });
  console.log(`${cfg.name.padEnd(26)} code=${r.json?.code} ${String(ids.length).padStart(3)}条 ids与cloudsearch一致=${diffIdx === -1 && ids.length === baseIds.length} 首个不同位=${diffIdx}`);
  await sleep(300);
}
const [g0, ...rest] = report.endpointCompare;
console.log(`字段覆盖：cloudsearch picUrl=${g0.hasAlPicUrl} pic_str=${g0.hasAlPicStr} alia=${g0.hasAlia} mv=${g0.hasMv} dt=${g0.hasDt}`);
for (const e of rest) console.log(`${e.name}: picUrl=${e.hasAlPicUrl} pic_str=${e.hasAlPicStr} alia=${e.hasAlia} mv=${e.hasMv} dt=${e.hasDt}`);
report.endpointCompareKeysOnlyInCloudsearch = report.endpointCompare[0].keys.filter((k) => !rest[0].keys.includes(k));

// ── 4. searchSong({limit:100}) 归一化保真度 ─────────────────
console.log(`\n===== 4. searchSong({limit:100}) 归一化保真度 =====`);
const raw = await form(CS, { s: KEYWORD, limit: 100 });
const rawSongs = songsOf(CS, raw.json);
const mapped = await searchSong({ keyword: KEYWORD, limit: 100 });
const bad = [];
const fieldLoss = [];
const rawById = new Map(rawSongs.map((s) => [Number(s.id), s]));
for (const c of mapped) {
  const r0 = rawById.get(c.id);
  if (!Number.isInteger(c.id) || c.id <= 0) bad.push({ id: c.id, why: 'id 非法' });
  if (typeof c.name !== 'string' || !c.name) bad.push({ id: c.id, why: 'name 空' });
  if (!Array.isArray(c.artists) || !c.artists.length || c.artists.some((a) => typeof a?.name !== 'string' || !a.name || !Number.isFinite(a?.id)))
    bad.push({ id: c.id, why: 'artists 异常', artists: c.artists });
  if (!c.album || typeof c.album.name !== 'string' || !Number.isFinite(c.album.id)) bad.push({ id: c.id, why: 'album 异常', album: c.album });
  if (c.durationMs !== null && !(Number.isFinite(c.durationMs) && c.durationMs > 0)) bad.push({ id: c.id, why: 'durationMs 既不是 null 也不是正数', durationMs: c.durationMs });
  if (!r0) { fieldLoss.push({ id: c.id, why: '原始响应里找不到这个 id' }); continue; }
  if (c.name !== r0.name) fieldLoss.push({ id: c.id, why: 'name 不一致', mapped: c.name, raw: r0.name });
  const rawArtists = (r0.ar ?? r0.artists ?? []).map((a) => [String(a.name ?? ''), Number(a.id)]);
  const mappedArtists = c.artists.map((a) => [a.name, a.id]);
  if (JSON.stringify(rawArtists) !== JSON.stringify(mappedArtists)) fieldLoss.push({ id: c.id, why: 'artists 不一致', mapped: mappedArtists, raw: rawArtists });
  const rawAlbum = { id: Number((r0.al ?? r0.album ?? {}).id), name: String((r0.al ?? r0.album ?? {}).name ?? '') };
  if (JSON.stringify(rawAlbum) !== JSON.stringify(c.album)) fieldLoss.push({ id: c.id, why: 'album 不一致', mapped: c.album, raw: rawAlbum });
  const rawDur = Number(r0.dt ?? r0.duration);
  if (c.durationMs !== (Number.isFinite(rawDur) && rawDur > 0 ? rawDur : null)) fieldLoss.push({ id: c.id, why: 'durationMs 不一致', mapped: c.durationMs, raw: rawDur });
}
const missingDuration = mapped.filter((c) => c.durationMs === null).length;
report.fidelity = {
  rawReturned: rawSongs.length, mappedReturned: mapped.length, idsPreserved: mapped.length === rawSongs.length,
  invalid: bad.length, fieldLoss: fieldLoss.length, missingDuration,
  distinctIds: new Set(mapped.map((c) => c.id)).size,
  examples: { bad: bad.slice(0, 5), fieldLoss: fieldLoss.slice(0, 5) },
  allArtistsNonEmpty: mapped.every((c) => c.artists.every((a) => a.name)),
};
console.log(`原始 ${rawSongs.length} 条 -> 归一化 ${mapped.length} 条；非法 ${bad.length}；字段不一致 ${fieldLoss.length}；durationMs=null ${missingDuration}；去重后 id ${report.fidelity.distinctIds}`);
console.log(`artists 全部非空: ${report.fidelity.allArtistsNonEmpty}`);
if (bad.length) console.log('非法样例: ' + JSON.stringify(bad.slice(0, 5)));
if (fieldLoss.length) console.log('不一致样例: ' + JSON.stringify(fieldLoss.slice(0, 5)));

// 截断响应片段（写进 notes/api.md 用）：前 10 条的 id/name/artists
report.rawSampleLimit100Top10 = rawSongs.slice(0, 10).map((s) => ({ id: s.id, name: s.name, artists: (s.ar ?? []).map((a) => a.name), album: (s.al ?? {}).name, dt: s.dt }));
report.rawSampleUrl = `${NETEASE_BASE}/api/cloudsearch/pc  (POST form: s=${encodeURIComponent(KEYWORD)}&type=1&offset=0&limit=100&total=true)`;
report.rawSampleTruncated = JSON.stringify(raw.json).slice(0, 1600);

// ── 5. songCount 语义细查：total 参数、offset 边界 ────────────
console.log(`\n===== 5. songCount 语义细查 =====`);
report.songCountDetail = [];
async function rawCloudsearch({ s, limit, offset = 0, total }) {
  const body = new URLSearchParams({ s, type: '1', offset: String(offset), limit: String(limit) });
  if (total !== undefined) body.set('total', String(total));
  const t0 = Date.now();
  const res = await fetch(CS.url, { method: 'POST', headers: { ...HEADERS, 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  const json = await res.json().catch(() => null);
  return { json, ms: Date.now() - t0 };
}
const cases = [
  { label: 'limit=100 total=true ', s: KEYWORD, limit: 100, total: true },
  { label: 'limit=100 total=false', s: KEYWORD, limit: 100, total: false },
  { label: 'limit=100 不带 total', s: KEYWORD, limit: 100 },
  { label: 'limit=10  total=true ', s: KEYWORD, limit: 10, total: true },
  { label: '限 100 硬上限 offset=99 ', s: KEYWORD, limit: 100, offset: 99, total: true },
  { label: 'offset=299          ', s: KEYWORD, limit: 100, offset: 299, total: true },
  { label: 'offset=301          ', s: KEYWORD, limit: 100, offset: 301, total: true },
  { label: '宽泛词 周杰伦       ', s: '周杰伦', limit: 100, total: true },
  { label: '宽泛词 limit=1000   ', s: '周杰伦', limit: 1000, total: true },
];
for (const c of cases) {
  const r = await rawCloudsearch(c);
  const row = { label: c.label, code: r.json?.code, songCount: r.json?.result?.songCount ?? null, returned: (r.json?.result?.songs ?? []).length, ms: r.ms };
  report.songCountDetail.push(row);
  console.log(`${c.label} -> code=${row.code} songCount=${row.songCount} 返回 ${row.returned} 条 (${row.ms}ms)`);
  await sleep(300);
}

// ── 6. offset 到底是「翻页」还是「取模」？（用 songCount 大于一页的宽泛词验证）──
console.log(`\n===== 6. offset 语义：宽泛词「周杰伦」(songCount=277) 翻页 =====`);
report.offsetBigPool = [];
for (const offset of [0, 50, 100, 200, 299, 300]) {
  const r = await rawCloudsearch({ s: '周杰伦', limit: 100, offset, total: true });
  const songs = r.json?.result?.songs ?? [];
  const row = {
    offset, code: r.json?.code, songCount: r.json?.result?.songCount ?? null, returned: songs.length,
    firstId: songs[0]?.id ?? null, firstArtist: (songs[0]?.ar ?? []).map((a) => a.name).join(','),
  };
  report.offsetBigPool.push(row);
  console.log(`offset=${String(offset).padStart(3)} -> songCount=${row.songCount} 返回 ${String(row.returned).padStart(3)} 条 首条 id=${row.firstId} (${row.firstArtist})`);
  await sleep(300);
}

mkdirSync(OUT_DIR, { recursive: true });
const out = join(OUT_DIR, '10-depth-limit.json');
writeFileSync(out, JSON.stringify(report, null, 2), 'utf8');
console.log('\nsaved -> ' + out);
