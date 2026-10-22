#!/usr/bin/env node
/**
 * verify/05-guard.mjs —— 保护目录 write163Key() 拒绝写入验证
 *
 * 任务书明确要求：不许只看代码，必须**真的构造一次调用**去撞。
 *
 * 这是本套审计里唯一允许 import lib/tags.mjs 的脚本——因为被审计对象就是
 * write163Key() 本身，不调用它就没法证明它抛错。
 *
 * 安全措施：
 *   1. 先对目标路径做 sha256 + mtime 快照，调用后再比对，证明保护目录一个字节都没被改
 *   2. 用 dryRun:true 与 dryRun:false 两种参数各撞一次（防止只有 dry-run 才拦截）
 *   3. 覆盖多种路径写法：原始大小写、全小写、带尾部分隔符、用 .. 绕、相对路径
 *   4. 同时验证「工作副本 E:\CloudMusic_163key 不被误拦」—— 保护不能过宽
 *
 * 运行：node verify/05-guard.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { C, ORIGINAL, BACKUP, TARGET, check, head, info, summary, vReadAudio } from './00-common.mjs';

const { write163Key, isProtected, assertWritable, PROTECTED_ROOTS } = await import('../lib/tags.mjs');

const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const stat = (p) => {
  const s = fs.statSync(p);
  return { size: s.size, mtimeMs: s.mtimeMs, sha256: sha(p) };
};

/**
 * 取一个真实的音频文件作为撞击样本。
 * 注意：原始素材/备份里本来就一个 163key 都没有（这正是本次写标签的前提），
 * 所以这里不能要求样本已带 key —— 只要是个真实音频文件即可。
 */
function pickSample(root) {
  for (const n of fs.readdirSync(root).sort()) {
    if (!/\.(mp3|flac)$/i.test(n)) continue;
    const p = path.join(root, n);
    const a = vReadAudio(p);
    if (a.format) return { path: p, key: a.keyHits[0]?.text ?? null, format: a.format };
  }
  return null;
}

const KEY = vReadAudio(path.join(TARGET, fs.readdirSync(TARGET).find((n) => /\.mp3$/i.test(n)))).keyHits[0].text;

head('1. PROTECTED_ROOTS 必须恰好覆盖原始素材与备份');
info('PROTECTED_ROOTS', JSON.stringify(PROTECTED_ROOTS));
check(
  PROTECTED_ROOTS.some((r) => path.resolve(r).toLowerCase() === path.resolve(ORIGINAL).toLowerCase()),
  'E:\\CloudMusic 在保护列表里',
);
check(
  PROTECTED_ROOTS.some((r) => path.resolve(r).toLowerCase() === path.resolve(BACKUP).toLowerCase()),
  'E:\\CloudMusic_backup_20261022 在保护列表里',
);
// 关键：工作副本名字很像保护目录（CloudMusic_163key vs CloudMusic），不能误拦也不能漏拦
check(isProtected(ORIGINAL) === true, 'isProtected(E:\\CloudMusic) === true');
check(isProtected(BACKUP) === true, 'isProtected(E:\\CloudMusic_backup_20261022) === true');
check(isProtected(TARGET) === false, 'isProtected(E:\\CloudMusic_163key) === false（工作副本不能被误拦）');
check(isProtected(path.join(TARGET, 'x.mp3')) === false, '工作副本下的文件不protected');

// 子路径必须被覆盖
check(isProtected(path.join(ORIGINAL, 'a.mp3')) === true, '保护目录下的文件被拦住');
check(isProtected(path.join(ORIGINAL, 'sub', 'deep', 'a.mp3')) === true, '保护目录的深层子路径也被拦住');

// 近似名字不能误伤 / 也不能漏
const nearMisses = ['E:\\CloudMusic2', 'E:\\CloudMusic_other', 'E:\\CloudMusicX', 'E:\\CloudMusi'];
for (const p of nearMisses) {
  check(isProtected(p) === false, `近似名不被误判为保护路径: ${p}`);
}

// 绕过尝试：大小写、尾分隔符、.. 回退、混合分隔符
const bypass = [
  { p: 'e:\\cloudmusic\\a.mp3', why: '全小写' },
  { p: 'E:\\CloudMusic\\a.mp3'.toUpperCase(), why: '全大写' },
  { p: 'E:\\CloudMusic\\sub\\..\\a.mp3', why: '父目录回退' },
  { p: 'E:\\CloudMusic\\', why: '带尾分隔符' },
  { p: 'E:\\X\\..\\CloudMusic\\a.mp3', why: '跨目录回退' },
];
for (const b of bypass) {
  check(isProtected(b.p) === true, `绕过手法被拦：${b.why}`, b.p);
}

head('2. 对保护目录里的真实文件调用 write163Key()，必须抛错，且文件一字未动');
{
  const sample = pickSample(ORIGINAL);
  const bsample = pickSample(BACKUP);
  check(!!sample && !!bsample, '找到了可用于撞击的样本文件（原始素材 + 备份各一）', `${sample?.path} / ${bsample?.path}`);
  check(!!KEY, '取到一个合法 163key 用于撞击');

  for (const [label, target] of [
    ['原始素材 E:\\CloudMusic', sample],
    ['备份 E:\\CloudMusic_backup_20261022', bsample],
  ]) {
    const before = stat(target.path);
    // dryRun: true —— 只有真正想落盘时才拦截的实现会漏掉这一档
    let threwDry = false;
    let errDry = '';
    try {
      write163Key(target.path, KEY, { dryRun: true });
    } catch (e) {
      threwDry = true;
      errDry = e.message;
    }
    // dryRun: false —— 真正会写盘的那一档
    let threwReal = false;
    let errReal = '';
    try {
      write163Key(target.path, KEY, { dryRun: false });
    } catch (e) {
      threwReal = true;
      errReal = e.message.split('\n')[0];
    }
    const after = stat(target.path);

    check(threwReal, `${label}：write163Key(dryRun:false) 抛出错误`, errReal);
    check(after.sha256 === before.sha256, `${label}：文件 sha256 未变（一个字节都没被写）`, `${before.sha256.slice(0, 16)} -> ${after.sha256.slice(0, 16)}`);
    check(after.size === before.size, `${label}：文件大小未变`, `${before.size} -> ${after.size}`);
    check(after.mtimeMs === before.mtimeMs, `${label}：mtime 未变（没有被 touch）`, `${new Date(before.mtimeMs).toISOString()}`);
    info(`   dryRun:true 时是否抛错`, threwDry ? `是：${errDry.split('\n')[0]}` : `${C.yellow}否${C.reset}（dryRun 不落盘，不抛错也可接受）`);
  }
}

head('3. assertWritable() 直接调用也必须抛');
{
  let threw = false;
  try {
    assertWritable(path.join(ORIGINAL, 'a.mp3'));
  } catch {
    threw = true;
  }
  check(threw, 'assertWritable(E:\\CloudMusic\\a.mp3) 抛错');
  let okT = false;
  try {
    assertWritable(path.join(TARGET, 'a.mp3'));
    okT = true;
  } catch {
    okT = false;
  }
  check(okT, 'assertWritable(E:\\CloudMusic_163key\\a.mp3) 正常返回（不误拦）');
}

head('4. 反面验证：目录不存在/无此文件时，是「保护」还是「恰好失败」？');
{
  // 用一个保护目录下**不存在**的文件去调用：如果它还抛「受保护」，说明拦截发生在文件 IO 之前
  const ghost = path.join(ORIGINAL, '__definitely_not_exists__.mp3');
  let err = '';
  let threw = false;
  try {
    write163Key(ghost, KEY, { dryRun: false });
  } catch (e) {
    threw = true;
    err = e.message;
  }
  check(threw, '对保护目录下不存在的文件调用也抛错');
  const isGuardError = /受保护|保护目录|拒绝写入/.test(err);
  check(isGuardError, '抛的是「保护目录」错误而不是「文件不存在」错误（证明拦截顺序正确）', err.split('\n')[0]);
  info('   完整错误信息', JSON.stringify(err.split('\n')[0]));
}

head('5. 保护目录快照复核：全部 57 个文件的 sha256/mtime 仍未变');
{
  // 用本轮审计刚开始时拍的基线比对（如果基线存在）
  const basePath = new URL('./artifacts/baseline-original.json', import.meta.url);
  const baseBackupPath = new URL('./artifacts/baseline-backup.json', import.meta.url);
  if (fs.existsSync(basePath) && fs.existsSync(baseBackupPath)) {
    const base = JSON.parse(fs.readFileSync(basePath, 'utf8'));
    const baseB = JSON.parse(fs.readFileSync(baseBackupPath, 'utf8'));
    let changed = 0;
    for (const [name, rec] of Object.entries(base)) {
      const p = path.join(ORIGINAL, name);
      if (!fs.existsSync(p)) {
        changed++;
        check(false, `原始素材文件消失: ${name}`);
        continue;
      }
      if (sha(p) !== rec.sha256) {
        changed++;
        check(false, `原始素材被改动: ${name}`, `${rec.sha256.slice(0, 12)} -> ${sha(p).slice(0, 12)}`);
      }
    }
    for (const [name, rec] of Object.entries(baseB)) {
      const p = path.join(BACKUP, name);
      if (!fs.existsSync(p)) {
        changed++;
        check(false, `备份文件消失: ${name}`);
        continue;
      }
      if (sha(p) !== rec.sha256) {
        changed++;
        check(false, `备份被改动: ${name}`, `${rec.sha256.slice(0, 12)} -> ${sha(p).slice(0, 12)}`);
      }
    }
    check(changed === 0, `保护目录全量 sha256 与本轮审计开始时一致（原始 ${Object.keys(base).length} + 备份 ${Object.keys(baseB).length} 个文件）`);
  } else {
    check(false, '缺少基线快照 verify/artifacts/baseline-*.json，无法做全量比对');
  }
}

head('6. 拒绝信息的可读性');
{
  let msg = '';
  try {
    write163Key(path.join(ORIGINAL, 'a.mp3'), KEY, { dryRun: false });
  } catch (e) {
    msg = e.message;
  }
  info('完整错误文本', JSON.stringify(msg));
  check(/E:\\CloudMusic/.test(msg), '错误信息里点名了被拒的路径');
  check(/CloudMusic_163key/.test(msg), '错误信息里给出了正确用法提示（工作副本路径）');
}

process.exitCode = summary('05-guard') ? 0 : 1;
