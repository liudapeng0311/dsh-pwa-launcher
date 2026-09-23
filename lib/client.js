// 本文件由 client/build.mjs 从 client/src/*.js 生成 —— 不要手改。
// 改源文件后跑：node client/build.mjs
window.__ModuleLoader__.load({
	id: "dsh-pwa-launcher",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let React = require("react").default;

		//#region client/src/locales.js
/**
 * launcher 控件的中英文案。
 *
 * 键集以 zh 为准，en 必须键完全一致 —— dsh 的 locale 注册要求两个字典同键，
 * 少一个键在英文界面下就是一个空白按钮。
 *
 * `{...}` 是插值占位符，由 dsh 的 t() 负责替换（open-in-app 的 "open.title" 同款用法）。
 */

/** 本插件拥有的词典命名空间。 */
const NS = 'pwa-launcher'

/** 简体中文（键集的事实来源）。 */
const zh = {
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
const en = {
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

		//#region client/src/LauncherController.js
/**
 * launcher 控件的浏览器侧状态机。
 *
 * 一个页面一份（插件 apply 时 new），因为「重启」「升级」「更新状态」都是进程级的、
 * 不是会话级的 —— 每个会话头部各拿一份只会重复轮询。
 *
 * 这里只负责状态与网络；DOM 和文案在 LauncherControls.js 里。
 * 三个宿主路由本来就在（原来给右上角悬浮控件用），这里直接复用，没有新增接口：
 *   POST /pwa-launcher/restart         外部重启
 *   GET  /pwa-launcher/restart-status  新进程起来了没有
 *   GET  /pwa-launcher/update-check    后台那次版本检查的结果
 *   POST /pwa-launcher/update-apply    外部升级（停服务→安装→校验→重启，失败回滚）
 */

/** 重启/升级轮询间隔。宿主冷启动实测要 60s+，间隔别太激进、超时要够长。 */
const RESTART_POLL_MS = 700
/** 重启/升级总超时。升级还要下载安装包，所以给得比重启更宽。 */
const RESTART_TIMEOUT_MS = 180000
const UPDATE_TIMEOUT_MS = 600000
/** 更新状态自动重试：服务刚启动时后台那次检查可能还没跑完。 */
const UPDATE_RETRY_MS = 4000
const UPDATE_RETRY_LIMIT = 15

/** 重启后的重连延迟：新进程报 ready 之后稍等一下再跳，避免撞上它还没完全就绪的瞬间。 */
const RECONNECT_DELAY_MS = 300

/**
 * 读本次页面所属进程的指纹。
 *
 * 宿主在 index.html 里注入的启动脚本会把它挂在 window 上（重启握手用的就是它）。
 * 读不到就退化成 null，那样第一个轮询响应会被当成「基准」而不是「新进程」，
 * 只是多等一拍。
 */
function currentNonce() {
  const value = globalThis.__DSH_DL_NONCE__
  return typeof value === 'string' && value.length > 0 ? value : null
}

/** 同源 JSON GET/POST。宿主路由要求带 cookie（credentials: same-origin）。 */
async function requestJson(path, init) {
  const response = await fetch(path, {
    credentials: 'same-origin',
    headers: { accept: 'application/json' },
    ...init
  })
  if (response.status === 401) throw Object.assign(new Error('unauthorized'), { code: 'unauthorized' })
  if (!response.ok) {
    // 宿主拒绝时会带一句人话（比如「只能更新到已检测到的候选版本」）。
    // 早先只抛 HTTP 状态码，把那句理由丢了，失败卡片上就只剩一个光秃秃的 403。
    let detail = ''
    try {
      const body = await response.json()
      if (body && typeof body.error === 'string') detail = body.error
    } catch {
      // 响应不是 JSON（或已断），退回到只有状态码。
    }
    throw new Error(detail ? `HTTP ${response.status}：${detail}` : `HTTP ${response.status}`)
  }
  return response.json()
}

/**
 * 一个页面一份的 launcher 控制器。
 *
 * 状态源各自独立：
 *   update  —— 版本检查结果（宿主后台已经在跑，这里只是取回来）
 *   action  —— 正在进行的手势：null / 'select'（在挑版本）/ 'restart' / 'upgrade'
 *   phase   —— 该手势推进到哪一步
 *
 * 'select' 是个**不忙**的手势：它只是把候选版本摆出来等用户点，期间按钮照常可点，
 * 所以 busy 不含 select。
 */
class LauncherController {
  constructor() {
    /** 更新检查快照，形状同宿主 GET /pwa-launcher/update-check 的响应。 */
    this.update = { status: 'idle' }
    /** 正在进行的手势：null = 空闲。 */
    this.action = null
    /** idle → select（挑版本）→ calling（已发出请求）→ waiting → reconnecting；或 timeout/error */
    this.phase = 'idle'
    /** 出错时的定性：'offline' | 'unauthorized' | 'timeout' | 'server' */
    this.failure = null
    /** 服务端返回的错误正文（有的话），用于把失败原因说清楚。 */
    this.failureDetail = null
    /** 挑版本阶段里当前选中的版本号（仅 phase === 'select' 时有意义）。 */
    this.selectedVersion = null
    /** 这次动作要等多久算超时。 */
    this.timeoutMs = RESTART_TIMEOUT_MS

    this.updateListeners = new Set()
    this.actionListeners = new Set()

    this.updateRetries = 0
    this.pollTimer = undefined
    this.retryTimer = undefined
    this.reconnectTimer = undefined
    this.startedAt = 0
    /**
     * 代次。每发起一次新动作就 +1，所有异步回调都带着自己那一代的号回来。
     *
     * 没有它就会出现这个错：一次重启超时/失败后用户又点一次，上一轮那个还在飞的
     * 轮询（或已经发出、刚被拒的请求）后脚返回，把**新**动作的状态覆盖成旧结论
     * ——新重启刚进入 calling 就被打回 waiting，甚至直接被打成 error。
     */
    this.generation = 0

    this.knownNonce = currentNonce()
    this.sawRestarting = false
    this.disposed = false
  }

  // ---------------------------------------------------------------- 订阅

  onUpdate(listener) {
    this.updateListeners.add(listener)
    return () => this.updateListeners.delete(listener)
  }

  onAction(listener) {
    this.actionListeners.add(listener)
    return () => this.actionListeners.delete(listener)
  }

  emitUpdate() {
    for (const listener of [...this.updateListeners]) listener(this.update)
  }

  emitAction() {
    const snapshot = this.actionSnapshot()
    for (const listener of [...this.actionListeners]) listener(snapshot)
  }

  /** 一次动作的完整快照。控制器内部用字段、组件读这一份。 */
  actionSnapshot() {
    return {
      action: this.action,
      phase: this.phase,
      failure: this.failure,
      detail: this.failureDetail,
      selected: this.selectedVersion
    }
  }

  setUpdate(next) {
    this.update = next
    this.emitUpdate()
  }

  /** 改动作状态。字段没变就不通知（否则每次轮询都会重渲染）。 */
  setAction(action, phase, failure = null, detail = null) {
    const changed = this.action !== action || this.phase !== phase ||
      this.failure !== failure || this.failureDetail !== detail
    this.action = action
    this.phase = phase
    this.failure = failure
    this.failureDetail = detail
    if (changed) this.emitAction()
  }

  /**
   * 这个手势是不是还在推进中（按钮据此禁用）。
   *
   * 注意 'select' 不算忙：那只是把候选摆出来等用户点，期间重启按钮、重新检查都该照常可用。
   */
  get busy() {
    return this.phase === 'calling' || this.phase === 'waiting' || this.phase === 'reconnecting'
  }

  /** 有没有得挑：候选里不止一个版本，或者唯一的那个还没被默认选中。 */
  get canChoose() {
    const newer = Array.isArray(this.update?.newer) ? this.update.newer : []
    return newer.length > 1
  }

  // ---------------------------------------------------------------- 更新

  /**
   * 取一次更新状态（不触发联网检查，读的是宿主后台那次的结果）。
   *
   * 服务刚起来时后台检查可能还没跑完，所以 status 是 idle/checking 时按
   * UPDATE_RETRY_MS 自己再取一次，取够 UPDATE_RETRY_LIMIT 次就放弃 ——
   * 没有这个兜底，按钮会永远停在「检查…」。
   */
  loadUpdate() {
    if (this.disposed) return Promise.resolve()
    return requestJson('/pwa-launcher/update-check')
      .then((data) => {
        if (this.disposed) return
        this.setUpdate(data)
        const pending = data?.status === 'idle' || data?.status === 'checking'
        if (pending && this.updateRetries < UPDATE_RETRY_LIMIT) {
          this.updateRetries += 1
          this.retryTimer = setTimeout(() => this.loadUpdate(), UPDATE_RETRY_MS)
        }
      })
      .catch((error) => {
        if (this.disposed) return
        this.setUpdate({ status: 'error', error: String(error?.message ?? error) })
      })
  }

  /** 手动「重新检查」：POST 会让宿主真去连一次 registry。 */
  recheck() {
    if (this.disposed) return Promise.resolve()
    if (this.retryTimer !== undefined) clearTimeout(this.retryTimer)
    this.updateRetries = 0
    this.setUpdate({ ...this.update, status: 'checking' })
    return requestJson('/pwa-launcher/update-check', { method: 'POST' })
      .then((data) => {
        if (!this.disposed) this.setUpdate(data)
      })
      .catch((error) => {
        if (!this.disposed) this.setUpdate({ ...this.update, status: 'error', error: String(error?.message ?? error) })
      })
  }

  // ---------------------------------------------------------------- 动作

  /** 触发一次完整重启，然后等新进程。 */
  restart() {
    if (!this.canStart()) return Promise.resolve()
    const generation = this.begin('restart', RESTART_TIMEOUT_MS)
    return requestJson('/pwa-launcher/restart', { method: 'POST' })
      .then(() => {
        if (this.stale(generation)) return
        this.setAction('restart', 'waiting')
        this.schedulePoll(generation)
      })
      .catch((error) => this.failFromRequest(generation, 'restart', error))
  }

  // ------------------------------------------------------------ 挑版本

  /**
   * 打开选版卡。
   *
   * 默认选中「宿主推荐的那个」（update.target，也就是最保守通道里最新的那个）——
   * 大多数情况下用户直接确认就行，想换就换。
   *
   * @param preferred - 想预选的版本号；不合法或不在候选里就退回 target。
   * @returns 是否真的打开了。
   */
  openPicker(preferred = null) {
    if (!this.canStart()) return false
    const newer = Array.isArray(this.update?.newer) ? this.update.newer : []
    if (newer.length === 0) return false
    const target = typeof this.update?.target === 'string' ? this.update.target : null
    const wanted = typeof preferred === 'string' && newer.some((n) => n.version === preferred) ? preferred : target
    this.selectedVersion = wanted ?? newer[0].version
    this.setAction('select', 'select', null, this.selectedVersion)
    return true
  }

  /**
   * 在选版卡里切换选中项。
   *
   * ⚠️ 候选必须**当场从 update.newer 里查**，不能用快照里的旧列表：
   * 这张卡开着的时候后台可能又重查了一次，旧的被忽略清单会让服务端的白名单
   * 跟界面对不上 —— 表现就是「明明选了个版本，点升级却报 400」。
   *
   * @param version - 候选版本号。
   * @returns 是否接受这次选择。
   */
  selectVersion(version) {
    if (this.phase !== 'select') return false
    if (typeof version !== 'string') return false
    const newer = Array.isArray(this.update?.newer) ? this.update.newer : []
    if (!newer.some((n) => n.version === version)) return false
    if (this.selectedVersion === version) return true
    this.selectedVersion = version
    this.setAction('select', 'select', null, version)
    return true
  }

  /**
   * 确认选版卡：升级到当前选中的版本。
   *
   * @returns 真正发起的升级请求的 promise（没得升时是一个已 resolve 的空 promise）。
   */
  confirmSelection() {
    if (this.phase !== 'select') return Promise.resolve()
    const version = this.selectedVersion
    // 先回到空闲，再走一次完整的发起流程 —— 于是升级这一代的状态、超时、
    // 代次号都由 begin() 统一负责，这里不另开一条分支。
    this.setAction(null, 'idle')
    if (typeof version !== 'string' || version.length === 0) return Promise.resolve()
    return this.upgrade(version)
  }

  /** 关掉选版卡。 */
  cancelSelection() {
    if (this.phase !== 'select') return
    this.selectedVersion = null
    this.setAction(null, 'idle')
  }

  /**
   * 触发一次自助升级。
   *
   * 版本号要走服务端的白名单校验（它必须是宿主那次检查里出现过的候选），
   * 这里只负责把用户点的那个版本原样送过去。
   *
   * @param version - 目标版本号（来自候选列表）。
   */
  upgrade(version) {
    if (!this.canStart()) return Promise.resolve()
    if (typeof version !== 'string' || version.length === 0) return Promise.resolve()
    const generation = this.begin('upgrade', UPDATE_TIMEOUT_MS, version)
    return requestJson('/pwa-launcher/update-apply', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version })
    })
      .then(() => {
        if (this.stale(generation)) return
        this.setAction('upgrade', 'waiting', null, version)
        this.schedulePoll(generation)
      })
      .catch((error) => this.failFromRequest(generation, 'upgrade', error, version))
  }

  /**
   * 开一代新动作。
   *
   * @param action - 'restart' | 'upgrade'
   * @param timeoutMs - 这一代的超时。
   * @param detail - 动作附带的说明（升级就是目标版本号）。
   * @returns 这一代的号，后续回调拿它跟自己比。
   */
  begin(action, timeoutMs, detail = null) {
    this.generation += 1
    this.timeoutMs = timeoutMs
    this.sawRestarting = false
    this.startedAt = Date.now()
    // 上一代遗留的定时器必须停掉，否则它会带着旧代次号跑进来（会被 stale 挡住，
    // 但白跑一次网络请求没意义）。
    for (const timer of [this.pollTimer, this.reconnectTimer]) {
      if (timer !== undefined) clearTimeout(timer)
    }
    this.pollTimer = undefined
    this.reconnectTimer = undefined
    this.selectedVersion = null
    this.setAction(action, 'calling', null, detail)
    return this.generation
  }

  /** 这个回调是不是过期了（控制器已销毁，或用户又发起了新一代动作）。 */
  stale(generation) {
    return this.disposed || generation !== this.generation
  }

  /** 只有空闲、或上一次以失败告终时才允许发起新动作。 */
  canStart() {
    if (this.disposed) return false
    return this.phase === 'idle' || this.phase === 'timeout' || this.phase === 'error'
  }

  /** 请求本身失败（服务拒绝/连不上）——这和「轮询中暂时连不上」是两回事。 */
  failFromRequest(generation, action, error, detail = null) {
    if (this.stale(generation)) return
    const unauthorized = error?.code === 'unauthorized'
    const reason = unauthorized ? detail : String(error?.message ?? error)
    this.setAction(action, 'error', unauthorized ? 'unauthorized' : 'server', reason)
  }

  /** 用户主动收起失败提示，回到空闲。 */
  dismiss() {
    if (this.busy) return
    this.generation += 1
    this.setAction(null, 'idle')
  }

  schedulePoll(generation = this.generation) {
    if (this.stale(generation)) return
    this.pollTimer = setTimeout(() => this.poll(generation), RESTART_POLL_MS)
  }

  /**
   * 轮询到新进程接管。
   *
   * 就绪判据有两个，都必须满足：nonce 变了（换了进程）、phase 是 ready。
   * 只看 ready 不够 —— 命令刚发出时老进程还没退场，它也会答 ready，
   * 那样会在服务真正重启之前就刷新页面。
   *
   * @param generation - 发起这次轮询的那一代号。
   */
  poll(generation = this.generation) {
    if (this.stale(generation)) return
    if (Date.now() - this.startedAt > this.timeoutMs) {
      this.setAction(this.action, 'timeout', 'timeout', this.failureDetail)
      return
    }
    requestJson('/pwa-launcher/restart-status')
      .then((status) => {
        if (this.stale(generation)) return
        const nonce = typeof status?.nonce === 'string' ? status.nonce : null
        if (nonce !== null && nonce !== this.knownNonce && status?.phase === 'ready') {
          this.knownNonce = nonce
          this.setAction(this.action, 'reconnecting', null, this.failureDetail)
          const target = typeof status.authUrl === 'string' && status.authUrl.length > 0
            ? status.authUrl
            : globalThis.location.origin + '/'
          // 等一小拍再跳：新进程刚报 ready，立刻替换地址偶尔会撞上它还没准备好接客。
          this.reconnectTimer = setTimeout(() => {
            if (!this.stale(generation)) globalThis.location.replace(target)
          }, RECONNECT_DELAY_MS)
          return
        }
        if (status?.phase === 'restarting') this.sawRestarting = true
        this.setAction(this.action, 'waiting', null, this.failureDetail)
        this.schedulePoll(generation)
      })
      .catch(() => {
        if (this.stale(generation)) return
        // 连不上 = 老进程已停、新进程正在起。这是过程中的正常一档，不是错误。
        this.setAction(this.action, 'waiting', null, this.failureDetail)
        this.schedulePoll(generation)
      })
  }

  /**
   * 页面从后台回到前台时调一次。
   *
   * 浏览器在标签页不可见时会冻结定时器，轮询可能就此停住。这里把它重新踢起来，
   * 用户切回来就能继续收敛，而不是永远显示「启动中…」。
   */
  resume() {
    if (this.disposed) return
    if (!this.busy) return
    if (this.pollTimer !== undefined) clearTimeout(this.pollTimer)
    this.poll(this.generation)
  }

  dispose() {
    this.disposed = true
    for (const timer of [this.pollTimer, this.retryTimer, this.reconnectTimer]) {
      if (timer !== undefined) clearTimeout(timer)
    }
    this.updateListeners.clear()
    this.actionListeners.clear()
  }
}

		//#region client/src/LauncherControls.js
/**
 * 会话头部的 launcher 控件。
 *
 * 一个 28px 的胶囊，里面两个按钮：`⟳ 重启` 和版本按钮（有新版时点它就是升级）。
 *
 * 外观（高度、圆角、边框、hover、分段线）逐项对齐同一个 utilities 容器里
 * open-in-app 那个分裂按钮，这样两者并排时是同一视觉重量。
 *
 * 只依赖 React —— 平台的 UI 原语（Tooltip / Menu / 图标）虽然也能 require，
 * 但那些名字不在本包能核对的契约里，用它们等于把「按钮能不能画出来」赌在另一个
 * 包的内部导出上。提示用 title，进度用自己画的卡片，零耦合。
 */

/** 重启按钮的文案键（按阶段）。 */
const RESTART_LABEL = {
  idle: 'restart.label',
  calling: 'restart.calling',
  waiting: 'restart.waiting',
  reconnecting: 'restart.waiting',
  timeout: 'action.failed',
  error: 'action.failed'
}

/**
 * 把控制器接进 React。
 *
 * 控制器一页一份，所以用「订阅 + 取快照」。手写一份等价实现，
 * 省掉 require('react') 之外的任何东西。
 */
function useLauncher(controller) {
  const [snapshot, setSnapshot] = React.useState(() => ({
    update: controller.update,
    action: controller.actionSnapshot()
  }))

  React.useEffect(() => {
    setSnapshot({ update: controller.update, action: controller.actionSnapshot() })
    const offUpdate = controller.onUpdate((update) => {
      setSnapshot((previous) => ({ ...previous, update }))
    })
    const offAction = controller.onAction((action) => {
      setSnapshot((previous) => ({ ...previous, action }))
    })
    return () => {
      offUpdate()
      offAction()
    }
  }, [controller])

  return snapshot
}

/** update.newer 里每一项的通道 → 文案键。 */
const CHANNEL_LABEL = {
  latest: 'channel.latest',
  next: 'channel.next',
  alpha: 'channel.alpha'
}

/**
 * 选版卡：候选不止一个时，让用户自己挑升到哪个。
 *
 * 为什么必须给这个入口：宿主只推荐一个版本（最保守通道里最新的那个），
 * 但 newer 里可能同时有 rc 和 alpha。服务端的白名单校验认的是整个 newer 列表，
 * 所以「升 rc 而不是 alpha」本来是合法的，只是原来界面没给路。
 *
 * 用全屏卡而不是从胶囊弹出的浮层：胶囊带着 overflow:hidden，浮层会被裁掉，
 * 而且它贴在一个 28px 的行内控件旁边，定位很容易出洋相。
 *
 * @param props.versions - update.newer（按保守 → 激进排好）。
 * @param props.selected - 当前选中的版本号。
 * @param props.current - 当前安装的版本号。
 * @param props.onPick - 切换选中项。
 * @param props.onConfirm - 确认升级。
 * @param props.onCancel - 关掉卡片。
 * @param props.t - 翻译函数。
 * @returns 选版卡元素。
 */
function VersionPickerCard({ versions, selected, current, onPick, onConfirm, onCancel, t }) {
  return React.createElement(
    'div',
    { className: 'dsh-launcher-card', role: 'dialog', 'aria-label': t('pick.title') },
    React.createElement(
      'div',
      { className: 'dsh-launcher-cardbox dsh-launcher-cardbox-wide' },
      React.createElement(
        'div',
        { className: 'dsh-launcher-cardcol' },
        React.createElement('div', { className: 'dsh-launcher-cardtitle' }, t('pick.title')),
        React.createElement('div', { className: 'dsh-launcher-cardmsg' }, t('pick.current', { current: current ?? '?' })),
        React.createElement(
          'div',
          { className: 'dsh-launcher-picks' },
          versions.map((entry) =>
            React.createElement(
              'button',
              {
                key: entry.version,
                type: 'button',
                className: 'dsh-launcher-pick',
                'data-selected': entry.version === selected ? 'true' : undefined,
                'aria-pressed': entry.version === selected ? 'true' : 'false',
                onClick: () => onPick(entry.version)
              },
              React.createElement('span', { className: 'dsh-launcher-pickradio', 'aria-hidden': true }),
              React.createElement('span', { className: 'dsh-launcher-pickversion' }, entry.version),
              React.createElement(
                'span',
                { className: 'dsh-launcher-pickmeta' },
                t(CHANNEL_LABEL[entry.channel] ?? 'channel.other'),
                entry.ignored ? ` · ${t('pick.ignored')}` : '',
                entry.version === selected ? ` · ${t('pick.chosen')}` : ''
              )
            )
          )
        ),
        versions.some((entry) => entry.ignored)
          ? React.createElement('div', { className: 'dsh-launcher-cardnote' }, t('pick.ignoredNote'))
          : null,
        React.createElement(
          'div',
          { className: 'dsh-launcher-cardrow' },
          React.createElement(
            'button',
            {
              type: 'button',
              className: 'dsh-launcher-cardbtn dsh-launcher-cardbtn-primary',
              onClick: onConfirm
            },
            t('pick.confirm', { version: selected ?? '?' })
          ),
          React.createElement(
            'button',
            { type: 'button', className: 'dsh-launcher-cardbtn', onClick: onCancel },
            t('pick.cancel')
          )
        ),
        React.createElement('div', { className: 'dsh-launcher-cardnote' }, t('pick.caveat'))
      )
    )
  )
}

/**
 * 全屏进度卡：确认之后的等待、失败时的说明。
 *
 * 为什么需要它：重启/升级会杀掉当前进程，页面在这段时间里做不了任何事。
 * 光把状态写在 8 个字宽的按钮上说不清楚，用户会以为界面卡死了。
 *
 * @param props.action - 动作快照（action / phase / failure / detail / selected）。
 * @param props.onDismiss - 失败或超时后收起卡片。
 * @param props.t - 翻译函数。
 * @returns 卡片元素，或 null（没有动作时完全不渲染）。
 */
function ActionCard({ action, onDismiss, t }) {
  const kind = action?.action ?? null
  const phase = action?.phase ?? 'idle'
  if (kind === null) return null

  const spinning = phase === 'calling' || phase === 'waiting' || phase === 'reconnecting'
  const isUpgrade = kind === 'upgrade'

  let title
  let message
  if (spinning) {
    title = isUpgrade ? t('action.upgrade.title', { version: action.detail ?? '?' }) : t('action.restart.title')
    if (phase === 'calling') message = t('action.calling')
    else if (phase === 'reconnecting') message = t('action.reconnecting')
    else message = t('action.waiting')
  } else {
    title = t('action.failed.title')
    if (action.failure === 'timeout') message = t('action.timeout')
    else if (action.failure === 'unauthorized') message = t('action.unauthorized')
    else if (action.failure === 'server') message = t('action.server', { reason: action.detail ?? '?' })
    else message = t('action.offline')
  }

  return React.createElement(
    'div',
    { className: 'dsh-launcher-card', role: 'alert' },
    React.createElement(
      'div',
      { className: 'dsh-launcher-cardbox' },
      spinning ? React.createElement('span', { className: 'dsh-launcher-spin', 'aria-hidden': true }) : null,
      React.createElement(
        'div',
        { className: 'dsh-launcher-cardcol' },
        React.createElement('div', { className: 'dsh-launcher-cardtitle' }, title),
        React.createElement('div', { className: 'dsh-launcher-cardmsg' }, message),
        spinning
          ? null
          : React.createElement(
              'button',
              { type: 'button', className: 'dsh-launcher-cardbtn', onClick: onDismiss },
              t('action.dismiss')
            )
      )
    )
  )
}

/**
 * 「重启 | 版本」胶囊 + 进度卡。
 *
 * @param props.controller - 一页一份的 LauncherController。
 * @param props.t - conversation 命名空间的翻译函数（slot 注入的）。
 * @returns 胶囊与卡片。
 */
function LauncherControls({ controller, t }) {
  const { update, action } = useLauncher(controller)
  const busy = action.phase === 'calling' || action.phase === 'waiting' || action.phase === 'reconnecting'
  const restarting = busy && action.action === 'restart'

  React.useEffect(() => {
    // 标签页被冻结过之后（后台标签、系统休眠），轮询可能停在中间态。
    // 回到前台时踢一脚，让它继续收敛。
    const onVisible = () => {
      if (document.visibilityState === 'visible') controller.resume()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [controller])

  const onRestartClick = () => {
    if (busy) return
    if (!window.confirm(t('restart.confirm'))) return
    controller.restart()
  }

  // —— 版本按钮的文案 / 提示 / 强调态 ——
  const current = update.current ?? '?'
  const checking = update.status === 'idle' || update.status === 'checking'
  const available = Boolean(update.available) && typeof update.target === 'string' && update.target.length > 0
  const canApply = update.canApply !== false
  const newer = Array.isArray(update.newer) ? update.newer : []

  let updateLabel
  let updateTitle
  let accent = false
  if (checking) {
    updateLabel = t('update.checking')
    updateTitle = t('update.checking.title')
  } else if (available) {
    // 只提醒模式（allowSelfUpdate=false）下点它不会装，所以文案也不能说会装。
    updateLabel = t('update.available', { version: update.target, current })
    updateTitle = canApply
      ? t('update.available.apply', { version: update.target, current })
      : t('update.available.manual', { version: update.target, current })
    accent = true
  } else if (update.status === 'error') {
    updateLabel = t('update.error')
    updateTitle = t('update.error.title', { reason: update.error ?? '?' })
  } else if (newer.length > 0) {
    updateLabel = t('update.ignored', { count: newer.length })
    updateTitle = t('update.ignored.title', { count: newer.length })
  } else {
    updateLabel = t('update.latest')
    updateTitle = t('update.latest.title', { current })
  }

  // 候选多于一个时，点版本按钮先摆出选版卡 —— 只升「推荐的那个」会把
  // 「其实也能升 rc」这件事藏起来，而服务端白名单本来就允许升 newer 里的任意一个。
  const choosing = action.phase === 'select'
  const onUpdateClick = () => {
    if (busy || checking) return
    if (choosing) {
      controller.cancelSelection()
      return
    }
    if (available && canApply) {
      if (newer.length > 1) {
        controller.openPicker(update.target)
        return
      }
      if (!window.confirm(t('update.confirm', { version: update.target, current }))) return
      controller.upgrade(update.target)
      return
    }
    controller.recheck()
  }

  return React.createElement(
    'div',
    { className: 'dsh-launcher-root' },
    React.createElement(
      'div',
      { className: 'dsh-launcher-cluster' },
      React.createElement(
        'button',
        {
          type: 'button',
          className: 'dsh-launcher-btn',
          disabled: busy,
          'aria-label': `${t('restart.label')}：${t('restart.title')}`,
          title: t('restart.title'),
          onClick: onRestartClick
        },
        React.createElement('span', { className: 'dsh-launcher-glyph', 'aria-hidden': true }, '\u21bb'),
        React.createElement('span', null, restarting ? t('restart.calling') : t('restart.label'))
      ),
      React.createElement('span', { className: 'dsh-launcher-sep', 'aria-hidden': true }),
      React.createElement(
        'button',
        {
          type: 'button',
          className: 'dsh-launcher-btn',
          'data-accent': accent ? 'true' : undefined,
          disabled: busy,
          'aria-label': `${updateLabel}：${updateTitle}`,
          title: updateTitle,
          onClick: onUpdateClick
        },
        React.createElement('span', null, updateLabel)
      )
    ),
    choosing
      ? React.createElement(VersionPickerCard, {
          versions: newer,
          selected: action.selected,
          current: update.current,
          onPick: (version) => controller.selectVersion(version),
          onConfirm: () => {
            const chosen = action.selected
            if (!window.confirm(t('update.confirm', { version: chosen ?? '?', current }))) return
            controller.confirmSelection()
          },
          onCancel: () => controller.cancelSelection(),
          t
        })
      : React.createElement(ActionCard, { action, onDismiss: () => controller.dismiss(), t })
  )
}

		//#region client/src/index.js
/**
 * 浏览器半边入口：把「重启」和「检查版本」注册成会话头部 utilities 的一个 slot 贡献。
 *
 * 为什么值得做成这样，而不是继续往 index.html 里注入 DOM：
 *   conversation.session.header.utilities 是 dsh 的公开扩展点（open-in-app 的分裂按钮
 *   就注册在同一个槽里，第三方插件也这么干），由 React 渲染、跟着顶栏一起布局。
 *   于是「避开 dsh 顶栏控件」这件事不再需要，右上角那套坐标探测 + MutationObserver
 *   补偿（avoidAppButtons）本来就是为了绕开「悬浮按钮会盖住顶栏」才存在的。
 *
 * 宿主侧不需要任何新路由：/pwa-launcher/restart 与 /pwa-launcher/update-check 是
 * 原有悬浮按钮就在用的接口，这里直接复用。
 */

/**
 * 控件之外还需要的两个服务：
 *   slots  —— 把贡献挂上 utilities 槽
 *   locale —— 注册 pwa-launcher 词典，并把 t() 注进组件
 * 另外用 ctx.effect 管生命周期，和 open-in-app 的写法保持一致。
 */
const inject = ['slots', 'locale']

/**
 * 注入 index.html 的样式。
 *
 * 数值与 open-in-app 的分裂按钮逐项对齐（28px 高、14px 圆角、11px 字号、
 * --dsw-alias-border-l4 边框），这样两个控件并排时是同一视觉重量。
 * 颜色一律走 dsh 的设计变量，不写死色值 —— 深色/浅色主题都跟着走。
 */
const CSS = [
  '.dsh-launcher-cluster{box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l4);height:28px;',
  'font-family:var(--dsw-font-family);border-radius:14px;align-items:stretch;display:inline-flex;overflow:hidden}',
  '.dsh-launcher-btn{color:var(--dsw-alias-label-primary);cursor:pointer;white-space:nowrap;background:0 0;border:0;',
  'align-items:center;gap:5px;font-size:11px;font-weight:400;line-height:16px;display:inline-flex;padding:5px 8px}',
  '.dsh-launcher-btn:hover:not(:disabled),.dsh-launcher-btn:focus-visible{background:var(--dsw-alias-interactive-bg-hover)}',
  '.dsh-launcher-btn:disabled{color:var(--dsw-alias-label-dimmed);cursor:wait}',
  '.dsh-launcher-btn[data-state=error]{color:var(--dsw-alias-state-error-primary)}',
  '.dsh-launcher-btn[data-accent=true]{color:#2563eb;font-weight:500}',
  '.dsh-launcher-sep{border-left:.5px solid var(--dsw-alias-border-l4);align-self:stretch;width:0}',
  '.dsh-launcher-glyph{font-size:12px;line-height:1}',
  // —— 重启/升级的进度卡 ——
  // 遮罩：重启期间页面做不了任何事，把它盖住比让用户对着一个没反应的界面强。
  '.dsh-launcher-card{position:fixed;inset:0;z-index:2147483001;display:flex;align-items:center;justify-content:center;',
  'background:rgba(0,0,0,.35)}',
  '.dsh-launcher-cardbox{display:flex;align-items:center;gap:16px;max-width:min(460px,86vw);padding:22px 28px;',
  'border-radius:12px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-specific-input-major);',
  'color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family);font-size:14px;line-height:1.6;',
  'box-shadow:0 10px 40px rgba(0,0,0,.28)}',
  '.dsh-launcher-cardcol{display:flex;flex-direction:column;gap:4px;min-width:0}',
  '.dsh-launcher-cardtitle{font-size:15px;font-weight:700}',
  '.dsh-launcher-cardmsg{opacity:.88}',
  '.dsh-launcher-cardbtn{align-self:flex-start;margin-top:8px;font-size:12px;padding:4px 12px;border-radius:8px;',
  'border:1px solid var(--dsw-alias-border-l2);background:transparent;color:inherit;cursor:pointer}',
  '.dsh-launcher-cardbtn:hover{border-color:var(--dsw-alias-label-secondary)}',
  '.dsh-launcher-cardbtn-primary{background:#2563eb;border-color:#2563eb;color:#fff;font-weight:500}',
  '.dsh-launcher-cardbtn-primary:hover{filter:brightness(1.08);border-color:#2563eb}',
  '.dsh-launcher-cardnote{font-size:12px;opacity:.72;margin-top:6px}',
  '.dsh-launcher-cardrow{display:flex;gap:8px;align-items:center;margin-top:10px}',
  // —— 选版卡 ——
  '.dsh-launcher-cardbox-wide{flex-direction:column;align-items:stretch;min-width:min(420px,86vw)}',
  '.dsh-launcher-picks{display:flex;flex-direction:column;gap:6px;margin-top:10px}',
  '.dsh-launcher-pick{display:flex;align-items:center;gap:10px;width:100%;box-sizing:border-box;text-align:left;',
  'padding:9px 12px;border-radius:10px;cursor:pointer;font:inherit;color:inherit;background:transparent;',
  'border:1px solid var(--dsw-alias-border-l2)}',
  '.dsh-launcher-pick:hover{background:var(--dsw-alias-interactive-bg-hover)}',
  '.dsh-launcher-pick[data-selected=true]{border-color:#2563eb;box-shadow:inset 0 0 0 1px #2563eb}',
  '.dsh-launcher-pickradio{flex:none;width:14px;height:14px;border-radius:50%;',
  'border:1.5px solid var(--dsw-alias-border-l2)}',
  '.dsh-launcher-pick[data-selected=true] .dsh-launcher-pickradio{border-color:#2563eb;border-width:4px}',
  '.dsh-launcher-pickversion{font-weight:600;font-variant-numeric:tabular-nums}',
  '.dsh-launcher-pickmeta{margin-left:auto;font-size:12px;opacity:.7;white-space:nowrap}',
  '@keyframes dsh-launcher-spin{to{transform:rotate(360deg)}}',
  '.dsh-launcher-spin{flex:none;width:20px;height:20px;border-radius:50%;border:2px solid var(--dsw-alias-border-l2);',
  'border-top-color:var(--dsw-alias-label-primary);animation:dsh-launcher-spin .8s linear infinite}',
  '@media (prefers-reduced-motion:reduce){.dsh-launcher-spin{animation-duration:2.4s}}'
].join('')

/** 样式标签 id：HMR 重载时靠它去重，不重复插入。 */
const STYLE_ID = 'dsh-launcher-controls-style'

/** 挂一次样式。 */
function ensureStyle() {
  if (typeof document === 'undefined') return
  if (document.querySelector(`style[data-plugin-css=${JSON.stringify(STYLE_ID)}]`) !== null) return
  const tag = document.createElement('style')
  tag.dataset.plugin = 'dsh-pwa-launcher'
  tag.dataset.pluginCss = STYLE_ID
  tag.textContent = CSS
  document.head.appendChild(tag)
}

/**
 * 客户端插件体。
 * @param ctx - 客户端根上下文。
 */
function apply(ctx) {
  ensureStyle()
  const controller = new LauncherController()
  // 页面一加载就把宿主的更新检查结果取回来；组件挂载前拿到，按钮就不会先闪一下「检查…」。
  controller.loadUpdate()

  // 控制器挂在 effect 里而不是模块作用域：apply 每次都给一份全新的，插件被
  // dispose 时（含 HMR 重载）旧的那份一定停掉轮询，不会留一个还在跑的僵尸。
  ctx.effect(() => () => controller.dispose(), 'pwa-launcher: controller')

  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'pwa-launcher: dictionaries')

  ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
    name: 'conversation.session.header.utilities',
    id: 'pwa-launcher',
    // 排在 open-in-app（order -10）后面，于是这一簇是「打开方式 · 重启 · 版本」，
    // 打头的是 dsh 自己的控件，我们跟在它右边。
    order: 10,
    // 声明命名空间后，框架会把 t 注进组件的 props（不自己 bind/拼 t ——
    // dsh 的 locale 服务没有 ctx.locale.t 这个入口）。
    locale: NS,
    inject: () => ({ controller })
  }, LauncherControls))
}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
