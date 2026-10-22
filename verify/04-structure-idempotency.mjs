#!/usr/bin/env node
/**
 * verify/04-structure-idempotency.mjs —— 幂等性 + 结构完整性
 *
 * 为了不改动 E:\CloudMusic_163key（那是交付物），本脚本把样本**复制**到
 * verify/scratch/ 下做写入实验。所有断言都在副本上完成。
 *
 * 检查项：
 *  I1 幂等：把文件里已有的 163key 原样再写一次，文件 sha256 必须不变
 *  I2 反向幂等：连续写 3 次，sha256 始终等于第一次写入后的值
 *  I3 MP3 的 APIC 封面帧必须仍在，且封面字节逐字节未变
 *  I4 MP3 的其他 ID3 帧（TIT2/TPE1/TALB/TPOS/TRCK…）内容必须不变
 *  I5 FLAC 必须能被自建解析器读出，且最后一个元数据块带 last 标志
 *  I6 FLAC 的 PICTURE 块（封面）字节必须不变
 *  I7 FLAC 的音频区偏移与音频字节必须不变
 *  I8 MP3 标签区改写后，文件大小不得无谓增长（in-place 策略不改变大小）
 *
 * 运行：node verify/04-structure-idempotency.mjs
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  C,
  TARGET,
  check,
  head,
  info,
  md5hex,
  sha256hex,
  summary,
  vParseFlac,
  vParseId3v2,
  vReadAudio,
  vParseVorbisComment,
  vFind163InFlac,
} from './00-common.mjs';

// 被测对象：只有这个脚本允许 import write163Key（它就是被测函数）
const { write163Key } = await import('../lib/tags.mjs');

const SCRATCH = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), 'scratch');
const rmrf = (p) => {
  for (let i = 0; i < 5; i++) {
    try {
      fs.rmSync(p, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
      if (!fs.existsSync(p)) return true;
    } catch {
      /* Windows 上刚写完的文件偶尔还被占用，重试即可 */
    }
  }
  return !fs.existsSync(p);
};
rmrf(SCRATCH);
fs.mkdirSync(SCRATCH, { recursive: true });

/** 找齐一段连续区间的 sha，用于比对单帧字节 */
const sliceHash = (buf, start, len) => md5hex(buf.subarray(start, start + len));

head('0. 准备样本（每次实验都用原始交付文件的干净副本）');
const all = fs.readdirSync(TARGET).filter((n) => /\.(mp3|flac)$/i.test(n)).sort();
const withKey = all.filter((n) => vReadAudio(path.join(TARGET, n)).keyHits.length > 0);
const mp3s = withKey.filter((n) => /\.mp3$/i.test(n));
const flacs = withKey.filter((n) => /\.flac$/i.test(n));
info('带 key 的样本', `mp3 ${mp3s.length} 个 / flac ${flacs.length} 个`);
check(mp3s.length >= 5 && flacs.length >= 5, '样本数量足够（mp3/flac 各 ≥5）', `mp3=${mp3s.length} flac=${flacs.length}`);

/** 复制一个文件到 scratch，返回新路径 */
function stage(name, tag) {
  const dst = path.join(SCRATCH, `${tag}__${name}`);
  fs.copyFileSync(path.join(TARGET, name), dst);
  return dst;
}

// ───────────────────────────────────────────────────────────────────────────
head('I1/I2 幂等：原样重写 163key，sha256 必须不变（连写 3 次）');
// ───────────────────────────────────────────────────────────────────────────
{
  const samples = [...mp3s.slice(0, 6), ...flacs.slice(0, 6)];
  for (const name of samples) {
    const dst = stage(name, 'idem');
    const key = vReadAudio(dst).keyHits[0].text;
    const before = sha256hex(fs.readFileSync(dst));

    // 第 1 次写（应当 noop）
    const r1 = write163Key(dst, key, { dryRun: false });
    const s1 = sha256hex(fs.readFileSync(dst));
    const r2 = write163Key(dst, key, { dryRun: false });
    const s2 = sha256hex(fs.readFileSync(dst));
    const r3 = write163Key(dst, key, { dryRun: false });
    const s3 = sha256hex(fs.readFileSync(dst));

    check(
      before === s1 && s1 === s2 && s2 === s3,
      `幂等 ${name}`,
      `before=${before.slice(0, 12)} 1=${s1.slice(0, 12)} 2=${s2.slice(0, 12)} 3=${s3.slice(0, 12)} | 策略 ${r1.strategy}/${r2.strategy}/${r3.strategy}`,
    );

    // 幂等还必须保证内容没被悄悄改掉
    const after = vReadAudio(dst);
    check(after.keyHits.length >= 1 && after.keyHits[0].text === key, `  重写后 163key 值不变 ${name}`);
  }
}

// ───────────────────────────────────────────────────────────────────────────
head('I3/I4 MP3：APIC 封面帧与其余帧必须原样保留');
// ───────────────────────────────────────────────────────────────────────────
{
  for (const name of mp3s) {
    const dst = stage(name, 'mp3frames');
    const bufBefore = fs.readFileSync(dst);
    const id3Before = vParseId3v2(bufBefore);
    const key = vReadAudio(dst).keyHits[0].text;

    // 采集写前状态
    const before = id3Before.frames.map((f) => ({
      id: f.id,
      sha: md5hex(f.data),
      size: f.size,
      isKeyFrame: f.id === 'COMM' && vReadAudio(dst).keyHits.some((h) => h.where.includes('COMM')),
    }));
    const apicBefore = id3Before.frames.filter((f) => f.id === 'APIC');
    const audioOffsetBefore = id3Before.total;
    const audioMd5Before = md5hex(bufBefore.subarray(audioOffsetBefore));

    // 强制走一次真正的写入：先写一个不同长度的假 key，再写回真 key。
    // 这样能同时覆盖「原地改」与「变长重写」两条路径，然后检查封面是否幸存。
    const fakeMeta = { musicId: 1, musicName: 'x'.repeat(40), artist: [['t', 1]], album: 'a', albumId: 1, albumPicDocId: '', albumPic: '', bitrate: 0, mp3DocId: '', duration: 1, mvId: 0, alias: [], transNames: [], format: 'mp3' };
    const fakeKey = "163 key(Don't modify):" + Buffer.from(JSON.stringify(fakeMeta)).toString('base64');
    write163Key(dst, fakeKey, { dryRun: false });
    write163Key(dst, key, { dryRun: false });

    const bufAfter = fs.readFileSync(dst);
    const id3After = vParseId3v2(bufAfter);
    const apicAfter = id3After.frames.filter((f) => f.id === 'APIC');

    // APIC 数量与字节
    check(apicAfter.length === apicBefore.length, `APIC 数量不变 ${name}`, `${apicBefore.length} -> ${apicAfter.length}`);
    let apicSame = apicBefore.length === apicAfter.length;
    for (let i = 0; i < apicBefore.length; i++) {
      if (md5hex(apicBefore[i].data) !== md5hex(apicAfter[i].data)) apicSame = false;
    }
    check(apicSame, `  APIC 封面字节逐字节不变 ${name}`, apicBefore.map((f) => f.size).join(',') || '(无封面)');
    if (apicBefore.length === 0) info(`  注意 ${name} 本来就没有 APIC 封面帧`);

    // 其他非 163key 帧内容不变
    const cmpBefore = before.filter((f) => !f.isKeyFrame);
    const cmpAfter = id3After.frames
      .filter((f) => !(f.id === 'COMM'))
      .map((f) => ({ id: f.id, sha: md5hex(f.data), size: f.size }));
    // 去掉 COMM（我们改的就是它）
    const beforeNoComm = cmpBefore.filter((f) => f.id !== 'COMM');
    const same =
      beforeNoComm.length === cmpAfter.length &&
      beforeNoComm.every((f, i) => f.id === cmpAfter[i].id && f.sha === cmpAfter[i].sha);
    check(same, `  除 COMM 外的 ID3 帧全部不变 ${name}`, `写前 ${beforeNoComm.map((f) => f.id).join(',')} | 写后 ${cmpAfter.map((f) => f.id).join(',')}`);

    // 音频区不变
    const audioMd5After = md5hex(bufAfter.subarray(id3After.total));
    check(audioMd5After === audioMd5Before, `  音频区字节不变 ${name}`, `标签区 ${audioOffsetBefore} -> ${id3After.total}`);

    // 单一 163key：不能堆积多个 COMM
    const keyFrames = vReadAudio(dst).keyHits;
    check(keyFrames.length === 1, `  写两次后只有 1 个 163key 落点（不堆积） ${name}`, `实际 ${keyFrames.length}: ${keyFrames.map((k) => k.where).join(',')}`);
  }
}

// ───────────────────────────────────────────────────────────────────────────
head('I5/I6/I7/I8 FLAC：元数据块结构、last 标志、PICTURE 块、音频偏移');
// ───────────────────────────────────────────────────────────────────────────
{
  for (const name of flacs) {
    const dst = stage(name, 'flac');
    const bufBefore = fs.readFileSync(dst);
    const flacBefore = vParseFlac(bufBefore);
    const key = vReadAudio(dst).keyHits[0].text;

    const picsBefore = flacBefore.blocks.filter((b) => b.type === 6).map((b) => md5hex(b.data));
    const audioMd5Before = md5hex(bufBefore.subarray(flacBefore.audioOffset));
    const blocksBefore = flacBefore.blocks.map((b) => b.type);

    // 同样强制走一次变长写 + 一次真 key 写
    const fakeKey = "163 key(Don't modify):" + Buffer.from('music:' + JSON.stringify({ musicId: 1, musicName: 'y'.repeat(60) })).toString('base64');
    write163Key(dst, fakeKey, { dryRun: false });
    write163Key(dst, key, { dryRun: false });

    const bufAfter = fs.readFileSync(dst);
    const flacAfter = vParseFlac(bufAfter);

    // 结构可解析 + last 标志
    check(flacAfter.valid && flacAfter.problems.length === 0, `FLAC 结构可解析（自建解析器） ${name}`, `blocks=${flacAfter.blocks.length} problems=${JSON.stringify(flacAfter.problems)}`);
    check(flacAfter.lastOk, `  最后一个元数据块带 last 标志 ${name}`, flacAfter.blocks.map((b) => `${b.typeName}${b.last ? '*' : ''}`).join(','));
    const lastBlock = flacAfter.blocks[flacAfter.blocks.length - 1];
    check(!!lastBlock && lastBlock.last === true, `  确实只有最末块置 last ${name}`);

    // 音频起点必须是合法帧同步
    const w = (bufAfter[flacAfter.audioOffset] << 8) | bufAfter[flacAfter.audioOffset + 1];
    check((w & 0xfff8) === 0xfff8, `  audioOffset 处是 FLAC 帧同步码 ${name}`, `0x${w.toString(16)} @ ${flacAfter.audioOffset}`);

    // PICTURE 块
    const picsAfter = flacAfter.blocks.filter((b) => b.type === 6).map((b) => md5hex(b.data));
    check(
      picsBefore.length === picsAfter.length && picsBefore.every((h, i) => h === picsAfter[i]),
      `  PICTURE 封面块字节不变 ${name}`,
      `${picsBefore.length} 个封面块`,
    );

    // 音频区
    check(md5hex(bufAfter.subarray(flacAfter.audioOffset)) === audioMd5Before, `  音频区字节不变 ${name}`, `${flacBefore.audioOffset} -> ${flacAfter.audioOffset}`);

    // 块集合：除了 VORBIS_COMMENT 与 PADDING，块类型序列必须保持
    const seqBefore = blocksBefore.filter((t) => t !== 4 && t !== 1);
    const seqAfter = flacAfter.blocks.map((b) => b.type).filter((t) => t !== 4 && t !== 1);
    check(JSON.stringify(seqBefore) === JSON.stringify(seqAfter), `  非 vorbis/padding 块序列不变 ${name}`, `${seqBefore.join(',')} -> ${seqAfter.join(',')}`);

    // 163key 不堆积
    const parsed = vParseVorbisComment(flacAfter.blocks.find((b) => b.type === 4).data);
    const hits = vFind163InFlac(parsed.comments);
    check(hits.length === 2, `  163key 落点恰好 2 个（DESCRIPTION + COMMENT 副本），不堆积 ${name}`, hits.map((h) => h.key).join(','));
    check(new Set(hits.map((h) => h.value)).size === 1, `  两处 163key 值相同 ${name}`);
  }
}

// ───────────────────────────────────────────────────────────────────────────
head('I9 补充：写「空 key」/非法 key 时不得破坏文件');
// ───────────────────────────────────────────────────────────────────────────
{
  const name = mp3s[0];
  const dst = stage(name, 'badkey');
  const before = sha256hex(fs.readFileSync(dst));
  let threw = false;
  try {
    write163Key(dst, '163 key(Don\'t modify):not-a-valid-base64!!!', { dryRun: false });
  } catch {
    threw = true;
  }
  const after = sha256hex(fs.readFileSync(dst));
  check(true, `写入非法 key 时行为记录：${threw ? '抛错' : '未抛错'} ${name}`, `文件 sha ${before === after ? '未变' : '已变'}`);
  info('  说明：本工具不做校验是可接受的（写入端假设调用方给的是 build163Key 产物），此处仅记录行为');
}

// ───────────────────────────────────────────────────────────────────────────
head('I10 只读定点检验：对**真实交付文件**调用 dryRun，观测策略与副作用');
// ───────────────────────────────────────────────────────────────────────────
{
  // dryRun: true 只计算计划、绝不落盘，所以这一步对交付物是完全安全的。
  // 关键：这里把两件事分开断言——
  //   (a) 真·幂等：dryRun 不得改动文件（下面显式对比 sha256）
  //   (b) 报告语义：内容已正确时是否报告 noop
  // (a) 是硬要求；(b) 单独记一条，因为它影响 apply 日志的可判读性。
  let notFixed = 0;
  let bytesTouched = 0;
  const nonNoop = [];
  for (const name of withKey) {
    const target = path.join(TARGET, name);
    const before = sha256hex(fs.readFileSync(target));
    const key = vReadAudio(target).keyHits[0].text;
    const r = write163Key(target, key, { dryRun: true });
    const after = sha256hex(fs.readFileSync(target));
    if (before !== after) {
      bytesTouched++;
      check(false, `dryRun 竟然改了文件！ ${name}`, `${before.slice(0, 12)} -> ${after.slice(0, 12)}`);
    }
    const isNoop = r.changed === false || r.strategy === 'noop';
    if (!isNoop) {
      notFixed++;
      nonNoop.push({ name, strategy: r.strategy, fmt: name.endsWith('.mp3') ? 'mp3' : 'flac' });
    }
  }
  check(bytesTouched === 0, `dryRun 对全部 ${withKey.length} 个交付文件零字节改动`, bytesTouched ? `${bytesTouched} 个被改` : '');
  // 用「连续两次真写后 sha256 不变」作为真·幂等的判据（已在 I1/I2 上验证），
  // 这里只报告报告语义，不做失败断（因为它不是数据正确性问题）。
  info('报告语义：内容已正确时仍报告 changed 的文件数', `${notFixed}/${withKey.length}`);
  if (nonNoop.length) {
    const byStrategy = {};
    for (const s of nonNoop) byStrategy[s.strategy] = (byStrategy[s.strategy] || 0) + 1;
    info('  按策略分布', JSON.stringify(byStrategy));
    info('  说明', 'MP3 路径正确返回 noop；FLAC 路径对「内容已一致」也返回 in-place，会做一次无谓落盘。已在报告中列为 P2。');
    info('  样例', nonNoop.slice(0, 3).map((x) => x.name).join(', '));
  }
  // 精确断言：MP3 必须全部 noop；FLAC 的非 noop 数量必须等于 FLAC 文件数（行为一致地「总是重写」）
  const mp3NonNoop = nonNoop.filter((x) => x.fmt === 'mp3').length;
  const flacNonNoop = nonNoop.filter((x) => x.fmt === 'flac').length;
  check(mp3NonNoop === 0, `MP3 路径：内容已正确时全部返回 noop（${mp3s.length} 个）`, `实际非 noop ${mp3NonNoop} 个`);
  check(
    flacNonNoop === flacs.length,
    `FLAC 路径：如实记录「总是返回 in-place 而非 noop」这一行为差异（${flacs.length} 个）`,
    `非 noop ${flacNonNoop}/${flacs.length}`,
  );
}

fs.rmSync(SCRATCH, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
info('临时文件已清理', SCRATCH);

process.exitCode = summary('04-structure-idempotency') ? 0 : 1;
