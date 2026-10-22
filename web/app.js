// 前端逻辑：无框架、无构建。所有重活都在 apply.mjs 子进程里，这里只负责展示与转发。
const $ = (id) => document.getElementById(id);

const state = {
  config: {},
  report: null,
  scan: null,
  job: { status: 'idle' },
  verify: null,
  records: [],
  filter: 'all',
  filterText: '',
  current: null,
  pickedId: null,
};

// ── 小工具 ────────────────────────────────────────────────

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

const fmtDur = (ms) => (Number.isFinite(ms) && ms > 0 ? (ms / 1000).toFixed(1) : '—');
const fmtDelta = (ms) => (Number.isFinite(ms) ? (ms / 1000).toFixed(1) : '—');
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function log(line) {
  const el = $('log');
  el.textContent += `${line}\n`;
  el.scrollTop = el.scrollHeight;
}

// 报告里 artists / album 的形状不统一（候选里是字符串，best 里是对象），统一在这里收口
const artistNames = (a) =>
  (Array.isArray(a) ? a : [])
    .map((x) => (typeof x === 'string' ? x : x?.name))
    .filter(Boolean)
    .join(' / ');
const albumName = (a) => (typeof a === 'string' ? a : a?.name) || '';

function statusOf(r) {
  if (r.onDisk === 'match') return { cls: 'b-done', label: '已写入' };
  if (r.onDisk === 'differs') return { cls: 'b-ugc', label: '待重写' };
  if (r.manual) return { cls: 'b-manual', label: '手动' };
  if (!r.key163) return { cls: 'b-none', label: '未生成' };
  if (r.ugc) return { cls: 'b-ugc', label: 'UGC可疑' };
  if (r.durationMismatch) return { cls: 'b-dur', label: '时长不符' };
  if (r.auto) return { cls: 'b-auto', label: '自动' };
  if (r.confidence === 'medium') return { cls: 'b-review', label: '待复核' };
  return { cls: 'b-low', label: '低置信' };
}

// ── 数据加载 ──────────────────────────────────────────────

async function loadState() {
  const s = await api('/api/state');
  state.config = s.config;
  state.job = s.job;
  renderPaths();
  return s;
}

async function loadRecords() {
  try {
    const rep = await api('/api/report');
    state.report = rep;
    state.records = rep.records || [];
  } catch {
    state.report = null;
    const scan = await api('/api/scan-result');
    state.scan = scan;
    // 还没匹配：把扫描结果伪装成记录，让用户先看到文件
    state.records = (scan?.records || []).map((r) => ({
      file: r.file,
      format: r.format,
      localTitle: r.title,
      localArtist: r.artist,
      localAlbum: r.album,
      localDurationMs: r.durationMs,
      hasKey: r.hasKey,
      key163: r.key163,
      confidence: null,
      auto: false,
      best: null,
      top: [],
      unscanned: true,
    }));
  }
  render();
}

function renderPaths() {
  const c = state.config;
  const parts = [];
  parts.push(c.root ? `音乐目录 ${c.root}` : '未设置音乐目录');
  if (c.backup) parts.push(`备份 ${c.backup}`);
  $('paths').textContent = parts.join('   ·   ');
}

// 「可以被 apply 写进去」的判据，和服务端/CLI 是同一套：
// 有 key、不是 UGC 冒充、时长对得上，且要么自动要么被手动指定。
const isReady = (r) => !!r.key163 && !r.ugc && !r.durationMismatch && (r.manual || r.auto);
const needsReview = (r) => !isReady(r);

function visibleRecords() {
  const t = state.filterText.trim().toLowerCase();
  return state.records.filter((r) => {
    if (state.filter === 'auto' && !isReady(r)) return false;
    if (state.filter === 'review' && !needsReview(r)) return false;
    if (state.filter === 'manual' && !r.manual) return false;
    if (state.filter === 'nokey' && r.key163) return false;
    if (t) {
      const hay = [r.file, r.localTitle, r.localArtist, r.localAlbum, r.best?.name, (r.best?.artists || []).map((a) => a.name).join('/')]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      if (!hay.includes(t)) return false;
    }
    return true;
  });
}

function render() {
  const rows = state.records;
  const written = rows.filter((r) => r.onDisk === 'match').length;
  const canWrite = rows.filter((r) => isReady(r) && r.onDisk !== 'match').length;
  const review = rows.filter(needsReview).length;

  $('summary').textContent = rows.length
    ? `共 ${rows.length} 首 · 已写入 ${written} · 待写入 ${canWrite} · 待复核 ${review}`
    : '还没有数据';

  $('btn-match').disabled = !state.records.length || state.job.status === 'running';
  $('btn-apply').disabled = !state.report || state.job.status === 'running';
  $('btn-verify').disabled = !state.report || state.job.status === 'running';

  const list = visibleRecords();
  const tbody = $('tbody');
  if (!list.length) {
    tbody.innerHTML = `<tr><td colspan="6" class="empty">${
      state.records.length ? '没有符合筛选条件的记录' : '先点「① 扫描目录」'
    }</td></tr>`;
    return;
  }

  tbody.innerHTML = list
    .map((r) => {
      const st = statusOf(r);
      const delta = r.durationDeltaMs;
      const dcls = delta == null ? '' : delta > 5000 ? 'bad' : delta <= 2000 ? 'good' : '';
      const al = albumName(r.best.album);
      const hit = r.best
        ? `<div class="hitname">${esc(r.best.name)}</div>
           <div class="hitmeta">${esc(artistNames(r.best.artists))}${al ? ` · ${esc(al)}` : ''} · id ${esc(
             r.best.id,
           )} · 分数 ${esc(r.best.score)}</div>`
        : '<span class="mono">—</span>';
      return `<tr data-file="${esc(r.file)}">
        <td><span class="fmt">${esc(r.format || '?')}</span><span class="fname">${esc(r.file)}</span></td>
        <td><div>${esc(r.localArtist || '?')} - ${esc(r.localTitle || '?')}</div>
            <div class="hitmeta">${esc(r.localAlbum || '无专辑')}${r.hasKey || r.key163 ? ' · 已有 key' : ''}</div></td>
        <td class="delta">${fmtDur(r.localDurationMs)}s</td>
        <td><span class="badge ${st.cls}">${st.label}</span></td>
        <td>${hit}</td>
        <td>
          <button class="btn sm" data-act="review">复核</button>
          <button class="btn ghost sm" data-act="play">试听</button>
        </td>
      </tr>`;
    })
    .join('');

  tbody.querySelectorAll('button[data-act]').forEach((b) => {
    b.addEventListener('click', (e) => {
      const tr = b.closest('tr');
      const rec = state.records.find((x) => x.file === tr.dataset.file);
      if (!rec) return;
      if (b.dataset.act === 'review') openDrawer(rec);
      else {
        $('dw-audio').src = `/api/audio?file=${encodeURIComponent(rec.file)}`;
        $('dw-audio').play().catch(() => {});
      }
    });
  });
}

// ── 任务 ──────────────────────────────────────────────────

const OP_NAME = { scan: '扫描', match: '匹配', apply: '写入', verify: '校验' };

function setJob(job) {
  state.job = job || { status: 'idle' };
  const running = state.job.status === 'running' || state.job.status === 'cancelling';
  $('jobbar').hidden = !state.job.status || state.job.status === 'idle' || state.job.status === 'done';
  if (!state.job.status || state.job.status === 'idle') {
    render();
    return;
  }
  $('job-op').textContent = OP_NAME[state.job.op] || state.job.op;
  $('job-bar').style.width = '0%';
  render();
}

function onProgress(evt) {
  if (!evt) return;
  const total = evt.total || 0;
  const done = evt.done || 0;
  if (total > 0 && done >= 0) $('job-bar').style.width = `${Math.min(100, Math.round((done / total) * 100))}%`;

  if (evt.kind === 'start') {
    log(`▶ 开始${OP_NAME[evt.op] || evt.op}：${total} 个目标`);
    $('jobbar').hidden = false;
  } else if (evt.kind === 'progress') {
    if (evt.op === 'match') {
      const hit = evt.bestName ? `${evt.bestArtists?.join('/') || '?'} - ${evt.bestName}` : '(无候选)';
      log(`  [${evt.flag}] ${evt.file}  →  ${hit}${evt.durationDeltaMs != null ? `  Δ${fmtDelta(evt.durationDeltaMs)}s` : ''}`);
    } else {
      log(`  ${evt.file || ''} ${evt.status ? `[${evt.status}]` : ''}`);
    }
  } else if (evt.kind === 'done') {
    log(`✔ ${OP_NAME[evt.op] || evt.op}结束：${JSON.stringify(evt.tally || evt.counts || { total: evt.total, auto: evt.auto })}`);
    if (evt.op === 'verify' && evt.problems?.length) for (const p of evt.problems) log(`  ❌ ${p}`);
    $('job-bar').style.width = '100%';
  }
}

async function startOp(op) {
  try {
    if (op === 'apply') {
      const ready = state.records.filter(isReady);
      const pending = ready.filter((r) => r.onDisk !== 'match');
      const wantMeta = $('opt-meta').checked;
      const wantCover = $('opt-cover').checked;
      let extra = '';
      if (wantMeta || wantCover) {
        extra =
          `\n\n⚠️ 同时会改写文件里的元数据：\n` +
          `   · 标题 / 歌手 / 专辑  → 换成云端匹配到的\n` +
          (wantCover ? `   · 专辑封面 → 换成云端封面（会联网下载，文件体积会变化）\n` : '') +
          `   音频数据一字节都不会动。`;
      }
      const yes = confirm(
        `报告里可写入 ${ready.length} 个文件，其中 ${pending.length} 个还没写/内容不一致。\n\n` +
          `确定 = 实际写入\n取消 = 先 dry-run 预览，不改任何文件` +
          extra,
      );
      $('log').textContent = '';
      await api('/api/apply', { method: 'POST', body: { write: yes, meta: wantMeta || wantCover, cover: wantCover } });
      return;
    }
    if (op === 'scan') $('log').textContent = '';
    await api(`/api/${op}`, { method: 'POST', body: op === 'scan' ? undefined : {} });
  } catch (e) {
    log(`❌ ${e.message}`);
    alert(e.message);
  }
}

// ── 复核抽屉 ──────────────────────────────────────────────

function openDrawer(rec) {
  state.current = rec;
  state.pickedId = rec.manual?.id ?? rec.best?.id ?? rec.top?.[0]?.id ?? null;
  $('drawer').hidden = false;
  $('dw-title').textContent = rec.file;
  $('dw-sub').textContent = `${rec.format || '?'} · ${rec.size ? (rec.size / 1048576).toFixed(1) + ' MB' : ''}`;
  $('dw-local').innerHTML = `
    <div><b>${esc(rec.localArtist || '?')} — ${esc(rec.localTitle || '?')}</b></div>
    <div>专辑：${esc(rec.localAlbum || '—')}　时长：${fmtDur(rec.localDurationMs)}s　码率：${
      rec.bitrate ? Math.round(rec.bitrate / 1000) + 'k' : '—'
    }</div>
    <div class="mono">解析查询：${esc((rec.queries || []).map((q) => `${q.q}(${q.n})`).join(' / ') || '—')}</div>`;
  const a = $('dw-audio');
  a.src = `/api/audio?file=${encodeURIComponent(rec.file)}`;
  $('dw-kw').value = (rec.queries?.[0]?.q || `${rec.localTitle || ''} ${rec.localArtist || ''}`).trim();
  $('dw-clear').disabled = !rec.manual;
  renderCands(rec.top || [], rec);
}

/** 时长容差：与 lib/match.mjs 的 DURATION_TOLERANCE_MS 保持一致（仅用于配色，不参与判定） */
const DUR_TOL_MS = 5000;

function durClass(delta) {
  const a = Math.abs(delta);
  if (a <= 2000) return 'd-ok';
  if (a <= DUR_TOL_MS) return 'd-warn';
  return 'd-bad';
}

/** 封面用 div 背景图：加载失败自动落到灰底，不会留下破图图标 */
function coverHtml(c) {
  const pic = c.picUrl || c.albumPic;
  if (!pic) return '<div class="cover ph">—</div>';
  const small = pic + (pic.includes('?') ? '&' : '?') + 'param=88y88';
  return `<div class="cover" style="background-image:url('${esc(small)}')"></div>`;
}

/** 搜索结果排序完全由服务端决定（复用 lib/match.mjs 的权威打分）。
 *  前端不再自行排序 —— 曾经试过「按 |Δ时长| 升序」，结果把翻唱排到了原唱前面
 *  （实测翻唱差 0.7s、真原唱 185924 差 1.5s），属于在 UI 层重新引入已解决过的陷阱。 */
function renderCands(cands, rec) {
  const box = $('dw-cands');
  const known = Number.isFinite(rec?.localDurationMs);
  const ordered = cands;
  $('dw-candmeta').textContent = ordered.length ? `${ordered.length} 条候选` : '没有候选';
  if (!ordered.length) {
    box.innerHTML = `<div class="empty" style="padding:24px 0">没有候选。换个关键词，或直接粘贴歌曲 ID / 分享链接再搜一次 →</div>`;
    $('dw-use').disabled = true;
    return;
  }
  box.innerHTML = ordered
    .map((c) => {
      const artists = artistNames(c.artists);
      const alb = albumName(c.album);
      const apiDur = Number.isFinite(c.durationMs) && c.durationMs > 0 ? c.durationMs : null;
      const delta = Number.isFinite(c.localDeltaMs)
        ? c.localDeltaMs
        : apiDur != null && known
          ? apiDur - rec.localDurationMs
          : null;
      const bits = [`id ${c.id}`];
      if (c.score != null) bits.push(`分数 ${c.score}`);
      bits.push(`接口 ${apiDur != null ? (apiDur / 1000).toFixed(1) + 's' : '—'}`);
      if (known) bits.push(`本地 ${(rec.localDurationMs / 1000).toFixed(1)}s`);
      const cmp = bits.join(' · ') + (delta != null ? ` · <b class="${durClass(delta)}">Δ${fmtDelta(delta)}s</b>` : '');
      const tags = [];
      if (c.ugc) tags.push('<span class="tag ugc">UGC 冒充</span>');
      else if ((c.catalog ?? 0) >= 0.99) tags.push('<span class="tag official">曲库正版</span>');
      if (c.fee === 1) tags.push('<span class="tag vip">会员</span>');
      return `<label class="cand ${state.pickedId === c.id ? 'on' : ''}" data-id="${c.id}">
        <input type="radio" name="cand" value="${c.id}" ${state.pickedId === c.id ? 'checked' : ''} />
        ${coverHtml(c)}
        <div class="info">
          <div class="t1">${esc(c.name)}${tags.join('')}</div>
          <div class="t2">${esc(artists)}${alb ? ` · ${esc(alb)}` : ''}</div>
          <div class="cmp">${cmp}</div>
        </div>
      </label>`;
    })
    .join('');
  box.querySelectorAll('.cand').forEach((el) => {
    el.addEventListener('click', () => {
      state.pickedId = Number(el.dataset.id);
      box.querySelectorAll('.cand').forEach((x) => x.classList.toggle('on', x === el));
      $('dw-use').disabled = false;
    });
  });
  $('dw-use').disabled = state.pickedId == null;
}

async function usePicked() {
  const rec = state.current;
  if (!rec || state.pickedId == null) return;
  $('dw-use').disabled = true;
  $('dw-use').textContent = '生成中…';
  try {
    const r = await api('/api/choose', { method: 'POST', body: { file: rec.file, musicId: state.pickedId } });
    Object.assign(rec, r.record);
    log(`✔ 手动指定：${rec.file} → ${r.record.best?.name} (id ${state.pickedId})`);
    closeDrawer();
    await loadRecords();
  } catch (e) {
    alert(e.message);
    $('dw-use').disabled = false;
  } finally {
    $('dw-use').textContent = '使用选中的候选';
  }
}

function closeDrawer() {
  $('drawer').hidden = true;
  $('dw-audio').pause();
  $('dw-audio').src = '';
  state.current = null;
}

// ── 客户端检查 ────────────────────────────────────────────

async function openClient() {
  $('modal-client').hidden = false;
  $('client-body').textContent = '正在读取客户端数据库（只读）…';
  try {
    const [off, roots] = await Promise.all([api('/api/offline'), api('/api/download-roots')]);
    renderClient(off, roots);
  } catch (e) {
    $('client-body').innerHTML = `<p class="bad">读取失败：${esc(e.message)}</p>`;
  }
}

function renderClient(off, roots) {
  const body = $('client-body');
  if (!off.found) {
    body.innerHTML = `<p class="bad">${esc(off.reason || '找不到客户端数据库')}</p>
      <div class="hintbox">这个功能只在装了网易云音乐客户端的机器上有意义。<br>数据库路径：<code>${esc(off.libDir || '未知')}</code></div>`;
    return;
  }
  const tracks = off.tracks || [];
  const dl = state.config.downloadRoot || '';
  const parts = [];
  parts.push(`<dl class="kv">
    <dt>客户端库目录</dt><dd><code>${esc(off.libDir)}</code></dd>
    <dt>offlineTrack 行数</dt><dd>${tracks.length ? `<span class="ok">${tracks.length}</span>` : '<span class="bad">0</span>'}</dd>
    <dt>当前下载目录设置</dt><dd>${dl ? `<code>${esc(dl)}</code>` : '<span class="bad">未设置</span>'}</dd>
  </dl>`);

  if (tracks.length) {
    parts.push(`<p class="ok">✔ 客户端下载清单里已经有歌了。</p>`);
    parts.push(`<table><thead><tr><th>歌名</th><th>歌手</th><th>相对路径</th></tr></thead><tbody>
      ${tracks
        .slice(0, 30)
        .map(
          (t) =>
            `<tr><td>${esc(t.trackName || '—')}</td><td>${esc(t.artistName || '—')}</td><td class="mono">${esc(t.newRelativePath || '—')}</td></tr>`,
        )
        .join('')}
    </tbody></table>`);
  } else {
    parts.push(`<p class="bad">✘ 客户端认为「已下载」的歌曲数是 0。</p>`);
  }

  parts.push(`<div class="hintbox">
    <b>要让它变成「已下载」，还差这几步（按顺序）：</b>
    <ol>
      <li>把已经写好 163key 的文件，放进客户端设置的<b>下载目录</b>里（子目录也可以）</li>
      <li>完全退出网易云音乐客户端（托盘也要退），再重新打开 —— 它启动时会扫一遍下载目录</li>
      <li>回到这里点「重新检查」，看 <code>offlineTrack</code> 行数是否变大</li>
    </ol>
    <p style="margin:8px 0 0">如果行数还是 0，说明<b>目录选错了</b>或者<b>标签没写对</b>。这就是这条链路的判据。</p>
  </div>`);

  if (roots?.candidates?.length) {
    parts.push(`<p class="sub" style="margin-top:14px">候选下载目录（点击填入设置）：</p><div class="cfg-hint">`);
    const html = roots.candidates
      .map((c) => `<button class="btn sm" data-root="${esc(c.path)}">${esc(c.path)}　<span class="mono">${esc(c.why)}</span></button>`)
      .join('');
    parts.push(html, '</div>');
  }

  body.innerHTML = parts.join('');
  body.querySelectorAll('button[data-root]').forEach((b) => {
    b.addEventListener('click', async () => {
      await api('/api/config', { method: 'POST', body: { downloadRoot: b.dataset.root } });
      state.config.downloadRoot = b.dataset.root;
      log(`下载目录已设为 ${b.dataset.root}`);
      openClient();
    });
  });
}

// ── 设置 ──────────────────────────────────────────────────

function openSettings() {
  const c = state.config;
  $('cfg-root').value = c.root || '';
  $('cfg-backup').value = c.backup || '';
  $('cfg-download').value = c.downloadRoot || '';
  $('cfg-limit').value = c.searchLimit ?? 100;
  $('cfg-queries').value = c.maxQueries ?? 2;
  $('cfg-sleep').value = c.sleepMs ?? 300;
  $('cfg-hints').textContent = '';
  $('modal-settings').hidden = false;
  api('/api/download-roots')
    .then((r) => {
      if (!r.candidates?.length) return;
      $('cfg-hints').innerHTML =
        '检测到的候选目录：' +
        r.candidates.map((x) => `<button class="btn sm" data-pick="${esc(x.path)}">${esc(x.path)}</button>`).join('');
      $('cfg-hints')
        .querySelectorAll('button[data-pick]')
        .forEach((b) =>
          b.addEventListener('click', () => {
            $('cfg-download').value = b.dataset.pick;
          }),
        );
    })
    .catch(() => {});
}

async function saveSettings() {
  try {
    const r = await api('/api/config', {
      method: 'POST',
      body: {
        root: $('cfg-root').value,
        backup: $('cfg-backup').value,
        downloadRoot: $('cfg-download').value,
        searchLimit: Number($('cfg-limit').value),
        maxQueries: Number($('cfg-queries').value),
        sleepMs: Number($('cfg-sleep').value),
      },
    });
    state.config = r.config;
    renderPaths();
    $('modal-settings').hidden = true;
    log(`设置已保存。保护目录：${(r.protectedRoots || []).join(' , ') || '(无)'}`);
    await loadRecords();
  } catch (e) {
    alert(e.message);
  }
}

// ── 事件绑定 ──────────────────────────────────────────────

$('btn-scan').onclick = () => startOp('scan');
$('btn-match').onclick = () => startOp('match');
$('btn-apply').onclick = () => startOp('apply');
$('btn-verify').onclick = () => startOp('verify');
$('btn-cancel').onclick = async () => {
  await api('/api/cancel', { method: 'POST', body: {} });
  log('已请求取消…');
};
$('btn-settings').onclick = openSettings;
$('btn-client').onclick = openClient;
$('cfg-save').onclick = saveSettings;
$('cfg-cancel').onclick = () => ($('modal-settings').hidden = true);
$('client-close').onclick = () => ($('modal-client').hidden = true);
$('client-refresh').onclick = openClient;
$('dw-close').onclick = closeDrawer;
$('dw-use').onclick = usePicked;
$('dw-clear').onclick = async () => {
  if (!state.current) return;
  await api('/api/choose', { method: 'POST', body: { file: state.current.file, clear: true } });
  closeDrawer();
  await loadRecords();
};
$('dw-search').onclick = async () => {
  const kw = $('dw-kw').value.trim();
  if (!kw || !state.current) return;
  $('dw-candmeta').textContent = '搜索中…';
  $('dw-use').disabled = true;
  try {
    const r = await api('/api/search', {
      method: 'POST',
      body: { keyword: kw, limit: 50, file: state.current.file },
    });
    const hits = r.hits || [];
    if (!hits.length) {
      $('dw-candmeta').textContent = '没搜到';
      renderCands([], state.current);
      return;
    }
    state.pickedId = hits[0].id;
    renderCands(hits, state.current);
    $('dw-candmeta').textContent = `${hits.length} 条${r.byId ? '（按 ID 精确查）' : r.rankedByEngine ? '（已按匹配引擎打分排序）' : ''}`;
  } catch (e) {
    $('dw-candmeta').textContent = e.message;
  }
};
$('btn-clear-log').onclick = () => ($('log').textContent = '');

$('btn-pick-all').onclick = async () => {
  const btn = $('btn-pick-all');
  btn.disabled = true;
  const old = btn.textContent;
  btn.textContent = '试算中…';
  try {
    const preview = await api('/api/pick-all', { method: 'POST', body: { dryRun: true } });
    if (!preview.total) {
      alert('没有可批量挑选的文件。\n\n只处理「待复核」且有时长合理候选的那些；\n时长不符、UGC 冒充的会保留给你人工判断。');
      return;
    }
    const lines = preview.plan
      .slice(0, 12)
      .map((p) => `· ${p.file}\n    → ${(p.pick.artists || []).join('/')} - ${p.pick.name} (id ${p.pick.id}, 分数 ${p.pick.score})`);
    const more = preview.plan.length > 12 ? `\n… 还有 ${preview.plan.length - 12} 个` : '';
    if (!confirm(`将为 ${preview.total} 个待复核文件写入「引擎评分最高」的候选：\n\n${lines.join('\n')}${more}\n\n确定执行？`)) return;
    btn.textContent = '写入中…';
    const r = await api('/api/pick-all', { method: 'POST', body: { dryRun: false } });
    log(`✔ 批量挑选：${r.applied}/${r.total} 个已按引擎打分重选` + (r.failed?.length ? `，失败 ${r.failed.length}` : ''));
    for (const f of r.failed || []) log(`  ❌ ${f.file}: ${f.error}`);
    await loadRecords();
  } catch (e) {
    alert(e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = old;
  }
};

$('chips').addEventListener('click', (e) => {
  const b = e.target.closest('.chip');
  if (!b) return;
  $('chips').querySelectorAll('.chip').forEach((c) => c.classList.toggle('on', c === b));
  state.filter = b.dataset.f;
  render();
});
$('filter-text').addEventListener('input', (e) => {
  state.filterText = e.target.value;
  render();
});
// 勾了封面就自动勾上文字元数据（封面改了就一定意味着要改专辑信息）
$('opt-cover').addEventListener('change', (e) => {
  if (e.target.checked) $('opt-meta').checked = true;
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (!$('drawer').hidden) closeDrawer();
    $('modal-settings').hidden = true;
    $('modal-client').hidden = true;
  }
});

// ── SSE ───────────────────────────────────────────────────

function connectSSE() {
  const es = new EventSource('/api/events');
  es.addEventListener('job', (e) => {
    const job = JSON.parse(e.data);
    setJob(job);
    if (job.status === 'done' || job.status === 'failed' || job.status === 'cancelled') {
      setTimeout(async () => {
        try {
          if (job.op === 'verify') state.verify = await api('/api/verify-result');
          await loadRecords();
        } catch {
          /* 报告可能还没生成 */
        }
      }, 200);
    }
  });
  es.addEventListener('progress', (e) => onProgress(JSON.parse(e.data)));
  es.onerror = () => {
    /* EventSource 自己会重连 */
  };
}

// ── 启动 ──────────────────────────────────────────────────

(async () => {
  try {
    await loadState();
    await loadRecords();
    connectSSE();
    log('就绪。① 扫描 → ② 匹配 → 复核 → ③ 写入 → ④ 校验。');
  } catch (e) {
    log(`启动失败：${e.message}`);
  }
})();
