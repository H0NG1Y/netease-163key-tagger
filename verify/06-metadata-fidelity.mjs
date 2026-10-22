#!/usr/bin/env node
/**
 * verify/06-metadata-fidelity.mjs —— 元数据保真度审计（对抗性）
 *
 * 前面的脚本证明了「标签写得对、音频没动」。这一份专挑更隐蔽的毛病：
 *
 *  F1  FLAC/MP3 原有标签有没有被破坏？
 *      写 163key 只应「新增」标签，绝不能吃掉用户已有的 Vorbis comment / ID3 帧。
 *      对比备份（写前）与工作副本（写后）的完整标签集合。
 *  F2  FLAC 的 DESCRIPTION 字段是否被硬塞 163key 顶掉了用户原有的 description？
 *      （Vorbis 允许同名字段重复，一旦重复，不同 TagLib 取第一条还是最后一条不一致）
 *  F3  163key 里的 bitrate 是否与真实码率相符？FLAC 是 ~900kbps，MP3 320kbps。
 *      若给 FLAC 也写 320000，客户端按位率选音质时会错。
 *  F4  163key 里的 mp3DocId 是否像真值（32 位 hex）还是回退占位符？
 *  F5  163key 里的 albumPicDocId 与 albumPic 里的数字是否一致（否则封面拉不到）？
 *  F6  duration 字段 vs 本地 STREAMINFO/帧数实测时长。
 *  F7  文件 mtime 是否被保留（客户端可能靠 mtime 决定是否重新入库）。
 *
 * 运行：node verify/06-metadata-fidelity.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { BACKUP, C, TARGET, check, head, info, summary, vParseFlac, vParseId3v2, vParseVorbisComment, vReadAudio, vParseTag } from './00-common.mjs';

const all = fs.readdirSync(TARGET).filter((n) => /\.(mp3|flac)$/i.test(n)).sort();
const rows = [];
for (const name of all) {
  const a = vReadAudio(path.join(TARGET, name));
  if (!a.keyHits.length) continue;
  rows.push({ name, a, meta: vParseTag(a.keyHits[0].text).meta });
}
info('带 163key 的文件', String(rows.length));

// ───────────────────────────────────────────────────────────────────────────
head('F1 完整标签集合：写前（备份）-> 写后（工作副本），只能「增」不能「删」');
// ───────────────────────────────────────────────────────────────────────────
{
  const destructive = [];
  const duplicate = [];

  for (const { name } of rows) {
    const before = vReadAudio(path.join(BACKUP, name));
    const after = vReadAudio(path.join(TARGET, name));

    if (after.format === 'flac') {
      const b = before.comments ? before.comments.comments : [];
      const a = after.comments ? after.comments.comments : [];
      const keyOf = (c) => {
        const eq = c.indexOf('=');
        return eq < 0 ? c : c.slice(0, eq).toUpperCase();
      };
      // 写前每个 comment（除了 key 自身）必须原样还在
      for (const c of b) {
        if (!a.includes(c)) destructive.push({ name, lost: c });
      }
      // 写后不应出现同名字段重复（除规范允许的多值：ARTIST / GENRE）
      const counts = {};
      for (const c of a) counts[keyOf(c)] = (counts[keyOf(c)] || 0) + 1;
      for (const [k, n] of Object.entries(counts)) {
        if (n > 1 && !['ARTIST', 'GENRE', 'PERFORMER'].includes(k)) {
          duplicate.push({ name, field: k, count: n });
        }
      }
    } else if (after.format === 'mp3') {
      const b = before.id3.frames.map((f) => `${f.id}:${f.data.toString('hex')}`);
      const a = after.id3.frames.map((f) => `${f.id}:${f.data.toString('hex')}`);
      // 写前除 COMM 外的帧必须原样保留
      for (const f of before.id3.frames) {
        if (f.id === 'COMM') continue;
        const sig = `${f.id}:${f.data.toString('hex')}`;
        if (!a.includes(sig)) destructive.push({ name, lost: `${f.id} (${f.size}B)` });
      }
      // 帧 id 重复检测（TIT2 之类不该有两个）
      const idc = {};
      for (const f of after.id3.frames) idc[f.id] = (idc[f.id] || 0) + 1;
      for (const [k, n] of Object.entries(idc)) {
        if (n > 1 && k !== 'COMM') duplicate.push({ name, field: k, count: n });
      }
    }
  }

  check(destructive.length === 0, '没有任何原有标签被删改（只允许新增 163key）', destructive.length ? JSON.stringify(destructive.slice(0, 8), null, 1) : '');
  check(duplicate.length === 0, '没有产生重复字段（DESCRIPTION/COMMENT/COMM 等）', duplicate.length ? JSON.stringify(duplicate.slice(0, 8), null, 1) : '');
}

// ───────────────────────────────────────────────────────────────────────────
head('F2 FLAC：DESCRIPTION 字段是否本来就存在（会被 163key 顶掉/并置）');
// ───────────────────────────────────────────────────────────────────────────
{
  let hadDesc = 0;
  let nowTwoDesc = 0;
  for (const { name, a } of rows) {
    if (a.format !== 'flac') continue;
    const before = vReadAudio(path.join(BACKUP, name));
    const bComments = before.comments ? before.comments.comments : [];
    const hadDescription = bComments.some((c) => c.toUpperCase().startsWith('DESCRIPTION='));
    if (hadDescription) {
      hadDesc++;
      info(`  原始就有 DESCRIPTION 的文件 ${name}`, bComments.filter((c) => c.toUpperCase().startsWith('DESCRIPTION=')).join(' | '));
    }
    const aComments = a.comments ? a.comments.comments : [];
    const descCount = aComments.filter((c) => c.toUpperCase().startsWith('DESCRIPTION=')).length;
    if (descCount > 1) nowTwoDesc++;
  }
  info('原始就带 DESCRIPTION 的 FLAC 数', String(hadDesc));
  check(nowTwoDesc === 0, '没有任何 FLAC 出现两条 DESCRIPTION（不会让客户端读到歧义值）', `重复的文件数 ${nowTwoDesc}`);
}

// ───────────────────────────────────────────────────────────────────────────
head('F3 bitrate：163key 里写的位率 vs 真实位率（语义判定见下）');
// ───────────────────────────────────────────────────────────────────────────
{
  // 语义判定（依据 probe/ref/163marker-core.py.txt L80 `'bitrate': audio.info.bitrate`）：
  //   163key 的 bitrate 语义是 **本地文件位率**，不是「云端最高可用档位」。
  //   官方真实样本恰好本地与云端都是 320k，单看它分不出；但 163marker 的源码写死了 audio.info.bitrate，
  //   而 163marker 正是这个字段的社区事实标准实现。
  // 因此：对 FLAC 文件写 320000 属于**语义错误**（真实无损位率 800k~1.8M）。
  const suspicious = [];
  for (const { name, a, meta } of rows) {
    let realKbps;
    if (a.format === 'flac') {
      // 无损：位率 = 音频区字节 * 8 / 时长秒（精确）
      const si = a.streamInfo;
      const audioBytes = a.size - a.audioOffset;
      realKbps = si && si.durationMs ? Math.round(((audioBytes * 8) / (si.durationMs / 1000)) / 1000) : null;
    } else {
      // MP3：读首帧帧头得到编码位率（这是最权威的本地值）
      const buf = fs.readFileSync(path.join(TARGET, name));
      realKbps = null;
      for (let i = a.audioOffset; i + 4 < buf.length; i++) {
        if (buf[i] !== 0xff || (buf[i + 1] & 0xe0) !== 0xe0) continue;
        const v = (buf[i + 1] >> 3) & 3;
        const l = (buf[i + 1] >> 1) & 3;
        const br = (buf[i + 2] >> 4) & 0xf;
        const sr = (buf[i + 2] >> 2) & 3;
        if (v !== 3 || l !== 1 || br === 0 || br === 15 || sr === 3) continue;
        realKbps = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320][br];
        break;
      }
    }
    if (realKbps == null) continue;
    const declaredKbps = meta.bitrate / 1000;
    const ok = Math.abs(declaredKbps - realKbps) / realKbps <= 0.08;
    if (!ok) suspicious.push({ name, fmt: a.format, declared: meta.bitrate, realKbps, ratio: Number((declaredKbps / realKbps).toFixed(2)) });
  }

  const flacBad = suspicious.filter((s) => s.fmt === 'flac');
  const mp3Bad = suspicious.filter((s) => s.fmt === 'mp3');
  info('语义依据', "probe/ref/163marker-core.py.txt L80: 'bitrate': audio.info.bitrate（本地文件位率）");
  info('不符统计', `FLAC ${flacBad.length}/${rows.filter((r) => r.a.format === 'flac').length}   MP3 ${mp3Bad.length}/${rows.filter((r) => r.a.format === 'mp3').length}`);

  check(
    flacBad.length === 0,
    'F3a FLAC 的 bitrate 字段等于本地无损真实位率（而非 MP3 档位 320000）',
    flacBad.length ? `${flacBad.length} 个不符，真实位率区间 ${Math.min(...flacBad.map((s) => s.realKbps))}~${Math.max(...flacBad.map((s) => s.realKbps))}kbps，一律写成 320000k` : '',
  );
  check(mp3Bad.length === 0, 'F3b MP3 的 bitrate 字段等于文件首帧编码位率', mp3Bad.length ? mp3Bad.map((s) => `${s.name}: 声明${s.declared} 实际${s.realKbps}k`).join('; ') : '');
  for (const s of suspicious.slice(0, 25)) {
    console.log(`   ${C.yellow}->${C.reset} ${s.fmt.padEnd(4)} 声明 ${String(s.declared).padStart(7)}  真实 ${String(s.realKbps * 1000).padStart(7)}  比值 ${s.ratio}  ${s.name}`);
  }
}

// ───────────────────────────────────────────────────────────────────────────
head('F4 mp3DocId：是否 32 位 hex 真值；是否是回退占位符');
// ───────────────────────────────────────────────────────────────────────────
{
  const bad = rows.filter(({ meta }) => !/^[0-9a-f]{32}$/.test(String(meta.mp3DocId || '').toLowerCase()));
  check(bad.length === 0, '所有 mp3DocId 都是 32 位小写 hex', bad.map((b) => `${b.name}:${JSON.stringify(b.meta.mp3DocId)}`).join(', '));

  // 回退值通常表现为「多首歌共用同一个 md5」
  const byMd5 = {};
  for (const { name, meta } of rows) (byMd5[meta.mp3DocId] ||= []).push(name);
  const shared = Object.entries(byMd5).filter(([, v]) => v.length > 1);
  check(shared.length === 0, '没有多首歌共用同一个 mp3DocId（共用 = 回退占位符，客户端会串歌）', shared.map(([k, v]) => `${k} <- ${v.join(' / ')}`).join(' | '));
}

// ───────────────────────────────────────────────────────────────────────────
head('F5 封面：albumPicDocId 必须出现在 albumPic URL 里');
// ───────────────────────────────────────────────────────────────────────────
{
  const bad = [];
  for (const { name, meta } of rows) {
    const docId = String(meta.albumPicDocId || '');
    const pic = String(meta.albumPic || '');
    if (!docId || !pic) bad.push({ name, why: '字段为空' });
    else if (!pic.includes(docId)) bad.push({ name, why: `docId ${docId} 不在 URL ${pic} 里` });
    else if (!/^https?:\/\//.test(pic)) bad.push({ name, why: `URL 不合法: ${pic}` });
  }
  check(bad.length === 0, '所有 albumPicDocId 都出现在 albumPic URL 中且 URL 合法', bad.length ? JSON.stringify(bad, null, 1) : '');
  // albumPicDocId 必须是 18 位左右的大整数（客户端用它拼封面地址）
  const weird = rows.filter(({ meta }) => !/^\d{15,20}$/.test(String(meta.albumPicDocId || '')));
  check(weird.length === 0, 'albumPicDocId 是 15-20 位十进制数字串', weird.map((w) => `${w.name}:${JSON.stringify(w.meta.albumPicDocId)}`).join(', '));
}

// ───────────────────────────────────────────────────────────────────────────
head('F6 duration：163key 的 duration vs 本地实测时长');
// ───────────────────────────────────────────────────────────────────────────
{
  const bad = [];
  for (const { name, a, meta } of rows) {
    let local = null;
    if (a.format === 'flac') local = a.streamInfo ? a.streamInfo.durationMs : null;
    if (local == null) continue; // MP3 的时长估算精度低，跳过
    const d = Math.abs(meta.duration - local);
    if (d > 3000) bad.push({ name, meta: meta.duration, local, delta: meta.duration - local });
  }
  check(bad.length === 0, 'FLAC 的 163key duration 与 STREAMINFO 实测时长一致（≤3s）', bad.length ? JSON.stringify(bad, null, 1) : '');
}

// ───────────────────────────────────────────────────────────────────────────
head('F7 mtime 是否被保留（写标签不该改文件时间戳）');
// ───────────────────────────────────────────────────────────────────────────
{
  let changed = 0;
  const changedList = [];
  for (const { name } of rows) {
    const bt = fs.statSync(path.join(BACKUP, name)).mtimeMs;
    const at = fs.statSync(path.join(TARGET, name)).mtimeMs;
    // 备份是 copy 出来的，mtime 可能与目标不同；这里只检查「目标 mtime 看起来是否像被批量刷过」
    if (Math.abs(at - bt) > 1000) {
      changed++;
      changedList.push({ name, backup: new Date(bt).toISOString(), target: new Date(at).toISOString() });
    }
  }
  info('说明：备份是拷贝产物，mtime 与工作副本不一致属正常；此检查仅列出差异供人工判断');
  check(true, `mtime 差异文件数：${changed}`, changed ? `（例如 ${changedList[0].name}: ${changedList[0].backup} -> ${changedList[0].target}）` : '');
}

// ───────────────────────────────────────────────────────────────────────────
head('F8 格式字段 format 必须与实际容器一致');
// ───────────────────────────────────────────────────────────────────────────
{
  const bad = rows.filter(({ a, meta }) => meta.format !== a.format);
  check(bad.length === 0, '所有 163key 的 format 字段与实际容器一致', bad.map((b) => `${b.name}: 声明 ${b.meta.format} 实际 ${b.a.format}`).join(', '));
}

process.exitCode = summary('06-metadata-fidelity') ? 0 : 1;
