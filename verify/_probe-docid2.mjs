/**
 * verify/_probe-docid2.mjs —— 精确判定 mp3DocId 的真实来源（修正上一次的判据错误）
 *
 * 上一次我用「最终 meta.format」代入合成公式，只命中 8 个。这是错的：
 * detail 记录里 format 恒为 "mp3"（fetch 时刻还没决定最终容器），所以合成公式
 * 应当用 "mp3" 代入才对。这一版逐个试所有候选 format，把真相挖出来。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import { TARGET, vParseTag, vReadAudio } from './00-common.mjs';

const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');

const rows = [];
for (const name of fs.readdirSync(TARGET).filter((n) => /\.(mp3|flac)$/i.test(n)).sort()) {
  const a = vReadAudio(`${TARGET}\\${name}`);
  if (!a.keyHits.length) continue;
  rows.push({ name, realFmt: a.format, meta: vParseTag(a.keyHits[0].text).meta });
}

let synAny = 0;
const detail = [];
for (const r of rows) {
  const id = r.meta.musicId;
  const cands = {
    'synthetic(mp3)': md5(`netease-163key-tagger|${id}|mp3`),
    'synthetic(flac)': md5(`netease-163key-tagger|${id}|flac`),
    'synthetic(meta.format)': md5(`netease-163key-tagger|${id}|${r.meta.format}`),
  };
  let hit = null;
  for (const [k, v] of Object.entries(cands)) if (v === r.meta.mp3DocId) hit = k;
  if (hit) synAny++;
  detail.push({ file: r.name, realFmt: r.realFmt, metaFormat: r.meta.format, musicId: id, mp3DocId: r.meta.mp3DocId, hit });
}

console.log(`总 ${rows.length} 个`);
console.log(`mp3DocId 命中任一合成公式的: ${synAny}  (${((synAny / rows.length) * 100).toFixed(0)}%)`);
console.log(`\n按命中的配方拆分:`);
const byHit = {};
for (const d of detail) byHit[d.hit ?? '不是合成值'] = (byHit[d.hit ?? '不是合成值'] || 0) + 1;
for (const [k, v] of Object.entries(byHit)) console.log(`  ${k}: ${v}`);

console.log('\n明细（命中 synthetic(mp3) 说明最终容器是 flac 但 docId 按 mp3 算的）:');
for (const d of detail) {
  console.log(`  ${d.realFmt.padEnd(4)} meta.format=${d.metaFormat.padEnd(4)} ${String(d.musicId).padStart(10)}  ${d.mp3DocId}  ${d.hit ?? '★真实值'}  ${d.file.slice(0, 42)}`);
}

// 顺带确认 bitrate 是不是也恒为 320000（同样是回退常量）
console.log('\n=== bitrate 取值分布 ===');
const brs = {};
for (const r of rows) brs[r.meta.bitrate] = (brs[r.meta.bitrate] || 0) + 1;
for (const [k, v] of Object.entries(brs).sort((a, b) => b[1] - a[1])) console.log(`  ${k}: ${v} 个`);

// detail 缓存里 format 是否恒为 mp3
const cache = JSON.parse(fs.readFileSync('D:/HonGLY/netease-163key-tagger/out/api-cache-100.json', 'utf8'));
const detKeys = Object.keys(cache).filter((k) => k.startsWith('detail:'));
const fmtCount = {};
for (const k of detKeys) {
  const f = cache[k]?.format;
  fmtCount[f] = (fmtCount[f] || 0) + 1;
}
console.log(`\n=== out/api-cache-100.json 里 ${detKeys.length} 条 detail 记录的 format 分布 ===`);
console.log('  ' + JSON.stringify(fmtCount));

fs.writeFileSync(new URL('./artifacts/docid-truth.json', import.meta.url), JSON.stringify(detail, null, 2), 'utf8');
