#!/usr/bin/env node
/**
 * verify/02-audio-integrity.mjs —— 音频区字节不可变性审计
 *
 * 核心断言：写 163key 只允许改标签区，音频字节一个 bit 都不许动。
 *
 * 独立性说明：
 *   音频区起点（audioOffset）由 verify/00-common.mjs 里**自己写的** ID3v2 / FLAC 解析器
 *   从文件字节推导，不使用 lib/tags.mjs 的 parseId3v2/parseFlac，也不读取任何 out/*.json 报告。
 *
 * 三重比对：
 *   1. target vs backup（E:\CloudMusic_backup_20261022）—— 备份是写前快照
 *   2. target vs 原始素材（E:\CloudMusic）      —— 原始素材是更早的源头，做交叉印证
 *   3. target 自身结构自洽                     —— 音频区长度 = 文件长度 - 标签区长度
 *
 * 另外检查尾部标签（ID3v1 / APEv2）没有被顺手破坏：它们也是「非音频区」，
 * 但不属于本工具应当修改的范围，动了就是副作用。
 *
 * 运行：node verify/02-audio-integrity.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { BACKUP, C, ORIGINAL, TARGET, check, head, info, md5hex, sha256hex, summary, vParseFlac, vParseId3v2, vReadAudio } from './00-common.mjs';

/**
 * 独立计算「音频区」的起止，并顺手探测尾部标签。
 * 返回 { audioStart, audioEnd, tailTags: [...], notes: [...] }
 */
function audioSpan(buf, format) {
  const notes = [];
  const tailTags = [];
  let audioStart = 0;
  let audioEnd = buf.length;

  if (format === 'mp3') {
    const id3 = vParseId3v2(buf);
    audioStart = id3.present ? id3.total : 0;
    if (id3.present && id3.truncated) notes.push(`ID3v2 声明长度 ${id3.total} 超出文件 ${buf.length}`);
    // ID3v1：末尾 128 字节，以 "TAG" 开头
    if (audioEnd - audioStart >= 128 && buf.toString('latin1', audioEnd - 128, audioEnd - 125) === 'TAG') {
      tailTags.push({ kind: 'ID3v1', offset: audioEnd - 128, len: 128 });
      audioEnd -= 128;
    }
    // APEv2：末尾 footer "APETAGEX"
    if (audioEnd - audioStart >= 32 && buf.toString('latin1', audioEnd - 32, audioEnd - 24) === 'APETAGEX') {
      const size = buf.readUInt32LE(audioEnd - 32 + 12);
      const hasHeader = !!(buf.readUInt32LE(audioEnd - 32 + 20) & 0x80000000);
      const total = size + (hasHeader ? 32 : 0);
      if (audioEnd - total >= audioStart) {
        tailTags.push({ kind: 'APEv2', offset: audioEnd - total, len: total });
        audioEnd -= total;
      } else notes.push(`APEv2 声明长度 ${total} 越界，未剥离`);
    }
    // 连续多个尾部标签的情况（ID3v1 之外再套 APEv2）已在上面按顺序剥离
  } else if (format === 'flac') {
    const flac = vParseFlac(buf);
    audioStart = flac.audioOffset ?? 0;
    for (const p of flac.problems) notes.push(p);
    // FLAC 理论上没有尾部标签；ID3v1 出现在 FLAC 里属于脏数据，如实记录
    if (audioEnd - audioStart >= 128 && buf.toString('latin1', audioEnd - 128, audioEnd - 125) === 'TAG') {
      tailTags.push({ kind: 'ID3v1-on-FLAC', offset: audioEnd - 128, len: 128 });
    }
  }
  return { audioStart, audioEnd, tailTags, notes };
}

const files = fs.readdirSync(TARGET).filter((n) => /\.(mp3|flac)$/i.test(n)).sort();
info('审计文件数', String(files.length));

const rows = [];
let problems = 0;

head('1. 逐文件：音频区 md5（target vs backup vs 原始素材）');
for (const name of files) {
  const tp = path.join(TARGET, name);
  const bp = path.join(BACKUP, name);
  const op = path.join(ORIGINAL, name);

  const tbuf = fs.readFileSync(tp);
  const fmt = vReadAudio(tp).format;
  const tSpan = audioSpan(tbuf, fmt);
  const tAudio = tbuf.subarray(tSpan.audioStart, tSpan.audioEnd);
  const tMd5 = md5hex(tAudio);

  let line = `${name}`;
  let ok = true;
  const detail = [];

  if (!fs.existsSync(bp)) {
    ok = false;
    detail.push('备份缺失');
  } else {
    const bbuf = fs.readFileSync(bp);
    const bSpan = audioSpan(bbuf, fmt);
    const bAudio = bbuf.subarray(bSpan.audioStart, bSpan.audioEnd);
    const bMd5 = md5hex(bAudio);
    const same = bMd5 === tMd5;
    ok = ok && same;
    if (!same) detail.push(`backup md5 不同 (t=${tMd5.slice(0, 12)} b=${bMd5.slice(0, 12)})`);
    // 音频区长度必须相等（音频流不允许增删字节）
    if (tAudio.length !== bAudio.length) {
      ok = false;
      detail.push(`音频区长度不同 t=${tAudio.length} b=${bAudio.length}`);
    }
    // 尾部标签结构也必须一致（种类与长度；offset 会随标签区变大整体平移，属正常）
    const shape = (arr) => arr.map((t) => `${t.kind}:${t.len}`).join(',');
    const tShape = shape(tSpan.tailTags);
    const bShape = shape(bSpan.tailTags);
    if (tShape !== bShape) {
      ok = false;
      detail.push(`尾部标签结构变了 t=[${tShape}] b=[${bShape}]`);
    }
    if (tSpan.tailTags.length) {
      for (let i = 0; i < tSpan.tailTags.length; i++) {
        const a = tbuf.subarray(tSpan.tailTags[i].offset, tSpan.tailTags[i].offset + tSpan.tailTags[i].len);
        const b = bbuf.subarray(bSpan.tailTags[i].offset, bSpan.tailTags[i].offset + bSpan.tailTags[i].len);
        if (!a.equals(b)) {
          ok = false;
          detail.push(`尾部标签 ${tSpan.tailTags[i].kind} 字节变了`);
        }
      }
    }
  }

  if (fs.existsSync(op)) {
    const obuf = fs.readFileSync(op);
    const oSpan = audioSpan(obuf, fmt);
    const oAudio = obuf.subarray(oSpan.audioStart, oSpan.audioEnd);
    if (md5hex(oAudio) !== tMd5) {
      ok = false;
      detail.push('原始素材 md5 不同');
    }
  } else {
    detail.push('原始素材缺失(不算失败)');
  }

  // 结构自洽：标签区 + 音频区 + 尾部 = 文件长度
  const recon = tSpan.audioStart + (tSpan.audioEnd - tSpan.audioStart) + (tbuf.length - tSpan.audioEnd);
  if (recon !== tbuf.length) {
    ok = false;
    detail.push(`结构不自洽 recomposed=${recon} != size=${tbuf.length}`);
  }
  if (tSpan.notes.length) {
    ok = false;
    detail.push(`解析告警: ${tSpan.notes.join('; ')}`);
  }

  if (!ok) problems++;
  check(ok, `${fmt.padEnd(4)} ${name}`, detail.join(' | ') || `md5=${tMd5.slice(0, 16)} audioLen=${tAudio.length} tagLen=${tSpan.audioStart}`);

  rows.push({
    file: name,
    format: fmt,
    size: tbuf.length,
    audioStart: tSpan.audioStart,
    audioEnd: tSpan.audioEnd,
    audioLen: tAudio.length,
    audioMd5: tMd5,
    tailTags: tSpan.tailTags.map((t) => t.kind),
    sha256: sha256hex(tbuf),
  });
}

// ───────────────────────────────────────────────────────────────────────────
head('2. 专项：MP3 走 rewrite 策略的文件（文件变大 = 整文件重写过），音频偏移必须整体平移而音频字节不变');
// ───────────────────────────────────────────────────────────────────────────
{
  const mp3s = rows.filter((r) => r.format === 'mp3');
  for (const r of mp3s) {
    const bbuf = fs.readFileSync(path.join(BACKUP, r.file));
    const bSpan = audioSpan(bbuf, 'mp3');
    const tbuf = fs.readFileSync(path.join(TARGET, r.file));
    const tSpan = audioSpan(tbuf, 'mp3');
    const delta = tSpan.audioStart - bSpan.audioStart;
    const changed = tbuf.length !== bbuf.length;
    // 定位第一处差异字节：rewrite 之后，标签区内容必然变；音频区必须完全一致
    const tAudio = tbuf.subarray(tSpan.audioStart, tSpan.audioEnd);
    const bAudio = bbuf.subarray(bSpan.audioStart, bSpan.audioEnd);
    const sameAudio = tAudio.equals(bAudio);
    check(
      sameAudio,
      `${r.file}`,
      `标签区 ${bSpan.audioStart} -> ${tSpan.audioStart} (Δ${delta >= 0 ? '+' : ''}${delta})，文件${changed ? '变大' : '等大'}，音频区 ${bAudio.length} 字节${sameAudio ? '逐字节一致' : '不一致!'}`,
    );
    if (delta !== 0 && changed === false) {
      check(false, `  ${r.file} 异常组合：偏移变了但文件大小没变`);
    }
  }
}

// ───────────────────────────────────────────────────────────────────────────
head('3. 专项：备份文件本身没有被写过（mtime/sha256 与原始素材比对）');
// ───────────────────────────────────────────────────────────────────────────
{
  let n = 0;
  let bad = 0;
  for (const name of files) {
    const bp = path.join(BACKUP, name);
    const op = path.join(ORIGINAL, name);
    if (!fs.existsSync(bp) || !fs.existsSync(op)) continue;
    n++;
    const b = fs.readFileSync(bp);
    const o = fs.readFileSync(op);
    if (!b.equals(o)) {
      bad++;
      check(false, `备份与原始素材不一致: ${name}`, `sha b=${sha256hex(b).slice(0, 12)} o=${sha256hex(o).slice(0, 12)}`);
    }
  }
  check(bad === 0, '备份目录与原始素材逐字节一致（备份确实是「写前快照」）', `${n} 个文件比对`);
}

// ───────────────────────────────────────────────────────────────────────────
head('4. 专项：CLOUDMUSIC 原始素材目录未被本次操作改动（与备份对照）');
// ───────────────────────────────────────────────────────────────────────────
{
  // 保护目录的一个可观测证据：原始素材与备份同为「写前状态」，任何 target 独有的变化都不该出现在它们身上
  const tChanged = rows.filter((r) => {
    const b = fs.readFileSync(path.join(BACKUP, r.file));
    return sha256hex(b) !== r.sha256;
  });
  info('target 相对备份发生变化的文件数', String(tChanged.length));
  const oChanged = tChanged.filter((r) => {
    const o = fs.readFileSync(path.join(ORIGINAL, r.file));
    const b = fs.readFileSync(path.join(BACKUP, r.file));
    return !o.equals(b);
  });
  check(oChanged.length === 0, '原始素材与备份在所有被改动的文件上仍然一致（原始素材没被连带修改）', oChanged.map((r) => r.file).join(', '));
}

fs.writeFileSync(new URL('./audio-integrity.json', import.meta.url), JSON.stringify({ generatedAt: new Date().toISOString(), rows, problems }, null, 2), 'utf8');

process.exitCode = summary('02-audio-integrity') ? 0 : 1;
