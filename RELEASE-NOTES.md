# v0.3.0

## 📦 下载哪个？

这次提供**两个版本，功能完全一样**，区别只是「装不装进系统」：

| 文件 | 适合谁 | 说明 |
| --- | --- | --- |
| `netease-163key-tagger-v0.3.0.exe` | 偶尔用、想随身带 | **单文件版**，绿色免安装，双击即用，不需要装 Node.js |
| `netease-163key-tagger-setup-v0.3.0.exe` | 经常用、想在命令行直接敲 | **安装版**，装到固定目录并登记进 PATH，带标准卸载项 |
| `checksums.txt` | — | 上面两个文件的 SHA256 |

```powershell
Get-FileHash .\netease-163key-tagger-setup-v0.3.0.exe -Algorithm SHA256
```

---

## 🎉 单文件版：双击就用

- 内嵌完整 Node 运行时（88.9 MB），**目标机器不用装 Node.js**
- 首次启动会把内置资源释放到 `%TEMP%`，第二次启动直接秒开
- 端口自动挑空闲的，不会跟别的服务撞
- 配置和报告固定在 `%USERPROFILE%\.netease-163key-tagger`，挪动 exe 也不会丢
- 不想要了：删掉 exe 和那个目录就干净了

## 🆕 安装版：装进 PATH，命令行直接敲

双击 `...-setup-...exe` → 点「安装」。它会：

1. 装到 `C:\Program Files\netease-163key-tagger\`（约 89 MB，安装包 lzma2 压到 23.3 MB）
2. 把这个目录登记进**系统** PATH
3. 在「设置 → 应用 → 已安装的应用」里登记标准卸载项，附带开始菜单快捷方式

因为要写 Program Files 和系统 PATH，**安装时会弹一次 UAC 要管理员权限**（跟隔壁的 `gacha-link-fetcher` 一样）。向导里可以选是否加 PATH、是否建桌面快捷方式、装完是否立刻启动。

装完开个新终端，任何目录都能用：

```powershell
netease-163key-tagger                 # 启动网页界面
netease-163key-tagger scan            # 扫描音乐目录
netease-163key-tagger match           # 联网匹配
netease-163key-tagger apply --write   # 写入标签
netease-163key-tagger verify          # 校验结果
```

**命令行的 `--cli` 前缀不用写了**——不带参数是界面，带 `scan` / `match` / `apply` / `verify` / `self-test` 就是命令行。敲错了会打印用法，而不是默默起一个服务挂着。

<details>
<summary>关于 PATH 的三句实话</summary>

改的是 `HKLM\...\Session Manager\Environment` 的 `Path`（**系统级**）。三个实测过的细节：

- 读的时候是**原样读**的，PATH 里原有的 `%SystemRoot%\system32` 这类变量引用**不会被展开**
- `ValueType: expandsz` + `preservestringtype`，值类型仍是 `REG_EXPAND_SZ`，不会降级成 `REG_SZ`
- 安装前先查重，已经在 PATH 里就不重复添加

卸载时 Inno 会按日志把 `Path` 还原，脚本里另有一道兜底 —— **装一次再卸一次，PATH 逐字节回到原样**。

</details>

<details>
<summary>静默安装 / 自定义目录 / 静默卸载</summary>

```powershell
# 静默安装（默认会加 PATH）
.\netease-163key-tagger-setup-v0.3.0.exe /VERYSILENT /SUPPRESSMSGBOXES /NORESTART

# 指定目录
.\netease-163key-tagger-setup-v0.3.0.exe /VERYSILENT /DIR="D:\Tools\163key"

# 不要加 PATH
.\netease-163key-tagger-setup-v0.3.0.exe /VERYSILENT /TASKS=""

# 静默卸载
"C:\Program Files\netease-163key-tagger\unins000.exe" /VERYSILENT /SUPPRESSMSGBOXES /NORESTART
```

安装日志在 `%TEMP%\Setup Log *.txt`。

</details>

---

## 🆕 搜索并对比面板

复核时不用瞎猜了。搜索框支持三种输入：歌名/歌手关键词、纯数字歌曲 ID、网易云分享链接。

结果是一张张卡片，每张都带：

- **专辑封面**（网易云原图）
- **「UGC 冒充」/「会员」/「曲库正版」徽章** —— 一眼分出哪个是假歌
- **接口时长 vs 本地时长 vs Δ 差值**，绿/黄/红三色标注

排序**不自己造**，直接用引擎的 `pickBest()` 打分——因为按「时长接近」排会把翻唱排到原唱前面（这个坑踩过一次，UI 层不能再踩一遍）。

还有「批量挑选待复核项」，按引擎分把待复核的文件批量定下来，执行前先给你看方案。

## 🆕 顺带改写文件信息（可选，默认关闭）

写 163key 的同时，可以顺手把文件里的标题 / 歌手 / 专辑改成曲库正版信息，并嵌入专辑封面。

- FLAC → Vorbis `DESCRIPTION` + `PICTURE` 块
- MP3 → ID3 `TIT2`/`TPE1`/`TALB` + `APIC`
- **音频区一个字节都不动**（自测逐字节校验 md5）
- **幂等**：重复写多次文件哈希不变

命令行用 `--meta` / `--cover`。

## 🐛 修掉的问题

- **FLAC 封面只删不插** —— 重写封面时旧 PICTURE 块被删掉却不插入新的，封面直接消失
- **FLAC 不幂等** —— 连续写两次字段顺序会变，文件哈希一直抖
- **只读最后一个 COMM** —— 客户端其实读标签里最后一个 COMM，之前写成「key 在前、空 COMM 在后」就认不到
- **`/api/choose` 撤销复核报「参数不对」** —— clear 分支被 musicId 校验挡住了
- **前端显示 `[object Object]`** —— 歌手和专辑对象没拆开

## ✅ 自测

212 条断言全绿（tags 77 + match 61 + meta 24 + e2e 50）：

- 163key 加解密往返一致，真实样本重加密**逐字节相同**
- 音频区 md5 在所有写入路径下**零变化**
- 幂等：重复写入哈希不变
- 保护目录 5 种绕过手法全被拦住

安装包另外做过实机验证：静默安装到 Program Files、系统 PATH 里 `%SystemRoot%` 的变量引用没被展开、装好的命令能跑通 `self-test`、静默卸载后 PATH **352 → 352 逐字节还原**、目录和快捷方式都清干净。

## ⚠️ 老规矩

- 本工具**只写标签**，不下载音乐，不破解付费内容，只改你自己磁盘上文件的标签
- 客户端认成「已下载」需要三个条件同时成立：文件里有 163key **且** 文件在客户端的下载根目录里 **且** 客户端触发过一次扫描
- 接口为逆向所得，服务端变更时可能需要更新
