/**
 * 多容器音频标签读写：
 *   - MP3  : ID3v2.3 / ID3v2.4 的 COMM 帧（163key 的官方落点，已用真实样本验证）
 *   - FLAC : Vorbis comment 的 COMMENT 字段
 *   - NCM  : 文件头 meta 段（"163 key(Don't modify):" + base64，整段 XOR 0x63）
 *
 * 设计原则：
 *   1. 未修改的帧/块 **原样字节复制**，只重建我们动过的那一个，避免任何重编码引入差异。
 *   2. 优先「同尺寸原地改」：能把新标签塞进原有标签空间时，只写标签区，音频字节一字节不动，
 *      文件大小、音频偏移都不变。
 *   3. 塞不下才走「临时文件 + 原子替换」整文件重写，并保留原 mtime。
 *   4. 对 E:\CloudMusic（原始素材）与备份目录做硬保护，写入直接抛错。
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { TAG_PREFIX, build163Key, parse163Key } from './163key.mjs';

// ─────────────────────────────────────────────────────────────
// 保护目录
// ─────────────────────────────────────────────────────────────

/**
 * 内置的只读保护目录。默认是空的——保护谁取决于使用者的机器，
 * 不能把开发者自己的路径写死在库里。
 * 实际生效的保护来自三处：
 *   1. 这个数组（想要硬编码就用 addProtectedRoot 在启动时追加）
 *   2. addProtectedRoot() 追加的「备份目录」
 *   3. 环境变量 NETEASE_163KEY_PROTECT（分号或逗号分隔）
 */
export const PROTECTED_ROOTS = [];

/**
 * 运行时追加的保护目录。Web 端会用它把用户选定的「备份目录」也锁成只读，
 * 这样不管 UI 怎么传参、报告被怎么改，备份都不可能被写入。
 */
const EXTRA_PROTECTED = [];

/** 追加一个只读保护目录（幂等，比较时忽略大小写） */
export function addProtectedRoot(dir) {
  if (!dir) return;
  const n = path.resolve(String(dir));
  if (!EXTRA_PROTECTED.some((d) => d.toLowerCase() === n.toLowerCase())) EXTRA_PROTECTED.push(n);
}

/** 从环境变量里读保护目录 */
for (const d of String(process.env.NETEASE_163KEY_PROTECT || '').split(/[;,]/)) {
  if (d.trim()) addProtectedRoot(d.trim());
}

/** 当前生效的全部保护目录 */
export function getProtectedRoots() {
  return [...PROTECTED_ROOTS, ...EXTRA_PROTECTED];
}

/**
 * 判断路径是否落在受保护目录内。必须按**路径分段**比较，不能用字符串前缀，
 * 否则 `D:\Music\CloudMusic_work` 会被 `D:\Music\CloudMusic` 误伤。
 */
export function isProtected(p) {
  const n = path.resolve(p).toLowerCase();
  return getProtectedRoots().some((root) => {
    const r = path.resolve(root).toLowerCase();
    return n === r || n.startsWith(r + path.sep);
  });
}

export function assertWritable(p) {
  if (isProtected(p)) {
    throw new Error(
      `拒绝写入受保护目录（备份/原始素材是只读的）：${p}\n` +
        `当前保护目录：${getProtectedRoots().join(' , ') || '(无)'}\n` +
        `如果你确实想写这里，先把它从保护的目录里移除。`,
    );
  }
}

// ─────────────────────────────────────────────────────────────
// 小工具
// ─────────────────────────────────────────────────────────────

const u32le = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0, 0);
  return b;
};

function synchsafeRead(buf, off) {
  return ((buf[off] & 0x7f) << 21) | ((buf[off + 1] & 0x7f) << 14) | ((buf[off + 2] & 0x7f) << 7) | (buf[off + 3] & 0x7f);
}

function synchsafeWrite(buf, off, value) {
  buf[off] = (value >>> 21) & 0x7f;
  buf[off + 1] = (value >>> 14) & 0x7f;
  buf[off + 2] = (value >>> 7) & 0x7f;
  buf[off + 3] = value & 0x7f;
}

/** Vorbis comment 的字段名大小写不敏感，这里统一大写比较 */
const up = (s) => String(s).toUpperCase();

// ─────────────────────────────────────────────────────────────
// 格式探测（按内容魔数，不信任扩展名）
// ─────────────────────────────────────────────────────────────

export function detectFormat(file, buf) {
  const b = buf || fs.readFileSync(file);
  if (b.length >= 8 && b.toString('latin1', 0, 8) === 'CTENFDAM') return 'ncm';
  if (b.length >= 4 && b.toString('latin1', 0, 4) === 'fLaC') return 'flac';
  if (b.length >= 3 && b.toString('latin1', 0, 3) === 'ID3') return 'mp3';
  if (b.length >= 8 && b.toString('latin1', 4, 8) === 'ftyp') return 'm4a';
  // 无 ID3 标签的裸 MPEG 流
  if (b.length >= 2 && b[0] === 0xff && (b[1] & 0xe0) === 0xe0) return 'mp3';
  return null;
}

// ─────────────────────────────────────────────────────────────
// ID3v2（MP3）
// ─────────────────────────────────────────────────────────────

const ID3V2_HEADER_LEN = 10;

/**
 * 解析 ID3v2 标签头与所有帧。未修改的帧保留 `raw`（含帧头的原始字节），
 * 序列化时直接复制，保证 APIC 封面等大帧逐字节不变。
 */
export function parseId3v2(buf) {
  if (buf.length < 10 || buf.toString('latin1', 0, 3) !== 'ID3') return null;
  const ver = buf[3];
  const rev = buf[4];
  const flags = buf[5];
  const size = synchsafeRead(buf, 6);
  const total = ID3V2_HEADER_LEN + size;
  if (total > buf.length) return { truncated: true, ver, rev, flags, size, total, frames: [] };

  const unsync = !!(flags & 0x80);
  const hasExt = !!(flags & 0x40);

  let start = ID3V2_HEADER_LEN;
  let extHeaderSize = 0;
  if (hasExt) {
    if (ver === 4) {
      extHeaderSize = synchsafeRead(buf, 10);
    } else {
      extHeaderSize = 4 + buf.readUInt32BE(10);
    }
    start += extHeaderSize;
  }

  const end = total;
  const frames = [];
  let p = start;
  const idLen = ver === 2 ? 3 : 4;
  const hdrLen = ver === 2 ? 6 : 10;

  while (p + hdrLen <= end) {
    const id = buf.toString('latin1', p, p + idLen);
    if (!/^[A-Z0-9]{3,4}$/.test(id)) break; // 撞到 padding 或垃圾
    let fsz;
    if (ver === 2) fsz = (buf[p + 3] << 16) | (buf[p + 4] << 8) | buf[p + 5];
    else if (ver === 4) fsz = synchsafeRead(buf, p + 4);
    else fsz = buf.readUInt32BE(p + 4);
    const fflags = ver === 2 ? 0 : buf.readUInt16BE(p + idLen + 4);
    const dataStart = p + hdrLen;
    if (fsz < 0 || dataStart + fsz > end) break;
    frames.push({
      id,
      flags: fflags,
      size: fsz,
      data: buf.subarray(dataStart, dataStart + fsz),
      raw: buf.subarray(p, dataStart + fsz), // 含帧头
    });
    p = dataStart + fsz;
  }

  return { truncated: false, ver, rev, flags, size, total, unsync, hasExt, extHeaderSize, frames, padding: end - p };
}

/** 序列化整个 ID3v2 标签（未改动帧用 raw 原样复制，改动过的帧重新构造帧头） */
function serializeId3v2(ver, rev, flags, frames, totalSize) {
  const parts = [];
  for (const f of frames) {
    if (f.raw && !f.dirty) {
      parts.push(f.raw);
      continue;
    }
    const hdrLen = ver === 2 ? 6 : 10;
    const h = Buffer.alloc(hdrLen);
    h.write(f.id, 0, 'latin1');
    const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data);
    if (ver === 2) {
      h[3] = (data.length >>> 16) & 0xff;
      h[4] = (data.length >>> 8) & 0xff;
      h[5] = data.length & 0xff;
    } else if (ver === 4) {
      synchsafeWrite(h, 4, data.length);
      h.writeUInt16BE(f.flags || 0, 8);
    } else {
      h.writeUInt32BE(data.length, 4);
      h.writeUInt16BE(f.flags || 0, 8);
    }
    parts.push(h, data);
  }
  const body = Buffer.concat(parts);
  const total = totalSize !== undefined ? totalSize : ID3V2_HEADER_LEN + body.length + 1024;
  if (ID3V2_HEADER_LEN + body.length > total) {
    throw new Error(`ID3v2 目标尺寸 ${total} 装不下帧数据 ${body.length + ID3V2_HEADER_LEN}`);
  }
  const out = Buffer.alloc(total);
  out.write('ID3', 0, 'latin1');
  out[3] = ver;
  out[4] = rev;
  // 扩展头（0x40）与 unsync（0x80）在解析时已被吃掉/被拒绝，输出时必须清掉标志位，
  // 否则会写出「声明有扩展头但实际没有」的畸形标签。
  out[5] = flags & ~0x40 & ~0x80;
  synchsafeWrite(out, 6, total - ID3V2_HEADER_LEN);
  body.copy(out, ID3V2_HEADER_LEN);
  out.fill(0, ID3V2_HEADER_LEN + body.length); // padding
  return out;
}

/** 组装 163key 的 COMM 帧体：编码 0x00 + 语言 "XXX" + 空描述 + 文本 */
function buildCommData(text) {
  return Buffer.concat([
    Buffer.from([0x00]),
    Buffer.from('XXX', 'latin1'),
    Buffer.from([0x00]),
    Buffer.from(text, 'latin1'),
  ]);
}

// ─────────────────────────────────────────────────────────────
// ID3 文本帧 / 封面帧的构造
// ─────────────────────────────────────────────────────────────

/**
 * 构造一个 ID3v2 文本帧体。
 *
 * 编码策略：**能塞进 Latin-1 就用 Latin-1，否则用 UTF-16LE + BOM**。
 * 很多老播放器对 UTF-8（ID3v2.4 才规范）支持不完整，而 Latin-1 又放不下中文，
 * UTF-16 是兼容性最稳的中文方案。163key 本身是纯 ASCII，因此永远是 Latin-1。
 */
function buildTextData(text) {
  const s = String(text ?? '');
  // eslint-disable-next-line no-control-regex
  const latin1Ok = /^[\u0000-\u00FF]*$/.test(s);
  if (latin1Ok) return Buffer.concat([Buffer.from([0x00]), Buffer.from(s, 'latin1')]);
  const body = Buffer.from(s, 'utf16le');
  return Buffer.concat([Buffer.from([0x01]), Buffer.from([0xff, 0xfe]), body]);
}

/**
 * 构造 APIC（封面）帧体。
 * 结构：编码(1) + MIME(ASCII, \0 结尾) + 图片类型(1) + 描述(\0 结尾) + 图片二进制
 * 图片类型 3 = Cover (front)。
 */
function buildApicData(bytes, mime) {
  const m = String(mime || 'image/jpeg');
  return Buffer.concat([
    Buffer.from([0x00]), // ISO-8859-1，MIME 与描述都是纯 ASCII
    Buffer.from(m, 'latin1'),
    Buffer.from([0x00]),
    Buffer.from([0x03]), // front cover
    Buffer.from([0x00]), // 空描述
    bytes,
  ]);
}

/** 从 URL 或 Content-Type 猜图片 MIME */
function guessImageMime(buf, fallbackUrl) {
  if (buf && buf.length > 8) {
    if (buf[0] === 0x89 && buf[1] === 0x50) return 'image/png';
    if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
    if (buf.slice(0, 4).toString('latin1') === 'RIFF') return 'image/webp';
    if (buf.slice(0, 3).toString('latin1') === 'GIF') return 'image/gif';
  }
  const u = String(fallbackUrl || '');
  if (/\.png(\?|$)/i.test(u)) return 'image/png';
  if (/\.webp(\?|$)/i.test(u)) return 'image/webp';
  return 'image/jpeg';
}

/**
 * 把一批「键 → 值」写进 ID3 帧列表。
 * 已存在同名帧就就地替换（保留它原来的位置），不存在才追加。
 *
 * 注意 APIC 特殊处理：**先删掉所有旧 APIC**，只留一张新封面。
 * 否则多张封面会同时存在，客户端/播放器显示哪张不确定。
 */
function upsertId3Frames(frames, ver, patch) {
  const setText = (id, value) => {
    if (value == null) return;
    const data = buildTextData(value);
    const existing = frames.filter((f) => f.id === id);
    if (existing.length) {
      existing[0].data = data;
      existing[0].flags = 0;
      existing[0].dirty = true;
      // 多余的重复文本帧删掉，避免取值时不知道读哪个
      for (const extra of existing.slice(1)) frames.splice(frames.indexOf(extra), 1);
    } else {
      frames.push({ id, flags: 0, size: data.length, data });
    }
  };

  if (patch.title != null) setText('TIT2', patch.title);
  if (patch.artist != null) setText('TPE1', patch.artist);
  if (patch.album != null) setText('TALB', patch.album);
  if (patch.albumArtist != null) setText('TPE2', patch.albumArtist);
  if (patch.year != null) setText('TDRC', String(patch.year)); // v2.4 用 TDRC，v2.3 用 TYER
  if (patch.trackNo != null) setText('TRCK', String(patch.trackNo));

  if (patch.cover && patch.cover.bytes && patch.cover.bytes.length) {
    for (let i = frames.length - 1; i >= 0; i--) if (frames[i].id === 'APIC') frames.splice(i, 1);
    const data = buildApicData(patch.cover.bytes, patch.cover.mime);
    frames.push({ id: 'APIC', flags: 0, size: data.length, data });
  }
  return frames;
}


/** 从 COMM / TXXX 帧体里取出文本 */
function commFrameText(data, id) {
  if (!data || data.length < 4) return '';
  const enc = data[0];
  let p;
  let desc;
  if (id === 'TXXX') {
    p = 1;
  } else {
    p = 4; // 跳过 encoding(1) + language(3)
  }
  if (enc === 0 || enc === 3) {
    const e = data.indexOf(0, p);
    if (e < 0) return '';
    desc = data.subarray(p, e);
    p = e + 1;
  } else {
    let e = p;
    while (e + 1 < data.length && !(data[e] === 0 && data[e + 1] === 0)) e += 2;
    desc = data.subarray(p, e);
    p = e + 2;
  }
  const text = decodeId3Text(data.subarray(p), enc);
  return id === 'TXXX' ? `${desc.toString('latin1')}\u0000${text}` : text;
}

/**
 * 解码 ID3 文本帧。UTF-16(enc=1/2) 的 BOM 会被 Node 解成 U+FEFF 留在串首——
 * 真实样本（Jackie 那首）的 TIT2/TPE1/TALB 都带着这个字符，不去掉会污染歌名/歌手/专辑比对。
 */
function decodeId3Text(bytes, enc) {
  const s = bytes.toString(enc === 1 || enc === 2 ? 'utf16le' : enc === 3 ? 'utf8' : 'latin1');
  return s.replace(/^\uFEFF/, '').replace(/[\u0000\s]+$/, '');
}

/** 在 ID3v2 帧里找 163key */
function find163KeyInId3(id3) {
  if (!id3 || !id3.frames) return { text: null, frame: null };
  for (const f of id3.frames) {
    if (f.id !== 'COMM' && f.id !== 'TXXX' && f.id !== 'USLT') continue;
    const t = commFrameText(f.data, f.id);
    if (t && t.includes(TAG_PREFIX)) return { text: t, frame: f };
  }
  return { text: null, frame: null };
}

/** MP3：读基础标签 + 163key */
function readMp3(buf) {
  const id3 = parseId3v2(buf);
  const out = {
    format: 'mp3',
    title: null,
    artist: null,
    album: null,
    durationMs: null,
    id3Version: id3 ? `2.${id3.ver}.${id3.rev}` : null,
    id3Truncated: !!(id3 && id3.truncated),
    id3Unsync: !!(id3 && id3.unsync),
    id3HasExtHeader: !!(id3 && id3.hasExt),
    frames: id3 && id3.frames ? id3.frames.map((f) => f.id) : [],
    key163: null,
  };
  if (id3 && id3.frames) {
    for (const f of id3.frames) {
      const dec = (enc) => decodeId3Text(f.data.subarray(1), enc);
      if (f.id === 'TIT2' && !out.title) out.title = dec(f.data[0]);
      else if (f.id === 'TPE1' && !out.artist) out.artist = dec(f.data[0]);
      else if (f.id === 'TALB' && !out.album) out.album = dec(f.data[0]);
      else if (f.id === 'TLEN' && !out.durationMs) {
        const v = parseInt(dec(f.data[0]), 10);
        if (Number.isFinite(v)) out.durationMs = v;
      }
    }
    const found = find163KeyInId3(id3);
    if (found.text) out.key163 = found.text;
  }
  if (out.durationMs == null) out.durationMs = estimateMp3Duration(buf, id3 ? id3.total : 0);
  out.bitrate = normalizeBitrate(mp3Bitrate(buf, id3 ? id3.total : 0, out.durationMs), 'mp3');
  return out;
}

/**
 * MP3 的实际音频码率（bit/s）。
 *
 * 优先用「音频字节数 × 8 ÷ 时长」——对 VBR 文件这是唯一正确的算法，
 * 单看首帧的码率索引只能反映第一帧。
 * 仅当时长拿不到时，才退回首帧码率索引（此时只对 CBR 文件准确）。
 */
function mp3Bitrate(buf, audioStart, durationMs) {
  try {
    const audioBytes = buf.length - audioStart;
    if (!audioBytes || !durationMs || durationMs <= 0) return firstFrameKbps(buf, audioStart);
    const byAvg = Math.round((audioBytes * 8) / (durationMs / 1000));
    const byFrame = firstFrameKbps(buf, audioStart);
    // 两者差得太多说明时长估算不可靠（例如有大量尾部标签），此时信任首帧
    if (byFrame && Math.abs(byAvg - byFrame) / byFrame > 0.5) return byFrame;
    return byAvg;
  } catch {
    return null;
  }
}

function firstFrameKbps(buf, audioStart) {
  const BITRATES = {
    3: { 1: [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448], 2: [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384], 3: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320] },
    2: { 1: [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256], 2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160], 3: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160] },
  };
  for (let i = audioStart; i < buf.length - 4; i++) {
    if (buf[i] !== 0xff || (buf[i + 1] & 0xe0) !== 0xe0) continue;
    const verBits = (buf[i + 1] >> 3) & 0x03;
    const layerBits = (buf[i + 1] >> 1) & 0x03;
    const brIdx = (buf[i + 2] >> 4) & 0x0f;
    const srIdx = (buf[i + 2] >> 2) & 0x03;
    if (verBits === 1 || layerBits === 0 || brIdx === 0 || brIdx === 15 || srIdx === 3) continue;
    const verKey = verBits === 3 ? 3 : 2;
    const layer = layerBits === 3 ? 1 : layerBits === 2 ? 2 : 3;
    const kbps = BITRATES[verKey][layer][brIdx];
    if (!kbps) continue;
    // VBR 文件的首帧通常是 Xing/Info 头帧，其码率索引不代表整体，交给平均值逻辑
    return kbps * 1000;
  }
  return null;
}

/** 估算 MP3 时长：优先 Xing/Info/VBRI 帧数，其次按首帧码率算 CBR */
function estimateMp3Duration(buf, audioStart) {
  try {
    const BITRATES = {
      // [version][layer] -> kbps 表
      3: { 1: [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448], 2: [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384], 3: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320] },
      2: { 1: [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256], 2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160], 3: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160] },
    };
    const SR = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };
    const SAMPLES = { 1: 384, 2: 1152, 3: 1152 };
    // 找同步头
    let i = audioStart;
    while (i < buf.length - 4) {
      if (buf[i] === 0xff && (buf[i + 1] & 0xe0) === 0xe0) {
        const verBits = (buf[i + 1] >> 3) & 0x03;
        const layerBits = (buf[i + 1] >> 1) & 0x03;
        const brIdx = (buf[i + 2] >> 4) & 0x0f;
        const srIdx = (buf[i + 2] >> 2) & 0x03;
        if (verBits !== 1 && layerBits !== 0 && brIdx !== 0 && brIdx !== 15 && srIdx !== 3) return durationFromFrame(buf, i, verBits, layerBits, brIdx, srIdx);
      }
      i++;
    }
    return null;

    function durationFromFrame(b, off, vBits, lBits, brIdx, srIdx) {
      const verKey = vBits === 3 ? 3 : 2;
      const layer = lBits === 3 ? 1 : lBits === 2 ? 2 : 3;
      const kbps = BITRATES[verKey][layer][brIdx];
      const sr = SR[vBits === 3 ? 3 : vBits === 2 ? 2 : 0][srIdx];
      const samplesPerFrame = SAMPLES[layer];
      // Xing / Info
      const sideInfo = vBits === 3 ? (vBits === 3 && (b[off + 1] >> 3 & 3) === 3 ? 32 : 17) : 9;
      const xingOff = off + 4 + (lBits === 3 ? 21 + (vBits === 1 ? 0 : 0) : 0);
      const scan = (o) => {
        if (o + 12 > b.length) return null;
        const tag = b.toString('latin1', o, o + 4);
        if (tag !== 'Xing' && tag !== 'Info') return null;
        const flags = b.readUInt32BE(o + 4);
        if (!(flags & 1)) return null;
        const frames = b.readUInt32BE(o + 8);
        return (frames * samplesPerFrame) / sr * 1000;
      };
      for (const o of [off + 4 + sideInfo, xingOff, off + 36, off + 21, off + 13]) {
        const d = scan(o);
        if (d) return Math.round(d);
      }
      const bytes = b.length - off;
      return Math.round(((bytes * 8) / (kbps * 1000)) * 1000);
    }
  } catch {
    return null;
  }
}

/**
 * 把承载 163key 的 COMM 帧挪到「所有 COMM 帧的最后一位」。
 *
 * 为什么必须这样：客户端（cloudmusic）扫描下载目录时，会把 ID3 里所有 COMM 帧依次读过去，
 * **留下最后一个** 的文本作为注释。如果文件本来就带一个空 COMM（很多压制工具会写），
 * 而我们的 key 帧排在它前面，客户端读到的就是那个空串 —— key 写了等于没写。
 *
 * 实证（本机 57 个文件，客户端库对照）：单 COMM 且含 key 的 10 个全部被认出；
 * 唯一一个「key 在前 + 空 COMM 在后」的 HOME SWEET HOME 没有被认出（tid 为空、未进 offlineTrack）。
 * 复现脚本：out/scratch/probe-carrier-slots.mjs。
 */
function placeAsLastComm(frames, frame) {
  const at = frames.indexOf(frame);
  if (at >= 0) frames.splice(at, 1);
  let last = -1;
  for (let i = 0; i < frames.length; i++) if (frames[i].id === 'COMM' || frames[i].id === 'COM') last = i;
  if (last >= 0) frames.splice(last + 1, 0, frame);
  else frames.push(frame);
}

/** 该帧是否已经是最后一个 COMM 帧（位置合法时才算 noop） */
function isLastComm(frames, frame) {
  const at = frames.indexOf(frame);
  if (at < 0) return false;
  for (let i = at + 1; i < frames.length; i++) if (frames[i].id === 'COMM' || frames[i].id === 'COM') return false;
  return true;
}

/**
 * 判断 patch 是否真的会改变文件内容（用于幂等：没有变化就不重写）。
 * 文本按「解码后的字符串」比，封面按「字节 + MIME」比。
 */
function willChangeId3(frames, ver, patch) {
  const currentText = (id) => {
    const f = frames.find((x) => x.id === id);
    if (!f) return null;
    return decodeId3Text(f.data.subarray(1), f.data[0]);
  };
  const checks = [
    ['TIT2', patch.title],
    ['TPE1', patch.artist],
    ['TALB', patch.album],
    ['TPE2', patch.albumArtist],
  ];
  for (const [id, want] of checks) {
    if (want == null) continue;
    if (currentText(id) !== String(want)) return true;
  }
  if (patch.cover && patch.cover.bytes && patch.cover.bytes.length) {
    const apics = frames.filter((f) => f.id === 'APIC');
    if (apics.length !== 1) return true; // 0 张要补、多张要收敛成一张
    const body = apics[0].data;
    // APIC 尾部就是图片二进制：比较尾部若干字节即可判断「是不是同一张图」，
    // 不用把大图完整解析出来。长度不同直接判为变化。
    const imgLen = patch.cover.bytes.length;
    const tailLen = Math.min(imgLen, 4096);
    const curTail = body.subarray(Math.max(0, body.length - tailLen));
    const wantTail = patch.cover.bytes.subarray(imgLen - tailLen);
    if (body.length < tailLen || !curTail.equals(wantTail)) return true;
  }
  return false;
}

/** MP3：写入 163key（可同时补写标题/歌手/专辑/封面） */
function writeMp3(buf, keyText, patch = null) {
  let id3 = parseId3v2(buf);
  let frames;
  let ver;
  let rev;
  let flags;
  let oldTotal;
  let audioStart;

  if (id3 && !id3.truncated) {
    ver = id3.ver;
    rev = id3.rev;
    flags = id3.flags;
    oldTotal = id3.total;
    audioStart = id3.total;
    frames = id3.frames.slice();
  } else {
    ver = 3;
    rev = 0;
    flags = 0;
    oldTotal = 0;
    audioStart = id3 && id3.truncated ? id3.total : 0;
    frames = [];
  }

  if (id3 && id3.unsync) {
    throw new Error('该 MP3 的 ID3v2 标签带 unsynchronisation 标志，暂不支持安全重写');
  }

  const found = find163KeyInId3({ frames });
  const newData = buildCommData(keyText);
  let keyChanged = false;
  if (found.frame && (found.frame.id === 'COMM' || found.frame.id === 'COM')) {
    if (found.text !== keyText || !isLastComm(frames, found.frame)) {
      found.frame.data = newData;
      found.frame.flags = 0;
      found.frame.dirty = true;
      placeAsLastComm(frames, found.frame);
      keyChanged = true;
    }
  } else {
    // 没有 COMM 落点（或 163key 藏在 TXXX 等非标准帧里）：新增一个，原帧一律不动
    const f = { id: ver === 2 ? 'COM' : 'COMM', flags: 0, size: newData.length, data: newData };
    placeAsLastComm(frames, f);
    keyChanged = true;
  }

  // 元数据补写（标题/歌手/专辑/封面）。放在 key 之后做，因为 upsert 可能追加新帧。
  // patch 生效前先判断「是不是真的不一样」，否则重复运行会把文件反复重写，破坏幂等。
  let metaChanged = false;
  if (patch) metaChanged = willChangeId3(frames, ver, patch);
  if (patch && metaChanged) upsertId3Frames(frames, ver, patch);

  if (!keyChanged && !metaChanged) return { changed: false, strategy: 'noop', audioStart };

  const bodyLen = frames.reduce((acc, f) => acc + (f.raw && !f.dirty ? f.raw.length : (ver === 2 ? 6 : 10) + f.data.length), 0);
  const minTotal = ID3V2_HEADER_LEN + bodyLen;

  if (oldTotal >= minTotal) {
    // 同尺寸原地改：音频偏移不变
    const tagBuf = serializeId3v2(ver, rev, flags, frames, oldTotal);
    return { changed: true, strategy: 'in-place', region: tagBuf, regionOffset: 0, audioStart, newTotal: oldTotal };
  }
  // 需要变长：整文件重写，并预留 1KB padding
  const newTotal = minTotal + 1024;
  const tagBuf = serializeId3v2(ver, rev, flags, frames, newTotal);
  return { changed: true, strategy: audioStart === 0 ? 'prepend' : 'rewrite', region: tagBuf, regionOffset: 0, audioStart, newTotal };
}

// ─────────────────────────────────────────────────────────────
// FLAC
// ─────────────────────────────────────────────────────────────

const FLAC_BLOCK = {
  STREAMINFO: 0,
  PADDING: 1,
  APPLICATION: 2,
  SEEKTABLE: 3,
  VORBIS_COMMENT: 4,
  CUESHEET: 5,
  PICTURE: 6,
};

/**
 * 163key 在 FLAC 里的字段名。
 *
 * 用 DESCRIPTION，不是 COMMENT。COMMENT 是历史遗留写法，Vorbis 规范里「注释」的规范字段名是
 * DESCRIPTION。三条依据：
 *   1. 社区事实标准 163marker（136★）对 FLAC 走 mutagen 的 audio['description']，MP3 才走 COMM 帧；
 *   2. TagLib 的 Ogg::XiphComment::comment() 先取 DESCRIPTION，为空才回退 COMMENT（setComment 同理）；
 *   3. 本机真实 .ogg 样本里读到的就是 DESCRIPTION= 而不是 COMMENT=。
 * 客户端内嵌的正是 TagLib（cloudmusic.dll 里有 FLAC::File::scan()、Vorbis::File::read() 等字面量），
 * 所以走 TagLib 存取器时 DESCRIPTION 是主路径、COMMENT 只是兜底。
 *
 * 为兼容「按字段名精确取 COMMENT」的实现，写入时默认再补一份 COMMENT 副本
 * （见 FLAC_COMPAT_FIELD / flacCommentCopy）；读取端不挑字段名，只要值里含 TAG_PREFIX 就认。
 * 可用 --flac-field 覆盖主字段、--no-flac-comment-copy 关掉副本。
 */
export const DEFAULT_FLAC_FIELD = 'DESCRIPTION';

/** 兼容副本字段名：同时写一份，防止对端按精确字段名取 COMMENT。 */
export const FLAC_COMPAT_FIELD = 'COMMENT';

export function parseFlac(buf) {
  if (buf.length < 4 || buf.toString('latin1', 0, 4) !== 'fLaC') return null;
  const blocks = [];
  let off = 4;
  while (off + 4 <= buf.length) {
    const header = buf[off];
    const last = !!(header & 0x80);
    const type = header & 0x7f;
    const len = (buf[off + 1] << 16) | (buf[off + 2] << 8) | buf[off + 3];
    const dataStart = off + 4;
    if (dataStart + len > buf.length) return null;
    blocks.push({ type, last, len, headerOffset: off, dataStart, data: buf.subarray(dataStart, dataStart + len) });
    off = dataStart + len;
    if (last) break;
  }
  return { blocks, audioOffset: off };
}

function parseVorbisComment(data) {
  let p = 0;
  const vendorLen = data.readUInt32LE(p);
  p += 4;
  const vendor = data.subarray(p, p + vendorLen).toString('utf8');
  p += vendorLen;
  const count = data.readUInt32LE(p);
  p += 4;
  const comments = [];
  for (let i = 0; i < count && p + 4 <= data.length; i++) {
    const len = data.readUInt32LE(p);
    p += 4;
    comments.push(data.subarray(p, p + len).toString('utf8'));
    p += len;
  }
  return { vendor, comments };
}

function buildVorbisComment(vendor, comments) {
  const vb = Buffer.from(vendor, 'utf8');
  const parts = [u32le(vb.length), vb, u32le(comments.length)];
  for (const c of comments) {
    const cb = Buffer.from(c, 'utf8');
    parts.push(u32le(cb.length), cb);
  }
  return Buffer.concat(parts);
}

function serializeFlacRegion(blocks) {
  const parts = [];
  blocks.forEach((b, i) => {
    const h = Buffer.alloc(4);
    h[0] = (i === blocks.length - 1 ? 0x80 : 0x00) | (b.type & 0x7f);
    h[1] = (b.data.length >>> 16) & 0xff;
    h[2] = (b.data.length >>> 8) & 0xff;
    h[3] = b.data.length & 0xff;
    parts.push(h, b.data);
  });
  return Buffer.concat(parts);
}

/** FLAC：从 STREAMINFO 拿精确时长 */
function flacDurationMs(blocks) {
  const si = blocks.find((b) => b.type === FLAC_BLOCK.STREAMINFO);
  if (!si || si.data.length < 18) return null;
  const d = si.data;
  const sampleRate = (d[10] << 12) | (d[11] << 4) | (d[12] >> 4);
  const totalSamples = ((d[13] & 0x0f) * 2 ** 32) + d.readUInt32BE(14);
  if (!sampleRate || !totalSamples) return null;
  return Math.round((totalSamples / sampleRate) * 1000);
}

/**
 * 把实测码率规范化成「档位值」。
 *
 * 实测值必然带小数抖动（320038、128014、937900），而 163key 里的 bitrate 是
 * 一个**档位标识**（官方写的都是 320000、128000 这种整数），不是精确测量值。
 * 直接用实测值会写出 `"bitrate":320038` 这种和官方风格不一致的数。
 *
 * 规则：
 *   - MP3（CBR/VBR 有损）：吸附到标准档位 32/48/56/64/80/96/112/128/160/192/224/256/320k；
 *     离档位超过 12% 才认为是不规则 VBR，此时取整到千位。
 *   - FLAC（无损）：没有标准档位，取整到 1000（如 937900 → 938000）。
 */
export function normalizeBitrate(bps, format) {
  const v = Number(bps);
  if (!Number.isFinite(v) || v <= 0) return null;
  if (format === 'flac') return Math.round(v / 1000) * 1000;
  const LADDER = [32000, 48000, 56000, 64000, 80000, 96000, 112000, 128000, 160000, 192000, 224000, 256000, 320000];
  let best = LADDER[0];
  for (const s of LADDER) if (Math.abs(s - v) < Math.abs(best - v)) best = s;
  if (Math.abs(best - v) / best <= 0.12) return best;
  return Math.round(v / 1000) * 1000;
}

/**
 * FLAC 的实际音频码率（bit/s）。
 *
 * 用「音频数据字节数 × 8 ÷ 时长」算，而不是从 STREAMINFO 里读——STREAMINFO 只有
 * 采样率/声道/位深，没有码率字段。也不要用整个文件大小：那样会把封面、歌词等
 * 元数据块也算进码率里，FLAC 封面动辄几百 KB，误差很大。
 *
 * 163key 里的 bitrate 应当是本地文件的实际码率（社区实现 163marker 用的就是
 * `audio.info.bitrate`）。网易云的 flac 是无损，实际码率 800k~1800k，
 * 一律写 320000 是错的。
 */
export function flacBitrate(buf) {
  const flac = parseFlac(buf);
  if (!flac) return null;
  const durationMs = flacDurationMs(flac.blocks);
  if (!durationMs || durationMs <= 0) return null;
  const audioBytes = buf.length - flac.audioOffset;
  if (audioBytes <= 0) return null;
  return Math.round((audioBytes * 8) / (durationMs / 1000));
}

function readFlac(buf) {
  const flac = parseFlac(buf);
  const out = {
    format: 'flac',
    title: null,
    artist: null,
    album: null,
    durationMs: null,
    bitrate: null,
    key163: null,
    comments: [],
    blocks: flac ? flac.blocks.map((b) => `${b.type}:${b.len}`) : [],
  };
  if (!flac) return out;
  const vc = flac.blocks.find((b) => b.type === FLAC_BLOCK.VORBIS_COMMENT);
  if (vc) {
    const { comments } = parseVorbisComment(vc.data);
    out.comments = comments;
    for (const c of comments) {
      const eq = c.indexOf('=');
      if (eq < 0) continue;
      const k = up(c.slice(0, eq));
      const v = c.slice(eq + 1);
      if (k === 'TITLE' && !out.title) out.title = v;
      else if (k === 'ARTIST' && !out.artist) out.artist = v;
      else if (k === 'ALBUM' && !out.album) out.album = v;
      if (v.includes(TAG_PREFIX) && !out.key163) out.key163 = v;
    }
  }
  out.durationMs = flacDurationMs(flac.blocks);
  out.bitrate = out.durationMs
    ? normalizeBitrate(Math.round(((buf.length - flac.audioOffset) * 8) / (out.durationMs / 1000)), 'flac')
    : null;
  return out;
}

/**
 * 构造 FLAC 的 PICTURE 元数据块（type=6）。
 * 结构（全大端）：
 *   type(4) mimeLen(4) mime  descLen(4) desc  width(4) height(4) depth(4) colors(4) dataLen(4) data
 * 宽度/高度不知道就写 0——规范允许，播放器会自己解图片。
 */
function buildFlacPicture(bytes, mime) {
  const m = Buffer.from(String(mime || 'image/jpeg'), 'latin1');
  const d = Buffer.alloc(4);
  const parts = [
    d, // picture type = 3 (front cover)
    (() => { const b = Buffer.alloc(4); b.writeUInt32BE(m.length); return b; })(),
    m,
    (() => { const b = Buffer.alloc(4); b.writeUInt32BE(0); return b; })(), // desc 长度 0
    (() => { const b = Buffer.alloc(4); b.writeUInt32BE(0); return b; })(), // width
    (() => { const b = Buffer.alloc(4); b.writeUInt32BE(0); return b; })(), // height
    (() => { const b = Buffer.alloc(4); b.writeUInt32BE(0); return b; })(), // depth
    (() => { const b = Buffer.alloc(4); b.writeUInt32BE(0); return b; })(), // colors
    (() => { const b = Buffer.alloc(4); b.writeUInt32BE(bytes.length); return b; })(),
    bytes,
  ];
  parts[0].writeUInt32BE(3);
  return Buffer.concat(parts);
}

/** FLAC 的文本字段 upsert（TITLE/ARTIST/ALBUM/ALBUMARTIST）。
 *  关键：**已有字段就地改值、绝不挪位置**；只有全新字段才 push。
 *  否则每次写入都会重排 comment 顺序，导致「第二次写虽然内容一样但字节不同」，破坏幂等。 */
function upsertVorbisText(comments, patch) {
  const setField = (name, value) => {
    if (value == null) return;
    const want = String(value);
    const idx = comments
      .map((c, i) => [c, i])
      .filter(([c]) => {
        const eq = c.indexOf('=');
        return eq > 0 && up(c.slice(0, eq)) === up(name);
      });
    // 摘掉多余的重复项（从后往前删，避免索引漂移），只留第一条
    for (let k = idx.length - 1; k >= 1; k--) comments.splice(idx[k][1], 1);
    if (idx.length) {
      const i = idx[0][1];
      comments[i] = `${name}=${want}`; // 就地在原位改值
    } else {
      comments.push(`${name}=${want}`); // 只有新字段才追加
    }
  };
  if (patch.title != null) setField('TITLE', patch.title);
  if (patch.artist != null) setField('ARTIST', patch.artist);
  if (patch.album != null) setField('ALBUM', patch.album);
  if (patch.albumArtist != null) setField('ALBUMARTIST', patch.albumArtist);
  if (patch.year != null) setField('DATE', patch.year);
  if (patch.trackNo != null) setField('TRACKNUMBER', patch.trackNo);
  return comments;
}

function writeFlac(
  buf,
  keyText,
  { field = DEFAULT_FLAC_FIELD, compatField = FLAC_COMPAT_FIELD, padBytes = 8192, patch = null } = {},
) {
  const flac = parseFlac(buf);
  if (!flac) throw new Error('不是有效的 FLAC 文件');
  const blocks = flac.blocks.map((b) => ({ type: b.type, data: b.data }));
  const oldRegionLen = flac.audioOffset - 4;

  let vcIdx = blocks.findIndex((b) => b.type === FLAC_BLOCK.VORBIS_COMMENT);
  let vendor = 'reference libFLAC 1.3.2 20170101';
  let comments = [];
  if (vcIdx >= 0) {
    const parsed = parseVorbisComment(blocks[vcIdx].data);
    vendor = parsed.vendor;
    comments = parsed.comments.slice();
  }
  const oldVcLen = vcIdx >= 0 ? blocks[vcIdx].data.length : 0;

  // 顺序很重要：**先补写用户可见的文本元数据，最后再写 163key**。
  // 反过来做的话，每次都会「删掉旧 key → 末尾追加新 key」，把 patch 新加的字段
  // （如 ALBUMARTIST）挤到 key 前面，导致「内容一样但字节不同」，破坏幂等。
  let picChanged = false;
  if (patch) {
    upsertVorbisText(comments, patch);
    if (patch.cover && patch.cover.bytes && patch.cover.bytes.length) {
      const wantTail = patch.cover.bytes.subarray(Math.max(0, patch.cover.bytes.length - 4096));
      const pics = blocks.filter((b) => b.type === FLAC_BLOCK.PICTURE);
      const same =
        pics.length === 1 &&
        pics[0].data.length >= wantTail.length &&
        pics[0].data.subarray(pics[0].data.length - wantTail.length).equals(wantTail);
      if (!same) {
        // 只留一张封面：先删掉所有旧 PICTURE，稍后再插一张新的
        for (let i = blocks.length - 1; i >= 0; i--) if (blocks[i].type === FLAC_BLOCK.PICTURE) blocks.splice(i, 1);
        picChanged = true;
      }
    }
  }

  // 163key 最后写：先摘掉所有已有的 key 注释项，再统一追加到末尾（幂等 + 不重复堆积）
  comments = comments.filter((c) => {
    const eq = c.indexOf('=');
    return eq < 0 || !c.slice(eq + 1).includes(TAG_PREFIX);
  });
  const fields = [field];
  if (compatField && up(compatField) !== up(field)) fields.push(compatField);
  for (const f of fields) comments.push(`${f}=${keyText}`);

  const newVcData = buildVorbisComment(vendor, comments);
  if (vcIdx >= 0) blocks[vcIdx].data = newVcData;
  else {
    // 没有 VORBIS_COMMENT：插到 STREAMINFO 之后
    blocks.splice(1, 0, { type: FLAC_BLOCK.VORBIS_COMMENT, data: newVcData });
    vcIdx = 1;
  }

  if (picChanged) {
    const picBlock = { type: FLAC_BLOCK.PICTURE, data: buildFlacPicture(patch.cover.bytes, patch.cover.mime) };
    blocks.splice(vcIdx + 1, 0, picBlock);
  }

  const delta = newVcData.length - oldVcLen;
  const padIdx = blocks.findIndex((b) => b.type === FLAC_BLOCK.PADDING && b !== blocks[vcIdx]);

  if (padIdx >= 0) {
    const oldPad = blocks[padIdx].data.length;
    const newPad = oldPad - delta;
    if (newPad >= 0) {
      blocks[padIdx].data = Buffer.alloc(newPad);
      const region = serializeFlacRegion(blocks);
      if (region.length === oldRegionLen) {
        return { changed: true, strategy: 'in-place', region, regionOffset: 4, audioStart: flac.audioOffset };
      }
      // 理论不会走到，兜底走重写
      return { changed: true, strategy: 'rewrite', region, regionOffset: 4, audioStart: flac.audioOffset };
    }
    // padding 不够，吃掉 padding 并扩容
    blocks[padIdx].data = Buffer.alloc(0);
  } else if (delta > 0) {
    blocks.push({ type: FLAC_BLOCK.PADDING, data: Buffer.alloc(padBytes) });
  }

  const region = serializeFlacRegion(blocks);
  return { changed: true, strategy: 'rewrite', region, regionOffset: 4, audioStart: flac.audioOffset };
}

// ─────────────────────────────────────────────────────────────
// NCM
// ─────────────────────────────────────────────────────────────

const NCM_MAGIC = 'CTENFDAM';
const NCM_AES_KEY = Buffer.from('hzHRAmso5kInbaxW', 'utf8');

function ncmXor(b, k) {
  return Buffer.from(b.map((x) => x ^ k));
}

/**
 * 解析 NCM：返回头部各段的偏移，以及 meta 段的 163key 字符串。
 * 结构：magic(8) gap(2) keyLen(4LE) key(keyLen) metaLen(4LE) meta(metaLen) crc32(4LE) gap(5) audio
 */
export function parseNcm(buf) {
  if (buf.length < 16 || buf.toString('latin1', 0, 8) !== NCM_MAGIC) return null;
  let p = 8 + 2;
  const keyLen = buf.readUInt32LE(p);
  p += 4;
  const keyStart = p;
  const keyBlob = buf.subarray(p, p + keyLen);
  p += keyLen;
  const metaLen = buf.readUInt32LE(p);
  p += 4;
  const metaStart = p;
  const metaBlob = buf.subarray(p, p + metaLen);
  p += metaLen;
  const crcOffset = p;
  const crc = buf.readUInt32LE(p);
  p += 4;
  const audioOffset = p + 5;
  return { keyLen, keyStart, keyBlob, metaLen, metaStart, metaBlob, crcOffset, crc, audioOffset };
}

/**
 * NCM meta 段 -> 明文 `music:{json}`。
 * NCM 头部存的就是 163key 本身，只是换了一把 AES 密钥并整段 XOR 0x63，**没有第二层**。
 */
export function ncmMetaToPlaintext(metaBlob) {
  const raw = ncmXor(metaBlob, 0x63).toString('latin1');
  const i = raw.indexOf(TAG_PREFIX);
  if (i < 0) return null;
  const b64 = raw.slice(i + TAG_PREFIX.length).replace(/\u0000+$/, '');
  const ct = Buffer.from(b64, 'base64');
  let plain;
  try {
    const d = crypto.createDecipheriv('aes-128-ecb', NCM_AES_KEY, null);
    plain = Buffer.concat([d.update(ct), d.final()]).toString('utf8');
  } catch {
    const d = crypto.createDecipheriv('aes-128-ecb', NCM_AES_KEY, null);
    d.setAutoPadding(false);
    plain = Buffer.concat([d.update(ct), d.final()]).toString('utf8');
  }
  return plain.replace(/\u0000+$/, '');
}

function readNcm(buf) {
  const n = parseNcm(buf);
  const out = { format: 'ncm', title: null, artist: null, album: null, durationMs: null, key163: null };
  if (!n) return out;
  try {
    const plain = ncmMetaToPlaintext(n.metaBlob);
    if (!plain) return out;
    const meta = JSON.parse(plain.replace(/^music:/, ''));
    out.title = meta.musicName ?? null;
    out.artist = Array.isArray(meta.artist)
      ? meta.artist.map((a) => (Array.isArray(a) ? a[0] : a)).join('/')
      : null;
    out.album = meta.album ?? null;
    out.durationMs = meta.duration ?? null;
    out.meta = meta;
    out.key163 = build163Key(meta); // 规范化为与 MP3 一致的 163key
  } catch (e) {
    out.key163Error = String(e.message || e);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────
// 对外接口
// ─────────────────────────────────────────────────────────────

/** 读：格式 + 基础标签 + 已有 163key */
export function readTags(file) {
  const buf = fs.readFileSync(file);
  const fmt = detectFormat(file, buf);
  switch (fmt) {
    case 'mp3':
      return readMp3(buf);
    case 'flac':
      return readFlac(buf);
    case 'ncm':
      return readNcm(buf);
    case 'm4a':
      return { format: 'm4a', title: null, artist: null, album: null, durationMs: null, key163: null, unsupported: true };
    default:
      return { format: null, title: null, artist: null, album: null, durationMs: null, key163: null };
  }
}

/**
 * 写：把 163key 写进文件标签，可选同时补写标题/歌手/专辑/封面。
 * @param {string} file
 * @param {string} keyText 完整标签串（含 "163 key(Don't modify):" 前缀）
 * @param {{
 *   dryRun?:boolean, flacField?:string, flacCommentCopy?:boolean,
 *   meta?: null | {
 *     title?: string, artist?: string, album?: string, albumArtist?: string,
 *     year?: string|number, trackNo?: number|string,
 *     cover?: { bytes: Buffer, mime?: string } | null
 *   }
 * }} opts
 *   flacField        FLAC 主字段名，默认 DESCRIPTION
 *   flacCommentCopy  是否再补写一份 COMMENT 兼容副本，默认 true
 *   meta             非空时同时改写文本标签与封面（封面会显著增大文件）
 */
export function write163Key(file, keyText, opts = {}) {
  assertWritable(file);
  const { dryRun = true, flacField = DEFAULT_FLAC_FIELD, flacCommentCopy = true, meta = null } = opts;
  const buf = fs.readFileSync(file);
  const fmt = detectFormat(file, buf);
  if (!fmt) throw new Error(`无法识别的音频格式：${file}`);

  let plan;
  if (fmt === 'mp3') plan = writeMp3(buf, keyText, meta);
  else if (fmt === 'flac')
    plan = writeFlac(buf, keyText, {
      field: flacField,
      compatField: flacCommentCopy ? FLAC_COMPAT_FIELD : null,
      patch: meta,
    });
  else if (fmt === 'ncm') throw new Error('NCM 写入尚未通过真实样本验证，暂不开放');
  else if (fmt === 'm4a') throw new Error('M4A 写入尚未实现');
  else throw new Error(`不支持的格式：${fmt}`);

  if (!plan.changed) return { format: fmt, changed: false, strategy: 'noop' };
  if (dryRun) return { format: fmt, changed: true, strategy: plan.strategy, dryRun: true };

  const st = fs.statSync(file);
  if (plan.strategy === 'in-place') {
    const fd = fs.openSync(file, 'r+');
    try {
      fs.writeSync(fd, plan.region, 0, plan.region.length, plan.regionOffset);
    } finally {
      fs.closeSync(fd);
    }
  } else {
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
    const off = plan.regionOffset || 0;
    const out = Buffer.alloc(off + plan.region.length + (buf.length - plan.audioStart));
    buf.copy(out, 0, 0, off); // FLAC 的 "fLaC" 魔数头
    plan.region.copy(out, off);
    buf.copy(out, off + plan.region.length, plan.audioStart);
    fs.writeFileSync(tmp, out);
    fs.renameSync(tmp, file);
  }
  // 保留原 mtime，避免客户端因为时间戳变化重新校验
  try {
    fs.utimesSync(file, st.atime, st.mtime);
  } catch {}
  return { format: fmt, changed: true, strategy: plan.strategy };
}

/** 从文件里取出 163key 字符串（原样，含前缀） */
export function read163Key(file) {
  return readTags(file).key163 ?? null;
}

export { build163Key, parse163Key, TAG_PREFIX };
