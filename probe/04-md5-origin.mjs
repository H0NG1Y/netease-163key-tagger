// Probe 04 — what IS mp3DocId, byte-for-byte?
//
// Lead already ruled out: (a) md5 of the whole .mp3 file, (b) md5 of the audio stream after
// stripping ID3. This probe enumerates every other "natural" byte-slice of the real sample and
// asks which one hashes to the mp3DocId recorded in the verified 163key
// (cde6b150f488f81c8f0d9b374d2fe2fb). If one matches, mp3DocId is a file-derived hash; if none
// matches, it is a server-side object id (and the CDN URL path already showed it as the object
// name). Both outcomes are informative, so we record all of them.
//
// Run: node probe/04-md5-origin.mjs
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';

const TARGET = 'cde6b150f488f81c8f0d9b374d2fe2fb';
const SAMPLE = '<REAL_SAMPLE:一个由官方客户端写入 163key 的真实 mp3>';

const md5 = (b) => createHash('md5').update(b).digest('hex');

/** Parse the ID3v2 header at offset 0. Returns {size, footer} or null. */
function id3v2Header(buf) {
  if (buf.length < 10 || buf.toString('latin1', 0, 3) !== 'ID3') return null;
  const major = buf[3];
  const flags = buf[5];
  const sz = ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f);
  const footer = (flags & 0x10) !== 0 ? 10 : 0;
  return { major, flags, size: 10 + sz + footer, bodyStart: 10, bodyEnd: 10 + sz };
}

/** Walk the frames of an ID3v2.3/2.4 tag, returning [{id, size, start, end}]. */
function id3Frames(buf, h) {
  const frames = [];
  let p = h.bodyStart;
  while (p + 10 <= h.bodyEnd) {
    const id = buf.toString('latin1', p, p + 4);
    if (!/^[A-Z0-9]{4}$/.test(id)) break;
    let size;
    if (h.major === 4) {
      size = ((buf[p + 4] & 0x7f) << 21) | ((buf[p + 5] & 0x7f) << 14) | ((buf[p + 6] & 0x7f) << 7) | (buf[p + 7] & 0x7f);
    } else {
      size = buf.readUInt32BE(p + 4);
    }
    const start = p + 10;
    const end = start + size;
    if (size <= 0 || end > buf.length) break;
    frames.push({ id, size, start, end });
    p = end;
  }
  return frames;
}

if (!existsSync(SAMPLE)) {
  console.error('sample missing: ' + SAMPLE);
  process.exit(2);
}
const buf = readFileSync(SAMPLE);
const h = id3v2Header(buf);
const frames = h ? id3Frames(buf, h) : [];

const candidates = [];
const add = (name, b) => candidates.push({ name, bytes: b.length, md5: md5(b), match: md5(b) === TARGET });

add('whole file', buf);
if (h) {
  add('file minus ID3v2 tag', Buffer.concat([buf.subarray(h.size)]));
  const noV1 = buf.subarray(buf.length - 128, buf.length - 125).toString('latin1') === 'TAG'
    ? buf.subarray(h.size, buf.length - 128)
    : buf.subarray(h.size);
  add('file minus ID3v2 minus ID3v1', noV1);

  // audio frames only = everything after the tag with every ID3 frame's payload removed
  const keep = [];
  let cursor = 0; // within the tag body
  for (const f of frames) {
    keep.push(buf.subarray(h.bodyStart + cursor, h.bodyStart + f.start - h.bodyStart + cursor)); // inter-frame padding
    cursor = f.end - h.bodyStart;
  }
  // simpler + exact: concat all non-ID3 bytes of the whole file
  const drop = new Set();
  for (const f of frames) for (let i = f.start; i < f.end; i++) drop.add(i);
  const stripped = [];
  for (let i = 0; i < buf.length; i++) if (i >= h.size || !drop.has(i)) stripped.push(buf[i]);
  add('file minus every ID3v2 frame payload', Buffer.from(stripped));

  for (const f of frames) add(`single ID3 frame ${f.id} payload`, buf.subarray(f.start, f.end));
}

// also try each 16-byte-aligned hex string appearing in the file
const asLatin = buf.toString('latin1');
const hexes = new Set((asLatin.match(/[0-9a-f]{32}/g) || []));
const report = {
  generatedAt: new Date().toISOString(),
  sample: SAMPLE,
  fileBytes: buf.length,
  targetMp3DocId: TARGET,
  id3v2: h ? { major: h.major, totalSize: h.size } : null,
  frames: frames.map((f) => ({ id: f.id, size: f.size })),
  candidates,
  hex32StringsInsideFile: [...hexes],
  anyMatch: candidates.some((c) => c.match),
};
const outPath = join(import.meta.dirname, 'out', '04-md5-origin.json');
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf8');

console.log(`file=${buf.length}B id3v2=${h ? 'v2.' + h.major + ' ' + h.size + 'B' : 'none'} frames=${frames.map((f) => f.id).join(',')}`);
for (const c of candidates) {
  console.log(`${c.match ? 'MATCH  ' : '       '}${String(c.bytes).padStart(10)}B  ${c.md5}  ${c.name}`);
}
console.log(`\ntarget                    ${TARGET}`);
console.log('32-hex strings embedded in the file: ' + (report.hex32StringsInsideFile.join(', ') || '(none)'));
console.log('any candidate matched: ' + report.anyMatch);
console.log('saved -> ' + outPath);
