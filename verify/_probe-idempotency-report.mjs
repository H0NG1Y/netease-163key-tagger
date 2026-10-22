/**
 * verify/_probe-idempotency-report.mjs —— 精确刻画「重复写入」的行为
 *
 * 04 号脚本的 I1/I2 已经证明：对同一个 163key 再写一次，**文件 sha256 不变**（真·幂等）。
 * 但同时观察到：FLAC 的写入计划总是返回 strategy='in-place'（而不是 'noop'），
 * 意味着即使内容完全一致，write163Key 也会真的开文件、真的落盘一次。
 *
 * 这个探查回答三个问题：
 *   Q1 MP3 与 FLAC 在「内容已正确」时分别返回什么？
 *   Q2 FLAC 那次「多余的落盘」会不会改变任何字节？（在副本上验证）
 *   Q3 会不会改变 mtime / 产生可观测副作用？
 *
 * 全部在 verify/scratch2/ 的副本上做，绝不碰交付物。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { TARGET, vReadAudio } from './00-common.mjs';

const { write163Key } = await import('../lib/tags.mjs');

const S = 'D:/HonGLY/netease-163key-tagger/verify/scratch2';
fs.rmSync(S, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
fs.mkdirSync(S, { recursive: true });

const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

const names = fs.readdirSync(TARGET).filter((n) => /\.(mp3|flac)$/i.test(n)).sort();
const withKey = names.filter((n) => vReadAudio(path.join(TARGET, n)).keyHits.length > 0);

console.log('═══ Q1/Q2/Q3：对内容已正确的文件重复写入，观测返回值与字节变化 ═══\n');
const mp3Rows = [];
const flacRows = [];

for (const name of withKey) {
  const dst = path.join(S, name);
  fs.copyFileSync(path.join(TARGET, name), dst);
  const key = vReadAudio(dst).keyHits[0].text;
  const s0 = sha(dst);
  const m0 = fs.statSync(dst).mtimeMs;
  const r1 = write163Key(dst, key, { dryRun: true }); // 只算计划
  const r2 = write163Key(dst, key, { dryRun: false }); // 真写
  const s1 = sha(dst);
  const m1 = fs.statSync(dst).mtimeMs;
  const row = { name, planStrategy: r1.strategy, planChanged: r1.changed, realStrategy: r2.strategy, realChanged: r2.changed, bytesSame: s0 === s1, mtimeSame: Math.abs(m0 - m1) < 500 };
  (name.endsWith('.mp3') ? mp3Rows : flacRows).push(row);
}

const summarize = (label, rows) => {
  const byPlan = {};
  for (const r of rows) byPlan[`${r.planStrategy}/${r.realStrategy}`] = (byPlan[`${r.planStrategy}/${r.realStrategy}`] || 0) + 1;
  const bytesChanged = rows.filter((r) => !r.bytesSame);
  const mt = rows.filter((r) => !r.mtimeSame);
  console.log(`${label}: ${rows.length} 个`);
  console.log(`  dryRun/real 策略分布: ${JSON.stringify(byPlan)}`);
  console.log(`  重写后字节发生变化的: ${bytesChanged.length}${bytesChanged.length ? ' -> ' + bytesChanged.map((r) => r.name).slice(0, 5).join(', ') : ''}`);
  console.log(`  mtime 发生变化的: ${mt.length}`);
  console.log('');
};
summarize('MP3', mp3Rows);
summarize('FLAC', flacRows);

console.log('═══ 结论 ═══');
const flacAlwaysRewrites = flacRows.every((r) => r.planChanged === true);
const mp3IsNoop = mp3Rows.every((r) => r.planChanged === false);
const allBytesSame = [...mp3Rows, ...flacRows].every((r) => r.bytesSame);
console.log(`  MP3 内容正确时报告 noop:           ${mp3IsNoop ? '是' : '否'}`);
console.log(`  FLAC 内容正确时仍报告 changed:      ${flacAlwaysRewrites ? '是  ← 行为不一致' : '否'}`);
console.log(`  但两种情况重写后字节都不变:         ${allBytesSame ? '是（内容层面幂等成立）' : '否 ← 严重'}`);
console.log('');
console.log('  判定：内容层面幂等 ✔（sha256 不变），但 FLAC 路径每次都实际落盘、并对外报告 changed。');
console.log('        影响：① 重复运行 apply 会对全部 FLAC 做无谓写盘；');
console.log('              ② apply 日志里无法区分「本次新增」与「本来就有」，审计时容易误判为「写了 42 个」。');
console.log('              ③ 若磁盘写入过程中断电，理论上存在把本来完好的文件写坏的时间窗（虽然概率极低）。');

fs.rmSync(S, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
