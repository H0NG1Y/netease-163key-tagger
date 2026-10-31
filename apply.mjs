#!/usr/bin/env node
/**
 * netease-163key-tagger CLI
 *
 *   node apply.mjs scan     [--root DIR] [--out FILE]
 *   node apply.mjs match    [--root DIR] [--report FILE] [--api MOD] [--sleep MS] [--limit N]
 *                           [--search-limit N] [--max-queries N]
 *   node apply.mjs apply    [--report FILE] [--review FILE] [--write] [--only SUBSTR] [--flac-field NAME]
 *   node apply.mjs verify   [--root DIR] [--report FILE] [--out FILE]
 *   node apply.mjs self-test
 *
 * 安全默认：apply 不带 --write 就是 dry-run；--root 指向 E:\CloudMusic 会被硬拒绝。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { build163Key, parse163Key, TAG_PREFIX } from './lib/163key.mjs';
import { readTags, write163Key, detectFormat, parseId3v2, parseFlac, isProtected, PROTECTED_ROOTS, addProtectedRoot } from './lib/tags.mjs';
import { parseFilename, pickBest, DURATION_TOLERANCE_MS } from './lib/match.mjs';
import { systemMusicDir } from './lib/paths.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// exe 态：源码被释放到临时目录，配置与产物必须落在用户数据目录，
// 否则临时文件一被清理，匹配报告就没了。源码态 DATA 就是项目根。
const DATA = process.env.NETEASE_163KEY_DATA || HERE;
const NODE = process.execPath;

// 命令行与 Web 端共用同一份本机配置，避免两边指到不同目录。
function readLocalConfig() {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA, '.config.json'), 'utf8'));
  } catch {
    return {};
  }
}
const LOCAL_CFG = readLocalConfig();
// 默认音乐目录 = 系统自带的音乐文件夹（%USERPROFILE%\Music），省得用户手打路径。
const DEFAULT_ROOT = process.env.NETEASE_163KEY_ROOT || LOCAL_CFG.root || systemMusicDir();
// 配置里点名的只读目录一律先上锁再干活。
for (const d of LOCAL_CFG.protect || []) if (d) addProtectedRoot(d);

const AUDIO_RE = /\.(mp3|flac)$/i;
const OUT = path.join(DATA, 'out');

// ── 杂项 ─────────────────────────────────────────────────────

function parseArgs(argv) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) flags[k] = true;
      else {
        flags[k] = next;
        i++;
      }
    } else rest.push(a);
  }
  return { cmd: rest[0], args: rest.slice(1), flags };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const md5 = (b) => crypto.createHash('md5').update(b).digest('hex');
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const mb = (n) => (n / 1048576).toFixed(2) + 'MB';

function listAudio(root) {
  const out = [];
  const walk = (dir) => {
    let ents;
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (AUDIO_RE.test(e.name)) out.push(p);
    }
  };
  walk(root);
  return out.sort();
}

function readJsonIf(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}
function writeJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
}

function resolveRoot(flags) {
  const raw = String(flags.root || DEFAULT_ROOT || '');
  if (!raw) {
    throw new Error(
      '没有指定音乐目录。用 --root "D:\\你的\\音乐目录"，\n' +
        '或者在配置目录建 .config.json 写上 {"root": "..."}（Web 界面会自动帮你写）。',
    );
  }
  const root = path.resolve(raw);
  if (isProtected(root)) {
    throw new Error(`--root 指向了只读保护目录：${root}\n这个目录被登记为只读（原始素材），工具不会往里写。`);
  }
  return root;
}

/**
 * 音频区指纹：跳过标签，只算音频字节的 md5。
 * verify 把它记进结果 JSON——没有「备份副本」可比的年代，它让用户能自己留档、
 * 隔一段时间再跑一次对比（音频区变了哈希就会变）。
 */
function audioFingerprint(file) {
  const buf = fs.readFileSync(file);
  const fmt = detectFormat(file, buf);
  let off = 0;
  if (fmt === 'mp3') {
    const id3 = parseId3v2(buf);
    off = id3 ? id3.total : 0;
  } else if (fmt === 'flac') {
    const f = parseFlac(buf);
    off = f ? f.audioOffset : 0;
  }
  return { fmt, off, audioMd5: md5(buf.subarray(off)), size: buf.length };
}

async function loadApi(apiPath) {
  const p = apiPath ? path.resolve(String(apiPath)) : path.join(HERE, 'lib', 'netease-api.mjs');
  if (!fs.existsSync(p)) {
    throw new Error(
      `找不到 API 模块 ${p}\n` +
        `说明：netEase API 客户端由 teammate api-probe 交付到 lib/netease-api.mjs。\n` +
        `如果想在没有网络/没有该模块时验证流水线，可以用桩：--api test/stub-api.mjs`,
    );
  }
  const mod = await import(new URL(`file://${p.replace(/\\/g, '/')}`).href);
  for (const fn of ['searchSong', 'getSongDetail', 'to163Meta']) {
    if (typeof mod[fn] !== 'function') throw new Error(`API 模块 ${p} 缺少导出函数 ${fn}()`);
  }
  return mod;
}

/**
 * 编码前的硬校验。这些字段缺任何一个，写出来的 163key 在客户端眼里都是废的。
 * 特别注意 NaN：JSON.stringify(NaN) 会静默变成 null，不在这儿拦住就会写出空 musicId 的 key
 * （lib/netease-api.mjs 的 to163Meta 曾经在字段路径取错时返回 musicId=NaN，就是这么被漏过去的）。
 */
function validateMeta(meta, rec) {
  const errors = [];
  const warnings = [];
  const musicId = Number(meta?.musicId);
  if (!Number.isInteger(musicId) || musicId <= 0) {
    errors.push(`musicId 非法: ${JSON.stringify(meta?.musicId)} (typeof ${typeof meta?.musicId}, isNaN ${Number.isNaN(meta?.musicId)})`);
  }
  if (!meta?.musicName || !String(meta.musicName).trim()) errors.push('musicName 为空');
  if (!Array.isArray(meta?.artist) || !meta.artist.length) errors.push('artist 为空');
  const dur = Number(meta?.duration);
  if (!Number.isFinite(dur) || dur <= 0) errors.push(`duration 非法: ${JSON.stringify(meta?.duration)}`);
  else if (dur > 6 * 3600 * 1000) warnings.push(`duration 可疑地大: ${dur}`);
  if (meta?.format !== rec.format) errors.push(`format ${JSON.stringify(meta?.format)} != 实际容器 ${rec.format}`);
  if (!Number.isInteger(Number(meta?.albumId)) || Number(meta.albumId) <= 0) warnings.push('albumId 为空或 0');
  if (!meta?.album || !String(meta.album).trim()) warnings.push('album 为空');
  if (!meta?.mp3DocId || !String(meta.mp3DocId).trim()) warnings.push('mp3DocId 为空');
  else if (!/^[0-9a-f]{32}$/i.test(String(meta.mp3DocId))) warnings.push(`mp3DocId 不是 32 位 hex: ${meta.mp3DocId}`);
  if (!meta?.albumPicDocId || !String(meta.albumPicDocId).trim()) warnings.push('albumPicDocId 为空');
  if (!meta?.albumPic || !String(meta.albumPic).trim()) warnings.push('albumPic 为空');
  return { errors, warnings };
}

// ── scan ─────────────────────────────────────────────────────

function cmdScan(flags) {
  const root = resolveRoot(flags);
  const files = listAudio(root);
  const records = [];
  const fmtCount = {};
  const t0 = Date.now();
  emit('start', { op: 'scan', root, total: files.length });
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const st = fs.statSync(f);
    const t = readTags(f);
    const parsed = parseFilename(f);
    fmtCount[t.format] = (fmtCount[t.format] || 0) + 1;
    records.push({
      file: path.relative(root, f),
      abs: f,
      size: st.size,
      mtime: st.mtime.toISOString(),
      format: t.format,
      title: t.title,
      artist: t.artist,
      album: t.album,
      durationMs: t.durationMs,
      bitrate: t.bitrate ?? null,
      key163: t.key163,
      hasKey: !!t.key163,
      frames: t.frames || undefined,
      parsed,
    });
    emit('progress', { op: 'scan', done: i + 1, total: files.length, file: path.relative(root, f) });
  }
  const outFile = path.resolve(String(flags.out || path.join(OUT, 'scan.json')));
  writeJson(outFile, { root, generatedAt: new Date().toISOString(), count: records.length, fmtCount, records });
  emit('done', { op: 'scan', total: records.length, fmtCount, withKey: records.filter((r) => r.hasKey).length, out: outFile, ms: Date.now() - t0 });
  console.log(`扫描 ${root}`);
  console.log(`  ${records.length} 个音频文件  格式分布 ${JSON.stringify(fmtCount)}  用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(`  已带 163key: ${records.filter((r) => r.hasKey).length}`);
  console.log(`  -> ${outFile}`);
  for (const r of records) {
    console.log(`    [${r.format}] ${r.artist ?? '?'} - ${r.title ?? '?'}   (${mb(r.size)}, ${r.durationMs ? (r.durationMs / 1000).toFixed(1) + 's' : '时长未知'})${r.hasKey ? '  *已有key' : ''}`);
  }
  return records;
}

// ── match ────────────────────────────────────────────────────

const dedupeById = (arr) => {
  const m = new Map();
  for (const c of arr) if (c && c.id != null && !m.has(c.id)) m.set(c.id, c);
  return [...m.values()];
};

async function cmdMatch(flags) {
  const root = resolveRoot(flags);
  const api = await loadApi(flags.api);
  const scanFile = path.resolve(String(flags.scan || path.join(OUT, 'scan.json')));
  let scan = readJsonIf(scanFile);
  if (!scan || scan.root !== root) {
    console.log('（没有匹配的 scan.json，先跑一次 scan）');
    const records = cmdScan({ ...flags, root });
    scan = { root, records };
  }
  const cacheFile = path.resolve(String(flags.cache || path.join(OUT, 'api-cache.json')));
  const cache = readJsonIf(cacheFile) || {};
  const sleepMs = Number(flags.sleep ?? 350);
  const limit = flags.limit ? Number(flags.limit) : Infinity;
  // 搜索深度：匿名搜索对「歌名 + 歌手」会把翻唱 / type-beat 等 UGC 排在最前，
  // 授权曲库里的原唱要几十条之后才出现（实测「简单爱 周杰伦」的真·周杰伦首次出现在
  // 第 21~100 条，前 20 条全是翻唱）。只取 10 条永远看不到原唱，所以默认拉满 100 条。
  const searchLimit = Math.max(1, Math.min(100, Number(flags['search-limit'] ?? 100) || 100));
  const maxQueries = Math.max(1, Number(flags['max-queries'] ?? 2) || 2);

  const records = [];
  let done = 0;
  const t0 = Date.now();
  const budget = Math.min(limit, scan.records.length);
  emit('start', { op: 'match', root: scan.root, total: budget, searchLimit, maxQueries });
  for (const rec of scan.records) {
    if (done >= limit) break;
    done++;
    emit('progress', { op: 'match', done: done - 1, total: budget, file: rec.file, phase: 'search' });
    const parsed = rec.parsed;
    const opts = { localDurationMs: rec.durationMs, localAlbum: rec.album, localArtists: parsed.artists };
    let pool = [];
    const triedQueries = [];
    let pre = { confidence: 'low', best: null, auto: false };

    for (const q of parsed.queries) {
      const ck = `search:${searchLimit}:${q}`;
      let hits = cache[ck];
      if (!hits) {
        try {
          hits = await api.searchSong({ keyword: q, limit: searchLimit });
        } catch (e) {
          hits = [];
          cache[ck] = { __error: String(e.message || e) };
        }
        if (!cache[ck]) cache[ck] = hits;
        writeJson(cacheFile, cache);
        await sleep(sleepMs);
      } else if (hits && hits.__error) {
        hits = [];
      }
      triedQueries.push({ q, n: Array.isArray(hits) ? hits.length : 0 });
      if (Array.isArray(hits)) pool.push(...hits);
      pool = dedupeById(pool);
      pre = pickBest(pool, parsed, opts);
      // 收手条件：拿到「时长也对得上」的自动候选才停。只看歌名/歌手是不够的——
      // 翻唱的歌名歌手常常和原唱一字不差，必须等时长闸门给出结论；而反过来，
      // 池子没铺够时第二名又可能只是没被搜到的原唱，所以要允许再补一个查询。
      if (pre.auto) break;
      if (triedQueries.length >= maxQueries) break;
    }

    let meta = null;
    let detailErr = null;
    const best = pre.best;
    if (best) {
      const dk = `detail:${best.id}`;
      let detail = cache[dk];
      if (!detail) {
        try {
          detail = await api.getSongDetail(best.id);
          cache[dk] = detail;
          writeJson(cacheFile, cache);
          await sleep(sleepMs);
        } catch (e) {
          detailErr = String(e.message || e);
          detail = null;
        }
      }
      if (detail && !detail.__error) {
        try {
          meta = api.to163Meta(detail, {
            format: rec.format,
            localDurationMs: rec.durationMs,
            // 163key 里的 bitrate 必须是这个文件的实际码率：FLAC 无损是 800k~1800k，
            // MP3 可能是 128k/192k/320k。一律写接口给的 320000 是错的（实测 46/52 错）。
            bitrate: rec.bitrate ?? undefined,
          });
        } catch (e) {
          detailErr = `to163Meta: ${e.message}`;
        }
      }
    }

    let key163 = null;
    let keyErr = null;
    let metaWarnings = [];
    if (meta) {
      const v = validateMeta(meta, rec);
      metaWarnings = v.warnings;
      if (v.errors.length) {
        keyErr = `元数据不合格: ${v.errors.join('; ')}`;
      } else {
        try {
          key163 = build163Key(meta);
          // 自校验：生成的东西必须能原样解回来
          const back = parse163Key(key163);
          if (!back || back.musicId !== meta.musicId) {
            throw new Error(
              `编码/解码自校验失败 (meta.musicId=${JSON.stringify(meta.musicId)} back.musicId=${JSON.stringify(back?.musicId)})`,
            );
          }
        } catch (e) {
          keyErr = String(e.message || e);
          key163 = null;
        }
      }
    }

    records.push({
      file: rec.file,
      format: rec.format,
      localTitle: rec.title,
      localArtist: rec.artist,
      localAlbum: rec.album,
      localDurationMs: rec.durationMs,
      parsed: { title: parsed.title, artist: parsed.artist, artists: parsed.artists, feat: parsed.feat },
      queries: triedQueries,
      candidateCount: pool.length,
      top: pre.ranked.slice(0, 5).map((c) => ({
        id: c.id,
        name: c.name,
        artists: (c.artists || []).map((a) => a.name),
        album: c.album?.name ?? null,
        durationMs: c.durationMs ?? null,
        score: Number(c.score.toFixed(4)),
        parts: c.parts,
      })),
      best: best
        ? { id: best.id, name: best.name, artists: best.artists, album: best.album, durationMs: best.durationMs, score: Number(best.score.toFixed(4)) }
        : null,
      confidence: pre.confidence,
      ambiguous: !!pre.ambiguous,
      auto: !!pre.auto,
      durationDeltaMs: pre.durationDeltaMs ?? null,
      durationMismatch: !!pre.durationMismatch,
      ugc: !!pre.ugc,
      meta,
      key163,
      keyLength: key163 ? key163.length : 0,
      warnings: metaWarnings,
      error: keyErr || detailErr || null,
    });
    const flag = pre.ugc ? 'UGC!' : pre.durationMismatch ? 'DUR!' : pre.auto ? 'AUTO' : pre.confidence === 'medium' ? 'REVIEW' : 'LOW';
    const dTxt = pre.durationDeltaMs != null ? `, Δ${(pre.durationDeltaMs / 1000).toFixed(1)}s` : '';
    emit('progress', {
      op: 'match',
      done,
      total: budget,
      file: rec.file,
      flag,
      confidence: pre.confidence,
      auto: !!pre.auto,
      scored: !!key163,
      bestId: best?.id ?? null,
      bestName: best?.name ?? null,
      bestArtists: best ? (best.artists || []).map((a) => a.name) : null,
      score: best ? Number(best.score.toFixed(3)) : null,
      durationDeltaMs: pre.durationDeltaMs ?? null,
      error: keyErr || detailErr || null,
    });
    console.log(
      `  [${flag}] ${rec.file}\n` +
        `         本地: ${rec.artist ?? '?'} - ${rec.title ?? '?'}\n` +
        `         命中: ${best ? `${(best.artists || []).map((a) => a.name).join('/')} - ${best.name} (id=${best.id}, score=${best.score.toFixed(3)}, ${pre.confidence}${dTxt})` : '(无候选)'}` +
        (keyErr ? `\n         错误: ${keyErr}` : ''),
    );
  }

  const auto = records.filter((r) => r.auto && r.key163);
  const review = records.filter((r) => !r.auto || !r.key163);
  const reportFile = path.resolve(String(flags.report || path.join(OUT, 'matches.json')));
  writeJson(reportFile, {
    root,
    generatedAt: new Date().toISOString(),
    total: records.length,
    auto: auto.length,
    review: review.length,
    records,
  });
  const reviewFile = path.resolve(String(flags.review || path.join(OUT, 'review.json')));
  writeJson(reviewFile, { root, generatedAt: new Date().toISOString(), records: review });
  emit('done', { op: 'match', total: records.length, auto: auto.length, review: review.length, report: reportFile, reviewFile, ms: Date.now() - t0 });

  const keyFailed = records.filter((r) => r.error);
  if (keyFailed.length) {
    const seen = new Map();
    for (const r of keyFailed) {
      const k = String(r.error).replace(/\(.*?\)/g, '(...)');
      seen.set(k, (seen.get(k) || 0) + 1);
    }
    console.log(`\n  ⚠️ ${keyFailed.length} 个文件没能生成 163key：`);
    for (const [msg, n] of [...seen].sort((a, b) => b[1] - a[1])) console.log(`     ×${n}  ${msg}`);
  }
  const warnAll = new Map();
  for (const r of records) for (const w of r.warnings || []) warnAll.set(w, (warnAll.get(w) || 0) + 1);
  if (warnAll.size) {
    console.log(`  ℹ️ 字段警告（不阻断写入）：`);
    for (const [msg, n] of [...warnAll].sort((a, b) => b[1] - a[1]).slice(0, 10)) console.log(`     ×${n}  ${msg}`);
  }

  console.log(
    `\n匹配完成：${records.length} 个文件，可自动应用 ${auto.length}，需人工复核 ${review.length}，用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`,
  );
  console.log(`  -> ${reportFile}\n  -> ${reviewFile}`);
  return records;
}

// ── apply ────────────────────────────────────────────────────

/** 封面下载缓存：同一张图在多个文件间复用，避免重复请求 */
const coverCache = new Map();

/**
 * 把 163key 里的 meta 转成「写入文件标签用」的补丁。
 * 只取用户看得见的字段：标题/歌手/专辑/专辑艺人/封面。
 * 封面失败不影响主流程，只是这一项被跳过。
 */
async function buildMetaPatch(rec, { downloadCover = false } = {}) {
  const m = rec.meta;
  if (!m) return null;
  const artists = Array.isArray(m.artist) ? m.artist.map((a) => (Array.isArray(a) ? a[0] : a)).filter(Boolean) : [];
  const patch = {
    title: m.musicName || null,
    artist: artists.length ? artists.join('/') : null,
    album: m.album || null,
    albumArtist: artists.length ? artists[0] : null,
  };
  if (downloadCover && m.albumPic) {
    try {
      let bytes = coverCache.get(m.albumPic);
      if (!bytes) {
        const ctl = AbortSignal.timeout(15000);
        const res = await fetch(m.albumPic, { signal: ctl, headers: { 'User-Agent': 'Mozilla/5.0' } });
        if (res.ok) {
          const buf = Buffer.from(await res.arrayBuffer());
          if (buf.length > 0 && buf.length < 8 * 1024 * 1024) {
            bytes = { bytes: buf, mime: guessCoverMime(buf) };
            coverCache.set(m.albumPic, bytes);
          }
        }
      }
      if (bytes) patch.cover = bytes;
    } catch {
      /* 封面拿不到就算了，文字标签照写 */
    }
  }
  return patch;
}

/** 按文件头判断图片格式，不信 URL 后缀（网易云图片经常没有扩展名） */
function guessCoverMime(buf) {
  if (buf.length > 8) {
    if (buf[0] === 0x89 && buf[1] === 0x50) return 'image/png';
    if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
    if (buf.slice(0, 4).toString('latin1') === 'RIFF') return 'image/webp';
  }
  return 'image/jpeg';
}

async function cmdApply(flags) {
  const reportFile = path.resolve(String(flags.report || path.join(OUT, 'matches.json')));
  const report = readJsonIf(reportFile);
  if (!report) throw new Error(`找不到匹配报告 ${reportFile}，先跑 node apply.mjs match`);
  const write = !!flags.write;
  const only = flags.only ? String(flags.only) : null;
  const flacField = flags['flac-field'] ? String(flags['flac-field']) : undefined;
  const flacCommentCopy = !flags['no-flac-comment-copy'];
  const includeReview = !!flags['include-review'] || !!flags.all;
  const includeAll = !!flags.all;
  // 是否顺带改写用户可见的元数据（标题/歌手/专辑/封面）。
  // 默认关：写标签命中率再高，改标题也是一件「会改变你看到的文件名以外的东西」的操作，
  // 必须显式 opt-in。--meta 开文字，--cover 再加封面（封面要联网下载）。
  const wantMeta = !!flags.meta || !!flags.cover;
  const downloadCover = !!flags.cover;

  const results = [];
  let applied = 0;
  const pushResult = (r) => {
    results.push(r);
    emit('progress', { op: 'apply', done: results.length, total: report.records.length, status: r.status, file: r.file, confidence: r.confidence ?? null });
  };
  emit('start', { op: 'apply', root: report.root, total: report.records.length, write });
  for (const rec of report.records) {
    if (only && !rec.file.includes(only)) continue;
    if (!rec.key163) {
      pushResult({ file: rec.file, status: 'skip:no-key', confidence: rec.confidence });
      continue;
    }
    // 用户在复核界面显式选定过候选（rec.manual）：以人的判断为准，绕过自动判据直接写。
    // key163 已在 /api/choose 时按该候选重新生成并写回报告，这里只负责放行。
    const isManual = !!(rec.manual && rec.manual.id);
    // 时长闸门：命中候选的时长和本地实测差太多，说明匹配到了伴奏 / remix / 合辑版，
    // 写进去的 musicId 就是错的。这一条优先于置信度，--all 是人工核对后的兜底出口。
    const dLocal = rec.localDurationMs;
    const dApi = rec.best?.durationMs;
    const delta = Number.isFinite(dLocal) && Number.isFinite(dApi) ? Math.abs(dApi - dLocal) : rec.durationDeltaMs ?? null;
    if (!isManual && (rec.durationMismatch || (delta != null && delta > DURATION_TOLERANCE_MS)) && !includeAll) {
      pushResult({ file: rec.file, status: 'skip:duration-mismatch', confidence: rec.confidence, durationDeltaMs: delta });
      continue;
    }
    // UGC 冒充条目：艺人 id 全 0 且没有专辑名。宁可漏写也不能写错——把翻唱的
    // musicId 写进原唱文件，客户端会显示成完全不相干的歌。--all 才能绕过。
    if (!isManual && rec.ugc && !includeAll) {
      pushResult({ file: rec.file, status: 'skip:ugc-candidate', confidence: rec.confidence });
      continue;
    }
    // 默认只写高置信度（auto）的记录；其余必须显式放行，避免把错误匹配写进文件
    const lvl = rec.auto ? 'auto' : rec.confidence === 'medium' ? 'medium' : 'low';
    if (!isManual && lvl === 'medium' && !includeReview) {
      pushResult({ file: rec.file, status: 'skip:needs-review', confidence: rec.confidence });
      continue;
    }
    if (!isManual && lvl === 'low' && !includeAll) {
      pushResult({ file: rec.file, status: 'skip:low-confidence', confidence: rec.confidence });
      continue;
    }
    const target = path.join(report.root, rec.file);
    let r;
    try {
      const patch = wantMeta ? await buildMetaPatch(rec, { downloadCover }) : null;
      r = write163Key(target, rec.key163, { dryRun: !write, flacField, flacCommentCopy, meta: patch });
      if (write) applied++;
      pushResult({ file: rec.file, status: r.changed ? (write ? `written:${r.strategy}` : `dryrun:${r.strategy}`) : 'noop', confidence: rec.confidence, durationDeltaMs: delta });
    } catch (e) {
      pushResult({ file: rec.file, status: `error:${e.message}`, confidence: rec.confidence });
    }
  }
  const logFile = path.resolve(String(flags.log || path.join(OUT, write ? 'apply.log.json' : 'dryrun.log.json')));
  writeJson(logFile, { root: report.root, write, when: new Date().toISOString(), results });
  const tally = {};
  for (const r of results) tally[r.status] = (tally[r.status] || 0) + 1;
  emit('done', { op: 'apply', write, applied, total: results.length, tally, log: logFile });
  console.log(`${write ? '【实际写入】' : '【dry-run，未落盘】'} ${report.root}`);
  console.log(`  ${JSON.stringify(tally)}`);
  const skipped = results.filter(
    (r) =>
      r.status === 'skip:needs-review' ||
      r.status === 'skip:low-confidence' ||
      r.status === 'skip:duration-mismatch' ||
      r.status === 'skip:ugc-candidate',
  );
  if (skipped.length) {
    console.log(`  跳过 ${skipped.length} 个未达自动标准的记录：用 --include-review 放行中等置信度，--all 全部放行`);
    for (const s of skipped.slice(0, 20)) {
      const extra = s.durationDeltaMs != null && s.status === 'skip:duration-mismatch' ? `（时长差 ${(s.durationDeltaMs / 1000).toFixed(1)}s）` : '';
      console.log(`     - [${s.status.replace('skip:', '')}] ${s.file}${extra}`);
    }
  }
  const durMismatch = results.filter((r) => r.status === 'skip:duration-mismatch');
  if (durMismatch.length) {
    console.log(
      `  ⚠️ 其中 ${durMismatch.length} 个是「歌名/歌手对得上但时长对不上」，多半命中了伴奏 / remix / 合辑版，\n` +
        `     musicId 很可能是错的。--all 可以强行写入，但请先人工核对。`,
    );
  }
  const ugcSkipped = results.filter((r) => r.status === 'skip:ugc-candidate');
  if (ugcSkipped.length) {
    console.log(
      `  ⚠️ 其中 ${ugcSkipped.length} 个命中的是「艺人 id 全 0 且无专辑」的 UGC 冒充条目\n` +
        `     （匿名搜索会把这类翻唱排在原唱前面）。--all 可以强行写入，但基本可以确定是错的。`,
    );
  }
  if (!write) console.log('  加 --write 才会真正写盘。');
  console.log(`  -> ${logFile}`);
  return results;
}

// ── verify ───────────────────────────────────────────────────

function cmdVerify(flags) {
  const root = resolveRoot(flags);
  const report = readJsonIf(path.resolve(String(flags.report || path.join(OUT, 'matches.json'))));
  const expect = new Map((report?.records || []).map((r) => [r.file, r]));
  const files = listAudio(root);

  let durOk = 0;
  const problems = [];
  const perFile = [];
  for (const f of files) {
    const rel = path.relative(root, f);
    const t = readTags(f);
    const exp = expect.get(rel);
    const row = { file: rel, format: t.format, hasKey: !!t.key163 };

    // 「没有 163key」只有两种情况才算问题：
    //   ① 报告里根本没有这条记录（来源不明）；
    //   ② 报告说它该被自动写入（auto 且有 key163）却没写上。
    // 报告里明确标为需人工复核 / 时长不符 / UGC 的，本来就不该被写，
    // 不能算故障——否则每次跑 verify 都会被这批策略性跳过刷屏，真问题被淹掉。
    const expectWritten = !!exp?.key163 && (!!exp?.auto || !!exp?.manual);

    if (!t.key163) {
      row.expected = expectWritten ? 'should-have-key' : exp?.key163 ? 'intentionally-skipped' : 'no-record';
      if (!exp) problems.push(`${rel}: 没有 163key，且报告里没有这条记录`);
      else if (expectWritten) problems.push(`${rel}: 报告标记为自动写入，但文件里没有 163key`);
      else row.skippedIntentional = true;
    } else {
      const meta = parse163Key(t.key163);
      row.musicId = meta?.musicId ?? null;
      row.musicName = meta?.musicName ?? null;
      if (!meta) problems.push(`${rel}: 163key 解不开`);
      // 重编码必须逐字节一致
      try {
        if (build163Key(meta) !== t.key163) problems.push(`${rel}: 163key 重编码不一致`);
      } catch (e) {
        problems.push(`${rel}: 重编码异常 ${e.message}`);
      }
      if (exp) {
        if (exp.key163 && exp.key163 !== t.key163) problems.push(`${rel}: 与报告中的 key 不一致`);
        if (meta && exp.best && meta.musicId !== exp.best.id) problems.push(`${rel}: musicId ${meta.musicId} != 报告命中 ${exp.best.id}`);
        if (meta && meta.format !== t.format) problems.push(`${rel}: format 字段 ${meta.format} != 实际 ${t.format}`);
      }
    }

    // 音频区自洽检查（不再需要一份「备份副本」）：
    //   标签写在音频流之外，所以只要能重新解析出音频头、且时长与扫描时一致，
    //   就说明这次写入没碰过音频区。时长变了 = 音频头被动过，必须报出来。
    const expDur = exp?.localDurationMs;
    row.audioDurationMs = t.durationMs ?? null;
    if (Number.isFinite(expDur) && expDur > 0 && Number.isFinite(t.durationMs) && t.durationMs > 0) {
      row.expectedDurationMs = expDur;
      if (Math.abs(t.durationMs - expDur) > 1) {
        problems.push(`${rel}: 音频时长 ${t.durationMs}ms 与扫描时 ${expDur}ms 不一致（音频区可能被破坏）`);
      } else {
        durOk++;
      }
    } else {
      row.audioDurationUnchecked = true;
    }
    // 顺便留下音频区指纹，方便用户自己隔期比对
    try {
      const fp = audioFingerprint(f);
      row.audioMd5 = fp.audioMd5;
      row.audioBytes = fp.size - fp.off;
    } catch {
      /* 指纹算不出来不影响判定 */
    }
    perFile.push(row);
  }

  const outFile = path.resolve(String(flags.out || path.join(OUT, 'verify.json')));
  const intentional = perFile.filter((r) => r.skippedIntentional);
  writeJson(outFile, {
    root,
    when: new Date().toISOString(),
    files: perFile.length,
    problems,
    // 覆盖率必须机器可读：只报 files/problems 会让自动化以为「没有 problem 就是全写好了」，
    // 实际上可能是 53/57。这里把清单和计数都落盘。
    counts: {
      files: perFile.length,
      withKey: perFile.filter((r) => r.hasKey).length,
      skippedIntentional: intentional.length,
      audioDurationVerified: durOk,
      problems: problems.length,
    },
    skipped: intentional.map((r) => ({ file: r.file, format: r.format, reason: r.expected })),
    perFile,
  });
  console.log(`校验 ${root}`);
  console.log(`  文件 ${perFile.length}，音频时长与扫描时一致 ${durOk}`);
  console.log(`  带 163key: ${perFile.filter((r) => r.hasKey).length}，按策略有意未写: ${intentional.length}`);
  if (problems.length) {
    console.log(`  ❌ ${problems.length} 个问题：`);
    for (const p of problems.slice(0, 40)) console.log(`     - ${p}`);
  } else {
    console.log('  ✅ 无问题');
  }
  console.log(`  -> ${outFile}`);
  emit('done', { op: 'verify', out: outFile, counts: { files: perFile.length, withKey: perFile.filter((r) => r.hasKey).length, skippedIntentional: intentional.length, audioDurationVerified: durOk, problems: problems.length }, problems: problems.slice(0, 40) });
  return problems.length;
}

// ── self-test ────────────────────────────────────────────────

function cmdSelfTest() {
  let bad = 0;
  let ran = 0;
  for (const t of ['test/tags.selftest.mjs', 'test/match.selftest.mjs', 'test/meta.selftest.mjs', 'test/e2e.mjs']) {
    const p = path.join(HERE, t);
    if (!fs.existsSync(p)) {
      console.log(`  (跳过，不存在) ${t}`);
      continue;
    }
    console.log(`\n=== ${t} ===`);
    const r = spawnSync(NODE, [p], { stdio: 'inherit', cwd: HERE });
    ran++;
    if (r.status !== 0) bad++;
  }
  if (ran === 0) {
    // 单文件版（SEA）只打包运行时资源，不含 test/ —— 这些套件还依赖
    // test/e2e/src 里的音频样本，塞进 exe 得不偿失。这里必须说清楚，
    // 不能把「一个套件都没跑」渲染成「全部通过」。
    console.log('\n没有可运行的测试套件。');
    console.log('单文件版不含 test/（套件需要 test/e2e/src 里的音频样本），这是正常现象；');
    console.log('要跑完整自测请在源码目录执行： node apply.mjs self-test');
    return 0;
  }
  console.log(bad ? `\n自测失败：${bad} 个套件不通过` : `\n自测全部通过（${ran} 个套件）`);
  return bad;
}

// ── 进度事件（给 Web / 桌面前端的结构化进度）──────────────────
// `--progress <file>` 时把事件以 JSONL 追加写入该文件，前端 tail 它渲染进度条。
// 刻意不走 stdout：中文输出、颜色、子进程管道缓冲都会让解析变得脆弱。
let PROGRESS_FILE = null;
function emit(kind, data = {}) {
  if (!PROGRESS_FILE) return;
  try {
    fs.appendFileSync(PROGRESS_FILE, `${JSON.stringify({ t: Date.now(), kind, ...data })}\n`);
  } catch {
    /* 进度上报失败绝不影响主流程 */
  }
}

// ── main ─────────────────────────────────────────────────────

const { cmd, flags } = parseArgs(process.argv.slice(2));
// 环境变量追加只读保护目录（多个用系统路径分隔符隔开）。Web 端用它把用户在
// 配置里点名的只读目录锁死，保证任何参数组合下都不会往里写。
if (process.env.NETEASE_163KEY_PROTECT) {
  for (const d of String(process.env.NETEASE_163KEY_PROTECT).split(path.delimiter)) {
    if (d.trim()) addProtectedRoot(d.trim());
  }
}
if (flags.progress) {
  PROGRESS_FILE = path.resolve(String(flags.progress));
  try {
    fs.mkdirSync(path.dirname(PROGRESS_FILE), { recursive: true });
    fs.writeFileSync(PROGRESS_FILE, '');
  } catch {
    PROGRESS_FILE = null;
  }
}
const USAGE = `netease-163key-tagger

  node apply.mjs scan     [--root DIR] [--out FILE]
  node apply.mjs match    [--root DIR] [--report FILE] [--review FILE] [--api MOD] [--sleep MS] [--limit N]
                          [--search-limit N] [--max-queries N]
  node apply.mjs apply    [--report FILE] [--write] [--only SUBSTR] [--flac-field NAME]
                          [--no-flac-comment-copy] [--include-review] [--all]
                          [--meta] [--cover]
  node apply.mjs verify   [--root DIR] [--report FILE] [--out FILE]
  node apply.mjs self-test

默认 root = ${DEFAULT_ROOT}（系统音乐文件夹 %USERPROFILE%\\Music，可在设置里改）
verify 不再需要备份副本：它校验每个文件的 163key 自洽性，并用「音频时长与扫描时一致」
来证明音频区没被这次写入动过。
apply 默认只写「高置信度自动匹配」的记录；--include-review 放行中等置信度，--all 放行全部。
match 默认每个查询拉 --search-limit 条（默认 100）——匿名搜索里翻唱会挤满前 20 条，
原唱在更深的位置；每个文件最多试 --max-queries 个查询（默认 2），拿到时长自洽的自动候选就收手。`;

// 入口分发。
// 用 async IIFE 包住、不在模块顶层 await：顶层 await 会让本文件成为
// 「异步 ESM 图」，node 的 require(esm) 会直接拒绝加载
// （ERR_REQUIRE_ASYNC_MODULE），而 SEA 单文件版启动器正是靠
// createRequire 从释放目录里加载本文件的。
// 返回值导出成 `done`：require() 是同步的，启动器拿到命名空间后
// `await done` 才能真正等这次命令跑完（否则异步命令可能被提前退出）。
export const done = (async () => {
  try {
    switch (cmd) {
      case 'scan':
        cmdScan(flags);
        break;
      case 'match':
        await cmdMatch(flags);
        break;
      case 'apply':
        await cmdApply(flags);
        break;
      case 'verify':
        process.exitCode = cmdVerify(flags) ? 1 : 0;
        break;
      case 'self-test':
        process.exitCode = cmdSelfTest() ? 1 : 0;
        break;
      default:
        console.log(USAGE);
        process.exitCode = cmd ? 2 : 0;
    }
  } catch (e) {
    console.error(`错误：${e.message}`);
    process.exitCode = 1;
  }
})();
