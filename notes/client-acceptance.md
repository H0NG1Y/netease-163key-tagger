# 客户端「已下载 / 本地音乐匹配」实机验收结果

> 状态：**已闭合**（2026-10-22，用户本机实跑）
> 取证方式：全程只读客户端数据库副本，未修改客户端任何文件。

## 1. 结论

条件齐备后，**两条链路同时成立**：

| 客户端里的现象 | 数据落点 | 实测结果 |
|---|---|---|
| 「本地音乐」里匹配上曲库歌曲 | `library.dat` → `track.tid` / `track.aid` | 53 个带 key 的文件中 **52 个 tid 被填成真实 songId** |
| 「已下载」列表里出现这些歌 | `webdb.dat` → `offlineTrack` | **0 行 → 52 行**，全部 `state=4` |

**关键一致性**：`163key` 明文里的 `musicId` 与客户端 `library.dat.track.tid`
**52/52 完全相同**。这说明客户端确实是把标签里的 musicId 直接当作歌曲身份用的，
不存在「客户端另算了一套 id」的情况。

## 2. 天然对照组（最有说服力的部分）

同一批文件、同一个目录，唯一的差别是**有没有写 key**：

| 分组 | 文件数 | `library.dat.tid` 非空 | 进 `offlineTrack` |
|---|---|---|---|
| 带 163key | 53 | 52 | 52 |
| **不带 163key** | 4 | **0** | **0** |

4 个对照文件：

- `周杰伦 - 一路向北.flac`
- `周杰伦 - 一路向北.mp3`
- `磨尖的粉笔 - 我只能离开.mp3`
- `艾比利 - 一个人想着一个人 (说唱版).flac`

它们都在同一个目录里、都被客户端扫到过（`library.dat` 里有行），但 `tid` 为空、
`offlineTrack` 里没有 —— 因为目录扫描拿不到 `comment` 就直接 `continue` 了。

## 3. 唯一的一个例外，以及它暴露出的写入缺陷

53 个带 key 的文件里有 1 个没被认出：

`G-DRAGON,TAEYANG,DAESUNG - HOME SWEET HOME (feat. TAEYANG & DAESUNG).mp3`

逐帧对比后找到原因 —— 它的 ID3 里有**两个 COMM 帧**：

```
成功（POWER.mp3）              失败（HOME SWEET HOME.mp3）
  COMM  ← 163key                APIC
  TIT2                          TYER
  TPE1                          COMM  ← 163key
  TALB                          COMM  ← 空（lang=eng）
  APIC                          TCON / TALB / TIT2 / TPE1
```

**客户端读的是最后一个 COMM 帧**，而这个文件里 key 排在空 COMM 前面，
于是客户端读到一个空串 → 无冒号 → 放弃。

交叉表（`out/scratch/probe-carrier-slots.mjs`）：

| 承载帧结构 | 文件数 | 客户端认出 |
|---|---|---|
| 单个 COMM 且含 key | 10 | **10 / 10** |
| 两个 COMM（key 在前 + 空在后） | 1 | **0 / 1** |
| FLAC 双写 DESCRIPTION + COMMENT（都含 key） | 42 | 42 / 42 |
| 完全没有 key | 4 | 0 / 4 |

### 修复

`lib/tags.mjs` 新增 `placeAsLastComm()` / `isLastComm()`：写入时把承载 163key 的
`COMM` 帧移到**所有 COMM 帧之后**，不删除用户原有的注释帧。

- 回归测试：`test/tags.selftest.mjs` 的 **T8**（人为构造「空 COMM 在前」的标签，
  断言写入后 key 落在最后一个 COMM、原空 COMM 不被覆盖、音频字节不变）。
- 历史版本写出的文件重跑一次写入即可自动校正（`noop` 判定已带上位置检查，
  位置不合法会强制重写）。

## 4. 复验命令

```bash
# 客户端数据库只读交叉核对：library.dat × offlineTrack × 文件里的 163key
node out/scratch/probe-match-cross.mjs

# musicId 与 tid 逐条比对
node out/scratch/probe-tid-vs-key.mjs

# 承载帧数量 × 是否被认出 的交叉表
node out/scratch/probe-carrier-slots.mjs
```

界面里的「客户端检查」做的是同一件事（只读 `webdb.dat.offlineTrack` 行数），
不需要命令行。

## 5. 仍然未定位的细节

`startScanDownload` 的**触发时机**（启动时 / 打开下载管理时 / 改下载目录后）仍未定位。
本次实验里客户端是自然启动后就扫到了，因此「重启客户端即可」是一条可用经验，
但不是从代码里证明出来的。若遇到放进去没反应，先完整退出客户端（含托盘）再启动。

## 6. 不要做的事

- **不要**手写 `webdb.dat` 的 `offlineTrack` 表。库里 `state` 是 JSON 序列化字符串、
  非主键字段走 `jsonStr`，伪造库比写标签危险得多，且没有意义 —— 写对标签客户端自己会建行。
- 不要改客户端安装目录里的任何文件。
- 验收时对 `webdb.dat` 只读（复制一份再开 `node:sqlite`）。
