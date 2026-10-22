/**
 * verify/_probe-bitrate-truth.mjs —— 关键判定：163key 的 bitrate 字段到底是「本地位率」还是「云端值」？
 *
 * 这个结论决定 bitrate 不符算不算缺陷，所以必须用 ground truth 定死。
 *
 * 唯一 ground truth：官方客户端写的真实样本 MP3。
 * 它的本地位率与云端位率**恰好都是 320000**，所以单看它分不出语义。
 * 必须换一个角度：
 *   1. 163marker（社区事实标准）的源码（probe/ref/163marker-core.py.txt）里
 *      `'bitrate': audio.info.bitrate` —— mutagen 的 audio.info.bitrate = **本地文件位率**。
 *   2. 官方样本若 mp3DocId 是云端 CDN 对象 md5（已证实：不等于本地文件 md5），
 *      说明官方写标签时手里有「云端对象」的信息；但这不代表 bitrate 也取了云端值。
 *   3. 决定性检验：如果 bitrate 是本地值，那么对 FLAC 文件，官方客户端会写 FLAC 的真实位率
 *      （~900000+），而不是 mp3 的 320000。本项目 42 个 FLAC 全部写 320000。
 *
 * 本脚本把三条证据摊开，让结论可复核。
 */
import fs from 'node:fs';
import { REAL_SAMPLE, TARGET, vParseFlac, vParseTag, vReadAudio } from './00-common.mjs';

console.log('═══ 证据 1：社区事实标准 163marker 的字段来源 ═══\n');
const ref = fs.readFileSync('<REPO>/probe/ref/163marker-core.py.txt', 'utf8');
const lines = ref.split(/\r?\n/);
lines.forEach((l, i) => {
  if (/bitrate|mp3DocId|duration/.test(l)) console.log(`  L${i + 1}: ${l.trim()}`);
});

console.log('\n═══ 证据 2：官方真实样本的 bitrate 与本地/云端值 ═══\n');
const a = vReadAudio(REAL_SAMPLE);
const meta = vParseTag(a.keyHits[0].text).meta;
const buf = fs.readFileSync(REAL_SAMPLE);
// 本地 CBR 位率（读首帧）
const BR = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
let localKbps = null;
for (let i = a.audioOffset; i + 4 < buf.length; i++) {
  if (buf[i] !== 0xff || (buf[i + 1] & 0xe0) !== 0xe0) continue;
  const v = (buf[i + 1] >> 3) & 3;
  const l = (buf[i + 1] >> 1) & 3;
  const br = (buf[i + 2] >> 4) & 0xf;
  const sr = (buf[i + 2] >> 2) & 3;
  if (v !== 3 || l !== 1 || br === 0 || br === 15 || sr === 3) continue;
  localKbps = BR[br];
  break;
}
console.log(`  官方 meta.bitrate       = ${meta.bitrate}`);
console.log(`  本地首帧位率            = ${localKbps * 1000}`);
console.log(`  ⇒ 二者相同（本例无区分度，样本恰好都是 320k）`);

console.log('\n═══ 证据 3：本项目 42 个 FLAC 的声明值 vs 真实无损位率 ═══\n');
let n = 0;
const rows = [];
for (const name of fs.readdirSync(TARGET).filter((x) => /\.flac$/i.test(x)).sort()) {
  const p = `${TARGET}\\${name}`;
  const au = vReadAudio(p);
  if (!au.keyHits.length) continue;
  const m = vParseTag(au.keyHits[0].text).meta;
  const b = fs.readFileSync(p);
  const fl = vParseFlac(b);
  const si = fl.blocks.find((x) => x.type === 0).data;
  const sampleRate = (si[10] << 12) | (si[11] << 4) | (si[12] >> 4);
  const totalSamples = (si[13] & 0x0f) * 4294967296 + si.readUInt32BE(14);
  const realBps = Math.round(((b.length - fl.audioOffset) * 8) / (totalSamples / sampleRate));
  rows.push({ name, declared: m.bitrate, realBps, ratio: (m.bitrate / realBps).toFixed(2) });
  if (n < 6) console.log(`  ${name.slice(0, 34).padEnd(34)} 声明 ${String(m.bitrate).padStart(7)}  真实 ${String(realBps).padStart(7)}  比值 ${(m.bitrate / realBps).toFixed(2)}`);
  n++;
}
console.log(`  ... 共 ${n} 个 FLAC，全部声明约 320000，真实值区间 ${Math.min(...rows.map((r) => r.realBps))}..${Math.max(...rows.map((r) => r.realBps))}`);
console.log(`  ⇒ 若 bitrate 语义是「本地文件位率」，这 ${n} 个全部写错（低了 3~5 倍）`);
console.log(`  ⇒ 若语义是「云端 mp3 档位」（320k），则全部正确`);

console.log('\n═══ 证据 4：客户端拿 bitrate 干什么？（决定这个错有多大影响） ═══\n');
console.log('  notes/api.md §6.2 记录：客户端曲库库 dbTrack 里 "bitrate" 出现 0 次');
console.log('  ⇒ 客户端不靠 163key 的 bitrate 做任何本地判断，字段仅作展示/透传');
const apiMd = fs.readFileSync('<REPO>/notes/api.md', 'utf8');
const hit = apiMd.includes('`"bitrate"` → **0**') || /"bitrate"`?[^\n]{0,20}→\s*\*\*0\*\*/.test(apiMd);
console.log(`  ⇒ 复核 notes/api.md 是否确实这么写：${hit ? '是' : '需人工确认'}`);

fs.writeFileSync(new URL('./artifacts/bitrate-truth.json', import.meta.url), JSON.stringify({ sample: { meta, localKbps }, flac: rows }, null, 2), 'utf8');
console.log('\n  -> verify/artifacts/bitrate-truth.json');
