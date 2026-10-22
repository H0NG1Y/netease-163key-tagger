/**
 * lib/tags.mjs 自测。全程只读原始素材，写入只在 out/scratch/ 下的副本上进行。
 *   node test/tags.selftest.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { build163Key, parse163Key, TAG_PREFIX } from '../lib/163key.mjs';
import {
  readTags,
  write163Key,
  detectFormat,
  parseId3v2,
  parseFlac,
  isProtected,
  addProtectedRoot,
  normalizeBitrate,
  flacBitrate,
} from '../lib/tags.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SCRATCH = path.join(ROOT, 'out', 'scratch');
fs.mkdirSync(SCRATCH, { recursive: true });

let pass = 0;
let fail = 0;
const ok = (cond, name, extra = '') => {
  if (cond) {
    pass++;
    console.log(`  \u2713 ${name}`);
  } else {
    fail++;
    console.log(`  \u2717 ${name}${extra ? '  << ' + extra : ''}`);
  }
};
const md5 = (b) => crypto.createHash('md5').update(b).digest('hex');
const sha = (f) => md5(fs.readFileSync(f));

// 测试的「原始输入」一律取**未被动过**的备份目录：它永远不含 163key。
// 绝不能指向工作副本 music/——那个目录会被真实写入，一旦里面有 key，
// 这些「写入前必须没有 key」的断言就会假失败。
// 可用 NETEASE_163KEY_WORK 覆盖，方便别人在任意目录跑自测。
const WORK = process.env.NETEASE_163KEY_WORK || path.join(ROOT, 'music-backup');
// 「写入前必须没有 163key」的用例，统一用 test/e2e/src 里那份**永远保持原始状态**的素材：
// 它是 e2e 的输入源，每次跑测试都从它复制，不会被任何流程写到。
const FIXTURES = path.join(ROOT, 'test', 'e2e', 'src');
// 本机那个「由网易云客户端亲自写下 163key」的真实样本，用于字节级双向验证。
const SAMPLE =
  process.env.NETEASE_163KEY_SAMPLE || path.join(FIXTURES, 'Jackie - John Dreamer-亚托克斯 伴奏（Jackie remix）.mp3');
const MP3_NOKEY = path.join(FIXTURES, '周杰伦 - 一路向北.mp3');
const MP3_UTF16 = `${WORK}/G-DRAGON,TAEYANG,DAESUNG - HOME SWEET HOME (feat. TAEYANG & DAESUNG).mp3`;
const FLAC = path.join(FIXTURES, '周杰伦 - 一路向北.flac');

if (!fs.existsSync(WORK)) {
  console.log(`跳过：找不到测试素材目录 ${WORK}`);
  console.log('  这是正常的——自测需要一份真实音乐库当输入。');
  console.log('  设置环境变量 NETEASE_163KEY_WORK 指向任意音乐目录即可运行。');
  process.exit(0);
}

// ── T1 真实样本：解析 → 重编码必须逐字节一致 ──────────────────
console.log('\n[T1] 真实样本（官方客户端写的 163key）');
{
  const t = readTags(SAMPLE);
  ok(t.format === 'mp3', '格式识别 = mp3', t.format);
  ok(t.id3Version === '2.3.0', `ID3 版本 = 2.3.0`, t.id3Version);
  ok(!!t.key163 && t.key163.startsWith(TAG_PREFIX), 'COMM 里有 163key');
  const meta = t.key163 ? parse163Key(t.key163) : null;
  ok(meta && meta.musicId === 1809412694, 'musicId = 1809412694', JSON.stringify(meta?.musicId));
  ok(meta && build163Key(meta) === t.key163, '重编码 163key 与原始逐字节一致');
  ok(meta && meta.format === 'mp3', '新字段 format = "mp3"', meta?.format);
}

// ── T2 无 key 的 MP3：原地写入 ───────────────────────────────
console.log('\n[T2] 无 163key 的 MP3 写入（原地）');
{
  const dst = path.join(SCRATCH, 't2.mp3');
  fs.copyFileSync(MP3_NOKEY, dst);
  const before = fs.readFileSync(dst);
  const tb = readTags(dst);
  const id3b = parseId3v2(before);
  const audioStart = id3b ? id3b.total : 0;
  const audioMd5 = md5(before.subarray(audioStart));
  const sizeB = before.length;
  const framesB = tb.frames.join(',');

  ok(tb.key163 === null, '写入前确实没有 163key');
  ok(!!id3b && id3b.frames.length >= 1, `写入前解析出 ${id3b?.frames.length} 个 ID3 帧`, framesB);

  const sampleMeta = parse163Key(readTags(SAMPLE).key163);
  const fake = build163Key({ ...sampleMeta, musicId: 186016, musicName: '一路向北' });
  const r = write163Key(dst, fake, { dryRun: false });
  console.log(`      strategy = ${r.strategy}  (原 ID3 标签总长 ${id3b.total}，padding ${id3b.padding})`);

  const after = fs.readFileSync(dst);
  const ta = readTags(dst);
  const id3a = parseId3v2(after);
  ok(ta.key163 === fake, '写入后可读回相同 163key');
  ok(
    r.strategy === 'in-place' ? after.length === sizeB : after.length > sizeB,
    `文件大小符合策略 (${sizeB} -> ${after.length}, ${r.strategy})`,
  );
  ok(md5(after.subarray(id3a.total)) === audioMd5, '音频字节 md5 完全不变');
  ok(ta.frames.includes('APIC'), '封面 APIC 帧仍在');
  ok(ta.title === tb.title && ta.artist === tb.artist && ta.album === tb.album, '标题/歌手/专辑未被破坏');
  ok(
    r.strategy !== 'in-place' || id3a.total === id3b.total,
    `原地写时 ID3 标签总长不变 (${id3b.total} -> ${id3a.total})`,
  );
  const idsA = id3a.frames.map((f) => f.id);
  const idsB = id3b.frames.map((f) => f.id);
  ok(
    idsA.filter((x) => x !== 'COMM').join(',') === idsB.filter((x) => x !== 'COMM').join(','),
    '除 COMM 外的帧保持原序',
  );
  ok(
    idsA.filter((x) => x === 'COMM').length === idsB.filter((x) => x === 'COMM').length + 1,
    'COMM 帧数 = 原有 + 1（不覆盖用户既有注释）',
  );
  ok(
    idsA.lastIndexOf('COMM') === idsA.length - 1,
    '163key 的 COMM 排在最后（客户端只取最后一个 COMM）',
  );
  const h1 = sha(dst);
  write163Key(dst, fake, { dryRun: false });
  ok(sha(dst) === h1, '重复写入同一 key 幂等（文件 md5 不变）');

  // 第一次写完后标签里已有 1024 字节 padding，换一把 key 应走原地写
  const fake2 = build163Key({ ...sampleMeta, musicId: 186017, musicName: '一路向北' });
  const size2 = fs.statSync(dst).size;
  const r2 = write163Key(dst, fake2, { dryRun: false });
  ok(r2.strategy === 'in-place', `有 padding 后自动转为原地写 (${r2.strategy})`);
  ok(fs.statSync(dst).size === size2, '原地写后文件大小不变');
  ok(readTags(dst).key163 === fake2, '原地写后可读回新 key');
  ok(md5(fs.readFileSync(dst).subarray(parseId3v2(fs.readFileSync(dst)).total)) === audioMd5, '原地写后音频 md5 仍不变');
}

// ── T3 UTF-16 / 多帧 MP3 ────────────────────────────────────
console.log('\n[T3] 另一个 MP3（UTF-16 文本帧）');
{
  const dst = path.join(SCRATCH, 't3.mp3');
  fs.copyFileSync(MP3_UTF16, dst);
  const before = fs.readFileSync(dst);
  const tb = readTags(dst);
  const id3b = parseId3v2(before);
  const audioMd5 = md5(before.subarray(id3b.total));
  const sampleMeta = parse163Key(readTags(SAMPLE).key163);
  const fake = build163Key({ ...sampleMeta, musicId: 1, musicName: tb.title || 'x' });
  const r = write163Key(dst, fake, { dryRun: false });
  const after = fs.readFileSync(dst);
  const ta = readTags(dst);
  console.log(`      strategy = ${r.strategy}`);
  ok(ta.key163 === fake, '写入后可读回');
  ok(md5(after.subarray(parseId3v2(after).total)) === audioMd5, '音频字节 md5 不变');
  ok(
    r.strategy === 'in-place' ? after.length === before.length : after.length > before.length,
    `文件大小符合策略 (${before.length} -> ${after.length}, ${r.strategy})`,
  );
  ok(ta.title === tb.title, `标题未变 (${tb.title})`);
}

// ── T4 FLAC ─────────────────────────────────────────────────
console.log('\n[T4] FLAC 写入');
{
  const dst = path.join(SCRATCH, 't4.flac');
  fs.copyFileSync(FLAC, dst);
  const before = fs.readFileSync(dst);
  const tb = readTags(dst);
  const flacB = parseFlac(before);
  const audioMd5 = md5(before.subarray(flacB.audioOffset));
  const sizeB = before.length;
  const streamsB = md5(flacB.blocks[0].data);

  ok(tb.key163 === null, 'FLAC 写入前没有 163key');
  ok(!!tb.durationMs, `FLAC 时长可读 = ${tb.durationMs}ms`);

  const sampleMeta = parse163Key(readTags(SAMPLE).key163);
  const fake = build163Key({ ...sampleMeta, musicId: 186016, musicName: '七里香', format: 'flac' });
  const r = write163Key(dst, fake, { dryRun: false });
  console.log(`      strategy = ${r.strategy}`);

  const after = fs.readFileSync(dst);
  const ta = readTags(dst);
  const flacA = parseFlac(after);
  ok(ta.key163 === fake, 'FLAC 写入后可读回 163key');

  // FLAC 的字段名：主字段必须是规范名 DESCRIPTION，并默认带一份 COMMENT 兼容副本
  const vcBlock = flacA.blocks.find((b) => b.type === 4);
  const vcText = vcBlock ? vcBlock.data.toString('latin1') : '';
  const countOf = (hay, needle) => hay.split(needle).length - 1;
  ok(vcText.includes(`DESCRIPTION=${fake}`), 'FLAC 主字段写在 DESCRIPTION');
  ok(vcText.includes(`COMMENT=${fake}`), 'FLAC 默认补写 COMMENT 兼容副本');
  ok(countOf(vcText, `DESCRIPTION=${fake}`) === 1, 'DESCRIPTION 不重复');
  ok(countOf(vcText, `COMMENT=${fake}`) === 1, 'COMMENT 副本不重复');

  ok(md5(after.subarray(flacA.audioOffset)) === audioMd5, 'FLAC 音频字节 md5 不变');
  ok(md5(flacA.blocks[0].data) === streamsB, 'STREAMINFO 块未被改动');
  ok(flacA.blocks[flacA.blocks.length - 1].last === true, '最后一个元数据块带 last 标志');
  ok(ta.title === tb.title && ta.artist === tb.artist, 'FLAC 标题/歌手未变');
  if (r.strategy === 'in-place') ok(after.length === sizeB, `原地写：文件大小不变 (${sizeB})`);
  else ok(after.length > sizeB, `重写：文件变大 (${sizeB} -> ${after.length})`);
  const h1 = sha(dst);
  write163Key(dst, fake, { dryRun: false });
  ok(sha(dst) === h1, 'FLAC 重复写入幂等');
  ok(detectFormat(dst) === 'flac', '写完后仍是合法 FLAC');

  // --no-flac-comment-copy 时只留规范字段，且仍能读回
  write163Key(dst, fake, { dryRun: false, flacCommentCopy: false });
  const flacC = parseFlac(fs.readFileSync(dst));
  const vcC = flacC.blocks.find((b) => b.type === 4).data.toString('latin1');
  ok(vcC.includes(`DESCRIPTION=${fake}`), '关掉副本后 DESCRIPTION 仍在');
  ok(!vcC.includes(`COMMENT=${fake}`), '--no-flac-comment-copy 时 COMMENT 副本被移除');
  ok(readTags(dst).key163 === fake, '关掉副本后仍能读回 163key');
}

// ── T4b 码率：必须是本地文件的实际码率，不是固定的 320000 ──────
// 回归 P1：此前 apply 没把本地码率传给 to163Meta，导致 42 个 FLAC 全写 320000
// （真实 800k~1800k）、4 个 128k 的 MP3 也写 320000。
console.log('\n[T4b] 实际码率读数');
{
  const flacT = readTags(FLAC);
  ok(flacT.bitrate > 500000, `FLAC 码率应是无损级（实测 ${flacT.bitrate}）`);
  ok(flacT.bitrate % 1000 === 0, 'FLAC 码率取整到 1000');

  const mp3T = readTags(MP3_NOKEY);
  ok(Number.isFinite(mp3T.bitrate) && mp3T.bitrate > 0, `MP3 码率可读（${mp3T.bitrate}）`);
  ok([128000, 192000, 256000, 320000, 96000, 112000].includes(mp3T.bitrate), `MP3 码率吸附到标准档位（${mp3T.bitrate}）`);

  // 128k 的文件必须读成 128000，不能随大流写 320000
  const lowBitPath = `${WORK}/Michita - Cry For Me (feat. Ami).mp3`;
  if (fs.existsSync(lowBitPath)) {
    const lowBit = readTags(lowBitPath);
    ok(lowBit.bitrate === 128000, `128k 的 MP3 读成 128000（实际 ${lowBit.bitrate}）`);
  }

  ok(normalizeBitrate(320038, 'mp3') === 320000, '320038 -> 320000');
  ok(normalizeBitrate(128014, 'mp3') === 128000, '128014 -> 128000');
  ok(normalizeBitrate(937900, 'flac') === 938000, '937900 -> 938000（无损取整到千）');
  ok(normalizeBitrate(191999, 'mp3') === 192000, '191999 -> 192000');
  ok(normalizeBitrate(null, 'mp3') === null, '无效输入返回 null');
  ok(flacBitrate(fs.readFileSync(FLAC)) > 500000, 'flacBitrate() 独立可用');
}

// ── T5 保护目录 ─────────────────────────────────────────────
// 保护谁的目录取决于使用者的机器，所以这里现造一个「备份目录」并登记为只读，
// 测的是守卫逻辑本身（路径分段比较、大小写、`..` 回退、前缀陷阱），不依赖任何绝对路径。
console.log('\n[T5] 保护目录 guard');
{
  const GUARD = path.join(SCRATCH, 'guard-backup');
  fs.mkdirSync(path.join(GUARD, 'sub', 'deep'), { recursive: true });
  addProtectedRoot(GUARD);

  ok(isProtected(GUARD) === true, '登记的保护目录自身受保护');
  ok(isProtected(path.join(GUARD, 'a.mp3')) === true, '保护目录里的文件受保护');
  ok(isProtected(path.join(GUARD, 'sub', 'deep', 'a.mp3')) === true, '深层子路径受保护');
  ok(isProtected(GUARD.toUpperCase()) === true, '全大写也拦住');
  ok(isProtected(path.join(GUARD, 'sub', '..', 'a.mp3')) === true, '父目录回退不能绕开');
  ok(isProtected(GUARD + path.sep) === true, '带尾分隔符也拦住');

  // 前缀陷阱：同前缀的兄弟目录（guard-backup-work）不能被子串比较误伤
  const SIBLING = path.join(SCRATCH, 'guard-backup-work');
  ok(isProtected(SIBLING) === false, '同前缀的兄弟目录不被误伤（路径分段比较）');
  ok(isProtected(path.join(SIBLING, 'a.mp3')) === false, '兄弟目录内的文件不被误伤');

  let threw = false;
  let msg = '';
  try {
    write163Key(path.join(GUARD, 'a.mp3'), 'x', { dryRun: true });
  } catch (e) {
    threw = /受保护/.test(String(e.message));
    msg = String(e.message);
  }
  ok(threw, '对保护目录写入被硬拒绝');
  ok(msg.includes(GUARD), '错误信息点名了被拒的路径', msg);
}

// ── T6 合成 NCM 往返 ────────────────────────────────────────
console.log('\n[T6] 合成 NCM 解析往返');
{
  const u32 = (n) => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(n >>> 0);
    return b;
  };
  const sampleMeta = parse163Key(readTags(SAMPLE).key163);
  const plain = 'music:' + JSON.stringify({ ...sampleMeta, musicId: 999, musicName: 'NCM测试' });
  const ci = crypto.createCipheriv('aes-128-ecb', Buffer.from('hzHRAmso5kInbaxW'), null);
  const ct = Buffer.concat([ci.update(Buffer.from(plain, 'utf8')), ci.final()]);
  const metaStr = TAG_PREFIX + ct.toString('base64');
  const metaBlob = Buffer.from(metaStr, 'latin1').map((x) => x ^ 0x63);
  const keyBlob = Buffer.from('0123456789abcdef', 'latin1');
  const audio = fs.readFileSync(MP3_NOKEY).subarray(0, 4096);
  const ncm = Buffer.concat([
    Buffer.from('CTENFDAM', 'latin1'),
    Buffer.alloc(2),
    u32(keyBlob.length),
    keyBlob,
    u32(metaBlob.length),
    Buffer.from(metaBlob),
    u32(0),
    Buffer.alloc(5),
    audio,
  ]);
  const p = path.join(SCRATCH, 't6.ncm');
  fs.writeFileSync(p, ncm);
  ok(detectFormat(p) === 'ncm', 'NCM 魔数识别');
  const t = readTags(p);
  ok(t.key163 === build163Key({ ...sampleMeta, musicId: 999, musicName: 'NCM测试' }), 'NCM 解出并规范化 163key');
  ok(t.title === 'NCM测试', `NCM 标题 = NCM测试 (got ${t.title})`);
  ok(t.durationMs === sampleMeta.duration, 'NCM 时长字段可读');
}

// ── T7 全量工作副本扫描（只读） ─────────────────────────────
console.log('\n[T7] 工作副本全量只读扫描');
{
  const files = fs.readdirSync(WORK).filter((f) => /\.(mp3|flac)$/i.test(f));
  const t0 = Date.now();
  const fmt = {};
  const withKey = [];
  const badKey = [];
  const bad = [];
  const durs = [];
  for (const f of files) {
    const p = path.join(WORK, f);
    try {
      const t = readTags(p);
      fmt[t.format] = (fmt[t.format] || 0) + 1;
      if (!t.format) bad.push(f);
      if (t.format === 'flac' && !t.durationMs) bad.push(f + ' (无时长)');
      if (t.format === 'mp3') durs.push([f, t.durationMs]);
      if (t.key163) {
        withKey.push(f);
        // 已有 key 的文件必须能「解密 → 重编码 → 字节一致」，否则就是写坏了
        try {
          const m = parse163Key(t.key163);
          if (!m || !Number.isFinite(m.musicId)) badKey.push(`${f} (解密失败)`);
          else if (build163Key(m) !== t.key163) badKey.push(`${f} (重编码不一致)`);
          else if (m.format && t.format && m.format !== t.format) badKey.push(`${f} (format ${m.format} ≠ 容器 ${t.format})`);
        } catch (e) {
          badKey.push(`${f}: ${e.message}`);
        }
      }
    } catch (e) {
      bad.push(`${f}: ${e.message}`);
    }
  }
  console.log(`      ${files.length} 个文件，用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(`      格式分布: ${JSON.stringify(fmt)}`);
  console.log(`      其中已有 163key: ${withKey.length} 个`);
  console.log(`      mp3 时长估算抽样: ${JSON.stringify(durs.slice(0, 4))}`);
  ok(bad.length === 0, `全部文件可解析（${bad.length} 个异常）`, bad.slice(0, 5).join(' | '));
  ok(
    badKey.length === 0,
    `已有的 ${withKey.length} 个 163key 全部可解密且重编码字节一致（${badKey.length} 个异常）`,
    badKey.slice(0, 5).join(' | '),
  );
}

// ── T8 真实世界回归：文件原本就带一个空 COMM ─────────────────
// 客户端（cloudmusic）扫描下载目录时只取「最后一个 COMM」的文本。
// 如果 key 排在原有的空 COMM 之前，客户端读到的就是空串 —— 写了等于没写。
// 实证：本机 57 个文件里，单 COMM 且含 key 的 10 个全部被认出；
// 唯一「key 在前 + 空 COMM 在后」的 HOME SWEET HOME 没有被认出。
// 复现：out/scratch/probe-carrier-slots.mjs
console.log('\n[T8] 已有空 COMM 时，163key 必须落在最后一个 COMM');
{
  const src = fs.readFileSync(MP3_NOKEY);
  const id3b = parseId3v2(src);
  const audio = src.subarray(id3b ? id3b.total : 0);

  const synchsafe = (n) => Buffer.from([(n >>> 21) & 0x7f, (n >>> 14) & 0x7f, (n >>> 7) & 0x7f, n & 0x7f]);
  const frame = (id, data) => {
    const h = Buffer.alloc(10);
    h.write(id, 0, 'latin1');
    h.writeUInt32BE(data.length, 4);
    h.writeUInt16BE(0, 8);
    return Buffer.concat([h, data]);
  };
  // 空 COMM = 编码字节 0x00 + 语言 'XXX' + 空描述 0x00 + 空正文
  const emptyComm = frame('COMM', Buffer.from([0x00, 0x58, 0x58, 0x58, 0x00]));
  const tit2 = frame('TIT2', Buffer.concat([Buffer.from([0x00]), Buffer.from('回退测试', 'utf8')]));
  const body = Buffer.concat([emptyComm, tit2]);
  const total = body.length + 1200; // padding 要够容纳一把 key 的 COMM（约 550~700 字节）
  const header = Buffer.concat([Buffer.from('ID3'), Buffer.from([3, 0, 0]), synchsafe(total)]);
  const dst = path.join(SCRATCH, 't8-empty-comm.mp3');
  fs.writeFileSync(dst, Buffer.concat([header, body, Buffer.alloc(total - body.length), audio]));

  const before = parseId3v2(fs.readFileSync(dst));
  ok(before.frames.map((f) => f.id).join(',') === 'COMM,TIT2', `构造出「空 COMM 在前」的标签 (${before.frames.map((f) => f.id).join(',')})`);

  const key = build163Key({
    musicId: 999001,
    musicName: '回退测试',
    artist: [['回退', 1]],
    albumId: 1,
    album: '回退',
    albumPicDocId: '0',
    albumPic: 'https://p1.music.126.net/x.jpg',
    bitrate: 128000,
    mp3DocId: '0'.repeat(32),
    duration: 1000,
    mvId: 0,
    alias: [],
    transNames: [],
    format: 'mp3',
  });
  const r = write163Key(dst, key, { dryRun: false });
  ok(r.strategy === 'in-place', `有 padding 时仍走同尺寸原地写 (${r.strategy})`);

  const after = parseId3v2(fs.readFileSync(dst));
  const commTexts = after.frames
    .filter((f) => f.id === 'COMM')
    .map((f) => {
      let q = 4; // 跳过编码字节 + 语言
      while (q < f.data.length && f.data[q] !== 0) q++; // 跳过描述
      q++;
      return f.data.subarray(q).toString('latin1');
    });
  ok(commTexts.length === 2, `COMM 帧数 = 2，原空 COMM 未被覆盖 (got ${commTexts.length})`);
  ok(commTexts[0] === '', `第一个 COMM 仍然是空的 (got ${JSON.stringify(commTexts[0].slice(0, 12))})`);
  ok(commTexts[1] === key, '最后一个 COMM 就是 163key（客户端能读到）');
  ok(md5(fs.readFileSync(dst).subarray(after.total)) === md5(audio), '音频字节不变');
  ok(readTags(dst).key163 === key, '写入后可读回相同 163key');
}

console.log(`\n${'='.repeat(60)}\n通过 ${pass} / 失败 ${fail}\n`);
process.exit(fail ? 1 : 0);
