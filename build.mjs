#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────
// 把项目打包成单个 EXE（Node SEA）
//
// ── 为什么用「内嵌源码 + 运行时释放」而不是打包器 ──
// Node 的 SEA 只能内嵌**一个** JS 文件，而本项目是多个 ESM 模块 + web/ 静态资源。
// 自己写打包器去拍平 ESM（改写 import/export）非常脆弱：export 形式一花就错，
// 而且会改变模块语义（循环依赖、顶层 await、live binding 都会出问题）。
//
// 更稳的做法：把 lib/*.mjs 和 web/* 原样 base64 内嵌进启动器，运行时写到
// 用户临时目录再 import —— 源码一个字节都没改，行为和直接跑源码完全一致。
//
// 代价：首次启动要把 ~100KB 释放到临时目录（毫秒级），可以接受。
//
// 运行：node build.mjs
// 产物：dist/netease-163key-tagger.exe
// ─────────────────────────────────────────────────────────────

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TMP = path.join(HERE, 'build-tmp');
const DIST = path.join(HERE, 'dist');
const RESERVED = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

const log = (s) => console.log(`[build] ${s}`);
const die = (s) => {
  console.error(`[build] ❌ ${s}`);
  process.exit(1);
};

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  if (r.status !== 0) {
    console.error((r.stdout || '').slice(-3000));
    console.error((r.stderr || '').slice(-3000));
    die(`${path.basename(cmd)} 失败（退出码 ${r.status}）`);
  }
  return r;
}

function findBuildNode() {
  const cands = [process.execPath, 'C:\\Program Files\\nodejs\\node.exe', '/usr/local/bin/node', '/usr/bin/node'];
  for (const c of cands) {
    if (!c || !fs.existsSync(c)) continue;
    const r = spawnSync(c, ['--version'], { encoding: 'utf8' });
    if (r.status === 0 && Number(String(r.stdout).trim().replace(/^v/, '').split('.')[0]) >= 20) {
      return { exe: c, version: String(r.stdout).trim() };
    }
  }
  die('找不到 node >= 20');
}

// ── 收集要内嵌的文件 ─────────────────────────────────────────

function collectAssets() {
  const assets = {};
  const addDir = (dir, prefix) => {
    for (const name of fs.readdirSync(dir)) {
      const abs = path.join(dir, name);
      if (!fs.statSync(abs).isFile()) continue;
      assets[`${prefix}/${name}`] = fs.readFileSync(abs).toString('base64');
    }
  };
  addDir(path.join(HERE, 'lib'), 'lib');
  addDir(path.join(HERE, 'web'), 'web');
  // apply.mjs 也要内嵌：server 靠 spawn 它来跑 scan/match/apply/verify，
  // 子进程用的就是 host 上的 node（exe 自己），所以它必须能被找到。
  assets['apply.mjs'] = fs.readFileSync(path.join(HERE, 'apply.mjs')).toString('base64');
  assets['server.mjs'] = fs.readFileSync(path.join(HERE, 'server.mjs')).toString('base64');
  return assets;
}

// ── 生成启动器 ───────────────────────────────────────────────

function buildLauncher(assets) {
  const assetLines = Object.entries(assets)
    .map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)},`)
    .join('\n');

  return `#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────
// netease-163key-tagger —— 单文件启动器（由 build.mjs 生成，请勿手改）
//
// 内嵌了 lib/*.mjs 与 web/* 的全部源码。启动时释放到临时目录再 import，
// 所以跑的是**原样的源码**，没有经过任何打包器改写。
// ─────────────────────────────────────────────────────────────
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { createRequire } = require('node:module');

const EMBEDDED = {
${assetLines}
};

/** 内嵌内容的指纹：源码变了就要换目录，避免旧缓存串味 */
function contentHash() {
  const h = crypto.createHash('sha256');
  for (const k of Object.keys(EMBEDDED).sort()) h.update(k).update(EMBEDDED[k]);
  return h.digest('hex').slice(0, 16);
}

/**
 * 把内嵌资源写到 dir。
 */
function extractInto(dir) {
  fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'web'), { recursive: true });
  for (const [rel, b64] of Object.entries(EMBEDDED)) {
    fs.writeFileSync(path.join(dir, rel), Buffer.from(b64, 'base64'));
  }
  fs.writeFileSync(path.join(dir, '.ready'), new Date().toISOString());
}

/**
 * 目录是不是「完整可用」：每个文件都在、字节数对得上、.ready 也在。
 * 只认 .ready 是不够的 —— 目录被外部清过、或上次写到一半被打断时，
 * 只认标记会一直加载一堆残缺文件。
 */
function dirLooksComplete(dir) {
  for (const [rel, b64] of Object.entries(EMBEDDED)) {
    let st;
    try {
      st = fs.statSync(path.join(dir, rel));
    } catch {
      return false;
    }
    if (!st.isFile() || st.size !== Buffer.from(b64, 'base64').length) return false;
  }
  return fs.existsSync(path.join(dir, '.ready'));
}

/**
 * 释放内嵌资源到临时目录，返回该目录。
 * 目录名带内容指纹：同名且完整就跳过写入（第二次启动几乎零开销）。
 */
function materialize(force) {
  const base = process.env.NETEASE_163KEY_HOME || path.join(os.tmpdir(), 'netease-163key-tagger');
  const dir = path.join(base, contentHash());
  if (!force && dirLooksComplete(dir)) return dir;
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {}
  extractInto(dir);
  return dir;
}

(async () => {
  const dir = materialize();

  // 让服务端知道自己是「exe 态」：资源目录与数据目录分开，
  // 避免把配置/报告写进会被清理的临时目录。
  if (!process.env.NETEASE_163KEY_DATA) {
    process.env.NETEASE_163KEY_DATA = path.join(os.homedir(), '.netease-163key-tagger');
    fs.mkdirSync(process.env.NETEASE_163KEY_DATA, { recursive: true });
  }
  process.env.NETEASE_163KEY_ASSETS = dir;

  // 命令行模式判定：
  //   server.mjs 只认环境变量（PORT / NO_OPEN），不吃任何命令行参数，
  //   所以「只要带了参数」就按命令行走。
  //   这样敲错命令会打印用法，而不是默默起一个网页服务挂着。
  //   --cli（server 调子进程时用的老写法）也继续兼容。
  const argv = process.argv.slice(2);
  const isCli = argv.length > 0;
  const cliArgs = argv[0] === '--cli' ? argv.slice(1) : argv;
  const target = isCli ? 'apply.mjs' : 'server.mjs';
  if (isCli) process.argv = [process.argv[0], path.join(dir, 'apply.mjs'), ...cliArgs];

  // 加载方式：createRequire 优先，动态 import / require 做兜底。
  // 为什么 createRequire 排第一：它锚在释放目录的假 CJS 文件上，能正确
  //   把 entry 当「磁盘上的文件路径」解析。另外两种在 Node 26 的 SEA 里
  //   都会把路径当成内置模块去找（No such built-in module: C:\...）。
  // 前提：apply.mjs / server.mjs 的 ESM 图里不能有顶层 await，
  //   否则 createRequire 会抛 ERR_REQUIRE_ASYNC_MODULE。
  //   （apply.mjs 的入口分发已经包进 async IIFE 来满足这个前提。）
  const entry = path.join(dir, target);
  const attempts = [
    ['createRequire', () => createRequire(path.join(dir, '__entry__.cjs'))(entry)],
    ['import', () => import(pathToFileURL(entry).href)],
    ['require', () => require(entry)],
  ];

  async function tryLoad() {
    const failures = [];
    for (const [name, attempt] of attempts) {
      try {
        const r = attempt();
        const mod = r && typeof r.then === 'function' ? await r : r;
        // apply.mjs 把入口分发的结果导出成 done：require() 是同步的，
        // 必须显式等它，否则 match/apply 这类异步命令会被提前退出。
        if (mod && mod.done && typeof mod.done.then === 'function') await mod.done;
        return { ok: true, failures };
      } catch (e) {
        failures.push(name + ': ' + (e && e.message ? e.message : e));
      }
    }
    return { ok: false, failures };
  }

  let res = await tryLoad();
  if (!res.ok) {
    // 兜底：解包目录可能被外部清理过，或被安全软件扫到一半卡住 ——
    // 强制重写一遍资源再试一次，能吸收掉这类瞬时的读取失败。
    try {
      materialize(true);
      res = await tryLoad();
    } catch (e) {
      res.failures.push('重新解包: ' + (e && e.message ? e.message : e));
    }
  }
  if (!res.ok) {
    console.error('');
    console.error('  启动失败：');
    for (const line of res.failures) console.error('    · ' + line);
    console.error('');
    console.error('  如果反复失败，可以删掉这个目录后重试：');
    console.error('    ' + dir);
    console.error('');
    process.exitCode = 1;
  }
})();
`;
}

// ── 主流程 ───────────────────────────────────────────────────

log('清理 build-tmp');
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });
fs.mkdirSync(DIST, { recursive: true });

const { exe: nodeExe, version } = findBuildNode();
log(`构建用 node: ${nodeExe} (${version})`);

const assets = collectAssets();
const totalBytes = Object.values(assets).reduce((a, b) => a + b.length, 0);
log(`内嵌 ${Object.keys(assets).length} 个文件（base64 后 ${(totalBytes / 1024).toFixed(0)} KB）`);

const launcherPath = path.join(TMP, 'launcher.cjs');
fs.writeFileSync(launcherPath, buildLauncher(assets));
log(`launcher.cjs: ${(fs.statSync(launcherPath).size / 1024).toFixed(1)} KB`);

log('语法检查 launcher');
run(nodeExe, ['--check', launcherPath]);

log('生成 SEA blob');
const seaCfg = path.join(TMP, 'sea-config.json');
fs.writeFileSync(
  seaCfg,
  JSON.stringify(
    {
      main: launcherPath,
      output: path.join(TMP, 'app.blob'),
      disableExperimentalSEAWarning: true,
      useSnapshot: false,
      useCodeCache: false,
    },
    null,
    2,
  ),
);
run(nodeExe, ['--experimental-sea-config', seaCfg], { cwd: TMP });
const blobPath = path.join(TMP, 'app.blob');
log(`blob: ${(fs.statSync(blobPath).size / 1024).toFixed(0)} KB`);

const exePath = path.join(DIST, 'netease-163key-tagger.exe');
log('复制 node 二进制作为模板');
fs.copyFileSync(nodeExe, exePath);

log('准备 postject');
const postjectCli = path.join(TMP, 'node_modules', 'postject', 'dist', 'cli.js');
if (!fs.existsSync(postjectCli)) {
  log('安装 postject（首次构建需要联网）');
  // 必须先写一个 package.json 把 temp 目录锚定成独立的 npm 项目，
  // 否则 npm 会往上找到仓库根或全局，报「up to date」但什么都没装。
  if (!fs.existsSync(path.join(TMP, 'package.json'))) {
    fs.writeFileSync(
      path.join(TMP, 'package.json'),
      JSON.stringify({ name: 'sea-build-tmp', private: true, version: '0.0.0' }, null, 2),
    );
  }
  run('npm', ['install', 'postject', '--no-audit', '--no-fund'], { cwd: TMP, shell: true });
}
if (!fs.existsSync(postjectCli)) die(`postject 未就位：${postjectCli}`);
log('postject 就绪');

if (process.platform === 'win32') {
  log('清空 PE 签名段（否则注入会破坏签名）');
  run(nodeExe, [
    '-e',
    `const fs=require('fs');const p=${JSON.stringify(exePath)};
     const b=fs.readFileSync(p);const peOff=b.readUInt32LE(0x3c);const optOff=peOff+0x18;
     const magic=b.readUInt16LE(optOff);const ddOff=optOff+(magic===0x20b?0x70:0x60);
     b.writeUInt32LE(0,ddOff+4*8);b.writeUInt32LE(0,ddOff+4*8+4);fs.writeFileSync(p,b);`,
  ]);
}

log('注入 SEA blob');
run(nodeExe, [postjectCli, exePath, 'NODE_SEA_BLOB', blobPath, '--sentinel-fuse', RESERVED], { cwd: TMP });

log(`✅ 完成: ${exePath}`);
log(`   体积 ${(fs.statSync(exePath).size / 1024 / 1024).toFixed(1)} MB`);
