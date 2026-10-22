# netease-163key-tagger

给本地音乐文件写入网易云音乐的 `163 key(Don't modify):` 标签（俗称 **163key**）。

从第三方渠道拿到的 MP3 / FLAC 通常没有 163key，客户端因此不知道它们对应曲库里的哪首歌。
本工具按「歌手 - 歌名」去网易云 API 匹配到正确的歌曲条目，生成对应的 163key，写进文件标签。
自带一个本地 Web 界面：扫描 → 匹配 → 人工复核 → 写入 → 校验，全程可视化。

> **这是个人研究与自用工具。** 它只改你自己磁盘上的文件标签，不下载、不破解、不绕过任何付费内容。
> 请只对你合法拥有的音乐使用；不要用来分发版权内容。

![界面](docs/screenshot.png)

## ⚠️ 先读这段：163key 能做什么、不能做什么

`163key` 只是**元数据标签**，客户端用它来知道「这个文件是曲库里的哪首歌」。它不是「已下载」的凭据。

网易云音乐客户端判断一首歌「已下载」，靠的是自己数据库 `webdb.dat` 里的 `offlineTrack` 表。
写入的链路（已由客户端前端 JS 一手证据闭合）是：

1. 原生层 `storage.downloadscanner` 扫描**客户端配置的下载目录**，把每个文件的 comment
   （即解密后的 `music:{...}` 明文）回传给前端 JS；
2. JS 按**第一个冒号**取前缀（`music:` / `dj:` / `mv:`），`JSON.parse` 出 songId；
3. 往 `webdb.dat.offlineTrack` 插入一行 `state=finish`、`relativePath = 绝对路径 − 下载根`。

所以要让客户端把文件认成「已下载」，**三个条件缺一不可**：

| 条件 | 本工具负责 |
|---|---|
| ① 文件里有正确的 163key | ✅ 核心功能 |
| ② 文件位于客户端设置的**下载根目录**内 | ❌ 需要你自己放进去 |
| ③ 客户端触发过一次下载目录扫描 | ❌ 需要重启客户端（触发时机未完全定位） |

只写标签、却把文件留在别的目录，客户端不会有任何反应。界面里的「客户端检查」
会直接读 `offlineTrack` 的行数，给你一个**只读的、可复现的**验收判据。

### ✅ 已实机验证（2026-10-22）

条件 ①②③ 凑齐之后，效果是**双向成立**的：

- 客户端「本地音乐」里，这些文件从「歌手/专辑空白」变成**匹配上曲库的歌曲**（`library.dat`
  的 `tid` 从空变成真实 songId，且与 163key 里的 `musicId` **52/52 完全一致**）；
- 客户端「已下载」列表里**出现了这些歌**（`offlineTrack` 从 0 行变成 52 行，`state=4`，
  `newRelativePath` 与文件名对应）。

天然对照组：那 4 个**没写 key** 的文件，`tid` 仍为空、也没进 `offlineTrack`。

> ⚠️ 一个已修复的坑：客户端只读**最后一个** `COMM` 帧。若文件原本就带一个空 `COMM`，
> 而 key 排在它前面，客户端读到的是空串 —— 标签写了等于没写。写入器现已强制把 key 的
> `COMM` 放到所有 `COMM` 之后（回归测试 `T8`）。历史版本写出的文件重跑一次即可校正。

## 快速开始

需要 **Node.js ≥ 22**（用到内置 `fetch` 和 `node:sqlite`），**零 npm 依赖**。

```bash
git clone <this-repo> netease-163key-tagger
cd netease-163key-tagger

# 图形界面（推荐）
node server.mjs
#   → 打开 http://127.0.0.1:55790

# 或者纯命令行
node apply.mjs scan    --root ./music
node apply.mjs match   --root ./music
node apply.mjs apply   --report out/matches.json --dry-run
node apply.mjs apply   --report out/matches.json --write
node apply.mjs verify  --root ./music --backup ./music-backup
```

Windows 上也可以双击 `启动.cmd`。

默认把 `./music` 当目标目录、`./music-backup` 当只读的比对备份。这两个目录都在 `.gitignore` 里。

## 界面

- **① 扫描目录**：读标签、时长、实测码率，0.7s 扫完 57 个文件
- **② 联网匹配**：并发搜索 + 打分，实时进度条与日志
- **③ 写入标签**：默认 dry-run，确认后落盘；只写「自动通过」的条目
- **④ 校验结果**：音频区与备份逐字节比对，页面内显示报告
- 每条记录都能打开**复核抽屉**：试听、看候选排名（分数 / 接口时长 / Δ时长 / 专辑 / 艺人 id）、手动改关键字重搜、一键指定
- **客户端检查**：只读客户端数据库，告诉你 `offlineTrack` 现在几行、还差哪一步

## 算法

```
163key = "163 key(Don't modify):" + base64( AES-128-ECB/PKCS#7( "music:" + 紧凑JSON ) )
```

- 密钥固定 16 字节：`#14ljk_!\]&0U<'(`（hex `2331346c6a6b5f215c5d2630553c2728`）
- 明文 = `music:` + `JSON.stringify(meta)`，紧凑无空格
- ECB + PKCS#7（Node `createCipheriv('aes-128-ecb')` 默认填充即 PKCS#7）
- **无签名、无 MAC**：任何人都能生成，客户端只把它当元数据读

字段顺序固定为：
`musicId, musicName, artist, albumId, album, albumPicDocId, albumPic, bitrate, mp3DocId, duration, mvId, alias, transNames, format`

验证方式：取一个客户端真实下载的文件，解密其 COMM 帧后重新加密，与原 Base64 **逐字节完全一致**。

## 各容器的落点

| 容器 | 落点 | 状态 |
|---|---|---|
| MP3 | ID3v2.3 `COMM` 帧，编码字节 `0x00`(Latin-1)，语言 `XXX`，描述为空 | 已用真实样本验证 |
| FLAC | Vorbis comment `DESCRIPTION=`（同时补写一份 `COMMENT=` 兼容副本，`--no-flac-comment-copy` 可关） | 字段名有旁证，无客户端产出的真实样本 |
| NCM | 头部 meta 段：`XOR 0x63` → `"163 key(Don't modify):"` + base64；外层密钥 `hzHRAmso5kInbaxW`，另需重算 CRC32 | 待验证（手上无真实样本） |
| M4A | `moov.udta.meta.ilst.©cmt` | 未实现 |

写入策略：**同尺寸原地改**优先——能塞进原有标签空间时只改标签区，音频字节一字节不动；
塞不下才临时文件 + 原子替换（保留 mtime）。

## 匹配：整个工具最容易踩坑的一段

匿名搜索是 **UGC 优先**的：翻唱、type-beat、DJ 版会挤满前 10~20 条，
**授权曲库里的原唱要 20~100 名才出现**。实测 `s=简单爱 周杰伦`：

| 每次查询拉取 | 结果里真·周杰伦 |
|---|---|
| 10 条 | **0 条** |
| 30 条 | 1 条（第 21 条，现场版） |
| 100 条 | 32 条 |

所以 `match` 默认 `--search-limit 100`、每个文件最多试 `--max-queries 2` 个查询，
并且只在拿到**时长自洽的自动候选**时才收手——只看歌名/歌手会停在翻唱上。

挑原唱靠**时长 + 专辑 + 曲库身份**三条硬信号：

- **时长**：差 > 5s 的候选独立打成 low 并默认跳过（歌名歌手一字不差、时长却对不上，
  几乎必然是伴奏 / remix / 合辑版）。
- **专辑**：同一录音会以多个条目散落在精选集里，时长差 1ms 挑不出原专辑，
  **是专辑名把它挑出来的**，所以有专辑标签时不要丢。
- **曲库身份**：`artist.id === 0` 且专辑名为空的，多半是上传者把艺人名直接写成
  「周杰伦」冒充原唱。这类候选垫底并禁止自动写入（部分艺人 id=0 不算冒充，只扣分不拦截）。

`bitrate` 用的是**本地文件的实测码率**，不是固定 320000：FLAC 无损实际 800k~1800k，
MP3 可能是 128k/192k/320k。

更完整的踩坑记录（含反例与原始数据）见 [`notes/matching-pitfalls.md`](notes/matching-pitfalls.md)。

## 安全约定

- 目标目录与备份目录**职责分开**：备份目录被登记为只读保护，写它会直接抛错。
  保护根可用环境变量 `NETEASE_163KEY_PROTECT`（分号/逗号分隔）追加。
- 默认 `--dry-run`，不显式加 `--write` 不落盘。
- `apply` 的放行阶梯：默认只写 `auto`；`--include-review` 放行 medium；`--all` 全部放行
  （时长不符 `skip:duration-mismatch` 与 UGC 冒充 `skip:ugc-candidate` 只有 `--all` 能绕过）。
- 宁可不写，也不写错：本机 57 个文件里有 4 个因为无法确认原专辑/账号，被**故意跳过**。

## 顺带改写文件信息（可选，默认关闭）

匹配完成后，除了写 163key，还可以把**文件里你看到的信息**也换成云端的：

```bash
node apply.mjs apply --report out/matches.json --write --meta            # 标题/歌手/专辑
node apply.mjs apply --report out/matches.json --write --meta --cover    # 再加专辑封面
```

界面上对应两个复选框，默认都不勾；勾了封面会自动勾上文字。

| 开关 | 改什么 | 代价 |
|---|---|---|
| `--meta` | MP3 的 `TIT2`/`TPE1`/`TALB`/`TPE2`；FLAC 的 `TITLE`/`ARTIST`/`ALBUM`/`ALBUMARTIST` | 纯文本，几乎不改变体积 |
| `--cover` | MP3 的 `APIC` 帧；FLAC 的 `PICTURE` 块（只留一张，旧封面删除） | 要联网下载封面；文件体积会变化 |

**音频数据一字节都不会动**，这条有回归测试守着（`test/meta.selftest.mjs`，24 条断言：
改写后音频区 md5 不变 / 重复写入字节不变 / 换封面能被察觉 / 封面确实是那张图）。

这样能修掉一类真实脏数据：比如本机那份 `周杰伦 - 一路向北.flac` 的专辑标签是
`J III MP3 Player`（精选集乱名），改写后会变成云端正确的《11月的萧邦》。

## 目录结构

```
netease-163key-tagger/
├── server.mjs             # 本地 Web 服务（零依赖，内置 http）
├── web/                   # 前端：index.html / app.js / style.css
├── apply.mjs              # CLI 入口：scan / match / apply / verify / self-test
├── lib/
│   ├── 163key.mjs         # 编解码
│   ├── tags.mjs           # 各容器标签读写 + 时长/码率读取
│   ├── netease-api.mjs    # 网易云 API 搜索 / 详情
│   └── match.mjs          # 文件名解析 + 候选打分
├── test/                  # 自测（标签 63 条 / 匹配 61 条 / 端到端 50 条）+ 离线假 API
├── probe/                 # API 探测脚本与原始响应
├── notes/                 # 接口行为、客户端机制、二进制取证、踩坑记录、独立验证
├── verify/                # 独立验证脚本（10 个套件）
└── out/                   # 运行产物（不入库）
```

## 自测

```bash
node apply.mjs self-test     # 174 条断言，全程离线
```

## 已知未闭合的地方

- 客户端**下载目录扫描的触发时机**没有完全定位（倾向：启动时 / 打开下载管理时 / 改下载目录后）。
- 手上没有客户端真实产出的 **FLAC / NCM / M4A** 163key 样本，这三条链路只有旁证。
- `mp3DocId` 是服务端 docId（不是文件 md5），匿名接口对部分歌曲拿不到，此时用确定性合成值兜底。

## License

[MIT](LICENSE)
