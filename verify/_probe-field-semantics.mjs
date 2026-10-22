/**
 * verify/_probe-field-semantics.mjs —— 探查 163key 各字段的「语义」到底来自本地文件还是云端条目
 *
 * 判据来源（唯一 ground truth）：官方客户端写的真实样本
 *   <REAL_SAMPLE:一个由官方客户端写入 163key 的真实 mp3>
 *
 * 对每个字段，问一个问题：这个值是「本地文件的属性」还是「云端条目的属性」？
 * 用真实样本可以分辨，因为它的本地属性与云端属性**不完全相同**。
 *
 * 同时对 52 个写入文件做同样比对：如果某字段语义应该是「本地属性」但写成了「云端属性」，
 * 那 52 个文件实际上几乎全部是错的（因为本地文件都是自己转的 FLAC，与云端 CDN 对象不同）。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import { REAL_SAMPLE, TARGET, vParseFlac, vParseId3v2, vParseTag, vReadAudio } from './00-common.mjs';

const md5 = (b) => crypto.createHash('md5').update(b).digest('hex');

/** 取真实样本的本地属性 + 官方写的 meta，逐字段判定语义 */
const a = vReadAudio(REAL_SAMPLE);
const meta = vParseTag(a.keyHits[0].text).meta;
const buf = fs.readFileSync(REAL_SAMPLE);
const id3 = vParseId3v2(buf);
const audioBytes = buf.length - id3.total;

// 真实位率：CBR 320kbps，用帧头确定
const BR_V1L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
function firstFrameKbps(b, from) {
  for (let i = from; i + 4 < b.length; i++) {
    if (b[i] !== 0xff || (b[i + 1] & 0xe0) !== 0xe0) continue;
    const vBits = (b[i + 1] >> 3) & 3;
    const lBits = (b[i + 1] >> 1) & 3;
    const brIdx = (b[i + 2] >> 4) & 0xf;
    const srIdx = (b[i + 2] >> 2) & 3;
    if (vBits !== 3 || lBits !== 1 || brIdx === 0 || brIdx === 15 || srIdx === 3) continue;
    return BR_V1L3[brIdx];
  }
  return null;
}
const kbps = firstFrameKbps(buf, id3.total);

console.log('═══ 真实样本的「本地属性」 vs 「官方写入的 meta」 ═══\n');
const local = {
  fileMd5: md5(buf),
  audioMd5: md5(buf.subarray(id3.total)),
  fileSize: buf.length,
  audioBytes,
  bitrateFromFrameHeader: kbps * 1000,
  bitrateFromBytesOverDuration: Math.round((audioBytes * 8) / (meta.duration / 1000)),
  durationFromBytes: Math.round((audioBytes * 8) / (kbps * 1000) * 1000),
};
console.log('本地属性:');
for (const [k, v] of Object.entries(local)) console.log(`  ${k.padEnd(28)} = ${v}`);
console.log('\n官方写入的 meta 关键字段:');
for (const k of ['musicId', 'musicName', 'artist', 'albumId', 'album', 'albumPicDocId', 'bitrate', 'mp3DocId', 'duration', 'format']) {
  console.log(`  ${k.padEnd(28)} = ${JSON.stringify(meta[k])}`);
}

console.log('\n── 判定 ──');
const bitrateIsLocal = Math.abs(meta.bitrate - local.bitrateFromFrameHeader) < 1000;
console.log(`  bitrate:  meta=${meta.bitrate}  本地帧头=${local.bitrateFromFrameHeader}  按字节/时长=${local.bitrateFromBytesOverDuration}`);
console.log(`            -> ${bitrateIsLocal ? '语义 = 本地文件真实位率' : '语义 = 其他（云端值/常量）'}`);

const durIsLocal = Math.abs(meta.duration - local.durationFromBytes) < 1000;
console.log(`  duration: meta=${meta.duration}  本地按字节推算=${local.durationFromBytes}`);
console.log(`            -> 差 ${meta.duration - local.durationFromBytes}ms，${durIsLocal ? '≈本地' : '更接近云端 dt（不是本地解码值）'}`);

const docIsFile = meta.mp3DocId === local.fileMd5;
console.log(`  mp3DocId: meta=${meta.mp3DocId}`);
console.log(`            本地整文件 md5=${local.fileMd5}`);
console.log(`            -> ${docIsFile ? '语义 = 本地整文件 md5' : '不等于本地整文件 md5（是云端 CDN 对象的 md5）'}`);

// 再确认一下：mp3DocId 是否等于「音频区 md5」？
console.log(`            本地音频区 md5=${local.audioMd5}  ${meta.mp3DocId === local.audioMd5 ? '(相等!)' : ''}`);

// ───────────────────────────────────────────────────────────────────────────
console.log('\n\n═══ 52 个写入文件：这些字段还能对上吗 ═══\n');
const rows = [];
for (const name of fs.readdirSync(TARGET).filter((n) => /\.(mp3|flac)$/i.test(n)).sort()) {
  const p = `${TARGET}\\${name}`;
  const au = vReadAudio(p);
  if (!au.keyHits.length) continue;
  const m = vParseTag(au.keyHits[0].text).meta;
  const b = fs.readFileSync(p);
  let realBps = null;
  let realDur = null;
  if (au.format === 'flac') {
    const fl = vParseFlac(b);
    const si = fl.blocks.find((x) => x.type === 0).data;
    const sr = (si[10] << 12) | (si[11] << 4) | (si[12] >> 4);
    const ts = (si[13] & 0x0f) * 4294967296 + si.readUInt32BE(14);
    realDur = Math.round((ts / sr) * 1000);
    realBps = Math.round(((b.length - fl.audioOffset) * 8) / (ts / sr));
  } else {
    const id = vParseId3v2(b);
    const k = firstFrameKbps(b, id.total);
    realBps = k ? k * 1000 : null;
    realDur = m.duration;
  }
  rows.push({
    name,
    fmt: au.format,
    declaredBps: m.bitrate,
    realBps,
    bitrateOk: realBps ? Math.abs(m.bitrate - realBps) / realBps < 0.05 : null,
    fileMd5: md5(b),
    docIdIsFileMd5: m.mp3DocId === md5(b),
    declaredDur: m.duration,
    realDur,
    durDelta: realDur != null ? m.duration - realDur : null,
  });
}

const bitrateBad = rows.filter((r) => r.bitrateOk === false);
const docIdMatchesFileMd5 = rows.filter((r) => r.docIdIsFileMd5);
console.log(`bitrate 与本地真实位率不符: ${bitrateBad.length}/${rows.length}`);
console.log(`mp3DocId == 本地整文件 md5 的: ${docIdMatchesFileMd5.length}/${rows.length}`);
const durBad = rows.filter((r) => r.durDelta != null && Math.abs(r.durDelta) > 100);
console.log(`duration 与本地实测差 >100ms 的: ${durBad.length}/${rows.length}（元数据以云端 dt 为准时这是预期的）`);

console.log('\n按格式拆分 bitrate 不符:');
for (const f of ['mp3', 'flac']) {
  const sub = rows.filter((r) => r.fmt === f);
  const bad = sub.filter((r) => r.bitrateOk === false);
  console.log(`  ${f}: ${bad.length}/${sub.length} 不符`);
  const declared = [...new Set(sub.map((r) => r.declaredBps))].sort((x, y) => x - y);
  console.log(`     写入的 bitrate 取值集合: ${declared.join(', ')}`);
  const real = sub.map((r) => r.realBps).filter(Boolean).sort((x, y) => x - y);
  console.log(`     真实位率区间: ${real[0]} .. ${real[real.length - 1]}`);
}

fs.writeFileSync(new URL('./artifacts/field-semantics.json', import.meta.url), JSON.stringify({ groundTruth: { local, meta }, rows }, null, 2), 'utf8');
console.log('\n  -> verify/artifacts/field-semantics.json');
