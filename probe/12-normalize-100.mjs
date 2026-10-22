// Probe 12 — `searchSong({limit:100})` 归一化保真度（满 100 行的大池子）
//
// `s=简单爱 周杰伦` 的池子只有 80 条，验不到「100 行」这个上限；本脚本用宽泛词
// （songCount=277，单页返回满 100 行）逐字段对比「原始 result.songs」与「searchSong 归一化结果」，
// 确认 100 行全部正确映射、无 NaN、无丢字段、无不可用 durationMs。
//
// Run: node probe/12-normalize-100.mjs
import { searchSong, configureNeteaseApi } from '../lib/netease-api.mjs';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const OUT_DIR = join(import.meta.dirname, 'out');
configureNeteaseApi({ minIntervalMs: 0, retries: 1 });

// 直接打原始端点拿「未归一化」的对照数据（与 searchSong 内部同一个端点/参数）
const form = new URLSearchParams({ s: '周杰伦', type: '1', offset: '0', limit: '100', total: 'true' });
const res = await fetch('https://music.163.com/api/cloudsearch/pc', {
  method: 'POST',
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    Referer: 'https://music.163.com/',
    'Content-Type': 'application/x-www-form-urlencoded',
  },
  body: form.toString(),
});
const json = await res.json();
const raw = json?.result?.songs ?? [];
const normalized = await searchSong({ keyword: '周杰伦', limit: 100 });

const problems = [];
const upstreamAnomalies = [];
const missingDuration = [];
let mismatched = 0;
for (let i = 0; i < raw.length; i++) {
  const r = raw[i];
  const n = normalized[i];
  if (!n) { problems.push(`第 ${i} 行归一化结果缺失`); continue; }
  if (n.id !== r.id) problems.push(`第 ${i} 行 id ${n.id} != ${r.id}`);
  if (!Number.isFinite(n.id) || n.id <= 0) problems.push(`第 ${i} 行 id 非法: ${n.id}`);
  if (!n.name || n.name !== r.name) problems.push(`第 ${i} 行 name「${n.name}」!=「${r.name}」`);
  const rawArtists = (r.ar ?? r.artists ?? []).map((a) => a.name);
  const normArtists = n.artists.map((a) => a.name);
  if (JSON.stringify(rawArtists) !== JSON.stringify(normArtists)) problems.push(`第 ${i} 行 artists ${JSON.stringify(normArtists)} != ${JSON.stringify(rawArtists)}`);
  if (!n.artists.length) problems.push(`第 ${i} 行 artists 为空`);
  // 归一化必须忠实：name 不能空；id 必须是有限非负数。id=0 是**上游 UGC 数据本身**的异常
  // （未绑定歌手账号的上传），不是我映射出来的，单独统计而不是当成 bug。
  if (!n.artists.every((a) => typeof a.name === 'string' && a.name && Number.isFinite(a.id) && a.id >= 0)) problems.push(`第 ${i} 行 artist.id/name 类型非法`);
  if (n.artists.some((a) => a.id === 0)) upstreamAnomalies.push({ row: i, name: r.name, rawAr: r.ar ?? r.artists });
  const rawAlbum = r.al?.name ?? '';
  if (n.album?.name !== rawAlbum) problems.push(`第 ${i} 行 album「${n.album?.name}」!=「${rawAlbum}」`);
  const dt = r.dt ?? r.duration;
  if (!(Number.isFinite(dt) && dt > 0)) missingDuration.push(`${i}:${r.name}`);
  else if (n.durationMs !== dt) problems.push(`第 ${i} 行 durationMs ${n.durationMs} != ${dt}`);
  if (typeof n.durationMs !== 'number' && n.durationMs !== null) problems.push(`第 ${i} 行 durationMs 类型非法: ${typeof n.durationMs}`);
}
const ids = normalized.map((n) => n.id);
const dupes = ids.length - new Set(ids).size;
for (const n of normalized) {
  for (const k of ['id', 'name', 'artists', 'album', 'durationMs']) if (!(k in n)) problems.push(`归一化对象缺少键 ${k}`);
}

const report = {
  at: new Date().toISOString(),
  query: '周杰伦', rawCount: raw.length, normalizedCount: normalized.length,
  songCount: json?.result?.songCount ?? null,
  idsUnique: new Set(ids).size, duplicates: dupes,
  rawMissingDuration: missingDuration.length,
  mismatchedRows: mismatched,
  problems,
  upstreamArtistIdZero: upstreamAnomalies.length,
  upstreamAnomalies,
  firstRowRaw: raw[0] ? { id: raw[0].id, name: raw[0].name, ar: raw[0].ar ?? raw[0].artists, al: raw[0].al?.name, dt: raw[0].dt } : null,
  firstRowNormalized: normalized[0] ? { ...normalized[0], artists: normalized[0].artists } : null,
  lastRowNormalized: normalized.at(-1) ?? null,
};
console.log(`原始 ${raw.length} 行 -> 归一化 ${normalized.length} 行（songCount=${report.songCount}）`);
console.log(`唯一 id ${report.idsUnique}，重复 ${dupes}，原始缺 dt ${report.rawMissingDuration}，归一化问题 ${problems.length}，上游 artist.id=0 异常 ${upstreamAnomalies.length}`);
if (problems.length) console.log(problems.slice(0, 20).join('\n'));
for (const a of upstreamAnomalies) console.log(`  · 上游异常 row ${a.row} 「${a.name}」 ar=${JSON.stringify(a.rawAr)}`);
console.log(JSON.stringify(report.firstRowNormalized));
console.log(JSON.stringify(report.lastRowNormalized));
mkdirSync(OUT_DIR, { recursive: true });
const out = join(OUT_DIR, '12-normalize-100.json');
writeFileSync(out, JSON.stringify(report, null, 2), 'utf8');
console.log('saved -> ' + out);
process.exit(problems.length ? 1 : 0);
