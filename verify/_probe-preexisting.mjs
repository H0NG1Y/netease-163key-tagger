/**
 * verify/_probe-preexisting.mjs —— 探查：原始素材里是否本来就带 163key
 *
 * 这个探查很重要：如果原文件已经带官方写入的 163key，我们「覆盖」它就等于破坏官方数据；
 * 如果原文件一个都没有，那么全部 52 个写入都是本次新增，需要独立审计。
 */
import fs from 'node:fs';
import path from 'node:path';
import { ORIGINAL, BACKUP, TARGET, vReadAudio } from './00-common.mjs';

for (const root of [ORIGINAL, BACKUP, TARGET]) {
  console.log(`\n=== ${root}`);
  let withKey = 0;
  let total = 0;
  for (const name of fs.readdirSync(root).sort()) {
    const p = path.join(root, name);
    if (!fs.statSync(p).isFile() || !/\.(mp3|flac)$/i.test(name)) continue;
    total++;
    const a = vReadAudio(p);
    if (a.keyHits.length) withKey++;
    console.log(`  ${a.keyHits.length ? 'KEY×' + a.keyHits.length : '    '}  ${a.format.padEnd(4)} ${name.slice(0, 62)}${a.keyHits.length ? '  <- ' + a.keyHits.map((h) => h.where).join(',') : ''}`);
  }
  console.log(`  --- ${withKey}/${total} 带 163key`);
}
