/**
 * verify/_probe-tail.mjs —— 探查「心底的旧」音频区末尾那 583 字节到底是什么
 *
 * 07 号脚本报了这一处「收尾差 583B」。需要判定：
 *   (a) 是打标签造成的损坏 —— 严重，P0
 *   (b) 是原文件本来就有的尾部数据（Lyrics3 / APEv2 / 静音帧）—— 与打标签无关
 * 02 号已经证明音频区字节与备份完全相同，所以预计是 (b)，但必须查清楚它是什么。
 */
import fs from 'node:fs';
import path from 'node:path';
import { BACKUP, ORIGINAL, TARGET, md5hex, vReadAudio } from './00-common.mjs';

const name = 'pro、陈小满 - 心底的旧.mp3';
for (const root of [TARGET, BACKUP, ORIGINAL]) {
  const p = path.join(root, name);
  const buf = fs.readFileSync(p);
  const a = vReadAudio(p);
  // 剥 ID3v1
  let end = buf.length;
  if (buf.toString('latin1', end - 128, end - 125) === 'TAG') end -= 128;
  const audio = buf.subarray(a.audioOffset, end);
  console.log(`\n=== ${root}`);
  console.log(`  文件 ${buf.length}  标签区 ${a.audioOffset}  音频区(剥ID3v1后) ${audio.length}  md5 ${md5hex(audio)}`);
  // 搜索已知尾部标签特征
  for (const [sig, label] of [
    ['LYRICSBEGIN', 'Lyrics3v2'],
    ['APETAGEX', 'APEv2'],
    ['TAG+', 'ID3v1 enhanced'],
    ['ID3', 'ID3v2 (嵌套?)'],
  ]) {
    const i = buf.indexOf(Buffer.from(sig, 'latin1'));
    if (i >= 0) console.log(`  含 ${label} 特征 @${i}`);
  }
  // 最后 600 字节里有没有帧同步
  console.log(`  末 600 字节 hex 头 64: ${audio.subarray(audio.length - 600, audio.length - 536).toString('hex')}`);
}

// 逐字节比对 target vs backup 的音频区
{
  const t = fs.readFileSync(path.join(TARGET, name));
  const b = fs.readFileSync(path.join(BACKUP, name));
  const ta = vReadAudio(path.join(TARGET, name)).audioOffset;
  const ba = vReadAudio(path.join(BACKUP, name)).audioOffset;
  let te = t.length;
  if (t.toString('latin1', te - 128, te - 125) === 'TAG') te -= 128;
  let be = b.length;
  if (b.toString('latin1', be - 128, be - 125) === 'TAG') be -= 128;
  const TA = t.subarray(ta, te);
  const BA = b.subarray(ba, be);
  console.log(`\n=== 音频区逐字节比对`);
  console.log(`  target ${TA.length}B  backup ${BA.length}B  equals=${TA.equals(BA)}`);
}
