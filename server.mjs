#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────
// 本地 Web 服务：把已经验证过的 CLI 包成图形界面。
//
// 设计上刻意不做「把核心逻辑搬进服务进程」的重构：
//   每次操作都 spawn 一个 apply.mjs 子进程，用 --progress 文件回传结构化进度。
// 好处是崩溃隔离（子进程炸了服务还在）、取消简单（杀子进程）、
// 以及 CLI 与 GUI 走的是**同一条代码路径**——CLI 跑通就等于 GUI 跑通。
// ─────────────────────────────────────────────────────────────

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { build163Key, parse163Key } from './lib/163key.mjs';
import { readTags, getProtectedRoots, addProtectedRoot } from './lib/tags.mjs';
import * as api from './lib/netease-api.mjs';
import { isDefiniteUgc, catalogScore, parseFilename, pickBest, DURATION_TOLERANCE_MS } from './lib/match.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// exe 态由启动器注入：ASSETS 指向释放出来的资源目录，DATA 指向用户数据目录。
// 源码态两者都不设，沿用项目目录（行为和以前完全一致）。
const ASSETS = process.env.NETEASE_163KEY_ASSETS || HERE;
const DATA = process.env.NETEASE_163KEY_DATA || HERE;
const OUT = path.join(DATA, 'out');
const WEB = path.join(ASSETS, 'web');
const CONFIG_FILE = path.join(DATA, '.config.json');
/**
 * exe 态检测：SEA 里 process.execPath 就是打包好的 exe 本身。
 * 判断方式看是否有启动器注入的环境变量，比 require('node:sea') 更可控
 * （后者在 ESM 里拿不到 require，而且源码态也不该走这条路）。
 */
const IS_SEA = !!process.env.NETEASE_163KEY_ASSETS;
const NODE = process.execPath;
const PORT = Number(process.env.PORT || 0);

// ── 配置 ─────────────────────────────────────────────────────

const DEFAULT_CONFIG = {
  root: process.env.NETEASE_163KEY_ROOT || '',
  backup: process.env.NETEASE_163KEY_BACKUP || '',
  downloadRoot: '',
  // 额外的只读保护目录：原始素材放这里，工具永远不会往里写
  protect: [],
  searchLimit: 100,
  maxQueries: 2,
  sleepMs: 300,
};

function loadConfig() {
  try {
    return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}
function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_FILE, `${JSON.stringify(cfg, null, 2)}\n`);
}
let config = loadConfig();
if (config.backup) addProtectedRoot(config.backup);
if (Array.isArray(config.protect)) for (const d of config.protect) if (d) addProtectedRoot(d);

// ── 任务管理 ─────────────────────────────────────────────────

/** 同一时刻只允许一个操作在跑：两个 apply 并发写同一批文件没有任何好处 */
let job = null;
const sseClients = new Set();

function sseSend(type, data) {
  const payload = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(payload);
    } catch {
      sseClients.delete(res);
    }
  }
}

function jobSnapshot() {
  if (!job) return { status: 'idle' };
  const { child, timer, ...rest } = job;
  return rest;
}

function finishJob(code, signal) {
  if (!job) return;
  clearInterval(job.timer);
  drainProgress(); // 收尾前把最后几行读完，否则前端会漏掉 done 事件
  job.status = code === 0 ? 'done' : 'failed';
  job.exitCode = code;
  job.signal = signal ?? null;
  job.endedAt = Date.now();
  const snap = jobSnapshot();
  sseSend('job', snap);
  job.child = null;
  job.timer = null;
}

/** 读进度文件里新增的整行并广播 */
function drainProgress() {
  if (!job || !job.progressFile) return;
  let buf;
  try {
    const fd = fs.openSync(job.progressFile, 'r');
    const size = fs.fstatSync(fd).size;
    if (size <= job.offset) {
      fs.closeSync(fd);
      return;
    }
    buf = Buffer.alloc(size - job.offset);
    fs.readSync(fd, buf, 0, buf.length, job.offset);
    fs.closeSync(fd);
    job.offset = size;
  } catch {
    return;
  }
  const text = buf.toString('utf8');
  const lines = text.split('\n');
  // 最后一段可能是被截断的半行，留到下一次；这里用「保留最后一个不完整片段」的策略
  const tail = lines.pop();
  if (tail) {
    job.offset -= Buffer.byteLength(tail, 'utf8');
  }
  for (const line of lines) {
    if (!line.trim()) continue;
    let evt;
    try {
      evt = JSON.parse(line);
    } catch {
      continue;
    }
    if (evt.kind === 'done') {
      job.result = evt;
    }
    job.lastEvent = evt;
    sseSend('progress', evt);
  }
}

function startJob(op, args) {
  if (job && job.status === 'running') {
    const e = new Error(`已有任务在跑（${job.op}），先等它结束或取消`);
    e.code = 'busy';
    throw e;
  }
  const progressFile = path.join(OUT, `progress-${op}.jsonl`);
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(progressFile, '');

  const env = { ...process.env };
  const protect = [config.backup, ...getProtectedRoots()].filter(Boolean);
  if (protect.length) env.NETEASE_163KEY_PROTECT = protect.join(path.delimiter);
  env.NETEASE_163KEY_ROOT = config.root || '';
  env.NETEASE_163KEY_BACKUP = config.backup || '';
  // 子进程要和父进程用同一个数据目录（exe 态是 ~/.netease-163key-tagger）
  env.NETEASE_163KEY_DATA = DATA;

  // 子进程有两种形态：
  //   源码态：node <ASSETS>/apply.mjs scan ...
  //   exe 态 ：<exe> --cli scan ...          （启动器看到 --cli 就转去跑 apply）
  const argv = IS_SEA
    ? ['--cli', op, ...args, '--progress', progressFile]
    : [path.join(ASSETS, 'apply.mjs'), op, ...args, '--progress', progressFile];
  const child = spawn(NODE, argv, { cwd: ASSETS, env, windowsHide: true });

  job = {
    op,
    args,
    progressFile,
    offset: 0,
    child,
    timer: null,
    status: 'running',
    startedAt: Date.now(),
    endedAt: null,
    exitCode: null,
    result: null,
    lastEvent: null,
    log: [],
  };

  const pushLog = (s) => {
    for (const line of String(s).split('\n')) {
      if (line.trim()) job.log.push(line.trimEnd());
    }
    if (job.log.length > 400) job.log.splice(0, job.log.length - 400);
  };
  child.stdout.on('data', pushLog);
  child.stderr.on('data', pushLog);
  child.on('exit', (code, signal) => finishJob(code, signal));
  child.on('error', (e) => {
    pushLog(`spawn 失败: ${e.message}`);
    finishJob(1, null);
  });

  job.timer = setInterval(drainProgress, 120);
  sseSend('job', jobSnapshot());
  return jobSnapshot();
}

function cancelJob() {
  if (!job || job.status !== 'running' || !job.child) return jobSnapshot();
  const pid = job.child.pid;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
  } else {
    job.child.kill('SIGTERM');
  }
  job.status = 'cancelling';
  return jobSnapshot();
}

// ── 文件与报告工具 ───────────────────────────────────────────

const readJson = (p) => {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
};
const writeJson = (p, v) => fs.writeFileSync(p, `${JSON.stringify(v, null, 2)}\n`);

const reportPath = () => path.join(OUT, 'matches.json');
const scanPath = () => path.join(OUT, 'scan.json');

function reportRecords() {
  return readJson(reportPath())?.records || [];
}

/** 只允许读 root 之下的文件，防止路径穿越把整个硬盘当音乐库 */
function safeUnderRoot(rel) {
  if (!config.root) throw new Error('还没有设置音乐目录');
  const root = path.resolve(config.root);
  const abs = path.resolve(root, rel);
  if (!(abs === root || abs.startsWith(root + path.sep))) throw new Error('路径越界');
  return abs;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg',
  '.flac': 'audio/flac',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.ncm': 'application/octet-stream',
};

function serveStatic(res, file) {
  let buf;
  try {
    buf = fs.readFileSync(file);
  } catch {
    res.writeHead(404).end('not found');
    return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
  res.end(buf);
}

/** 支持 Range 的音频流，否则 <audio> 拖不动进度条 */
function serveAudio(req, res, abs) {
  let st;
  try {
    st = fs.statSync(abs);
  } catch {
    res.writeHead(404).end('not found');
    return;
  }
  const type = MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream';
  const range = req.headers.range;
  if (!range) {
    res.writeHead(200, { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Length': st.size });
    fs.createReadStream(abs).pipe(res);
    return;
  }
  const m = /bytes=(\d*)-(\d*)/.exec(range);
  let start = m && m[1] ? Number(m[1]) : 0;
  let end = m && m[2] ? Number(m[2]) : st.size - 1;
  if (!Number.isFinite(start) || start < 0) start = 0;
  if (!Number.isFinite(end) || end >= st.size) end = st.size - 1;
  if (start > end) {
    res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }).end();
    return;
  }
  res.writeHead(206, {
    'Content-Type': type,
    'Accept-Ranges': 'bytes',
    'Content-Range': `bytes ${start}-${end}/${st.size}`,
    'Content-Length': end - start + 1,
  });
  fs.createReadStream(abs, { start, end }).pipe(res);
}

// ── 客户端库（只读）─────────────────────────────────────────

function clientLibDir() {
  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA;
    if (!base) return null;
    return path.join(base, 'Netease', 'CloudMusic', 'Library');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Netease', 'CloudMusic', 'Library');
  }
  return path.join(os.homedir(), '.config', 'netease-cloud-music', 'Library');
}

/**
 * 只读检查客户端「已下载」清单。
 * 必须复制一份再打开：客户端在跑时库文件有 write lock / -journal，
 * 直接开原文件既可能失败，也可能（用非只读方式）干扰客户端。
 */
function readOfflineTracks() {
  const libDir = clientLibDir();
  if (!libDir || !fs.existsSync(path.join(libDir, 'webdb.dat'))) {
    return { found: false, libDir, reason: '找不到客户端的 webdb.dat（是否装过网易云音乐？）' };
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'n163k-'));
  try {
    const dst = path.join(tmp, 'webdb.dat');
    fs.copyFileSync(path.join(libDir, 'webdb.dat'), dst);
    const db = new DatabaseSync(dst, { readOnly: true });
    try {
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all()
        .map((r) => r.name);
      if (!tables.includes('offlineTrack')) {
        return { found: true, libDir, hasOfflineTable: false, tracks: [], count: 0 };
      }
      const rows = db.prepare('SELECT * FROM offlineTrack').all();
      const tracks = rows.map((r) => {
        let state = r.state;
        try {
          if (typeof state === 'string' && /^[[{"]|^\d/.test(state)) state = JSON.parse(state);
        } catch {
          /* 保持原样 */
        }
        return {
          id: r.id,
          type: r.type,
          state,
          completeTime: r.completeTime,
          newRelativePath: r.newRelativePath,
          trackName: r.trackName,
          artistName: r.artistName,
          albumName: r.albumName,
          size: r.size,
        };
      });
      return { found: true, libDir, hasOfflineTable: true, count: tracks.length, tracks };
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ── 建议下载根目录 ───────────────────────────────────────────

function suggestDownloadRoots() {
  const cands = [];
  const add = (p, why) => {
    if (!p) return;
    const n = path.resolve(p);
    if (cands.some((c) => c.path.toLowerCase() === n.toLowerCase())) return;
    if (fs.existsSync(n)) cands.push({ path: n, why, exists: true });
  };
  if (process.platform === 'win32') {
    add(path.join(os.homedir(), 'Music'), '系统「音乐」文件夹');
    add(path.join(os.homedir(), 'Downloads', 'Music'), '下载目录下的 Music');
    add(path.join(os.homedir(), 'Documents', 'CloudMusic'), '常见自定义位置');
  } else if (process.platform === 'darwin') {
    add(path.join(os.homedir(), 'Music'), '系统「音乐」文件夹');
    add(path.join(os.homedir(), 'Music', 'CloudMusic'), '常见自定义位置');
  } else {
    add(path.join(os.homedir(), 'Music'), '系统「音乐」文件夹');
    add(path.join(os.homedir(), 'Music', 'cloudmusic'), '常见自定义位置');
  }
  // library.dat 里出现过、且不是受保护原始素材的目录，也是强线索
  try {
    const libDir = clientLibDir();
    const src = path.join(libDir, 'library.dat');
    if (fs.existsSync(src)) {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'n163k-'));
      const dst = path.join(tmp, 'library.dat');
      fs.copyFileSync(src, dst);
      const db = new DatabaseSync(dst, { readOnly: true });
      try {
        const dirs = db.prepare("SELECT dir, count(*) c FROM track WHERE dir IS NOT NULL AND dir<>'' GROUP BY dir").all();
        for (const d of dirs) add(d.dir, `客户端曲库里登记过 ${d.c} 首`);
      } finally {
        db.close();
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    }
  } catch {
    /* 建议不出来就算了，用户自己选 */
  }
  return cands;
}

// ── HTTP ─────────────────────────────────────────────────────

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 4 * 1024 * 1024) return reject(new Error('请求体过大'));
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

async function handleApi(req, res, url) {
  const p = url.pathname;

  if (p === '/api/state') {
    const rep = readJson(reportPath());
    const scan = readJson(scanPath());
    return json(res, 200, {
      config,
      protectedRoots: getProtectedRoots(),
      hasScan: !!scan,
      scan: scan ? { root: scan.root, count: scan.count, fmtCount: scan.fmtCount, withKey: (scan.records || []).filter((r) => r.hasKey).length } : null,
      report: rep ? { root: rep.root, total: rep.total, auto: rep.auto, review: rep.review, generatedAt: rep.generatedAt } : null,
      job: jobSnapshot(),
      apiBase: api.NETEASE_BASE ?? null,
    });
  }

  if (p === '/api/config' && req.method === 'POST') {
    const body = JSON.parse((await readBody(req)) || '{}');
    for (const k of ['root', 'backup', 'downloadRoot']) {
      if (typeof body[k] === 'string') config[k] = body[k].trim();
    }
    for (const k of ['searchLimit', 'maxQueries', 'sleepMs']) {
      if (body[k] != null && Number.isFinite(Number(body[k]))) config[k] = Number(body[k]);
    }
    if (config.backup) addProtectedRoot(config.backup);
    saveConfig(config);
    return json(res, 200, { ok: true, config, protectedRoots: getProtectedRoots() });
  }

  if (p === '/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': connected\n\n');
    res.write(`event: job\ndata: ${JSON.stringify(jobSnapshot())}\n\n`);
    sseClients.add(res);
    const ka = setInterval(() => {
      try {
        res.write(': keep-alive\n\n');
      } catch {
        /* 下面会在 close 时清掉 */
      }
    }, 20000);
    req.on('close', () => {
      clearInterval(ka);
      sseClients.delete(res);
    });
    return;
  }

  if (p === '/api/job') {
    if (url.searchParams.get('cancel')) return json(res, 200, cancelJob());
    return json(res, 200, jobSnapshot());
  }

  if (p === '/api/cancel' && req.method === 'POST') {
    return json(res, 200, cancelJob());
  }

  if (p === '/api/scan' && req.method === 'POST') {
    if (!config.root) return json(res, 400, { error: '先设置音乐目录' });
    return json(res, 200, startJob('scan', ['--root', config.root, '--out', scanPath()]));
  }

  if (p === '/api/match' && req.method === 'POST') {
    if (!config.root) return json(res, 400, { error: '先设置音乐目录' });
    const args = [
      '--root',
      config.root,
      '--report',
      reportPath(),
      '--search-limit',
      String(config.searchLimit),
      '--max-queries',
      String(config.maxQueries),
      '--sleep',
      String(config.sleepMs),
    ];
    // 允许对单个文件重跑匹配（复核界面点「重新匹配」）
    const one = url.searchParams.get('file');
    if (one) args.push('--only', one);
    return json(res, 200, startJob('match', args));
  }

  if (p === '/api/apply' && req.method === 'POST') {
    const body = JSON.parse((await readBody(req)) || '{}');
    const args = ['--report', reportPath()];
    if (body.write) args.push('--write');
    if (body.includeReview) args.push('--include-review');
    if (body.all) args.push('--all');
    // 元数据改写是「会改变你看到的东西」的操作，必须显式传才会做
    if (body.meta || body.cover) args.push('--meta');
    if (body.cover) args.push('--cover');
    return json(res, 200, startJob('apply', args));
  }

  if (p === '/api/verify' && req.method === 'POST') {
    const args = ['--root', config.root, '--report', reportPath(), '--out', path.join(OUT, 'verify.json')];
    if (config.backup) args.push('--backup', config.backup);
    return json(res, 200, startJob('verify', args));
  }

  if (p === '/api/report') {
    const rep = readJson(reportPath());
    if (!rep) return json(res, 404, { error: '还没有匹配报告，先跑匹配' });
    // 顺手把「磁盘上现在到底是什么状态」标出来：报告说生成了 key ≠ 已经写进文件。
    // 57 个文件读一遍约 0.7s，比让用户猜「到底写没写」划算。
    for (const r of rep.records || []) {
      try {
        const t = readTags(path.join(rep.root, r.file));
        r.onDisk = t.key163 ? (t.key163 === r.key163 ? 'match' : 'differs') : null;
        r.onDiskMusicId = t.key163 ? (parse163Key(t.key163)?.musicId ?? null) : null;
      } catch (e) {
        r.onDisk = 'error';
        r.onDiskError = e.message;
      }
    }
    return json(res, 200, rep);
  }

  if (p === '/api/scan-result') {
    return json(res, 200, readJson(scanPath()) || null);
  }

  if (p === '/api/verify-result') {
    return json(res, 200, readJson(path.join(OUT, 'verify.json')) || null);
  }

  if (p === '/api/audio') {
    try {
      return serveAudio(req, res, safeUnderRoot(url.searchParams.get('file') || ''));
    } catch (e) {
      return json(res, 400, { error: e.message });
    }
  }

  // 用户在复核界面手动指定某个候选：按该 musicId 重新生成 key163 并写回报告
  if (p === '/api/choose' && req.method === 'POST') {
    const body = JSON.parse((await readBody(req)) || '{}');
    const file = String(body.file || '');
    if (!file) return json(res, 400, { error: '缺少 file 参数' });
    const rep = readJson(reportPath());
    if (!rep) return json(res, 404, { error: '先跑匹配' });
    const rec = (rep.records || []).find((r) => r.file === file);
    if (!rec) return json(res, 404, { error: '报告里没有这个文件' });

    // 撤销要在校验 musicId 之前处理——clear 请求本来就不带 musicId
    if (body.clear) {
      rec.manual = null;
      writeJson(reportPath(), rep);
      return json(res, 200, { ok: true, cleared: true, record: rec });
    }

    const musicId = Number(body.musicId);
    if (!Number.isFinite(musicId) || musicId <= 0) return json(res, 400, { error: 'musicId 无效' });

    const abs = path.join(rep.root, file);
    let tags = {};
    try {
      tags = readTags(abs);
    } catch {
      /* 读不到就用报告里的 */
    }
    let detail;
    try {
      detail = await api.getSongDetail(musicId);
    } catch (e) {
      return json(res, 502, { error: `取歌曲详情失败：${e.message}` });
    }
    let meta;
    try {
      meta = api.to163Meta(detail, {
        format: rec.format,
        localDurationMs: tags.durationMs ?? rec.localDurationMs,
        bitrate: tags.bitrate ?? undefined,
      });
    } catch (e) {
      return json(res, 500, { error: `生成元数据失败：${e.message}` });
    }
    const key163 = build163Key(meta);
    const back = parse163Key(key163);
    if (!back || back.musicId !== meta.musicId) return json(res, 500, { error: '编码自校验失败' });

    rec.key163 = key163;
    rec.keyLength = key163.length;
    rec.meta = meta;
    rec.manual = { id: musicId, name: meta.musicName, at: new Date().toISOString() };
    rec.best = {
      id: musicId,
      name: meta.musicName,
      artists: (meta.artist || []).map((a) => ({ name: a[0], id: a[1] })),
      album: meta.album,
      durationMs: meta.duration,
      score: 1,
    };
    rec.error = null;
    rec.warnings = [];
    writeJson(reportPath(), rep);
    return json(res, 200, { ok: true, record: rec });
  }

  // 「搜索并对比」：关键词搜 / 直接给歌曲 ID / 粘贴分享链接，三种都收。
  // 回包里带上封面、正版/UGC 标记、以及与本地文件的时长差，让用户在界面上直接比对挑选。
  if (p === '/api/search' && req.method === 'POST') {
    const body = JSON.parse((await readBody(req)) || '{}');
    const keyword = String(body.keyword || '').trim();

    // 支持三种输入：纯数字 id、music.163.com/song?id=xxx、分享短链里的 id=
    const m = keyword.match(/[?&]id=(\d+)/) || keyword.match(/(?:^|\D)(\d{5,})(?:\D|$)/);
    const explicit = Number(body.musicId);
    const byId = Number.isFinite(explicit) && explicit > 0 ? explicit : m ? Number(m[1]) : null;

    // 本地文件的时长，用来算 Δ（对比就靠它）
    let localDurationMs = null;
    const file = String(body.file || '');
    if (file) {
      try {
        const rep = readJson(reportPath());
        const rec = (rep?.records || []).find((r) => r.file === file);
        localDurationMs = Number.isFinite(rec?.localDurationMs) ? rec.localDurationMs : null;
        if (!localDurationMs && rep?.root) localDurationMs = readTags(path.join(rep.root, file))?.durationMs ?? null;
      } catch {
        /* 取不到就不给 Δ */
      }
    }
    const deltaOf = (ms) =>
      Number.isFinite(localDurationMs) && Number.isFinite(ms) && ms > 0 ? ms - localDurationMs : null;

    // 搜索结果 → 统一卡片数据
    // 注意：mapSong() 的 album 只有 {id,name}（契约里没放封面），封面得从 raw.al / raw.album 捞。
    const picOf = (h) => h.album?.picUrl || h.raw?.al?.picUrl || h.raw?.album?.picUrl || null;
    const hitFromSearch = (h) => ({
      id: h.id,
      name: h.name,
      artists: (h.artists || []).map((a) => a.name),
      artistIds: (h.artists || []).map((a) => a.id),
      album: h.album?.name ?? null,
      albumId: h.album?.id ?? null,
      picUrl: picOf(h),
      durationMs: h.durationMs,
      fee: h.raw?.fee ?? h.fee ?? null,
      bitrate: null,
      ugc: isDefiniteUgc(h),
      catalog: Number(catalogScore(h).toFixed(3)),
      localDeltaMs: deltaOf(h.durationMs),
    });

    // 详情（163key meta 形状）→ 统一卡片数据
    const hitFromMeta = (meta) => {
      const arts = (meta.artist || []).map((a) => ({ name: a[0], id: a[1] }));
      const cand = { artists: arts, album: { name: meta.album } };
      return {
        id: meta.musicId,
        name: meta.musicName,
        artists: arts.map((a) => a.name),
        artistIds: arts.map((a) => a.id),
        album: meta.album || null,
        albumId: meta.albumId ?? null,
        picUrl: meta.albumPic || null,
        durationMs: meta.duration,
        fee: null,
        bitrate: meta.bitrate ?? null,
        ugc: isDefiniteUgc(cand),
        catalog: Number(catalogScore(cand).toFixed(3)),
        localDeltaMs: deltaOf(meta.duration),
      };
    };

    try {
      if (byId) {
        const meta = await api.getSongDetail(byId);
        return json(res, 200, { keyword: String(byId), byId: true, localDurationMs, hits: meta ? [hitFromMeta(meta)] : [] });
      }
      if (!keyword) return json(res, 400, { error: '关键词或歌曲 ID 至少给一个' });
      const hits = await api.searchSong({ keyword, limit: Math.min(100, Number(body.limit) || 30) });
      // 用 lib/match.mjs 的权威打分排序，而不是在 UI 层另造一套——
      // 只按「时长差最小」会把翻唱排到原唱前面（实测翻唱能差 0.7s、原唱差 1.5s）。
      // 这里复用与自动匹配完全相同的判据（歌名/歌手/时长/专辑/曲库身份），
      // 保证「界面上第一眼看到的那条」就是引擎会选的那条。
      let ordered = (hits || []).map(hitFromSearch);
      if (file) {
        try {
          const rep = readJson(reportPath());
          const rec = (rep?.records || []).find((r) => r.file === file);
          const parsed = rec?.parsed
            ? parseFilename(rec.file)
            : parseFilename(file);
          const { ranked } = pickBest(
            (hits || []).map((h) => ({
              id: h.id,
              name: h.name,
              artists: h.artists || [],
              album: h.album || {},
              durationMs: h.durationMs,
            })),
            parsed,
            {
              localDurationMs,
              localAlbum: rec?.localAlbum ?? null,
              localArtists: parsed.artists,
            },
          );
          const byIdMap = new Map(ordered.map((h) => [h.id, h]));
          ordered = ranked
            .map((r) => {
              const card = byIdMap.get(r.id);
              if (!card) return null;
              card.score = Number(r.score.toFixed(4));
              card.parts = r.parts;
              card.auto = false;
              return card;
            })
            .filter(Boolean);
          // 补上任何被 pickBest 丢掉的（理论上不会有，保险起见）
          const seen = new Set(ordered.map((h) => h.id));
          for (const h of (hits || []).map(hitFromSearch)) if (!seen.has(h.id)) ordered.push(h);
        } catch {
          /* 打分失败就退回接口原始顺序 */
        }
      }
      return json(res, 200, {
        keyword,
        byId: false,
        localDurationMs,
        durationToleranceMs: DURATION_TOLERANCE_MS,
        rankedByEngine: !!file,
        hits: ordered,
      });
    } catch (e) {
      return json(res, 502, { error: `搜索失败：${e.message}` });
    }
  }

  // 批量：给所有「待复核」文件，用引擎打分把最佳候选重新挑一遍并写回报告。
  // 只处理 medium（有候选、时长也大致对，只是没过 auto 阈值）的；
  // 时长明确不符 / UGC 冒充的仍然留给人工，不在这里替用户拍板。
  if (p === '/api/pick-all' && req.method === 'POST') {
    const body = JSON.parse((await readBody(req)) || '{}');
    const dryRun = body.dryRun !== false;
    const rep = readJson(reportPath());
    if (!rep) return json(res, 404, { error: '先跑匹配' });
    const targets = (rep.records || []).filter(
      (r) => !r.manual && !r.auto && r.confidence === 'medium' && !r.ugc && !r.durationMismatch && (r.top || []).length,
    );
    const plan = [];
    for (const rec of targets) {
      const cand = (rec.top || []).slice().sort((a, b) => (b.score ?? 0) - (a.score ?? 0))[0];
      if (!cand) continue;
      plan.push({
        file: rec.file,
        pick: { id: cand.id, name: cand.name, artists: cand.artists, album: cand.album, durationMs: cand.durationMs, score: cand.score },
        current: rec.best ? { id: rec.best.id, name: rec.best.name } : null,
        sameAsCurrent: rec.best?.id === cand.id,
      });
    }
    if (dryRun) {
      return json(res, 200, { dryRun: true, total: targets.length, plan });
    }
    let applied = 0;
    const failed = [];
    for (const item of plan) {
      const rec = (rep.records || []).find((r) => r.file === item.file);
      if (!rec) continue;
      try {
        const abs = path.join(rep.root, rec.file);
        let tags = {};
        try {
          tags = readTags(abs);
        } catch {}
        const detail = await api.getSongDetail(item.pick.id);
        const meta = api.to163Meta(detail, {
          format: rec.format,
          localDurationMs: tags.durationMs ?? rec.localDurationMs,
          bitrate: tags.bitrate ?? undefined,
        });
        const key163 = build163Key(meta);
        const back = parse163Key(key163);
        if (!back || back.musicId !== meta.musicId) throw new Error('编码自校验失败');
        rec.key163 = key163;
        rec.keyLength = key163.length;
        rec.meta = meta;
        rec.manual = { id: meta.musicId, name: meta.musicName, at: new Date().toISOString(), by: 'pick-all' };
        rec.best = {
          id: meta.musicId,
          name: meta.musicName,
          artists: (meta.artist || []).map((a) => ({ name: a[0], id: a[1] })),
          album: meta.album,
          durationMs: meta.duration,
          score: item.pick.score ?? null,
        };
        rec.error = null;
        rec.warnings = [];
        applied++;
      } catch (e) {
        failed.push({ file: item.file, error: e.message });
      }
    }
    writeJson(reportPath(), rep);
    return json(res, 200, { dryRun: false, total: targets.length, applied, failed, plan });
  }

  if (p === '/api/download-roots') {
    return json(res, 200, { clientLibDir: clientLibDir(), candidates: suggestDownloadRoots() });
  }

  if (p === '/api/offline') {
    try {
      return json(res, 200, readOfflineTracks());
    } catch (e) {
      return json(res, 500, { found: false, error: e.message });
    }
  }

  if (p === '/api/log') {
    return json(res, 200, { log: job?.log || [] });
  }

  return json(res, 404, { error: 'no such api' });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    const rel = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '');
    const abs = path.resolve(WEB, rel);
    if (!abs.startsWith(path.resolve(WEB))) {
      res.writeHead(403).end('forbidden');
      return;
    }
    return serveStatic(res, abs);
  } catch (e) {
    try {
      json(res, 500, { error: e.message });
    } catch {
      /* 响应已经发出去了 */
    }
  }
});

server.listen(PORT, '127.0.0.1', () => {
  const { port } = server.address();
  const url = `http://127.0.0.1:${port}`;
  console.log(`netease-163key-tagger 已启动：${url}`);
  console.log(`音乐目录: ${config.root || '(未设置)'}`);
  if (config.backup) console.log(`备份目录（只读保护）: ${config.backup}`);
  console.log('按 Ctrl+C 停止服务。');
  if (process.env.NO_OPEN !== '1') {
    const cmd =
      process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
    spawn(process.platform === 'win32' ? 'cmd' : 'sh', process.platform === 'win32' ? ['/c', cmd] : ['-c', cmd], {
      windowsHide: true,
      stdio: 'ignore',
      detached: true,
    }).unref();
  }
});
