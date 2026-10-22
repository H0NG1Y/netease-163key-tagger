/**
 * 163key 编解码器 —— 网易云音乐写入下载文件的 `163 key(Don't modify):` 标签。
 *
 * 算法（已在客户端真实下载的一个 mp3 样本上逐字节验证
 * 上做过严格往返验证：解密后重新加密，与原 Base64 逐字节一致）：
 *
 *   tag   = "163 key(Don't modify):" + base64( AES-128-ECB/PKCS#7( "music:" + compactJSON ) )
 *
 * - 密钥固定 16 字节："#14ljk_!\]&0U<'("  (hex 2331346c6a6b5f215c5d2630553c2728)
 * - 明文 JSON 是紧凑序列化（JSON.stringify 默认，无空格），键顺序见 FIELD_ORDER
 * - ECB + PKCS#7，Node 的 createCipheriv 默认填充即为 PKCS#7
 * - 没有任何签名 / MAC：所以可以自行伪造，客户端拿到后只当元数据用
 */

import crypto from 'node:crypto';

/** 16 字节 AES-128 密钥 */
export const KEY_163 = Buffer.from("#14ljk_!\\]&0U<'(", 'utf8');

/** 标签前缀，客户端靠它识别 */
export const TAG_PREFIX = "163 key(Don't modify):";

/** 解密后 JSON 前面还有这个前缀 */
export const PLAIN_PREFIX = 'music:';

/**
 * JSON 字段顺序。顺序会影响 Base64 结果的字节，客户端虽然大概率按 key 取值，
 * 但为了尽量和官方产出一致，这里固定顺序。
 */
export const FIELD_ORDER = [
  'musicId',
  'musicName',
  'artist',
  'albumId',
  'album',
  'albumPicDocId',
  'albumPic',
  'bitrate',
  'mp3DocId',
  'duration',
  'mvId',
  'alias',
  'transNames',
  'format',
];

if (KEY_163.length !== 16) {
  // 防御性检查：密钥写错会导致全部产物不可解析
  throw new Error(`163key 密钥长度必须是 16 字节，实际 ${KEY_163.length}`);
}

/**
 * 规范化 meta：按 FIELD_ORDER 排列键，补齐缺省值，剔除未知键。
 * @param {object} meta
 * @returns {object}
 */
export function normalizeMeta(meta) {
  if (!meta || typeof meta !== 'object') throw new TypeError('meta 必须是对象');
  if (meta.musicId === undefined || meta.musicId === null) {
    throw new TypeError('meta.musicId 必填');
  }
  const out = {};
  for (const k of FIELD_ORDER) {
    let v = meta[k];
    if (v === undefined || v === null) {
      switch (k) {
        case 'musicName': v = ''; break;
        case 'artist': v = []; break;
        case 'albumId': v = 0; break;
        case 'album': v = ''; break;
        case 'albumPicDocId': v = ''; break;
        case 'albumPic': v = ''; break;
        case 'bitrate': v = 0; break;
        case 'mp3DocId': v = ''; break;
        case 'duration': v = 0; break;
        case 'mvId': v = 0; break;
        case 'alias': v = []; break;
        case 'transNames': v = []; break;
        case 'format': v = ''; break;
        default: v = '';
      }
    }
    out[k] = v;
  }
  out.musicId = Number(out.musicId);
  out.albumId = Number(out.albumId) || 0;
  out.bitrate = Number(out.bitrate) || 0;
  out.duration = Number(out.duration) || 0;
  out.mvId = Number(out.mvId) || 0;
  if (!Array.isArray(out.artist)) out.artist = [];
  if (!Array.isArray(out.alias)) out.alias = [];
  if (!Array.isArray(out.transNames)) out.transNames = [];
  return out;
}

/**
 * meta -> 明文（"music:" + 紧凑 JSON）
 * @param {object} meta
 * @returns {string}
 */
export function metaToPlaintext(meta) {
  return PLAIN_PREFIX + JSON.stringify(normalizeMeta(meta));
}

/**
 * 明文 -> meta
 * @param {string} plaintext
 * @returns {object}
 */
export function plaintextToMeta(plaintext) {
  if (!plaintext.startsWith(PLAIN_PREFIX)) {
    throw new Error(`明文缺少 "${PLAIN_PREFIX}" 前缀`);
  }
  return JSON.parse(plaintext.slice(PLAIN_PREFIX.length));
}

/**
 * 加密成 Base64（不含标签前缀）。
 * @param {object} meta
 * @returns {string}
 */
export function encryptMetaToBase64(meta) {
  const plain = Buffer.from(metaToPlaintext(meta), 'utf8');
  const cipher = crypto.createCipheriv('aes-128-ecb', KEY_163, null);
  return Buffer.concat([cipher.update(plain), cipher.final()]).toString('base64');
}

/**
 * Base64 -> meta
 * @param {string} b64
 * @returns {object}
 */
export function decryptBase64ToMeta(b64) {
  const ct = Buffer.from(b64, 'base64');
  if (ct.length === 0 || ct.length % 16 !== 0) {
    throw new Error(`密文长度异常：${ct.length} 字节（必须是 16 的整数倍）`);
  }
  const decipher = crypto.createDecipheriv('aes-128-ecb', KEY_163, null);
  const plain = Buffer.concat([decipher.update(ct), decipher.final()]);
  return plaintextToMeta(plain.toString('utf8'));
}

/**
 * meta -> 完整标签字符串（带 "163 key(Don't modify):" 前缀），可直接写进标签。
 * @param {object} meta
 * @returns {string}
 */
export function build163Key(meta) {
  return TAG_PREFIX + encryptMetaToBase64(meta);
}

/**
 * 从一段文本里解析 163key。标签值里可能带 "163 key(Don't modify):" 前缀，也可能只有 Base64。
 * @param {string} text
 * @returns {object|null} 解析失败返回 null
 */
export function parse163Key(text) {
  if (typeof text !== 'string') return null;
  let s = text;
  const i = s.indexOf(TAG_PREFIX);
  if (i >= 0) s = s.slice(i + TAG_PREFIX.length);
  s = s.trim();
  if (!s) return null;
  try {
    return decryptBase64ToMeta(s);
  } catch {
    return null;
  }
}

/**
 * 判断某个标签文本是不是 163key（不抛异常）。
 * @param {string} text
 * @returns {boolean}
 */
export function looksLike163Key(text) {
  return typeof text === 'string' && text.includes(TAG_PREFIX);
}
