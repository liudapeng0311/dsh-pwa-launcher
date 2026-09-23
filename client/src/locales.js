/**
 * launcher 控件的中英文案。
 *
 * 键集以 zh 为准，en 必须键完全一致 —— dsh 的 locale 注册要求两个字典同键，
 * 少一个键在英文界面下就是一个空白按钮。
 *
 * `{...}` 是插值占位符，由 dsh 的 t() 负责替换（open-in-app 的 "open.title" 同款用法）。
 */

/** 本插件拥有的词典命名空间。 */
export const NS = 'pwa-launcher'

/** 简体中文（键集的事实来源）。 */
export const zh = {
  // —— 重启按钮 ——
  'restart.label': '重启',
  'restart.title': '重启整个 DeepSeek Harness：停止当前进程（含正在运行的任务/会话）并重新拉起，本页面会自动重连',
  'restart.confirm': '重启整个 DeepSeek Harness？\n\n这会彻底停止当前进程（包括正在运行的任务/会话），然后自动重新拉起并刷新本页。',
  'restart.calling': '重启中…',

  // —— 版本按钮 ——
  'update.checking': '检查…',
  'update.checking.title': '正在检查 DeepSeek Harness 新版本…',
  'update.available': '↑ 有新版 {version}',
  'update.available.apply': '发现新版本 {version}（当前 {current}）。\n\n点一下立即升级：会停掉当前服务、自动安装并重启，失败自动回滚到 {current}。',
  'update.available.manual': '发现新版本 {version}（当前 {current}）。\n\n当前部署关闭了自助更新（allowSelfUpdate=false），所以这里只提醒。点一下重新检查。',
  'update.confirm': '升级到 {version}？\n\n当前版本 {current}。这会停止 DeepSeek Harness（含正在运行的任务/会话），自动安装新版本并重启；\n\n安装或校验失败会自动回滚到 {current}。',
  'update.latest': '✓ 已是最新',
  'update.latest.title': '当前 {current}，已是最新。点一下重新检查。',
  'update.ignored': '已忽略 {count}',
  'update.ignored.title': '有 {count} 个新版本在忽略名单里。点一下重新检查；要恢复提醒就删掉 %LOCALAPPDATA%\\DeepSeekHarness\\update-dismiss.json。',
  'update.error': '未查到',
  'update.error.title': '这次没查到更新：{reason}\n多半是网络抖动（离线 / 超时 / 被墙）。点一下再试。',

  // —— 通道标签（候选列表里用）——
  'channel.latest': '推荐通道',
  'channel.next': '候选通道',
  'channel.alpha': '前沿通道',
  'channel.other': '未知通道',

  // —— 选版卡 ——
  'pick.title': '升级到哪个版本？',
  'pick.current': '当前版本 {current}。下面是这次查到的全部较新版本，按通道从保守到激进排列。',
  'pick.chosen': '已选',
  'pick.ignored': '曾忽略',
  'pick.ignoredNote': '「曾忽略」只表示你之前把它的提醒关掉了，不影响这次安装；装完之后提醒会自动恢复。',
  'pick.confirm': '升级到 {version}',
  'pick.cancel': '取消',
  'pick.caveat': '预发布版本（rc / alpha）可能不稳定。升级会停掉当前服务，失败会自动回滚。',

  // —— 重启 / 升级的进度卡 ——
  'action.restart.title': '正在重启 DeepSeek Harness',
  'action.upgrade.title': '正在升级到 {version}',
  'action.calling': '已发出请求，正在等待服务退出…',
  'action.waiting': '服务正在重启，就绪后本页会自动重连。',
  'action.reconnecting': '新进程已就绪，正在重连…',
  'action.failed.title': '操作没能完成',
  'action.timeout': '新服务没能在预期时间内就绪。请双击桌面图标重启，或查看启动器日志（%LOCALAPPDATA%\\DeepSeekHarness\\logs）。',
  'action.unauthorized': '登录状态已失效。请关闭本窗口，用桌面图标重新打开一次 Harness。',
  'action.offline': '无法联系本地服务。请双击桌面图标重启。',
  'action.server': '服务拒绝了这次请求：{reason}',
  'action.dismiss': '知道了'
}

/** English dictionary, key-identical to the Chinese source of truth. */
export const en = {
  // —— Restart ——
  'restart.label': 'Restart',
  'restart.title': 'Restart the whole DeepSeek Harness: stop this process (running tasks/sessions included) and start it again; this page reconnects automatically',
  'restart.confirm': 'Restart the whole DeepSeek Harness?\n\nThis stops the current process (running tasks/sessions included), starts it again, and reloads this page.',
  'restart.calling': 'Restarting…',

  // —— Version ——
  'update.checking': 'Checking…',
  'update.checking.title': 'Checking for a newer DeepSeek Harness…',
  'update.available': '↑ {version} available',
  'update.available.apply': 'Version {version} is available (current {current}).\n\nClick to upgrade now: the service stops, the new version installs, and it restarts; a failed install rolls back to {current}.',
  'update.available.manual': 'Version {version} is available (current {current}).\n\nSelf-update is disabled in this deployment (allowSelfUpdate=false), so this is a notice only. Click to re-check.',
  'update.confirm': 'Upgrade to {version}?\n\nCurrent version {current}. This stops DeepSeek Harness (running tasks/sessions included), installs the new version, and restarts.\n\nA failed install or verification rolls back to {current}.',
  'update.latest': '✓ Up to date',
  'update.latest.title': 'Current {current}, up to date. Click to re-check.',
  'update.ignored': '{count} ignored',
  'update.ignored.title': '{count} newer versions are on the ignore list. Click to re-check; to restore the notices, delete %LOCALAPPDATA%\\DeepSeekHarness\\update-dismiss.json.',
  'update.error': 'Unknown',
  'update.error.title': 'This check found nothing: {reason}\nUsually a network hiccup (offline / timeout / blocked). Click to try again.',

  // —— Channel labels (used by the candidate list) ——
  'channel.latest': 'recommended channel',
  'channel.next': 'candidate channel',
  'channel.alpha': 'bleeding-edge channel',
  'channel.other': 'unknown channel',

  // —— Version picker ——
  'pick.title': 'Which version do you want?',
  'pick.current': 'Current version {current}. These are all the newer versions this check found, ordered from most conservative channel to most aggressive.',
  'pick.chosen': 'selected',
  'pick.ignored': 'previously ignored',
  'pick.ignoredNote': '“Previously ignored” only means you muted its notice earlier; it does not block this install, and the notice comes back once you are on that version.',
  'pick.confirm': 'Upgrade to {version}',
  'pick.cancel': 'Cancel',
  'pick.caveat': 'Prerelease versions (rc / alpha) may be unstable. Upgrading stops the current service; a failure rolls back automatically.',

  // —— Restart / upgrade progress card ——
  'action.restart.title': 'Restarting DeepSeek Harness',
  'action.upgrade.title': 'Upgrading to {version}',
  'action.calling': 'Request sent; waiting for the service to exit…',
  'action.waiting': 'The service is restarting; this page reconnects once it is ready.',
  'action.reconnecting': 'The new process is ready; reconnecting…',
  'action.failed.title': 'The operation did not finish',
  'action.timeout': 'The new service did not become ready in time. Restart from the desktop icon, or check the launcher log (%LOCALAPPDATA%\\DeepSeekHarness\\logs).',
  'action.unauthorized': 'The session expired. Close this window and open Harness again from the desktop icon.',
  'action.offline': 'Cannot reach the local service. Restart from the desktop icon.',
  'action.server': 'The service refused the request: {reason}',
  'action.dismiss': 'Dismiss'
}
