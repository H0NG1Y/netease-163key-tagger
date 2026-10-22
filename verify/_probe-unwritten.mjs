/**
 * verify/_probe-unwritten.mjs —— 探查：5 个未写入文件的「不写」是正确保守还是漏匹配
 *
 * 判定方法（不依赖项目的匹配器）：
 *   对每个未写入文件，拿本地（备份里的）歌名 + 歌手 + 专辑 + 实测时长，
 *   用深度搜索拉一个大池子，然后**我自己写一套判据**筛出「歌名精确 + 歌手命中 + 时长命中」的候选，
 *   再检查其中是否有专辑名也对得上的。
 *   如果存在这样的候选 → 「不写」是漏匹配（P1 完整性问题）；
 *   如果所有候选在专辑或时长上都有歧义 → 「不写」是正确保守。
 */
import fs from 'node:fs';
import path from 'node:path';
import { BACKUP, TARGET, vDecodeId3Text, vDetectFormat, vFlacStreamInfo, vParseFlac, vParseId3v2, vParseVorbisComment, vFlacStreamInfo as si } from './00-common.mjs';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const H = { 'User-Agent': UA, Referer: 'https://music.163.com/' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const norm = (s) =>
  String(s ?? '')
    .toLowerCase()
    .replace(/[\s\u3000]/g, '')
    .replace(/[（(]/g, '(')
    .replace(/[）)]/g, ')')
    .replace(/[''`]/g, "'")
    .trim();

const splitArtists = (s) => String(s ?? '').split(/[;；、,，&＆/]|feat\.?|ft\.?/i).map(norm).filter(Boolean);

const BR_V1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const BR_V2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const SRATE = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

/** 用 Xing/Info 权威帧数算 MP3 时长（这是最可靠的独立算法，不靠解码） */
function mp3DurationFromXing(buf, from) {
  for (let i = from; i + 4 < buf.length; i++) {
    if (buf[i] !== 0xff || (buf[i + 1] & 0xe0) !== 0xe0) continue;
    const vBits = (buf[i + 1] >> 3) & 3;
    const lBits = (buf[i + 1] >> 1) & 3;
    const brIdx = (buf[i + 2] >> 4) & 0xf;
    const srIdx = (buf[i + 2] >> 2) & 3;
    if (vBits === 1 || lBits === 0 || brIdx === 0 || brIdx === 15 || srIdx === 3) continue;
    const sampleRate = SRATE[vBits === 3 ? 3 : vBits === 2 ? 2 : 0][srIdx];
    const spf = lBits === 3 ? 384 : lBits === 2 ? 1152 : vBits === 3 ? 1152 : 576;
    const sideInfo = vBits === 3 ? 32 : 17;
    for (const off of [i + 4 + sideInfo, i + 4 + 17, i + 4 + 9, i + 36, i + 21, i + 13]) {
      if (off + 12 > buf.length) continue;
      const tag = buf.toString('latin1', off, off + 4);
      if (tag !== 'Xing' && tag !== 'Info') continue;
      const flags = buf.readUInt32BE(off + 4);
      if (!(flags & 1)) continue;
      const frames = buf.readUInt32BE(off + 8);
      return Math.round((frames * spf * 1000) / sampleRate);
    }
    return null;
  }
  return null;
}

function localMeta(p) {
  const buf = fs.readFileSync(p);
  const fmt = vDetectFormat(buf);
  if (fmt === 'flac') {
    const fl = vParseFlac(buf);
    const vc = fl.blocks.find((b) => b.type === 4);
    const out = { fmt, title: null, artist: null, album: null };
    if (vc) {
      for (const c of vParseVorbisComment(vc.data).comments) {
        const eq = c.indexOf('=');
        if (eq < 0) continue;
        const k = c.slice(0, eq).toUpperCase();
        const v = c.slice(eq + 1);
        if (k === 'TITLE' && !out.title) out.title = v;
        else if (k === 'ARTIST' && !out.artist) out.artist = v;
        else if (k === 'ALBUM' && !out.album) out.album = v;
      }
    }
    const s = vFlacStreamInfo(fl.blocks);
    out.durationMs = s?.durationMs ?? null;
    return out;
  }
  const id3 = vParseId3v2(buf);
  const out = { fmt, title: null, artist: null, album: null, durationMs: null };
  for (const f of id3.frames) {
    const t = f.data.length > 1 ? vDecodeId3Text(f.data.subarray(1), f.data[0]) : '';
    if (f.id === 'TIT2' && !out.title) out.title = t;
    else if (f.id === 'TPE1' && !out.artist) out.artist = t;
    else if (f.id === 'TALB' && !out.album) out.album = t;
    else if (f.id === 'TLEN' && !out.durationMs) out.durationMs = parseInt(t, 10) || null;
  }
  // TLEN 缺失时用 Xing/Info 权威帧数自己算（不自造近似值）
  if (!out.durationMs) out.durationMs = mp3DurationFromXing(buf, id3.total);
  return out;
}

const unwritten = fs
  .readdirSync(TARGET)
  .filter((n) => /\.(mp3|flac)$/i.test(n))
  .filter((n) => {
    const b = fs.readFileSync(path.join(TARGET, n));
    return !b.includes(Buffer.from('163 key(Don', 'latin1'));
  })
  .sort();

console.log(`未写入 163key 的文件：${unwritten.length} 个\n`);

for (const name of unwritten) {
  const lm = localMeta(path.join(BACKUP, name));
  console.log(`\n═══ ${name}`);
  console.log(`  本地: 「${lm.title}」/「${lm.artist}」/《${lm.album}》/${lm.durationMs}ms  [${lm.fmt}]`);

  // 深度搜索：多个 query
  const queries = [`${lm.title} ${splitArtists(lm.artist)[0] ?? ''}`.trim(), lm.title];
  const pool = new Map();
  for (const q of queries) {
    try {
      const r = await fetch('https://music.163.com/api/cloudsearch/pc', {
        method: 'POST',
        headers: { ...H, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ s: q, type: '1', limit: '100', offset: '0' }),
      });
      const j = await r.json();
      for (const s of j.result?.songs || []) {
        if (!pool.has(s.id)) {
          pool.set(s.id, {
            id: s.id,
            name: s.name,
            artists: (s.ar || []).map((a) => [a.name, a.id]),
            album: (s.al || {}).name ?? '',
            albumId: (s.al || {}).id ?? 0,
            duration: s.dt,
          });
        }
      }
    } catch (e) {
      console.log(`  搜索失败 ${q}: ${e.message}`);
    }
    await sleep(700);
  }
  console.log(`  池子 ${pool.size} 个候选`);

  // 我自己的判据
  const scored = [];
  for (const c of pool.values()) {
    const titleExact = norm(c.name) === norm(lm.title);
    const lArt = new Set(splitArtists(lm.artist));
    const cArt = new Set(c.artists.map((a) => norm(a[0])));
    const artistHit = [...lArt].some((x) => cArt.has(x));
    const durDelta = lm.durationMs != null ? Math.abs(c.duration - lm.durationMs) : null;
    const durOk = durDelta != null && durDelta <= 3000;
    const albumExact = !!lm.album && norm(lm.album) === norm(c.album);
    const zeroArtist = c.artists.some((a) => a[1] === 0);
    const emptyAlbum = !String(c.album || '').trim();
    if (titleExact && artistHit && durOk) {
      scored.push({ ...c, durDelta, albumExact, zeroArtist, emptyAlbum });
    }
  }
  scored.sort((a, b) => (b.albumExact - a.albumExact) || a.durDelta - b.durDelta);

  if (!scored.length) {
    console.log(`  → 没有任何「歌名精确 + 歌手命中 + 时长≤3s」的候选  ⇒ 不写是正确保守`);
  } else {
    console.log(`  → 找到 ${scored.length} 个「歌名精确+歌手命中+时长命中」候选：`);
    for (const s of scored.slice(0, 6)) {
      const tags = [s.albumExact ? '专辑也命中★' : '专辑不同', s.zeroArtist ? 'artist.id=0!' : '', s.emptyAlbum ? '空专辑!' : ''].filter(Boolean).join(' ');
      console.log(`      ${s.id}  ${s.name}  ${s.artists.map((a) => `${a[0]}(${a[1]})`).join('/')}  《${s.album}》  ${s.duration}ms(Δ${s.durDelta})  ${tags}`);
    }
    const best = scored[0];
    if (best.albumExact && !best.zeroArtist && !best.emptyAlbum) {
      console.log(`  ⇒ ⇒ 存在唯一的完全匹配（专辑也对得上）: ${best.id}  —— 「不写」属于漏匹配`);
    } else if (scored.length === 1) {
      console.log(`  ⇒ 只有一个候选且在专辑上有差异，属可判定 —— 需要人工判断`);
    } else {
      console.log(`  ⇒ 多个候选互相分不开（专辑全不对或重复），「不写」是正确保守`);
    }
  }
  await sleep(700);
}
