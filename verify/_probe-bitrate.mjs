/**
 * verify/_probe-bitrate.mjs —— 探查：163key 里写的 bitrate 是否等于文件真实位率
 *
 * 独立方法：
 *   MP3  —— 直接读第一个音频帧头里的 bitrate index，得到声明位率；再统计前 N 帧确认是 CBR 还是 VBR
 *   FLAC —— 位率 = (音频区字节数 * 8) / 时长秒（无损，这个算法是精确的）
 *
 * 对照对象：真实官方样本（MP3 320k）里写的 bitrate 是 320000，说明这个字段
 * 语义上就是「文件本身的实际位率」，而不是「曲库里最高可用音质」。
 */
import fs from 'node:fs';
import path from 'node:path';
import { BACKUP, REAL_SAMPLE, TARGET, vParseFlac, vParseId3v2, vReadAudio, vParseTag, vDetectFormat } from './00-common.mjs';

const BR_V1L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]; // MPEG1 Layer3
const BR_V2L3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]; // MPEG2/2.5 Layer3
const SR = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

/** 扫描 MP3 音频区，收集前若干帧的位率（kbps） */
function mp3FrameBitrates(buf, from, maxFrames = 60) {
  const out = [];
  let i = from;
  let frames = 0;
  while (i + 4 < buf.length && frames < maxFrames) {
    if (buf[i] !== 0xff || (buf[i + 1] & 0xe0) !== 0xe0) {
      i++;
      continue;
    }
    const vBits = (buf[i + 1] >> 3) & 3;
    const lBits = (buf[i + 1] >> 1) & 3;
    const brIdx = (buf[i + 2] >> 4) & 0xf;
    const srIdx = (buf[i + 2] >> 2) & 3;
    const pad = (buf[i + 2] >> 1) & 1;
    if (vBits === 1 || lBits !== 1 || brIdx === 0 || brIdx === 15 || srIdx === 3) {
      i++;
      continue;
    }
    const table = vBits === 3 ? BR_V1L3 : BR_V2L3;
    const kbps = table[brIdx];
    const sr = SR[vBits === 3 ? 3 : vBits === 2 ? 2 : 0][srIdx];
    const spf = 1152;
    out.push(kbps);
    frames++;
    const frameLen = Math.floor((spf / 8) * (kbps * 1000) / sr) + pad;
    if (frameLen <= 0) {
      i++;
      continue;
    }
    i += frameLen;
  }
  return out;
}

function realBitrate(file) {
  const buf = fs.readFileSync(file);
  const fmt = vDetectFormat(buf);
  if (fmt === 'mp3') {
    const id3 = vParseId3v2(buf);
    const brs = mp3FrameBitrates(buf, id3.total);
    const uniq = [...new Set(brs)].sort((a, b) => a - b);
    return { fmt, kind: uniq.length === 1 ? 'CBR' : 'VBR', kbpsValues: uniq, framesSampled: brs.length, bps: uniq.length ? Math.round((brs.reduce((s, x) => s + x, 0) / brs.length) * 1000) : null };
  }
  if (fmt === 'flac') {
    const flac = vParseFlac(buf);
    const si = flac.blocks.find((b) => b.type === 0);
    const d = si.data;
    const sampleRate = (d[10] << 12) | (d[11] << 4) | (d[12] >> 4);
    const totalSamples = (d[13] & 0x0f) * 4294967296 + d.readUInt32BE(14);
    const audioBytes = buf.length - flac.audioOffset;
    const bps = Math.round((audioBytes * 8) / (totalSamples / sampleRate));
    return { fmt, kind: 'FLAC', bps, sampleRate, totalSamples };
  }
  return { fmt, bps: null };
}

console.log('=== 官方真实样本（ground truth）===');
{
  const r = realBitrate(REAL_SAMPLE);
  const a = vReadAudio(REAL_SAMPLE);
  const meta = vParseTag(a.keyHits[0].text).meta;
  console.log(`  ${r.fmt} ${r.kind} 帧位率 ${r.kbpsValues?.join('/')}kbps -> 真实 ${r.bps}bps`);
  console.log(`  官方 163key 里写的 bitrate = ${meta.bitrate}`);
  console.log(`  -> 结论：字段语义 = 文件真实位率（${Math.abs(meta.bitrate - r.bps) < 5000 ? '两者相符' : '两者不符!'}）`);
}

console.log('\n=== 工作副本逐文件 ===');
const rows = [];
for (const name of fs.readdirSync(TARGET).filter((n) => /\.(mp3|flac)$/i.test(n)).sort()) {
  const p = path.join(TARGET, name);
  const a = vReadAudio(p);
  if (!a.keyHits.length) continue;
  const meta = vParseTag(a.keyHits[0].text).meta;
  const r = realBitrate(p);
  const ratio = r.bps ? meta.bitrate / r.bps : null;
  const verdict = ratio == null ? '?' : ratio > 0.9 && ratio < 1.1 ? 'OK' : 'MISMATCH';
  rows.push({ name, fmt: a.format, declared: meta.bitrate, real: r.bps, kind: r.kind, values: r.kbpsValues, verdict });
  console.log(
    `  ${verdict.padEnd(8)} ${a.format.padEnd(4)} 声明 ${String(meta.bitrate).padStart(7)}  真实 ${String(r.bps).padStart(7)}  ${r.kind.padEnd(4)} ${(r.kbpsValues || []).join('/')}  ${name.slice(0, 50)}`,
  );
}

const bad = rows.filter((r) => r.verdict === 'MISMATCH');
console.log(`\n合计 ${rows.length} 个文件，bitrate 不符 ${bad.length} 个`);
console.log(`  其中 FLAC 声明 320000 的: ${bad.filter((r) => r.fmt === 'flac').length}`);
console.log(`  其中 MP3  声明 320000 但实际非 320 的: ${bad.filter((r) => r.fmt === 'mp3').length}`);
fs.writeFileSync(new URL('./artifacts/bitrate-audit.json', import.meta.url), JSON.stringify(rows, null, 2), 'utf8');
console.log('  -> verify/artifacts/bitrate-audit.json');
