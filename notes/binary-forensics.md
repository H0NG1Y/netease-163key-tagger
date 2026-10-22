# 客户端二进制取证（Lead）

对象：`C:\Program Files\Netease\CloudMusic\cloudmusic.dll`（36.0 MB）
方法：原样字节搜索 + 上下文 dump。脚本在 `out/scratch/find-flac-field.mjs`、`out/scratch/dump-tag-strings.mjs`，可直接复跑。

## 1. 163key 算法被官方二进制直接确认 ✅

偏移 `@27273550`–`@27273770`（**同一个字符串块，顺序紧邻**）：

```
Error: getid3content: AES_decrypt length not in multiple of AES_BLOCK_SIZE!
Error: getid3content: AES_set_decrypt_key error!
163 key(Don't modify):
#14ljk_!\]&0U<'(
Error: addid3content: AES_set_encrypt_key error!
)(13daqP@ssw0rd~
```

- `163 key(Don't modify):` 与密钥 `#14ljk_!\]&0U<'(` **字面相邻**，证明我们推导的
  `"163 key(Don't modify):" + base64(AES-128-ECB("music:"+json))`、key = `#14ljk_!\]&0U<'(` 完全正确。
- 函数名就叫 `getid3content` / `addid3content`，且是**通用**的读写媒体标签入口（`addid3content write media tag:`），
  没有独立的 `addflaccontent`。参数名是 `commstr`（comment string）——即「把 163key 当注释串写进去」。
- 另有 `)(13daqP@ssw0rd~` 这个口令串（用途未证实，可能是 ncm 或本地库加密，**与 163key 无关**，不要混用）。
- `AES_decrypt length not in multiple of AES_BLOCK_SIZE` 说明客户端只做裸 AES-ECB，没有额外校验/签名 → **可自由伪造**。

## 2. FLAC 的 Vorbis 字段名：仍是推断，但推断依据变强了 ⚠️

**没有**任何 `addflaccontent` / `flaccontent` / `setflac` 字面量（搜过，0 命中）。
客户端用的是 **TagLib**（`@30671228` 有 `fLaC`、`FLAC::File::scan() -- FLAC stream not found`、
`FLAC::File::scan() -- multiple Vorbis Comment blocks found`、`FLAC::Properties::read()`、
`@30673600` 有 `Vorbis::File::read() - Could not find the Vorbis comment header.`）。

`@30663396`–`@30664200` 是 TagLib 的帧名映射表（`PERFORMER:` `COMMENT:` `LYRICS:` `URL:` 带冒号的用户帧，
以及 `COMMENT` `ALBUM` `TBPM` `BPM` `COMPOSER` `GENRE` `TCOP` `TDRC` `TRACKNUM` … 标准帧）。

推论：`addid3content` 走 TagLib 的高层 API（`setComment(commstr)`）。

### ⚠️ 更正：我一开始从这里推出「字段名 = COMMENT」，这个推断是错的

我当时的理由是「TagLib 把 Vorbis `COMMENT` 当作 comment 的标准字段」。
实际去查 TagLib 的行为后推翻了这个推断：

- `Ogg::XiphComment::comment()` **先取 `DESCRIPTION`，非空即返回；为空才回退 `COMMENT`**，
  `setComment()` 对称地以 `DESCRIPTION` 为主。TagLib 之所以还认 `COMMENT`，
  是为了兼容历史上写坏的文件（2015 年 Tsuda Kageyu 有个专门提交
  "Fix XiphComment::setComment() for the case that a Vorbis comment has the 'COMMENT' field"）。
- Vorbis comment 规范里「注释」的规范字段名就是 `DESCRIPTION`；`COMMENT` 是非规范写法。
  旁证：SFBAudioEngine issue #370 明确说 "the canonical name for a comment in a Vorbis comment field is DESCRIPTION"。
- 社区事实标准 163marker（136★）对 FLAC 走 mutagen 的 `audio['description']`，MP3 才走 COMM 帧。

**结论**：`lib/tags.mjs` 的主字段已从 `COMMENT` 改为 `DESCRIPTION`（`DEFAULT_FLAC_FIELD`），
同时默认补写一份 `COMMENT` 副本（`FLAC_COMPAT_FIELD`）以兼容按精确字段名取值的实现。
读取端本来就不挑字段名（只要值里含 `TAG_PREFIX` 就认），两条路都能读回。

**仍未实证的部分**（如实标注）：本机 57 个文件 + 全盘 969 个音频里，
没有一个「由网易云客户端自己写出的、带 163key 的真实 FLAC/ogg」样本
（6 个 Minecraft ogg 只是字段名旁证，不是客户端产物）。
所以「客户端读 FLAC 时确实走 TagLib 的 comment()」是**推断**，不是实测。
保留 `--flac-field` 可切换正是为此。

## 3. 额外的重大线索：客户端有自己的「已下载」索引 🔍

`@29439196`–`@29440156` 一片字符串：

```
storage.ongettempfile … addid3content param in: / waraning commstr is empty / mip:
addid3content No Find Pic: / addid3content encrypt error / addid3content write media tag:
.ntmediatmp … addid3content Move error IN: / WriteMediaTag error IN: / MoveMediaFile error IN:
addid3content failed failed. , result: … addid3content, id:
storage.onaddid3done … Storage::AddID3, id: … media_rel_path … image_rel_path … extension
encrypt / decrypt , decrypt: , encrypt: , pic_path: … Storage::AddID3, start, path:
but actual download dir is … DownloadScan: sanner dir is …
```

含义：下载完成后客户端做的是「**写标签 → 原子改名（.ntmediatmp → 正式文件）→
`Storage::AddID3(id, media_rel_path, image_rel_path, extension, …)` 写进自己的本地索引**」。

=> 客户端判断「已下载」很可能**不只看标签，还看这个本地索引**（`Storage`）。
沙箱里找不到这个索引的落盘位置，需要 client-behavior 去定位
（候选：`%LOCALAPPDATA%\Netease\CloudMusic\`、`%APPDATA%\Netease\` 下的 db/webdata）。
这决定了最终交付能不能真的让客户端「认成已下载」。

## 4. 服务端匹配接口（备选路线，已被我放弃）

`@27248774`：`/music/audio/match`、`clientSign`、`requestId`、`pc_back_discern`、`decrypt`
`@27294925`：`http://music.163.com/api/music/matcher`、`&clientType=pc`、`.ncm .aac .flac .m4a .mp3 .og…`

即客户端有「上传音频指纹 → 服务端返回匹配结果」的云匹配接口。我们**不走**这条：
它需要登录态 + device id 签名（`clientSign`/`encrypt_device_id`），
而且用文件名+歌手搜索已经能正确命中（真实样本 Jackie 那首一次命中 id=1809412694）。
记录在此，仅作为「自动匹配结果与官方云匹配不一致」时的排查线索。
