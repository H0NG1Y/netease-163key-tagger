// 自测：元数据改写（标题/歌手/专辑/封面）是否生效、是否幂等、音频区是否一字节未动
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { build163Key } from '../lib/163key.mjs';
import { readTags, write163Key, parseId3v2, parseFlac, detectFormat } from '../lib/tags.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SCRATCH = path.join(ROOT, 'out', 'scratch');
const FIX = path.join(ROOT, 'test', 'e2e', 'src');
fs.mkdirSync(SCRATCH, { recursive: true });

const md5 = (b) => crypto.createHash('md5').update(b).digest('hex');
let pass = 0,
  fail = 0;
const ok = (c, n, extra = '') => {
  if (c) {
    pass++;
    console.log(`  \u2713 ${n}`);
  } else {
    fail++;
    console.log(`  \u2717 ${n}${extra ? '  << ' + extra : ''}`);
  }
};

function audioStart(buf) {
  const fmt = detectFormat('x', buf);
  if (fmt === 'mp3') return parseId3v2(buf)?.total ?? 0;
  if (fmt === 'flac') return parseFlac(buf)?.audioOffset ?? 0;
  return 0;
}
const audioMd5 = (f) => {
  const b = fs.readFileSync(f);
  return md5(b.subarray(audioStart(b)));
};

// 造一张真 PNG（1x1），要比对「封面真的被写进去了」
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const META = {
  title: '一路向北',
  artist: '周杰伦',
  album: '十一月的萧邦',
  albumArtist: '周杰伦',
  cover: { bytes: PNG, mime: 'image/png' },
};

const FAKE_KEY = build163Key({
  musicId: 185924,
  musicName: '一路向北',
  artist: [['周杰伦', 6452]],
  albumId: 18915,
  album: '十一月的萧邦',
  albumPicDocId: '1',
  albumPic: 'https://p1.music.163.com/x.jpg',
  bitrate: 320000,
  mp3DocId: '0'.repeat(32),
  duration: 295692,
  mvId: 0,
  alias: [],
  transNames: [],
  format: 'mp3',
});

for (const [label, srcName] of [
  ['MP3', path.join(FIX, '周杰伦 - 一路向北.mp3')],
  ['FLAC', path.join(FIX, '周杰伦 - 一路向北.flac')],
]) {
  console.log(`\n[${label}] 元数据改写`);
  const dst = path.join(SCRATCH, `meta-${label.toLowerCase()}${path.extname(srcName)}`);
  fs.copyFileSync(srcName, dst);

  const before = readTags(dst);
  const a0 = audioMd5(dst);
  const s0 = fs.statSync(dst).size;
  ok(true, `原文件 ：title=${JSON.stringify(before.title)} artist=${JSON.stringify(before.artist)} album=${JSON.stringify(before.album)}`);

  const r = write163Key(dst, FAKE_KEY, { dryRun: false, meta: META });
  ok(r.changed, `写入执行 (strategy=${r.strategy})`);

  const after = readTags(dst);
  ok(after.title === META.title, `标题 -> ${JSON.stringify(after.title)}`);
  ok(after.artist === META.artist, `歌手 -> ${JSON.stringify(after.artist)}`);
  ok(after.album === META.album, `专辑 -> ${JSON.stringify(after.album)}`);
  ok(after.key163 === FAKE_KEY, '163key 仍在且正确');
  ok(audioMd5(dst) === a0, '音频区 md5 未变（一个字节都没动）');

  const grew = fs.statSync(dst).size - s0;
  // 文件大小的变化方向不固定：
  //   - MP3 走「同尺寸原地改」时，新旧标签都塞进原有 padding，文件大小完全不变；
  //   - FLAC 换小图会变小、换大图会变大。
  // 所以这里不断言方向，只在确实变化时记录一下。
  console.log(`      文件大小 ${grew === 0 ? '不变' : (grew > 0 ? '+' : '') + grew + ' 字节'}（strategy=${r.strategy}）`);

  // 封面确实落地
  if (label === 'MP3') {
    const id3 = parseId3v2(fs.readFileSync(dst));
    const apics = id3.frames.filter((f) => f.id === 'APIC');
    ok(apics.length === 1, `只有 1 张封面（实际 ${apics.length}）`);
    ok(apics[0].data.includes(PNG.subarray(0, 32)), 'APIC 里是我们写的那张 PNG');
  } else {
    const fl = parseFlac(fs.readFileSync(dst));
    const pics = fl.blocks.filter((b) => b.type === 6);
    ok(pics.length === 1, `只有 1 个 PICTURE 块（实际 ${pics.length}）`);
    ok(pics[0].data.includes(PNG.subarray(0, 32)), 'PICTURE 里是我们写的那张 PNG');
  }

  // 幂等：同样的 patch 再写一次，文件字节不应变化。
  // 注意不能断言 strategy === 'noop'：FLAC 首次写入会重新分配 padding，
  // 之后每次虽然走 in-place 分支，但产出的字节是一样的 —— 幂等的本质是「字节不变」。
  const h1 = md5(fs.readFileSync(dst));
  const r2 = write163Key(dst, FAKE_KEY, { dryRun: false, meta: META });
  ok(md5(fs.readFileSync(dst)) === h1, `重复写入后文件哈希不变（strategy=${r2.strategy}）`);

  // 只改封面、不动文本 → 应该检测到变化
  const PNG2 = Buffer.concat([PNG, Buffer.from('extra')]);
  const r3 = write163Key(dst, FAKE_KEY, { dryRun: false, meta: { ...META, cover: { bytes: PNG2, mime: 'image/png' } } });
  ok(r3.changed, `换封面能被察觉 (strategy=${r3.strategy})`);
  ok(audioMd5(dst) === a0, '换封面后音频区仍未变');
}

console.log(`\n${'='.repeat(60)}\n通过 ${pass} / 失败 ${fail}\n`);
process.exit(fail ? 1 : 0);
