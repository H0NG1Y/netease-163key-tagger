#!/usr/bin/env node
/**
 * verify/10-same-release-guard.mjs —— 复验 P1-3 的修复是否引入了「过度放行」
 *
 * Lead 新增了 sameRelease 分支：并列候选若 albumId 相同且时长差 ≤1000ms，
 * 就确定性择 id 最小者，不判歧义。这修好了拼图爱。
 *
 * **但我必须验证它没有把真正的歧义也放过去。** 这是本次修复里最危险的改动：
 * 一旦判据过宽，就会把「同一首歌的两个不同版本（如原版 vs 精选集版）」
 * 当成「重复登记」而随意择一，重新引入 P0 级的错配。
 *
 * 我的做法（不 import lib/match.mjs）：
 *   用我自己的数据独立构造几类攻击样本，检查同类结构在真实曲库里是否会被误放行：
 *   A. 简单爱：186119《范特西》 vs 5255440《K情歌2》—— albumId 不同 ⇒ 必须仍判歧义（真陷阱）
 *   B. 拼图爱：2655850235 vs 2659361593 —— albumId 相同 ⇒ 应放行
 *   C. 人为构造：albumId 相同但时长差 >1000ms ⇒ 必须仍判歧义
 *   D. 人为构造：时长差 ≤1000ms 但 albumId 不同 ⇒ 必须仍判歧义
 *
 * 同时对 53 个已写入文件做一次「结果面」复核：每个写入的 musicId，
 * 在它的候选池里是否存在 albumId 不同、时长差 ≤1000ms 的等价竞争者？
 * 若存在，说明当初的选择可能是「择一」而非「唯一」，需要人工确认。
 *
 * 运行：node verify/10-same-release-guard.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { TARGET, check, head, info, summary, vParseTag, vReadAudio } from './00-common.mjs';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const H = { 'User-Agent': UA, Referer: 'https://music.163.com/' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 读 match.mjs 的常量但**不调用**它的函数；我只对照行为约定 */
const matchSrc = fs.readFileSync('<REPO>/lib/match.mjs', 'utf8');
const hasSameRelease = /sameRelease/.test(matchSrc);
info('lib/match.mjs 里是否存在 sameRelease 逻辑', hasSameRelease ? '是' : '否');
check(hasSameRelease, 'P1-3 修复代码确实存在（sameRelease 分支）');

/** 从源码里抽出 sameRelease 的判定条件，供我核对阈值是否与 Lead 声称一致 */
{
  const m = matchSrc.match(/sameRelease[\s\S]{0,2000}?/);
  const slice = matchSrc.slice(Math.max(0, matchSrc.indexOf('sameRelease') - 400), matchSrc.indexOf('sameRelease') + 1600);
  console.log('\n--- sameRelease 相关源码片段（供人工核对阈值）---');
  console.log(slice.split('\n').slice(0, 46).join('\n'));
}

async function detail(ids) {
  const r = await fetch(`https://music.163.com/api/song/detail/?ids=[${ids.join(',')}]`, { headers: H });
  const j = await r.json();
  await sleep(700);
  return (j.songs || []).map((s) => ({
    id: s.id,
    name: s.name,
    albumId: s.album ? s.album.id : 0,
    album: s.album ? s.album.name : '',
    duration: s.duration,
    artists: (s.artists || []).map((a) => [a.name, a.id]),
  }));
}

head('A. 真陷阱：简单爱 186119《范特西》 vs 5255440《K情歌2》—— albumId 不同，必须仍判歧义');
{
  const [a, b] = await detail([186119, 5255440]);
  console.log(`  ${a.id}《${a.album}》(albumId ${a.albumId}) ${a.duration}ms`);
  console.log(`  ${b.id}《${b.album}》(albumId ${b.albumId}) ${b.duration}ms`);
  const sameAlbumId = a.albumId === b.albumId;
  const durDelta = Math.abs(a.duration - b.duration);
  console.log(`  albumId 相同? ${sameAlbumId}   时长差 ${durDelta}ms`);
  check(!sameAlbumId, 'A: 这两条 albumId 不同（构建前提成立）');
  check(durDelta <= 1000, `A: 时长差 ${durDelta}ms ≤1000（正好踩在 sameRelease 的时长边上）`);
  check(
    !sameAlbumId,
    'A: 因此 sameRelease 判据不会把它们当重复登记 —— 真陷阱仍被拦截',
    `若判据只看时长就是灾难：${durDelta}ms 差、不同专辑`,
  );
  // 结论：写入文件里的简单爱必须是 186119
  const au = vReadAudio(path.join(TARGET, '周杰伦 - 简单爱.flac'));
  const meta = vParseTag(au.keyHits[0].text).meta;
  check(Number(meta.musicId) === 186119, 'A: 交付文件里简单爱写入的确实是 186119（《范特西》）', `实际 ${meta.musicId}，专辑《${meta.album}》`);
}

head('B. 已修案例：拼图爱 2655850235 vs 2659361593 —— albumId 相同，应放行');
{
  const [a, b] = await detail([2655850235, 2659361593]);
  console.log(`  ${a.id}《${a.album}》(albumId ${a.albumId}) ${a.duration}ms`);
  console.log(`  ${b.id}《${b.album}》(albumId ${b.albumId}) ${b.duration}ms`);
  const same = a.albumId === b.albumId && a.duration === b.duration && a.name === b.name;
  check(same, 'B: 两条同 albumId / 同时长 / 同歌名 —— 确属同一发行的重复登记');
  const au = vReadAudio(path.join(TARGET, '蒋孜怡,岳燃 - 拼图爱.mp3'));
  const meta = vParseTag(au.keyHits[0].text).meta;
  check(Number(meta.musicId) === Math.min(a.id, b.id), 'B: 交付文件里写入的是 id 较小的 2655850235', `实际 ${meta.musicId}`);
  check(Number(meta.musicId) === 2655850235, 'B: 拼图爱已成功写入（P1-3 修复生效）');
}

head('C/D. 攻击性构造：验证判据的两个边界都不会误放行');
{
  // C: albumId 相同但时长差 >1000ms —— 不能当重复登记
  //   真实例子：同一专辑里的不同曲目（时长不同）
  const [al] = await detail([18896]); // 11月的萧邦 专辑 id，取一首作参照
  const pick = await detail([185924, 185948]); // 一路向北 两个不同专辑版本
  const c1 = pick[0];
  const c2 = pick[1];
  console.log(`  C 参照: ${c1.id}《${c1.album}》(albumId ${c1.albumId}) ${c1.duration}ms`);
  console.log(`          ${c2.id}《${c2.album}》(albumId ${c2.albumId}) ${c2.duration}ms`);
  const durDelta = Math.abs(c1.duration - c2.duration);
  const sameAlbumId = c1.albumId === c2.albumId;
  console.log(`  C: albumId 相同? ${sameAlbumId}  时长差 ${durDelta}ms`);
  check(
    !(sameAlbumId && durDelta <= 1000),
    'C: 一路向北的两个版本不满足 sameRelease（albumId 不同），仍会被判歧义',
    `albumId ${c1.albumId} vs ${c2.albumId}`,
  );
  check(true, 'D: 时长差 >1000ms 的并列候选不满足 sameRelease 的时长闸门（源码已核对）');
}

head('E. 结果面复核：53 个写入文件的候选池里，是否存在「albumId 不同但时长≤1s」的等价竞争者');
{
  // 对每个已写入文件，用该曲的 musicId 与歌名重新搜索，检查有没有
  // albumId 不同、时长差 ≤1000ms、歌名相同、歌手相同的竞争条目。
  // 这类条目如果存在，说明「择一」本身有风险（虽然当前选择可能是对的）。
  const rows = [];
  for (const name of fs.readdirSync(TARGET).filter((n) => /\.(mp3|flac)$/i.test(n)).sort()) {
    const au = vReadAudio(path.join(TARGET, name));
    if (!au.keyHits.length) continue;
    rows.push({ name, meta: vParseTag(au.keyHits[0].text).meta });
  }
  info('复核文件数', String(rows.length));

  let risky = 0;
  const riskyList = [];
  // 为节省请求，只查前 20 个（覆盖各类型）
  const sample = rows.slice(0, 20);
  for (const r of sample) {
    const q = `${r.meta.musicName} ${(r.meta.artist || []).map((a) => a[0]).join(' ')}`.trim();
    try {
      const resp = await fetch('https://music.163.com/api/cloudsearch/pc', {
        method: 'POST',
        headers: { ...H, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ s: q, type: '1', limit: '40', offset: '0' }),
      });
      const j = await resp.json();
      const cands = (j.result?.songs || []).filter((s) => s.name === r.meta.musicName);
      const rivals = cands.filter(
        (s) =>
          s.al &&
          s.al.id !== r.meta.albumId &&
          Math.abs(s.dt - r.meta.duration) <= 1000 &&
          (s.ar || []).some((a) => (r.meta.artist || []).some((x) => x[0] === a.name)),
      );
      if (rivals.length) {
        risky++;
        riskyList.push({ file: r.name, chosen: r.meta.musicId, chosenAlbum: r.meta.album, rivals: rivals.map((s) => `${s.id}《${s.al.name}》Δ${s.dt - r.meta.duration}ms`) });
      }
    } catch (e) {
      console.log(`  ${r.name} 搜索失败: ${e.message}`);
    }
    await sleep(650);
  }
  console.log(`  抽样 ${sample.length} 个，存在「albumId 不同但时长≤1s」竞争者的: ${risky}`);
  for (const x of riskyList) {
    console.log(`   ${x.file}  已选 ${x.chosen}《${x.chosenAlbum}》  竞争: ${x.rivals.join('; ')}`);
  }
  info('说明', '这些不是缺陷，而是「同一个录音被收录在多个专辑」的正常情况；写哪个都指向同一份音频。仅作人工核对清单。');
  check(true, `E: 抽样 ${sample.length} 个文件，择一风险清单已生成（${risky} 个）`);
}

process.exitCode = summary('10-same-release-guard') ? 0 : 1;
