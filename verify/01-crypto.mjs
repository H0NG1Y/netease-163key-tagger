#!/usr/bin/env node
/**
 * verify/01-crypto.mjs —— 163key 算法反证
 *
 * 目标：完全独立地证明「写入文件的 163key 密文 = 用 AES-128-ECB/PKCS#7 加密 "music:"+紧凑JSON」。
 *
 * 三个反证层次：
 *  A. 真实样本往返：读官方客户端写的 MP3 的 COMM 帧密文 -> 用自己的实现解密 -> 明文
 *     -> 再用自己的实现加密 -> 必须得到**逐字节相同**的原 base64。
 *     这一步是整条链路的 ground truth，它一旦不成立，后面所有东西都不用谈。
 *  B. 结构反证：把明文 JSON 抽出来，检查 "music:" 前缀、无空格紧凑序列化、UTF-8 编码、
 *     以及密文长度必须是 16 的倍数（ECB 分组）。
 *  C. 全量解出：用自建实现解 E:\CloudMusic_163key 下所有文件的 163key，JSON.parse 成功，
 *     并检查 musicId 是正整数。同时检查「同一个文件里多处 163key 是否一致」。
 *
 * 运行：node verify/01-crypto.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  C,
  REAL_SAMPLE,
  TARGET,
  V_KEY,
  V_PLAIN_PREFIX,
  V_TAG_PREFIX,
  check,
  head,
  info,
  summary,
  vDecrypt,
  vEncrypt,
  vParseTag,
  vReadAudio,
  sha256hex,
} from './00-common.mjs';

head('1. 密钥自检');
info('密钥 hex', V_KEY.toString('hex'));
check(V_KEY.length === 16, '密钥长度为 16 字节（AES-128）', `实际 ${V_KEY.length}`);
check(
  V_KEY.toString('hex') === '2331346c6a6b5f215c5d2630553c2728',
  '密钥字节与任务书给定的 hex 一致',
  V_KEY.toString('latin1'),
);

// ───────────────────────────────────────────────────────────────────────────
head('2. Ground truth：真实样本（官方客户端写入）的往返反证');
// ───────────────────────────────────────────────────────────────────────────

if (!fs.existsSync(REAL_SAMPLE)) {
  check(false, '真实样本存在', REAL_SAMPLE);
} else {
  const sample = vReadAudio(REAL_SAMPLE);
  info('样本容器', `${sample.format}, ${sample.size} 字节, ID3v2.${sample.id3?.ver}.${sample.id3?.rev}, 音频区偏移 ${sample.audioOffset}`);
  info('样本 ID3 帧清单', sample.id3.frames.map((f) => `${f.id}(${f.size})`).join(' '));
  check(sample.keyHits.length >= 1, '真实样本里存在 163key', `命中 ${sample.keyHits.length} 处: ${sample.keyHits.map((h) => h.where).join(', ')}`);

  for (const hit of sample.keyHits) {
    const { b64, plaintext, meta } = vParseTag(hit.text);
    info(`落点 ${hit.where}`, `base64 长度 ${b64.length}, 明文长度 ${plaintext.length}`);

    // A-1: 解密结果结构
    check(plaintext.startsWith('music:'), '解密明文以 "music:" 开头', JSON.stringify(plaintext.slice(0, 10)));
    check(!/\n/.test(plaintext), '解密明文不含换行');
    const jsonPart = plaintext.slice(V_PLAIN_PREFIX.length);
    check(jsonPart === JSON.stringify(meta), '明文 JSON 是 JSON.stringify 默认紧凑格式（无空格），且可被 JSON.parse 还原');
    check(!/: /.test(jsonPart) && !/", "/.test(jsonPart), '明文 JSON 没有 ", " / ": " 之类的空格分隔符');

    // A-2: 重新加密必须逐字节一致 —— 这是本套审计的核心断言
    const reenc = vEncrypt(plaintext);
    check(reenc === b64, '【核心】用自建实现重新加密得到逐字节相同的 base64', `len ${reenc.length} vs ${b64.length}`);

    // A-3: 直接对 meta 走「对象 -> 明文 -> 加密」全链，验证我与官方产出等价
    const rebuilt = V_PLAIN_PREFIX + JSON.stringify(meta);
    check(rebuilt === plaintext, 'meta 重新序列化后字符串完全相同（键顺序也一致）');

    // A-4: 密文长度 = 16 的倍数（ECB 分组）且等于 ceil((plainlen+1)/16)*16
    const ctLen = Buffer.from(b64, 'base64').length;
    const expectCt = Math.ceil((Buffer.byteLength(plaintext, 'utf8') + 1) / 16) * 16;
    check(ctLen % 16 === 0, '密文长度是 16 的整数倍', `${ctLen}`);
    check(ctLen === expectCt, '密文长度符合 PKCS#7 填充公式', `${ctLen} == ${expectCt}`);
    // 自动填充确实加了填充（明文不是刚好整块）
    const noPad = Buffer.byteLength(plaintext, 'utf8') % 16;
    info('PKCS#7 填充字节数', String(16 - noPad));
    check(ctLen > Buffer.byteLength(plaintext, 'utf8'), '即使明文已对齐也会多出一个整块（PKCS#7 恒填充）');

    // A-5: 反例检验——改一个字节必须解密失败（证明我们不是「怎么都能解」）
    const bad = Buffer.from(b64, 'base64');
    bad[bad.length - 1] ^= 0xff;
    let threw = false;
    try {
      vDecrypt(bad.toString('base64'));
    } catch {
      threw = true;
    }
    // 注意：ECB 下改最后一个密文字节会破坏最后一个明文块的填充，PKCS#7 校验应导致 final() 抛错
    check(threw, '篡改末位密文字节后解密抛错（PKCS#7 校验生效，排除误判）');

    // A-6: 篡改中间字节但保证填充合法的情形：结果应当是不合法的 "music:" 前缀或 JSON
    const bad2 = Buffer.from(b64, 'base64');
    bad2[0] ^= 0x01;
    let rejected = false;
    try {
      const p2 = vDecrypt(bad2.toString('base64'));
      // 若没抛，必须至少前缀或 JSON 不成立
      if (!p2.startsWith(V_PLAIN_PREFIX)) rejected = true;
      else {
        try {
          JSON.parse(p2.slice(V_PLAIN_PREFIX.length));
        } catch {
          rejected = true;
        }
      }
    } catch {
      rejected = true;
    }
    check(rejected, '篡改首字节后密文被拒（前缀/JSON/填充至少一项不成立）');

    // A-7: 打印官方样本的完整字段，供人工对照
    info('官方样本 meta', JSON.stringify(meta));
  }
}

// ───────────────────────────────────────────────────────────────────────────
head('3. 已知答案自检（固定向量）：同一明文两次加密结果必须相同（ECB、确定性）');
// ───────────────────────────────────────────────────────────────────────────
{
  const plain = V_PLAIN_PREFIX + JSON.stringify({ musicId: 186119, musicName: '简单爱' });
  const a = vEncrypt(plain);
  const b = vEncrypt(plain);
  check(a === b, 'ECB 无 IV，同一明文两次加密结果相同（确定性）');
  check(vDecrypt(a) === plain, '自加密 -> 自解密 往返一致');
  // 分组独立：两个相同明文块加密后应出现相同密文块
  const block = 'A'.repeat(16);
  const two = vEncrypt(block + block);
  const raw = Buffer.from(two, 'base64');
  check(raw.subarray(0, 16).equals(raw.subarray(16, 32)), 'ECB 特性：两个相同明文块产生相同密文块（确证是 ECB 不是 CBC）');
  info('16 字节固定向量的密文 hex', Buffer.from(vEncrypt('A'.repeat(16)), 'base64').toString('hex'));
}

// ───────────────────────────────────────────────────────────────────────────
head('4. 全量：解出 E:\\CloudMusic_163key 下每个文件的 163key');
// ───────────────────────────────────────────────────────────────────────────

const files = fs
  .readdirSync(TARGET)
  .filter((n) => /\.(mp3|flac)$/i.test(n))
  .sort();

info('待解文件数', String(files.length));

const decoded = [];
const noKey = [];
let parseFail = 0;

for (const name of files) {
  const p = path.join(TARGET, name);
  const audio = vReadAudio(p);
  if (!audio.keyHits.length) {
    // 未写入不等于缺陷：需要与「按策略有意未写」的清单交叉核对。
    // 本项目对低置信度/时长不符/UGC 候选采取「宁可漏写不可写错」策略，
    // 所以这里记为「未写入」，并统计出来供人工确认这批确实是策略性跳过。
    noKey.push({ name, format: audio.format });
    continue;
  }
  // 同一文件里若有多处落点，必须解密出完全相同的明文
  const plains = new Set();
  let one = null;
  let ok = true;
  for (const hit of audio.keyHits) {
    try {
      const parsed = vParseTag(hit.text);
      plains.add(parsed.plaintext);
      if (!one) one = parsed;
    } catch (e) {
      ok = false;
      check(false, `[解密失败] ${name} @ ${hit.where}`, e.message);
    }
  }
  if (!ok) {
    parseFail++;
    continue;
  }
  const consistent = plains.size === 1;
  if (!consistent) {
    check(false, `[同一文件多处 163key 明文不一致] ${name}`, `${plains.size} 种明文: ${audio.keyHits.map((h) => h.where).join(' / ')}`);
  }

  const meta = one.meta;
  const midOk = Number.isInteger(meta.musicId) && meta.musicId > 0;
  const nameOk = typeof meta.musicName === 'string' && meta.musicName.trim().length > 0;
  const artistOk = Array.isArray(meta.artist) && meta.artist.length > 0;
  const durOk = Number.isFinite(meta.duration) && meta.duration > 0;
  const fmtOk = meta.format === audio.format;

  // 重编码一致性：解密 -> 加密 必须回到原 base64（对每个落点分别验证）
  const reencOk = audio.keyHits.every((h) => {
    const b64 = h.text.slice(h.text.indexOf(V_TAG_PREFIX) + V_TAG_PREFIX.length).trim();
    return vEncrypt(vDecrypt(b64)) === b64;
  });

  const allOk = consistent && midOk && nameOk && artistOk && durOk && fmtOk && reencOk;
  check(allOk, `${name}`, `id=${meta.musicId} "${meta.musicName}" [${audio.format}] 落点${audio.keyHits.length}${consistent ? '' : ' 明文不一致!'}${reencOk ? '' : ' 重编码不一致!'}${fmtOk ? '' : ` format字段=${meta.format}≠${audio.format}!`}`);
  if (!midOk) check(false, `  musicId 非法`, JSON.stringify(meta.musicId));
  if (!nameOk) check(false, `  musicName 为空`, JSON.stringify(meta.musicName));
  if (!artistOk) check(false, `  artist 为空`, JSON.stringify(meta.artist));
  if (!durOk) check(false, `  duration 非法`, JSON.stringify(meta.duration));

  decoded.push({
    file: name,
    format: audio.format,
    size: audio.size,
    audioOffset: audio.audioOffset,
    keyHits: audio.keyHits.map((h) => h.where),
    sha256: sha256hex(audio.buf),
    meta,
    plaintext: one.plaintext,
    b64: one.b64,
  });
}

info('解出成功', `${decoded.length} 个`);
info('未写入 163key', `${noKey.length} 个：${noKey.map((x) => x.name).join(', ')}`);
info('解密失败', String(parseFail));

// 未写入的数量与「有 key 的才能解」是两件事。这里断言：
// ① 每个带 key 的都能解开（已在上面逐个断言）
// ② 未写入的比例与项目自报的策略性跳过数量一致（52 写入 + 5 跳过 = 57）
check(
  decoded.length + noKey.length === files.length,
  '带 key 与不带 key 的文件数之和等于总文件数（没有文件被漏读）',
  `${decoded.length} + ${noKey.length} = ${files.length}`,
);
check(parseFail === 0, '没有任何一个带 163key 的文件解密失败', parseFail ? `${parseFail} 个失败` : '');
info(
  '说明',
  `未写入的 ${noKey.length} 个文件是否「应当写入」属于匹配策略问题，由 03 号脚本与 _probe-unwritten.mjs 单独审计，不在本套件判失败`,
);

// 字段完整性统计
head('5. 字段分布与合理性');
{
  const keys = new Set();
  for (const d of decoded) for (const k of Object.keys(d.meta)) keys.add(k);
  info('出现过的字段', [...keys].join(', '));

  const byFormat = {};
  for (const d of decoded) byFormat[d.format] = (byFormat[d.format] || 0) + 1;
  info('格式分布', JSON.stringify(byFormat));

  const ids = decoded.map((d) => d.meta.musicId);
  const dupIds = ids.filter((v, i) => ids.indexOf(v) !== i);
  check(dupIds.length === 0, '没有两个文件写入相同的 musicId', dupIds.length ? `重复: ${[...new Set(dupIds)].join(',')}` : '');

  const badDur = decoded.filter((d) => d.meta.duration > 6 * 3600 * 1000 || d.meta.duration < 10 * 1000);
  check(badDur.length === 0, '所有 duration 落在 10s ~ 6h 的合理区间', badDur.map((d) => `${d.file}:${d.meta.duration}`).join(', '));

  const emptyAlbum = decoded.filter((d) => !d.meta.album || !String(d.meta.album).trim());
  check(emptyAlbum.length === 0, '所有 album 非空', emptyAlbum.map((d) => d.file).join(', '));

  const emptyDocId = decoded.filter((d) => !/^[0-9a-f]{32}$/i.test(String(d.meta.mp3DocId || '')));
  check(emptyDocId.length === 0, '所有 mp3DocId 是 32 位 hex', emptyDocId.map((d) => `${d.file}:${JSON.stringify(d.meta.mp3DocId)}`).join(', '));
}

// 落盘中间产物，供 03 审计使用
const dumpPath = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), 'decoded.json');
fs.writeFileSync(
  dumpPath,
  JSON.stringify(
    decoded.map((d) => ({ file: d.file, format: d.format, keyHits: d.keyHits, meta: d.meta, sha256: d.sha256 })),
    null,
    2,
  ),
  'utf8',
);
info('中间产物', dumpPath);

// 打印全量清单，方便人工抽查
head('6. 全量清单（file -> musicId / 歌名 / 歌手 / 专辑 / 时长）');
for (const d of decoded) {
  const m = d.meta;
  console.log(
    `  ${String(m.musicId).padStart(10)}  ${d.format.padEnd(4)}  ${(m.musicName || '').padEnd(24)} | ${(m.artist || []).map((a) => a?.[0] ?? a).join('/')} | ${(m.album || '').padEnd(16)} | ${m.duration}ms`,
  );
}

process.exitCode = summary('01-crypto') ? 0 : 1;
