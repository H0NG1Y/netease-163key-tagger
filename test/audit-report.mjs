/**
 * 匹配报告审计：把报告里每一个「可自动应用」的 musicId 拿去网易云反查，
 * 核对「歌名 / 歌手 / 专辑 / 时长」是否与本地文件一致，并专门检查 UGC 冒充。
 *
 *   node test/audit-report.mjs [report.json]
 *
 * 退出码 0 = 全部通过；1 = 有 P0 问题（不该写入的记录被判为 auto）。
 *
 * 为什么需要这个：匿名搜索会把翻唱排在原唱前面，光看打分无法发现错配——
 * 必须拿 musicId 反查回真实曲目信息，逐条人工可比对地核对。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const reportPath = path.resolve(process.argv[2] || path.join(ROOT, 'out', 'matches-v3.json'));

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
const H = { 'User-Agent': UA, Referer: 'https://music.163.com/' };

const DURATION_TOLERANCE_MS = 5000;

const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
const recs = report.records || report;
const autos = recs.filter((r) => r.auto);
if (!autos.length) {
  console.log('报告里没有 auto 记录，无需审计。');
  process.exit(0);
}
const ids = [...new Set(autos.map((r) => r.best.id))];
console.log(`报告 ${reportPath}`);
console.log(`auto 记录 ${autos.length} 条，唯一 musicId ${ids.length} 个，开始反查…`);

// 批量取详情：ids=[..] 支持逗号分隔，一批 20 个
const detail = new Map();
for (let i = 0; i < ids.length; i += 20) {
  const chunk = ids.slice(i, i + 20);
  const url = `https://music.163.com/api/song/detail/?ids=[${chunk.join(',')}]`;
  const res = await fetch(url, { headers: H });
  const json = await res.json().catch(() => ({}));
  for (const s of json.songs || []) detail.set(s.id, s);
  await new Promise((r) => setTimeout(r, 200));
}
console.log(`反查到 ${detail.size}/${ids.length} 条详情\n`);

const rows = [];
for (const r of autos) {
  const id = r.best.id;
  const s = detail.get(id);
  if (!s) {
    rows.push({ file: r.file, id, verdict: 'P0:查不到详情' });
    continue;
  }
  const ar = s.artists || s.ar || [];
  const ids0 = ar.map((a) => a.id).filter((v) => Number.isInteger(v));
  const allZero = ids0.length > 0 && ids0.every((v) => v === 0);
  const al = s.album || s.al || {};
  const alName = String(al.name || '').trim();
  const dt = s.duration || s.dt;
  const delta = Number.isFinite(dt) && Number.isFinite(r.localDurationMs) ? Math.abs(dt - r.localDurationMs) : null;

  let verdict = 'OK';
  let why = '';
  if (allZero && !alName) {
    verdict = 'P0:UGC冒充';
    why = '艺人 id 全 0 且无专辑名';
  } else if (delta != null && delta > DURATION_TOLERANCE_MS) {
    verdict = 'P0:时长不符';
    why = `Δ=${delta}ms`;
  }
  rows.push({
    file: r.file,
    id,
    name: s.name,
    artists: ar.map((a) => `${a.name}#${a.id}`).join('/'),
    album: alName,
    apiDuration: dt,
    localDuration: r.localDurationMs,
    delta,
    verdict,
    why,
  });
}

rows.sort((a, b) => (a.verdict === 'OK' ? 1 : -1));
for (const x of rows) {
  const mark = x.verdict === 'OK' ? '\u2705' : '\u274c';
  const d = x.delta == null ? '?' : String(x.delta);
  console.log(
    `${mark} ${String(x.id).padEnd(11)} ${String(x.name || '').slice(0, 18).padEnd(19)} ` +
      `${String(x.artists || '').slice(0, 24).padEnd(25)} \u300a${String(x.album || '').slice(0, 12).padEnd(13)}\u300b ` +
      `\u0394=${d.padStart(6)}  ${x.verdict} ${x.why}`,
  );
  if (x.verdict !== 'OK') console.log(`     \u2190 ${x.file}`);
}

const bad = rows.filter((r) => r.verdict !== 'OK');
console.log(`\n结论: OK=${rows.length - bad.length}  P0=${bad.length}  查不到=${rows.filter((r) => r.verdict === 'P0:查不到详情').length}`);
if (bad.length) {
  console.log('\n有 P0 问题：这些记录被判为 auto 但不该写入。');
  process.exit(1);
}
console.log('全部 auto 记录的 musicId 反查结果与本地文件一致，可安全写入。');
process.exit(0);
