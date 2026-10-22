/**
 * verify/00-common.mjs —— 独立验证用的「零信任」基础设施。
 *
 * 设计原则（这是本次审计的全部价值所在）：
 *   本文件 **不 import** 项目里的任何模块（lib/163key.mjs、lib/tags.mjs 都不 import）。
 *   163key 的加解密、ID3v2 的帧解析、FLAC 的元数据块解析，全部在下面从零实现，
 *   只依赖 node: 内置模块。
 *
 * 唯一例外：05-guard.mjs 需要调用 write163Key() 来验证它是否抛错，那是被测对象本身。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// ───────────────────────────────────────────────────────────────────────────
// 1. 163key 加解密（node:crypto 从零实现，不参考项目实现）
// ───────────────────────────────────────────────────────────────────────────

/**
 * AES-128 密钥 16 字节。用 hex 硬编码而不是字面量字符串，避免转义歧义：
 *   "#14ljk_!\]&0U<'(" -> 23 31 34 6c 6a 6b 5f 21 5c 5d 26 30 55 3c 27 28
 */
export const V_KEY = Buffer.from('2331346c6a6b5f215c5d2630553c2728', 'hex');

export const V_TAG_PREFIX = "163 key(Don't modify):";
export const V_PLAIN_PREFIX = 'music:';

if (V_KEY.length !== 16) throw new Error(`自建实现：密钥长度 ${V_KEY.length} != 16`);

/** 明文 -> 密文 base64（AES-128-ECB + PKCS#7 自动填充） */
export function vEncrypt(plaintext) {
  const c = crypto.createCipheriv('aes-128-ecb', V_KEY, null);
  c.setAutoPadding(true); // PKCS#7
  return Buffer.concat([c.update(Buffer.from(plaintext, 'utf8')), c.final()]).toString('base64');
}

/** base64 密文 -> 明文（严格模式：解密失败会抛，不吞异常） */
export function vDecrypt(b64) {
  const ct = Buffer.from(b64, 'base64');
  if (ct.length % 16 !== 0 || ct.length === 0) {
    throw new Error(`密文长度 ${ct.length} 不是 16 的正整数倍`);
  }
  const d = crypto.createDecipheriv('aes-128-ecb', V_KEY, null);
  d.setAutoPadding(true);
  return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
}

/**
 * 从一段标签文本里剥离前缀并解密。返回 { b64, plaintext, meta }。
 * 前缀可以出现在任意位置（有的写法把整串放进 TXXX），所以用 indexOf。
 */
export function vParseTag(text) {
  if (typeof text !== 'string') throw new Error('text 不是字符串');
  const i = text.indexOf(V_TAG_PREFIX);
  if (i < 0) throw new Error(`缺少前缀 ${JSON.stringify(V_TAG_PREFIX)}`);
  const b64 = text.slice(i + V_TAG_PREFIX.length).trim();
  const plaintext = vDecrypt(b64);
  if (!plaintext.startsWith(V_PLAIN_PREFIX)) {
    throw new Error(`明文缺少 "music:" 前缀，实际开头：${JSON.stringify(plaintext.slice(0, 16))}`);
  }
  let meta;
  try {
    meta = JSON.parse(plaintext.slice(V_PLAIN_PREFIX.length));
  } catch (e) {
    throw new Error(`明文 JSON 解析失败: ${e.message}`);
  }
  return { b64, plaintext, meta };
}

// ───────────────────────────────────────────────────────────────────────────
// 2. 哈希工具
// ───────────────────────────────────────────────────────────────────────────

export const md5hex = (b) => crypto.createHash('md5').update(b).digest('hex');
export const sha256hex = (b) => crypto.createHash('sha256').update(b).digest('hex');

// ───────────────────────────────────────────────────────────────────────────
// 3. ID3v2 解析（从零，按字节）
// ───────────────────────────────────────────────────────────────────────────

const synchsafe = (b, o) => ((b[o] & 0x7f) << 21) | ((b[o + 1] & 0x7f) << 14) | ((b[o + 2] & 0x7f) << 7) | (b[o + 3] & 0x7f);

/**
 * 解析 ID3v2 标签，返回：
 *   { present, ver, rev, flags, size, footer, total, unsync, extHeader, frames: [...] }
 * 每个 frame: { id, size, flags, data, headerOffset, rawOffset, rawLen }
 * 失败/不存在返回 { present: false, total: 0 }。
 * 注意：这里**不解 unsynchronisation**，只在返回里如实标记，让上层决定。
 */
export function vParseId3v2(buf) {
  const none = { present: false, total: 0, frames: [] };
  if (buf.length < 10) return none;
  if (buf.toString('latin1', 0, 3) !== 'ID3') return none;

  const ver = buf[3];
  const rev = buf[4];
  const flags = buf[5];
  const size = synchsafe(buf, 6);
  const footer = ver === 4 && !!(flags & 0x10);
  const total = 10 + size + (footer ? 10 : 0);
  const out = {
    present: true,
    ver,
    rev,
    flags,
    size,
    footer,
    total,
    unsync: !!(flags & 0x80),
    extHeader: !!(flags & 0x40),
    frames: [],
    truncated: total > buf.length,
  };
  if (out.truncated) return out;

  let p = 10;
  const end = 10 + size;

  // 扩展头
  if (out.extHeader) {
    if (ver === 4) {
      const ehSize = synchsafe(buf, p);
      p += ehSize; // 按照规范 2.4 扩展头大小含自身
    } else {
      const ehSize = buf.readUInt32BE(p);
      p += 4 + ehSize;
    }
  }

  while (p + (ver === 2 ? 6 : 10) <= end) {
    // 填充区（全 0）即结束
    if (buf[p] === 0) break;
    let id;
    let fsize;
    let fflags = 0;
    if (ver === 2) {
      id = buf.toString('latin1', p, p + 3);
      fsize = (buf[p + 3] << 16) | (buf[p + 4] << 8) | buf[p + 5];
      p += 6;
    } else {
      id = buf.toString('latin1', p, p + 4);
      fsize = ver === 4 ? synchsafe(buf, p + 4) : buf.readUInt32BE(p + 4);
      fflags = buf.readUInt16BE(p + 8);
      p += 10;
    }
    if (!/^[A-Z0-9]{3,4}$/.test(id)) break; // 帧区结束（padding 或损坏）
    if (p + fsize > end) {
      out.frames.push({ id, size: fsize, flags: fflags, data: buf.subarray(p, end), headerOffset: p - (ver === 2 ? 6 : 10), rawOffset: p - (ver === 2 ? 6 : 10), rawLen: end - (p - (ver === 2 ? 6 : 10)), corrupt: true });
      break;
    }
    out.frames.push({
      id,
      size: fsize,
      flags: fflags,
      data: buf.subarray(p, p + fsize),
      headerOffset: p - (ver === 2 ? 6 : 10),
      rawOffset: p - (ver === 2 ? 6 : 10),
      rawLen: (ver === 2 ? 6 : 10) + fsize,
    });
    p += fsize;
  }
  return out;
}

/** 按 ID3 文本编码字节解字符串。enc: 0=latin1, 1=utf16(带 BOM), 2=utf16be, 3=utf8 */
export function vDecodeId3Text(bytes, enc) {
  if (bytes.length === 0) return '';
  switch (enc) {
    case 0:
      return bytes.toString('latin1').replace(/\0+$/, '');
    case 1: {
      // BOM 决定字节序
      if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return bytes.subarray(2).toString('utf16le').replace(/\0+$/, '');
      if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
        const swapped = Buffer.from(bytes.subarray(2));
        swapped.swap16();
        return swapped.toString('utf16le').replace(/\0+$/, '');
      }
      return bytes.toString('utf16le').replace(/\0+$/, '');
    }
    case 2: {
      const swapped = Buffer.from(bytes);
      if (swapped.length % 2) return swapped.toString('utf16le');
      swapped.swap16();
      return swapped.toString('utf16le').replace(/\0+$/, '');
    }
    case 3:
      return bytes.toString('utf8').replace(/\0+$/, '');
    default:
      return bytes.toString('latin1');
  }
}

/** 解析 COMM 帧：enc(1) + lang(3) + 短描述(0 结尾) + 正文 */
export function vParseComm(data) {
  const enc = data[0];
  const lang = data.toString('latin1', 1, 4);
  let p = 4;
  // 描述以 0 结尾
  if (enc === 1 || enc === 2) {
    while (p + 1 < data.length && !(data[p] === 0 && data[p + 1] === 0)) p += 2;
    p += 2;
  } else {
    while (p < data.length && data[p] !== 0) p += 1;
    p += 1;
  }
  return { enc, lang, description: '', text: vDecodeId3Text(data.subarray(p), enc), rawTextBytes: data.subarray(p) };
}

/** 解析 TXXX 帧：enc(1) + 描述(0 结尾) + 值 */
export function vParseTxxx(data) {
  const enc = data[0];
  let p = 1;
  if (enc === 1 || enc === 2) {
    while (p + 1 < data.length && !(data[p] === 0 && data[p + 1] === 0)) p += 2;
    const desc = vDecodeId3Text(data.subarray(1, p), enc);
    p += 2;
    return { enc, description: desc, text: vDecodeId3Text(data.subarray(p), enc) };
  }
  while (p < data.length && data[p] !== 0) p += 1;
  const desc = vDecodeId3Text(data.subarray(1, p), enc);
  p += 1;
  return { enc, description: desc, text: vDecodeId3Text(data.subarray(p), enc) };
}

/**
 * 在 ID3 标签里找 163key。返回所有携带 TAG_PREFIX 的落点（可能是 COMM，也可能是 TXXX）。
 * 返回 { found: [{ frameId, description, text }], plainTextFound: [...] }
 */
export function vFind163InId3(id3) {
  const found = [];
  for (const f of id3.frames) {
    let text = null;
    let description = '';
    try {
      if (f.id === 'COMM') {
        const c = vParseComm(f.data);
        text = c.text;
        description = c.description;
      } else if (f.id === 'TXXX') {
        const t = vParseTxxx(f.data);
        text = t.text;
        description = t.description;
      } else if (f.id === 'USLT') {
        text = vDecodeId3Text(f.data.subarray(4), f.data[0]);
        description = '';
      } else {
        continue;
      }
    } catch {
      continue;
    }
    if (typeof text === 'string' && text.includes(V_TAG_PREFIX)) found.push({ frameId: f.id, description, text });
  }
  return found;
}

// ───────────────────────────────────────────────────────────────────────────
// 4. FLAC 解析（从零，按字节）
// ───────────────────────────────────────────────────────────────────────────

export const FLAC_TYPE = {
  0: 'STREAMINFO',
  1: 'PADDING',
  2: 'APPLICATION',
  3: 'SEEKTABLE',
  4: 'VORBIS_COMMENT',
  5: 'CUESHEET',
  6: 'PICTURE',
  7: 'UNKNOWN7',
  126: 'UNKNOWN126',
  127: 'INVALID',
};

/**
 * 解析 FLAC 元数据块。返回 { valid, blocks, audioOffset, lastOk, problems }
 * 严格检查：最后一个块必须带 0x80 last 标志，且 audioOffset 处必须是音频帧同步码。
 */
export function vParseFlac(buf) {
  const out = { valid: false, blocks: [], audioOffset: null, lastOk: false, problems: [] };
  if (buf.length < 8) {
    out.problems.push('文件小于 8 字节');
    return out;
  }
  if (buf.toString('latin1', 0, 4) !== 'fLaC') {
    out.problems.push(`魔数不是 fLaC，实际 ${JSON.stringify(buf.toString('latin1', 0, 4))}`);
    return out;
  }
  let off = 4;
  let guard = 0;
  let sawLast = false;
  while (off + 4 <= buf.length) {
    if (++guard > 4096) {
      out.problems.push('元数据块数量异常 ( > 4096 )，疑似死循环');
      return out;
    }
    const h = buf[off];
    const last = !!(h & 0x80);
    const type = h & 0x7f;
    const len = (buf[off + 1] << 16) | (buf[off + 2] << 8) | buf[off + 3];
    const dataStart = off + 4;
    if (dataStart + len > buf.length) {
      out.problems.push(`块 type=${type} len=${len} 越界 (dataStart=${dataStart}, fileLen=${buf.length})`);
      return out;
    }
    out.blocks.push({ last, type, typeName: FLAC_TYPE[type] || `UNKNOWN${type}`, len, headerOffset: off, dataStart, data: buf.subarray(dataStart, dataStart + len) });
    off = dataStart + len;
    if (last) {
      sawLast = true;
      break;
    }
  }
  out.lastOk = sawLast;
  out.audioOffset = off;
  if (!sawLast) out.problems.push('遍历完所有块都没有遇到 last 标志位');
  if (out.blocks.length && out.blocks[0].type !== 0) out.problems.push(`第一个块不是 STREAMINFO，而是 ${out.blocks[0].typeName}`);
  if (out.blocks.some((b) => b.type === 127)) out.problems.push('存在 type=127（INVALID）块');
  // 音频起始应当是一个合法 FLAC 帧头：14 bit 同步码 0b11111111111110
  if (out.audioOffset + 1 < buf.length) {
    const w = (buf[out.audioOffset] << 8) | buf[out.audioOffset + 1];
    if ((w & 0xfff8) !== 0xfff8) out.problems.push(`audioOffset=${out.audioOffset} 处不是 FLAC 帧同步码 (0x${w.toString(16)})`);
  }
  out.valid = sawLast && out.blocks.length > 0 && out.blocks[0].type === 0;
  return out;
}

/** 解析 Vorbis comment 块：返回 { vendor, comments: ['K=V', ...] } */
export function vParseVorbisComment(data) {
  let p = 0;
  const vendorLen = data.readUInt32LE(p);
  p += 4;
  const vendor = data.toString('utf8', p, p + vendorLen);
  p += vendorLen;
  const count = data.readUInt32LE(p);
  p += 4;
  const comments = [];
  for (let i = 0; i < count; i++) {
    if (p + 4 > data.length) throw new Error(`vorbis comment 第 ${i} 项长度字段越界`);
    const len = data.readUInt32LE(p);
    p += 4;
    if (p + len > data.length) throw new Error(`vorbis comment 第 ${i} 项数据越界 (len=${len})`);
    comments.push(data.toString('utf8', p, p + len));
    p += len;
  }
  return { vendor, comments, consumed: p, trailingBytes: data.length - p };
}

/** FLAC STREAMINFO -> { sampleRate, totalSamples, durationMs, channels, bitsPerSample } */
export function vFlacStreamInfo(blocks) {
  const si = blocks.find((b) => b.type === 0);
  if (!si || si.data.length < 34) return null;
  const d = si.data;
  const sampleRate = (d[10] << 12) | (d[11] << 4) | (d[12] >> 4);
  const channels = ((d[12] >> 1) & 0x07) + 1;
  const bitsPerSample = (((d[12] & 0x01) << 4) | (d[13] >> 4)) + 1;
  const totalSamples = (d[13] & 0x0f) * 4294967296 + d.readUInt32BE(14);
  return {
    sampleRate,
    channels,
    bitsPerSample,
    totalSamples,
    durationMs: sampleRate && totalSamples ? Math.round((totalSamples / sampleRate) * 1000) : null,
  };
}

/** 在 FLAC vorbis comments 里找 163key，返回所有命中 [{ key, value }] */
export function vFind163InFlac(comments) {
  const hits = [];
  for (const c of comments) {
    const eq = c.indexOf('=');
    if (eq < 0) continue;
    const k = c.slice(0, eq);
    const v = c.slice(eq + 1);
    if (v.includes(V_TAG_PREFIX)) hits.push({ key: k, value: v });
  }
  return hits;
}

// ───────────────────────────────────────────────────────────────────────────
// 5. 容器统一入口：给出「音频区起始偏移」与格式
// ───────────────────────────────────────────────────────────────────────────

/** 按魔数判定容器（不看扩展名） */
export function vDetectFormat(buf) {
  if (buf.length >= 8 && buf.toString('latin1', 0, 4) === 'fLaC') return 'flac';
  if (buf.length >= 3 && buf.toString('latin1', 0, 3) === 'ID3') return 'mp3';
  if (buf.length >= 2 && buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return 'mp3';
  if (buf.length >= 8 && buf.toString('latin1', 4, 8) === 'ftyp') return 'm4a';
  if (buf.length >= 8 && buf.toString('latin1', 0, 8) === 'CTENFDAM') return 'ncm';
  return null;
}

/**
 * 独立读取一个音频文件：容器、音频区偏移、标签里的 163key 落点。
 * 返回结构：
 *   { format, buf, audioOffset, id3?, flac?, keyHits: [{where, text}], comments? }
 * 关键：audioOffset 完全由本文件的字节布局推导，不信任任何外部报告。
 */
export function vReadAudio(file) {
  const buf = fs.readFileSync(file);
  const format = vDetectFormat(buf);
  const res = { file, format, size: buf.length, buf, audioOffset: 0, keyHits: [], issues: [] };

  if (format === 'mp3') {
    const id3 = vParseId3v2(buf);
    res.id3 = id3;
    res.audioOffset = id3.present ? id3.total : 0;
    if (id3.truncated) res.issues.push(`ID3v2 声明长度超出文件（header ${id3.total} > file ${buf.length}）`);
    for (const f of vFind163InId3(id3)) res.keyHits.push({ where: `ID3v2.${id3.ver} ${f.frameId}${f.description ? `[${f.description}]` : ''}`, text: f.text });
  } else if (format === 'flac') {
    const flac = vParseFlac(buf);
    res.flac = flac;
    res.audioOffset = flac.audioOffset ?? 0;
    for (const p of flac.problems) res.issues.push(p);
    const vc = flac.blocks.find((b) => b.type === 4);
    if (vc) {
      try {
        const parsed = vParseVorbisComment(vc.data);
        res.comments = parsed;
        for (const h of vFind163InFlac(parsed.comments)) res.keyHits.push({ where: `FLAC VORBIS_COMMENT ${h.key}`, text: h.value });
      } catch (e) {
        res.issues.push(`vorbis comment 解析失败: ${e.message}`);
      }
    } else {
      res.issues.push('没有 VORBIS_COMMENT 块');
    }
    res.streamInfo = vFlacStreamInfo(flac.blocks);
  } else {
    res.issues.push(`未识别的容器 (前 12 字节: ${buf.subarray(0, 12).toString('hex')})`);
  }
  return res;
}

// ───────────────────────────────────────────────────────────────────────────
// 6. 输出小工具（统一格式，便于 grep）
// ───────────────────────────────────────────────────────────────────────────

export const C = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
};

let failures = 0;
let checks = 0;

export function check(ok, label, detail = '') {
  checks++;
  if (!ok) failures++;
  const tag = ok ? `${C.green}  OK  ${C.reset}` : `${C.red} FAIL ${C.reset}`;
  console.log(`${tag} ${label}${detail ? `  ${C.dim}${detail}${C.reset}` : ''}`);
  return ok;
}

export function info(label, detail = '') {
  console.log(`${C.cyan} INFO ${C.reset} ${label}${detail ? `  ${C.dim}${detail}${C.reset}` : ''}`);
}

export function head(title) {
  console.log(`\n${C.bold}═══ ${title} ═══${C.reset}`);
}

export function summary(name) {
  const ok = failures === 0;
  console.log(`\n${ok ? C.green + '通过' : C.red + '不通过'}${C.reset}  ${name}: ${checks - failures}/${checks} 项断言通过`);
  console.log(JSON.stringify({ suite: name, checks, failures, pass: ok }));
  return ok;
}

export function failCount() {
  return failures;
}

export const PROJECT = 'D:\\HonGLY\\netease-163key-tagger';
export const TARGET = 'E:\\CloudMusic_163key';
export const BACKUP = 'E:\\CloudMusic_backup_20261022';
export const ORIGINAL = 'E:\\CloudMusic';
export const REAL_SAMPLE = 'D:\\HonGLY\\思想道德与法治\\《放下手机》\\Jackie - John Dreamer-亚托克斯 伴奏（Jackie remix）.mp3';
