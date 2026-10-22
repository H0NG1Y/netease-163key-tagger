// Probe 11 — depth=100 全量复算（独立于 Lead 的 apply.mjs 路径）
//
// 目的：Lead 指出「匿名搜索 UGC 优先，原唱被埋在 20~100 名」，因此在被污染的
// limit=10 池子上得出的「26/57 匹配错误」必须用 depth=100 重算。本脚本独立复算：
//   - 每个文件用 parseFilename() 的前 2 个 query，各取 limit=100，合并去重
//   - 用 lib/match.mjs 的 pickBest()（与生产同一条代码路径）打分，opts 带 localDurationMs + localAlbum
//   - localAlbum 从**文件标签**读（FLAC VORBIS ALBUM / ID3v2 TALB），不是从文件名猜
//   - 与 probe/05（depth=10）逐文件对比选中 id 是否变化、变化后时长/专辑是否更对得上
//
// Run: node probe/11-deep-match.mjs
import { readdirSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { searchSong, getSongDetail, to163Meta, md5FallbackFor, getApiStats } from '../lib/netease-api.mjs';
import { parseFilename, pickBest, DURATION_TOLERANCE_MS } from '../lib/match.mjs';
import { readAudioInfo, readAlbumTag } from './_audioinfo.mjs';

const MUSIC_DIR = 'E:\\CloudMusic';
const OUT_DIR = join(import.meta.dirname, 'out');
const SEARCH_LIMIT = 100;
const MAX_QUERIES = 2;
const EXT = /\.(mp3|flac|m4a|wav|ape|ogg)$/i;

const files = readdirSync(MUSIC_DIR).filter((f) => EXT.test(f)).sort();
const report = { at: new Date().toISOString(), musicDir: MUSIC_DIR, searchLimit: SEARCH_LIMIT, maxQueries: MAX_QUERIES, files: [] };
const counts = {
  total: 0, poolEmpty: 0, auto: 0, high: 0, medium: 0, low: 0,
  durationMismatch: 0, over10s: 0, within5s: 0, nameExact: 0, artistHit: 0,
  albumExact: 0, albumScored: 0, realMd5: 0, fallbackMd5: 0, errors: 0,
  ugcBest: 0, ambiguous: 0,
  correctVersionInPool: 0, pickedChangedVsDepth10: 0, deepBetterDuration: 0, deepBetterAlbum: 0,
};
const timings = [];
let idx = 0;

for (const f of files) {
  idx++;
  const full = join(MUSIC_DIR, f);
  const parsed = parseFilename(f);
  const local = readAudioInfo(full);
  const localAlbum = readAlbumTag(full);
  const t0 = Date.now();
  const row = {
    file: f, parsed: { title: parsed.title, artists: parsed.artists, album: localAlbum },
    localAudio: { format: local.format, durationMs: local.durationMs, bitrate: local.bitrate, exact: local.exact },
    ok: false,
  };
  counts.total++;

  try {
    // 池子：前 2 个 query，各 limit=100，按 id 去重
    const pool = new Map();
    const perQuery = [];
    for (const q of parsed.queries.slice(0, MAX_QUERIES)) {
      const cands = await searchSong({ keyword: q, limit: SEARCH_LIMIT });
      perQuery.push({ q, returned: cands.length });
      for (const c of cands) if (!pool.has(c.id)) pool.set(c.id, c);
    }
    const candidates = [...pool.values()];
    row.perQuery = perQuery;
    row.poolSize = candidates.length;
    row.poolMissingDuration = candidates.filter((c) => !(Number.isFinite(c.durationMs) && c.durationMs > 0)).length;
    if (!candidates.length) {
      counts.poolEmpty++;
      row.error = '池子为空';
    } else {
      const pick = pickBest(candidates, parsed, { localDurationMs: local.durationMs, localAlbum });
      const best = pick.best;
      row.pick = {
        id: best.id, name: best.name, artists: best.artists.map((a) => a.name), artistIds: best.artists.map((a) => a.id), album: best.album?.name ?? '',
        durationMs: best.durationMs, score: +best.score.toFixed(4), parts: best.parts,
        confidence: pick.confidence, auto: pick.auto, ambiguous: pick.ambiguous, ugc: pick.ugc === true, gap: +(pick.gap ?? 0).toFixed(4),
        durationDeltaMs: pick.durationDeltaMs, durationMismatch: pick.durationMismatch,
      };
      if (pick.auto) counts.auto++;
      if (pick.ugc === true) counts.ugcBest++;
      if (pick.ambiguous) counts.ambiguous++;
      counts[pick.confidence]++;
      if (pick.durationMismatch) counts.durationMismatch++;
      if (pick.durationDeltaMs != null) {
        if (Math.abs(pick.durationDeltaMs) <= DURATION_TOLERANCE_MS) counts.within5s++;
        if (Math.abs(pick.durationDeltaMs) > 10000) counts.over10s++;
      }
      if ((best.parts.title ?? 0) >= 0.97) counts.nameExact++;
      if ((best.parts.artist ?? 0) >= 0.9) counts.artistHit++;
      if (best.parts.album != null) {
        counts.albumScored++;
        if (best.parts.album >= 0.97) counts.albumExact++;
      }
      // 池子里到底有没有「正确版本」（歌名与歌手都对得上）
      row.correctVersionInPool = candidates.filter((c) => (c.name === parsed.title || (c.name ?? '').includes(parsed.title)) && (c.artists ?? []).some((a) => parsed.artists.includes(a.name))).length;
      if (row.correctVersionInPool) counts.correctVersionInPool++;

      const meta = await getSongDetail(best.id);
      row.meta = { musicId: meta.musicId, musicName: meta.musicName, album: meta.album, duration: meta.duration, mp3DocId: meta.mp3DocId };
      row.final = to163Meta(meta, { format: local.format, localDurationMs: local.durationMs, bitrate: local.bitrate });
      row.md5Fallback = meta.mp3DocId === md5FallbackFor(meta.musicId, local.format);
      if (row.md5Fallback) counts.fallbackMd5++;
      else counts.realMd5++;
      row.ok = true;
    }
  } catch (e) {
    counts.errors++;
    row.error = e.message.split('\n')[0];
  }
  const ms = Date.now() - t0;
  timings.push(ms);
  row.ms = ms;
  report.files.push(row);
  const p = row.pick;
  console.log(
    `${String(idx).padStart(2)} ${row.ok ? (p.auto ? '✅' : '⚠️ ') : '❌'} ${f.slice(0, 40).padEnd(40)} pool=${String(row.poolSize ?? 0).padStart(3)} -> ` +
      `${String(p?.id ?? '-').padEnd(11)} ${(p?.name ?? row.error ?? '').slice(0, 24).padEnd(24)} conf=${String(p?.confidence ?? '-').padEnd(6)} ` +
      `dDur=${String(p?.durationDeltaMs ?? '-').padStart(8)}${p?.ugc ? ' UGC' : ''}${p?.ambiguous ? ' AMBIG' : ''} album=${JSON.stringify((localAlbum || '').slice(0, 12))}->${JSON.stringify((p?.album ?? '').slice(0, 12))} ${ms}ms`,
  );
}

// ── 与 depth=10（probe/05）逐文件对比 ────────────────────────
let depth10 = null;
const p05 = join(OUT_DIR, '05-e2e.json');
if (existsSync(p05)) {
  try { depth10 = JSON.parse(readFileSync(p05, 'utf8')); } catch { depth10 = null; }
}
if (depth10?.files) {
  const byFile = new Map(depth10.files.map((r) => [r.file, r]));
  report.vsDepth10 = [];
  for (const r of report.files) {
    const old = byFile.get(r.file);
    if (!old?.best?.id || !r.pick?.id) continue;
    if (old.best.id !== r.pick.id) {
      counts.pickedChangedVsDepth10++;
      const oldDelta = old.durationDiffMs == null ? null : Math.abs(old.durationDiffMs);
      const newDelta = r.pick.durationDeltaMs == null ? null : Math.abs(r.pick.durationDeltaMs);
      const betterDur = oldDelta != null && newDelta != null && newDelta < oldDelta;
      if (betterDur) counts.deepBetterDuration++;
      report.vsDepth10.push({
        file: r.file, depth10: { id: old.best.id, name: old.best.name, delta: old.durationDiffMs },
        depth100: { id: r.pick.id, name: r.pick.name, delta: r.pick.durationDeltaMs },
        deepBetterDuration: betterDur,
      });
      console.log(`  ↳ 换选: ${r.file}\n      depth10  ${old.best.id} 「${old.best.name}」 Δ=${old.durationDiffMs}\n      depth100 ${r.pick.id} 「${r.pick.name}」 Δ=${r.pick.durationDeltaMs}`);
    }
  }
}

const sorted = [...timings].sort((a, b) => a - b);
report.summary = {
  counts,
  timingMs: { min: sorted[0], p50: sorted[Math.floor(sorted.length / 2)], max: sorted[sorted.length - 1] },
  api: getApiStats(),
};
console.log('\n=== 汇总（depth=100，' + MAX_QUERIES + ' query/文件）===');
console.log(JSON.stringify(counts, null, 2));

mkdirSync(OUT_DIR, { recursive: true });
const out = join(OUT_DIR, '11-deep-match.json');
writeFileSync(out, JSON.stringify(report, null, 2), 'utf8');
console.log('\nsaved -> ' + out);
