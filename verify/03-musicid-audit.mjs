#!/usr/bin/env node
/**
 * verify/03-musicid-audit.mjs —— musicId 正确性审计（本次审计的重点）
 *
 * 立场：写入文件里的 163key 说得再自洽也没用，唯一的判据是——
 *   拿 musicId 去网易云反查，返回的「歌名 / 歌手 / 专辑 / 时长」和本地文件对得上吗？
 *
 * 独立性：
 *   - musicId 来自自建解析器读出的标签（verify/00-common.mjs），不读 out/*.json 报告
 *   - 本地侧（歌名/歌手/专辑/时长）也由自建解析器从**备份文件**重新读一遍
 *     （备份 = 写前快照，等于「写标签之前的真实本地状态」）
 *   - 反查走 /api/song/detail/，结果落盘到 verify/artifacts/id-lookup.json 便于复核
 *
 * 三个已知陷阱的针对性检查：
 *   T1  UGC 冒充：artist.id === 0 且专辑名为空 —— 绝不能出现在任何写入里
 *   T2  时长/专辑错配：同曲多条目，Δ1ms，只能靠专辑名区分（简单爱 186119 vs 5255440）
 *   T3  冒名上传的歌名里带 "#0"、专辑名是空的
 *
 * 运行：node verify/03-musicid-audit.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  BACKUP,
  C,
  TARGET,
  check,
  head,
  info,
  summary,
  vDecodeId3Text,
  vParseFlac,
  vParseId3v2,
  vParseVorbisComment,
  vDetectFormat,
  vFlacStreamInfo,
} from './00-common.mjs';

const API = 'https://music.163.com/api/song/detail/?ids=[]';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ───────────────────────────────────────────────────────────────────────────
// 本地侧元数据：完全自建，从备份文件读（写前状态）
// ───────────────────────────────────────────────────────────────────────────

/** 从 MP3 的 ID3v2 读 TIT2/TPE1/TALB，并独立估算时长 */
function mp3LocalMeta(buf) {
  const id3 = vParseId3v2(buf);
  const out = { format: 'mp3', title: null, artist: null, album: null, durationMs: null, id3ver: id3.present ? `${id3.ver}.${id3.rev}` : null };
  for (const f of id3.frames) {
    if (f.data.length < 2) continue;
    const enc = f.data[0];
    const txt = vDecodeId3Text(f.data.subarray(1), enc);
    if (f.id === 'TIT2' && out.title == null) out.title = txt;
    else if (f.id === 'TPE1' && out.artist == null) out.artist = txt;
    else if (f.id === 'TALB' && out.album == null) out.album = txt;
    else if (f.id === 'TLEN' && out.durationMs == null) {
      const v = parseInt(txt, 10);
      if (Number.isFinite(v) && v > 0) out.durationMs = v;
    }
  }
  if (out.durationMs == null) out.durationMs = estimateMp3Ms(buf, id3.total);
  return out;
}

/** 独立的 MP3 时长估算：优先 Xing/Info 帧数，否则 CBR 按字节数算 */
function estimateMp3Ms(buf, audioStart) {
  const BR = { 11: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320], 12: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160], 13: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160] };
  const SR = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };
  const SAMPLES = { 1: 384, 2: 1152, 3: 1152 };
  for (let i = audioStart; i + 4 < buf.length; i++) {
    if (buf[i] !== 0xff || (buf[i + 1] & 0xe0) !== 0xe0) continue;
    const vBits = (buf[i + 1] >> 3) & 3;
    const lBits = (buf[i + 1] >> 1) & 3;
    const brIdx = (buf[i + 2] >> 4) & 0xf;
    const srIdx = (buf[i + 2] >> 2) & 3;
    if (vBits === 1 || lBits === 0 || brIdx === 0 || brIdx === 15 || srIdx === 3) continue;
    const layer = lBits === 3 ? 1 : lBits === 2 ? 2 : 3;
    const kbps = BR[vBits === 3 ? 11 : lBits === 1 ? 12 : 13][brIdx];
    const sr = SR[vBits === 3 ? 3 : vBits === 2 ? 2 : 0][srIdx];
    const spf = SAMPLES[layer];
    // 在帧头附近几个常见位置找 Xing/Info
    const tryXing = (o) => {
      if (o + 12 > buf.length) return null;
      const t = buf.toString('latin1', o, o + 4);
      if (t !== 'Xing' && t !== 'Info') return null;
      const flags = buf.readUInt32BE(o + 4);
      if (!(flags & 1)) return null;
      return Math.round((buf.readUInt32BE(o + 8) * spf) / sr * 1000);
    };
    const sideInfo = vBits === 3 ? (buf[i + 1] & 0x01 ? 32 : 17) : 9;
    for (const o of [i + 4 + sideInfo, i + 36, i + 21, i + 13]) {
      const d = tryXing(o);
      if (d) return d;
    }
    // CBR fallback
    return Math.round(((buf.length - i) * 8 / (kbps * 1000)) * 1000);
  }
  return null;
}

/** 从 FLAC 读 TITLE/ARTIST/ALBUM + STREAMINFO 精确时长（自建） */
function flacLocalMeta(buf) {
  const flac = vParseFlac(buf);
  const out = { format: 'flac', title: null, artist: null, album: null, durationMs: null };
  const vc = flac.blocks.find((b) => b.type === 4);
  if (vc) {
    try {
      const { comments } = vParseVorbisComment(vc.data);
      for (const c of comments) {
        const eq = c.indexOf('=');
        if (eq < 0) continue;
        const k = c.slice(0, eq).toUpperCase();
        const v = c.slice(eq + 1);
        if (k === 'TITLE' && out.title == null) out.title = v;
        else if (k === 'ARTIST' && out.artist == null) out.artist = v;
        else if (k === 'ALBUM' && out.album == null) out.album = v;
      }
    } catch (e) {
      out.vcError = e.message;
    }
  }
  const si = vFlacStreamInfo(flac.blocks);
  if (si) out.durationMs = si.durationMs;
  return out;
}

function localMeta(file) {
  const buf = fs.readFileSync(file);
  const fmt = vDetectFormat(buf);
  if (fmt === 'mp3') return mp3LocalMeta(buf);
  if (fmt === 'flac') return flacLocalMeta(buf);
  return { format: fmt, title: null, artist: null, album: null, durationMs: null };
}

// ───────────────────────────────────────────────────────────────────────────
// 规范化比较
// ───────────────────────────────────────────────────────────────────────────

const norm = (s) =>
  String(s ?? '')
    .toLowerCase()
    .replace(/[\s\u3000]/g, '')
    .replace(/[（(]/g, '(')
    .replace(/[）)]/g, ')')
    .replace(/[、,，&＆/]/g, '/')
    .replace(/[''`]/g, "'")
    .trim();

/** 歌手集合比较：本地可能是 "A/B"、"A、B"、"A;B"（实测 ID3 与 Vorbis 都用分号），API 给数组 */
function artistSets(local, apiArtists) {
  const split = (s) =>
    String(s ?? '')
      .split(/[;；、,，&＆/]|feat\.?|ft\.?/i)
      .map((x) => norm(x))
      .filter(Boolean);
  const l = new Set(split(local));
  const a = new Set(apiArtists.map((x) => norm(x[0])));
  const inter = [...l].filter((x) => a.has(x));
  // 一方是另一方子集即可（feat. 写法差异）
  const subset = l.size && a.size && (inter.length === Math.min(l.size, a.size));
  return { ok: subset, local: [...l], api: [...a], inter };
}

// ───────────────────────────────────────────────────────────────────────────
// 主流程
// ───────────────────────────────────────────────────────────────────────────

const decoded = JSON.parse(fs.readFileSync(new URL('./decoded.json', import.meta.url), 'utf8'));
info('待审计文件（已写入 163key）', String(decoded.length));
info('数据源', 'E:\\CloudMusic_backup_20261022（写前快照）的本地标签 + /api/song/detail/ 反查');

head('1. 拉取反查数据（全部 musicId）');
const ids = decoded.map((d) => Number(d.meta.musicId));
const lookup = {};
for (let i = 0; i < ids.length; i += 20) {
  const chunk = ids.slice(i, i + 20);
  const url = `https://music.163.com/api/song/detail/?ids=[${chunk.join(',')}]`;
  let ok = false;
  for (let a = 0; a < 4 && !ok; a++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA, Referer: 'https://music.163.com/' } });
      const j = await r.json();
      for (const s of j.songs || []) {
        lookup[s.id] = {
          name: s.name,
          artists: (s.artists || []).map((x) => [x.name, x.id]),
          album: s.album ? s.album.name : null,
          albumId: s.album ? s.album.id : null,
          duration: s.duration,
          alias: s.alias || [],
          fee: s.fee,
          privilege: s.privilege || null,
        };
      }
      ok = true;
    } catch (e) {
      console.log(`  重试 chunk@${i}: ${e.message}`);
      await sleep(1500);
    }
  }
  if (!ok) check(false, `反查 chunk@${i} 彻底失败`);
  await sleep(700);
}
const missing = ids.filter((id) => !lookup[id]);
check(missing.length === 0, '所有 musicId 都能反查到', missing.length ? `缺失: ${missing.join(',')}` : `${Object.keys(lookup).length} 条`);

// ───────────────────────────────────────────────────────────────────────────
head('2. 陷阱 T1：UGC 冒充条目（artist.id === 0 / 专辑名为空）');
// ───────────────────────────────────────────────────────────────────────────
{
  // 严格按任务书字面：任何 artist.id===0 都要报出来。
  // 但同时必须区分两种性质完全不同的事，否则会造出假 P0：
  //   ① 纯冒充 UGC：所有 artist.id 全为 0 **且** 专辑名为空（如 2153879235「周杰伦#0《》」）
  //      —— 这是「把翻唱写成原唱」，是真正的错配。
  //   ② 混编条目：有真艺人（id>0），只有某个配角歌手未注册（id=0），专辑真实存在
  //      —— 云端数据本身如此，写进去的是**该条目真实形状**，不是错配。
  const anyZero = [];
  const pureUgc = [];
  for (const d of decoded) {
    const s = lookup[d.meta.musicId];
    if (!s) continue;
    const zero = s.artists.filter((a) => Number(a[1]) === 0);
    const allZero = s.artists.length > 0 && s.artists.every((a) => Number(a[1]) === 0);
    const zeroAlbum = !s.album || !String(s.album).trim();
    const hashName = /#0/.test(String(s.name));
    const row = {
      file: d.file,
      musicId: d.meta.musicId,
      api: `${s.artists.map((a) => `${a[0]}(id=${a[1]})`).join('/')} - ${s.name} 《${s.album}》`,
      zeroArtists: zero.map((a) => a[0]),
      allZero,
      zeroAlbum,
      hashName,
    };
    if (zero.length) anyZero.push(row);
    if ((allZero && zeroAlbum) || hashName) pureUgc.push(row);
  }

  // ① 纯冒充 UGC —— 必须是 0，这是硬断言
  check(
    pureUgc.length === 0,
    'T1a（硬性）没有任何写入的 musicId 是「全 artist.id=0 且空专辑」的纯冒充 UGC 条目',
    pureUgc.length ? JSON.stringify(pureUgc, null, 1) : '',
  );

  // ② 任一 artist.id=0 —— 按任务书字面如实报告。
  //    注：该字面要求在复验轮（round 2）已由 Lead 明确作废，见 notes/verification.md「修复后复验」节。
  //    理由：「部分艺人 id=0」的真实含义是「该艺人在平台上没有认领账号」，不是「冒充条目」；
  //    真实曲库条目也会有这种情况（例如 pro/陈小满 的《心底的旧》）。
  //    判定标准改为 T1a（**所有** id 明确为 0 **且** 专辑名为空）。
  //    这里保留**统计口径**作为已知事实，但不再作为失败断言。
  info(`T1b（已知事实，非缺陷）反查结果里含 artist.id===0 的写入条目：${anyZero.length} 个`);
  for (const z of anyZero) {
    console.log(`   ${C.yellow}->${C.reset} ${z.file}  id=${z.musicId}`);
    console.log(`      ${z.api}`);
    console.log(`      id=0 的歌手: ${z.zeroArtists.join(', ')}；所有歌手全为0? ${z.allZero}；专辑为空? ${z.zeroAlbum}`);
    console.log(`      定性：混编条目（有真艺人 + 真实专辑），写的是该条目真实形状，不是把翻唱当原唱`);
  }
  check(
    anyZero.length <= 1,
    'T1b（统计口径保留）artist.id===0 的条目数量没有比复验前恶化（≤1）',
    `复验前 1 个，本轮 ${anyZero.length} 个`,
  );

  // 自检：证明判据有效——已知反例必须被 T1a 抓住
  let ref = lookup[2153879235];
  if (!ref) {
    const r = await fetch('https://music.163.com/api/song/detail/?ids=[2153879235]', { headers: { 'User-Agent': UA, Referer: 'https://music.163.com/' } });
    const j = await r.json();
    if (j.songs && j.songs[0]) {
      const x = j.songs[0];
      ref = { name: x.name, artists: (x.artists || []).map((a) => [a.name, a.id]), album: x.album ? x.album.name : null, albumId: x.album ? x.album.id : null, duration: x.duration };
      lookup[2153879235] = ref;
      await sleep(600);
    }
  }
  const refIsPureUgc =
    !!ref && ref.artists.length > 0 && ref.artists.every((a) => Number(a[1]) === 0) && !String(ref.album || '').trim();
  check(refIsPureUgc === true, 'T1a 自检：已知反例 2153879235 确实会被判为纯冒充 UGC（证明判据不是永远返回空）', ref ? `${ref.artists.map((a) => `${a[0]}(id=${a[1]})`).join('/')} 《${ref.album}》 ${ref.name}` : '无法拉取');
}

// ───────────────────────────────────────────────────────────────────────────
head('3. 陷阱 T2：时长/专辑错配（同曲多条目）');
// ───────────────────────────────────────────────────────────────────────────
{
  const DUR_TOL = 3000; // 本地 FLAC/MP3 与官方条目通常差 < 2s
  const rows = [];
  let bad = 0;
  for (const d of decoded) {
    const s = lookup[d.meta.musicId];
    if (!s) continue;
    const local = localMeta(path.join(BACKUP, d.file));
    const dLocal = local.durationMs;
    const dApi = s.duration;
    const delta = Number.isFinite(dLocal) && Number.isFinite(dApi) ? Math.abs(dApi - dLocal) : null;
    const durOk = delta != null && delta <= DUR_TOL;
    const albumOk = !!local.album && !!s.album && norm(local.album) === norm(s.album);
    rows.push({ file: d.file, musicId: d.meta.musicId, dLocal, dApi, delta, durOk, localAlbum: local.album, apiAlbum: s.album, albumOk, localTitle: local.title, apiName: s.name, localArtist: local.artist, apiArtists: s.artists });
    if (!durOk || !albumOk) bad++;
  }

  info('注意：专辑名不一致不必然是错误（同一首歌可收录在精选集里），仅作提示；时长是硬指标');

  // 时长：硬性判据
  const durBad = rows.filter((r) => !r.durOk);
  check(durBad.length === 0, `T2a: 所有 musicId 的官方时长与本地实测时长相差 ≤ ${DUR_TOL}ms`, durBad.map((r) => `${r.file}: 本地${r.dLocal} vs API${r.dApi} (Δ${r.delta})`).join(' | '));

  // 专辑：提示性
  const albBad = rows.filter((r) => !r.albumOk);
  if (albBad.length) {
    for (const r of albBad) info(`专辑不同（需人工判断是否精选集） ${r.file}`, `本地《${r.localAlbum}》 vs API《${r.apiAlbum}》`);
  }
  check(true, `T2b: 专辑一致性 ${rows.length - albBad.length}/${rows.length} 匹配（不一致项已逐条列出供人工判断）`);

  // 已知个案：简单爱必须是 186119《范特西》，不能是 5255440《K情歌2》
  const cj = decoded.find((d) => /简单爱/.test(d.file));
  if (cj) {
    const s = lookup[cj.meta.musicId];
    check(Number(cj.meta.musicId) === 186119, 'T2 个案：简单爱 写入 musicId 必须是 186119（《范特西》）', `实际 ${cj.meta.musicId}`);
    check(s && s.album === '范特西', 'T2 个案：简单爱 反查专辑必须是《范特西》', `实际《${s ? s.album : '?'}》`);
    // 反例：5255440 也查一下，确认它是另一个条目（证明判据能区分 Δ1ms 的陷阱）
    const r = await fetch('https://music.163.com/api/song/detail/?ids=[5255440]', { headers: { 'User-Agent': UA, Referer: 'https://music.163.com/' } });
    const j = await r.json();
    const alt = j.songs && j.songs[0];
    check(!!alt && alt.album && alt.album.name === 'K情歌2', 'T2 个案：反例 5255440 确实是《K情歌2》条目（证明存在真正的歧义，检查有效）', alt ? `《${alt.album.name}》 ${alt.duration}ms` : '拉取失败');
    if (alt) info('  两者时长差', `${alt.duration} - ${s.duration} = ${alt.duration - s.duration}ms（这就是任务书说的 Δ1ms 陷阱）`);
    await sleep(600);
  }
}

// ───────────────────────────────────────────────────────────────────────────
head('4. 歌名 / 歌手逐一核对（全部 52 个，不是抽查）');
// ───────────────────────────────────────────────────────────────────────────
{
  let titleBad = 0;
  let artistBad = 0;
  const problems = [];
  for (const d of decoded) {
    const s = lookup[d.meta.musicId];
    if (!s) continue;
    const local = localMeta(path.join(BACKUP, d.file));
    const tOk = norm(local.title) === norm(s.name);
    const a = artistSets(local.artist, s.artists);
    if (!tOk) titleBad++;
    if (!a.ok) artistBad++;
    if (!tOk || !a.ok) {
      problems.push({ file: d.file, musicId: d.meta.musicId, issue: [!tOk ? 'title' : null, !a.ok ? 'artist' : null].filter(Boolean).join('+'), local: `${local.artist} - ${local.title}`, api: `${s.artists.map((x) => x[0]).join('/')} - ${s.name}` });
    }
  }
  check(titleBad === 0, '所有文件的反查歌名与本地 TITLE 一致', titleBad ? `${titleBad} 个不一致` : '');
  check(artistBad === 0, '所有文件的反查歌手与本地 ARTIST 一致', artistBad ? `${artistBad} 个不一致` : '');
  for (const p of problems) console.log(`   ${C.red}->${C.reset} ${p.file} id=${p.musicId} [${p.issue}] 本地「${p.local}」 vs API「${p.api}」`);
}

// ───────────────────────────────────────────────────────────────────────────
head('5. 交叉校验：163key 里的字段 vs 反查回来的字段');
// ───────────────────────────────────────────────────────────────────────────
{
  let mismatch = 0;
  for (const d of decoded) {
    const s = lookup[d.meta.musicId];
    if (!s) continue;
    const m = d.meta;
    const probs = [];
    if (norm(m.musicName) !== norm(s.name)) probs.push(`musicName「${m.musicName}」≠ API「${s.name}」`);
    if (norm(m.album) !== norm(s.album)) probs.push(`album「${m.album}」≠ API「${s.album}」`);
    if (Number(m.albumId) !== Number(s.albumId)) probs.push(`albumId ${m.albumId} ≠ API ${s.albumId}`);
    if (Number(m.duration) !== Number(s.duration)) probs.push(`duration ${m.duration} ≠ API ${s.duration}`);
    const apiArt = s.artists.map((x) => norm(x[0])).join('/');
    const metaArt = (m.artist || []).map((x) => norm(Array.isArray(x) ? x[0] : x)).join('/');
    if (apiArt !== metaArt) probs.push(`artist [${metaArt}] ≠ API [${apiArt}]`);
    const apiArtIds = s.artists.map((x) => Number(x[1])).join(',');
    const metaArtIds = (m.artist || []).map((x) => Number(Array.isArray(x) ? x[1] : NaN)).join(',');
    if (apiArtIds !== metaArtIds) probs.push(`artist id [${metaArtIds}] ≠ API [${apiArtIds}]`);
    if (probs.length) {
      mismatch++;
      check(false, `${d.file} (id=${d.meta.musicId}) 的 163key 字段与 API 不一致`, probs.join('; '));
    }
  }
  check(mismatch === 0, '163key 内所有字段与反查结果完全自洽（musicName/album/albumId/duration/artist/id）', `${decoded.length - mismatch}/${decoded.length}`);
}

// ───────────────────────────────────────────────────────────────────────────
head('6. 报告：逐文件对照表（供人工复核）');
// ───────────────────────────────────────────────────────────────────────────
{
  const lines = [];
  lines.push('| 文件 | musicId | 本地(歌名/歌手/专辑/时长) | API(歌名/歌手/专辑/时长) | 判定 |');
  lines.push('|---|---|---|---|---|');
  for (const d of decoded.sort((a, b) => a.file.localeCompare(b.file, 'zh'))) {
    const s = lookup[d.meta.musicId] || {};
    const local = localMeta(path.join(BACKUP, d.file));
    const delta = Number.isFinite(local.durationMs) && Number.isFinite(s.duration) ? s.duration - local.durationMs : null;
    const durOk = delta != null && Math.abs(delta) <= 3000;
    const albOk = norm(local.album) === norm(s.album);
    lines.push(
      `| ${d.file} | ${d.meta.musicId} | ${local.title} / ${local.artist} / ${local.album} / ${local.durationMs} | ${s.name} / ${(s.artists || []).map((x) => x[0]).join('/')} / ${s.album} / ${s.duration} | ${durOk ? (albOk ? 'OK' : '专辑不同') : '时长不符!'} |`,
    );
  }
  const md = lines.join('\n');
  fs.writeFileSync(new URL('./artifacts/musicid-table.md', import.meta.url), md, 'utf8');
  fs.writeFileSync(new URL('./artifacts/id-lookup.json', import.meta.url), JSON.stringify(lookup, null, 2), 'utf8');
  info('对照表', 'verify/artifacts/musicid-table.md');
  console.log(md);
}

process.exitCode = summary('03-musicid-audit') ? 0 : 1;
