/**
 * 文件名解析 + 候选打分。
 * 纯逻辑，不发网络请求，便于离线测试。
 *
 * 目标文件名规则（网易云下载目录的约定）：`歌手 - 歌名.ext`
 */

// ── 文本归一化 ───────────────────────────────────────────────

/** 全角 -> 半角（仅字母/数字/常见标点） */
export function toHalfWidth(s) {
  return String(s)
    .replace(/[\uff01-\uff5e]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/\u3000/g, ' ');
}

const PUNCT = /[\s()\[\]{}【】（）《》<>"'`~!@#$%^&*_+=|\\/,.?;:，。、？！；：·・…—–\-]/g;

/** 比较用归一化：去空白与标点、转小写、全角转半角 */
export function norm(s) {
  return toHalfWidth(s || '')
    .toLowerCase()
    .replace(PUNCT, '');
}

/** 去掉 feat./with 段落后的核心名 */
export function coreName(s) {
  return (s || '')
    .replace(/[（(]\s*(?:feat|ft|with|FEAT|FT|WITH)\.?\s*[^）)]*[）)]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 字符二元组 Dice 相似度，对中文友好 */
export function dice(a, b) {
  if (!a && !b) return 1;
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;
  const grams = (s) => {
    const m = new Map();
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2);
      m.set(g, (m.get(g) || 0) + 1);
    }
    return m;
  };
  const ga = grams(a);
  const gb = grams(b);
  let inter = 0;
  for (const [g, n] of ga) inter += Math.min(n, gb.get(g) || 0);
  const total = a.length - 1 + (b.length - 1);
  return (2 * inter) / total;
}

/** 名称相似度：相等 1.0；互相包含 0.9；否则 Dice */
export function nameSim(a, b) {
  const na = norm(a);
  const nb = norm(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const ca = norm(coreName(a));
  const cb = norm(coreName(b));
  if (ca && cb && ca === cb) return 0.97;
  if (na.includes(nb) || nb.includes(na)) {
    const shorter = Math.min(na.length, nb.length);
    const ratio = shorter / Math.max(na.length, nb.length);
    // 单字名被更长的名字包含，证据太弱，不给高分
    if (shorter < 2) return 0.7;
    return Math.min(0.97, 0.76 + 0.2 * ratio);
  }
  if (ca && cb && (ca.includes(cb) || cb.includes(ca))) return 0.85;
  return Math.max(dice(na, nb), dice(ca, cb)) * 0.95;
}

// ── 文件名解析 ───────────────────────────────────────────────

const EXT_RE = /\.(mp3|flac|m4a|ncm|wav|ape|ogg|aac|wma|mp4)$/i;
/** 网易云/其它下载器塞进文件名的噪音 */
const NOISE_RES = [
  /\[(?:mqms2?|320k|flac|sq|hq|lq|无损|高清|高音质|独家)\]/gi,
  /[（(](?:320k|flac|sq|hq|lq|无损|高音质|高清)[）)]/gi,
  /\s*-\s*副本(?:\s*\(\d+\))?\s*$/,
  /\s*\(\d+\)\s*$/,
];
const ARTIST_SPLIT_RE = /\s*[,、&/;]\s*|\s+(?:feat|ft|with)\.?\s+/i;
const FEAT_RE = /[（(]\s*(?:feat|ft|with)\.?\s*([^）)]*)[）)]/i;

/**
 * 解析 `歌手 - 歌名.ext`。
 * @returns {{raw,title,artist,artists,feat,titleCore,queries}}
 */
export function parseFilename(fileOrBase) {
  let base = String(fileOrBase);
  if (base.includes('/') || base.includes('\\')) base = base.replace(/^.*[\\/]/, '');
  let raw = base;
  for (const re of NOISE_RES) base = base.replace(re, ' ');
  const hadExt = EXT_RE.test(base);
  base = base.replace(EXT_RE, '').trim();
  base = base.replace(/\s{2,}/g, ' ');

  // 优先用「两侧带空格的短横线」切分，避免切到歌名里的连字符
  const seps = [/\s+[-\u2013\u2014]\s+/, /\s*\uff0d\s*/, /\s+\u2015\s+/];
  let artist = null;
  let title = base;
  for (const re of seps) {
    const i = base.search(re);
    if (i > 0) {
      const m = base.match(re);
      artist = base.slice(0, i).trim();
      title = base.slice(i + m[0].length).trim();
      break;
    }
  }

  const feat = [];
  for (const src of [title, artist || '']) {
    const m = src && src.match(FEAT_RE);
    if (m) {
      for (const p of m[1].split(ARTIST_SPLIT_RE)) {
        const t = p.trim();
        if (t) feat.push(t);
      }
    }
  }

  const artists = artist
    ? artist
        .split(ARTIST_SPLIT_RE)
        .map((s) => s.trim())
        .filter(Boolean)
    : [];

  const titleCore = coreName(title);
  const queries = [];
  const push = (q) => {
    const t = q.replace(/\s+/g, ' ').trim();
    if (t && !queries.includes(t)) queries.push(t);
  };
  if (artist) {
    push(`${titleCore} ${artists[0]}`);
    push(`${title} ${artist}`);
    if (artists.length > 1) push(`${titleCore} ${artists.slice(0, 2).join(' ')}`);
  }
  push(titleCore);
  push(title);
  if (artists[0]) push(artists[0]);

  return { raw, hadExt, title, titleCore, artist, artists, feat, queries };
}

// ── 候选打分 ─────────────────────────────────────────────────
const W = { title: 0.48, artist: 0.26, duration: 0.14, album: 0.05, catalog: 0.07 };

/**
 * 本地实测时长与接口时长的「自动放行」容差（毫秒）。
 * apply.mjs 复用同一个常量当硬闸门，避免两处阈值漂移。
 */
export const DURATION_TOLERANCE_MS = 5000;

/**
 * 参与「候选优先」排序的时长容差（毫秒）。
 * 超过这个范围的候选一律排在通过容差的候选之后——同一首歌的伴奏 / remix / 合辑版
 * 往往歌名和歌手一模一样，只有时长能区分，所以这一项必须能压过名称。
 */
export const DURATION_RANK_MS = 10000;

function durationScore(a, b) {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  const d = Math.abs(a - b);
  if (d <= 2000) return 1;
  if (d <= DURATION_TOLERANCE_MS) return 0.85;
  if (d <= DURATION_RANK_MS) return 0.6;
  if (d <= 20000) return 0.25;
  if (d <= 60000) return 0.05;
  return 0;
}

/** 候选里任一艺人与本地任一艺人名的最高相似度 */
export function artistScore(apiArtists, localArtists) {
  if (!apiArtists || !apiArtists.length || !localArtists || !localArtists.length) return null;
  let best = 0;
  for (const a of apiArtists) {
    const an = typeof a === 'string' ? a : a?.name;
    if (!an) continue;
    for (const l of localArtists) {
      best = Math.max(best, nameSim(an, l));
    }
  }
  return best;
}

/**
 * 曲库身份分：判别「真正的曲库条目」与「用户上传的冒充条目」。
 *
 * 这不是启发式，是实测出来的硬特征。匿名搜索会把 UGC 排在前面，而 UGC 有两个
 * 稳定的结构性特征：
 *   1. **artist.id === 0** —— 上传者没有注册艺人页，反查出 `周杰伦#0`、`Xa小爱#0`
 *      这类占位。真正的曲库艺人一定有非 0 id（周杰伦 = 6452、颜人中 = 31376161）。
 *   2. **album 名为空** —— UGC 没有专辑信息（dump 出来就是 `《》`）。
 *
 * 实测「爱在西元前 周杰伦」前 100 条里，artist.id===0 的有 25 条，
 * 其中 8 条直接把艺人名写成「周杰伦」冒充原唱（如 2153879235 周杰伦#0《》），
 * 而真·周杰伦(6452)的《范特西》版是 186114。
 *
 * 注意「部分 id 为 0」是真实存在的脏数据（如 2735941345 `pro#53262224/陈小满#0`，
 * 专辑名有效、时长也对得上），这类**不能**当作冒充条目拦掉，只在 catalogScore 里扣分。
 */
export function catalogScore(cand) {
  const arts = cand?.artists || [];
  const ids = arts.map((a) => a?.id).filter((v) => Number.isInteger(v));
  // 接口没回传 id 时按「未知」处理（中性 0.5），不能当成 UGC——
  // 只有「明确给了 id 且全是 0」才是上传者占位。
  let idPart;
  if (!ids.length) idPart = 0.5;
  else {
    const real = ids.filter((v) => v > 0).length;
    idPart = real === ids.length ? 1 : real > 0 ? 0.5 : 0;
  }
  const albumPart = cand?.album?.name && String(cand.album.name).trim() ? 1 : 0;
  return 0.5 * idPart + 0.5 * albumPart;
}

/**
 * 是不是「确定无疑的 UGC 冒充条目」：艺人 id **明确给了且全是 0**，并且没有专辑名。
 * 真曲库条目绝不会同时满足这两条（周杰伦 = 6452、颜人中 = 31376161），
 * 所以命中即可安全地排到最后并禁止自动应用。
 *
 * 判定故意保守：「部分 id 为 0」或「有专辑名」都不算。
 * 例：2735941345 `pro#53262224/陈小满#0`《心底的旧》—— 有真艺人、有专辑、时长也对，
 * 是真条目，不能误伤。
 */
export function isDefiniteUgc(cand) {
  const arts = cand?.artists || [];
  const ids = arts.map((a) => a?.id).filter((v) => Number.isInteger(v));
  if (!ids.length || ids.some((v) => v > 0)) return false;
  return !(cand?.album?.name && String(cand.album.name).trim());
}

/**
 * @param cand {{id,name,artists,album,durationMs}}
 * @param parsed  parseFilename 的结果
 * @param opts {{localDurationMs?, localAlbum?, localArtists?}}
 */
export function scoreCandidate(cand, parsed, opts = {}) {
  const localArtists = opts.localArtists?.length ? opts.localArtists : parsed.artists;
  const parts = {
    title: nameSim(cand.name, parsed.title),
    artist: artistScore(cand.artists, localArtists),
    duration: durationScore(cand.durationMs, opts.localDurationMs),
    album: opts.localAlbum && cand.album?.name ? nameSim(cand.album.name, opts.localAlbum) : null,
    catalog: catalogScore(cand),
  };
  let sum = 0;
  let wsum = 0;
  for (const k of Object.keys(W)) {
    if (parts[k] == null) continue;
    sum += parts[k] * W[k];
    wsum += W[k];
  }
  const score = wsum ? sum / wsum : 0;
  return { ...cand, score, parts };
}

/**
 * 排序 + 置信度判定。
 * @returns {{ranked, best, confidence:'high'|'medium'|'low', ambiguous, auto, durationDeltaMs, durationMismatch, ugc}}
 */
export function pickBest(candidates, parsed, opts = {}) {
  // 三级排序：
  //   ① 确定无疑的 UGC（艺人 id 全 0 且无专辑）一律垫底；
  //   ② 时长对得上（0）→ 时长未知（1）→ 时长明确对不上（2）；
  //   ③ 组内按加权分。
  const group = (c) => (c.parts.duration == null ? 1 : c.parts.duration >= 0.6 ? 0 : 2);
  const ranked = (candidates || [])
    .map((c) => scoreCandidate(c, parsed, opts))
    .sort((a, b) => group(a) - group(b) || b.score - a.score);

  const empty = {
    ranked, best: null, confidence: 'low', ambiguous: false, gap: 1, auto: false,
    durationDeltaMs: null, durationMismatch: false, ugc: false, duplicateIds: [], sameRelease: false,
  };
  if (!ranked.length) return empty;

  const head = ranked[0];
  const second = ranked[1] || null;
  const gap = second ? head.score - second.score : 1;

  // 「同一发行的重复条目」：并列表现在**同一张专辑**上，时长也几乎一样。
  // 这不是「分不出来」——是同一段录音在曲库里的重复登记，写哪个 musicId
  // 客户端都显示成同一首歌、同一张封面。此时按 id 升序确定性择一，不算歧义。
  // 反例（真歧义）：并列但 albumId 不同，那可能是不同版本，必须人工看。
  const tied = ranked.filter((c) => head.score - c.score < 0.05 && (c.parts.title ?? 0) >= 0.97);
  const sameRelease =
    tied.length > 1 &&
    tied.every(
      (c) =>
        c.album?.id != null &&
        String(c.album.id) === String(head.album?.id) &&
        Math.abs((c.durationMs ?? 0) - (head.durationMs ?? 0)) <= 1000,
    );

  let best = head;
  let duplicateIds = [];
  if (sameRelease) {
    // 确定性择一：取 id 最小的那条，把它挪到最前，保证多次运行结果一致
    best = tied.reduce((m, c) => (c.id < m.id ? c : m), tied[0]);
    duplicateIds = tied.filter((c) => c.id !== best.id).map((c) => c.id).sort((a, b) => a - b);
    const i = ranked.indexOf(best);
    if (i > 0) {
      ranked.splice(i, 1);
      ranked.unshift(best);
    }
  }

  // 「真歧义」= 第一名和第二名在各维度上都分不出来，写哪个 musicId 都可能错。
  // 必须同时满足：歌名几乎一样、歌手几乎一样、时长都在容差内、专辑也对得一样齐。
  //
  // 反例（不该判为歧义）：夜曲 185904《11月的萧邦》album=0.57 压过 406346134 album=0，
  // 专辑名就是决胜信号，此时差距 0.028 只是分数接近，不是分不出来。
  const nameTie = !!second && (second.parts.title ?? 0) >= 0.97 && (second.parts.artist ?? 0) >= 0.9;
  const durationTie = !!second && (second.parts.duration ?? 0) >= 0.85 && (best.parts.duration ?? 0) >= 0.85;
  const albumTie =
    !!second &&
    (best.parts.album == null || second.parts.album == null
      ? best.parts.album === second.parts.album
      : Math.abs(best.parts.album - second.parts.album) < 0.1);
  const ambiguous = nameTie && durationTie && albumTie && gap < 0.05 && !sameRelease;

  const t = best.parts.title ?? 0;
  const a = best.parts.artist ?? 0;
  let confidence = 'low';
  if (t >= 0.97 && a >= 0.9) confidence = 'high';
  else if (t >= 0.85 && a >= 0.7) confidence = 'medium';
  if (ambiguous) confidence = confidence === 'high' ? 'medium' : 'low';

  // 时长硬闸门：歌名/歌手都对得上、时长却差了一大截，命中的几乎必然是伴奏 / remix /
  // 合辑版，写进去的 musicId 就是错的。实测在真实歌单上这类占 26/57，所以它必须
  // 能独立把置信度打到 low，而不是只当加权项。
  const durationDeltaMs =
    Number.isFinite(best.durationMs) && Number.isFinite(opts.localDurationMs)
      ? Math.abs(best.durationMs - opts.localDurationMs)
      : null;
  const durationMismatch = durationDeltaMs != null && durationDeltaMs > DURATION_TOLERANCE_MS;
  if (durationMismatch) confidence = 'low';

  // UGC 冒充条目：艺人 id 全 0 且没有专辑名。这种候选绝不能自动应用，
  // 否则会把「周杰伦#0 上传的翻唱」的 musicId 写进文件。
  const ugc = isDefiniteUgc(best);
  if (ugc) confidence = 'low';

  const auto = !ambiguous && !durationMismatch && !ugc && confidence === 'high' && best.score >= 0.8;
  return { ranked, best, confidence, ambiguous, gap, auto, durationDeltaMs, durationMismatch, ugc, duplicateIds, sameRelease };
}
