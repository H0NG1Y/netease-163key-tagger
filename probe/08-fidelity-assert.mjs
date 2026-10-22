// Probe 08 — 断言型保真度自测（可复跑；失败时进程退出码非 0）
//
// 断言清单：
//   A. to163Meta(await getSongDetail(id), {}) 必须原样保留 musicId / musicName / artist / albumPicDocId
//      （Lead 在 out/scratch/roundtrip.mjs 里抓到的 bug：之前这四项会被丢成 null/""/[]）
//      A8/A9: duration 必须是有限数值毫秒（不是秒/字符串/0），且等于接口 dt
//   B. 只用接口值（不传本地测量）重新生成的 meta 必须与真实标签逐字段一致
//      （albumPic 允许 CDN 分片 p1~p4 不同，见 D）
//   C. 幂等 + 字段顺序固定为 META_FIELD_ORDER、恰好 14 个键
//   D. albumPic 的 CDN 分片（p2 vs p3）是否返回同一张图 —— 决定要不要按真实样本归一化
//   F. searchSong 候选的 durationMs 契约（apply.mjs 的时长闸门依赖它；null=未知，0=明确不符）
//   G. to163Meta 的 duration 取值口径与 NaN 自检（接口 dt 优先于 localDurationMs）
//
// Run: node probe/08-fidelity-assert.mjs
import { readFileSync } from 'node:fs';
import { createDecipheriv, createHash } from 'node:crypto';
import { getSongDetail, to163Meta, searchSong, metaTo163Plain, META_FIELD_ORDER } from '../lib/netease-api.mjs';
import { pickBest, parseFilename } from '../lib/match.mjs';

const SAMPLE = 'D:\\HonGLY\\思想道德与法治\\《放下手机》\\Jackie - John Dreamer-亚托克斯 伴奏（Jackie remix）.mp3';
const KEY_HEX = '2331346c6a6b5f215c5d2630553c2728';

function readRealTag(file) {
  const buf = readFileSync(file);
  const marker = Buffer.from("163 key(Don't modify):", 'utf8');
  const at = buf.indexOf(marker);
  const start = at + marker.length;
  let end = start;
  while (end < buf.length && /[A-Za-z0-9+/=]/.test(String.fromCharCode(buf[end]))) end++;
  return buf.subarray(start, end).toString('latin1');
}
const decrypt = (b64) =>
  createDecipheriv('aes-128-ecb', Buffer.from(KEY_HEX, 'hex'), null).update(Buffer.from(b64, 'base64'), undefined, 'utf8') +
  createDecipheriv('aes-128-ecb', Buffer.from(KEY_HEX, 'hex'), null).final('utf8');

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✅ PASS' : '❌ FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

// 解密真实标签（注意：不能复用同一个 Decipheriv 实例的 update+final，见上面的写法）
const realPlainFull = readRealTag(SAMPLE);
const d = createDecipheriv('aes-128-ecb', Buffer.from(KEY_HEX, 'hex'), null);
const realPlain = d.update(Buffer.from(realPlainFull, 'base64'), undefined, 'utf8') + d.final('utf8');
const realMeta = JSON.parse(realPlain.slice('music:'.length));
console.log(`真实标签明文前缀: ${JSON.stringify(realPlain.slice(0, 6))}  musicId=${realMeta.musicId}\n`);

// --- E：纯离线 fixture（把真实标签解出来的 14 字段当作 to163Meta 的输入，不需要网络）
const fx = to163Meta(realMeta, {});
check('E1 离线 fixture：to163Meta(真实meta, {}) 与输入逐字段相同', JSON.stringify(fx) === JSON.stringify(realMeta), JSON.stringify(fx) !== JSON.stringify(realMeta) ? `\n    入: ${JSON.stringify(realMeta)}\n    出: ${JSON.stringify(fx)}` : '');
check('E2 离线 fixture：musicId 是正整数（不是 NaN/0/null）', Number.isInteger(fx.musicId) && fx.musicId > 0, String(fx.musicId));
check('E3 离线 fixture：musicName/artist/albumPicDocId 非空', Boolean(fx.musicName) && fx.artist.length > 0 && Boolean(fx.albumPicDocId), `${fx.musicName} / ${JSON.stringify(fx.artist)} / ${fx.albumPicDocId}`);
const fx2 = to163Meta({ ...realMeta, musicId: undefined, mp3DocId: undefined }, {});
check('E4 缺字段时绝不产生 NaN（musicId 回退 0 而不是 NaN）', Number.isFinite(fx2.musicId) && fx2.musicId === 0, String(fx2.musicId));

// --- A
const meta1 = await getSongDetail(realMeta.musicId);
check('A1 musicId 保留', meta1.musicId === realMeta.musicId, `得到 ${JSON.stringify(meta1.musicId)}`);
check('A2 musicName 非空且一致', meta1.musicName === realMeta.musicName, JSON.stringify(meta1.musicName));
check('A3 artist 非空且一致', JSON.stringify(meta1.artist) === JSON.stringify(realMeta.artist), JSON.stringify(meta1.artist));
check('A4 albumPicDocId 一致', meta1.albumPicDocId === realMeta.albumPicDocId, `${JSON.stringify(meta1.albumPicDocId)} vs 真实 ${JSON.stringify(realMeta.albumPicDocId)}`);
check('A5 mp3DocId 是真 md5（非回退）', meta1.mp3DocId === realMeta.mp3DocId, `${meta1.mp3DocId} vs 真实 ${realMeta.mp3DocId}`);
check('A6 duration 不再为 0', meta1.duration > 0, String(meta1.duration));
check('A7 albumId/album 一致', meta1.albumId === realMeta.albumId && meta1.album === realMeta.album, `${meta1.albumId}/${meta1.album}`);
// --- A8/A9：duration 契约（Lead 的时长闸门依赖它）—— 必须是「有限数值、单位毫秒」
check(
  'A8 duration 是有限数值且单位为毫秒（不是秒、不是字符串、不是 undefined）',
  typeof meta1.duration === 'number' && Number.isFinite(meta1.duration) && meta1.duration > 60_000 && meta1.duration < 3_600_000,
  `typeof=${typeof meta1.duration} 值=${meta1.duration}（若是秒会是 213 这种量级）`,
);
check('A9 duration 等于接口返回的 dt（不是 0、不是本地值）', meta1.duration === realMeta.duration, `${meta1.duration} vs 真实标签/接口 ${realMeta.duration}`);

// --- F：searchSong 候选的 durationMs 契约（缺了会让时长闸门静默失效）
const cands = await searchSong({ keyword: '七里香 周杰伦', limit: 10 });
const badDur = cands.filter((c) => !(Number.isFinite(c.durationMs) && c.durationMs > 0));
check(
  'F1 searchSong 每个候选都带有限正数 durationMs（毫秒）',
  cands.length > 0 && badDur.length === 0,
  `${cands.length} 个候选，缺失/非法 ${badDur.length} 个：${JSON.stringify(badDur.map((c) => [c.id, c.name, c.durationMs]))}`,
);
check(
  'F2 searchSong durationMs 是毫秒量级（不是秒）',
  cands.every((c) => c.durationMs > 30_000 && c.durationMs < 3_600_000),
  JSON.stringify(cands.slice(0, 3).map((c) => c.durationMs)),
);
// F3 的下游后果用真正生效的打分层（lib/match.mjs 的 pickBest）验证：
// 「时长未知(null)」必须不触发闸门，「时长为 0」会被当成明确不符 → 说明 mapSong 必须给 null 而不是 0。
const mk = (durationMs) => [{ id: 1, name: '七里香', artists: [{ id: 2, name: '周杰伦' }], album: { id: 3, name: '七里香' }, durationMs }];
const parsedQ = parseFilename('周杰伦 - 七里香.flac');
const unknownPick = pickBest(mk(null), parsedQ, { localDurationMs: 299_000 });
const zeroPick = pickBest(mk(0), parsedQ, { localDurationMs: 299_000 });
check(
  'F3 durationMs=null 表示「时长未知」不触发时长闸门；0 会被误判成「明确对不上」',
  unknownPick.durationMismatch === false && unknownPick.best?.durationMs === null && zeroPick.durationMismatch === true,
  `null: mismatch=${unknownPick.durationMismatch} / 0: mismatch=${zeroPick.durationMismatch}`,
);

// --- G：to163Meta 的自检必须覆盖 duration，且接口值优先于本地实测值
let g1 = null;
try {
  g1 = to163Meta({ ...realMeta, duration: Number.NaN }, {});
} catch (e) {
  g1 = { threw: e.message };
}
check(
  'G1 duration 传 NaN 时绝不外泄 NaN（要么抛错，要么回退成有限值）',
  g1 && (g1.threw ? true : Number.isFinite(g1.duration)),
  JSON.stringify(g1?.threw ?? g1?.duration),
);
const g2 = to163Meta(realMeta, { format: 'mp3', localDurationMs: 999_999 });
check(
  'G2 接口 dt 优先于 localDurationMs（真实标签用的是接口值：14/14 一致）',
  g2.duration === realMeta.duration,
  `接口值优先得到 ${g2.duration}（本地 999999 被忽略）；若本地优先会得到 999999`,
);
const g3 = to163Meta({ ...realMeta, duration: undefined }, { format: 'mp3', localDurationMs: 213_744 });
check('G3 接口 dt 缺失时回退到 localDurationMs', g3.duration === 213_744, String(g3.duration));
check(
  'G4 输出里没有任何 undefined / NaN 字段（to163Meta 末尾自检）',
  Object.values(g3).every((v) => v !== undefined && !(typeof v === 'number' && !Number.isFinite(v))),
  JSON.stringify(g3),
);

// --- C
check('C1 键数量 = 14', Object.keys(meta1).length === 14, String(Object.keys(meta1).length));
check('C2 字段顺序 = META_FIELD_ORDER', JSON.stringify(Object.keys(meta1)) === JSON.stringify(META_FIELD_ORDER));
const meta2 = await getSongDetail(realMeta.musicId);
check('C3 幂等（两次调用结果相同）', JSON.stringify(meta1) === JSON.stringify(meta2));

// --- B：只用接口值（不传任何本地测量）逐字段比对真实标签
// duration 现在由接口 dt 决定（见 G2）；本组因此同时是「接口值即可复现真实标签」的证明。
const rebuilt = to163Meta(meta1, { format: 'mp3', bitrate: realMeta.bitrate });
const normPic = (u) => String(u).replace(/\/\/p[1-4]\.music\.126\.net\//, '//pX.music.126.net/');
const diffs = [];
for (const k of META_FIELD_ORDER) {
  const a = k === 'albumPic' ? normPic(realMeta[k]) : realMeta[k];
  const b = k === 'albumPic' ? normPic(rebuilt[k]) : rebuilt[k];
  if (JSON.stringify(a) !== JSON.stringify(b)) diffs.push({ field: k, real: realMeta[k], mine: rebuilt[k] });
}
check('B1 14/14 字段与真实标签一致（albumPic 忽略 CDN 分片）', diffs.length === 0, diffs.length ? JSON.stringify(diffs) : '');
check('B2 metaTo163Plain 与真实标签明文一致（albumPic 忽略 CDN 分片）', metaTo163Plain({ ...rebuilt, albumPic: normPic(rebuilt.albumPic) === normPic(realMeta.albumPic) ? realMeta.albumPic : rebuilt.albumPic }) === realPlain, `\n    真实: ${realPlain}\n    生成: ${metaTo163Plain(rebuilt)}`);
check('B3 albumPic 分片差异', normPic(meta1.albumPic) === normPic(realMeta.albumPic), `真实 ${realMeta.albumPic.split('//')[1].split('/')[0]} / 接口 ${meta1.albumPic.split('//')[1].split('/')[0]}`);

// --- D：CDN 分片是否同一张图
async function headish(url) {
  try {
    const res = await fetch(url, { method: 'GET', headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://music.163.com/' } });
    const buf = Buffer.from(await res.arrayBuffer());
    return { status: res.status, bytes: buf.length, sha256: createHash('sha256').update(buf).digest('hex'), type: res.headers.get('content-type') };
  } catch (e) {
    return { error: e.message };
  }
}
const shards = ['p1', 'p2', 'p3', 'p4'].map((s) => [s, meta1.albumPic.replace('//p2.music.126.net/', `//${s}.music.126.net/`)]);
const pics = {};
for (const [s, u] of shards) {
  pics[s] = await headish(u);
  console.log(`   ${s}: HTTP ${pics[s].status ?? '-'} ${pics[s].bytes ?? '-'}B ${pics[s].type ?? ''} sha256=${(pics[s].sha256 ?? '').slice(0, 16)}`);
}
const hashes = new Set(Object.values(pics).map((p) => p.sha256).filter(Boolean));
check('D1 p1~p4 返回同一张图（分片可互换）', hashes.size === 1 && Object.keys(pics).length === 4, `${hashes.size} 个不同 sha256`);

console.log(`\n===== ${results.filter((r) => r.ok).length}/${results.length} 通过 =====`);
if (results.some((r) => !r.ok)) process.exitCode = 1;
