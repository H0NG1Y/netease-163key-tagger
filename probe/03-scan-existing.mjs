// Probe 03 — hunt the filesystem for EXISTING real 163key tags.
// Purpose: (a) get more mp3DocId data points, (b) find a real FLAC 163key to learn `format`,
//          (c) find real cases where mp3DocId is empty/zero/missing.
// Uses a raw byte search for the ASCII marker "163 key(Don't modify)" in the head+tail of
// each audio container, so it does not depend on the Lead's tag library.
// Run: node probe/03-scan-existing.mjs [dir ...]
import { readdirSync, statSync, openSync, readSync, closeSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';

const MARKER = Buffer.from("163 key(Don't modify):", 'utf8');
const AUDIO_EXT = new Set(['.mp3', '.flac', '.m4a', '.mp4', '.ncm', '.wav', '.ape', '.ogg', '.wma']);
const HEAD = 3 * 1024 * 1024; // ID3v2 / Vorbis comment / ©cmt live near the front
const TAIL = 512 * 1024;      // ID3v1 + ID3v2.4 footer

function scanFile(p) {
  const size = statSync(p).size;
  const fd = openSync(p, 'r');
  try {
    const hits = [];
    const head = Buffer.alloc(Math.min(HEAD, size));
    readSync(fd, head, 0, head.length, 0);
    let i = head.indexOf(MARKER);
    while (i !== -1) { hits.push({ at: i, region: 'head' }); i = head.indexOf(MARKER, i + 1); }
    if (size > HEAD) {
      const tl = Math.min(TAIL, size);
      const tail = Buffer.alloc(tl);
      readSync(fd, tail, 0, tl, size - tl);
      let k = tail.indexOf(MARKER);
      while (k !== -1) { hits.push({ at: size - tl + k, region: 'tail' }); k = tail.indexOf(MARKER, k + 1); }
    }
    if (!hits.length) return null;
    // extract the base64 payload that follows the marker (first hit)
    const off = hits[0].region === 'head' ? hits[0].at : null;
    let payload = null;
    if (off !== null) {
      const start = off + MARKER.length;
      const end = head.indexOf(0x00, start);
      payload = head.subarray(start, end === -1 ? start + 400 : end).toString('latin1').trim();
    }
    return { hits, payload: payload ? payload.slice(0, 400) : null };
  } finally {
    closeSync(fd);
  }
}

const roots = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['E:\\CloudMusic', 'E:\\CloudMusic_backup_20261022'];

const found = [];
const skipped = [];
let scanned = 0;
function walk(dir, depth = 0) {
  let ents;
  try { ents = readdirSync(dir, { withFileTypes: true }); } catch (e) { skipped.push(`${dir} :: ${e.code}`); return; }
  for (const e of ents) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (depth < 6) walk(p, depth + 1);
    } else if (e.isFile()) {
      const ext = e.name.slice(e.name.lastIndexOf('.')).toLowerCase();
      if (!AUDIO_EXT.has(ext)) continue;
      scanned++;
      try {
        const r = scanFile(p);
        if (r) { found.push({ file: p, size: e.size, ...r }); console.log('HIT ' + p); }
      } catch (err) { skipped.push(`${p} :: ${err.code || err.message}`); }
    }
  }
}
for (const r of roots) {
  try { if (statSync(r).isDirectory()) walk(r); else { scanned++; const x = scanFile(r); if (x) { found.push({ file: r, ...x }); console.log('HIT ' + r); } } }
  catch (e) { skipped.push(`${r} :: ${e.code}`); }
}

const outPath = join(import.meta.dirname, 'out', '03-existing-163keys.json');
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify({ roots, scanned, found, skipped }, null, 2), 'utf8');
console.log(`\nscanned=${scanned} with163key=${found.length} skipped=${skipped.length}`);
console.log('saved -> ' + outPath);
