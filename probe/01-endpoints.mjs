// Probe 01 — which netease endpoints are alive with NO cookie?
// Run: node probe/01-endpoints.mjs
// Writes the full raw record set to probe/out/01-endpoints.json and prints a summary table.
import { BASE, probe, saveJson, sleep, summarize } from './_common.mjs';

const KW = '七里香';
const KW_ENC = encodeURIComponent(KW);
const SAMPLE_ID = 1809412694; // the real sample from the Lead's verified 163key
const JAY_ID = 186016;        // 七里香 (周杰伦)

const cases = [
  // ---------- search family ----------
  ['GET /api/search/get/web', `GET`, `${BASE}/api/search/get/web?s=${KW_ENC}&type=1&offset=0&limit=3`],
  ['GET /api/search/get?s=', `GET`, `${BASE}/api/search/get?s=${KW_ENC}&type=1&offset=0&limit=3`],
  ['POST /api/search/get (form)', `POST`, `${BASE}/api/search/get`, { s: KW, type: '1', offset: '0', limit: '3' }],
  ['GET /api/search/suggest/web', `GET`, `${BASE}/api/search/suggest/web?s=${KW_ENC}&limit=3`],
  ['POST /api/cloudsearch/pc', `POST`, `${BASE}/api/cloudsearch/pc`, { s: KW, type: '1', offset: '0', limit: '3', total: 'true' }],
  ['GET /api/cloudsearch/pc?', `GET`, `${BASE}/api/cloudsearch/pc?s=${KW_ENC}&type=1&offset=0&limit=3`],
  ['POST /api/linux/forward (eapi-ish)', `POST`, `${BASE}/api/linux/forward`, { s: KW, type: '1', offset: '0', limit: '3' }],

  // ---------- song detail family ----------
  ['GET /api/song/detail/?ids=[x]', `GET`, `${BASE}/api/song/detail/?ids=[${SAMPLE_ID}]`],
  ['GET /api/song/detail?ids=x', `GET`, `${BASE}/api/song/detail?ids=${SAMPLE_ID}`],
  ['GET /api/v3/song/detail?c=', `GET`, `${BASE}/api/v3/song/detail?c=${encodeURIComponent(JSON.stringify([{ id: SAMPLE_ID }]))}`],
  ['POST /api/v3/song/detail', `POST`, `${BASE}/api/v3/song/detail`, { c: JSON.stringify([{ id: SAMPLE_ID }]) }],
  ['GET /api/song/detail/?ids=[jay]', `GET`, `${BASE}/api/song/detail/?ids=[${JAY_ID}]`],

  // ---------- song url family (likely needs cookie) ----------
  ['GET /api/song/enhance/player/url?ids=', `GET`, `${BASE}/api/song/enhance/player/url?ids=[${SAMPLE_ID}]&br=320000`],
  ['GET /api/song/enhance/player/url (flac br=999000)', `GET`, `${BASE}/api/song/enhance/player/url?ids=[${JAY_ID}]&br=999000`],
  ['POST /api/song/enhance/player/url', `POST`, `${BASE}/api/song/enhance/player/url`, { ids: `[${SAMPLE_ID}]`, br: '320000' }],
  ['GET /api/song/enhance/player/url/v1', `GET`, `${BASE}/api/song/enhance/player/url/v1?ids=[${SAMPLE_ID}]&level=exhigh&encodeType=mp3`],
  ['GET /api/song/enhance/download/url', `GET`, `${BASE}/api/song/enhance/download/url?id=${SAMPLE_ID}&br=320000`],
  ['GET /api/song/url?id=', `GET`, `${BASE}/api/song/url?id=${SAMPLE_ID}&br=320000`],
  ['GET /song/media/outer/url (redirect)', `GET`, `${BASE}/song/media/outer/url?id=${SAMPLE_ID}.mp3`, { referer: undefined }],

  // ---------- extras ----------
  ['GET /api/album/{id}', `GET`, `${BASE}/api/album/121139178`],
  ['GET /api/song/lyric', `GET`, `${BASE}/api/song/lyric?id=${SAMPLE_ID}&lv=-1&kv=-1&tv=-1`],
  ['GET /api/mv/detail (mvId 0 → junk)', `GET`, `${BASE}/api/mv/detail?id=0`],
];

const out = [];
for (const [label, method, url, body] of cases) {
  const rec = await probe(label, url, { method, body });
  rec.summary = summarize(rec);
  out.push(rec);
  console.log(String(rec.summary).padEnd(46), label);
  await sleep(450); // be polite: keyless endpoints rate-limit aggressively
}

saveJson('01-endpoints.json', { generatedAt: new Date().toISOString(), query: KW, results: out });
console.log('\nsaved -> probe/out/01-endpoints.json');
