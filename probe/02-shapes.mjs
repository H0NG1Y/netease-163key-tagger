// Probe 02 — deep-shape dump for the candidate chains.
// Run: node probe/02-shapes.mjs
import { BASE, probe, saveJson, sleep } from './_common.mjs';

const SAMPLE_ID = 1809412694;   // keyless-playable, real 163key sample
const VIP_ID = 186016;          // 七里香 — VIP, keyless url=null
const FREE_ID = 347230;         // 海阔天空 — long-standing free track
const FLAC_TARGET = 28718347;   // placeholder; resolved by name search below

const out = {};
async function run(key, label, url, opts = {}) {
  const rec = await probe(label, url, opts);
  out[key] = rec;
  console.log(`${rec.status ?? 'ERR'} ${rec.ms}ms  ${label}`);
  await sleep(400);
  return rec;
}

// --- cloudsearch/pc full first record (abbreviated schema) ---
const cs = await run('cloudsearch', 'POST /api/cloudsearch/pc', `${BASE}/api/cloudsearch/pc`, {
  method: 'POST',
  body: { s: '七里香 周杰伦', type: '1', offset: '0', limit: '3', total: 'true' },
});

// --- v3 song detail full record ---
const v3 = await run('v3detail', 'GET /api/v3/song/detail', `${BASE}/api/v3/song/detail?c=${encodeURIComponent(
  JSON.stringify([{ id: SAMPLE_ID }, { id: VIP_ID }, { id: FREE_ID }]),
)}`);

// --- song/detail multi-id ---
const sd = await run('detailMulti', 'GET /api/song/detail multi', `${BASE}/api/song/detail/?ids=[${SAMPLE_ID},${VIP_ID},${FREE_ID}]`);

// --- player/url for three fee profiles, default br ---
for (const [k, id] of [['pu_sample', SAMPLE_ID], ['pu_vip', VIP_ID], ['pu_free', FREE_ID]]) {
  await run(k, `player/url id=${id}`, `${BASE}/api/song/enhance/player/url?ids=[${id}]&br=320000`);
}
// --- lossless levels for the sample + vip ---
await run('pu_sample_lossless', 'player/url v1 lossless sample', `${BASE}/api/song/enhance/player/url/v1?ids=[${SAMPLE_ID}]&level=lossless&encodeType=flac`);
await run('pu_vip_lossless', 'player/url v1 lossless vip', `${BASE}/api/song/enhance/player/url/v1?ids=[${VIP_ID}]&level=lossless&encodeType=flac`);
// --- download url variants ---
await run('dl_v1', 'download/url id= sample', `${BASE}/api/song/enhance/download/url?id=${SAMPLE_ID}&br=320000`);
await run('dl_v2', 'download/url id= free', `${BASE}/api/song/enhance/download/url?id=${FREE_ID}&br=320000`);
// --- outer url (no api): does it 302 to a CDN path containing the md5? ---
await run('outer', 'song/media/outer/url sample', `${BASE}/song/media/outer/url?id=${SAMPLE_ID}.mp3`);

saveJson('02-shapes.json', { generatedAt: new Date().toISOString(), results: out });

// --- compact human-readable digest ---
console.log('\n================ DIGEST ================');
const j = out.cloudsearch.json;
if (j) {
  console.log('\n[cloudsearch/pc] result.songs[0] =');
  console.log(JSON.stringify(j.result.songs[0], null, 1).slice(0, 2500));
  console.log('\n[cloudsearch/pc] result.songCount =', j.result.songCount);
  console.log('[cloudsearch/pc] result.songs[0].privilege =', JSON.stringify(j.result.songs[0].privilege));
}
const v3j = out.v3detail.json;
if (v3j) {
  console.log('\n[v3/detail] songs[0] =');
  console.log(JSON.stringify({ al: v3j.songs[0].al, ar: v3j.songs[0].ar, alia: v3j.songs[0].alia, dt: v3j.songs[0].dt, mv: v3j.songs[0].mv, fee: v3j.songs[0].fee, h: v3j.songs[0].h, m: v3j.songs[0].m, l: v3j.songs[0].l, sq: v3j.songs[0].sq, hr: v3j.songs[0].hr, t: v3j.songs[0].t, name: v3j.songs[0].name, id: v3j.songs[0].id }, null, 1));
  console.log('\n[v3/detail] privileges =', JSON.stringify(v3j.privileges));
}
const dm = out.detailMulti.json;
if (dm) {
  console.log('\n[detail multi] per-song summary:');
  for (const s of dm.songs) {
    console.log(` id=${s.id} name=${s.name} fee=${s.fee} dur=${s.duration} mv=${s.mvid} mp3Url=${JSON.stringify(s.mp3Url)} rurl=${JSON.stringify(s.rurl)} transName=${JSON.stringify(s.transName)} alias=${JSON.stringify(s.alias)}`);
    console.log(`   hMusic=${JSON.stringify(s.hMusic)} mMusic=${JSON.stringify(s.mMusic)} lMusic=${JSON.stringify(s.lMusic)} bMusic=${JSON.stringify(s.bMusic)}`);
    console.log(`   album picId=${s.album.picId} picId_str=${s.album.picId_str} picUrl=${s.album.picUrl}`);
  }
}
for (const k of ['pu_sample', 'pu_vip', 'pu_free', 'pu_sample_lossless', 'pu_vip_lossless', 'dl_v1', 'dl_v2']) {
  const r = out[k];
  if (!r?.json) continue;
  const d = r.json.data;
  if (Array.isArray(d)) {
    console.log(`\n[${k}] ` + JSON.stringify(d.map((x) => ({ id: x.id, code: x.code, br: x.br, md5: x.md5, type: x.type, encodeType: x.encodeType, level: x.level, size: x.size, fee: x.fee, time: x.time, url: x.url ? x.url.slice(0, 120) + '…' : x.url }))));
  } else {
    console.log(`\n[${k}] ` + JSON.stringify(r.json).slice(0, 400));
  }
}
console.log('\n[outer] status=' + out.outer.status + ' location=' + JSON.stringify(out.outer.json));
