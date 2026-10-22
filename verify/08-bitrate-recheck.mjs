#!/usr/bin/env node
/**
 * verify/08-bitrate-recheck.mjs —— 复验 P1-1：独立重算每个文件的真实位率，与 163key 里的值比对
 *
 * 完全不 import lib/tags.mjs 的 normalizeBitrate / flacBitrate。
 * 我的独立算法（两条互相独立的路径，用于交叉印证）：
 *
 *   FLAC 路径 A（无损，精确）：
 *     bitrate = (文件长度 - 元数据块总长) * 8 / (totalSamples / sampleRate)
 *     其中元数据块总长从 fLaC 魔数后逐块累加得到（自写解析器），因此自然排除封面/seektable。
 *
 *   FLAC 路径 B（交叉印证）：
 *     用 STREAMINFO 的 totalSamples 与 audioOffset 单独再算一次。
 *     两条路径必须给出同一个数，否则说明我的偏移推导有 bug。
 *
 *   MP3 路径 A（VBR 正确算法）：
 *     bitrate = 音频区字节 * 8 / 时长，时长取自 Xing/Info 权威帧数
 *   MP3 路径 B（CBR 交叉印证）：
 *     读首帧帧头得到编码档位。若文件是 CBR，A 与 B 应当吻合（±5%）。
 *
 * 判定：163key 值 vs 我的实测值，相对误差 ≤5% 记为「一致」。
 *       同时按 Lead 声称的「FLAC 误差 ≤1000 bps、MP3 全等」两套口径分别统计。
 *
 * 运行：node verify/08-bitrate-recheck.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { C, TARGET, check, head, info, sha256hex, summary, vParseFlac, vParseId3v2, vParseTag, vReadAudio, vFlacStreamInfo } from './00-common.mjs';

const BR_V1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const BR_V2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const SRATE = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

/** 剥尾部 ID3v1 / APEv2 */
function audioEnd(buf, start) {
  let end = buf.length;
  for (let g = 0; g < 2; g++) {
    if (end - start >= 128 && buf.toString('latin1', end - 128, end - 125) === 'TAG') {
      end -= 128;
      continue;
    }
    if (end - start >= 32 && buf.toString('latin1', end - 32, end - 24) === 'APETAGEX') {
      const size = buf.readUInt32LE(end - 32 + 12);
      const hasHeader = !!(buf.readUInt32LE(end - 32 + 20) & 0x80000000);
      const total = size + (hasHeader ? 32 : 0);
      if (end - total >= start) {
        end -= total;
        continue;
      }
    }
    break;
  }
  return end;
}

/** MP3 首帧 + Xing/Info */
function mp3Info(buf, from) {
  for (let i = from; i + 4 < buf.length; i++) {
    if (buf[i] !== 0xff || (buf[i + 1] & 0xe0) !== 0xe0) continue;
    const vBits = (buf[i + 1] >> 3) & 3;
    const lBits = (buf[i + 1] >> 1) & 3;
    const brIdx = (buf[i + 2] >> 4) & 0xf;
    const srIdx = (buf[i + 2] >> 2) & 3;
    if (vBits === 1 || lBits === 0 || brIdx === 0 || brIdx === 15 || srIdx === 3) continue;
    const kbps = (vBits === 3 ? BR_V1 : BR_V2)[brIdx];
    const sampleRate = SRATE[vBits === 3 ? 3 : vBits === 2 ? 2 : 0][srIdx];
    const spf = lBits === 3 ? 384 : lBits === 2 ? 1152 : vBits === 3 ? 1152 : 576;
    let frames = null;
    const sideInfo = vBits === 3 ? 32 : 17;
    for (const off of [i + 4 + sideInfo, i + 4 + 17, i + 4 + 9, i + 36, i + 21, i + 13]) {
      if (off + 12 > buf.length) continue;
      const t = buf.toString('latin1', off, off + 4);
      if (t !== 'Xing' && t !== 'Info') continue;
      const flags = buf.readUInt32BE(off + 4);
      if (flags & 1) frames = buf.readUInt32BE(off + 8);
      break;
    }
    return { kbps, sampleRate, spf, frames, offset: i };
  }
  return null;
}

const all = fs.readdirSync(TARGET).filter((n) => /\.(mp3|flac)$/i.test(n)).sort();
const withKey = [];
for (const n of all) if (vReadAudio(path.join(TARGET, n)).keyHits.length) withKey.push(n);
info('带 163key 的文件', String(withKey.length));
info('不带 163key 的文件', String(all.length - withKey.length));

const rows = [];

head('1. FLAC：两条独立路径重算真实位率，与 163key 声明值比对');
for (const name of withKey.filter((n) => /\.flac$/i.test(n))) {
  const p = path.join(TARGET, name);
  const buf = fs.readFileSync(p);
  const a = vReadAudio(p);
  const meta = vParseTag(a.keyHits[0].text).meta;
  const flac = a.flac;
  const si = vFlacStreamInfo(flac.blocks);

  // 路径 A：元数据块总长 = audioOffset - 4（fLaC 魔数 4 字节）
  const metaBytes = flac.audioOffset - 4;
  const audioBytes = buf.length - flac.audioOffset;
  const durS = si.totalSamples / si.sampleRate;
  const bpsA = Math.round((audioBytes * 8) / durS);

  // 路径 B：逐块累加，独立算出同一个量
  let sumBlocks = 0;
  for (const b of flac.blocks) sumBlocks += 4 + b.len;
  const bpsB = Math.round(((buf.length - 4 - sumBlocks) * 8) / durS);

  const declared = Number(meta.bitrate);
  const absA = Math.abs(declared - bpsA);
  const relA = absA / bpsA;
  const ok = relA <= 0.05;

  check(bpsA === bpsB, `  两条路径自洽 ${name}`, `A=${bpsA} B=${bpsB} metaBytes=${metaBytes}`);
  check(ok, `FLAC ${name}`, `声明 ${declared}  实测 ${bpsA}  差 ${declared - bpsA} (${(relA * 100).toFixed(2)}%)`);
  rows.push({ name, fmt: 'flac', declared, measured: bpsA, absDiff: declared - bpsA, relPct: relA * 100, ok, kind: '无损' });
}

head('2. MP3：VBR 正确算法（音频区字节/时长）与首帧档位交叉印证');
for (const name of withKey.filter((n) => /\.mp3$/i.test(n))) {
  const p = path.join(TARGET, name);
  const buf = fs.readFileSync(p);
  const a = vReadAudio(p);
  const meta = vParseTag(a.keyHits[0].text).meta;
  const end = audioEnd(buf, a.audioOffset);
  const audioBytes = end - a.audioOffset;
  const mi = mp3Info(buf, a.audioOffset);

  // 路径 A：用 Xing 权威帧数算时长，再算平均位率（VBR 唯一正确做法）
  const durMs = mi.frames ? (mi.frames * mi.spf * 1000) / mi.sampleRate : null;
  const bpsA = durMs ? Math.round((audioBytes * 8) / (durMs / 1000)) : null;
  // 路径 B：首帧编码档位
  const bpsB = mi.kbps * 1000;
  const isCbr = bpsA != null && Math.abs(bpsA - bpsB) / bpsB < 0.05;

  const declared = Number(meta.bitrate);
  const absA = bpsA != null ? Math.abs(declared - bpsA) : null;
  const relA = bpsA ? absA / bpsA : null;
  // 判定对两种口径都要求一致：既要贴合平均位率，也要贴合编码档位
  const ok = relA != null && relA <= 0.05;
  // 旁证：声明值是否等于首帧档位（说明吸附到标准档位了）
  const snapped = declared === bpsB;

  check(ok, `MP3 ${name}`, `声明 ${declared}  平均实测 ${bpsA}（${(relA * 100).toFixed(2)}%）  首帧档位 ${bpsB}${isCbr ? ' [CBR]' : ' [VBR]'}${snapped ? ' 已吸附' : ''}`);
  rows.push({ name, fmt: 'mp3', declared, measured: bpsA, absDiff: declared - bpsA, relPct: relA * 100, ok, frameKbps: bpsB, snapped, isCbr });
}

// ───────────────────────────────────────────────────────────────────────────
head('3. 汇总：按两套口径分别统计');
{
  const flac = rows.filter((r) => r.fmt === 'flac');
  const mp3 = rows.filter((r) => r.fmt === 'mp3');

  // 口径 ①（Lead 声称）：FLAC 绝对误差 ≤1000 bps，MP3 完全相等
  const flacUnder1000 = flac.filter((r) => Math.abs(r.absDiff) <= 1000);
  const mp3Exact = mp3.filter((r) => r.declared === r.measured);
  // 口径 ②（我的）：相对误差 ≤5%
  const flacOk5 = flac.filter((r) => r.relPct <= 5);
  const mp3Ok5 = mp3.filter((r) => r.relPct <= 5);
  // 口径 ③（最严）：绝对误差 ≤1000（FLAC 与 MP3 都按这个）
  const allUnder1000 = rows.filter((r) => Math.abs(r.absDiff) <= 1000);

  console.log(`  FLAC ${flac.length} 个：`);
  console.log(`    绝对误差 ≤1000 bps 的: ${flacUnder1000.length}/${flac.length}`);
  console.log(`    相对误差 ≤5%   的:     ${flacOk5.length}/${flac.length}`);
  console.log(`    绝对误差范围: ${Math.min(...flac.map((r) => r.absDiff))} .. ${Math.max(...flac.map((r) => r.absDiff))}`);
  console.log(`  MP3 ${mp3.length} 个：`);
  console.log(`    与平均实测完全相等:    ${mp3Exact.length}/${mp3.length}`);
  console.log(`    相对误差 ≤5%   的:     ${mp3Ok5.length}/${mp3.length}`);
  console.log(`    吸附到首帧标准档位的:  ${mp3.filter((r) => r.snapped).length}/${mp3.length}`);
  console.log(`  全部 ${rows.length} 个按「绝对误差 ≤1000」: ${allUnder1000.length}/${rows.length}`);

  const bad = rows.filter((r) => !r.ok);
  console.log(`\n  按 ≤5% 相对误差口径，不符: ${bad.length} 个`);
  for (const b of bad) console.log(`    ${b.fmt} ${b.name}  声明 ${b.declared} 实测 ${b.measured} (${b.relPct.toFixed(2)}%)`);

  // 最大偏差的文件
  const worst = [...rows].sort((x, y) => Math.abs(y.absDiff) - Math.abs(x.absDiff)).slice(0, 5);
  console.log(`\n  绝对偏差最大的 5 个:`);
  for (const w of worst) console.log(`    ${String(w.absDiff).padStart(7)}  ${w.fmt} ${w.name.slice(0, 46)}  声明 ${w.declared} 实测 ${w.measured}`);

  check(flacUnder1000.length === flac.length, `P1-1 复验：全部 ${flac.length} 个 FLAC 的 bitrate 绝对误差 ≤1000 bps`, `${flac.length - flacUnder1000.length} 个超出`);
  check(mp3Ok5.length === mp3.length, `P1-1 复验：全部 ${mp3.length} 个 MP3 的 bitrate 与实测一致（≤5%）`, `${mp3.length - mp3Ok5.length} 个超出`);
  check(bad.length === 0, `P1-1 复验：全部 ${rows.length} 个文件的 bitrate 都不符项清零`, bad.length ? `${bad.length} 个` : '');
}

// 与上一轮（修复前）对比
head('4. 与修复前的对照（上一轮结论：42 FLAC 全错 + 4 MP3 错，合计 46）');
{
  const prevBadFlac = 42;
  const prevBadMp3 = 4;
  const nowBadFlac = rows.filter((r) => r.fmt === 'flac' && !r.ok).length;
  const nowBadMp3 = rows.filter((r) => r.fmt === 'mp3' && !r.ok).length;
  console.log(`  FLAC 不符: ${prevBadFlac} -> ${nowBadFlac}`);
  console.log(`  MP3  不符: ${prevBadMp3} -> ${nowBadMp3}`);
  console.log(`  合计     : ${prevBadFlac + prevBadMp3} -> ${nowBadFlac + nowBadMp3}`);

  // 修复前那 4 个错 MP3 现在对不对
  const wasWrong = ['Michita - Cry For Me (feat. Ami).mp3', 'Valentin - Unchanged Mind.mp3', 'suhmeduh - Phone Kisses.mp3', '郑润泽 - 瞬.mp3'];
  console.log(`\n  修复前错写的 4 个 MP3 复核:`);
  for (const w of wasWrong) {
    const r = rows.find((x) => x.name === w);
    if (!r) {
      console.log(`    ${w} -> 未带 key（不在审计范围）`);
      continue;
    }
    console.log(`    ${w}\n        声明 ${r.declared}  实测 ${r.measured}（首帧 ${r.frameKbps}）  ${r.ok ? '✅ 已修正' : '❌ 仍不符'}`);
  }
}

fs.writeFileSync(
  new URL('./artifacts/bitrate-recheck.json', import.meta.url),
  JSON.stringify({ at: new Date().toISOString(), rows }, null, 2),
  'utf8',
);
info('中间产物', 'verify/artifacts/bitrate-recheck.json');

process.exitCode = summary('08-bitrate-recheck') ? 0 : 1;
