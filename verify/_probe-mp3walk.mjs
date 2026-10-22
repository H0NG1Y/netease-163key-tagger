/**
 * verify/_probe-mp3walk.mjs —— 调试：为什么某些 MP3 的累计帧时长与 163key 里的 duration 不符
 *
 * 要分清两种情况：
 *   (a) 我的走查写错了（帧长/样本数算错）
 *   (b) 文件里的音频实际时长与写入的 duration 真的不符
 * 注意：02 号脚本已证明音频字节与备份完全一致，所以 (b) 也**不是**打标签造成的损坏，
 * 而是「元数据描述与文件实际内容不符」，属于另一类问题。
 */
import fs from 'node:fs';
import path from 'node:path';
import { BACKUP, TARGET, vParseId3v2, vParseTag, vReadAudio } from './00-common.mjs';

const BR_V1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const BR_V2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const SRATE = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

const files = ['阴雨天 - 和你的照片还留着.mp3', '颜人中 - 我只能离开.mp3', 'G-DRAGON - POWER.mp3', '郑润泽 - 瞬.mp3'];

for (const name of files) {
  const p = path.join(TARGET, name);
  const a = vReadAudio(p);
  const meta = vParseTag(a.keyHits[0].text).meta;
  const buf = fs.readFileSync(p);
  // 剥掉尾部 ID3v1
  let end = buf.length;
  if (end - a.audioOffset >= 128 && buf.toString('latin1', end - 128, end - 125) === 'TAG') end -= 128;
  const audioLen = end - a.audioOffset;

  console.log(`\n=== ${name}`);
  console.log(`  ID3v2 标签区 ${a.audioOffset} 字节, 音频区 ${audioLen} 字节, meta.duration=${meta.duration}`);

  // 打印前 3 帧的帧头字段
  let i = a.audioOffset;
  for (let k = 0; k < 3 && i + 4 < buf.length; k++) {
    while (i + 4 < buf.length && !(buf[i] === 0xff && (buf[i + 1] & 0xe0) === 0xe0)) i++;
    const vBits = (buf[i + 1] >> 3) & 3;
    const lBits = (buf[i + 1] >> 1) & 3;
    const brIdx = (buf[i + 2] >> 4) & 0xf;
    const srIdx = (buf[i + 2] >> 2) & 3;
    const pad = (buf[i + 2] >> 1) & 1;
    const verName = vBits === 3 ? 'MPEG1' : vBits === 2 ? 'MPEG2' : vBits === 0 ? 'MPEG2.5' : 'reserved';
    const layerName = lBits === 3 ? 'L1' : lBits === 2 ? 'L2' : lBits === 1 ? 'L3' : 'res';
    console.log(`  帧@${i}: ${verName} ${layerName} brIdx=${brIdx}(${(vBits === 3 ? BR_V1 : BR_V2)[brIdx]}k) srIdx=${srIdx}(${SRATE[vBits === 3 ? 3 : vBits === 2 ? 2 : 0][srIdx]}Hz) pad=${pad}`);
    i += 4;
  }

  // 用「帧长 = 全文件音频区 / 帧数」反推：先精确走一遍，记录用的 spf
  let pos = a.audioOffset;
  let frames = 0;
  const spfSet = new Set();
  const frameLens = [];
  while (pos + 4 <= end) {
    if (!(buf[pos] === 0xff && (buf[pos + 1] & 0xe0) === 0xe0)) {
      pos++;
      continue;
    }
    const vBits = (buf[pos + 1] >> 3) & 3;
    const lBits = (buf[pos + 1] >> 1) & 3;
    const brIdx = (buf[pos + 2] >> 4) & 0xf;
    const srIdx = (buf[pos + 2] >> 2) & 3;
    const pad = (buf[pos + 2] >> 1) & 1;
    if (vBits === 1 || lBits === 0 || brIdx === 0 || brIdx === 15 || srIdx === 3) {
      pos++;
      continue;
    }
    const kbps = (vBits === 3 ? BR_V1 : BR_V2)[brIdx];
    const sr = SRATE[vBits === 3 ? 3 : vBits === 2 ? 2 : 0][srIdx];
    // MPEG1 L3 = 1152, MPEG2/2.5 L3 = 576；L1=384, L2=1152
    const spf = lBits === 3 ? 384 : lBits === 2 ? 1152 : vBits === 3 ? 1152 : 576;
    const len = Math.floor(((spf / 8) * kbps * 1000) / sr) + pad;
    spfSet.add(`${vBits}/${lBits}/${spf}`);
    frameLens.push(len);
    frames++;
    pos += len;
  }
  const uniq = [...new Set(frameLens)];
  console.log(`  走查结果: ${frames} 帧, 帧长取值 ${uniq.slice(0, 5).join(',')}${uniq.length > 5 ? '...' : ''}, 参数(spf) ${[...spfSet].join(' ')}`);
  console.log(`  帧数×帧长 = ${frames * (uniq.length === 1 ? uniq[0] : 0)} vs 音频区 ${audioLen}`);
  for (const s of spfSet) {
    const [, , spf] = s.split('/').map(Number);
    const sr = 44100;
    console.log(`  若按 spf=${spf} @44100: 时长 = ${Math.round((frames * spf) / sr * 1000)}ms  (meta=${meta.duration})`);
  }
  // 用 Xing/Info 头找权威帧数
  const first = a.audioOffset;
  for (const off of [first + 4 + 32, first + 4 + 17, first + 36, first + 21, first + 13]) {
    const tagTxt = buf.toString('latin1', off, off + 4);
    if (tagTxt === 'Xing' || tagTxt === 'Info') {
      const flags = buf.readUInt32BE(off + 4);
      console.log(`  找到 ${tagTxt} @${off} flags=0x${flags.toString(16)} bytes=${flags & 2 ? buf.readUInt32BE(off + 12) : 'n/a'} frames=${flags & 1 ? buf.readUInt32BE(off + 8) : 'n/a'}`);
    }
  }
}
