// _audioinfo.mjs — 只读取本地音频文件本身的信息（格式 / 时长 / 码率），绝不修改文件。
// 探针专用（Lead 的 lib/tags.mjs 有自己的实现，这里不重复造轮子到 lib/ 里）。
// 支持：FLAC（STREAMINFO，精确）、MP3（Xing/Info VBR 头或 CBR 估算）。
import { openSync, readSync, closeSync, statSync } from 'node:fs';

const ID3V2_FLAG_FOOTER = 0x10;

function readAt(fd, pos, len) {
  const b = Buffer.alloc(len);
  readSync(fd, b, 0, len, pos);
  return b;
}

/** FLAC: STREAMINFO -> 时长精确、码率按 文件大小/时长 估算 */
function readFlac(fd, size) {
  // 'fLaC' 之后是 METADATA_BLOCK_HEADER: 1 byte (last<<7|type) + 3 bytes length
  let pos = 4;
  for (let guard = 0; guard < 16; guard++) {
    const h = readAt(fd, pos, 4);
    const type = h[0] & 0x7f;
    const last = (h[0] & 0x80) !== 0;
    const len = (h[1] << 16) | (h[2] << 8) | h[3];
    if (type === 0 && len >= 34) {
      const s = readAt(fd, pos + 4, 34);
      const sampleRate = (s[10] << 12) | (s[11] << 4) | (s[12] >> 4);
      const channels = ((s[12] >> 1) & 0x07) + 1;
      const bitsPerSample = (((s[12] & 0x01) << 4) | (s[13] >> 4)) + 1;
      // 36-bit total samples: low nibble of s[13], then s[14..17]
      const hi = s[13] & 0x0f;
      const totalSamples = hi * 2 ** 32 + s.readUInt32BE(14);
      const durationMs = sampleRate > 0 ? Math.round((totalSamples / sampleRate) * 1000) : 0;
      const bitrate = durationMs > 0 ? Math.round((size * 8) / (durationMs / 1000)) : 0;
      return { format: 'flac', durationMs, bitrate, sampleRate, channels, bitsPerSample, totalSamples, exact: true };
    }
    pos += 4 + len;
    if (last) break;
  }
  return { format: 'flac', durationMs: 0, bitrate: 0, exact: false };
}

const MPEG_VERSIONS = [2.5, null, 2, 1];
const SAMPLE_RATES = { 1: [44100, 48000, 32000], 2: [22050, 24000, 16000], 2.5: [11025, 12000, 8000] };
const BITRATES = {
  // [versionGroup][layer][index]
  1: { 1: [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448], 2: [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384], 3: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320] },
  2: { 1: [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256], 2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160], 3: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160] },
};

function parseMp3FrameHeader(b) {
  if (b[0] !== 0xff || (b[1] & 0xe0) !== 0xe0) return null;
  const version = MPEG_VERSIONS[(b[1] >> 3) & 0x03];
  const layer = 4 - ((b[1] >> 1) & 0x03);
  const bitrateIdx = (b[2] >> 4) & 0x0f;
  const srIdx = (b[2] >> 2) & 0x03;
  const padding = (b[2] >> 1) & 0x01;
  if (!version || layer === 4 || bitrateIdx === 0 || bitrateIdx === 15 || srIdx === 3) return null;
  const group = version === 1 ? 1 : 2;
  const bitrate = BITRATES[group][layer][bitrateIdx] * 1000;
  const sampleRate = SAMPLE_RATES[version][srIdx];
  return { version, layer, bitrate, sampleRate, padding, samplesPerFrame: layer === 1 ? 384 : layer === 2 ? 1152 : version === 1 ? 1152 : 576 };
}

/**
 * MP3: 跳过 ID3v2，用「连续多帧一致性」校验找到真实帧起点（第一版只校验一帧，会把
 * 随机字节误认成 8kbps 的帧，算出 76 分钟的荒唐时长 —— 实测「郑润泽 - 瞬.mp3」中招）。
 * 找到起点后逐帧走完全文件：Xing/Info 头优先，否则用帧数 × 每帧样本数算真实时长。
 */
function readMp3(buf, fd) {
  const size = buf.length;
  const head = buf.subarray(0, 10);
  let offset = 0;
  if (head.toString('latin1', 0, 3) === 'ID3') {
    const sz = ((head[6] & 0x7f) << 21) | ((head[7] & 0x7f) << 14) | ((head[8] & 0x7f) << 7) | (head[9] & 0x7f);
    offset = 10 + sz + ((head[5] & ID3V2_FLAG_FOOTER) ? 10 : 0);
  }
  let audioEnd = size;
  if (size > 128 && buf.toString('latin1', size - 128, size - 125) === 'TAG') audioEnd = size - 128;

  const frameLen = (h) => Math.floor((h.bitrate * h.samplesPerFrame) / (8 * h.sampleRate)) + h.padding;

  // 帧起点校验：要求连续 4 帧都合法且版本/层/采样率一致
  const start = (() => {
    for (let i = offset; i + 4 <= Math.min(audioEnd, offset + 512 * 1024); i++) {
      const h = parseMp3FrameHeader(buf.subarray(i, i + 4));
      if (!h) continue;
      let p = i;
      let ok = 0;
      for (let k = 0; k < 4; k++) {
        const hh = parseMp3FrameHeader(buf.subarray(p, p + 4));
        if (!hh || hh.version !== h.version || hh.layer !== h.layer || hh.sampleRate !== h.sampleRate) break;
        ok++;
        p += frameLen(hh);
        if (p + 4 > audioEnd) break;
      }
      if (ok >= 4) return i;
    }
    return -1;
  })();
  if (start < 0) return { format: 'mp3', durationMs: 0, bitrate: 0, exact: false, note: '找不到可信的连续帧起点' };

  const h0 = parseMp3FrameHeader(buf.subarray(start, start + 4));
  // Xing / Info（VBR 头）优先
  const sideInfo = h0.version === 1 ? (h0.layer === 3 ? 32 : 17) : h0.layer === 3 ? 17 : 9;
  const xingOff = start + 4 + sideInfo;
  const tagStr = buf.toString('latin1', xingOff, xingOff + 4);

  // 逐帧走完全文件，统计帧数与总字节（对 CBR 无 Xing 的文件这就是真实时长）
  let p = start;
  let frames = 0;
  let bytes = 0;
  let firstBitrate = h0.bitrate;
  let bitrateSum = 0;
  const bitrateHist = new Map();
  while (p + 4 <= audioEnd) {
    const h = parseMp3FrameHeader(buf.subarray(p, p + 4));
    if (!h) {
      // 允许少量坏帧/脏数据：向前再扫最多 4KB 重新同步
      let resync = -1;
      for (let i = p + 1; i < Math.min(p + 4096, audioEnd - 4); i++) {
        const hh = parseMp3FrameHeader(buf.subarray(i, i + 4));
        if (hh && hh.version === h0.version && hh.layer === h0.layer && hh.sampleRate === h0.sampleRate) { resync = i; break; }
      }
      if (resync < 0) break;
      bytes += resync - p;
      p = resync;
      continue;
    }
    const len = frameLen(h);
    bitrateHist.set(h.bitrate, (bitrateHist.get(h.bitrate) ?? 0) + 1);
    bitrateSum += h.bitrate;
    frames++;
    bytes += len;
    p += len;
  }
  if (frames < 10) return { format: 'mp3', durationMs: 0, bitrate: 0, exact: false, note: `帧数过少(${frames})` };
  const avgBitrate = Math.round(bitrateSum / frames);
  const durationMs = Math.round((frames * h0.samplesPerFrame * 1000) / h0.sampleRate);

  if (tagStr === 'Xing' || tagStr === 'Info') {
    const flags = buf.readUInt32BE(xingOff + 4);
    let q = xingOff + 8;
    let xFrames = 0;
    if (flags & 0x0001) { xFrames = buf.readUInt32BE(q); q += 4; }
    if (xFrames > 0) {
      return {
        format: 'mp3', durationMs: Math.round((xFrames * h0.samplesPerFrame * 1000) / h0.sampleRate),
        bitrate: avgBitrate, sampleRate: h0.sampleRate, vbr: tagStr === 'Xing', frames: xFrames, exact: true,
      };
    }
  }
  return {
    format: 'mp3', durationMs, bitrate: avgBitrate, sampleRate: h0.sampleRate,
    vbr: bitrateHist.size > 1, frames, firstBitrate, distinctBitrates: bitrateHist.size,
    // 逐帧走完 = 帧数法，时长就是解码时长（±1 帧），可当精确值用于时长闸门
    exact: true,
  };
}

/** 只读：返回 { format, durationMs, bitrate, ... } */
export function readAudioInfo(filePath) {
  const size = statSync(filePath).size;
  const fd = openSync(filePath, 'r');
  try {
    const magic = readAt(fd, 0, 4);
    if (magic.toString('latin1') === 'fLaC') return { file: filePath, size, ...readFlac(fd, size) };
    if (magic.toString('latin1', 0, 3) === 'ID3' || (magic[0] === 0xff && (magic[1] & 0xe0) === 0xe0)) {
      // MP3 需要逐帧走完全文件才能得到真实时长，整块读进来（只读，不写回）
      const buf = Buffer.alloc(size);
      readSync(fd, buf, 0, size, 0);
      return { file: filePath, size, ...readMp3(buf) };
    }
    return { file: filePath, size, format: 'other', durationMs: 0, bitrate: 0, exact: false, magic: magic.toString('hex') };
  } finally {
    closeSync(fd);
  }
}

// ---------------------------------------------------------------------------
// 专辑名（只读）：有意从「文件标签」里取，而不是从文件名推断 —— 它是区分
// 同一录音的不同专辑条目（原专辑 vs 精选集）的唯一信号，见 notes/api.md §8。
// ---------------------------------------------------------------------------

const ID3_TEXT_ENCODINGS = { 0: 'latin1', 1: 'utf16le', 2: 'utf16be', 3: 'utf8' };

function decodeId3Text(buf) {
  if (!buf.length) return '';
  const enc = buf[0];
  let body = buf.subarray(1);
  if (enc === 0 || enc === 3) {
    const s = body.toString(ID3_TEXT_ENCODINGS[enc]);
    return s.replace(/\0.*$/, '').trim();
  }
  // UTF-16 带 BOM（enc=1）或显式大端（enc=2）
  if (enc === 1 && body.length >= 2) {
    const bom = body.readUInt16BE(0);
    if (bom === 0xfffe) return body.subarray(2).toString('utf16le').replace(/\0.*$/, '').trim();
    if (bom === 0xfeff) return swap16(body.subarray(2)).toString('utf16le').replace(/\0.*$/, '').trim();
  }
  return swap16(body).toString('utf16le').replace(/\0.*$/, '').trim();
}

function swap16(b) {
  const out = Buffer.from(b);
  if (out.length % 2) return out;
  for (let i = 0; i < out.length; i += 2) {
    const t = out[i];
    out[i] = out[i + 1];
    out[i + 1] = t;
  }
  return out;
}

/** 读取标签里的专辑名（MP3: ID3v2 TALB；FLAC: Vorbis comment 的 ALBUM 字段）；读不到返回 ''。 */
export function readAlbumTag(filePath) {
  const size = statSync(filePath).size;
  const fd = openSync(filePath, 'r');
  try {
    const magic = readAt(fd, 0, 4);
    if (magic.toString('latin1') === 'fLaC') {
      let pos = 4;
      for (let guard = 0; guard < 32; guard++) {
        const h = readAt(fd, pos, 4);
        const type = h[0] & 0x7f;
        const last = (h[0] & 0x80) !== 0;
        const len = (h[1] << 16) | (h[2] << 8) | h[3];
        if (type === 4 && len > 8) {
          const block = readAt(fd, pos + 4, Math.min(len, 1 << 20));
          let q = 0;
          const vlen = block.readUInt32LE(q);
          q += 4 + vlen;
          if (q + 4 > block.length) return '';
          const count = block.readUInt32LE(q);
          q += 4;
          for (let i = 0; i < count && q + 4 <= block.length; i++) {
            const clen = block.readUInt32LE(q);
            q += 4;
            if (q + clen > block.length) break;
            const kv = block.toString('utf8', q, q + clen);
            q += clen;
            const eq = kv.indexOf('=');
            if (eq > 0 && kv.slice(0, eq).toUpperCase() === 'ALBUM') return kv.slice(eq + 1).trim();
          }
          return '';
        }
        pos += 4 + len;
        if (last) break;
      }
      return '';
    }
    if (magic.toString('latin1', 0, 3) === 'ID3') {
      const head = readAt(fd, 0, 10);
      const ver = head[3];
      const tagSize = ((head[6] & 0x7f) << 21) | ((head[7] & 0x7f) << 14) | ((head[8] & 0x7f) << 7) | (head[9] & 0x7f);
      const tag = readAt(fd, 10, tagSize);
      let q = 0;
      while (q + 10 <= tag.length) {
        const id = tag.toString('latin1', q, q + 4);
        const fsize = ver >= 4
          ? ((tag[q + 4] & 0x7f) << 21) | ((tag[q + 5] & 0x7f) << 14) | ((tag[q + 6] & 0x7f) << 7) | (tag[q + 7] & 0x7f)
          : tag.readUInt32BE(q + 4);
        if (!/^[A-Z0-9]{4}$/.test(id) || fsize <= 0 || q + 10 + fsize > tag.length) break;
        if (id === 'TALB') return decodeId3Text(tag.subarray(q + 10, q + 10 + fsize));
        q += 10 + fsize;
      }
      return '';
    }
    return '';
  } catch {
    return '';
  } finally {
    closeSync(fd);
  }
}
