/**
 * 离线的假 API：只为验证流水线（scan -> match -> apply -> verify）能跑通，
 * 不参与真实交付。真实运行时用 lib/netease-api.mjs。
 *
 *   node apply.mjs match --api test/stub-api.mjs --root <测试目录>
 *
 * 行为：按 keyword 造 3 个候选——1 个正确、1 个「歌名歌手完全一样、只差 15 秒时长」的
 * 伴奏/remix 版（专门用来验证时长信号真的生效）、1 个无关。
 * 同一个 keyword 永远返回同一批数据（id 由 keyword 哈希得出），所以可复现。
 */

import fs from 'node:fs';

/**
 * 「题目 → 本地实测时长」映射。e2e 跑 scan 之后会写一份 test/e2e/duration-map.json，
 * 并通过 STUB_DURATION_MAP 指过来，让桩的第一个候选时长与本地文件对齐。
 * 真实网易云 API 当然不需要这个；没有这个文件时退回合成时长。
 */
let DMAP = {};
try {
  const f = process.env.STUB_DURATION_MAP;
  if (f && fs.existsSync(f)) DMAP = JSON.parse(fs.readFileSync(f, 'utf8'));
} catch {
  DMAP = {};
}

const idOf = (s) => {
  let h = 2166136261;
  for (const ch of s) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return (h % 900000) + 100000000;
};

const hashStr = (s) => {
  let h = 5381;
  for (const ch of s) h = ((h * 33) ^ ch.codePointAt(0)) >>> 0;
  return h;
};

export async function searchSong({ keyword, limit = 10 }) {
  const parts = String(keyword).trim().split(/\s+/);
  const title = parts[0];
  const artist = parts.slice(1).join(' ') || '未知歌手';
  const base = idOf(keyword);
  // 第一个候选的时长与本地实测对齐（有映射时）。第二个候选的歌名、歌手与第一个
  // 完全一样，只有时长差 15 秒——这正是真实歌单里最容易写错 musicId 的
  // 「伴奏 / remix / 合辑版」，而唯一能把它和正版区分开的信号就是时长。
  const aligned = DMAP[`${title}|${artist}`];
  const dur = Number.isFinite(aligned) ? aligned : 180000 + (hashStr(keyword) % 120000);
  const list = [
    { id: base, name: title, artists: [{ id: 1000 + (base % 500), name: artist }], album: { id: 2000, name: 'Stub Album' }, durationMs: dur },
    { id: base + 1, name: title, artists: [{ id: 999, name: artist }], album: { id: 2001, name: 'Stub Cover' }, durationMs: dur + 15000 },
    { id: base + 2, name: '完全无关的歌', artists: [{ id: 998, name: '路人甲' }], album: { id: 2002, name: 'Stub Other' }, durationMs: 90000 },
  ];
  return list.slice(0, limit);
}

export async function getSongDetail(id) {
  return {
    id,
    name: `Stub Song ${id}`,
    artists: [{ id: 1, name: 'Stub Artist' }],
    album: { id: 2000, name: 'Stub Album' },
    duration: 123456,
    albumPicDocId: 109951165606660795,
    albumPic: 'https://p3.music.126.net/xxx==/109951165606660795.jpg',
    mvId: 0,
    alias: [],
    transNames: [],
    mp3DocId: 'stubdocid' + id,
    bitrate: 320000,
  };
}

export function to163Meta(detail, { format = 'mp3', localDurationMs } = {}) {
  return {
    musicId: detail.id,
    musicName: detail.name,
    artist: (detail.artists || []).map((a) => [a.name, a.id]),
    albumId: detail.album?.id ?? 0,
    album: detail.album?.name ?? '',
    albumPicDocId: String(detail.albumPicDocId ?? ''),
    albumPic: detail.albumPic ?? '',
    bitrate: detail.bitrate ?? 320000,
    mp3DocId: detail.mp3DocId ?? '',
    duration: localDurationMs ?? (detail.duration ? detail.duration * 1000 : 0),
    mvId: detail.mvId ?? 0,
    alias: detail.alias ?? [],
    transNames: detail.transNames ?? [],
    format,
  };
}
