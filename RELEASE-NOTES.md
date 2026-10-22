# v0.3.0

## 🎉 全新：单文件 EXE，双击即用

- 不用再敲 `node server.mjs` 了。下载 `netease-163key-tagger-v0.3.0.exe`，**双击**就打开网页界面。
- 内嵌了完整 Node 运行时（88.9 MB），**目标机器不需要装 Node.js**。
- 首次启动会自动释放内置资源到 `%TEMP%\netease-163key-tagger\`，第二次启动直接秒开。
- 端口自动挑空闲的，不会和别的服务撞。
- 配置和报告写在 `%USERPROFILE%\.netease-163key-tagger\`，卸载 exe 不会丢数据。

<details>
<summary>🖥 仍然想用命令行？</summary>

同一个 exe 也能当 CLI 用：

```powershell
# 扫描
.\netease-163key-tagger.exe --cli scan
# 匹配（只匹配不写盘）
.\netease-163key-tagger.exe --cli match
# 写入
.\netease-163key-tagger.exe --cli apply --write
# 校验
.\netease-163key-tagger.exe --cli verify
```

</details>

## 🆕 本次新增

### 搜索并对比面板

复核时不用瞎猜了。搜索框现在支持三种输入：

- 歌名 / 歌手关键词
- 纯数字歌曲 ID
- 网易云分享链接（`music.163.com/song?id=xxx` 或短链）

结果是一张张卡片，每张都带：

- **专辑封面**（网易云原图，88×88）
- **「UGC 冒充」/「会员」/「曲库正版」徽章**——一眼分出哪个是假歌
- **接口时长 vs 本地时长 vs Δ 差值**，绿/黄/红三色标注
- musicId、匹配分数

排序**不自己造**，直接用引擎的 `pickBest()` 打分——因为按「时长接近」排会把翻唱排到原唱前面（这个坑踩过一次，UI 层不能再踩一遍）。

### 批量挑选待复核项

一键把待复核的文件按引擎分最高的候选批量定下来，弹窗先给你看方案再执行。

### 顺带改写文件信息（可选，默认关闭）

写 163key 的同时，可以顺手把文件本地的标题 / 歌手 / 专辑改成曲库里的正版信息，并把专辑封面嵌进文件里。

- FLAC → 写 Vorbis `DESCRIPTION` + `PICTURE` 块
- MP3 → 写 ID3 `TIT2`/`TPE1`/`TALB` + `APIC`
- **音频区一个字节都不动**（自测逐字节校验 md5）
- **幂等**：重复写多次文件哈希不变

命令行：`--meta` 改信息，`--cover` 顺带下载封面。

## 🐛 修掉的问题

- **FLAC 封面只删不插**：原来重写封面会把旧 PICTURE 块删掉却不插入新的，封面直接消失。
- **FLAC 不幂等**：连续写两次，标签字段顺序会变（文件哈希一直在抖）。已修：已有字段就地改值，163key 永远写在最后。
- **撤销复核项报「参数不对」**：`/api/choose` 的 clear 分支被 musicId 校验挡住了。
- **前端显示 `[object Object]`**：歌手和专辑对象没拆开。

## ✅ 自测

212 条断言全绿（tags 77 + match 61 + meta 24 + e2e 50）：

- 163key 加解密往返一致，真实样本重加密**逐字节相同**
- 音频区 md5 在所有写入路径下**零变化**
- 幂等：重复写入哈希不变
- 保护目录 5 种绕过手法全被拦住

## 📦 下载

| 文件 | 说明 |
| --- | --- |
| `netease-163key-tagger-v0.3.0.exe` | Windows 单文件版，双击即用 |
| `checksums.txt` | SHA256 校验和 |

校验：

```powershell
Get-FileHash .\netease-163key-tagger-v0.3.0.exe -Algorithm SHA256
```

## ⚠️ 老规矩

- 本工具**只写标签**，不会伪造网易云的下载记录。
- 客户端认成「已下载」需要三个条件同时成立：文件里有 163key **且** 文件在客户端的下载根目录里 **且** 客户端触发过一次扫描。
- 自用随便用，商用/二次分发请遵守各平台条款。
