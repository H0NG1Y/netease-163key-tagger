#!/usr/bin/env node
/**
 * verify/07-audio-integrity-deep.mjs —— 音频流深度完整性（帧级）
 *
 * 02 号脚本已经证明「音频区字节与备份逐字节相同」，本脚本再补一层：
 * **真的把音频流解析一遍**，确认流本身结构自洽、且 163key 里描述的 duration
 * 与文件里音频实际时长一致。这能抓 02 抓不到的一类问题：
 * 字节没被动过，但元数据里的 duration 描述与实际音频不符。
 *
 * 方法（权威值不靠猜）：
 *   MP3  —— 读音频区第一帧的 Xing/Info 头，那里有**编码器写入的权威帧数**。
 *           时长 = frames × samplesPerFrame / sampleRate，sampleRate 取自首帧头
 *           （不能像初版那样写死 44100：本批里有 48kHz 的文件，写死会算出 187s vs 172s 的假错误）。
 *           再用逐帧走查得到的帧数交叉校验。
 *   FLAC —— STREAMINFO 的 totalSamples / sampleRate 是权威值（无损、精确）。
 *           再统计音频区里 FLAC 帧同步码的密度，确认码流没有断裂。
 *
 * 运行：node verify/07-audio-integrity-deep.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { BACKUP, C, TARGET, check, head, info, summary, vParseFlac, vParseTag, vReadAudio, vFlacStreamInfo } from './00-common.mjs';

const BR_V1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const BR_V2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const SRATE = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

/** 剥掉尾部 ID3v1 / APEv2，返回真正的音频区末端 */
function audioEnd(buf, start) {
  let end = buf.length;
  for (let guard = 0; guard < 2; guard++) {
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

/** 解析首帧帧头，返回 { ver, layer, kbps, sampleRate, spf, frameLen, padBit } */
function firstFrame(buf, from) {
  for (let i = from; i + 4 < buf.length; i++) {
    if (buf[i] !== 0xff || (buf[i + 1] & 0xe0) !== 0xe0) continue;
    const vBits = (buf[i + 1] >> 3) & 3;
    const lBits = (buf[i + 1] >> 1) & 3;
    const brIdx = (buf[i + 2] >> 4) & 0xf;
    const srIdx = (buf[i + 2] >> 2) & 3;
    const pad = (buf[i + 2] >> 1) & 1;
    if (vBits === 1 || lBits === 0 || brIdx === 0 || brIdx === 15 || srIdx === 3) continue;
    const kbps = (vBits === 3 ? BR_V1 : BR_V2)[brIdx];
    const sampleRate = SRATE[vBits === 3 ? 3 : vBits === 2 ? 2 : 0][srIdx];
    // L1=384；L2=1152；L3：MPEG1=1152，MPEG2/2.5=576
    const spf = lBits === 3 ? 384 : lBits === 2 ? 1152 : vBits === 3 ? 1152 : 576;
    return { offset: i, vBits, lBits, kbps, sampleRate, spf, pad, frameLen: Math.floor(((spf / 8) * kbps * 1000) / sampleRate) + pad };
  }
  return null;
}

/** 读 Xing/Info 头：返回 { frames, bytes, sampleRate } 或 null */
function xingInfo(buf, f) {
  // 位置：帧头 4 字节 + side info。MPEG1: 单声道 17 / 双声道 32；MPEG2/2.5: 单声道 9 / 双声道 17
  const sideInfo = f.vBits === 3 ? 32 : 17;
  for (const off of [f.offset + 4 + sideInfo, f.offset + 4 + 17, f.offset + 4 + 9, f.offset + 36, f.offset + 21, f.offset + 13]) {
    if (off + 12 > buf.length) continue;
    const tag = buf.toString('latin1', off, off + 4);
    if (tag !== 'Xing' && tag !== 'Info') continue;
    const flags = buf.readUInt32BE(off + 4);
    const r = { tag, flags, at: off };
    if (flags & 1) r.frames = buf.readUInt32BE(off + 8);
    if (flags & 2) {
      const o = off + 8 + (flags & 1 ? 4 : 0);
      if (o + 4 <= buf.length) r.bytes = buf.readUInt32BE(o);
    }
    return r;
  }
  return null;
}

/** 逐帧走查：返回实际走到的帧数与结束位置 */
function walkFrames(buf, from, end, f0) {
  let pos = from;
  let frames = 0;
  let last = from;
  let stray = 0;
  while (pos + 4 <= end) {
    if (!(buf[pos] === 0xff && (buf[pos + 1] & 0xe0) === 0xe0)) {
      stray++;
      pos++;
      continue;
    }
    const vBits = (buf[pos + 1] >> 3) & 3;
    const lBits = (buf[pos + 1] >> 1) & 3;
    const brIdx = (buf[pos + 2] >> 4) & 0xf;
    const srIdx = (buf[pos + 2] >> 2) & 3;
    const pad = (buf[pos + 2] >> 1) & 1;
    if (vBits === 1 || lBits === 0 || brIdx === 0 || brIdx === 15 || srIdx === 3) {
      stray++;
      pos++;
      continue;
    }
    const kbps = (vBits === 3 ? BR_V1 : BR_V2)[brIdx];
    const sampleRate = SRATE[vBits === 3 ? 3 : vBits === 2 ? 2 : 0][srIdx];
    const spf = lBits === 3 ? 384 : lBits === 2 ? 1152 : vBits === 3 ? 1152 : 576;
    const len = Math.floor(((spf / 8) * kbps * 1000) / sampleRate) + pad;
    if (len < 24) {
      stray++;
      pos++;
      continue;
    }
    frames++;
    last = pos + len;
    pos += len;
  }
  return { frames, last, stray };
}

const all = fs.readdirSync(TARGET).filter((n) => /\.(mp3|flac)$/i.test(n)).sort();

head('1. MP3：用 Xing/Info 权威帧数 + 真实采样率算时长，与 163key 的 duration 对照');
for (const name of all.filter((n) => /\.mp3$/i.test(n))) {
  const p = path.join(TARGET, name);
  const a = vReadAudio(p);
  if (!a.keyHits.length) {
    info(`跳过（无 163key，按策略未写） ${name}`);
    continue;
  }
  const meta = vParseTag(a.keyHits[0].text).meta;
  const buf = fs.readFileSync(p);
  const end = audioEnd(buf, a.audioOffset);
  const f = firstFrame(buf, a.audioOffset);
  const x = xingInfo(buf, f);
  const walk = walkFrames(buf, f.offset, end, f);

  const frames = x?.frames ?? walk.frames;
  const durMs = Math.round((frames * f.spf * 1000) / f.sampleRate);
  const delta = durMs - meta.duration;
  const durOk = Math.abs(delta) <= 1000;
  // Xing/Info 的 bytes 字段由**编码器**写入，实测个别源文件本身就不准（见下 info）。
  // 因此断言改成「与备份里的同一字段一致」，而不是「等于音频区长度」——
  // 前者才是打标签流程的责任范围。Info 头位于音频区内，音频区既然逐字节未变，它就必然未变。
  const bBuf = fs.readFileSync(path.join(BACKUP, name));
  const bf = firstFrame(bBuf, vReadAudio(path.join(BACKUP, name)).audioOffset);
  const bx = xingInfo(bBuf, bf);
  const bytesOk = (x?.bytes ?? null) === (bx?.bytes ?? null) && (x?.frames ?? null) === (bx?.frames ?? null);
  // 走查帧数与权威帧数一致（允许 ±2 帧边界误差）
  const framesOk = Math.abs(walk.frames - frames) <= 2;
  // 走查结束位置应当正好到音频区末尾（允许少量尾部残留：有的源文件尾部有编码器附加数据）
  const tailOk = Math.abs(walk.last - end) <= 4096;
  if (x?.bytes != null && x.bytes !== end - a.audioOffset) {
    info(`  源文件 Info.bytes 本身与音频区长度不符（编码器问题，非本次打标签造成） ${name}`, `Info.bytes=${x.bytes} 实际音频区=${end - a.audioOffset} 差=${x.bytes - (end - a.audioOffset)}B`);
  }

  check(
    durOk && bytesOk && framesOk && tailOk,
    `MP3 ${name}`,
    `${x?.tag ?? 'noXing'} 帧数 ${frames} ${f.sampleRate}Hz spf=${f.spf} 实际 ${durMs}ms vs meta ${meta.duration}ms (Δ${delta}) 走查帧 ${walk.frames} 尾部残留 ${end - walk.last}B`,
  );
}

head('2. FLAC：STREAMINFO 权威时长 + 帧同步码密度（确认码流未断裂）');
for (const name of all.filter((n) => /\.flac$/i.test(n))) {
  const p = path.join(TARGET, name);
  const a = vReadAudio(p);
  if (!a.keyHits.length) {
    info(`跳过（无 163key，按策略未写） ${name}`);
    continue;
  }
  const meta = vParseTag(a.keyHits[0].text).meta;
  const buf = fs.readFileSync(p);
  const flac = vParseFlac(buf);
  const si = vFlacStreamInfo(flac.blocks);
  const delta = si.durationMs - meta.duration;
  const durOk = Math.abs(delta) <= 1000;
  // 同步码密度：正常 FLAC 帧 1~16KB
  let sync = 0;
  for (let i = flac.audioOffset; i + 1 < buf.length; i++) if (buf[i] === 0xff && (buf[i + 1] & 0xfe) === 0xf8) sync++;
  const avg = sync ? Math.round((buf.length - flac.audioOffset) / sync) : 0;
  const syncOk = sync > 0 && avg > 300 && avg < 40000;
  check(durOk && syncOk, `FLAC ${name}`, `STREAMINFO ${si.durationMs}ms(${si.totalSamples}样本 ${si.sampleRate}Hz ${si.channels}ch ${si.bitsPerSample}bit) vs meta ${meta.duration}ms (Δ${delta}) 帧同步 ${sync} 个 平均 ${avg}B/帧`);
}

head('3. 抽样：工作副本音频区 vs 备份音频区，首/中/尾各 1MB 逐字节比对');
{
  const samples = [...all.filter((n) => /\.mp3$/i.test(n)).slice(0, 5), ...all.filter((n) => /\.flac$/i.test(n)).slice(0, 5)];
  for (const name of samples) {
    const ta = fs.readFileSync(path.join(TARGET, name));
    const tb = fs.readFileSync(path.join(BACKUP, name));
    const a = vReadAudio(path.join(TARGET, name)).audioOffset;
    const b = vReadAudio(path.join(BACKUP, name)).audioOffset;
    const A = ta.subarray(a);
    const B = tb.subarray(b);
    const N = 1048576;
    const mid = Math.floor(A.length / 2);
    const parts = [
      ['首', 0, N],
      ['中', Math.max(0, mid - N / 2), mid + N / 2],
      ['尾', Math.max(0, A.length - N), A.length],
    ];
    let ok = A.length === B.length;
    const detail = [];
    for (const [label, s, e] of parts) {
      const eq = A.subarray(s, e).equals(B.subarray(s, e));
      if (!eq) ok = false;
      detail.push(`${label}${eq ? '✓' : '✗'}`);
    }
    check(ok, `首中尾比对 ${name}`, `音频区 ${A.length}B ${detail.join(' ')}`);
  }
}

head('4. MP3 尾部标签（ID3v1 / APEv2）是否与备份逐字节一致');
{
  for (const name of all.filter((n) => /\.mp3$/i.test(n))) {
    const tp = path.join(TARGET, name);
    const bp = path.join(BACKUP, name);
    const tb = fs.readFileSync(tp);
    const bb = fs.readFileSync(bp);
    const tId3v1 = tb.toString('latin1', tb.length - 128, tb.length - 125) === 'TAG';
    const bId3v1 = bb.toString('latin1', bb.length - 128, bb.length - 125) === 'TAG';
    if (tId3v1 !== bId3v1) {
      check(false, `ID3v1 存在性变化 ${name}`, `target=${tId3v1} backup=${bId3v1}`);
      continue;
    }
    if (!tId3v1) {
      continue;
    }
    const te = tb.subarray(tb.length - 128);
    const be = bb.subarray(bb.length - 128);
    check(te.equals(be), `ID3v1 标签 128 字节未变 ${name}`, `"${te.toString('latin1', 3, 33).replace(/\0/g, '').trim()}"`);
  }
}

process.exitCode = summary('07-audio-integrity-deep') ? 0 : 1;
