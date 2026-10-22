// Probe 09 — 只读检查客户端自己的曲库数据库（webdb.dat）
//
// 目的（回答问题 A 的「拿不到真实 mp3DocId 时填什么最不伤客户端」）：
//   客户端到底存不存 mp3DocId / docId / format 这些字段？存 → 我们填合成值可能被比对出来；
//   不存 → 说明客户端根本不拿它做字面比对，合成值无害。
// 做法：把 webdb.dat 复制到 %TEMP% 再只读打开（绝不直接开客户端在用的原文件，避免锁库/写库）。
//       使用 Node 内置 `node:sqlite`（本机 v24.21.0 可用，无需 npm 依赖）。
//
// Run: node probe/09-client-db.mjs
import { copyFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const SRC = join(process.env.LOCALAPPDATA ?? '', 'Netease', 'CloudMusic', 'Library', 'webdb.dat');
const COPY = join(tmpdir(), 'webdb_probe09_copy.dat');

let DatabaseSync;
try {
  ({ DatabaseSync } = await import('node:sqlite'));
} catch (e) {
  console.error('node:sqlite 不可用，无法检查客户端数据库: ' + e.message);
  process.exit(2);
}

console.log(`源库: ${SRC}  ${statSync(SRC).size} 字节`);
copyFileSync(SRC, COPY);
const db = new DatabaseSync(COPY, { readOnly: true });

const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((r) => r.name);
console.log(`\n表（${tables.length}）:`);
const interesting = ['dbTrack', 'localMatch', 'offlineTrack', 'cloudTrack'];
for (const t of tables) {
  let n = '?';
  try {
    n = db.prepare(`SELECT count(*) c FROM "${t}"`).get().c;
  } catch {}
  const schema = db.prepare('SELECT sql FROM sqlite_master WHERE name=?').get(t)?.sql ?? '';
  console.log(`  ${t.padEnd(22)} ${String(n).padStart(8)}  ${t === 'dbTrack' || interesting.includes(t) ? schema : ''}`);
}

// dbTrack 的 jsonStr 是 Web API 形状的歌曲 JSON；精确检索这些字段名，看客户端存不存 docId 概念
const FIELDS = ['"md5"', '"docId"', '"mp3DocId"', '"albumPicDocId"', '"format"', '"bitrate"', '"musicId"', '"mvid"', '"transNames"', '"duration"', '"path"', '"localPath"'];
console.log('\ndbTrack 里各字段名的命中行数（精确带引号）:');
for (const f of FIELDS) {
  const c = db.prepare('SELECT count(*) c FROM dbTrack WHERE jsonStr LIKE ?').get('%' + f + '%').c;
  console.log(`  ${f.padEnd(18)} ${c}`);
}

const one = db.prepare('SELECT id, jsonStr FROM dbTrack LIMIT 1').get();
if (one) console.log(`\ndbTrack 样例 id=${one.id}\n${one.jsonStr.slice(0, 900)}`);

// 客户端已经扫到、但因为「没有 163key」而认不出的本地文件：artists/album 全空
const locals = db
  .prepare("SELECT jsonStr FROM dbTrack WHERE jsonStr LIKE '%.flac%' OR jsonStr LIKE '%.mp3%' LIMIT 200")
  .all()
  .map((r) => JSON.parse(r.jsonStr));
console.log(`\nname 看起来是本地文件名的行: ${locals.length}`);
for (const j of locals.slice(0, 12)) {
  console.log(`  ${String(j.name).padEnd(42)} songType=${j.songType} fee=${j.fee} artists=${JSON.stringify(j.artists)} albumId=${JSON.stringify(j.album?.id)} albumName=${JSON.stringify(j.album?.name)} dur=${j.duration}`);
}
const emptyArtist = locals.filter((j) => !j.artists?.[0]?.name).length;
console.log(`\n其中 artists[0].name 为空（= 客户端认不出这首歌）的行: ${emptyArtist}/${locals.length}`);
console.log('对照：本项目写入真实 163key 后应能用 musicId 补全歌手/专辑。');
