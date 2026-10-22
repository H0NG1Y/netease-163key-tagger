/**
 * lib/match.mjs 自测：文件名解析 + 打分。纯离线。
 *   node test/match.selftest.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseFilename, nameSim, artistScore, pickBest, scoreCandidate, catalogScore, isDefiniteUgc } from '../lib/match.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
// 用备份目录：文件名与真实歌单一模一样，但它永远保持原始状态（不含 163key），
// 不受工作副本写入进度影响，测试结果稳定。可用 NETEASE_163KEY_WORK 覆盖。
const WORK = process.env.NETEASE_163KEY_WORK || path.join(ROOT, 'music-backup');
if (!fs.existsSync(WORK)) {
  console.log(`跳过：找不到测试素材目录 ${WORK}`);
  console.log('  设置环境变量 NETEASE_163KEY_WORK 指向任意音乐目录即可运行。');
  process.exit(0);
}

let pass = 0;
let fail = 0;
const ok = (c, n, extra = '') => {
  if (c) {
    pass++;
    console.log(`  \u2713 ${n}`);
  } else {
    fail++;
    console.log(`  \u2717 ${n}${extra ? '  << ' + extra : ''}`);
  }
};
const eq = (got, want, name) => ok(got === want, name, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

console.log('\n[M1] 文件名解析个案');
{
  const a = parseFilename('周杰伦 - 一路向北.mp3');
  eq(a.artist, '周杰伦', '普通：歌手');
  eq(a.title, '一路向北', '普通：歌名');
  ok(a.queries.includes('一路向北 周杰伦'), '查询串含「歌名 歌手」', JSON.stringify(a.queries));

  const b = parseFilename('Jackie - John Dreamer-亚托克斯 伴奏（Jackie remix）.mp3');
  eq(b.artist, 'Jackie', '歌名内含连字符：歌手');
  eq(b.title, 'John Dreamer-亚托克斯 伴奏（Jackie remix）', '歌名内含连字符：歌名不被切开');

  const c = parseFilename('G-DRAGON,TAEYANG,DAESUNG - HOME SWEET HOME (feat. TAEYANG & DAESUNG).mp3');
  eq(c.artists.length, 3, '多歌手按逗号切开');
  eq(c.feat.length, 2, 'feat 段抽出 2 人', JSON.stringify(c.feat));
  eq(c.titleCore, 'HOME SWEET HOME', 'titleCore 去掉 feat 段');

  const d = parseFilename('周杰伦、梁心颐 - 珊瑚海.flac');
  eq(d.artists.length, 2, '顿号分隔多歌手', JSON.stringify(d.artists));

  const e = parseFilename('G.E.M. 邓紫棋 - 来自天堂的魔鬼.mp3');
  eq(e.artist, 'G.E.M. 邓紫棋', '含英文缩写的歌手名');
  eq(e.title, '来自天堂的魔鬼', '含英文缩写的歌名');

  const f = parseFilename('周杰伦 - 说好不哭 (with 五月天阿信).flac');
  eq(f.titleCore, '说好不哭', 'with 段被剥离', JSON.stringify(f.titleCore));
  ok(f.feat.includes('五月天阿信'), 'with 段识别为合作者', JSON.stringify(f.feat));

  const g = parseFilename('艾比利 - 一个人想着一个人 (说唱版).flac');
  eq(g.title, '一个人想着一个人 (说唱版)', '括号后缀保留在标题（不误删）');

  const h = parseFilename('suhmeduh - Phone Kisses.mp3');
  eq(h.artist, 'suhmeduh', '纯英文歌手');
  eq(h.title, 'Phone Kisses', '纯英文歌名');

  const i = parseFilename('某个没有分隔符的歌.mp3');
  eq(i.artist, null, '无分隔符：歌手为 null');
  eq(i.title, '某个没有分隔符的歌', '无分隔符：整串当歌名');
}

console.log('\n[M2] 名称相似度');
{
  ok(nameSim('邓紫棋', 'G.E.M. 邓紫棋') >= 0.85, '包含关系拿到高分', String(nameSim('邓紫棋', 'G.E.M. 邓紫棋')));
  ok(nameSim('一路向北', '一路向北') === 1, '完全相同 = 1');
  ok(nameSim('一路向北', '一路向西') < 0.8, '不同歌名得分低', String(nameSim('一路向北', '一路向西')));
  ok(nameSim('Cry For Me (feat. Ami)', 'Cry For Me') >= 0.9, 'feat 段不影响核心名比对', String(nameSim('Cry For Me (feat. Ami)', 'Cry For Me')));
  ok(artistScore([{ name: '周杰伦' }], ['周杰伦']) === 1, '艺人完全相同 = 1');
  ok(artistScore([{ name: 'G.E.M. 邓紫棋' }], ['邓紫棋']) >= 0.85, '艺人包含关系');
  ok(artistScore([], ['周杰伦']) === null, '艺人缺失返回 null（不拉低总分）');
}

console.log('\n[M3] 打分与置信度');
{
  const parsed = parseFilename('周杰伦 - 一路向北.mp3');
  const good = pickBest(
    [
      { id: 1, name: '一路向北', artists: [{ id: 6452, name: '周杰伦' }], album: { id: 1, name: '十一月的萧邦' }, durationMs: 295000 },
      { id: 2, name: '一路向北', artists: [{ id: 999, name: '群星' }], album: { id: 2, name: '翻唱合集' }, durationMs: 200000 },
    ],
    parsed,
    { localDurationMs: 295500, localAlbum: '十一月的萧邦' },
  );
  eq(good.best.id, 1, '正确候选排第一');
  eq(good.confidence, 'high', '置信度 high');
  ok(good.auto === true, '自动应用 = true');

  const bad = pickBest([{ id: 3, name: '完全不一样的歌', artists: [{ name: '别的歌手' }], durationMs: 100000 }], parsed, {
    localDurationMs: 295500,
  });
  eq(bad.confidence, 'low', '不相关候选 -> low');
  ok(bad.auto === false, '低置信度不自动应用');

  const amb = pickBest(
    [
      { id: 4, name: '一路向北', artists: [{ id: 6452, name: '周杰伦' }], album: { id: 11, name: '十一月的萧邦' }, durationMs: 295000 },
      { id: 5, name: '一路向北', artists: [{ id: 6452, name: '周杰伦' }], album: { id: 12, name: '另一个合集' }, durationMs: 295000 },
    ],
    parsed,
    { localDurationMs: 295500 },
  );
  ok(amb.ambiguous === true, '同名同歌手同时长但专辑不同 -> 真歧义');
  ok(amb.confidence !== 'high', '歧义时降级置信度', amb.confidence);

  // 同发行的重复条目（同一 albumId、时长一致）：不该判为歧义，确定性择 id 最小的
  const dup = pickBest(
    [
      { id: 2659361593, name: '拼图爱', artists: [{ id: 31364543, name: '蒋孜怡' }, { id: 29938303, name: '岳燃' }], album: { id: 999, name: '拼图爱' }, durationMs: 151276 },
      { id: 2655850235, name: '拼图爱', artists: [{ id: 31364543, name: '蒋孜怡' }, { id: 29938303, name: '岳燃' }], album: { id: 999, name: '拼图爱' }, durationMs: 151276 },
    ],
    parseFilename('蒋孜怡,岳燃 - 拼图爱.mp3'),
    { localDurationMs: 151320, localAlbum: '拼图爱' },
  );
  eq(dup.ambiguous, false, '同专辑重复条目不算歧义');
  eq(dup.sameRelease, true, '标出 sameRelease');
  eq(dup.best.id, 2655850235, '确定性择 id 最小者');
  ok(dup.duplicateIds.includes(2659361593), '让位的兄弟 id 被记录', JSON.stringify(dup.duplicateIds));
  ok(dup.auto === true, '同发行重复条目可以自动应用');

  // 回归：真实歌单上 26/57 的错误命中，全都是「歌名、歌手一模一样，只有时长差一大截」
  // 的伴奏 / remix / 合辑版。时长必须能独立把这种候选打到 low 并禁止自动应用，
  // 而不是只当 10% 的加权项被名称压过去。
  const remix = pickBest(
    [
      { id: 6, name: '一路向北', artists: [{ id: 6452, name: '周杰伦' }], album: { id: 1, name: '十一月的萧邦' }, durationMs: 295500 + 30000 },
      { id: 7, name: '一路向北', artists: [{ id: 6452, name: '周杰伦' }], album: { id: 1, name: '十一月的萧邦' }, durationMs: 295500 },
    ],
    parsed,
    { localDurationMs: 295500, localAlbum: '十一月的萧邦' },
  );
  eq(remix.best.id, 7, '时长对得上的版本排在伴奏版前面');
  eq(remix.durationMismatch, false, '胜者未被标记 durationMismatch');
  ok(remix.auto === true, '时长对齐的胜者可以自动应用');

  const onlyRemix = pickBest(
    [
      { id: 8, name: '一路向北', artists: [{ id: 6452, name: '周杰伦' }], album: { id: 1, name: '十一月的萧邦' }, durationMs: 295500 + 30000 },
    ],
    parsed,
    { localDurationMs: 295500, localAlbum: '十一月的萧邦' },
  );
  eq(onlyRemix.durationMismatch, true, '只有伴奏版可选时标出 durationMismatch');
  eq(onlyRemix.confidence, 'low', '只有伴奏版可选时判定为 low');
  ok(onlyRemix.auto === false, '时长对不上的候选绝不自动应用');

  const s = scoreCandidate({ name: '一路向北', artists: [{ name: '周杰伦' }] }, parsed, {});
  ok(s.parts.duration === null, '没有本地时长时 duration 项为 null');
  ok(s.parts.catalog === 0.25, `无 id 无专辑 -> catalog=0.25（未知，不是 0）`, String(s.parts.catalog));
  ok(s.score > 0.9, '仅靠名称也能拿到高分（但缺专辑/id 会略低于满分）', String(s.score));
}

console.log('\n[M3b] UGC 冒充条目判别（实测特征：艺人 id=0 且无专辑名）');
{
  const parsed = parseFilename('周杰伦 - 爱在西元前.flac');
  const realFantezi = {
    id: 186114, name: '爱在西元前',
    artists: [{ id: 6452, name: '周杰伦' }],
    album: { id: 18915, name: '范特西' }, durationMs: 234253,
  };
  const compSelected = {
    id: 5234472, name: '爱在西元前',
    artists: [{ id: 6452, name: '周杰伦' }],
    album: { id: 999, name: '跨世纪金曲精选' }, durationMs: 234253,
  };
  // 实测真实存在的冒充条目：艺人 id=0、专辑名空
  const fakeOriginal = {
    id: 2153879235, name: '爱在西元前',
    artists: [{ id: 0, name: '周杰伦' }],
    album: { id: 0, name: '' }, durationMs: 234280,
  };

  ok(isDefiniteUgc(fakeOriginal) === true, '周杰伦#0《》被判为 UGC 冒充');
  ok(isDefiniteUgc(realFantezi) === false, '真专辑条目不是 UGC');
  ok(catalogScore(realFantezi) === 1, '有真 id + 有专辑 -> catalog=1');

  const r = pickBest([fakeOriginal, realFantezi, compSelected], parsed, { localDurationMs: 234253, localAlbum: '范特西' });
  eq(r.best.id, 186114, '原专辑条目胜出（UGC 被垫底、精选集输在专辑名）');
  ok(r.best.parts.album > 0.8, '专辑名参与了决胜', String(r.best.parts.album));
  ok(r.auto === true, '干净的曲库条目可以自动应用');

  // 只有 UGC 可选时，宁可不写
  const onlyFake = pickBest([fakeOriginal], parsed, { localDurationMs: 234280 });
  ok(onlyFake.ugc === true, '只有 UGC 时标出 ugc');
  ok(onlyFake.auto === false, '只有 UGC 时绝不自动应用');
  eq(onlyFake.confidence, 'low', '只有 UGC 时置信度为 low');

  // 接口没回传 id 不等于 id=0：不能误伤
  const noId = pickBest([{ id: 1, name: '爱在西元前', artists: [{ name: '周杰伦' }], album: { name: '范特西' }, durationMs: 234253 }], parsed, { localDurationMs: 234253 });
  ok(noId.ugc === false, '缺 artist.id 不被误判为 UGC');

  // 真实脏数据：部分艺人 id 为 0、但有真艺人 + 有效专辑 + 时长吻合（2735941345 pro#53262224/陈小满#0《心底的旧》）
  // 这是真条目，门禁必须放行，不能因为「有一个 id 是 0」就误伤。
  const partialZero = {
    id: 2735941345, name: '心底的旧',
    artists: [{ id: 53262224, name: 'pro' }, { id: 0, name: '陈小满' }],
    album: { id: 1, name: '心底的旧' }, durationMs: 216000,
  };
  ok(isDefiniteUgc(partialZero) === false, '仅部分艺人 id=0 且有专辑，不算 UGC');
  ok(catalogScore(partialZero) < 1 && catalogScore(partialZero) > 0, '部分 id=0 只是扣分，不等于清零', String(catalogScore(partialZero)));
  const partial = pickBest([partialZero], parseFilename('pro、陈小满 - 心底的旧.mp3'), { localDurationMs: 216036 });
  ok(partial.auto === true, '部分 id=0 的真条目仍可自动应用');
}

console.log('\n[M4] 工作副本 57 个真实文件名解析');
{
  const files = fs.readdirSync(WORK).filter((f) => /\.(mp3|flac)$/i.test(f));
  let noArtist = 0;
  const rows = [];
  for (const f of files) {
    const p = parseFilename(f);
    if (!p.artist) noArtist++;
    rows.push([f, p.artist, p.title]);
  }
  for (const [f, a, t] of rows) console.log(`      ${a ?? '(无)'} | ${t}   <- ${f}`);
  ok(noArtist === 0, `全部文件名都能切出歌手（${noArtist} 个失败）`);
  const allHaveQuery = files.every((f) => parseFilename(f).queries.length >= 2);
  ok(allHaveQuery, '每个文件都生成了 >= 2 条检索词');
}

console.log(`\n${'='.repeat(60)}\n通过 ${pass} / 失败 ${fail}\n`);
process.exit(fail ? 1 : 0);
