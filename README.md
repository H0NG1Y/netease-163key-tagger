<div align="center">

# 网易云 163key 标签工具

**给本地音乐文件写入 163key，让客户端认出它们是曲库里的哪首歌**

[![GitHub](https://img.shields.io/badge/GitHub-181717?logo=github&logoColor=white)](https://github.com/H0NG1Y/netease-163key-tagger)
[![Stars](https://img.shields.io/github/stars/H0NG1Y/netease-163key-tagger?color=yellow&label=stars&logo=github)](https://github.com/H0NG1Y/netease-163key-tagger/stargazers)
[![Downloads](https://img.shields.io/github/downloads/H0NG1Y/netease-163key-tagger/total?color=orange&label=downloads)](https://github.com/H0NG1Y/netease-163key-tagger/releases/latest)
[![Windows Download](https://img.shields.io/github/v/release/H0NG1Y/netease-163key-tagger?color=brightgreen&label=Windows%20Download&logo=windows&logoColor=white)](https://github.com/H0NG1Y/netease-163key-tagger/releases/latest)
[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A522-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![Zero Dependencies](https://img.shields.io/badge/dependencies-0-4CAF50)](package.json)

</div>

![主界面](docs/screenshot.png)

## 项目介绍

一个仅在本机运行的 Windows 工具：扫描你的本地音乐文件，按「歌手 - 歌名」到网易云曲库匹配到对应歌曲，把 `163 key(Don't modify)` 标签写进文件里。

写对之后，客户端会把它们认成曲库里的正常歌曲 —— **本地音乐会匹配上曲名和封面，也会出现在「已下载」列表里**（前提是文件放在客户端会扫描的下载目录内，见下方说明）。

整个过程不下载音乐、不破解付费内容，只改你自己磁盘上文件的标签。

## 下载

请从 [GitHub Releases](https://github.com/H0NG1Y/netease-163key-tagger/releases/latest) 下载。

每次发版都提供两个版本，**功能完全一样**，区别只是「装不装进系统」，按习惯挑一个：

| 下载 | 适合谁 | 说明 |
| --- | --- | --- |
| `netease-163key-tagger-v版本号.exe` | 偶尔用、想随身带 | **单文件版**，绿色免安装，双击即用，不需要装 Node.js |
| `netease-163key-tagger-setup-v版本号.exe` | 经常用、想直接敲命令 | **安装版**，装到固定目录并登记进 PATH，带标准卸载项 |

Release 同时提供 `checksums.txt`，可以核对下载文件的 SHA-256：

```powershell
Get-FileHash .\netease-163key-tagger-v0.3.0.exe -Algorithm SHA256
```

### 单文件版

下载完**双击**就行——不用安装，也不用解压。浏览器会自动打开界面。

- 配置和报告固定放在 `%USERPROFILE%\.netease-163key-tagger`，换个地方放 exe 也不会丢
- 第一次启动会慢几秒（要把内置资源释放到 `%TEMP%`），之后秒开
- 不想要了，删掉这个 exe 和上面那个目录就干净了

想用命令行也可以，只是得带上路径：

```powershell
.\netease-163key-tagger.exe scan           # 扫描音乐目录
.\netease-163key-tagger.exe match          # 联网匹配
.\netease-163key-tagger.exe apply --write  # 写入标签
.\netease-163key-tagger.exe verify         # 校验结果
```

### 安装版

下载 `...-setup-...exe`，**双击**，点「安装」。它会做三件事：

1. 装到 `C:\Program Files\netease-163key-tagger\`
2. 把安装目录登记进**系统** PATH
3. 在「设置 → 应用 → 已安装的应用」里登记标准卸载项

因为要写 Program Files 和系统 PATH，**安装时会弹一次 UAC 要管理员权限**（和隔壁的 [gacha-link-fetcher](https://github.com/H0NG1Y/gacha-link-fetcher) 一样）。安装向导里可以选：

- 是否加入 PATH
- 是否创建桌面快捷方式
- 装完是否立刻启动

装完**开一个新的终端窗口**，在任何目录都能直接敲：

```powershell
netease-163key-tagger                 # 启动网页界面
netease-163key-tagger scan            # 扫描音乐目录
netease-163key-tagger match           # 联网匹配
netease-163key-tagger apply --write   # 写入标签
netease-163key-tagger verify          # 校验结果
```

不带参数是图形界面；带 `scan` / `match` / `apply` / `verify` / `self-test` 就是命令行。

<details>
<summary>静默安装 / 自定义目录 / 静默卸载</summary>

Inno Setup 的标准静默参数：

```powershell
# 静默安装（默认会加 PATH）
.\netease-163key-tagger-setup-v0.3.0.exe /VERYSILENT /SUPPRESSMSGBOXES /NORESTART

# 指定目录
.\netease-163key-tagger-setup-v0.3.0.exe /VERYSILENT /DIR="D:\Tools\163key"

# 不要加 PATH（不加 /TASKS 就是不加）
.\netease-163key-tagger-setup-v0.3.0.exe /VERYSILENT /TASKS=""

# 静默卸载
"C:\Program Files\netease-163key-tagger\unins000.exe" /VERYSILENT /SUPPRESSMSGBOXES /NORESTART
```

安装日志写在 `%TEMP%\Setup Log *.txt`。

</details>

<details>
<summary>它改的是哪个环境变量？会不会写坏我的 PATH？</summary>

改的是 `HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment` 里的 **`Path`**，也就是系统 PATH。

三个实现细节，专门为了不给人添麻烦：

- 读的时候是**原样读**的，PATH 里原有的 `%SystemRoot%\system32` 这类变量引用**不会被展开**（这条是实测验证过的）
- `ValueType: expandsz` + `preservestringtype`，值类型仍然是 `REG_EXPAND_SZ`，不会被降级成 `REG_SZ`
- 安装前先查重，已经在 PATH 里就不重复添加

卸载时 Inno Setup 会按日志把 `Path` 恢复成安装前的值，脚本里的 `CurUninstallStepChanged` 另有一道兜底。**装一次再卸一次，PATH 逐字节回到原样**（同样是实测过的）。

改完会广播 `WM_SETTINGCHANGE`，但**已经开着的终端窗口仍然认不到新命令**，这是 Windows 的规矩，开一个新的就行。

</details>

<details>
<summary>从源码运行</summary>

需要 Node.js 22 或更新版本，零 npm 依赖：

```powershell
node server.mjs      # 网页界面
node apply.mjs scan  # 命令行
```

自己打包（单文件版 + 安装版一起出，需要 [Inno Setup](https://jrsoftware.org/isdl.php) 6/7）：

```powershell
pwsh .\Build-Release.ps1
```

</details>

## 使用方法

1. 双击 EXE，浏览器会自动打开 `http://127.0.0.1:端口`。
2. 点「设置」，选择**音乐目录**（会被写入）和**备份目录**（会被登记为只读，工具永远不会往里写）。
3. 点「① 扫描目录」，读取每个文件的标签、时长和实际码率。
4. 点「② 联网匹配」，按歌手和歌名去曲库搜索，进度条实时显示处理到哪个文件。
5. 对拿不准的条目点「复核」，在右侧抽屉里对比候选：可以试听、看封面和时长差，也可以直接粘贴歌曲 ID 或分享链接精确查找。
6. 点「③ 写入标签」。默认只写「自动命中」的条目，其余需要你显式放行。
7. 点「④ 校验结果」，把音频区和备份逐字节比对。

想同时修正文件里显示的标题、歌手、专辑或封面，勾上对应的两个复选框（默认关闭，见下方「顺带改写文件信息」）。

## 功能

- 支持 MP3（ID3v2.3 `COMM` 帧）与 FLAC（Vorbis comment `DESCRIPTION`，并补写一份 `COMMENT` 兼容副本）
- 联网匹配采用「搜索深度 100 + 时长/专辑/曲库身份三重判据」，避免命中翻唱和伴奏
- 复核界面显示封面缩略图、正版/UGC 标记、接口与本地时长差，支持按 ID 或分享链接直接定位
- 可批量重新挑选待复核项，执行前先列出方案让你确认
- 写入优先「同尺寸原地改」：能塞进原标签空间时只改标签区，音频字节一字节不动
- 可选同时改写标题、歌手、专辑与封面（`--meta` / `--cover`）
- 所有写操作默认 dry-run，不显式确认不落盘
- 备份目录登记为只读保护，路径比较按分段进行，不会误伤同前缀的兄弟目录
- 零 npm 依赖，只用 Node 内置模块

## 关于「让客户端认成已下载」

`163key` 只是元数据标签，客户端用它知道「这个文件是曲库里的哪首歌」。它**不是**「已下载」的凭据。

客户端判断「已下载」靠的是自己数据库 `webdb.dat` 里的 `offlineTrack` 表。写入链路是：

1. 原生层扫描**客户端配置的下载目录**，把文件的 comment（即解密后的 `music:{...}` 明文）交给前端；
2. 前端按第一个冒号取前缀，解析出 songId；
3. 往 `offlineTrack` 插一行，`relativePath = 绝对路径 − 下载根`。

所以要凑齐三个条件：

| 条件 | 谁负责 |
| --- | --- |
| 文件里有正确的 163key | ✅ 本工具 |
| 文件位于客户端设置的下载根目录内 | ⬜ 需要你自己放进去 |
| 客户端触发过一次下载目录扫描 | ⬜ 重新启动客户端 |

界面右上角的「客户端检查」会**以只读方式**读取 `offlineTrack` 的行数，直接告诉你还差哪一步，不需要猜。

### 已实机验证

条件凑齐后效果是双向成立的：客户端「本地音乐」里从「歌手/专辑空白」变成匹配上曲库的歌曲（`library.dat` 的 `tid` 从空变成真实 songId，且与 163key 里的 `musicId` 完全一致），「已下载」列表里也会出现这些歌（`offlineTrack` 从 0 行变成正数）。

天然对照组：没写 key 的文件，`tid` 始终为空，也不会进 `offlineTrack`。

## 顺带改写文件信息

匹配完成后，除了写 163key，还可以把文件里你看到的信息换成云端的：

```bash
node apply.mjs apply --report out/matches.json --write --meta            # 标题/歌手/专辑
node apply.mjs apply --report out/matches.json --write --meta --cover    # 再加专辑封面
```

界面上对应两个复选框，默认都不勾；勾封面会自动勾上文字。

| 开关 | 改什么 | 代价 |
| --- | --- | --- |
| `--meta` | MP3 的 `TIT2`/`TPE1`/`TALB`/`TPE2`；FLAC 的 `TITLE`/`ARTIST`/`ALBUM`/`ALBUMARTIST` | 纯文本，几乎不改变体积 |
| `--cover` | MP3 的 `APIC` 帧；FLAC 的 `PICTURE` 块（只留一张，旧封面删除） | 需联网下载封面，文件体积会变化 |

音频数据一字节都不会动，这条有回归测试守着。

## 命令行

不想开界面也可以直接用 CLI，所有子命令都支持 `--progress <file>` 输出结构化进度。

装了**安装版**的话，直接敲 exe 名：

```powershell
netease-163key-tagger scan     --root D:\Music
netease-163key-tagger match    --root D:\Music
netease-163key-tagger apply    --report out/matches.json --dry-run
netease-163key-tagger apply    --report out/matches.json --write
netease-163key-tagger verify   --root D:\Music --backup D:\Music-backup
netease-163key-tagger self-test
```

**单文件版**或从源码跑，把 `netease-163key-tagger` 换成 `.\netease-163key-tagger.exe` 或 `node apply.mjs` 即可，参数完全一样。

`apply` 的放行阶梯：默认只写自动命中的条目；`--include-review` 放行中等置信度；`--all` 全部放行。时长不符和 UGC 冒充只有 `--all` 能绕过。

顺带改写文件信息用 `--meta`（标题/歌手/专辑）、`--cover`（再加封面），**默认关闭**。

## 算法

```
163key = "163 key(Don't modify):" + base64( AES-128-ECB/PKCS#7( "music:" + 紧凑JSON ) )
```

密钥固定 16 字节，无签名、无 MAC。已用客户端真实下载的文件做双向验证：解密后重新加密，与原 Base64 逐字节一致。

字段顺序固定为：`musicId, musicName, artist, albumId, album, albumPicDocId, albumPic, bitrate, mp3DocId, duration, mvId, alias, transNames, format`

## 匹配时踩过的坑

匿名搜索是 **UGC 优先**的：翻唱、type-beat、DJ 版会挤满前 10~20 条，**授权曲库里的原唱要 20~100 名才出现**。实测 `s=简单爱 周杰伦`：

| 每次查询拉取 | 结果里真·周杰伦 |
| --- | --- |
| 10 条 | 0 条 |
| 30 条 | 1 条（第 21 条，还是现场版） |
| 100 条 | 32 条 |

所以默认搜索深度 100。挑原唱靠三条硬信号：

- **时长**：差超过 5 秒的候选独立降级，歌名歌手一字不差但时长对不上的，几乎必然是伴奏或合辑版
- **专辑**：同一录音会散落在多个精选集里，时长只差 1 毫秒，只有专辑名能挑出原版
- **曲库身份**：`artist.id === 0` 且专辑名为空的，多半是上传者冒名顶替原唱

另外还有两个容易忽略的点：客户端只读**最后一个** `COMM` 帧（key 排在空 COMM 前面会被读成空串）；`bitrate` 要写文件的实际码率，不是固定 320000。

更完整的排查记录见 [`notes/matching-pitfalls.md`](notes/matching-pitfalls.md)。

## 数据与隐私

- 只读取你指定的音乐目录，不会扫描其他位置。
- 联网只做两件事：搜索曲库、下载封面（仅在你勾选「替换封面」时）。
- 匹配报告、缓存和日志保存在程序数据目录，不会上传。
- 备份目录登记为只读保护，任何写入尝试都会直接报错。
- 默认 dry-run；实际写入需要你显式确认。
- 不修改客户端安装目录里的任何文件；「客户端检查」对数据库只读（复制到临时目录后再打开）。

> 手写客户端的 `webdb.dat` 是危险且没有必要的做法 —— 标签写对了，客户端自己会建行。

## 常见问题

**匹配率不高怎么办？**

先确认文件名是「歌手 - 歌名」格式，工具靠它做搜索。实在搜不到的，在复核抽屉里手动改关键词，或直接粘贴歌曲 ID / 分享链接。

**为什么有些文件故意不写？**

宁可漏写也不写错。遇到专辑信息不可信、艺人账号对不上、时长贴着容差边界的，工具会保留给你人工判断，不会替你拍板。

**写入后客户端还是没反应？**

检查三件事：文件是否在下载根目录内、是否完全退出过客户端（含托盘图标）再启动、标签是否真的写进去了（点「校验结果」）。

**FLAC 的 163key 写在哪个字段？**

`DESCRIPTION`（Vorbis 规范的注释字段），同时补写一份 `COMMENT` 兼容副本。这一点有旁证但没有客户端产出的真实样本，所以保留了 `--flac-field` 可切换。

**EXE 为什么这么大？**

单文件打包内置了 Node 运行时（约 89 MB），换来的是不需要安装任何东西。首次启动会把约 280 KB 的网页资源释放到临时目录，之后启动几乎瞬间完成。

## 源码结构

- `server.mjs`：本地 Web 服务，零依赖，负责把 CLI 包成界面
- `web/`：前端页面，无框架、无构建
- `apply.mjs`：CLI 入口（scan / match / apply / verify / self-test）
- `lib/163key.mjs`：163key 编解码
- `lib/tags.mjs`：ID3v2 与 Vorbis comment 读写，含时长与码率解析
- `lib/match.mjs`：文件名解析与候选打分（时长、专辑、曲库身份三重判据）
- `lib/netease-api.mjs`：曲库搜索与歌曲详情
- `test/`：四套自测（212 条断言）+ 离线假 API
- `verify/`：独立验证套件，用另一套实现交叉核对
- `notes/`：接口行为、客户端机制、二进制取证、踩坑记录、验收报告
- `build.mjs`：把源码打包成单文件 EXE（Node SEA）
- `installer/netease-163key-tagger.iss`：安装版的 Inno Setup 脚本
- `Build-Release.ps1`：一次产出「单文件版 + 安装版 + checksums.txt」

## 开发

```powershell
node server.mjs          # 起本地服务（源码态）
node apply.mjs self-test # 212 条断言，全程离线
node build.mjs           # 打包单文件版（需要 Node 22+ 与联网装 postject）
pwsh .\Build-Release.ps1 # 一次出「单文件版 + 安装版 + checksums.txt」
```

单文件版和安装版是**同一次发版的两个产物**，`Build-Release.ps1` 会把两个都打出来，少一个就直接失败。

编安装包用的是 [Inno Setup](https://jrsoftware.org/isdl.php)（6 或 7 都行），跟隔壁两个项目一致：`gacha-link-fetcher` 用 Inno Setup 出 Setup.exe，`OptiScalerInstaller` 用 WiX 出 MSI。

## 免责声明

这是一个非官方工具，与网易云音乐无隶属关系，仅供个人整理本地音乐库使用。请只对你合法拥有的音乐使用，不要用于分发版权内容。接口为逆向所得，服务端变更时可能需要更新。

[English README](README.en.md)
