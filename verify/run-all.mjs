#!/usr/bin/env node
/**
 * verify/run-all.mjs —— 一键复跑全部独立验证
 *
 *   node verify/run-all.mjs            # 跑全部
 *   node verify/run-all.mjs --offline  # 跳过需要网络的 03
 *
 * 设计：每个子脚本都是独立进程，退出码 0=全过，1=有断言失败。
 * 本脚本汇总所有 JSON 末行，生成 verify/artifacts/summary.json，
 * 并打印总的 P0/P1/P2 计数，供 notes/verification.md 引用。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const NODE = process.execPath;
const offline = process.argv.includes('--offline');

const SUITES = [
  { file: '01-crypto.mjs', net: false, title: '算法反证（163key 加解密 + ground truth 逐字节往返）' },
  { file: '02-audio-integrity.mjs', net: false, title: '音频区不变（vs 备份 / vs 原始素材）' },
  { file: '03-musicid-audit.mjs', net: true, title: 'musicId 正确性（全量反查 + UGC 陷阱 + 时长/专辑）' },
  { file: '04-structure-idempotency.mjs', net: false, title: '幂等 + 结构完整性（APIC/PICTURE/last 标志）' },
  { file: '05-guard.mjs', net: false, title: '保护目录 guard（真的调用 write163Key 撞）' },
  { file: '06-metadata-fidelity.mjs', net: false, title: '元数据保真（标签只能增不能删 / bitrate / 封面）' },
  { file: '07-audio-integrity-deep.mjs', net: false, title: '音频流深度完整性（Xing 帧数 / STREAMINFO / 尾部标签）' },
  { file: '08-bitrate-recheck.mjs', net: false, title: '【复验】独立重算 bitrate 并与 163key 逐条比对' },
  { file: '09-unwritten-recheck.mjs', net: true, title: '【复验】未写入文件是否仍属正确保守' },
  { file: '10-same-release-guard.mjs', net: true, title: '【复验】sameRelease 判据是否过度放行' },
];

const results = [];
console.log(`独立验证套件 —— ${SUITES.length} 个脚本${offline ? '（离线模式：跳过联网项）' : ''}\n`);

for (const s of SUITES) {
  if (offline && s.net) {
    console.log(`\n${'='.repeat(78)}\n跳过（需联网）: ${s.file} — ${s.title}\n${'='.repeat(78)}`);
    results.push({ file: s.file, title: s.title, skipped: true });
    continue;
  }
  console.log(`\n${'='.repeat(78)}\n运行: ${s.file} — ${s.title}\n${'='.repeat(78)}`);
  const r = spawnSync(NODE, [path.join(HERE, s.file)], { stdio: 'inherit', cwd: path.dirname(HERE) });
  const ok = r.status === 0;
  results.push({ file: s.file, title: s.title, ok, exitCode: r.status });
}

console.log(`\n\n${'='.repeat(78)}\n汇总\n${'='.repeat(78)}`);
for (const r of results) {
  const mark = r.skipped ? '  --  ' : r.ok ? ' PASS ' : ' FAIL ';
  console.log(`[${mark}] ${r.file.padEnd(32)} ${r.title}`);
}
const failed = results.filter((r) => r.ok === false);
const passed = results.filter((r) => r.ok === true);
console.log(`\n${passed.length} 通过 / ${failed.length} 失败 / ${results.filter((r) => r.skipped).length} 跳过`);

fs.mkdirSync(path.join(HERE, 'artifacts'), { recursive: true });
fs.writeFileSync(path.join(HERE, 'artifacts', 'summary.json'), JSON.stringify({ at: new Date().toISOString(), results }, null, 2), 'utf8');
console.log(`-> verify/artifacts/summary.json`);

if (failed.length) {
  console.log(`\n失败明细（这些是需要上报的断言不通过项，逐条已在上方输出里给出复现命令）：`);
  for (const f of failed) console.log(`  - node verify/${f.file}   (exit ${f.exitCode})`);
}
process.exitCode = failed.length ? 1 : 0;
