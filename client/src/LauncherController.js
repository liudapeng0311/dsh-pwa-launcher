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
export class LauncherController {
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
