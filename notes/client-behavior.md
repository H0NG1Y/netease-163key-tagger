# 网易云音乐 PC 客户端：凭什么把本地文件认成「已下载」/「已匹配到线上歌曲」

- 调研人：teammate `client-behavior`（共享任务板 task-2）
- 日期：2026-10-22
- 方法：①网络一手资料（官方专栏/官方答疑、GitHub 仓库源码与 issue、第三方实测博客）；②**只读**检查本机 Windows 客户端安装目录、用户数据目录与其 SQLite 库、以及客户端二进制内嵌字符串。
- 权限声明：**全程只读**。没有修改/删除客户端任何文件；所有 SQLite 都是在 `%TEMP%` 里的副本上或 `mode=ro` 打开；未对 `E:\CloudMusic`、`%USERPROFILE%\Downloads\Music` 下任何音频做写入。本文所有「路径 + 文件名」均是我实际看到的内容。
- 分档：【已证实】= 一手实测/官方原文/我本机直接观察；【有旁证】= 多个二手来源一致但无一手直证；【推测】= 我的推理；【未找到证据】= 明确没有找到。

---

## 0. 结论速览

| # | 结论 | 档位 |
|---|---|---|
| 1 | `163 key(Don't modify):...` 标签是**客户端真实读取**的（读出的 songId 会成为该文件的「身份」），不是死数据 | 【已证实】 |
| 2 | ~~`163key` 不是「已下载」的凭据~~ **（该结论已被 §0.5 推翻）**：**163key 就是「已下载」认定的输入**——native DownloadScanner 把文件里的 comment 交给前端 JS，JS 据此往 `offlineTrack` 写 `state=finish` 的行；没有 comment 的文件被直接跳过 | 【已证实】（前端 JS 一手，§2.7） |
| 3 | 「已下载」= **①文件在下载根目录内 ＋ ②文件带合法 163key ＋ ③扫描器跑到它**，随后客户端在 `webdb.dat` 的 `offlineTrack` 表记账（`id` + `newRelativePath` + `state` + `completeTime` + `jsonStr`） | 【已证实】（表结构/字段/API + 前端 JS 一手） |
| 4 | 文件「属于下载目录」在 `library.dat` 里用哨兵值 `dir='<download>'` 分组，而那条记录对应的文件**不含 163key** ⇒ **「本地音乐扫描/归类」与「已下载记账」是两条互不相干的通道**（前者看路径，后者看标签） | 【已证实】 |
| 5 | 本地音乐的「词图匹配」（匹配到线上歌曲）走**服务端**：hash 匹配 `/eapi/search/match/new` → 频谱匹配 `/eapi/music/matcher`，结果**按文件路径缓存**，重启失效 | 【已证实】（一手抓包实测） |
| 6 | 云盘上传的「匹配曲库」也是**服务端**行为，规则是「**MD5 优先，其次是歌曲的 ID3**」，与 163key 无关（163marker 作者原话：与云盘匹配无关） | 【有旁证】（官方/半官方答疑 + 作者回帖） |
| 7 | `library.dat.track.id` = **SHA1(完整文件路径 UTF-8) 大写十六进制**；改名/移动 = 换身份 | 【已证实】（本机复算命中） |
| 8 | **FLAC 的 163key 应写在 Vorbis comment 的 `DESCRIPTION` 字段**（我们当前实现写的是 `COMMENT`，见 §4 风险） | 【已证实】（参考实现源码 + 本机真实 .ogg 样本 + 客户端内嵌 TagLib 字符串） |
| 9 | 【未找到证据】别人做过的「Windows 客户端手动写入 163key 后显示为已下载」的**外部**实测（只有 Mac 版第三方工具声称「写 Comment 后下载管理能识别」）。**但机制已由本机前端 JS 证据闭合**（§0.5/§2.7），现在缺的只是「我们自己做一次端到端验收实验」 | 【未找到证据】（机制已由 §2.7 补齐） |
| 10 | 标签 payload 的**权威字段表** ＝ 客户端自己写的 `music:` JSON：`musicId, musicName, artist[[name,id]…], albumId, album, albumPicDocId, albumPic, bitrate, mp3DocId, duration(ms), mvId, alias, transNames, format, fee, volumeDelta`（另 `privilege.flag` 在 `encryptFile` 时加） | 【已证实】（§2.7(d)） |
| 11 | `mp3DocId` **不是**本机文件的 MD5（两个真实样本实测均不等），本地无法推导 → 我们的标签里它只能是占位/近似值；解析端不校验它，**是否影响秒传/云盘匹配【未找到证据】** | 【已证实（反例）】+【未找到证据】 |
| 12 | 客户端「已下载」判定的**触发入口**是 native 命令 `storage.downloadscanner`（前端 `startScanDownload` 调用）；但**具体触发时机未定位**（启动时/打开下载管理时/改下载目录后） | 【未找到证据】 |

---

## 0.5 ★★★ 决定性发现（前端 JS 一手证据，同日追补）

**一句话结论**：客户端把某个文件认成「已下载」，靠的不是隐藏数据库里的魔法，而是 **native 的 DownloadScanner 扫描下载目录 → 把每个文件的 `comment`（就是 163key 解密后的 `music:{...}` 明文）交给前端 JS → JS 解析出歌曲身份，直接往 `webdb.dat.offlineTrack` 插一行 `state=finish`（完成＝已下载）**。所以：**标签就是「已下载」认定的输入，而路径决定扫描器看不看得到这个文件。**

证据链（来源：本机 `C:\Program Files\Netease\CloudMusic\package\orpheus.ntpk`，前 100 字节是十六进制头，第 100 字节起是标准 ZIP，解出 **1411 个 web 前端文件**；详见 §2.7）：

1. **原生桥接**（`pub/hybrid/app.chunk.83304b1.js`）：
   - `startScanDownload(e)` → `const{path:t,limit:n=100,excludePath:i=[]}=e; return yield Nt.call("storage.downloadscanner", t, !1, "", n, i), !0`
   - `subscribeDownloadScanner(e)` → 回调把原生回传的 `{comment, creation_time, last_accessed, last_modified, path, size}` 映射为 `{comment, creationTime, lastAccessed, lastModified, path, size}`。
   → **native 会读出每个文件的 comment 交给 JS**。
2. **前端消费**（`24.chunk.js` 与 `app.chunk.js` 的 `onDownloadScan`，逐句）：
   - `if(!l||!l.comment||!l.path) continue;` → **没有 comment 的文件直接跳过**（普通 mp3/flac 丢进下载目录不会被认成已下载）。
   - `let n = yield r(m.h, l.comment, l.size);` → 用 comment 解析歌曲身份；`if(!n||!n.id) continue;` 解析失败也跳过。
   - 命中即建行落库：`state:i.b.finish`、`relativePath:l.path.replace(R,"")`、`newRelativePath:l.path.replace(R,"")`、`completeTime:l.creationTime`、`size:l.size`、`fileType:T?1:0`、`realSuffix:n.realSuffix||"mp3"`、`origin:null`，随后 `Database.put({tableName:"offlineTrack", rows:u})`（`X="offlineTrack"`）。
   - 去重/保护：库里已有该 id 的行 → `if(j) continue`；本次已出现同路径 → 跳过；该 id 正在下载（`download.state>addQueue`）→ 跳过。
3. **「已下载」列表判据**：`Database.sqlQuery().from("offlineTrack").where({type:t, state:o.b.finish})`；播放取 `path:e.relativePath`；`encryptFile:!!/\.ncm$/.test(e.relativePath)`。
4. **客户端自己怎么生成这个标签**（同一份 JS 的 `le` 函数）——它构造的 `comm` 就是 `music:{...}` 明文，然后交给 native 加密写入：`comm = "music:"+JSON.stringify({musicId, musicName, artist, albumId, album, albumPicDocId, albumPic, bitrate, mp3DocId, duration, mvId, alias, transNames, format, fee, volumeDelta})`（`encryptFile` 时再加 `privilege.flag`），`Nt.call("storage.addid3", id, path, pathId, ext, comm)`。
   → **JS 里 0 处出现 `163 key` 字面量、也没有可用的 AES 加解密路径，加解密全部在 native**（与 §1.1 的 DLL 证据吻合）。

**对本项目验收的直接含义**
- 【已证实】写对 163key **就是**让客户端「认成已下载」的正门——**不需要伪造数据库**；补法＝「标签写对 ＋ 放进客户端下载根目录 ＋ 触发下载目录扫描」。
- 【已证实】只写标签、但文件**不在下载根目录**（或扫描器没跑到它），`offlineTrack` 就不会有行 → 「下载管理」里不会出现。
- 【已证实】标签必须被 native 读出并解析出合法 payload。于是 **FLAC 的 Vorbis 字段名变成成败关键**（§4：客户端内嵌 TagLib，`comment()` 优先 `DESCRIPTION`、回退 `COMMENT`；我们当前写的是 `COMMENT`）。
- 【推测，未确认】扫描链路里没有看到 API 调用（`m.h` 解析函数体只做字符串/JSON 处理，`size` 参数未被使用），因此**很可能不需要联网/登录**；但这一点没有一手实证，建议用「断网＋未登录」做对照。

---

## 1. 三种机制分别起什么作用

### 1.1 `163 key(Don't modify):...` 标签（"163key"）

**格式**（【已证实】，本机 10 个样本全部复核）：标签文本 = `163 key(Don't modify):`（**22** 字符）+ Base64 密文；Base64 解码后用 **AES-128-ECB + 密钥 `#14ljk_!\]&0U<'(`**（16 字节，hex `2331346C6A6B5F215C5D2630553C2728`）解密，PKCS#7 去填充，得到明文 = 前缀 + JSON。前缀有两种：`music:`（歌曲）、`dj:`（播客/电台节目）。

自检技巧（我实测出来的）：因为第一个 AES 块固定是 `music:{"musicId` 这 16 字节，所以**所有正确的 `music:` 标签，其密文 Base64 的前 21 个字符固定为 `L64FU3W4YxX3ZFTmbZ+8/`**（本机 10 个样本的前 23 字符均一致）；算出别的开头就是密钥/算法/字段搞错了。

**客户端确实会读它**（【已证实】，三条独立证据）：
1. `cloudmusic.dll` 内同时存在 `getid3content`（解密读）与 `addid3content`（加密写回）的实现，字符串原文包括 `163 key(Don't modify):`、密钥 `#14ljk_!\]&0U<'(`、`Error: getid3content: AES_decrypt length not in multiple of AES_BLOCK_SIZE!`、`addid3content write media tag:`，源码路径 `...\orpheus\src\player\common\utility.cpp`。（本机 `C:\Program Files\Netease\CloudMusic\cloudmusic.dll`，37,747,192 字节）
2. 社区一手实测（2025-02-27，帕琪的小屋 https://pakiknowledge.pages.dev/posts/neteaseshit/ ）：作者把平板下载的播客音频（tag 明文前缀是 `dj:`）上传云盘后想收藏进歌单，被提示「版权方要求，无法收藏」/「无法收藏电台节目进歌单」；**把这段备注从 mp3 里去掉之后就可以了** → 客户端确实按标签内容执行版权/节目类型拦截，且该拦截**只**依赖标签本身。
3. 参考实现 163marker 的存在意义即「让非网易云客户端下载的音频文件能被客户端识别，正常匹配歌词和查看评论」。

**⚠ 修正（2026-10-22 追补）**：本节早期版本写的「标签不产生、也不等价于『已下载』记录」**已被 §0.5/§2.7 的前端 JS 证据推翻**。正确关系是：标签**就是**「已下载」认定的输入（native DownloadScanner 把 comment 交给前端 JS，JS 据此写 `offlineTrack` 里 `state=finish` 的行），而**路径**决定扫描器是否会看到这个文件——两者缺一不可。

### 1.2 客户端自己的本地数据库/索引

`%USERPROFILE%\AppData\Local\Netease\CloudMusic\Library\` 下两个 SQLite（我实测，均以 `SQLite format 3\0` 开头）：

**A. `library.dat`（13,312 B；另有 `library_bak.dat` 13,312 B、`library.dat-journal` 6,704 B）——本地曲库索引**
- 只有一张表 `track`：
  `CREATE TABLE track(file TEXT, tid TEXT, aid TEXT, dir TEXT, title TEXT, album TEXT, genre TEXT, artist TEXT, duration REAL, timestamp INTEGER, bitrate INTEGER, filesize INTEGER, ignored INTEGER DEFAULT 0, id TEXT, artistid TEXT DEFAULT "", parentdir TEXT DEFAULT "", track TEXT, librarypath TEXT DEFAULT "", tracknumber INTEGER, source TEXT DEFAULT "", starttime REAL DEFAULT 0, type INTEGER DEFAULT 0)`
  索引：`file_index(file)`、`dir_index(dir)`、`id_index(id)`、`parentdir_index(parentdir)`
- 18 行。`dir` 只有两个取值：`E:\CloudMusic`（17 行）与 `<download>`（1 行）；全部 18 行 `source=''`、`type=0`、`ignored=0`、`tid=''`。
- 二进制里的 SQL 片段（DLL 字符串，源码 `...\orpheus\src\player\storage\library_index.cpp`）：`...,dir,ignored FROM ... ORDER BY dir ASC, file ASC`、`WHERE file=? COLLATE NOCASE ORDER BY file asc`、`WHERE dir=? COLLATE NOCASE ORDER BY file asc`、`VALUES(?,"","",?,?,?,?,?,?,?,?,?,0)`、迁移语句 `ADD parentdir TEXT DEFAULT ""` / `ADD track TEXT` / `ADD librarypath TEXT DEFAULT ""` / `ADD tracknumber INTEGER DEFAULT 10001` / `ADD source TEXT DEFAULT ""`、`update library tables 1->3`。
  → 扫描索引**只用 `file`/`dir` 定位**，完全没有 163key 相关字段。
- `track.id` 派生算法【已证实】：**大写 SHA1(文件完整路径的 UTF-8 字节)**。我用 3 个真实行复算全部命中，例如 `sha1("E:\CloudMusic\G-DRAGON - POWER.mp3") = C699D703F40B2914B4360C1AE4460F18BFBE2166`，与库中 `id` 完全一致（md5 不匹配）。
  → 客户端按**路径**而不是音频内容给本地文件编身份。

**B. `webdb.dat`（293,100,544 B，即 279 MiB）——业务库**
- 19 张表：`audioEffect, audioEffectTrack, cloudTrack, dbTrack, device, historyAlbums, historyAudioBooks, historyAudios, historyPlaylists, historyTracks, historyVoices, localMatch, offlineTrack, persistentModel, playingCount, playlistTrackIds, requestCache, sqlite_sequence, tsPlayingCount`
- 行数实测：`dbTrack=7172`、`historyTracks=162`、`requestCache=1190`、`persistentModel=7`、`playlistTrackIds=3`，而 **`offlineTrack=0`、`cloudTrack=0`、`localMatch=0`、`device=0`**。
- 关键 schema 原文：
  - `CREATE TABLE offlineTrack (type VARCHAR(40) NOT NULL DEFAULT '', state BIGINT NULL, completeTime BIGINT NULL, newRelativePath VARCHAR(40) NOT NULL DEFAULT '', trackName VARCHAR(40) NOT NULL DEFAULT '', artistName VARCHAR(40) NOT NULL DEFAULT '', albumName VARCHAR(40) NOT NULL DEFAULT '', size BIGINT NULL, id VARCHAR(40) NOT NULL, jsonStr TEXT NULL, PRIMARY KEY (id))`
  - `CREATE TABLE localMatch (uid VARCHAR(40) NOT NULL, jsonStr TEXT NULL, PRIMARY KEY (uid))`
  - `CREATE TABLE dbTrack (id VARCHAR(40) NOT NULL, jsonStr TEXT NULL, PRIMARY KEY (id))`
- 客户端二进制里有专门面向这张表的 GP API 名：`queryOfflineTracks`、`queryOfflineTrackPath`、`offlineTrack`、`cancelOfflineTrack`、`enumOfflineTracks`、`deleteOfflineTracks`、`searchOffline`、`searchLocal`、`execsql`、`exectransaction`。
  → `offlineTrack` 就是「已下载/离线曲目」表：主键=歌曲 id，用 `newRelativePath`（相对下载根目录的**相对路径**）定位文件，另有 `state`/`completeTime`/`jsonStr`。

**对本机的解读（含 2026-10-22 修正）**：
- `offlineTrack` = **0 行** ⇒ 客户端当前**没有任何**「已下载」记账（这也是 §5.5 验收实验的基线）。
- `localMatch` = **0 行** ⇒ 它**不是**「匹配结果缓存」，而是**「忽略匹配（不关联）黑名单」**（`uid` → `jsonStr.trackIds`；由 `getCurrentUserIgnoreMatchSet` / `refreshLocalList` 读写，配合 `webdata\file\blackTrackIds` 与服务端 `ignoreTrackIds`/`restoreTrackIds` 接口）。**我早期「`localMatch`＝匹配结果表」的推测作废**（证据见 §2.7(f)）。
- `library.dat` 里唯一那条 `dir='<download>'` 记录指向的文件**不含 163key**（见 §3.3）⇒ 它进的是**本地曲库索引**（按路径），不是 `offlineTrack` 的「已下载记账」（按标签）。**两条通道是分开的**：`library.dat` 只用 `file`/`dir` 定位，`offlineTrack` 只看标签 + 路径。

### 1.3 路径 / 目录规则

- 【已证实】下载流程变量名（`cloudmusic.dll` 同一函数的字符串序列，@29409709 附近）：`mp3path, apicpath, others, str, commstr, id3s, dest_path, dest_root, tmp, dest_filepath, media_new_path, pic_new_path, rel_media_new_path, extension, temp_download_path, storage_path, vip_download_path, keys, relpath, rel_media_path, context`
  → 客户端下载时区分 `storage_path`（普通下载根）与 **`vip_download_path`（VIP 下载根）**，并显式计算 **`rel_media_path`（相对路径）**——与 `offlineTrack.newRelativePath` 完全对应。
- 【已证实】`VipSongsDownload` 是客户端**自己的目录名常量**（DLL 路径常量簇里有 `VipSongsDownload`、`ncm_notice`、`Library`、`Statics`、`webdb.dat`、`Cache`、`download` 等）。本机 `E:\CloudMusic\VipSongsDownload\` 里只有一个「拷贝后其他播放器不可播放的解决方案.txt」（301 B，2026/3/27 创建），内容是「此类歌曲会员用户下载后为专属格式（ncm）……若需拷贝至其他播放器播放，请单曲购买该歌曲后重新下载」。→ 证实 `VipSongsDownload` = VIP 专属 `.ncm` 下载目录。
- 【已证实】DLL 里有一组虚拟节点/来源名（**只以 UTF-16LE 存在**，ASCII 搜索为 0 命中）：`<download>`, `<mymusic>`, `<windowsmedia>`, `<itunes>`, `<kugou>`, `<baidumusic>`, `<xiami>`, `<kuwo>`, `<duomi>`, `<custom>`, `<publicmusic>`。`library.dat` 里那条 `dir='<download>'` 用的正是这个虚拟节点。
- 【有旁证】V2EX t/261868（2016-03-08，标题「为何网易云音乐下载的歌曲 放入自建文件夹后 下载标志就变灰了？」，7227 浏览）摘要原文：「比如默认下载目录设为 d:/music，把下载的音乐剪切到 d:/music/folder 后，云音乐上的已下载标识变成了灰色，意思就是没下载过，播放音乐时依旧要从网络走流量。」（页面本体多次抓取超时，仅得搜索摘要 → 降为旁证）
- 【已证实/负结果】客户端用户数据目录里**找不到明文形式的下载目录配置**：全目录（≤8 MiB 文件，含 UTF-16 搜索）搜 `DownloadDir`/`downloadDir`/`download_dir`/`DownloadPath`/`downloadPath`/`storage_path`/`VipSongsDownload` 全部 0 命中；`webdata\file\configCenter`（121,350 B JSON）是广告/配置中心下发项，无下载目录；`localdata`(15,097 B)、`localware`(52 B)、`cloudmusic.elog`(7,623,201 B) 均为混淆/加密字节（`CloudMusic`/`Download` 明文 0 命中）；`info`(10 B) 内容只是 uid `1288439217`；注册表 `HKCU\Software\Netease`、`HKLM\SOFTWARE\Netease` 下**没有 CloudMusic 项**（只有 GameViewer / MuMu 系列）。→ 下载根目录配置应在混淆存储里，无法只读取证。

### 1.4 三者的分工矩阵（缺一个会怎样）

| 想达到的效果 | 需要 163key 标签？ | 需要本地库记账？ | 需要路径/目录？ |
|---|---|---|---|
| 客户端「知道这是哪首歌」→ 显示正确歌词/封面/评论 | **需要**（或靠服务端词图匹配猜） | 不需要 | 不需要 |
| 显示为「已下载」（下载管理里有它、离线播放不跑流量） | **需要**（前端 JS 明确 `if(!l.comment) continue`：无标签文件不会被登记） | 由客户端自己写（**不需要**我们伪造；扫描后 JS 会 `Database.put` 一行 `state=finish`） | **需要**（文件须落在下载根目录内才会被扫描到） |
| 本地音乐「匹配词图」匹配到线上歌曲 | 有帮助（提高候选正确率），但**匹配本身是服务端行为** | 不需要 | 影响缓存键（按路径缓存） |
| 被客户端收录进「本地音乐」列表 | 不需要 | **需要**（`library.dat.track` 行） | 需要（目录须在扫描范围内，且未被 `ignored`） |
| 云盘上传后「匹配曲库」 | 不需要 | 不需要 | 不需要 |

---

## 2. 一手/二手证据清单（含 URL 与原话）

### 2.1 我自己在二进制里挖到的（一手，只读）
见 §1.1/§1.2/§1.3 引用的 `cloudmusic.dll` 字符串与源码路径（`orpheus\src\player\common\utility.cpp`、`...\player\common\AudioTagsAcquisitor.cpp`、`...\player\music_discern\music_id3_reader.cpp`、`...\player\storage\library_index.cpp`、`...\player\storage\library_storage.cpp`、`...\player\music_discern\filepath_watchex.cpp`、`...\player\nos_upload_wrapper\file_uploader.cpp`）。前端可达 API 名（GPS 表 @29291552）：`scanMusicFile`、`deleteScanMusicFile`、**`setTrackMatchInfo`**、`discernMusic`/`discernMusic3`/`discernMusicTest`、`selectSystemDir`、`selectSystemFile`、`openSaveFileDialog`。
→ 即：客户端有「扫描本地音乐」「设置本地文件↔线上歌曲匹配信息」「词图识别」三套独立动作。**⚠ 修正**：早期版本据此写「字符表里没有任何『靠标签判定已下载』的痕迹」——该结论**已被 §2.7 推翻**：判定逻辑不在 DLL 而在 **web 前端 JS**（`pub/hybrid/24.chunk.83304b1.js` 的 `onDownloadScan` ＋ `app.chunk.83304b1.js` 的 `startScanDownload`/`subscribeDownloadScanner`），原生侧只提供 `storage.downloadscanner` 把每个文件的 comment 交出来。

### 2.2 网易云官方一手文档
**（a）官方专栏《“偷删本地文件”系谣言 我们分析了本地文件不见的几种可能原因》** https://music.163.com/topic?id=43355669 （2019-07-08，云音乐技术/Android开发组，阅读 257.9 万）原话要点：
- 「在扫描本地音乐时，过滤了部分文件夹，导致歌曲无法显示」
- 「在本地音乐里进行了删除歌曲操作（不勾选删除文件）后，会导致网易云音乐『本地音乐』选项中一直无法显示这首歌曲，实际上歌曲本地文件还在」
- 「在其他音乐 APP 下载的特殊格式歌曲，网易云音乐目前无法识别」
- 「将本地音乐进行词图识别后，因我们的识别精度的问题，可能存在展示的歌曲信息和原文件歌曲信息不一致」→「点击『还原歌曲信息』即可恢复」
→ 官方承认：「本地音乐」可见性由**扫描索引 + 持久化的『已删除/忽略』状态**决定（对应 `library.dat.ignored`）；「下载管理」列表成员是客户端记账；识别/匹配是客户端的独立动作。

**（b）半官方答疑《「网易云音乐云盘」相关技巧及其答疑 V2.0.1》** https://music.163.com/topic?id=18356075 （2017-04-12，作者秋风暖暖666，阅读 25.8 万）原话：
- 「云盘的匹配规则是 **MD5 优先，其次是歌曲的 ID3**」
- 「本专栏提供的方法只能提高云盘识别的成功率……并不能保证 100% 成功」
- 秒传原理 = 文件 MD5 去重；「MD5 计算的得出和歌曲的 ID3，大小，内容是息息相关的」
- 提高匹配率的做法是**改 ID3**（歌名/歌手/专辑/删封面描述/删年份流派音轨号等），**全程没有提到 163key**
- PC 端上传匹配成功率高于移动端

### 2.3 GitHub 一手：参考实现 nondanee/163marker（136★ / MIT）
https://github.com/nondanee/163marker
- README 原话：「为歌曲添加 `163 key(Don't modify)` 标记。让非网易云客户端下载的音频文件能被客户端识别，正常匹配歌词和查看评论**（与云盘匹配无关）**」
- `163marker/core.py`（我通过 GitHub API 取回 base64 解码核对）：FLAC 写 `audio['description']`，MP3 用 `audio.tags.RegisterTextKey('comment','COMM')` 写 `audio['comment']`；读取时跳过前 22 字符再 Base64→AES 解密→`json.loads(meta[6:])`（跳过 `music:`）。
- **issue #6「现在貌似失效了...」** https://github.com/nondanee/163marker/issues/6 （2021-01-26，open，2 条评论）报告人原话：
  > 「如题，自行测试了下面四首歌曲，都没能匹配成功
  > http://music.163.com/song?id=1803908863 成功写入163key，但匹配失败
  > http://music.163.com/song?id=1815109508 成功写入163key，但匹配失败
  > http://music.163.com/song?id=863967061 运行后未写入163key，匹配失败
  > http://music.163.com/song?id=1457707546 运行后未写入163key，匹配失败
  > 前两首使用外来的FLAC资源，后两首使用第三方工具下载的网易云MP3资源
  > 使用网易云音乐Windows版 2.7.6」
  作者 nondanee 回复原话：「README 里写了 **"与云盘匹配无关"**」；2024-05-23 另一位用户补问「是不是因为 `https://music.163.com/api/song/detail?ids=` 失效了？」
  → 这是**最接近本项目问题的一手反馈**：Windows 2.7.6 上「成功写入 163key 但依然匹配失败」。但必须标注两点局限：①报告人说的「匹配」含义不明（作者按「云盘匹配」回应，倾向是云盘流程）；②其中两首连标签都没写进去。**因此不能据此断言「标签对本地识别无效」，只能断言「写了标签 ≠ 一定匹配成功」。**（档位：【有旁证】，方向为「不足够」）
- issue #3「能否通过读取本地文件确认歌曲id?」（2020-10-01）讨论从本地 mp3 恢复歌曲 id，作者反问「用本地文件的什么信息推出 id？」→ 说明 163key 里确实带 `musicId`，但社区也清楚它不是完整的可逆歌单来源。

### 2.4 社区一手实测：本地「词图匹配」的真实机制（对本题极关键）
**iyn.me《对网易云音乐将云盘上传/本地播放的音乐关联匹配到曲库相应条目行为的观察》** https://iyn.me/i/post-30.html （2019-03-10，10,140 浏览）原话要点：
- 「首先播放歌曲 A，匹配到了歌词。之后将歌曲 A 文件换成与歌曲 A 完全不同的歌曲 B，**保持路径相同文件名相同**。再次播放，呈现的依旧是上次匹配到的歌曲 A 的歌词。」
- 「首次频谱分析拉到结果后会将**匹配结果按文件路径缓存**。**重启可使缓存失效**，重新进行频谱分析匹配。」
- 「对于已经成功匹配过歌词的本地歌曲，下次播放时不会再发出任何匹配相关的 API 请求」
- 把歌曲 A 的 meta 全改成歌曲 C 的，**依旧匹配成 A**；但 meta 会影响结果：「meta 会影响频谱分析（听歌识曲）匹配结果，但 meta 对匹配结果的影响仅作用于由频谱匹配相似决定的歌曲范围之内」——「在 meta 中把曲名设置成 Hop 并不能使得一首不是 Hop 的曲子匹配结果为 Hop」
- 抓包：本地播放时发 `/eapi/search/match/new`（疑 hash 匹配）与 `/eapi/music/matcher`（疑频谱匹配）；静音改版先 hash 返回空、再频谱成功
→ 「本地音乐匹配到线上歌曲」= **服务端 hash/频谱识别**，不是标签判定；缓存键是**文件路径**。

### 2.5 Mac 版第三方工具/教程（唯一「写 Comment → 下载管理能识别」的旁证）
- GitHub **tpnet/Repair163MusicComment**（4★, Apache-2.0, 1 issue）https://github.com/tpnet/Repair163MusicComment
  简介原文：「Repair163MusicComment，修复修改mp3的Comment信息，让网易云可以识别出来别的地方下载的歌曲」
  README（jsDelivr 取回原文）功能列表：「一键批量修改增加mp3的Comment为网易云歌曲的Comment / 单首歌修改 / 单首歌自定义网易云链接修改 / **自动更新网易云数据库信息** / 加解密Comment」；「原理：用网易云音乐的api接口搜索歌曲，匹配歌曲，得到歌曲的id，再使用api获取歌曲详情，然后根据详情信息生成网易云歌曲的Comment，设置到mp3的metadata里面，从而使得网易云可以识别到其他渠道下载的歌曲。」
- 配套 CSDN 教程《解决Mac网易云音乐下载管理识别不到mp3歌曲(修改Comment)》（2021-04-08，https://blog.csdn.net/niubitianping/article/details/115522609 ，CSDN 本体 HTTP 521 抓不到，仅得搜索摘要）：「在Mac上使用网易云音乐的时候，不能直接显示本地歌曲，只能通过**下载管理**添加本地文件夹，但不是网易云下载的歌曲却识别不出来」「通过填充和加密MP3文件的Comment字段，使Mac版网易云音乐能够识别并播放从其他渠道下载的歌曲」
→ 档位【有旁证】。注意其功能里那句「自动更新网易云数据库信息」措辞含糊（可能指更新工具自己的曲库缓存，也可能指写本地库），**不足以断言纯标签即可**；且是 Mac 版，Windows 版行为未证实。

### 2.6 其他旁证（未深挖，仅登记）
lchloride/NeteaseMusicCacheDecoder（把缓存转 MP3 并「添加云音乐识别码(163 key)，可以被云音乐识别，以查看歌词和评论」）；PyPI `ncm-163key-parser`（只读标识符）；CuiZhenhang/netease-music-tools（本地音乐与网易云匹配，把云信息同步到本地）；Cinvin/myuserscripts（云盘匹配纠正，1039★）；tree-white/NeteaseCloudMusicTools、zdxiaoda/NeteaseMusicCloudManager、chaunsin/netease-cloud-music、s337443501/NeteaseMusicCloudMatch（都围绕官方「云盘歌曲信息匹配纠正」接口）；Binaryify/NeteaseCloudMusicApi issue #1212（该接口）。

---

### 2.7 ★ 前端 JS 一手证据（本机 `package\orpheus.ntpk` → ZIP → `pub/hybrid/*.js`）

来源与可复现性（一手，只读）：`C:\Program Files\Netease\CloudMusic\package\orpheus.ntpk`，38,310,589 B。**去掉前 100 字节后是标准 ZIP**（第 100 字节处为 `PK\x03\x04`；前 64 字节是 ASCII 十六进制串 `0003f3efaaf702c76a85e4401a22460ea6ac`；各偏移熵 7.99–8.00/8），用 `zipfile` 可解出 **1411 个 web 前端文件**：`pub/hybrid/app.chunk.83304b1.js`（解压 5,378,081 B）、`pub/hybrid/subApp.chunk.83304b1.js`（5,048,246 B）、`pub/hybrid/vendors~app~subApp.chunk.83304b1.js`（3,439,545 B）、`pub/hybrid/24.chunk.83304b1.js`（37,839 B）、`pub/hybrid/215.chunk.83304b1.js`（3,906 B）、`pub/hybrid/67.chunk.83304b1.js`（22,761 B）等 200+ 个 `*.chunk.83304b1.js`。**`b"163 key"` 在全部 1411 个条目中 0 命中** ⇒ 标签字面量与加解密只在 native 侧。

#### (a) 原生桥接：谁去读文件、读什么

```js
// pub/hybrid/app.chunk.83304b1.js  （subApp.chunk 同码）
startScanDownload(e){ ... const {path:t, limit:n=100, excludePath:i=[]} = e;
  return yield Nt.call("storage.downloadscanner", t, !1, "", n, i), !0 }

subscribeDownloadScanner(e){ ...
  const t = t => { const n = t.map(e => { const {comment:t, creation_time:n, last_accessed:i,
      last_modified:o, path:r, size:a} = e;
      return {comment:t, creationTime:n, lastAccessed:i, lastModified:o, path:r, size:a} }); e(n) };
  return Nt.appendRegisterCall("downloadscanner","storage",t), () => { Nt.removeRegisterCall("downloadscanner","storage",t) } }
```
⇒ 【已证实】**native 命令 `storage.downloadscanner(path, false, "", limit, excludePath)` 会把每个文件的 `comment`（＝163key 解密后的明文）连同 `path/size/creation_time/last_accessed/last_modified` 回传给 JS**。另有 `subscribeDownloadFileDeleted`→`filedelete`/`storage`（原生信号 `storage.onfiledeleted`）。

#### (b) ★★★ `onDownloadScan`：把「有 comment 的文件」直接登记成 `offlineTrack` 里 `state=finish` 的行

```js
// pub/hybrid/24.chunk.83304b1.js（同函数亦在 app.chunk.83304b1.js）
onDownloadScan(e,t){ let {payload:o}=e, {put:l, select:n, call:r}=t; return function*(){
  const {trackMap:e, voiceMap:t, mvMap:d} = yield n(e => { let {download:t}=e; return t }), u=[], p=o.length;
  for(let a=0;a<p;a++){ const l=o[a];
    if(!l || !l.comment || !l.path) continue;                       // ← 没有 comment 直接跳过
    let n = yield r(m.h, l.comment, l.size),                        // ← 用 comment 解析身份（见 (c)）
        s = n?.mv ? c.a.mv : n?.voiceId ? c.a.voice : c.a.track;
    ...
    if(!n || !n.id) continue;                                       // ← 解析失败/无 id 跳过
    const p = Object(i.n)({voiceMap:t,trackMap:e,mvMap:d,resourceType:s}), j = p.get(n.id),
          h = j?.path && !x.a.test(j.path), T = x.a.test(l.path),
          g = Array.from(p.values()).some(e => e.path === l.path);
    if(h && T || g) continue;                                       // ← 同路径已存在则跳过
    const D = j?.download?.state; if(D && D > i.b.addQueue) continue;
    if(j) continue;                                                 // ← 库里已有该 id 则跳过
    const I = {...Object(i.c)({resource:n, resourceType:s}),
       bitrate:n.bitrate, volumeDelta:n.volumeDelta||0,
       state:i.b.finish,                                            // ★★ 直接标记为「已完成/已下载」
       relativePath:l.path.replace(R,""), newRelativePath:l.path.replace(R,""),   // ★ 相对下载根
       completeTime:l.creationTime, size:l.size, fileType:T?1:0,
       realSuffix:n.realSuffix||"mp3"};
    p.set(n.id,{path:I.relativePath, offlineId:I.id,
                download:{state:I.state, id3State:I.id3State}, origin:null}), u.push(I) }
  try{ if(u.length){ const e = yield r(a.Database.transaction,["offlineTrack"]);
    yield e(async e => { await a.Database.put({tableName:"offlineTrack", rows:u, retTrans:e}) }),
    yield l({type:"onDownloadScan/success", payload:{}}),
    s.b.info("download onDownloadScan","dbList = ",u) } }
  catch(j){ s.b.error("download onDownloadScan","error ".concat(j)) }
  yield l({type:"onUpdate", payload:{trackMap:e, voiceMap:t, mvMap:d}}),
  s.b.info("download onDownloadScan","dbList = ",u) }() }
```
逐条含义（每条都直接决定本项目验收）：
- **`if(!l.comment) continue`**：没有 163key 的文件**永远不会**被这条路径登记成已下载。这是「普通本地文件放进下载目录不会被认成已下载」的机制性原因。
- **`state:i.b.finish` + `origin:null`**：身份完全来自文件里的 comment，不来自线上资源（`origin:null`）。
- **`relativePath/newRelativePath = l.path.replace(R,"")`**：库里存的是**相对下载根**的路径；`R` 的唯一定义未定位到（同文件另有 `R=/^(\+)/i` 与请求头 `R="PH-PC-Xunlei-SDK-Strategy."+q`，均非此 R）⇒ 【未确认】。
- **`completeTime:l.creationTime`、`size:l.size`**：完成时间＝**文件创建时间**（不是下载时间），大小＝文件大小。
- **`x.a.test(path)` → `fileType`**：`x=o(171)`；同 chunk 另一处 `encryptFile: l.a.test(n)`（`l=o(3)`）判 `.ncm` ⇒ 【推测】`x.a` 是「加密/`.ncm`」判定正则，`fileType=1` 表示加密文件。
- 去重规则：同 id 已有行（无论是否下载完）→ 跳过；本轮扫描内同路径已出现 → 跳过。

#### (c) ★ 解析函数 `E`（＝module 23 的 export `h`，即 `m.h(comment, size)`）：客户端怎么读我们的标签

```js
// pub/hybrid/app.chunk.83304b1.js @2498200
E = async (e,t,n) => { let i=/"mp3DocId":(\d+)/, o=/"picId":(\d+)/;
  if(!e) return;
  let r = "".concat(e).indexOf(":"); if(r<0) return;         // ★ 必须以 music:/dj:/mv: 前缀出现，否则放弃
  let l = e.substring(0,r), c = "mv"===l;                     // 前缀 = music / dj / mv
  if((!n || (!("dj"===l) && !c)) && (e = e.substr(r+1).trim()
        .replace(/(^[\u0000-\u001F]+|[\u0000-\u001F]+$)/g,""))) {   // ★ 剥掉首尾控制字符（ID3 填充/0 字节）
    e = c ? e.replace(o,'"picId":"$1"') : e.replace(i,'"mp3DocId":"$1"');  // 数字型 mp3DocId/picId 补引号
    try { const t = JSON.parse(e); if(!t) return;
          return await (async(e,t)=>{ ...build resource... })(t,l) }
    catch(s){ f.b.error("parse error") } } }
```
映射成资源对象（同函数内）：
```js
r = { id: Object(m.i)(o.musicId) ? Object(O.t)(o.musicId) : o.musicId?.toString(),
      name:o.musicName, alias:o.alias, transNames:o.transNames||[], artists:P(o.artist),
      album:{ id:String(o.albumId||""), name:String(o.album||""),
              picId:String(o.albumPicDocId||""), picUrl:String(o.albumPic||"") },
      duration:o.duration, mvId:o.mvId?String(o.mvId):"",
      realSuffix:o.format||"mp3",                                     // ★ 缺省 "mp3"
      commentThreadId:..., voiceId:"",
      bitrate:(l=o.bitrate, l<=0?0 : l<=1e5?64e3 : l<=15e4?128e3 : l<=3e5?192e3 : l<=4e5?32e4
               : l<1999e3?999e3 : l<2999e3?1999e3 : l<3999e3?2999e3 : l),
      volumeDelta:o.volumeDelta };
if(o.flag!=null) r.privilege={flag:o.flag};
if(o.privilege?.flag!=null) r.privilege={flag:o.privilege.flag};
if(o.fee!=null) r.fee=o.fee;
```
⇒ ①**native 交给 JS 的 comment 已经是解密后的 `music:{...}`/`dj:{...}`/`mv:{...}` 明文**（前缀在第一个冒号之前；**没有冒号就整条丢弃**）；②首尾 `[\u0000-\u001F]`（含 ID3 常见的 `\x00` 填充）会被剥掉，**但正文内部的 0 字节不会**；③`mp3DocId`/`picId` 是数字时会被「补引号」修成字符串（说明两种形态都被见过）；④`bitrate` 只用于归到 64000/128000/192000/320000/999000/1999000/2999000 档位；⑤`realSuffix ← format`（**缺省 `mp3`**）；⑥**track/dj 分支里看不到任何 API 调用**（只有 `mv:` 分支有 `await Object(j.e)(o.picId)` 取封面）⇒ 解析是**纯本地**过程；⑦第三个参数（scanner 传的是 `size`）在该分支里没被使用 ⇒ **没有对文件大小做校验**。

#### (d) ★ 客户端自己怎么写这个标签（`le`，权威字段表）

```js
// pub/hybrid/app.chunk.83304b1.js @2510507
oe = /"mp3DocId":"(\d+)"/, re = '"mp3DocId":$1', ae = /^(mp3|flac|aac|m4a|mp4)$/i,
le = (e,t) => { ... if(!ae.test(e.realSuffix||"") || u)
      return {..., comm:"", ext:{media_rel_path:..., image_rel_path:""}};   // ★ 后缀不在白名单就不写标签
   const d = e.origin; let f = null;
   if(Object(O.r)({track:d})) f = { musicId:e.offlineId.replace(/offline-|track-/gi,""),
      musicName:(d.name||"").trim(), artist:ne(d.artists),
      albumId:(d.album||{}).id, album:((d.album||{}).name||"").trim(),
      albumPicDocId:(d.album||{}).picId, albumPic:(d.album||{}).picUrl,
      bitrate:e.bitrate, mp3DocId:e.md5, duration:d.duration, mvId:d.mvid,
      alias:d.alias, transNames:d.transNames||[], format:e.realSuffix,
      fee:e.origin.fee, volumeDelta:e.volumeDelta||0 };
   ... m && (s = "dj:".concat(JSON.stringify(m))), f && (s = "music:".concat(JSON.stringify(f)));
   s = s.replace(oe, re);                                        // ← 纯数字 mp3DocId 去掉引号后再写
   let g = { tit2:(d.name||"").trim(), tpe1:ie(d.artists) || m?.djName,
             talb:(t===voice && m?.radioName) ? m.radioName : d.album.name,
             encrypt:!!e.encryptFile, media_rel_path:e.finalPath||e.path,
             image_rel_path:"", trck:"", tpos:"" };
   d.position && (g.trck=(d.position||0).toString());
   d.cd && (g.tpos=(d.cd||"").toString());
   ... return { tmpPicUrl:"meta\\"+e.offlineId+"."+hash(picUrl), comm:s, ext:g } }
```
⇒ ①**只有后缀匹配 `ae=/^(mp3|flac|aac|m4a|mp4)$/i` 的才写 163key**；②`music:` 字段表＝`musicId, musicName, artist, albumId, album, albumPicDocId, albumPic, bitrate, mp3DocId, duration, mvId, alias, transNames, format, fee, volumeDelta`（**与本机 2023 真实样本逐字段一致**；Minecraft ogg 样本多出的 `fee`/`volumeDelta` 正来自这里）；③`mp3DocId: e.md5`、`format: e.realSuffix`；④发射前把**纯数字**的 `mp3DocId` 去引号；⑤`ext={tit2,tpe1,talb,encrypt,media_rel_path,image_rel_path,trck,tpos}` 交给 native 写进 ID3（TIT2/TPE1/TALB/COMM/APIC），封面走 `meta\<offlineId>.<hash>` 相对路径；⑥调用形式 `Nt.call("storage.addid3", id, path, pathId, ext, comm)`，回调事件名 `addid3done`（原生信号 `storage.onaddid3done`）——**JS 从不自己加密，`comm` 以明文交给 native**。

#### (e) `mp3DocId` 是不是「文件 MD5」：实测反例（重要）

| 文件 | 实测 MD5 | 标签里的 `mp3DocId` | 相等？ |
|---|---|---|---|
| `<REAL_SAMPLE:一个由官方客户端写入 163key 的真实 mp3>` | `96dc78c78f627fd4f4c38d826a178f10` | `cde6b150f488f81c8f0d9b374d2fe2fb` | ✗ |
| `…\assets\minecraft\sounds\music\menu\menu1.ogg`（两份副本 md5 相同） | `ce6c6ee028a7d1525132d9825164d553` | `81fc9d0ce34b9a0946ce979ca3f3fb65` | ✗ |

⇒ 【已证实】**`mp3DocId` ≠ 该本地文件的 MD5**；它更像服务端/NOS 侧文档 id（与 DLL 里 `file_uploader.cpp` 的 `bucket/token/docId`、`it2.datas` 同族），**本地无法推导**。解析端（`E`）不校验它 ⇒ 写个占位值不会被本地解析拒绝；但**「是否影响秒传/云盘匹配/客户端判断是否需要重新下载」未找到证据**（§6 存疑）。

#### (f) 其它同批确认

- **`&`/`@` 列映射规则**（`app.chunk.js` 里 `offlineTrack` 的 schema 声明）：`&` 前缀＝主键列，`@` 前缀＝**真正落库的列**，其余字段（`relativePath`/`realSuffix`/`id3State`/`fileType`/`md5`/`volumeDelta`/`detail`/`typeExtra`/`typeId`/`downloadTime`/`albumId`/`trackId`）**全部序列化进 `jsonStr`**——与真实 `webdb.dat` schema 完全吻合（库里只有 `id,type,state,completeTime,newRelativePath,trackName,artistName,albumName,size,jsonStr`）。
- **`state` 在库里是 JSON 序列化字符串**：`Database.updateBy({tableName:"offlineTrack", condition:{name:"id",value:e.id}, modify:t=>(t.state=JSON.parse(t.state), e.modify(t))})`。
- **native 命令白名单（不做参数混淆）**：`storage.offlineTrack`、`storage.execsql`、`storage.exectransaction`、`storage.savetofile`、`storage.deletefile`、`storage.readfromfile`、`storage.downloadscanner`、`storage.scanDirectory`、`app.scanMusicFile`、`musiclibrary.addLibrary/removeLibrary`、`player.*`、`winhelper.*` 等 ⇒ 客户端**自带**「扫描指定目录」能力。
- **`webdb.dat` 表由前端 JS 建/迁移**：`vendors~app~subApp.chunk.83304b1.js` 里有 knex 风格迁移器 `copyData: (t,e,n)=>\`INSERT INTO "${e}" SELECT ... FROM "${t}";\``、`dropOriginal`、`renameTable`、`getTableSql: t=>\`SELECT type, sql FROM sqlite_master WHERE (type='table' OR (type='index' AND sql IS NOT NULL)) AND lower(tbl_name)='${t.toLowerCase()}'\``；执行通道 `class ty{... execSql(e,t){... Nt.call("storage."+(t?"exectransaction":"execsql"), n, i.join("")) } sqlQuery(){...}}`（DLL 里查不到的列名正因如此）。
- **`localMatch` 不是「匹配结果缓存」，而是「忽略匹配（不关联）黑名单」**：`getCurrentUserIgnoreMatchSet` 读 `localMatch(uid)` 的 `trackIds` 组成 Set，`refreshLocalList` 用 `blackTrackIds` 本地缓存 + 服务端接口（`ignoreTrackIds`/`restoreTrackIds`/`onlineTrackId`）维护 ⇒ 我早期「`localMatch`＝匹配结果表」的推测**应作废**（已在 §1.2 修正）。
- **移动下载目录（`215.chunk.js` 的 `moveDownload`）证明 `relativePath` 是相对下载根**，且**文件清单＝`offlineTrack` 中 `state=finish` 的所有行 + 硬编码补一条 `VipSongsDownload\拷贝后其他播放器不可播放的解决方案.txt`**；换根时按相对路径重写：`Database.updateBy({tableName:"offlineTrack", condition:{name:"newRelativePath", value:e}, modify:e=>(e.relativePath=t[0], e.newRelativePath=t[0], e)})`；同盘符 `move`、跨盘符 `copy`；完成后 `App.exitApp(ExitAppAction.restart)` 重启客户端。

---

## 3. 本机只读取证（路径 + 文件名 + 实测值）

### 3.1 客户端安装目录 `C:\Program Files\Netease\CloudMusic\`
`cloudmusic.exe`（2,634,744 B）、`cloudmusic.dll`（37,747,192 B，LastWriteTime 2026/10/10 21:06）、`package\orpheus.ntpk`（38,310,589 B，文件头是 ASCII 十六进制串 `0003f3efaaf702c76a85e4401a22460ea6ac…` 而非 `NTPK`）、`package\native.ntpk`（779 B，头 `NTPK`）、`package\common.skin`（1,213,673 B，头 `NTPK`）、`package\dark.skin`、`resource\`（`3D环绕.ncae`、`ca`、`format.ico`、`gpuforbidlist`、`ncm_notice`、`translation.bin`、`vivid_model.bin` 等）。
`cloudmusic.dll` 内嵌 **TagLib**（`FLAC::File::scan()`、`Ogg::FLAC::File::scan()`、`Vorbis::File::read() - Could not find the Vorbis comment header`、`ASF::File::save()` 等），并在 @30681456 出现字面量 **`DESCRIPTION`**（紧邻 `TRACKNUM`）；@30663488 起是 TagLib 的 ID3v2 帧名表（`COMMENT`/`ALBUM`/`TIT2`…）。`cloudmusic.exe` 内上述 163key/DESCRIPTION 关键字 0 命中（逻辑都在 DLL 里）。

### 3.2 用户数据目录 `%USERPROFILE%\AppData\Local\Netease\CloudMusic\`
一级子目录：`ad, Aegis, aioresource, audioeffect, Cache, discern, dumps, Library, Log, preview, safemode, Statics, Temp, update, wasm, webapp91x64, webdata`；一级文件：`cloudmusic.elog, info, install.log, localdata, localware`。
- `Library\`：`library.dat`、`library.dat-journal`、`library_bak.dat`、`webdb.dat`（§1.2 已详解）
- `Statics\`：2043 个条目 = 2038+ 个 32 位十六进制名 `.dat` + `index.dat`(1,403,904 B) + `index.dat-journal`。`index.dat` 是 SQLite，表 `cache(id,url,path,type,headers,size,create_time,access_time,ttl)`；搜 `CloudMusic`/`VipSongsDownload`/`E:\`/`163 key`/`download`/`mp3`/`flac` 计数全 0 → 只是通用 HTTP 缓存，不是曲库。
- `webapp91x64\`：Chromium profile（`Cache\`、`Code Cache\js+wasm\`、`databases\Databases.db`、`IndexedDB\orpheus_orpheus_0.indexeddb.leveldb\`、`Local Storage\leveldb\`、`Cookies`(32,768 B)、`LocalPrefs.json`）
- `webdata\file\`：`appUpdate, backList, blackTrackIds, configCenter, crash_report, dawnLogFilterConfig, fmPlay, homePage, homePageBanner, homePageEcpm, lastTimePlayingList`(13,896,444 B)、`playingList, recentListen, runtimeMessage`
- `Log\`：`BI`、`Upload`、`bilog.elog.cahe`
- **全目录（2373 个 ≤60 MiB 文件）搜 `163 key` / UTF-16LE `163 key` / `163key` / `music:{` = 0 命中** → 客户端不把 163key 落到自己的数据文件里，需要时**直接从媒体文件标签读**。
- 下载目录配置负结果见 §1.3 末段。

### 3.3 `E:\CloudMusic\`（57 个音频，全部无 163key）
- 命名规则「歌手 - 歌名.ext」；44 个「周杰伦 - *.flac」的时间戳集中在 2026/10/22 13:01:11–13:01:56（批量拷贝），另有 13 个 mp3/flac 在 2024/12–2026/4。
- 唯一子目录 `VipSongsDownload\`（2026/3/27 创建）内只有 `拷贝后其他播放器不可播放的解决方案.txt`（301 B，原文两行，见 §1.3）。
- 我逐文件搜 `163 key`（含 UTF-16LE）/`163key`/`music:{`/`dj:{`：**57/57 全为 0 命中**。
- `library.dat` 里那 17 行 `dir='E:\CloudMusic'` 覆盖的文件名（节选）：`G-DRAGON - POWER.mp3`、`G-DRAGON,TAEYANG,DAESUNG - HOME SWEET HOME…`、`G.E.M. 邓紫棋…`、`Michita…`、`pro、陈小满…`、`suhmeduh…`、`Valentin…`、`周杰伦 - 一路向北.mp3`、`季彦霖…`、`磨尖的粉笔…`、`艾比利…`、`蒋孜怡,岳燃…`、`郑润泽…`、`阴雨天…`、`颜人中-慢慢.flac`、`颜人中-我只能离开.mp3`、`黄龄-鸳鸯戏.flac`。
  **44 个今天 13:01 拷入的「周杰伦 - *.flac」一行都没有**（`library.dat` 最后写入 12:29，早于拷贝）→ 客户端**必须扫描**才会进库，靠拷文件本身不会自动被认。
- `webdb.dat.offlineTrack` 唯一那条 `dir='<download>'` 记录的实体文件是 `%USERPROFILE%\Downloads\Music\【四川话助眠】温柔姐姐安慰压力大的你…  角色扮演  情景模拟.aac`（16,354,199 B），该文件头是 MP4/AAC 容器（`ftyp isom … avc1 isom dash`），**不含任何 163key**；`webdb.dat` 里按文件名关键词（`四川话`）逐表逐列搜索 **0 命中**（即它不在 `dbTrack`/`historyTracks` 里）。该行的其它字段：`duration=595391.833`、`timestamp=1789572948`、`bitrate=219`、`tracknumber=10000`、`parentdir='%USERPROFILE%\Downloads\Music'`、`librarypath='%USERPROFILE%\Downloads'`、`starttime=0.0`、`artistid='0'`（album/genre/artist 空）。
  → 这是「下载分组不依赖标签」的直接反例，也是理解 `dir='<download>'` 语义的关键样本。

### 3.4 ★ 本机真实 163key 样本（**这是本项目最宝贵的真值样本**）
我用 Python 扫 `E:\`、`D:\`、`%USERPROFILE%`（3523 个音频文件）后，共找到 **10 个**含 163key 的文件：
1. **真实用户老文件（2023 年，非本项目产物）**：`<REAL_SAMPLE:一个由官方客户端写入 163key 的真实 mp3>`（8,602,160 B，CreationTime/LastWriteTime = **2023/11/12 21:00**，ID3v2.3，COMM 帧，编码字节 0x00、语言码 `XXX`）。解密后明文：
   `music:{"musicId":1809412694,"musicName":"John Dreamer-亚托克斯 伴奏（Jackie remix）","artist":[["Jackie",37125028]],"albumId":121139178,"album":"ATOX","albumPicDocId":"109951165606660795","albumPic":"https://p3.music.126.net/fDOu_nezGgSAF5NfVuqFsg==/109951165606660795.jpg","bitrate":320000,"mp3DocId":"cde6b150f488f81c8f0d9b374d2fe2fb","duration":213702,"mvId":0,"alias":[],"transNames":[],"format":"mp3"}`
   → **2023 年的真实标签里带 `"format":"mp3"`，且数字型 id、`mvId:0`**；字段顺序与本项目当前实现的顺序一致。
   → 注意：这个 mp3 **完全不在客户端任何库里**（`library.dat` 18 行、`webdb.dat` 都没有它），客户端从未把它当成已下载/已收录。它是「有标签但客户端根本不认识它」的现成反例。
2. **真实第三方 .ogg 样本（Vorbis）**：`D:\Program Files\Minecraft Launcher\.minecraft\versions\隔离区\resourcepacks\…\assets\minecraft\sounds\music\menu\menu1.ogg`（等 6 个 menu*.ogg，两个资源包版本各一份）。字段名是 **`DESCRIPTION=`**，紧邻 `TRACKNUMBER=2`；解密后明文：
   `music:{"musicId":"33378175","musicName":"Horizon","artist":[["Pawel Blaszczak","41735"]],"albumId":"3206018","album":"Dying Light (Original Score)","albumPicDocId":"7940672977237536","albumPic":"https://p3.music.126.net/xGGDH_fd4qBtT2tIOfFSew==/7940672977237536.jpg","bitrate":320000,"mp3DocId":"81fc9d0ce34b9a0946ce979ca3f3fb65","duration":160000,"mvId":"","alias":[],"transNames":[],"format":"mp3","fee":0,"volumeDelta":-4.5797}`
   → **字符串型 id + 额外字段 `fee`/`volumeDelta`** 的另一种（更新的？）标签形态；且该 ogg 里 `format` 仍写 `"mp3"`（说明 `format` 至少不总是可靠）。**这是「Vorbis 字段名 = DESCRIPTION」的本机实物证据。**
3. **本项目自己的输出（3 个）**：`%WORKSPACE%\netease-163key-tagger\out\scratch\t2.mp3`、`t3.mp3`、`t4.flac`。解密均成功，密文 Base64 前缀与真实样本一致（`L64FU3W4YxX3ZFTmbZ+8/`）→ 密钥/算法/前缀实现正确。
   **但 t4.flac 的字段名是 `COMMENT=`（不是 `DESCRIPTION=`），见 §4。**

（原 Lead 说「全盘只有 1 个文件带 163key」，那是因为扫描时本项目还没产出 t2/t3/t4；现在共 10 个，其中 1 个真实老 mp3 + 6 个真实 ogg + 3 个项目产物。）

---

## 4. ★★★【必须看】FLAC 的 163key 写在哪个 Vorbis 字段：我们当前实现写的是 `COMMENT`，而参考实现与实物证据都是 `DESCRIPTION`

这条直接回答 Lead 在 m00123 的点名问题。

**证据链（四条独立证据指向 `DESCRIPTION`）：**
1. 参考实现（136★，社区事实标准）`163marker/core.py`：FLAC 走 `audio['description'] = identifier`，即 mutagen 的 **`description` → Vorbis comment 字段 `DESCRIPTION`**；MP3 才走 `COMMENT` 帧。
2. **本机实物**：§3.4-2 的 6 个真实 `.ogg` 里，字段名就是 `DESCRIPTION=`。
3. 客户端二进制内嵌 TagLib，DLL 里存在 `DESCRIPTION` 字面量（@30681456，紧邻 `TRACKNUM`，属 TagLib 的 Vorbis 字段名区）。
4. TagLib `taglib/ogg/xiphcomment.cpp` 的 `String Ogg::XiphComment::comment() const` 逻辑：**先取 `DESCRIPTION`，非空就用它**；为空才回退 `COMMENT`（`setComment()` 同理优先 DESCRIPTION）。（档位【已证实/二手交叉】）

**我们当前实现的差异（我读到的代码，不是推测）：**
- `netease-163key-tagger\lib\tags.mjs:418`：`export const DEFAULT_FLAC_FIELD = 'COMMENT';`
- `netease-163key-tagger\lib\tags.mjs:415` 的注释理由是「TagLib 把 Vorbis COMMENT 与 ID3 COMM、MP4 ©cmt 视为同一字段」
- 文件事实（我在 `out\scratch\t4.flac` 里读到的字节）：标签写在 `COMMENT=163 key(Don't modify):…`

**风险评估（我的判断，供 Lead 决策）：** 若客户端用的是 TagLib 的 `comment()` 存取器，`COMMENT` 属于兜底路径、**大概率也能读到**；但若客户端按字段名精确取 `DESCRIPTION`（或走它自己的 Vorbis 解析），写 `COMMENT` 就会**读不到标签**，表现为「标签写了但客户端不认」。这条风险**成本极低、收益明确**，建议：
1. FLAC **写 `DESCRIPTION`**（与 163marker/实物一致）；
2. 最稳妥是**同时写 `DESCRIPTION` 和 `COMMENT`**（都指向同一段标签文本），代价只是几十字节；读取时两者都试（163marker 的做法是 `max(identifier, key=len)` 取最长，我们可照抄这个容错思路）；
3. 在 e2e 里对 FLAC 断言「`DESCRIPTION` 存在且可解密」。
（`lib/tags.mjs` 不是我负责的文件，我只做只读核对与上报，不代改。）

---

## 5. 对本项目验收的影响

### 5.1 只写 163key，能通过什么样的验收？
- **能**让客户端「知道这个文件是哪首歌」：正确显示歌词/封面/评论，参与「匹配词图」时的候选判定，并进入客户端的版权/节目类型判断（`music:` vs `dj:` 明文前缀会带来不同提示）。
- **【2026-10-22 关键修订】只要它还落在客户端会扫描的下载根目录里，写对 163key 就能让客户端把它**直接记账成「已下载」**（native DownloadScanner 把 comment 交给前端 JS，JS 往 `offlineTrack` 写 `state=finish` 行——§0.5/§2.7）。也就是说：标签侧是「已下载」认定的**正门**，不是可有可无的装饰。
- 已有的直接证据表明客户端**确实读**这个标签（DLL 的 `getid3content` 实现 + 前端 JS 的 `m.h(comment,…)` 解析 + 帕琪实测 + 163marker 的定位）。

### 5.2 只写 163key，**不足以**得到什么（2026-10-22 修订版）
- **只写标签、但不把文件放进客户端会扫描的下载根目录**（或扫描器根本没跑到它）⇒ 不足以让客户端认成「已下载」：`offlineTrack` 依旧 0 行。（原来的理由是「标签与记账无因果」；修订后正确的理由是**路径这一环缺失**——见 §2.7 的 `if(!l.comment) continue` 与扫描根限制。）
- **不足以**保证「匹配到线上歌曲」：本地词图匹配是服务端 hash（`/eapi/search/match/new`）→ 频谱（`/eapi/music/matcher`）流程，结果**按文件路径缓存**；标签只影响服务端在频谱相似候选中的选择，不能把一首别的歌「指定」成某一首（iyn.me 实测）。云盘匹配同理是服务端 MD5/ID3。
- **不足以**让文件进入「本地音乐」列表：那需要客户端扫描进 `library.dat`；拷进去不扫描不会自动出现（本机 44 个新拷入 FLAC 一行都没有即是实证）。
- **不足以**在 FLAC 上生效——如果我们把标签写在 `COMMENT` 而客户端内嵌 TagLib 读到的是 `DESCRIPTION`（§4，当前实现的实际风险）。
- **不足以**补齐 `mp3DocId` 这类服务端侧字段（本地无法推导，§2.7(e)），是否影响秒传/云盘匹配【未找到证据】。

### 5.3 有没有可行的补法（按风险从低到高）
1. **路径侧（低风险，最可能奏效）**：把打好标签的文件放到客户端**下载根目录的直接子级**，让客户端自己扫描。依据：`offlineTrack.newRelativePath` + 下载流程里的 `rel_media_path` + DLL 的 `<download>` 虚拟节点 + V2EX「移到子文件夹后已下载标志变灰」。**但这条在本机无法验证**（下载根目录配置在混淆存储里，且 `offlineTrack` 为空，我无法确认是「按目录现扫」还是「按记账」）。建议作为验收实验（见 5.4）。
2. **数据库侧（高风险，不建议作为交付路径）**：关掉客户端后向 `webdb.dat.offlineTrack` 插入记录（需要 `id`、`newRelativePath`、`state`、`completeTime`、`jsonStr`，且要猜 `newRelativePath` 的基准根）。风险：客户端可能校验/覆盖、可能要求 `jsonStr` 完整结构、可能触发云同步不一致；**且我没有任何一手证据证明它有效**（无样本可参照：`offlineTrack` 是空表）。仅建议作为「实验性探索」，不要写进对外承诺。
3. **标签侧（本项目正在做的）**：把 163key 写对（FLAC 用 `DESCRIPTION`，MP3 用 `COMMENT`）+ 把 title/album/artist 写正确（云盘匹配「MD5 优先，其次 ID3」）。这能让「已匹配（词图/歌词/评论）」成立，但不等于「已下载」。

### 5.4 建议的验收实验（一次、只读为主，需用户同意才动客户端库）
1. 关闭网易云客户端 → 备份 `Library\library.dat`、`library_bak.dat`、`webdb.dat`（**不要**在没有备份时写库）。
2. 复制一个带正确 163key 的文件到下载根目录的直接子级（候选：`%USERPROFILE%\Downloads\Music\`，因为它是唯一已知的下载根痕迹）。
3. 启动客户端 → 观察四点：(a) 是否出现在「下载管理」；(b) `library.dat` 是否新增 `dir='<download>'` 行、该行 `id` 是否 = SHA1(路径)；(c) `webdb.dat.offlineTrack` 是否新增行；(d) 若判定为已下载，记录该行 `jsonStr` 与 `newRelativePath`（这是以后能否「伪造已下载」的唯一钥匙）。
4. 对照组：同一个文件放进 `E:\CloudMusic\`（非下载根），看两者差异 → 直接判定「标签 vs 记账 vs 路径」谁在起作用。
> 该实验会读客户端库、会往音乐目录拷文件，属于「修改本机状态」，**必须由 Lead/用户明确同意后再做**；我本人按任务要求全程只读，未执行。

---

### 5.5 ★ 基于前端 JS 的验收修订（**本节取代 §5.3 第 1、2 条与 §5.4 中的相应判断**）

机制已定（§0.5、§2.7）：客户端认出「已下载」的完整条件是 **①文件在客户端会扫描的下载根目录内 ＋ ②文件带能被 native 解出合法 payload 的 163key ＋ ③扫描器把 comment 交给 JS 并解析出 id ＋ ④JS 往 `webdb.dat.offlineTrack` 写 `state=finish` 行**。

**修订后的补法清单（风险从低到高）**
1. **【首选·低风险】标签写对 ＋ 放进下载根目录 ＋ 触发下载目录扫描**
   - 标签：MP3 写 ID3v2 `COMM`（内容 `163 key(Don't modify):` + Base64(AES-128-ECB(`music:{...}`))，密钥 `#14ljk_!\]&0U<'(`）；**FLAC 必须写到 Vorbis `DESCRIPTION`**（见 §4；建议 DESCRIPTION + COMMENT 双写以兼容读取端）。
   - payload 字段严格对齐 §2.7(d)：`musicId, musicName, artist[[name,id],…], albumId, album, albumPicDocId, albumPic, bitrate, mp3DocId, duration(ms), mvId, alias, transNames, format`（`fee`/`volumeDelta` 客户端也会写，可加）。
   - 目录：必须是**客户端正在使用的下载根目录**（本机线索：`librarypath='%USERPROFILE%\Downloads'`、`parentdir='%USERPROFILE%\Downloads\Music'`，来自 `library.dat` 里唯一那条 `dir='<download>'` 行；真正的下载根配置写在混淆存储里，未只读取证到，见 §6）。**推荐至少把文件同时放两处**（下载根与其直接子级 `Music\`）以提高命中概率。
   - 触发：让客户端做一次下载目录扫描（`storage.downloadscanner`；UI 上的对应动作大概率是「打开下载管理 / 设置里改下载目录 / 启动客户端」——**具体触发时机未定位，属本方案唯一未闭合环节**）。
2. **【不需要了】**~~伪造/写入客户端数据库~~：JS 会自己重建 `offlineTrack` 行，所以**直接改库属于下策**（还要处理 `state` 是 JSON 序列化字符串、`jsonStr` 结构、`&`/`@` 列映射、journal 一致性等细节，风险远高于标签路线）。
3. **【不建议】**走线上匹配接口（`/eapi/search/match/new`、`/eapi/music/matcher`）——需要登录态 + device 签名，且 `iyn.me` 的实测显示那是频谱/hash 匹配，与 163key 是两条独立通道。

**修订后的成功判据（可只读复验）**
- 客户端数据：`webdb.dat` 的 `offlineTrack` 里出现 **`id`＝我们写入的 `musicId`** 的行，且 `state`（**JSON 序列化字符串**，需 `JSON.parse` 后比较）为「完成」值、`newRelativePath`＝「文件路径 − 下载根前缀」；`offlineTrack` 行数从 0 变 1。
- 客户端 UI：「下载管理」出现该歌曲且可离线播放；「歌曲信息/匹配」显示线上元数据。
- 反向对照：把同一个文件（含 163key）放到**非下载目录** → `offlineTrack` 不应新增行（验证「路径」这一环的必要性）；把**同内容但去掉 163key** 的文件放进下载根 → 也不应新增行（验证「标签」这一环的必要性）。这两个对照能把三个机制的责任彻底分开。

**修订后的验收实验（4 步；需要在「先关客户端 → 拷文件 → 开客户端 → 只读复验」的窗口内进行，仍需 Lead/用户明确同意，我全程不动客户端库）**
1. 记录基线：`offlineTrack` 行数（当前 **0**）、`library.dat` 行数（当前 18）、客户端进程未运行时复制 `webdb.dat`+`library.dat`(+journal) 到 `%TEMP%` 留底（**只读副本**）。
2. 取一个现成带真标签的样本（如 `%WORKSPACE%\netease-163key-tagger\test\e2e\src\Jackie - John Dreamer-亚托克斯 伴奏（Jackie remix）.mp3`）与一个「去掉标签」的对照副本，文件名保持 `歌手 - 歌名.ext`，放进下载根目录（候选①`%USERPROFILE%\Downloads`、候选②`%USERPROFILE%\Downloads\Music`）。
3. 启动客户端 → 打开「下载管理」/触发一次下载目录扫描 → 关闭客户端。
4. 只读复验：`offlineTrack` 行数、新行的 `id/state/newRelativePath/jsonStr`、`library.dat` 是否新增、`E:\CloudMusic` 是否变化；把结果贴回报告。

---

## 6. 未找到证据 / 存疑清单（不编造成结论）

1. 【未找到证据】**外部**一手实测证明「在 Windows 客户端手动写入 163key 后，客户端把它显示为已下载」（最接近的只有 Mac 版 tpnet/Repair163MusicComment + CSDN 教程的**声称**，且含「自动更新网易云数据库信息」等含糊措辞）。**【2026-10-22 更新】机制已由本机前端 JS 证据闭合（§2.7），此处缺的只是「我们自己做一次端到端实验」。**
2. 【未找到证据】`library.dat.ignored`、`source`、`type` 三个列被客户端写入非默认值的真实样本（本机 18 行全是默认 0/空）→ 「本地音乐被我删过就一直不显示」这个官方说法对应哪一列，我只敢说是「持久化标记」，无法证明就是 `ignored`。
3. 【已部分解决】客户端「已下载」在**文件被移出下载根目录后变灰**的机制：前端 JS 侧已确认 `newRelativePath` 是**相对下载根**、且「移动下载目录」会按相对路径重写整张表（§2.7(f)）；仍缺的是**下载根本身**（配置在混淆存储里，只读取证不到）与**扫描触发时机**。
4. 【未找到证据】`<download>` 在 `library.dat.dir` 里的确切语义。两种都说得通：「文件在下载根目录里」 vs 「该文件是客户端下载的」。我倾向第一种，理由是那条记录对应的 AAC **没有 163key 也不在 `dbTrack` 里**、且 `offlineTrack` 为空；但**这是【推测】**。
5. 【已解决（修正）】`localMatch` 表＝**「忽略匹配（不关联）黑名单」**（`uid` → `jsonStr.trackIds`，配合 `webdata\file\blackTrackIds` 与服务端 `ignoreTrackIds`/`restoreTrackIds` 接口）——证据：`getCurrentUserIgnoreMatchSet` / `refreshLocalList`（§2.7(f)）。**原「存本地文件↔线上歌曲匹配结果」的推测作废。**
6. 【未找到证据】客户端对 `format` 字段是否校验、对未知字段是否容忍（真实样本里既有带 `format` 的，也有带 `fee`/`volumeDelta` 的；Minecraft 的 ogg 里 `format` 写的是 `"mp3"` 却是 ogg 文件 → 说明 `format` 至少不是强校验项）。**建议：保持与 163marker 一致的字段集即可，不必强行增补 `fee`/`volumeDelta`；如要做，先做小样本验证。**
8. 【未找到证据】`onDownloadScan` 里 `l.path.replace(R,"")` 的 `R`（下载根前缀）与 `x.a`（路径类型 / `.ncm` 判定正则）的唯一定义未定位（同文件另有 `R=/^(\+)/i` 与请求头 `R="PH-PC-Xunlei-SDK-Strategy."+q`，都不是它）。
9. 【未找到证据】`startScanDownload` / `storage.downloadscanner` 的**触发时机**（启动时？打开下载管理时？改下载目录后？）——扫描是「打开下载管理才扫」还是「常驻监听」，直接决定我们的补法要不要用户手动点一次。
10. 【未找到证据】下载目录扫描/登记是否**需要联网或登录**（`m.h` 解析函数体里未见任何 API 调用、`size` 参数未被使用 → 倾向「不需要」，但只是【推测】）。
11. 【未找到证据】`mp3DocId` 的校验与用途：解析端只做引号修补、不校验；但客户端/服务端是否用它做秒传、云盘匹配或「是否需要重新下载」的判断，无证据。两个真实样本的 `mp3DocId` 与本机文件 MD5 均不相等（§2.7(e)）。
12. 抓取失败、只能引用搜索摘要的：`www.v2ex.com/t/261868`（超时）、`blog.csdn.net/niubitianping/article/details/115522609`（HTTP 521）、`raw.githubusercontent.com`（超时）。关键词检索方面：`platform_search github` 对中英文查询多次返回 "No results found"，`advanced_search engine=multi` 对中文长查询返回官网噪声；**exa 引擎与 GitHub API 最有效**。

---

## 7. 参考链接

- 官方专栏（本地文件为何不见）：https://music.163.com/topic?id=43355669
- 半官方云盘答疑 V2.0.1（匹配=MD5 优先其次 ID3）：https://music.163.com/topic?id=18356075
- 163marker（参考实现，136★）：https://github.com/nondanee/163marker ；issue #6「现在貌似失效了...」https://github.com/nondanee/163marker/issues/6 ；issue #3 https://github.com/nondanee/163marker/issues/3
- 163key 格式与密钥说明（魔帆博客，2019-05-03）：https://morfans.cn/archives/2793
- 本地/云盘匹配机制一手实测（iyn.me，2019-03-10）：https://iyn.me/i/post-30.html
- 163key 被客户端读并据此拦截（帕琪的小屋，2025-02-27）：https://pakiknowledge.pages.dev/posts/neteaseshit/
- Mac 版写 Comment 工具：https://github.com/tpnet/Repair163MusicComment
- 云盘匹配纠正接口相关：https://github.com/Binaryify/NeteaseCloudMusicApi/issues/1212
- V2EX「下载标志变灰」（仅摘要）：https://www.v2ex.com/t/261868
