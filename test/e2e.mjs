/**
 * 端到端：scan -> match(离线桩) -> apply(dry-run) -> apply(--write) -> verify
 *
 *   node test/e2e.mjs
 *
 * 约定：
 *   test/e2e/src   原件，等价于「备份」，**只读**，每次跑不动它
 *   test/e2e/work  被写对象，每次跑之前整个重建
 *
 * 用 test/stub-api.mjs 当 API，所以不需要网络、结果可复现。
 * 这里刻意**不复用** apply.mjs 内部函数，音频区的比对自己算一遍，
 * 免得「用被测代码验证被测代码」。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { readTags, parseFlac } from '../lib/tags.mjs';
import { parse163Key, build163Key } from '../lib/163key.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(HERE, '..', 'apply.mjs');
const E2E = path.join(HERE, 'e2e');
const SRC = path.join(E2E, 'src');
const WORK = path.join(E2E, 'work');
const STUB = path.join(HERE, 'stub-api.mjs');
const NODE = process.execPath;

const p = (...a) => path.join(E2E, ...a);
const md5 = (b) => crypto.createHash('md5').update(b).digest('hex');

let pass = 0;
let fail = 0;
const ok = (cond, msg) => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${msg}`);
  } else {
    fail++;
    console.log(`  ✗ ${msg}`);
  }
};

function run(args, expectStatus = 0) {
  const r = spawnSync(NODE, [APP, ...args], {
    cwd: path.join(HERE, '..'),
    encoding: 'utf8',
    // 桩靠这个环境变量拿到「题目 → 本地实测时长」，好让正版候选的时长与本地对齐
    env: { ...process.env, STUB_DURATION_MAP: p('duration-map.json') },
  });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  if (expectStatus !== null && r.status !== expectStatus) {
    console.log(out);
    throw new Error(`apply.mjs ${args.join(' ')} 退出码 ${r.status}，期望 ${expectStatus}`);
  }
  return out;
}

/**
 * 独立算出「音频数据」的起始偏移，用来证明我们只碰了标签区。
 * MP3: 跳过 ID3v2（synchsafe 长度 + 扩展头/footer 10 字节）
 * FLAC: 跳过元数据块
 */
function audioStart(buf) {
  if (buf.length > 10 && buf.toString('latin1', 0, 3) === 'ID3') {
    const sz =
      ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f);
    return 10 + sz + (buf[5] & 0x10 ? 10 : 0);
  }
  if (buf.length > 4 && buf.toString('latin1', 0, 4) === 'fLaC') {
    const f = parseFlac(buf);
    if (!f) throw new Error('FLAC 解析失败');
    return f.audioOffset;
  }
  return 0;
}

const audioMd5 = (file) => {
  const buf = fs.readFileSync(file);
  return md5(buf.subarray(audioStart(buf)));
};

const sha = (file) => md5(fs.readFileSync(file));
const listAudio = (dir) =>
  fs
    .readdirSync(dir)
    .filter((f) => /\.(mp3|flac|ncm|m4a)$/i.test(f))
    .sort();
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

console.log('== 端到端：scan -> match -> apply -> verify ==');

// ── 0. 重建 work ─────────────────────────────────────────────
console.log('\n[E0] 重建 work 目录');
{
  if (!fs.existsSync(SRC)) throw new Error(`缺少原件目录 ${SRC}`);
  fs.rmSync(WORK, { recursive: true, force: true });
  fs.mkdirSync(WORK, { recursive: true });
  // 缓存一定要清掉：桩返回什么候选直接决定报告内容，留着上一轮的缓存会让结果不可复现
  fs.rmSync(p('api-cache.json'), { force: true });
  const files = listAudio(SRC);
  for (const f of files) fs.copyFileSync(path.join(SRC, f), path.join(WORK, f));
  ok(files.length >= 3, `原件 ${files.length} 个：${files.join(' / ')}`);
}

const srcAudio = new Map(listAudio(SRC).map((f) => [f, audioMd5(path.join(SRC, f))]));
const srcSha = new Map(listAudio(SRC).map((f) => [f, sha(path.join(SRC, f))]));

// ── 1. scan ──────────────────────────────────────────────────
console.log('\n[E1] scan');
{
  run(['scan', '--root', WORK, '--out', p('scan.json')]);
  const s = readJson(p('scan.json'));
  ok(s.count === srcAudio.size, `扫到 ${s.count} 个文件`);
  ok(Object.keys(s.fmtCount).length >= 1, `格式分布 ${JSON.stringify(s.fmtCount)}`);
  const withKey = s.records.filter((e) => e.hasKey).length;
  ok(withKey <= 1, `扫描时带 163key 的 ${withKey} 个（原件里最多 1 个真实样本）`);
}

// ── 1b. 给桩准备「题目 → 本地实测时长」─────────────────────────
console.log('\n[E1b] 生成本地时长映射（喂给离线桩）');
{
  const s = readJson(p('scan.json'));
  const dmap = {};
  for (const r of s.records) {
    const q0 = r.parsed?.queries?.[0];
    if (!q0 || !Number.isFinite(r.durationMs)) continue;
    // 必须和 test/stub-api.mjs 里切分 keyword 的方式完全一致
    const parts = q0.trim().split(/\s+/);
    dmap[`${parts[0]}|${parts.slice(1).join(' ') || '未知歌手'}`] = r.durationMs;
  }
  fs.writeFileSync(p('duration-map.json'), JSON.stringify(dmap, null, 2));
  ok(Object.keys(dmap).length > 0, `映射 ${Object.keys(dmap).length} 条`);
}

// ── 2. match（离线桩）────────────────────────────────────────
console.log('\n[E2] match（离线桩，不联网）');
{
  // --cache 必须指到测试目录，否则桩的假 id 会污染 out/api-cache.json
  run([
    'match',
    '--root', WORK,
    '--report', p('matches.json'),
    '--review', p('review.json'),
    '--api', STUB,
    '--cache', p('api-cache.json'),
    '--sleep', '0',
  ]);
  const m = readJson(p('matches.json'));
  ok(m.records.length === srcAudio.size, `报告 ${m.records.length} 条`);
  ok(
    m.records.every((r) => r.best && Number.isInteger(r.best.id) && r.best.id > 0),
    '每条都有合法的 best.id',
  );
  ok(
    m.records.every((r) => r.key163 && r.key163.startsWith("163 key(Don't modify):")),
    '每条都生成了带前缀的 key163',
  );
  // 桩的第二名与第一名歌名、歌手完全一样，只有时长差 15 秒。只有时长信号真的参与
  // 排序，正版才会胜出——这是修「真实歌单 26/57 匹配到伴奏/remix」的核心回归点。
  // 注意：两个「一路向北」共用同一条检索词，所以桩只能给它们同一个时长，
  // 其中一条会差 1.5s —— 仍落在 ±2s 的严格对齐带内，属于预期行为。
  ok(
    m.records.every(
      (r) => !Number.isFinite(r.localDurationMs) || Math.abs(r.best.durationMs - r.localDurationMs) < 10000,
    ),
    '没有任何一条选中时长偏离本地 ≥10s 的候选（伴奏/remix 版）',
  );
  ok(
    m.records.every((r) => !r.auto || r.durationDeltaMs <= 2000),
    '所有 auto 记录的接口时长都落在本地实测 ±2s 的对齐带内',
  );
  ok(m.records.some((r) => r.auto), '至少有一条拿到 auto');
  ok(m.records.some((r) => r.confidence !== 'high'), '也存在非 high 的记录，默认策略不会空转');
}

// ── 3. apply dry-run 必须一个字节都不动 ───────────────────────
console.log('\n[E3] apply --dry-run');
{
  const out = run(['apply', '--report', p('matches.json'), '--log', p('dry.log.json')]);
  ok(out.includes('dry-run'), '输出明确标注 dry-run');
  for (const [f, h] of srcSha) {
    ok(sha(path.join(WORK, f)) === h, `dry-run 后 ${f} 未被改动`);
  }
}

// ── 3b. 默认放行策略：只写 auto，其余必须显式放行 ─────────────
console.log('\n[E3b] apply --write 的默认放行策略');
{
  const m = readJson(p('matches.json'));
  const autoFiles = new Set(m.records.filter((r) => r.auto).map((r) => r.file));
  run(['apply', '--report', p('matches.json'), '--write', '--log', p('apply-default.log.json')]);
  const log = readJson(p('apply-default.log.json'));

  // 非 auto 的文件一个都不能被动过
  let untouched = 0;
  for (const [f, h] of srcSha) {
    if (autoFiles.has(f)) continue;
    untouched++;
    ok(sha(path.join(WORK, f)) === h, `${f} 非 auto，未被默认写入`);
  }
  ok(untouched > 0, `确实存在被默认拦下的文件（${untouched} 个），策略不是空转`);

  // auto 的文件必须已经带上 key
  for (const f of autoFiles) {
    ok(!!readTags(path.join(WORK, f)).key163, `${f} 是 auto，已被写入`);
  }

  const skipped = log.results.filter((r) => String(r.status).startsWith('skip')).length;
  ok(
    skipped === m.records.length - autoFiles.size,
    `跳过 ${skipped} 条需要显式放行（共 ${m.records.length} 条，auto ${autoFiles.size} 条）`,
  );

  // 时长闸门必须真的拦得住「歌名/歌手对得上、时长差 30 秒」的伴奏/remix 版。
  // 手改报告里的 durationMs 来构造这个场景；只动时长、不动 key163，
  // 所以即使后面 --all 放行，写进文件的 key 也和正确报告完全一致。
  const bad = JSON.parse(JSON.stringify(m));
  const victim =
    bad.records.find((r) => Number.isFinite(r.localDurationMs) && r.confidence === 'high') || bad.records[0];
  victim.auto = true;
  victim.confidence = 'high';
  victim.durationMismatch = true;
  victim.best.durationMs = victim.localDurationMs + 30000;
  fs.writeFileSync(p('matches-bad.json'), JSON.stringify(bad, null, 2));

  run(['apply', '--report', p('matches-bad.json'), '--write', '--log', p('apply-bad.log.json')], null);
  const bl = readJson(p('apply-bad.log.json'));
  const badRow = bl.results.find((r) => r.file === victim.file);
  ok(badRow?.status === 'skip:duration-mismatch', `${victim.file} 时长差 30s 被默认拦下（${badRow?.status}）`);

  // 反向证明这不是「永远跳过」的空转：--all 是人工核对后的兜底出口
  run(['apply', '--report', p('matches-bad.json'), '--write', '--all', '--log', p('apply-bad-all.log.json')], null);
  const bl2 = readJson(p('apply-bad-all.log.json'));
  const badRow2 = bl2.results.find((r) => r.file === victim.file);
  ok(!String(badRow2?.status).startsWith('skip'), `--all 可以显式放行（${badRow2?.status}）`);
}

// ── 4. apply --write --all ───────────────────────────────────
console.log('\n[E4] apply --write --all');
{
  run(['apply', '--report', p('matches.json'), '--write', '--all', '--log', p('apply.log.json')]);
  const log = readJson(p('apply.log.json'));
  const m = readJson(p('matches.json'));
  const expect = new Map(m.records.map((r) => [r.file, r]));
  const errs = log.results.filter((r) => String(r.status).startsWith('error'));
  ok(errs.length === 0, `无写入错误${errs.length ? `：${JSON.stringify(errs)}` : ''}`);
  ok(
    log.results.every((r) => !String(r.status).startsWith('skip')),
    '--all 之后没有记录再被跳过',
  );

  for (const f of listAudio(WORK)) {
    const t = readTags(path.join(WORK, f));
    ok(!!t.key163, `${f} 写入后可读回 163key`);
    if (!t.key163) continue;
    const meta = parse163Key(t.key163);
    ok(!!meta && Number.isInteger(meta.musicId), `${f} 163key 可解密`);
    ok(meta && build163Key(meta) === t.key163, `${f} 重编码逐字节一致`);
    ok(meta && meta.format === t.format, `${f} format=${meta?.format} 与实际容器一致`);
    // 关键：文件里的 key 必须就是报告里那条命中，别的都不算
    const rec = expect.get(f);
    ok(rec && meta && meta.musicId === rec.best.id, `${f} musicId=${meta?.musicId} == 报告命中 ${rec?.best.id}`);
    ok(rec && t.key163 === rec.key163, `${f} 文件里的 key 与报告逐字节一致`);
  }

  // 音频区必须一字未动 —— 这是本项目最硬的约束
  for (const [f, h] of srcAudio) {
    ok(audioMd5(path.join(WORK, f)) === h, `${f} 音频区 md5 与原件一致`);
  }
}

// ── 5. 幂等：再写一遍不该有任何变化 ──────────────────────────
console.log('\n[E5] 重复 apply 幂等');
{
  const before = new Map(listAudio(WORK).map((f) => [f, sha(path.join(WORK, f))]));
  run(['apply', '--report', p('matches.json'), '--write', '--all', '--log', p('apply2.log.json')]);
  for (const [f, h] of before) {
    ok(sha(path.join(WORK, f)) === h, `${f} 第二次写入文件 sha 不变`);
  }
}

// ── 6. verify（对比原件当备份）────────────────────────────────
console.log('\n[E6] verify');
{
  // verify 有问题时退出码是 1，这里自己判，所以允许任意退出码
  run(['verify', '--root', WORK, '--report', p('matches.json'), '--backup', SRC, '--out', p('verify.json')], null);
  const v = readJson(p('verify.json'));
  ok(v.problems.length === 0, `verify 无问题（problems=${v.problems.length}）`);
  if (v.problems.length) for (const x of v.problems) console.log(`     - ${x}`);
}

console.log('\n============================================================');
console.log(`通过 ${pass} / 失败 ${fail}`);
process.exitCode = fail ? 1 : 0;
