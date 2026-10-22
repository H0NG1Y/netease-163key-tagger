// Probe 07 — 选链路：把候选接口放在同一批关键字下逐个测，记录状态码/耗时/字段覆盖。
// 回答 Lead 的问题 B「search → detail 走哪条最稳」，用实测数字而不是印象。
//
// 覆盖字段的目标（生成 14 字段 meta 所需）：
//   search 需要: id, name, ar[].id/name, al.id/name, dt
//   detail 需要: al.picUrl, al.pic_str(或 picId_str), alia, mv, duration  (+ song/detail 独有的 transName)
//
// Run: node probe/07-chain-compare.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { searchSong, getSongDetail, to163Meta, getApiStats, NETEASE_BASE, DEFAULT_USER_AGENT } from '../lib/netease-api.mjs';

const KEYWORDS = [
  { keyword: '七里香', artist: '周杰伦', file: '周杰伦 - 七里香.flac' },
  { keyword: 'HOME SWEET HOME', artist: 'G-DRAGON', file: 'G-DRAGON,TAEYANG,DAESUNG - HOME SWEET HOME (feat. TAEYANG & DAESUNG).mp3' },
  { keyword: '珊瑚海', artist: '周杰伦、梁心颐', file: '周杰伦、梁心颐 - 珊瑚海.flac' },
  { keyword: '来自天堂的魔鬼', artist: 'G.E.M. 邓紫棋', file: 'G.E.M. 邓紫棋 - 来自天堂的魔鬼.mp3' },
  { keyword: '我只能离开', artist: '磨尖的粉笔', file: '磨尖的粉笔 - 我只能离开.mp3' },
];

async function raw(url, { method = 'GET', form } = {}) {
  const t0 = Date.now();
  const headers = { 'User-Agent': DEFAULT_USER_AGENT, Referer: NETEASE_BASE + '/', Accept: 'application/json, text/plain, */*' };
  let body;
  if (form) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(form).toString();
  }
  try {
    const res = await fetch(url, { method, headers, body, redirect: 'follow' });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* non-JSON */ }
    return { status: res.status, ms: Date.now() - t0, bytes: text.length, code: json?.code ?? null, json, isJson: json !== null };
  } catch (e) {
    return { status: null, ms: Date.now() - t0, bytes: 0, code: null, json: null, isJson: false, error: e.message };
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const yes = (b) => (b ? '✓' : '✗');

function searchCoverage(songs) {
  if (!Array.isArray(songs) || !songs.length) return null;
  const s = songs[0];
  const ar = s.ar ?? s.artists ?? [];
  const al = s.al ?? s.album ?? {};
  return {
    songs: songs.length,
    id: yes(Number.isFinite(Number(s.id))),
    name: yes(typeof s.name === 'string' && s.name.length > 0),
    ar_id_name: yes(ar.length > 0 && ar.every((a) => Number.isFinite(Number(a?.id)) && typeof a?.name === 'string')),
    al_id_name: yes(Number.isFinite(Number(al?.id)) && typeof al?.name === 'string' && al.name.length > 0),
    dt: yes(Number(s.dt ?? s.duration) > 0),
    al_picUrl: yes(typeof al?.picUrl === 'string' && al.picUrl.startsWith('http')),
    al_pic_str: yes(typeof (al?.pic_str ?? al?.picId_str) === 'string'),
    alia: yes(Array.isArray(s.alia ?? s.alias)),
    mv: yes(s.mv !== undefined || s.mvid !== undefined),
    transName: yes(typeof s.transName === 'string'),
  };
}

function detailCoverage(song) {
  if (!song) return null;
  const ar = song.ar ?? song.artists ?? [];
  const al = song.al ?? song.album ?? {};
  return {
    id: yes(Number.isFinite(Number(song.id))),
    name: yes(typeof song.name === 'string' && song.name.length > 0),
    ar_id_name: yes(ar.length > 0 && ar.every((a) => Number.isFinite(Number(a?.id)) && typeof a?.name === 'string')),
    al_id_name: yes(Number.isFinite(Number(al?.id)) && typeof al?.name === 'string'),
    al_picUrl: yes(typeof al?.picUrl === 'string' && al.picUrl.startsWith('http')),
    al_pic_str: yes(typeof (al?.pic_str ?? al?.picId_str) === 'string'),
    alia: yes(Array.isArray(song.alia ?? song.alias)),
    mv: yes(song.mv !== undefined || song.mvid !== undefined),
    dt: yes(Number(song.dt ?? song.duration) > 0),
    transName: yes(typeof song.transName === 'string' && song.transName.length > 0),
  };
}

const report = { generatedAt: new Date().toISOString(), keywords: [], moduleChain: [], md5: [], endpointStats: null };

for (const k of KEYWORDS) {
  console.log(`\n===== ${k.keyword}  (${k.artist}) =====`);
  const entry = { ...k, endpoints: {} };

  // --- 3 条 search 候选
  const variants = [
    { name: 'cloudsearch/pc (POST)', url: `${NETEASE_BASE}/api/cloudsearch/pc`, opts: { method: 'POST', form: { s: k.keyword, type: 1, offset: 0, limit: 10, total: true } }, pick: (j) => j?.result?.songs },
    { name: 'search/get/web (GET)', url: `${NETEASE_BASE}/api/search/get/web?s=${encodeURIComponent(k.keyword)}&type=1&offset=0&limit=10`, opts: {}, pick: (j) => j?.result?.songs },
    { name: 'search/get (POST)', url: `${NETEASE_BASE}/api/search/get`, opts: { method: 'POST', form: { s: k.keyword, type: 1, offset: 0, limit: 10 } }, pick: (j) => j?.result?.songs },
  ];
  let firstId = null;
  for (const v of variants) {
    const r = await raw(v.url, v.opts);
    const songs = r.isJson ? v.pick(r.json) : null;
    const cov = searchCoverage(songs);
    entry.endpoints[v.name] = { status: r.status, code: r.code, ms: r.ms, bytes: r.bytes, coverage: cov, error: r.error };
    if (!firstId && songs?.[0]) firstId = songs[0].id;
    console.log(`  ${v.name.padEnd(24)} HTTP ${r.status ?? '-'} code=${String(r.code).padStart(4)} ${String(r.ms).padStart(4)}ms ${String(r.bytes).padStart(7)}B songs=${cov?.songs ?? 0} ${cov ? Object.entries(cov).filter(([n]) => n !== 'songs').map(([n, val]) => `${val === '✓' ? '' : '缺少:'}${val === '✓' ? '' : n}`).join(' ') : r.error ?? ''}`);
    await sleep(350);
  }

  // --- 2 条 detail 候选（用搜索结果里的第一条 id）
  if (firstId) {
    const dv = [
      { name: 'v3/song/detail (GET)', url: `${NETEASE_BASE}/api/v3/song/detail?c=${encodeURIComponent(JSON.stringify([{ id: firstId }]))}` },
      { name: 'song/detail (GET)', url: `${NETEASE_BASE}/api/song/detail/?ids=${encodeURIComponent(JSON.stringify([firstId]))}` },
    ];
    entry.detailFor = firstId;
    for (const v of dv) {
      const r = await raw(v.url);
      const song = r.isJson ? r.json?.songs?.[0] : null;
      const cov = detailCoverage(song);
      entry.endpoints[v.name] = { status: r.status, code: r.code, ms: r.ms, bytes: r.bytes, coverage: cov, error: r.error, song };
      console.log(`  ${v.name.padEnd(24)} HTTP ${r.status ?? '-'} code=${String(r.code).padStart(4)} ${String(r.ms).padStart(4)}ms ${String(r.bytes).padStart(7)}B ${cov ? Object.entries(cov).filter(([, val]) => val === '✗').map(([n]) => '缺少:' + n).join(' ') || '全部字段齐备' : r.error ?? ''}`);
      await sleep(350);
    }

    // --- mp3DocId 可得性
    const u = await raw(`${NETEASE_BASE}/api/song/enhance/player/url?ids=${encodeURIComponent(JSON.stringify([firstId]))}&br=320000`);
    const d = u.json?.data?.[0];
    entry.md5 = { id: firstId, status: u.status, code: d?.code ?? u.json?.code, ms: u.ms, md5: d?.md5 ?? null, br: d?.br ?? null, type: d?.type ?? null, timeMs: d?.time ?? null, level: d?.level ?? null, url: d?.url ? d.url.slice(0, 90) + '…' : null };
    report.md5.push({ keyword: k.keyword, ...entry.md5 });
    console.log(`  player/url               HTTP ${u.status} code=${d?.code ?? u.json?.code} ${u.ms}ms md5=${d?.md5 ?? 'null'} br=${d?.br ?? '-'} type=${d?.type ?? '-'} time=${d?.time ?? '-'}`);
    await sleep(350);
  }

  // --- 模块链路（证明 lib 的实现真的跑通并给出 meta）
  try {
    const cands = await searchSong({ keyword: k.keyword, limit: 10 });
    const meta = await getSongDetail(firstId ?? cands[0].id);
    const final = to163Meta(meta, { format: 'flac', localDurationMs: 0 });
    entry.module = { candidates: cands.length, meta, final };
    report.moduleChain.push({ keyword: k.keyword, id: meta.musicId, meta, final });
    console.log(`  module: candidates=${cands.length} meta=${JSON.stringify({ musicId: meta.musicId, musicName: meta.musicName, albumId: meta.albumId, albumPicDocId: meta.albumPicDocId, albumPic: meta.albumPic.slice(0, 60), bitrate: meta.bitrate, mp3DocId: meta.mp3DocId, duration: meta.duration, mvId: meta.mvId, alias: meta.alias, transNames: meta.transNames, format: final.format })}`);
  } catch (e) {
    entry.moduleError = e.message.split('\n')[0];
    console.log('  module 失败: ' + entry.moduleError);
  }
  report.keywords.push(entry);
}

report.endpointStats = getApiStats();
mkdirSync(join(import.meta.dirname, 'out'), { recursive: true });
const outPath = join(import.meta.dirname, 'out', '07-chain-compare.json');
writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf8');
console.log('\nsaved -> ' + outPath);
