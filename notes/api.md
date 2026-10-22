# 网易云 API 实证笔记（netease-163key-tagger / task-1）

作者：api-probe　最后更新：2026-10-22
所有结论均标注证据来源（`probe/out/*.json`、真实样本标签、客户端二进制/数据库）。
标 **【实证】** 的表示有可复跑的直接证据；标 **【推断】** 的表示有旁证但不能在本机闭环证实。

---

## 0. 结论速查

| 问题 | 结论 | 等级 |
| --- | --- | --- |
| A. `mp3DocId` 来源 | = `GET /api/song/enhance/player/url` 返回的 `data[0].md5`，即**服务端 CDN 对象摘要**，本地不可能算出 | 【实证】 |
| A. 匿名可得率 | 57 个真实文件：depth=10 时 **51 个（89.5%）**、**depth=100（现行）48 个（84.2%）** 拿到真 md5；其余是 VIP/受保护曲（`code=-110`） | 【实证】 |
| A. 拿不到时填什么 | 确定性合成 md5（32 位 hex，每首唯一、幂等），**不要填空串/全 0**；客户端不比对，见 §3.4 | 【实证 + 旁证】 |
| B. 最稳链路 | search：`POST /api/cloudsearch/pc`（**唯一带 `al.picUrl`/`pic_str`**）；detail：`GET /api/v3/song/detail?c=[{"id":N}]`；两步 100% 匿名可用 | 【实证】 |
| **搜索深度** | **匿名搜索是 UGC 优先：原唱常被埋在 20~100 名；`limit=10` 根本看不到正确版本。生产必须 `limit=100`** | 【实证，§8】 |
| `limit` 上限 | **100 是硬上限**：`limit=200/500` 静默返回 0 条，`limit=1000` 返回 `code=400` | 【实证，§2.1】 |
| `songCount` | 该 query 的匹配总数，但**分段可信**：短/宽泛 query 恒定可信；**长 query 在 `limit<100` 下是被截断的近似值**（80 vs 真实 140），甚至可能缺失 | 【实证，§2.1】 |
| `offset` 分页 | 有效但**对 300 取模**（`offset=300` 又回到第一页）；可达深度约 300 | 【实证，§2.1】 |
| `albumPicDocId` = picUrl 末段？ | 57/57 相等；但数值型 `pic`/`picId` **丢精度**，只能用 `pic_str` 或 picUrl 末段 | 【实证】 |
| flac 的 `format` | 写 `"flac"`（小写、容器 token） | 【推断，两条旁证】 |
| `duration` 取哪个值 | **接口 `dt` 优先**（与真实标签逐字节相同 14/14；本地覆盖只能到 13/14），本地实测仅作闸门与回退 | 【实证】 |
| albumPic 的 p1~p4 分片 | 四片返回**同一张图**（同 sha256），分片按请求轮换，不需要归一化 | 【实证】 |
| 163key 缺 `mp3DocId` 客户端会怎样 | 客户端**不存、不比对** docId（`dbTrack` 里 `md5/docId/mp3DocId` 命中 0）⇒ 合成值不影响识别 | 【实证 + 旁证，§3.4】 |

---

## 1. `getSongDetail()` 返回的真实形状（脱敏样例）

`getSongDetail(1809412694)`（真实样本那首）实际返回，**恰好 14 个键、顺序固定**：

```json
{
  "musicId": 1809412694,
  "musicName": "John Dreamer-亚托克斯 伴奏（Jackie remix）",
  "artist": [["Jackie", 37125028]],
  "albumId": 121139178,
  "album": "ATOX",
  "albumPicDocId": "109951165606660795",
  "albumPic": "https://p2.music.126.net/fDOu_nezGgSAF5NfVuqFsg==/109951165606660795.jpg",
  "bitrate": 320000,
  "mp3DocId": "cde6b150f488f81c8f0d9b374d2fe2fb",
  "duration": 213702,
  "mvId": 0,
  "alias": [],
  "transNames": [],
  "format": "mp3"
}
```

要点：
- `artist` 是 `[[name, id], ...]`（数组的数组，与 163key 明文一致，不是 API 原生的 `ar:[{name,id}]`）。
- `albumPicDocId` 是**字符串**（18 位 doc id 超过 2^53，数值型会丢精度，见 §4）。
- `mp3DocId` 是**真 md5**（非回退值）：与真实标签、与 CDN 对象名三者完全相同。
- `duration` 是**接口给的** `dt`（毫秒），不是 0；接口没给才回退本地实测（口径与证据见 §7）。
- `format` 在 `getSongDetail` 里是占位 `"mp3"`，调用方必须用 `to163Meta(detail, { format })` 按实际容器覆盖。
- `searchSong()` 返回的候选 `durationMs` 契约：**有限正数毫秒，或 `null`（= 未知）**，绝不为 `0`。`0` 是有限数，会被下游当成「时长为 0 的明确值」而误触发时长硬闸门；`null` 才等于「未知」。
  > 回归断言：`probe/08-fidelity-assert.mjs` 的 `F1/F2/F3`（F3 直接验证「null 不触发闸门、0 会触发」，用的是生产真正在跑的 `lib/match.mjs` 的 `pickBest`）。

`to163Meta(detail, opts)` 接受三种输入形态（`coerceDetail()` 显式识别，不再靠猜）：
①上面这种 meta 形态（`'musicId' in x && 'mp3DocId' in x`）；
②内部 normalized 形态（含 `albumPicDocIdRaw` / `qualities` / `durationMs`）；
③API 原生 raw 形态（`/api/v3/song/detail` 的 `songs[0]`、`/api/song/detail` 的 `songs[0]`、cloudsearch 的 `result.songs[0]`）。

> 历史坑（已修）：早期版本用 `detail.album` 是否为对象来判断形态，而 meta 形态里 `detail.album` 是非空**字符串**，于是被误判成 raw 形态，二次归一化后 `musicId` 变 **NaN**、`musicName` 变 `""`、`artist` 变 `[]`、`albumPicDocId` 变 `""`。NaN 尤其阴：`typeof` 仍是 `'number'`、`JSON.stringify` 静默变 `null`。现在所有数值字段都过 `safeInt()`（`Number.isFinite` 兜底），`to163Meta` 末尾还有一道自检，出现 `undefined` 或非有限数值直接 `throw NeteaseApiError`。
> 回归自测：`node probe/08-fidelity-assert.mjs` —— **27 条断言全部通过**，含纯离线 fixture（`to163Meta(真实meta, {})` 必须与输入逐字段相同）与 `duration` 契约（`A8/A9/F1/F2/F3/G1~G4`）。

> **候选打分/文件名解析不在本模块**：唯一权威实现是 `lib/match.mjs`（`parseFilename` / `pickBest` / `DURATION_TOLERANCE_MS=5000` / `DURATION_RANK_MS=10000`），`apply.mjs` 主流程使用它。`lib/netease-api.mjs` 早期自带的 `pickBestMatch()`（含另一套时长阈值）**已删除**，避免两套阈值漂移。

---

## 2. 可用端点清单（全部**匿名可用**，无 Cookie；UA 伪装 Chrome + `Referer: https://music.163.com/`）

| 端点 | 方法 | 匿名 | 状态码 | 耗时 | 体积 | 备注 |
| --- | --- | --- | --- | --- | --- | --- |
| `/api/cloudsearch/pc` | POST form | ✅ | 200 / code 200 | 192–326ms（均 218ms） | 14.5–16KB | **search 首选**，字段最全（含 `al.picUrl`/`al.pic_str`/`alia`/`mv`/`dt`） |
| `/api/search/get/web?s=&type=1` | GET | ✅ | 200 / code 200 | 159–271ms | ~7KB | 备用，**缺 `al.picUrl`/`al.pic_str`**（无封面 URL） |
| `/api/search/get` | POST form | ✅ | 200 / code 200 | 166–265ms | ~7KB | 同上，备用 |
| `/api/v3/song/detail?c=[{"id":N}]` | GET | ✅ | 200 / code 200 | 56–73ms（均 73ms） | 2.1–2.3KB | **detail 首选**，含 `al.picUrl`+`al.pic_str`+`alia`+`mv`+`dt` |
| `/api/song/detail/?ids=[N]` | GET | ✅ | 200 / code 200 | 51–73ms（均 54ms） | 2.9–3.7KB | 唯一带 **`transName`** 的端点（老接口，兼容保留） |
| `/api/song/enhance/player/url?ids=[N]&br=320000` | GET | ✅ | 200 / code 200 或 **-110** | 49–70ms（均 57ms） | ~0.5KB | **`data[0].md5` = mp3DocId**；VIP 曲 `code=-110`、`md5=null` |
| `/api/song/enhance/player/url/v1?ids=[N]&level=exhigh` | GET | ✅ | 200 / code 200 或 -110 | ~52ms | ~0.5KB | 退路；**`level=lossless` 会被静默降级**成 exhigh/mp3，拿不到无损对象 |
| `/api/song/lyric` | GET | ✅ | 200 / code 200 | ~60ms | — | 与 163key 无关，仅确认可用 |
| `/api/song/enhance/download/url` | GET | ❌ | 200 但 `{"data":null,"code":301}` | — | — | **匿名不可用**（下载接口必须登录） |
| `/api/album/<id>` | GET | ❌ | **code -462** `请绑定手机后再试哦~` | — | — | 匿名被风控 |
| `/api/linux/forward` | POST | ❌ | HTTP 400 非 JSON | — | — | 已死 |
| `/api/song/url`、`/api/mv/detail?id=0` | GET | ❌ | code 404 | — | — | 不可用 |
| `music.163.com/song/media/outer/url?id=N.mp3` | GET | ✅ | 200（跟随后返回音频字节） | ~494ms | 音频 | 只能下音频，无 JSON |

### 参数细节（踩过的坑）
- `/api/song/detail/?ids=[N]` 的方括号**必须打**，写 `ids=N` 返回 `code=400`。
- `/api/v3/song/detail` 的 `c` 必须是 JSON 字符串：`c=[{"id":1809412694}]`，要 URL 编码。
- 这批接口用 `POST` 时 body 是 `application/x-www-form-urlencoded`（不是 JSON）。
- 所有接口都会返回 HTTP 200 + JSON 里的业务 `code`，**必须看 `code` 而不是 HTTP 状态码**。

### 2.1 搜索深度 / `limit` / `songCount` / `offset` 语义【实证，`probe/10-depth-limit.mjs` → `out/10-depth-limit.json`】

**（1）五个搜索端点返回同一结果集，但字段覆盖不同。** 用 `s=简单爱 周杰伦&type=1&limit=30` 对比
`GET/POST /api/cloudsearch/pc`、`GET/POST /api/search/get/web`、`GET/POST /api/search/get`：
**ids 逐个相同（首个不同位 = -1，30/30 一致）** —— 不是端点选择问题。
但字段覆盖有差异：**只有 `cloudsearch/pc` 返回 `al.picUrl` 与 `al.pic_str`**，其余四个端点的 `al` 里这两个字段**完全缺失**（`alia`/`mv`/`dt` 都有）。所以对本项目而言端点**不可互换**，`searchSong` 必须首选 `cloudsearch/pc`。

**（2）`limit` 的硬上限是 100。**
| limit | songCount | 实际返回 |
| --- | --- | --- |
| 10 | 80 | 10 |
| 30 | 80 | 30 |
| 100 | 80 | 80（= 池子全量） |
| 200 | null | **0（静默失败，HTTP 200/code 200）** |
| 500 | null | **0（同上）** |
| 1000 | null | 0（`code=400`） |

**（3）`songCount` 是「该 query 的匹配总数」，但可信度**分段**，取决于 query 长短与 limit【分段行为，Lead 与 api-probe 各自复跑后确认】**
先说结论：**`songCount` 不是「与 limit 无关」的绝对量**。对**短/宽泛** query 它恒定且可信；对**长 query**（本项目实际用的「歌名 + 歌手」正是长的）`limit<100` 时它只是**被截断的近似值**，`limit=100` 才接近真实，甚至可能**整个字段消失**。

Lead 的分段实测（`out/scratch/verify-songcount.mjs`/`songcount2.mjs`，可复跑）：

| query | limit=10 | limit=30 | limit=100 | 形态 |
| --- | --- | --- | --- | --- |
| `周杰伦` | 277 | 277 | 277 | 恒定的宽泛查询 |
| `晴天 周杰伦` | 249 | 249 | 249 | 恒定 |
| `简单爱 周杰伦` | 80 | 80 | **140** | limit=100 才给真值 |
| `爱在西元前 周杰伦` | 72 | 72 | **132** | 同上 |
| `颜人中 慢慢` | 88 | 88 | **undefined** | limit=100 时字段直接没了 |

我这一侧的原始响应（`out/10-depth-limit.json` 的 `songCountDetail`）在 `s=简单爱 周杰伦`（长 query）上只测到 `limit=10/30/100` 全为 80 —— 也就是说**我的样本恰好落在「被截断的近似值」区间**，当时误判成「与 limit 无关」。两条记录都对，是**不同 query 形态**。
> ⚠️ 给后来者的坑：**不要用 `limit<100` 的 `songCount` 判断池子大小**（长 query 下会低估，例：80 vs 真实 140）；也不要假设该字段一定存在（长 query + `limit=100` 可能直接没有）。要判断池子够不够，用**实际返回条数**，不要用 `songCount`。
> `total=true/false/不传` 在本项目的 query 上不改变 `songCount`（我实测三态都返回 80）；宽泛词 `s=周杰伦` 返回 `songCount=277` 但**实际仍只返回 100 条** ⇒ `songCount > 100` 的部分**单页拿不全**。

**（4）`offset` 有效，但**对 300 取模**，不能当可靠分页用。** 实测模型：`rows = pool.slice(offset % 300, offset % 300 + limit)`（受池子大小截断）。
在 `s=周杰伦`（`songCount=277`）上用 `limit=100`：
| offset | 返回 | 首条 id |
| --- | --- | --- |
| 0 | 100 | 509781655 |
| 50 | 100 | 3400648668（已换页，说明 offset 真的在切片） |
| 100 | 100 | 185694 |
| 200 | **77**（= 277−200） | 509781655 之后无更多 |
| 299 | **0**（`songCount=0`） | — |
| 300 | **100（又回到第 1 页！）** | 509781655（与 offset=0 相同） |
在 `s=简单爱 周杰伦`（`songCount=80`）上 `limit=100`：`offset=100/200` → 0 条，`offset=300` → 80 条（第 1 页），`offset=301` → 79 条（切片从 1 开始）。
⇒ **可达深度上限约 300**，`offset ≥ 300` 会绕回开头而不是报错。对本项目（每个文件用自己的 歌名+歌手 查询，实测池子 ~80）**一页 `limit=100` 就够了，不需要翻页**；只有宽泛词才需要小心，且必须去重、并以「某页出现重复 id」为停止条件（不能信 offset 单调递增）。

### 2.2 匿名搜索是 UGC 优先 —— 原唱被埋在 20~100 名【实证，最重要的一条行为】
`POST /api/cloudsearch/pc`，body `s=简单爱 周杰伦&type=1&offset=0&limit=<N>&total=true`：

| limit | 返回 | 真·周杰伦 条数 | 第一个真·周杰伦的位置 |
| --- | --- | --- | --- |
| 10 | 10 | **0** | —（不在池子里） |
| 30 | 30 | 1 | 第 **28** 位（0-based） |
| 100 | 80 | **31** | 第 **28** 位 |

`limit=10` 的前 5 条原样（截断自真实响应，完整位于 `out/10-depth-limit.json` 的 `rawSampleTruncated`）：
```json
[{"id":"…","name":"简单爱 (青涩版)","artists":["王大毛"],"album":"…","dt":…},
 {"name":"“简单爱” 周杰伦 Sweet Pop Beat","artists":["QK ON THE BEAT"]},
 {"name":"简单爱","artists":["陈年.Tŋ"]},
 {"name":"简单爱","artists":["洛淮枳"]},
 {"name":"我爱你","artists":["周杰伦♚"]}]          ← 假号/翻唱/type-beat，没有一条是原唱
```
⇒ **根因不是端点、不是权重，而是「原唱压根不在前 10 条池子里」**。这条行为必须当作一等 API 事实记录：**任何按歌名搜索的匹配都必须 `limit=100`**（见 §8）。

深池子里的噪声形态（`probe/12-normalize-100.mjs` 实测，宽泛词 `s=周杰伦` 一页 100 行）：
- 有 UGC 曲目**歌名本身就叫「周杰伦」**（row 64/74/79），所以按关键字搜歌手名会把它们捞进来 —— 这正说明**必须靠歌手 id + 专辑 + 时长三重信号**，不能只靠歌名（§8.3）。
- 100 行里有 **3 行的 `ar[].id` 是 `0`**（未绑定歌手账号的上传，原始响应如此，不是归一化丢的）；有 row 64 甚至同一歌手出现两次（`id:0` 与 `id:14299343`）。归一化**忠实保留**这个 0（`safeInt` 让它保持有限数），见 §9 第 6 条。

---

## 3. 问题 A：`mp3DocId` 的来源【实证】

### A1. 它是什么
`mp3DocId` = `/api/song/enhance/player/url` 响应里 `data[0].md5`。三条独立证据指向同一结论：

1. **与真实标签逐字节相同**：真实样本标签里 `mp3DocId = cde6b150f488f81c8f0d9b374d2fe2fb`，接口 `data[0].md5` 也是 `cde6b150f488f81c8f0d9b374d2fe2fb`。
2. **它同时是 CDN 对象名**：接口返回的 `url` 是
   `http://m701.music.126.net/<ts>/<sig>/jdymusic/obj/wo3DlMOGwrbDjj7DisKw/5609924212/bfa0/a980/78db/cde6b150f488f81c8f0d9b374d2fe2fb.mp3?vuutv=...`
   —— 文件名就是它。所以它是**服务端存储对象的摘要**。
3. **本地算不出来**（`probe/04-md5-origin.mjs`，结果 `out/04-md5-origin.json`）：对真实样本做全文件 / 去 ID3v2 / 再去 ID3v1 / 去所有 ID3v2 帧负载 / 逐帧（TSSE,COMM,TALB,TIT2,TPE1,TPOS,TRCK,APIC）切片求 md5，**没有一个是 `cde6b150...`**。实测值：整文件 `96dc78c78f627fd4f4c38d826a178f10`、去 ID3v2 `82cf9f7e6ea43d9ee8441a4817a0b2d5`、再去 ID3v1 `089cf3cd543418fbe0037d9f89b1aedc`、去所有 ID3v2 帧负载 `158a41603f689f206ec67538224adcfc`。

### A2. 匿名可得性【实证】
对 `E:\CloudMusic` 全 57 个真实文件跑完整链路（`probe/05` 与 `probe/11-deep-match.mjs` → `out/05-e2e.json` / `out/11-deep-match.json`）：

- **depth=100（现行搜索深度）下真 md5：48/57 = 84.2%**
- 回退：9/57 = 15.8%，全部是 `code=-110`（VIP/受保护曲）。v4 实测的 9 个文件（`out/11-deep-match.json`）：
  `G-DRAGON - POWER.mp3`、`G-DRAGON,TAEYANG,DAESUNG - HOME SWEET HOME (feat. TAEYANG & DAESUNG).mp3`、`G.E.M. 邓紫棋 - 来自天堂的魔鬼.mp3`、`Michita - Cry For Me (feat. Ami).mp3`、`Valentin - Unchanged Mind.mp3`、`pro、陈小满 - 心底的旧.mp3`、`suhmeduh - Phone Kisses.mp3`、`周杰伦 - 一路向北.mp3`、`郑润泽 - 瞬.mp3`
- 对照：depth=10 时是 51/57 = 89.5%（回退 6 个）。**深度越高越容易选到 VIP 正主，真 md5 反而更少** —— 取舍见 §8.4。

补充实测（为什么无损对象的 md5 拿不到）：
- `/api/v3/song/detail` 的品质对象 `h`/`m`/`l`/`sq` 只有键 `["br","fid","size","vd","sr"]`，**没有任何 md5 字段**；
- `player/url?br=999000` 与 `player/url/v1?level=lossless&encodeType=flac` 都**静默降级**，返回的还是那个 320k mp3 对象的 md5（`9a68ada88f42f70d9d944ed5a883f4cb`）与 `type=mp3, level=exhigh`；
- VIP 曲（如 186016 晴天）三个端点一律 `code=404, md5=null`。

⇒ **结论**：匿名（无 Cookie）状态下，能拿到的只有「可匿名试听的那一档 mp3 对象的 md5」；无损对象的 md5 在匿名下无法获得。请求里 `br` 传什么都不改变结果。

### A3. 拿不到时填什么最不伤客户端【推断，有旁证】
**推荐：确定性合成 md5** = `md5("netease-163key-tagger|" + musicId + "|" + format)`（16 进制 32 位小写）。
理由（按证据强度）：

1. **形状合法 + 与真实对象不符，是有先例的**：`github.com/nondanee/163marker`（就是干「让非客户端下载的文件被客户端识别」这件事的项目，MIT）直接写 `md5(整个本地文件)`，形状合法但和真实 CDN 对象必然不符，实际可用。
2. **客户端并不存这个字段，无从比对**（`probe/09-client-db.mjs` 证据，见 §6）：客户端自己的曲库数据库 `dbTrack` 里精确检索 `"md5"`/`"docId"`/`"mp3DocId"` 命中数**全为 0**；它的 JSON 模型是 Web API 形状（`artists`/`album.picId`/`album.picUrl`/`album.transNames`/`mvid`/`duration`/`privilege`），根本没有 docId 字段。既然客户端自己都不存真实值，我们填一个合成的不会造成「本可识别却因此不识别」。
3. **空串/全 0 没有先例**，且长度不合法（真实值恒为 32 位 hex），一旦客户端做格式校验就会更糟。
4. 合成值**幂等**（同一首歌、同一容器永远同一个值，不会像 163marker 那样第二次运行变一个值），便于 diff 和复跑。

可配置：`configureNeteaseApi({ md5Fallback: 'synthetic' | 'empty' | 'zeros' })`，默认 `'synthetic'`。
> 注意：本报告**不建议省略该字段**（Lead 早前的建议）。实测 84~89% 的文件能拿到真实值，省略等于白白丢掉真实信息；只有 11~16% 需要回退。

### A4. 163key 里缺 / 写错 `mp3DocId`，客户端不做比对【实证 + 旁证】
这是「合成 md5 不影响验收」的直接依据：

1. **客户端曲库数据库里没有 docId 这个概念**（`probe/09-client-db.mjs` → `out/09-client-db.json`）：副本只读打开 `webdb.dat`（293MB，`dbTrack` **7172 行**），对 `jsonStr` 做精确子串计数
   `"md5"` → **0**、`"docId"` → **0**、`"mp3DocId"` → **0**、`"albumPicDocId"` → **0**、`"format"` → **0**、`"bitrate"` → **0**、`"musicId"` → **0**、`"path"`/`"localPath"` → **0**；
   而 `"transNames"`、`"duration"`、`"mvid"` 各 **7172**（每行都有）。
   ⇒ 客户端**自己不存真实 mp3DocId**，也就无从拿它对我们的值做比对；它识别本地文件靠的是 `musicId`（+ 客户端自己请求回来的元数据），不是 docId。
2. **相反的先例**：`163marker` 直接写 `md5(整个本地文件)` —— 形状合法但与真实 CDN 对象**必然不符**，而该项目的整个存在意义就是「让客户端识别非客户端下载的文件」，说明这种不一致**不影响识别**。
3. **风险边界**：既然客户端不比对，本字段的真实作用只剩「形状合法 + 可读」；因此合成值只需保证 **32 位小写 hex**（与真实值同形）。反过来说，填**空串**（长度不合法）或**全 0**（显然是占位）反而更有可能被将来某个校验分支挑出来，所以不推荐。
4. `to163Meta` 的实际行为（Lead 已确认采用本建议）：`opts.mp3DocId` > 上游 meta 的 `mp3DocId` > `getMp3DocId()` 真值 > `md5FallbackFor(musicId, format)` 合成值，**任何情况下都不会输出空串**。

---

## 4. `albumPicDocId` 与 picUrl 末段【实证】

- **57/57 文件的 `albumPicDocId` 都等于 `albumPic` URL 的最后一段数字**（`probe/out/05-e2e.json` 校验「不一致 0 个」）。真实样本：`.../109951165606660795.jpg` ↔ `109951165606660795`。
- **但数值型字段会丢精度，绝对不能用**：
  - 样本：`al.pic` = `109951165606660800`（尾数 795→800 被抹）、`al.pic_str` = `109951165606660795` ✅
  - 347230：`pic` = `109951168912558460`、`pic_str` = `109951168912558470`（末两位错）
  - 18 位 doc id > 2^53，JSON 解析成 double 就回不来了。
- 取值优先级（`albumPicDocIdOf()` 已实现）：`al.pic_str` → 否则 `album.picId_str` → 否则从 `album.picUrl` 末段用正则 `/.*\/(\d+)\.\w+$/` 提取。
- **老专辑的 doc id 是 16 位**（例：`1364493930777368`），此时 `pic_str` **不存在**（实测「来自天堂的魔鬼」的 `al` 里没有 `pic_str`），必须走 picUrl 末段。
- albumPic 的 **CDN 分片 p1~p4 是按请求轮换的**（同一首歌连测三次分别拿到 p2/p1/p2），且四片返回**同一张图**：实测四个 URL 全都 HTTP 200、`37590` 字节、`content-type: image/jpg`、`sha256 = a7a4c0c1ef723efe...` 完全相同。⇒ 客户端不可能按完整 URL 字面比对，**不需要**按真实标签的 p3 归一化。

---

## 5. flac 的 `format` 应填什么【推断，有两条旁证】

结论：**`"flac"`（小写）**。本项目对 mp3 实测为 `"mp3"`（小写）。

旁证：
1. **接口的容器 token 就是这两个词**：`player/url` 的 `type` 字段取值只有 `"mp3"` / `"flac"`，真实样本的 `format:"mp3"` 与该曲 `type:"mp3"` 一致 ⇒ 这个字段表达的是**容器格式 token**。
2. **163marker 用本地文件魔数判容器**：`format = 'flac' if open(path,'rb').read(4) == b'fLaC' else 'mp3'`，即「本地是什么容器就写什么」，flac 写 `'flac'`。这是同一场景下已被实际使用的取值。

无法闭环的部分（**明确标注**）：本机**没有任何真实 flac 的 163key 样本**可以用来正面对照 —— 全盘扫描 371 个音频文件只有 1 个带 163key（就是那个 mp3 样本）；`E:\CloudMusic` 57 个文件（44 flac / 13 mp3）全都还没有标签；客户端二进制里这些字段名（`format`/`mp3DocId`/`albumPicDocId`/`musicId`/`transNames`）**ASCII 与 UTF-16LE 双编码检索均 0 命中**，无法从二进制证实。客户端曲库数据库里也**没有** format 字段（§6）。
⇒ 若日后拿到真实 flac 样本，第一件该做的事就是核对这个字段。

---

## 6. 客户端侧旁证（只读，未做任何修改）

### 6.1 二进制字符串（`probe/06-client-strings.mjs` → `out/06-client-strings.json`）
`C:\Program Files\Netease\CloudMusic\cloudmusic.dll` 偏移 27273656 附近有一整块 163key 相关字符串，说明**客户端自己既读也写**这个标记：
```
Error: getid3content: AES_decrypt length not in multiple of AES_BLOCK_SIZE!
Error: getid3content: AES_set_decrypt_key error!
163 key(Don't modify):
#14ljk_!\]&0U<'(
Error: addid3content: AES_set_encrypt_key error!
)(13daqP@ssw0rd~          ← 第二个 16 字节密钥候选（未使用）
```
附近还有 `orpheus::local_music` / `music_discern` / `filepath_watche.cpp` / `MusicID3Reader` 等符号。三份 NTPK 包（magic `NTPK`）是加密的，未解，因此「客户端具体怎么消费这些字段」无法从二进制进一步证实。

### 6.2 客户端曲库数据库（`webdb.dat`，只读副本）
`C:\Users\HonGLY\AppData\Local\Netease\CloudMusic\Library\webdb.dat`，293,100,544 字节，magic `SQLite format 3`，用 Node 内置 `node:sqlite` 只读打开（**先复制到 %TEMP% 再读，避免锁客户端**）。19 张表，关键三张：

| 表 | 结构 | 行数 |
| --- | --- | --- |
| `dbTrack` | `(id VARCHAR(40), jsonStr TEXT)` | 7172 |
| `localMatch` | `(uid VARCHAR(40), jsonStr TEXT)` | **0** |
| `offlineTrack` | `(type,state,completeTime,newRelativePath,trackName,artistName,albumName,size,id,jsonStr)` | **0** |

`dbTrack` 精确字段名检索命中数：`"md5"` **0**、`"docId"` **0**、`"mp3DocId"` **0**、`"format"` **0**、`"bitrate"` **0**、`"musicId"` **0**、`"path"` **0**、`"localPath"` **0**。`dbTrack` 的 JSON 是 Web API 形状（`artists`、`album.picId/picUrl/alias/transNames`、`mvid`、`duration`、`privilege`），注意 `album.transNames` 在客户端模型里是**数组**、`alias` 也是字符串数组（与 163key 里 `transNames: []` 的数组语义一致）。
⇒ **两条结论**：①客户端的曲库模型里根本没有 docId 概念（支撑 §A3 的「填合成值无害」）；②客户端模型里 `transNames` 是字符串数组，且它用 `mvid` 而 163key 用 `mvId`、它用 `artists` 而 163key 用 `artist` ⇒ 163key 是**独立于曲库模型的一套 schema**，不是直接复用 DB 的 JSON。

### 6.3 客户端已经「看见但认不出」这些本地文件（本项目的意义所在）
`dbTrack` 里有 **201 行 `songType:1`**，`name` 直接是本地文件名，例如完整行：
```json
{"id":"1865160362","alias":[],"duration":245845,"mvid":"","name":"周杰伦 - 不爱我就拉倒.flac",
 "songType":1,"fee":0,"mark":0,"popularity":0,
 "artists":[{"id":"","name":""}],
 "album":{"id":"","name":"","albumName":"","picUrl":"https://p4.music.126.net/C6Vro2l0BH59Wka9gOaC6w==/109951171180358170.jpg","alias":[],"transNames":[]},
 "privilege":{"id":"1865160362","cloudSong":1,...}}
```
**`artists[0] = {"id":"","name":""}`、`album.id=""`、`album.name=""`** —— 客户端扫到了文件、记了时长和封面，但**歌手/专辑全是空**，正是「没有 163key 所以认不出这首歌」的直接证据。写入 163key 后这些字段应当能被补全（客户端行为由 task-2 负责验证，不在本文件范围）。

---

## 7. `duration` 与 `bitrate` 口径

### duration（毫秒）—— **取接口 `dt`，本地实测只做闸门与回退**【实证】
决定性对照（对真实样本，`probe/05-search-detail-e2e.mjs` 的 `sampleFidelity` 节，两种取法并行输出）：

| 取法 | 与真实标签逐字段一致的字段数 | 明文 |
| --- | --- | --- |
| **只用接口值** | **14/14** | 与真实标签**逐字节相同**（唯一差别是 albumPic 的 CDN 分片主机名 p1 vs p3，doc id 相同） |
| 用本地实测覆盖 duration | 13/14 | duration 变成 213744，与真实标签 213702 差 42ms |

- 真实标签 213702 == 接口 `dt`/`time` 213702 ⇒ 真实标签里的 duration 就是接口给的值（这首歌是客户端自己下载的，写标签时手里就有接口元数据）。**接口值就是 ground truth。**
- 我的本地测量：MP3 修好帧链校验后给 **213744**（差 42ms）；FLAC 读 STREAMINFO 是**精确值**，与客户端自己记录的时长实测吻合：
  | 文件 | 客户端 dbTrack 记录 | 我读 STREAMINFO | 差 |
  | --- | --- | --- | --- |
  | 周杰伦 - 不爱我就拉倒.flac | 245845 | 246280 | 435ms |
  | 周杰伦 - 我是如此相信.flac | 266382 | 266383 | 1ms |
- ⇒ **口径**：`durationOf()` **接口 `dt` 优先**，`localDurationMs` 仅在接口缺失时回退（已在 `lib/netease-api.mjs` 反转优先级并写进注释）。理由：接口值不依赖本地解码精度，且是与真实标签逐字节一致的那一个。
- **`durationMs` 契约（重要）**：候选的 `durationMs` 必须是**有限正数或 `null`**，**绝不能是 `0`**。`0` 是有限数，会被下游当成「时长为 0 的明确值」而**误触发时长硬闸门**（把本来能自动应用的文件打成 `skip:duration-mismatch`）；`null` 才等于「未知」。已在 `mapSong()`/`normalizeRaw()`/`coerceDetail()` 统一为 `Number.isFinite(dt) && dt > 0 ? dt : null`，并有回归断言 `F1/F2/F3`（F3 直接用生产同款 `pickBest` 验证「null 不触发、0 会触发」）。
- **duration 的第二个用途**：排除错误版本（见 §8），但**权重必须低于歌名层级**。

### bitrate
- 真实样本 mp3 是 320000，接口 `player/url` 的 `br` 也是 320000（`bitrate` 字段与真实标签一致）。
- 对 flac，接口匿名只给 mp3 exhigh 档（320000），**拿不到无损档码率**（§A2）；建议 flac 用本地容器/流信息推算，或沿用接口 320000 并在 notes 里标注不确定。`to163Meta` 顺序：`opts.bitrate` → 上游 meta 的 `bitrate` → `qualities` 推导 → 默认 320000。
- 本项目 57 个文件的本地实测码率由 `probe/_audioinfo.mjs` 给出（FLAC 读 STREAMINFO，MP3 逐帧取均值；修好帧链后 13 个 mp3 全部落在 128000/320000 且 `exact=true`）。

---

## 8. 匹配质量：**必须 `limit=100`，且要带时长 + 专辑三重信号**【实证，最重要】

### 8.1 旧结论的作废声明（订正）
早期版本（基于 `limit=10` 的池子）报过「26/57 = 45.6% 的文件选中候选时长差 >10s」。**该结论是在被污染的 top-10 池子上得出的，现已作废**。根因不是打分权重，而是 **top-10 里根本没有正确版本**（§2.2 的 UGC 优先行为）。作废的旧清单（`G-DRAGON - POWER.mp3 -334450ms`、`郑润泽 - 瞬.mp3 -4275008ms` 等）中，`瞬` 的 −4275008ms 还有一半是当时 MP3 时长读取器自身的 bug（已修，见 §10）。

### 8.2 depth=100 的独立复算（`probe/11-deep-match.mjs` → `out/11-deep-match.json`）
57 个真实文件，每文件取 `parseFilename()` 前 2 个 query，各 `searchSong({ limit: 100 })`，按 id 合并去重成池子，再走**生产同一条打分路径** `lib/match.mjs` 的 `pickBest(candidates, parsed, { localDurationMs, localAlbum })`（`localAlbum` 从文件标签读：FLAC VORBIS `ALBUM=` / ID3v2 `TALB`）。0 错误。

| 指标 | depth=10（旧） | **depth=100（v4 现行）** |
| --- | --- | --- |
| `durationMismatch`（Δ>5s，会触发硬闸门） | 13 | **0** |
| `\|Δduration\| > 10s` | 18 | **0** |
| `within5s` | 44 | **57/57** |
| `nameExact`（title ≥0.97） | 41 | **56** |
| `artistHit`（artist ≥0.9） | 13 | **56** |
| `albumExact`（album ≥0.97） | — | **49/57** |
| `correctVersionInPool`（池里有歌名+歌手都对的） | — | **55/57** |
| `auto`（可自动应用） | — | **52** |
| `confidence` high/medium/low | — | **52 / 5 / 0** |
| `ugcBest`（选中者被判为 UGC 冒充） | — | **0** |
| `ambiguous`（判为真歧义） | — | **3** |
| `realMd5` / `fallbackMd5` | 51 / 6 | **48 / 9** |

> **与 Lead 的 `out/matches-v4.json` 完全对齐**：`auto 52 / 人工复核 5`（我这侧 `medium 5`），他审计的 5 个待复核文件与我这里的 5 个是同一批：`周杰伦 - 一路向北.flac`/`.mp3`（本地专辑标签是 `J III MP3 Player` 精选集，真实发行专辑是 `11月的萧邦` ⇒ 属于**正确**的歧义）、`蒋孜怡,岳燃 - 拼图爱.mp3`（gap=0 真歧义）、`磨尖的粉笔 - 我只能离开.mp3` 与 `艾比利 - 一个人想着一个人 (说唱版).flac`（池里 `correctVersionInPool=0`，即匿名曲库里没有正主，只能人工判断）。
> 早前我这一侧跑出 `auto 49 / medium 8`，差异**全部来自 `lib/match.mjs` 后来新增的第三条判据 `isDefiniteUgc()`**（见 §8.3 末条），不是我算错：本文件 §8.2 的数字已用 v4 打分器重跑（`probe/out/11-run-v4.log`）。

**换选明细：57 个文件里有 47 个的选中 id 变了，其中 41 个换选后 `|Δduration|` 更小。** 代表性例子（depth10 → depth100）：
```
周杰伦 - 七里香.flac                2108553289 Δ2576  →  186001      Δ200
周杰伦 - 晴天.flac                  2653714443 Δ-997  →  186016      Δ747
周杰伦 - 简单爱.flac                2073475488 Δ-582  →  186119(范特西) Δ987
周杰伦 - 夜曲.flac                  2725685941 Δ7128  →  185904      Δ1
周杰伦 - 不能说的秘密.flac           2646733205 Δ-1508 →  185868      Δ1
周杰伦 - 爱你没差.flac              2663089431 Δ-258763 → 25653004   Δ720
磨尖的粉笔 - 我只能离开.mp3          2614831413 Δ-33010 → 2606216171  Δ44
周杰伦 - 说好不哭 (with 五月天阿信).flac 2621295038 Δ1719 → 1391274164 Δ0
```
6 个换选后时长反而略差（`pro、陈小满 - 心底的旧.mp3` Δ−36→Δ36、`我落泪情绪零碎.flac` 609→894、`断了的弦.flac` 0→534、`止战之殇.flac` 15→907、`简单爱.flac` −582→987、`轨迹.flac` −480→853），全部仍在 1s 量级 —— 它们是**同一录音在不同专辑上的重复条目**，时长无法区分，此时由 album 项决胜（`186119 简单爱` 正是靠 album=范特西 胜出的那个 case）。

### 8.3 权重为什么必须「歌名绝对支配、时长只做层内裁决」
- 教训 1（我踩过）：把时长权重做大（±60 分）后，歌名精确率从 55/57 **掉到 40/57**，并选出 `童话`、`晴天 (女声版))`、`止战之殇 (AI 懒羊羊)`、`夜曲（Cover）` 这类错版 ⇒ **时长绝不能压过歌名层级**。
- 教训 2（Lead 的洞察）：`simple 简单爱` 这种曲目有 5 个 id 是**同一录音的不同专辑条目**，时长几乎相同（Δ1ms），**只有专辑名能挑出正主**（`186119`《范特西》，本地 album 正是范特西）。
- 现行 `lib/match.mjs` 权重：`title .52 / artist .28 / duration .15 / album .05`（`DURATION_TOLERANCE_MS = 5000`、`DURATION_RANK_MS = 10000`）。**池子够深时这套权重是对的**（`186119` = 1.00 vs 精选集版 = 0.95）；浅池子下再好的权重也救不回来。
- 硬闸门（Lead 在 `apply.mjs` 实现，与我无关但结论一致）：`durationMismatch`（Δ>5s）独立把置信度打到 `low` 并禁止 `auto`，`apply.mjs` 打 `skip:duration-mismatch`，只有 `--all` 能绕过。depth=100 下 57/57 都不再触发。
- **第三条判据 `isDefiniteUgc()`（Lead 实现于 `lib/match.mjs`，是 `auto 49→52` 的唯一原因）**：`artist.id` **明确给了且全是 0**、**且专辑名为空** ⇒ 判为「UGC 冒充条目」，垫底并禁止 `auto`。依据是 `s=爱在西元前 周杰伦` 前 100 条里 `artist.id === 0` 有 **25 条**、其中 **8 条署名「周杰伦」冒充原唱**（例：`2153879235 周杰伦#0《》234280ms`），真条目是 `186114 周杰伦#6452《范特西》`。
- **边界必须收窄（否则会误杀真条目）**：**部分** id 为 0 **不拦**。`2735941345`（`pro#53262224 / 陈小满#0`、专辑《心底的旧》、时长吻合）是有真艺人的真条目，只扣分。并且严格区分「**id 缺失（undefined）** ⇒ 未知、中性 0.5」与「**id 明确为 0** ⇒ UGC 信号」。
- **`ambiguous` 也必须收窄**：只看 `gap < 0.05` 会误杀 **8 个**明明由专辑名决出胜负的正确匹配。现行条件：歌名 ≥0.97 **且** 歌手 ≥0.9 **且** 双方时长都在容差内 **且** 专辑分差 <0.1 **且** gap <0.05 才算真歧义。
- **本模块不再自带第二套阈值**：`lib/netease-api.mjs` 的 `pickBestMatch()` / `parseFileName()` 已删除，唯一权威实现是 `lib/match.mjs` 的 `parseFilename` / `pickBest` / `isDefiniteUgc`。

### 8.4 代价与结论（必须如实记录）
depth=100 换上「正主」后，**正主多为 VIP/受保护曲**，`player/url` 更容易 `code=-110` ⇒ `realMd5` 从 depth=10 的 51 回落到 **48**（回退 9 个，全部按 §A3 写合成 md5）。这是「选对歌」与「拿到真 docId」之间的权衡。**Lead 已裁定：选对歌优先，不做「回头试 depth=10 第二名」的补丁**，理由比「优先级」更硬 ——
1. `mp3DocId` 只有 84% 能拿到真值，而且**客户端根本不存这个字段**（§A4：`dbTrack` 里 `md5/docId/mp3DocId` 命中数全为 0），它不参与任何判定，属于锦上添花；
2. `musicId` 错了，客户端会把整首歌显示成另一个人 —— **两者错误代价完全不对等**；
3. 回头捞 depth=10 的第二名，等于把**已经被时长/专辑/UGC 三条判据淘汰掉的错误候选**重新放回流水线，风险远大于收益。

---

## 9. 未实证 / 无法证实的部分（明确列出）

1. **`format` 在真实 flac 163key 里的取值**：本机无 flac 样本，客户端二进制无字段名明文 ⇒ 只有两条旁证（§5）。
2. **`transNames` 的真实语义**：唯一见过的真值是 `[]`（样本）与 `null`（接口 `transName`），没有任何真实样本证明它可以是多元素数组。当前实现：`transName` 非空 → `[transName]`，否则 `[]`（与 163marker 硬编码 `[]` 一致）。**这是本实现最弱的一环**，标注为推断。
3. **客户端到底怎么消费 `mp3DocId`/`albumPicDocId`**：二进制是加密 NTPK，DB 里没有这些字段。只能间接说「DB 不存 → 大概率不做字面比对」。
4. **无损对象的真实 md5**：匿名拿不到（需要登录 Cookie）。若后续提供 `NETEASE_COOKIE`，`getMp3DocId(id,{br})` 会自动走 `level=lossless` 尝试。
5. **`mvId`**：真实样本是 `0`，接口 `mvid`/`mv` 字段给出 `0` 或真 id（实测 36270426 那首 `mvId=503273`），口径一致，未做进一步实证。
6. **`artist[].id = 0` 的 UGC 数据**（`probe/12-normalize-100.mjs` → `out/12-normalize-100.json`）：宽泛词一页 100 行里有 **3 行**的 `ar[].id` 原始值就是 `0`（未绑定歌手账号的上传，例：`山弟` row 64、`用户5115307169` row 74、`Priscilla Abby` row 79），其中 row 64 同一歌手同时出现 `id:0` 与 `id:14299343` 两条。归一化**忠实保留** `0`（`safeInt` 保持有限数，不伪装成别的值）。⇒ 若这类曲目被选为匹配结果，163key 的 `artist` 会是 `[["山弟",0]]` 这种形态。**客户端能否接受 `artist` id=0 未实证**（无样本、二进制无字段明文），标注为风险；生产侧建议把「艺术家 id 全为 0」当作低置信度信号降级，而不是直接写。

---

## 10. 复跑方法（脚本清单）

```
node probe/01-endpoints.mjs          # 端点可用性/状态码/耗时  -> out/01-endpoints.json
node probe/02-shapes.mjs             # 各端点返回字段形状     -> out/02-shapes.json
node probe/03-scan-existing.mjs      # 扫描现有 163key（只读）
node probe/04-md5-origin.mjs         # mp3DocId 本地溯源（反证）-> out/04-md5-origin.json
node probe/05-search-detail-e2e.mjs  # 57 文件端到端(depth=10 对照) + 样本保真度 -> out/05-e2e.json / out/05-run.log
node probe/06-client-strings.mjs     # 客户端二进制字符串扫描 -> out/06-client-strings.json
node probe/07-chain-compare.mjs      # 链路对比（字段覆盖/状态码/耗时）-> out/07-chain-compare.json
node probe/08-fidelity-assert.mjs    # 断言型保真度自测（27 条；失败退出码 1）
node probe/09-client-db.mjs          # 客户端 webdb.dat 只读探测（副本 + node:sqlite）-> out/09-client-db.json
node probe/10-depth-limit.mjs        # limit/songCount/offset 语义 + 五端点字段覆盖 + 归一化保真度 -> out/10-depth-limit.json
node probe/11-deep-match.mjs         # depth=100 全量匹配复算 + 与 depth=10 逐文件对比 -> out/11-deep-match.json
node probe/12-normalize-100.mjs      # searchSong({limit:100}) 满 100 行归一化保真度 -> out/12-normalize-100.json
```
必读的环境/操作坑：
- 本机 Node v24.21.0 的 `node:path` **没有** `fileURLToPath` 导出（用了会报 `does not provide an export named 'fileURLToPath'`）；脚本统一用 `import.meta.dirname` + `join()`。
- 跑 `05` 时**不要**用 `| Select-Object -First N`（会把 node 进程提前杀掉，JSON 不会写完）。
- `E:\CloudMusic` 是**只读参考素材**，所有探测脚本只读；备份在 `E:\CloudMusic_backup_20261022`。
- `webdb.dat` 也要**先复制到 %TEMP% 再读**，避免与运行中的客户端抢锁（`probe/09` 已这么做）。
- 加密明文前缀 `music:` 是 **6 个字符**，解密后必须 `plain.slice('music:'.length)`（写成 `slice(5)` 会得到 `:{"musicId"...}` 并报 `SyntaxError: Unexpected token ':'`）。
- 节流/重试可用环境变量调：`NETEASE_MIN_INTERVAL_MS`(300)、`NETEASE_RETRIES`(2)、`NETEASE_TIMEOUT_MS`(10000)、`NETEASE_COOKIE`(可选)。
- 本轮 57 文件实测共 **240 个请求、0 次重试、0 次超时、0 个错误**；单文件端到端 p50 1243ms / 均值 1291ms（含模块内置 300ms 串行节流）。depth=100（每文件 2 query）同样是 0 错误。

### 自测覆盖（`probe/08-fidelity-assert.mjs`，27/27 通过）
`A1~A9`（14 键形状/顺序/幂等 + duration 是有限数值且 60s<d<3600s）、`B1~B3`（只用接口值 → 14/14 字段与真实标签一致、明文一致、albumPic 仅 CDN 分片差）、`C1~C3`（API 失败/超时/限流的错误可读性）、`D1`（p1~p4 同图同 sha256）、`E1~E4`（三种输入形态识别 + 缺字段回退 0 而非 NaN）、`F1~F3`（searchSong 候选 durationMs 契约 + null/0 对闸门的差别）、`G1~G4`（duration 优先序与不外泄 NaN/undefined）。
