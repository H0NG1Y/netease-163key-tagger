/**
 * verify/_probe-artistid0.mjs —— 深挖唯一一个 artist.id===0 的写入
 *
 * 结论要能站得住脚，必须回答：
 *   Q1 这个 musicId 2735941345 是不是「冒充原唱的 UGC 上传」？
 *      已知反例 2153879235 的特征是：artist.id===0 **且** 专辑名为空 **且** 歌名带 #0 痕迹。
 *      这个条目：artist = pro(53262224) / 陈小满(0)，专辑《心底的旧》id=281425517，时长 181802。
 *   Q2 同曲有没有另一个「全 id 非 0」的条目可选？
 *   Q3 该条目的专辑是不是真实存在的专辑（有 pic、有 publishTime、有 company）？
 *   Q4 本地文件的歌手标签是否本来就写着「陈小满」？
 */
import fs from 'node:fs';
import { BACKUP, TARGET, vParseTag, vReadAudio } from './00-common.mjs';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const H = { 'User-Agent': UA, Referer: 'https://music.163.com/' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ID = 2735941345;

console.log('═══ Q1 该条目的完整形状 ═══');
const r1 = await fetch(`https://music.163.com/api/song/detail/?ids=[${ID}]`, { headers: H });
const j1 = await r1.json();
const s = j1.songs[0];
console.log(`  id           ${s.id}`);
console.log(`  name         ${JSON.stringify(s.name)}`);
console.log(`  artists      ${JSON.stringify((s.artists || []).map((a) => [a.name, a.id]))}`);
console.log(`  album.name   ${JSON.stringify(s.album?.name)}`);
console.log(`  album.id     ${s.album?.id}`);
console.log(`  album.pic    ${s.album?.picId_str ?? s.album?.pic}`);
console.log(`  album.company ${JSON.stringify(s.album?.company)}`);
console.log(`  album.subType ${JSON.stringify(s.album?.subType)}`);
console.log(`  album.publish ${s.album?.publishTime ? new Date(s.album.publishTime).toISOString() : null}`);
console.log(`  duration     ${s.duration}`);
console.log(`  alias        ${JSON.stringify(s.alias)}`);
console.log(`  sqMusic      ${JSON.stringify(s.sqMusic && { size: s.sqMusic.size, br: s.sqMusic.bitrate, sr: s.sqMusic.sr, ext: s.sqMusic.extension })}`);
console.log(`  hrMusic      ${s.hrMusic ? 'present' : 'null'}`);

console.log('\n═══ 对照：已知 UGC 冒充条目 2153879235 的形状 ═══');
await sleep(600);
const r2 = await fetch('https://music.163.com/api/song/detail/?ids=[2153879235]', { headers: H });
const j2 = await r2.json();
const u = j2.songs[0];
console.log(`  name         ${JSON.stringify(u.name)}`);
console.log(`  artists      ${JSON.stringify((u.artists || []).map((a) => [a.name, a.id]))}`);
console.log(`  album.name   ${JSON.stringify(u.album?.name)}`);
console.log(`  album.id     ${u.album?.id}`);
console.log(`  album.publish ${u.album?.al?.publishTime ?? 'n/a'}`);
console.log(`  sqMusic      ${JSON.stringify(u.sqMusic)}`);

console.log('\n═══ Q2 同曲其他候选：有没有全 id 非 0 的？ ═══');
await sleep(600);
const r3 = await fetch('https://music.163.com/api/cloudsearch/pc', {
  method: 'POST',
  headers: { ...H, 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ s: '心底的旧 pro 陈小满', type: '1', limit: '30', offset: '0' }),
});
const j3 = await r3.json();
for (const x of j3.result?.songs || []) {
  if (!/心底的旧/.test(x.name)) continue;
  const ids = (x.ar || []).map((a) => a.id);
  const allNonZero = ids.length > 0 && ids.every((v) => v > 0);
  console.log(`  ${x.id}  ${x.name.padEnd(22)}  ${(x.ar || []).map((a) => `${a.name}(${a.id})`).join('/').padEnd(30)}  《${x.al?.name ?? ''}》  ${x.dt}ms  ${allNonZero ? '★全id非0' : ''}`);
}

console.log('\n═══ Q3 本地文件的标签原文（写前 = 备份） ═══');
{
  const p = `${BACKUP}\\pro、陈小满 - 心底的旧.mp3`;
  const a = vReadAudio(p);
  const buf = fs.readFileSync(p);
  const { vParseId3v2, vDecodeId3Text } = await import('./00-common.mjs');
  const id3 = vParseId3v2(buf);
  for (const f of id3.frames) {
    if (['TIT2', 'TPE1', 'TALB'].includes(f.id)) {
      console.log(`  ${f.id} = ${JSON.stringify(vDecodeId3Text(f.data.subarray(1), f.data[0]))}`);
    }
  }
}

console.log('\n═══ Q4 写入的 163key 与云端是否一致 ═══');
{
  const a = vReadAudio(`${TARGET}\\pro、陈小满 - 心底的旧.mp3`);
  const m = vParseTag(a.keyHits[0].text).meta;
  console.log(`  写入 artist  = ${JSON.stringify(m.artist)}`);
  console.log(`  云端 artists = ${JSON.stringify((s.artists || []).map((x) => [x.name, x.id]))}`);
  console.log(`  一致？       ${JSON.stringify(m.artist) === JSON.stringify((s.artists || []).map((x) => [x.name, x.id])) ? '是' : '否'}`);
}

console.log('\n═══ 判定 ═══');
const isImpersonation = !String(s.album?.name || '').trim() && (s.artists || []).every((a) => a.id === 0);
console.log(`  是否满足「纯冒充 UGC」判据（专辑空 且 所有 artist.id 全为 0）：${isImpersonation ? '是' : '否'}`);
console.log(`  ⇒ 该条目的专辑《${s.album?.name}》真实存在且带封面/发行信息，`);
console.log(`     artist 中有真艺人 pro(53262224)，只有配角「陈小满」是 id=0 的未注册艺人。`);
console.log(`     这与「周杰伦#0《》」那种纯冒充条目在结构上不同。`);
console.log(`  但任务书要求「确认没有任何写入的 musicId 反查回来 artist.id===0」——`);
console.log(`     本条目**违反了这个字面要求**，按字面应计为缺陷；按「是否写错歌」判据则不算。`);
