// Probe 05 — end-to-end: 真实文件名 -> searchSong -> getSongDetail -> to163Meta
//
// 两个目的：
//   0) 保真度校验：把真实样本 163key（probe/out/03-existing-163keys.json 里的 payload）解出来，
//      与我用接口重新生成的 meta 逐字段对比。这是"接口字段映射是否正确"的最强证据。
//   1) 命中率：对 E:\CloudMusic 全部 57 个文件跑完整链路（**只读**，绝不写入），统计命中率、
//      真实 mp3DocId 的可得率、每条链路的耗时与失败原因。
//
// Run: node probe/05-search-detail-e2e.mjs
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { createDecipheriv } from 'node:crypto';
import { searchSong, getSongDetail, to163Meta, metaTo163Plain, getApiStats, md5FallbackFor, META_FIELD_ORDER } from '../lib/netease-api.mjs';
// 打分/解析走唯一权威实现（与 apply.mjs 主流程同一条代码路径，避免探针和生产用两套阈值）
import { parseFilename, pickBest, DURATION_TOLERANCE_MS } from '../lib/match.mjs';
import { readAudioInfo } from './_audioinfo.mjs';

const LIB_DIR = join(import.meta.dirname, '..', 'lib');
const OUT_DIR = join(import.meta.dirname, 'out');
const MUSIC_DIR = 'E:\\CloudMusic';
const SAMPLE_KEY_HEX = '2331346c6a6b5f215c5d2630553c2728';

const decrypt163 = (b64) => {
  const d = createDecipheriv('aes-128-ecb', Buffer.from(SAMPLE_KEY_HEX, 'hex'), null);
  return d.update(Buffer.from(b64, 'base64'), undefined, 'utf8') + d.final('utf8');
};

/** 直接从文件里取真实的 163key payload（03 的 JSON 里那份是被截断的，不能用） */
function readRealTag(filePath) {
  const buf = readFileSync(filePath);
  const marker = Buffer.from("163 key(Don't modify):", 'utf8');
  const at = buf.indexOf(marker);
  if (at === -1) return null;
  const start = at + marker.length;
  let end = start;
  while (end < buf.length && /[A-Za-z0-9+/=]/.test(String.fromCharCode(buf[end]))) end++;
  return { at, payload: buf.subarray(start, end).toString('latin1') };
}

const report = { generatedAt: new Date().toISOString(), sampleFidelity: null, files: [], summary: null };

// ---------------------------------------------------------------------------
// 0) 保真度校验：真实标签 vs 我用接口重新生成的 meta
// ---------------------------------------------------------------------------
console.log('=== 0) 保真度校验：真实样本 163key vs 接口重建 ===\n');
const scanPath = join(OUT_DIR, '03-existing-163keys.json');
if (existsSync(scanPath)) {
  const scan = JSON.parse(readFileSync(scanPath, 'utf8'));
  const hit = scan.found?.[0];
  if (hit) {
    const real = readRealTag(hit.file);
    const plain = decrypt163(real.payload);
    const realMeta = JSON.parse(plain.slice('music:'.length)); // 去掉 'music:' 前缀（6 字符）
    const apiMeta = await getSongDetail(realMeta.musicId);
    const local = readAudioInfo(hit.file);
    // 用本地文件的容器/时长/码率重建（duration/format/bitrate 三个字段的真实来源）
    const rebuilt = to163Meta(apiMeta, { format: local.format, localDurationMs: local.durationMs, bitrate: local.bitrate });
    const rawRebuilt = to163Meta(apiMeta, { format: local.format });

    const diff = [];
    // CDN 分片 p1~p4 是按请求轮换的（实测四片返回同一张图，sha256 一致），比较时必须归一化
    const normPic = (u) => String(u).replace(/\/\/p[1-4]\.music\.126\.net\//, '//pX.music.126.net/');
    for (const k of META_FIELD_ORDER) {
      const a = JSON.stringify(realMeta[k]);
      const b = JSON.stringify(k === 'albumPic' ? normPic(rebuilt[k]) : rebuilt[k]);
      const a2 = JSON.stringify(k === 'albumPic' ? normPic(realMeta[k]) : realMeta[k]);
      if (a2 !== b) diff.push({ field: k, realTag: realMeta[k], mineWithLocalInfo: rebuilt[k], mineApiOnly: rawRebuilt[k] });
    }
    // 关键对照：不用本地测量值（只传 format）时，能否逐字段复现真实标签？
    // 这才是「接口自己给的值对不对」的判据 —— 用本地时长覆盖反而会破坏一致性。
    const diffApiOnly = [];
    for (const k of META_FIELD_ORDER) {
      const a = JSON.stringify(k === 'albumPic' ? normPic(realMeta[k]) : realMeta[k]);
      const b = JSON.stringify(k === 'albumPic' ? normPic(rawRebuilt[k]) : rawRebuilt[k]);
      if (a !== b) diffApiOnly.push({ field: k, realTag: realMeta[k], mineApiOnly: rawRebuilt[k] });
    }
    report.sampleFidelity = {
      file: hit.file,
      realTagPlain: plain,
      realTagMeta: realMeta,
      apiMeta,
      rebuiltWithLocalInfo: rebuilt,
      rebuiltApiOnly: rawRebuilt,
      localAudio: local,
      identicalFields: META_FIELD_ORDER.length - diff.length,
      totalFields: META_FIELD_ORDER.length,
      differences: diff,
      identicalFieldsApiOnly: META_FIELD_ORDER.length - diffApiOnly.length,
      differencesApiOnly: diffApiOnly,
      fieldOrderOk: JSON.stringify(Object.keys(rebuilt)) === JSON.stringify(META_FIELD_ORDER),
      plaintextMatchesRealTag: metaTo163Plain(rebuilt) === plain,
      plaintextMatchesRealTagApiOnly: metaTo163Plain(rawRebuilt) === plain,
      plaintextDiffersOnlyByCdnHost: metaTo163Plain({ ...rebuilt, albumPic: realMeta.albumPic }) === plain,
    };
    console.log(`真实标签: ${hit.file.split('\\').pop()}`);
    console.log(`本地音频: format=${local.format} durationMs=${local.durationMs} (exact=${local.exact}) bitrate=${local.bitrate}`);
    console.log(`逐字段一致（用本地时长/码率）: ${report.sampleFidelity.identicalFields}/${report.sampleFidelity.totalFields}`);
    console.log(`逐字段一致（只用接口值，CDN 分片已归一化）: ${report.sampleFidelity.identicalFieldsApiOnly}/${report.sampleFidelity.totalFields}`);
    console.log(`明文与真实标签完全相同（只用接口值）: ${report.sampleFidelity.plaintextMatchesRealTagApiOnly}`);
    for (const d of diffApiOnly) {
      console.log(`  ≠（只用接口值）${d.field}: 真实=${JSON.stringify(d.realTag)} 接口=${JSON.stringify(d.mineApiOnly)}`);
    }
    for (const d of diff) {
      console.log(`  ≠ ${d.field}`);
      console.log(`      真实标签      : ${JSON.stringify(d.realTag)}`);
      console.log(`      我用本地信息  : ${JSON.stringify(d.mineWithLocalInfo)}`);
      console.log(`      我只用接口    : ${JSON.stringify(d.mineApiOnly)}`);
    }
    if (!diff.length) {
      console.log(`  ✅ 14/14 字段完全一致（albumPic 忽略 CDN 分片 p1~p4，四片实测同一张图）`);
      console.log(`  明文逐字节一致: ${report.sampleFidelity.plaintextMatchesRealTag}｜仅因 CDN 分片不同: ${report.sampleFidelity.plaintextDiffersOnlyByCdnHost}`);
    }
    console.log();
  }
}

// ---------------------------------------------------------------------------
// 1) 全量 57 个文件
// ---------------------------------------------------------------------------
console.log('=== 1) E:\\CloudMusic 全量端到端（只读） ===\n');
const files = readdirSync(MUSIC_DIR)
  .filter((f) => ['.mp3', '.flac'].includes(extname(f).toLowerCase()))
  .sort();

const counts = { total: 0, searchOk: 0, noResults: 0, detailOk: 0, nameExact: 0, artistMatched: 0, accepted: 0, realMd5: 0, fallbackMd5: 0, errors: 0, candidatesMissingDuration: 0, durationMismatch: 0, durationMatched5s: 0 };
const timings = [];
let idx = 0;
for (const f of files) {
  idx++;
  const full = join(MUSIC_DIR, f);
  const parsed = parseFilename(f);
  const local = readAudioInfo(full);
  const t0 = Date.now();
  const row = {
    file: f,
    parsed,
    localAudio: { format: local.format, durationMs: local.durationMs, bitrate: local.bitrate, exact: local.exact },
    ok: false,
  };
  counts.total++;

  try {
    const candidates = await searchSong({ keyword: parsed.title, limit: 10 });
    // 契约守卫：候选必须带有限正数毫秒时长（apply.mjs 的时长闸门依赖它）
    row.candidatesMissingDuration = candidates.filter((c) => !(Number.isFinite(c.durationMs) && c.durationMs > 0)).length;
    if (row.candidatesMissingDuration) counts.candidatesMissingDuration++;
    if (!candidates.length) {
      counts.noResults++;
      row.error = 'searchSong 无结果';
    } else {
      counts.searchOk++;
      const pick = pickBest(candidates, parsed, { localDurationMs: local.durationMs });
      const best = pick.best;
      row.confidence = pick.confidence;
      row.auto = pick.auto;
      row.durationMismatch = pick.durationMismatch;
      row.candidates = candidates.length;
      row.best = {
        id: best.id,
        name: best.name,
        score: best.score,
        nameExact: (best.parts.title ?? 0) >= 0.97,
        artistsMatched: (best.parts.artist ?? 0) >= 0.9 ? 1 : 0,
        searchDurationMs: best.durationMs,
      };
      // 第二名用于人工核对是否选错
      row.runnerUp = candidates[1] ? { id: candidates[1].id, name: candidates[1].name, artists: candidates[1].artists.map((a) => a.name) } : null;

      const meta = await getSongDetail(best.id);
      row.meta = meta;
      const final = to163Meta(meta, { format: local.format, localDurationMs: local.durationMs, bitrate: local.bitrate });
      row.final = final;
      counts.detailOk++;
      if (row.best.nameExact) counts.nameExact++;
      if (row.best.artistsMatched >= 1) counts.artistMatched++;
      if (pick.durationMismatch) counts.durationMismatch++;
      // 真实 md5 判定必须用确定性比较：回退值是 md5(`netease-163key-tagger|${musicId}|${format}`)
      row.md5Fallback = meta.mp3DocId === md5FallbackFor(meta.musicId, local.format);
      if (row.md5Fallback) counts.fallbackMd5++;
      else counts.realMd5++;
      row.durationDiffMs = local.durationMs && meta.duration ? meta.duration - local.durationMs : null;
      // 匹配可信度：候选时长与本地实测（FLAC 为精确值）之差
      row.matchDurationDelta = pick.durationDeltaMs;
      if (row.matchDurationDelta !== null && Math.abs(row.matchDurationDelta) <= 5000) counts.durationMatched5s++;
      row.ok = true;
      counts.accepted++;
    }
  } catch (e) {
    counts.errors++;
    row.error = e.message.split('\n')[0];
  }
  const ms = Date.now() - t0;
  timings.push(ms);
  row.ms = ms;
  report.files.push(row);

  const flag = row.ok ? (row.best?.nameExact ? '✅' : '⚠️ ') : '❌';
  console.log(
    `${String(idx).padStart(2)} ${flag} ${f.slice(0, 46).padEnd(46)} -> ${String(row.best?.id ?? '-').padEnd(11)} ${(row.best?.name ?? row.error ?? '').slice(0, 30).padEnd(30)} ` +
      `conf=${String(row.confidence ?? '-').padEnd(6)} md5=${row.md5Fallback ? 'FB' : 'RE'} dDur=${row.durationDiffMs ?? '-'} ` +
      `${row.durationMismatch ? 'DUR-MISMATCH>=' + DURATION_TOLERANCE_MS : ''} ${ms}ms`,
  );
}

const sorted = [...timings].sort((a, b) => a - b);
report.summary = {
  counts,
  timingMs: { min: sorted[0], p50: sorted[Math.floor(sorted.length / 2)], max: sorted[sorted.length - 1], avg: Math.round(timings.reduce((a, b) => a + b, 0) / timings.length) },
  api: getApiStats(),
  hitRateNameExact: counts.searchOk ? +(counts.nameExact / counts.total).toFixed(3) : 0,
  realMd5Rate: counts.total ? +(counts.realMd5 / counts.total).toFixed(3) : 0,
};

console.log('\n=== 汇总 ===');
console.log(JSON.stringify(report.summary, null, 2).slice(0, 4000));

mkdirSync(OUT_DIR, { recursive: true });
const outPath = join(OUT_DIR, '05-e2e.json');
writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf8');
console.log('\nsaved -> ' + outPath);
console.log('lib dir (仅记录，未写入): ' + LIB_DIR);
