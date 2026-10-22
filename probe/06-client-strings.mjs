// Probe 06 — does the installed Windows client itself know these field names?
// Read-only binary scan of the Netease CloudMusic install tree for the 163key field names
// (ASCII and UTF-16LE). This is evidence about how the client consumes/creates the marker.
// Run: node probe/06-client-strings.mjs
import { readdirSync, statSync, openSync, readSync, closeSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';

const ROOT = 'C:\\Program Files\\Netease\\CloudMusic';
const NEEDLES = [
  'mp3DocId',
  'albumPicDocId',
  "163 key(Don't modify)",
  'albumPic',
  'transNames',
  'musicId',
  'music:',
];
const SKIP_EXT = new Set(['.pak', '.bin', '.dat', '.ttf', '.otf', '.woff', '.woff2', '.png', '.jpg', '.jpeg', '.gif', '.ico', '.bmp', '.mp3', '.mp4', '.zip', '.7z', '.cab', '.msi', '.msp', '.db', '.sqlite']);
const MAX_SCAN = 64 * 1024 * 1024; // 64 MiB per file is plenty for section-data strings

function find(hay, needle) {
  const out = [];
  let i = hay.indexOf(needle, 0);
  while (i !== -1 && out.length < 40) { out.push(i); i = hay.indexOf(needle, i + 1); }
  return out;
}

function context(buf, at, len, enc) {
  const from = Math.max(0, at - 96);
  const to = Math.min(buf.length, at + len + 96);
  const slice = buf.subarray(from, to);
  const s = enc === 'u16' ? slice.toString('utf16le') : slice.toString('latin1');
  return s.replace(/[\u0000-\u001f]+/g, '·').slice(0, 320);
}

const report = { root: ROOT, scanned: [], hits: {}, errors: [] };
for (const n of NEEDLES) report.hits[n] = [];

function walk(dir, depth = 0) {
  let ents;
  try { ents = readdirSync(dir, { withFileTypes: true }); } catch (e) { report.errors.push(dir + ' :: ' + e.code); return; }
  for (const e of ents) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { if (depth < 3) walk(p, depth + 1); continue; }
    if (!e.isFile()) continue;
    const ext = extname(e.name).toLowerCase();
    if (SKIP_EXT.has(ext)) continue;
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.size > MAX_SCAN) { continue; }
    let buf;
    try {
      const fd = openSync(p, 'r');
      buf = Buffer.alloc(st.size);
      readSync(fd, buf, 0, st.size, 0);
      closeSync(fd);
    } catch (err) { report.errors.push(p + ' :: ' + err.code); continue; }
    report.scanned.push({ file: p, size: st.size });
    for (const n of NEEDLES) {
      const a = find(buf, Buffer.from(n, 'latin1'));
      const u = find(buf, Buffer.from(n, 'utf16le'));
      for (const at of a.slice(0, 6)) {
        report.hits[n].push({ file: p, enc: 'ascii', offset: at, context: context(buf, at, n.length, 'ascii') });
      }
      for (const at of u.slice(0, 6)) {
        report.hits[n].push({ file: p, enc: 'utf16le', offset: at, context: context(buf, at, n.length * 2, 'u16') });
      }
    }
  }
}
walk(ROOT);

const outPath = join(import.meta.dirname, 'out', '06-client-strings.json');
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf8');

console.log(`scanned ${report.scanned.length} files under ${ROOT}`);
for (const n of NEEDLES) {
  const h = report.hits[n];
  console.log(`\n### ${JSON.stringify(n)}  hits=${h.length}`);
  for (const x of h.slice(0, 8)) {
    console.log(`  [${x.enc}] ${x.file.replace(ROOT, '…')} @${x.offset}`);
    console.log(`      ${x.context}`);
  }
}
console.log('\nfiles scanned:');
for (const s of report.scanned) console.log(`  ${String(s.size).padStart(9)}  ${s.file.replace(ROOT, '…')}`);
if (report.errors.length) console.log('\nerrors: ' + report.errors.slice(0, 10).join('; '));
console.log('\nsaved -> ' + outPath);
