/**
 * paths.mjs —— 定位「系统自带的音乐文件夹」。
 *
 * 用来当默认音乐目录，省得用户手打一长串路径。
 *
 * 为什么不用注册表里的 My Music：
 *   Windows 上「音乐」这个已知文件夹的物理路径默认就是 %USERPROFILE%\Music——
 *   中文系统里显示名是「音乐」，但真实目录名仍然是 Music。
 *   而 `reg.exe` 的输出走 OEM 代码页，用户名带中文时解码反而更容易出错；
 *   `os.homedir()` 是 Node 直接从系统 API 拿的，编码永远是对的。
 *   用户真把音乐夹搬到别的盘了，在设置里改一次就行（会存进 .config.json）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 系统音乐文件夹的绝对路径。
 * 优先取环境变量 NETEASE_163KEY_MUSIC_DIR（方便测试和自定义），
 * 否则用 %USERPROFILE%\Music。
 */
export function systemMusicDir() {
  const env = process.env.NETEASE_163KEY_MUSIC_DIR;
  if (env && env.trim()) return path.resolve(env.trim());
  return path.join(os.homedir(), 'Music');
}

/** 目录存在才返回，否则返回 null——给「猜猜音乐库在哪」这类场景用 */
export function existingMusicDir() {
  const dir = systemMusicDir();
  try {
    return fs.statSync(dir).isDirectory() ? dir : null;
  } catch {
    return null;
  }
}
