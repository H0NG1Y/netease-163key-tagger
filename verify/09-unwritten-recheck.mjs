#!/usr/bin/env node
/**
 * verify/09-unwritten-recheck.mjs —— 复验：剩下 4 个「不带 key」的文件，当前判断是否仍成立
 *
 * 上一轮我判定这 5 个（当时含拼图爱）都是「正确的保守」。拼图爱已被修掉。
 * 现在必须**重新独立判断**剩下 4 个，不能因为上次说过就沿用。
 *
 * 对每个文件，我做三件事：
 *   1. 列出曲库里所有「歌名精确命中」的条目（不预筛，全摊开）
 *   2. 对每个候选给出：歌手 id、专辑、时长差、是否 UGC
 *   3. 用我自己的判据给出结论，并说明「如果要写，写哪个 / 为什么仍不该写」
 *
 * 运行：node verify/09-unwritten-recheck.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { BACKUP, TARGET, C, check, head, info, summary, vDecodeId3Text, vDetectFormat, vFlacStreamInfo, vParseFlac, vParseId3v2, vParseVorbisComment } from './00-common.mjs';

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

const BR_V1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const SRATE = { 3: [44100, 48000, 32000] };

function mp3Dur(buf, from) {
  for (let i = from; i + 4 < buf.length; i++) {
    if (buf[i] !== 0xff || (buf[i + 1] & 0xe0) !== 0xe0) continue;
    const v = (buf[i + 1] >> 3) & 3;
    const l = (buf[i + 1] >> 1) & 3;
    const br = (buf[i + 2] >> 4) & 0xf;
    const sr = (buf[i + 2] >> 2) & 3;
    if (v !== 3 || l !== 1 || br === 0 || br === 15 || sr === 3) continue;
    const sampleRate = SRATE[3][sr];
    for (const off of [i + 4 + 32, i + 4 + 17, i + 36, i + 21, i + 13]) {
      if (off + 12 > buf.length) continue;
      const t = buf.toString('latin1', off, off + 4);
      if (t !== 'Xing' && t !== 'Info') continue;
      const flags = buf.readUInt32BE(off + 4);
      if (!(flags & 1)) continue;
      return Math.round((buf.readUInt32BE(off + 8) * 1152 * 1000) / sampleRate);
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
    out.durationMs = vFlacStreamInfo(fl.blocks)?.durationMs ?? null;
    return out;
  }
  const id3 = vParseId3v2(buf);
  const out = { fmt, title: null, artist: null, album: null };
  for (const f of id3.frames) {
    const t = f.data.length > 1 ? vDecodeId3Text(f.data.subarray(1), f.data[0]) : '';
    if (f.id === 'TIT2' && !out.title) out.title = t;
    else if (f.id === 'TPE1' && !out.artist) out.artist = t;
    else if (f.id === 'TALB' && !out.album) out.album = t;
  }
  out.durationMs = mp3Dur(buf, id3.total);
  return out;
}

async function searchAll(queries) {
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
      console.log(`    搜索失败 ${q}: ${e.message}`);
    }
    await sleep(650);
  }
  return pool;
}

const unwritten = fs
  .readdirSync(TARGET)
  .filter((n) => /\.(mp3|flac)$/i.test(n))
  .filter((n) => !fs.readFileSync(path.join(TARGET, n)).includes(Buffer.from('163 key(Don', 'latin1')))
  .sort();

info('不带 163key 的文件', `${unwritten.length} 个`);
check(unwritten.length === 4, '确实是 4 个（与 Lead 声称一致）', `实际 ${unwritten.length}`);

for (const name of unwritten) {
  const lm = localMeta(path.join(BACKUP, name));
  console.log(`\n${'═'.repeat(76)}`);
  console.log(`═══ ${name}`);
  console.log(`  本地: 「${lm.title}」/「${lm.artist}」/《${lm.album}》/${lm.durationMs}ms [${lm.fmt}]`);

  // 搜歌名 + 搜歌名带第一位歌手
  const firstArtist = String(lm.artist || '').split(/[;；、,，&＆/]/)[0].trim();
  const pool = await searchAll([`${lm.title} ${firstArtist}`.trim(), lm.title]);
  console.log(`  池子 ${pool.size} 个候选`);

  // 只保留歌名精确命中的（这是硬门槛）
  const exactTitle = [...pool.values()].filter((c) => norm(c.name) === norm(lm.title));
  console.log(`  歌名精确命中: ${exactTitle.length} 个`);
  if (!exactTitle.length) {
    console.log(`  ⇒ 曲库里没有同名条目，「不写」正确`);
    continue;
  }

  // 全摊开，按时长差排序
  exactTitle.sort((a, b) => Math.abs(a.duration - lm.durationMs) - Math.abs(b.duration - lm.durationMs));
  console.log(`  ${'id'.padEnd(12)} ${'歌手(id)'.padEnd(32)} ${'专辑'.padEnd(20)} 时长差`);
  for (const c of exactTitle.slice(0, 12)) {
    const d = c.duration - lm.durationMs;
    const allZero = c.artists.length > 0 && c.artists.every((a) => a[1] === 0);
    const emptyAlbum = !String(c.album || '').trim();
    const ugc = allZero && emptyAlbum;
    const artStr = c.artists.map((a) => `${a[0]}(${a[1]})`).join('/');
    console.log(
      `  ${String(c.id).padEnd(12)} ${artStr.padEnd(32).slice(0, 32)} ${String(c.album || '(空)').padEnd(20).slice(0, 20)} ${String(d).padStart(7)}ms ${ugc ? 'UGC!' : ''}${Math.abs(d) <= 1000 ? ' ★≤1s' : Math.abs(d) <= 3000 ? ' ☆≤3s' : ''}`,
    );
  }

  // 我的判据（三档，逐档放宽，让「差在哪」可见）
  //   档 A 严格：歌名精确 + 歌手命中 + 时长Δ≤1s + 非UGC + 专辑名相符
  //   档 B 次严：歌名精确 + 歌手命中 + 时长Δ≤1s + 非UGC（不看专辑）
  //   档 C 存疑：歌名精确 + 时长Δ≤1s + 非UGC，但**歌手不符**（单独列出，需人工判断）
  const splitArtists = (s) => String(s ?? '').split(/[;；、,，&＆/]/).map(norm).filter(Boolean);
  const localArts = new Set(splitArtists(lm.artist));
  const isUgc = (c) => c.artists.length > 0 && c.artists.every((a) => a[1] === 0) && !String(c.album || '').trim();
  const artistHit = (c) => {
    const ca = new Set(c.artists.map((a) => norm(a[0])));
    return [...localArts].some((x) => ca.has(x));
  };

  const tierA = exactTitle.filter((c) => Math.abs(c.duration - lm.durationMs) <= 1000 && !isUgc(c) && artistHit(c) && norm(c.album) === norm(lm.album));
  const tierB = exactTitle.filter((c) => Math.abs(c.duration - lm.durationMs) <= 1000 && !isUgc(c) && artistHit(c));
  const tierC = exactTitle.filter((c) => Math.abs(c.duration - lm.durationMs) <= 1000 && !isUgc(c) && !artistHit(c));

  console.log(`\n  档 A（歌名+歌手+时长≤1s+专辑 全中）: ${tierA.length} 个`);
  console.log(`  档 B（歌名+歌手+时长≤1s）:        ${tierB.length} 个`);
  console.log(`  档 C（歌名+时长≤1s，但歌手不符）:  ${tierC.length} 个`);

  if (tierA.length === 1) {
    console.log(`  ⇒ 结论：有且仅有一个完全匹配 ${tierA[0].id}  —— 「不写」属于漏匹配`);
  } else if (tierA.length > 1) {
    const ids = tierA.map((c) => c.id).sort((a, b) => a - b);
    const sameAlbumId = new Set(tierA.map((c) => c.albumId)).size === 1;
    console.log(`  ⇒ 结论：多个完全匹配 ${ids.join(', ')}，albumId 全同=${sameAlbumId} —— ${sameAlbumId ? '同一发行的重复登记，属于可修的保守' : '真歧义，正确'}`);
  } else if (tierB.length >= 1) {
    console.log(`  ⇒ 结论：歌手+时长对得上但专辑名不符（本地专辑《${lm.album}》曲库查无）`);
    console.log(`     候选: ${tierB.map((c) => `${c.id}《${c.album}》Δ${c.duration - lm.durationMs}ms`).join('; ')}`);
    console.log(`     「不写」可辩护（专辑无法确认版本归属），但人工可判定`);
  } else if (tierC.length >= 1) {
    console.log(`  ⇒ 结论：存在「歌名+专辑+时长」全中但**歌手账号不同**的条目：`);
    for (const c of tierC) {
      console.log(`     ${c.id}  ${c.name}  云端歌手=${c.artists.map((a) => `${a[0]}(${a[1]})`).join('/')}  《${c.album}》(albumId ${c.albumId})  Δ${c.duration - lm.durationMs}ms`);
    }
    console.log(`     本地歌手=「${lm.artist}」  云端歌手=「${tierC.map((c) => c.artists.map((a) => a[0]).join('/')).join(' / ')}」`);
    console.log(`     ⇒ 「不写」在「宁可漏写不可写错」策略下可辩护；`);
    console.log(`        但需人工确认这两个歌手账号是否同一人。若同一人，则属于漏匹配。`);
  } else {
    console.log(`  ⇒ 结论：无任何可接受候选，「不写」是唯一正确选择`);
  }
}

process.exitCode = summary('09-unwritten-recheck') ? 0 : 1;
