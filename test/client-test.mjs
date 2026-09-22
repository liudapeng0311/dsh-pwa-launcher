// 验证注入脚本的「顶栏避让」行为。
//
// 做法：真的 import 插件、真的调 apply()，从 tapIndex 钩子里截获它实际注入的 <script>，
// 再把这段脚本放进一个自建的假 DOM 里跑，检查按钮的 right 值。
// 这样验的是「真正会发到浏览器的那段代码」，而不是我对它的复述。
//
// 用法（在本包目录下）：node test/client-test.mjs
//
// apply() 里那个 setTimeout(0) 的安装流程不会被执行到 —— 本文件全程同步，最后直接
// process.exit()，真实定时器没有机会跑（避免它去动桌面快捷方式）。

import { pathToFileURL } from 'node:url'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import vm from 'node:vm'

const HERE = dirname(fileURLToPath(import.meta.url))
const MOD = pathToFileURL(join(HERE, '..', 'lib', 'index.js')).href
const { apply } = await import(MOD)

// ---------- 3) 搭一个够用的假 DOM ----------
// 注入脚本自带幂等守卫（window.__DSH_DL_RESTART__），同一份 window 里只能跑一次，
// 所以每个场景都要一块全新的沙箱 + DOM。这里做成工厂。
const VW = 1200

function makeEnv(opts) {
  opts = opts || {}
  const byId = Object.create(null)
  const widgets = []          // 「应用自己的」顶栏控件
  const timers = []
  const intervals = []
  const observers = []

  function rectFor(el) {
    if (el.id === 'dsh-dl-restart' || el.id === 'dsh-dl-upd') {
      const w = el.offsetWidth
      const right = parseFloat(el.style.right) || 10
      const top = parseFloat(el.style.top) || 10
      return { left: VW - right - w, right: VW - right, top, bottom: top + 30, width: w, height: 30 }
    }
    // 按钮内部的 span：落在按钮里面，而且**尺寸是真实的**（会通过 >=8px 的筛选）。
    // 这点很关键 —— 如果给 span 一个 0 尺寸，就复现不出「自己的 span 被当成应用控件」
    // 那个抖动 bug 了（我第一版测试就是这么漏掉的）。
    if (el.parentNode && (el.parentNode.id === 'dsh-dl-restart' || el.parentNode.id === 'dsh-dl-upd')) {
      const pr = rectFor(el.parentNode)
      const pad = 12, w = Math.max(8, pr.width - pad * 2)
      return { left: pr.left + pad, right: pr.left + pad + w, top: pr.top + 5, bottom: pr.bottom - 5, width: w, height: 20 }
    }
    return el._rect || { left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 }
  }
  function notify() { for (const o of observers) o.cb([{ type: 'childList' }]) }
  function makeEl(tag) {
    const el = {
      tagName: String(tag).toUpperCase(), nodeType: 1, id: '', style: {}, children: [],
      _removed: false, _text: '', _html: '', parentNode: null, _rect: null,
      get textContent() { return this._text }, set textContent(v) { this._text = v },
      get innerHTML() { return this._html },
      // 真实 DOM 里赋 innerHTML 会建出子元素（我们的按钮就是 <span>…</span>）。
      // 这里照做：造一个 span 子节点 —— 这正是当初漏掉那个抖动 bug 的原因。
      set innerHTML(v) {
        this._html = v
        if (typeof v === 'string' && v.indexOf('<span') >= 0 && this.children.length === 0) {
          const s = makeEl('span'); s.parentNode = this; this.children.push(s)
        }
      },
      appendChild(c) { c.parentNode = this; this.children.push(c); if (c.id) byId[c.id] = c; notify(); return c },
      addEventListener(type, fn) { (this._handlers || (this._handlers = {}))[type] = fn },
      remove() { this._removed = true; if (byId[this.id] === this) delete byId[this.id]; notify() },
      querySelector() { return null }, querySelectorAll() { return [] },
      contains(n) { for (var p = n; p; p = p.parentNode) { if (p === this) return true } return false },
      getBoundingClientRect() { return rectFor(this) },
      offsetHeight: 30
    }
    Object.defineProperty(el, 'offsetWidth', {
      get() {
        if (this.id === 'dsh-dl-upd') return 92
        if (this.id === 'dsh-dl-restart') return 68
        if (this._rect) return this._rect.width
        return 0
      }
    })
    return el
  }

  const head = makeEl('head')
  const body = makeEl('body')
  const documentElement = makeEl('html')
  documentElement.clientWidth = VW

  // 可控时钟：布局里有个「控件刚消失先别急着弹回」的延迟判断，用真实 Date.now()
  // 会让测试依赖墙钟（定时器是瞬间 flush 的，1.5s 永远等不到）。这里给个假时钟。
  let clockNow = 1700000000000
  class FakeDate extends Date { static now() { return clockNow } }

  const document = {
    head, body, documentElement,
    createElement: makeEl,
    querySelector: (s) => (s[0] === '#' ? byId[s.slice(1)] || null : null),
    querySelectorAll: () => [],
    getElementById: (id) => byId[id] || null,
    // document 级的监听器（面板的「点别处收起」注册在这里）。
    // 分成捕获/冒泡两拨，dispatch 时按真实语义各走一趟。
    _docHandlers: { capture: [], bubble: [] },
    addEventListener(type, fn, capture) {
      (capture ? this._docHandlers.capture : this._docHandlers.bubble).push({ type, fn })
    },
    // 派发一个事件：先捕获（从外往内），再冒泡。
    // 支持 ev.stopPropagation() —— 应用自己会用它挡掉冒泡，正是我们选捕获的原因。
    dispatch(type, target, extra) {
      const ev = Object.assign({ type, target, currentTarget: target, _stopped: false, stopPropagation() { this._stopped = true }, preventDefault() {} }, extra || {})
      for (const h of this._docHandlers.capture) { if (h.type === type) h.fn(ev) }
      if (!ev._stopped && target && target._handlers && target._handlers[type]) target._handlers[type](ev)
      if (!ev._stopped) for (const h of this._docHandlers.bubble) { if (h.type === type) h.fn(ev) }
      return ev
    },
    // 返回被点中位置上的元素栈：**最内层在前**（和真实 elementsFromPoint 一致）。
    // 我们的按钮内部是 span —— 先给 span，再给它所属的按钮，这样才逼真。
    elementsFromPoint(x, y) {
      const out = []
      for (const id of ['dsh-dl-restart', 'dsh-dl-upd']) {
        const el = byId[id]
        if (!el || el._removed) continue
        const r = rectFor(el)
        if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
          for (const c of el.children) out.push(c)   // 最内层 span 在前
          out.push(el)
        }
      }
      for (const w of widgets) {
        const r = w._rect
        if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
          for (const c of w.children) out.push(c)
          out.push(w)
        }
      }
      out.push(documentElement, body)
      return out
    }
  }

  const sandbox = {
    document,
    innerWidth: VW,
    addEventListener() {},
    getComputedStyle: () => ({ backgroundColor: 'rgb(255,255,255)', display: 'block', visibility: 'visible', opacity: '1' }),
    matchMedia: () => ({ matches: false }),
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length },
    setInterval: (fn, ms) => { intervals.push({ fn, ms }); return intervals.length },
    clearTimeout() {}, clearInterval() {},
    MutationObserver: class { constructor(cb) { this.cb = cb; observers.push(this) } observe() {} disconnect() {} },
    fetch: opts.fetch || (() => new Promise(() => {})),
    confirm: () => false,
    location: { origin: 'http://127.0.0.1:3080', replace() {} },
    Date: FakeDate,
    console
  }
  sandbox.window = sandbox
  vm.createContext(sandbox)

  return {
    sandbox, byId,
    addWidget(rect) { const w = makeEl('div'); w._rect = rect; widgets.push(w) },
    clearWidgets() { widgets.length = 0 },
    flushTimers(cap = 100) { let n = 0; while (timers.length && n++ < cap) { timers.shift().fn() } },
    tickIntervals() { for (const i of intervals) i.fn() },
    // 把假时钟往前推，让「控件消失后延迟回位」那步能真的发生。
    advance(ms) { clockNow += ms },
    // 等微任务队列排空（fetch 是 Promise，要给它机会 settle）
    async settle(rounds = 8) { for (let i = 0; i < rounds; i++) await Promise.resolve() },
    // 触发某个真实元素上注册的事件（目前只用到 click）
    click(id) { const el = byId[id]; if (el && el._handlers && el._handlers.click) { el._handlers.click({ target: el, currentTarget: el }); return true } return false },
    // document 级派发（面板的「点别处收起」靠这个测）
    dispatch(type, target, extra) { return document.dispatch(type, target, extra) },
    // 造一个「在某个已存在元素内部」的节点，用来模拟点面板内部的按钮/文字
    makeInside(parentId, tag = 'span') { const p = byId[parentId]; if (!p) return null; const c = makeEl(tag); c.parentNode = p; p.children.push(c); return c },
    body() { return body },
    button(id) { return byId[id] }
  }
}

// 截获某份「配置」下插件真正注入的脚本。
function captureScripts(config) {
  let inj = ''
  const ctx2 = {
    webServer: { port: 3080, tapIndex: (fn) => { inj = fn('<html><body></body></html>') }, register: () => {} },
    connection: { authenticatedUrl: () => 'http://127.0.0.1:3080/?token=T', authorizeIndex: () => true }
  }
  // 注意：installDir 故意指向一个不存在的路径；本文件全程同步并很快 exit，
  // apply() 里 setTimeout(0) 的安装流程没有机会执行。
  // 用平台临时目录下的合成子目录，而不是写死某个盘符 —— 后者只在作者的机器上
  // 碰巧"不存在"，换台机器或换个平台就不一定了。
  const fakeInstallDir = join(tmpdir(), 'dsh-pwa-launcher-not-installed-' + process.pid)
  apply(ctx2, { checkForUpdates: true, allowSelfUpdate: true, installDir: fakeInstallDir, ...config })
  return [...inj.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1])
}

// ---------- 1) 截获注入脚本 + 语法自检 ----------
const scripts = captureScripts({ avoidAppButtons: true })
console.log('截获注入脚本数量 =', scripts.length)
if (scripts.length !== 2) { console.log('FAIL: 期望 2 段脚本'); process.exit(1) }

for (let i = 0; i < scripts.length; i++) {
  try { new vm.Script(scripts[i]); console.log(`脚本 ${i + 1} 语法 OK (${scripts[i].length} 字节)`) }
  catch (e) { console.log(`FAIL: 脚本 ${i + 1} 语法错误: ${e.message}`); process.exit(1) }
}

// ---------- 2) 主场景 ----------
const env = makeEnv()
for (const s of scripts) vm.runInContext(s, env.sandbox)
env.flushTimers(200)
env.tickIntervals()

const restart = env.button('dsh-dl-restart')
const upd = env.button('dsh-dl-upd')
if (!restart || !upd) { console.log('FAIL: 按钮没建出来'); process.exit(1) }

let failures = 0
const check = (name, cond, detail) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
  if (!cond) failures++
}
const restartRight = () => parseFloat(restart.style.right)
const updRight = () => parseFloat(upd.style.right)
const summary = () => `restart.right=${restartRight()} upd.right=${updRight()}`

// 场景 1：没有应用侧控件 -> 保持原位置
check('S1 无应用按钮时贴右(10px)', restartRight() === 10, summary())

// 位置不重叠的判定：我们整个簇的「最右缘」必须落在对方控件的左边。
function noOverlap(widgetLeft) {
  const clusterRightEdge = VW - restartRight()
  return clusterRightEdge <= widgetLeft
}
function gapText(widgetLeft) {
  return `簇右缘=${VW - restartRight()} 对方左缘=${widgetLeft} 间隙=${widgetLeft - (VW - restartRight())}`
}

// 场景 2：应用侧控件出现 -> 整簇左移
const widgetLeft = VW - 260
env.addWidget({ left: widgetLeft, right: VW - 12, top: 8, bottom: 44, width: 248, height: 36 })
env.flushTimers(200); env.tickIntervals()
const shifted = restartRight()
check('S2 出现应用按钮后向左让位', shifted > 10, summary())
check('S2 让位后不与其重叠', noOverlap(widgetLeft), gapText(widgetLeft))
check('S2 更新按钮仍在重启左侧', updRight() > restartRight(), summary())

// 场景 3：稳定（反复触发不再抖动 / 不自激循环）
const before = restartRight()
for (let i = 0; i < 5; i++) { env.tickIntervals(); env.flushTimers(50) }
check('S3 反复触发后位置稳定', restartRight() === before, summary())

// 场景 4：应用侧控件消失 -> 延迟一小会儿后回到原位
env.clearWidgets()
// 刚消失这一拍：应该留在原地（防抖），不许立刻弹回
env.flushTimers(200); env.tickIntervals()
check('S4a 控件刚消失时留在原地（防抖）', restartRight() === before, summary())
// 过了防抖窗口再算 -> 回原位
env.advance(2000)
env.flushTimers(200); env.tickIntervals()
check('S4b 防抖窗口过后回到 10px', restartRight() === 10, summary())

// 场景 5：控件不贴右缘（右侧留了内边距）也要能发现
const w5left = VW - 300
env.addWidget({ left: w5left, right: VW - 40, top: 8, bottom: 44, width: 260, height: 36 })
env.flushTimers(200); env.tickIntervals()
check('S5 不贴右缘的控件也能避让', restartRight() > 10, summary())
check('S5 避让后不重叠', VW - restartRight() <= w5left, gapText(w5left))

// 场景 6：多个控件（含中间的空隙）-> 以最靠左的那个为准
env.clearWidgets()
const w6left = VW - 420
env.addWidget({ left: VW - 150, right: VW - 12, top: 8, bottom: 44, width: 138, height: 36 })
env.addWidget({ left: w6left, right: VW - 160, top: 8, bottom: 44, width: 260, height: 36 })
env.flushTimers(200); env.tickIntervals()
check('S6 多个控件时按最左者避让', VW - restartRight() <= w6left, gapText(w6left))

// 场景 7：全屏遮罩/大容器不应被当成顶栏控件
env.clearWidgets()
env.advance(2000)                 // 越过防抖窗口，避免受上一步影响
env.flushTimers(200); env.tickIntervals()
env.addWidget({ left: 0, right: VW, top: 0, bottom: 800, width: VW, height: 800 })
env.flushTimers(200); env.tickIntervals()
check('S7 全屏大容器不算控件（保持贴右）', restartRight() === 10, summary())

// ---------- 5) avoidAppButtons 开关 ----------
// 用各自全新的沙箱跑（脚本有幂等守卫，不能复用同一个 window）。
function runScenario(avoid, widgetRect) {
  const e2 = makeEnv()
  if (widgetRect) e2.addWidget(widgetRect)
  for (const s of captureScripts({ avoidAppButtons: avoid })) vm.runInContext(s, e2.sandbox)
  e2.flushTimers(200); e2.tickIntervals()
  return {
    restart: parseFloat(e2.button('dsh-dl-restart').style.right),
    upd: parseFloat(e2.button('dsh-dl-upd').style.right)
  }
}
const WIDGET = { left: VW - 260, right: VW - 12, top: 8, bottom: 44, width: 248, height: 36 }

const off = runScenario(false, WIDGET)
check('S8 avoidAppButtons:false 时有控件也不动', off.restart === 10, `restart.right=${off.restart} upd.right=${off.upd}`)

const on = runScenario(true, WIDGET)
check('S9 avoidAppButtons:true 时左移', on.restart > 10, `restart.right=${on.restart} upd.right=${on.upd}`)

// 场景 10：真实抖动回归 —— 我们自己的按钮里是 <span>，且尺寸真实。
// 曾经因为只看元素自身 id（span 没有 id），把自家按钮当成应用控件，
// 于是布局追着自己往左跑、再弹回原位，表现为「一会正常、一会间距很大」。
// 这里连算多次，要求单调收敛到同一个值。
{
  const e3 = makeEnv()   // 没有任何应用控件
  for (const s of captureScripts({ avoidAppButtons: true })) vm.runInContext(s, e3.sandbox)
  e3.flushTimers(200)
  const seen = []
  for (let i = 0; i < 6; i++) { e3.tickIntervals(); e3.flushTimers(50); seen.push(parseFloat(e3.button('dsh-dl-restart').style.right)) }
  const allSame = seen.every((v) => v === seen[0])
  check('S10 无应用控件时不许自己漂移', allSame && seen[0] === 10, `历次 right = ${seen.join(',')}`)
}

// 场景 11：应用控件被我们盖住时，仍要认出它（跳过自家 span/按钮后继续往下找）
{
  const e4 = makeEnv()
  // 控件就在右上角原位、且压在我们的按钮下面（模拟开始对话那一刻）
  e4.addWidget({ left: VW - 180, right: VW - 12, top: 8, bottom: 44, width: 168, height: 36 })
  for (const s of captureScripts({ avoidAppButtons: true })) vm.runInContext(s, e4.sandbox)
  e4.flushTimers(200); e4.tickIntervals()
  const r = parseFloat(e4.button('dsh-dl-restart').style.right)
  check('S11 被自家按钮盖住的控件也能识别', r > 10, `restart.right=${r}`)
}

// ---------- 6) 更新面板：不许永远停在「检查中」 ----------
// 这三个场景来自用户实际报的问题：面板打开后「当前版本」是空的、一直「检查中…」。
// 成因是页面在 dsh 冷启动（60s+）期间加载 —— 快速轮询只重试 10 次就彻底躺下。
function jsonResp(obj) {
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(obj) })
}
const CHECKING = { status: 'checking', ok: false, current: '0.1.5-rc.2', appVersion: '0.1.5-rc.2', cliVersion: '0.1.5-rc.1', newer: [] }

// S12：面板处于「检查中」时的显示。
// 注意：这条**只**覆盖前端渲染，不覆盖「服务端在 checking 阶段要带上 current」——
// 后者没法在这里测（runUpdateCheck 不做导出、且要真连 registry），
// 由 lib/index.js 里「版本一读出来就挂到 updateState」保证。
{
  const e5 = makeEnv({ fetch: () => jsonResp(CHECKING) })
  for (const s of captureScripts({ checkForUpdates: true })) vm.runInContext(s, e5.sandbox)
  e5.flushTimers(50); await e5.settle(); e5.flushTimers(50)
  e5.click('dsh-dl-upd')
  const pop = e5.button('dsh-dl-upd-pop')
  const html = pop ? pop.innerHTML : ''
  check('S12 检查中也能显示当前版本', html.includes('0.1.5-rc.2'),
    `面板${html.includes('0.1.5-rc.2') ? '含' : '不含'} 0.1.5-rc.2`)
}

// S12b：拿不到版本号时（首轮检查还没读到版本），文案不能是「当前版本：检查中…」
// 这种自相矛盾的占位，要明确说「读取中…」。
{
  const NOVER = { status: 'checking', ok: false, newer: [] }   // 刻意不带 current
  const e5b = makeEnv({ fetch: () => jsonResp(NOVER) })
  for (const s of captureScripts({ checkForUpdates: true })) vm.runInContext(s, e5b.sandbox)
  e5b.flushTimers(50); await e5b.settle(); e5b.flushTimers(50)
  e5b.click('dsh-dl-upd')
  const pop = e5b.button('dsh-dl-upd-pop')
  const html = pop ? pop.innerHTML : ''
  check('S12b 无版本号时显示「读取中…」', html.includes('读取中…') && !html.includes('当前版本</span><span class=\'v2\'>检查中'),
    `面板${html.includes('读取中…') ? '含读取中' : '不含读取中'}`)
}

// S13：连不上服务时，快速轮询用尽后要退到慢速轮询（而不是永远躺下）
{
  let calls = 0
  const e6 = makeEnv({ fetch: () => { calls++; return Promise.reject(new Error('Failed to fetch')) } })
  for (const s of captureScripts({ checkForUpdates: true })) vm.runInContext(s, e6.sandbox)
  await e6.settle()
  // 把快速轮询全部耗尽
  for (let i = 0; i < 30; i++) { e6.flushTimers(20); await e6.settle(3) }
  const afterFast = calls
  // 再推进几轮 —— 慢速轮询应该继续产生请求
  for (let i = 0; i < 5; i++) { e6.flushTimers(20); await e6.settle(3) }
  check('S13 连不上时仍会持续重试（不永久躺下）', calls > afterFast, `请求数 ${afterFast} -> ${calls}`)
}

// S14：服务起来后，慢速轮询要能把状态刷成终态并显示出来
{
  let calls = 0
  const DONE = { status: 'done', ok: true, current: '0.1.5-rc.2', appVersion: '0.1.5-rc.2', cliVersion: '0.1.5-rc.1', available: true, target: '0.1.6-alpha.2', channel: 'alpha', newer: [{ channel: 'alpha', version: '0.1.6-alpha.2', ignored: false }] }
  const e7 = makeEnv({
    fetch: () => { calls++; return calls <= 12 ? Promise.reject(new Error('down')) : jsonResp(DONE) }
  })
  for (const s of captureScripts({ checkForUpdates: true })) vm.runInContext(s, e7.sandbox)
  await e7.settle()
  for (let i = 0; i < 40; i++) { e7.flushTimers(20); await e7.settle(3) }
  const txt = e7.button('dsh-dl-upd').innerHTML
  check('S14 服务恢复后徽标能显示结果', txt.includes('有新版'), `按钮 = ${JSON.stringify(txt.replace(/<[^>]+>/g, ''))}`)
}

// ---------- 7) 点页面别处收起更新面板 ----------
const DONE1 = { status: 'done', ok: true, current: '0.1.5-rc.2', appVersion: '0.1.5-rc.2', cliVersion: '0.1.5-rc.1', available: true, target: '0.1.6-alpha.2', channel: 'alpha', newer: [{ channel: 'alpha', version: '0.1.6-alpha.2', ignored: false }] }
async function openPanel() {
  const e = makeEnv({ fetch: () => jsonResp(DONE1) })
  for (const s of captureScripts({ checkForUpdates: true })) vm.runInContext(s, e.sandbox)
  e.flushTimers(50); await e.settle(); e.flushTimers(50)
  e.click('dsh-dl-upd')                       // 打开面板
  return e
}
const popOpen = (e) => !!e.button('dsh-dl-upd-pop')

// S15：点页面别处 -> 收起
{
  const e = await openPanel()
  check('S15 前提：面板已打开', popOpen(e))
  e.dispatch('click', e.body())               // 点 body（页面别处）
  check('S15 点别处后收起', !popOpen(e), `面板存在=${popOpen(e)}`)
}

// S16：点面板内部 -> 不收起（否则点「忽略」「更新」就点不到了）
{
  const e = await openPanel()
  const inner = e.makeInside('dsh-dl-upd-pop', 'button')
  check('S16 前提：造出面板内部节点', !!inner)
  e.dispatch('click', inner)
  check('S16 点面板内部不收起', popOpen(e), `面板存在=${popOpen(e)}`)
}

// S17：点开关按钮自己 -> 由 toggle 关掉（不能被捕获阶段抢跑成「先关再开」）
{
  const e = await openPanel()
  e.dispatch('click', e.button('dsh-dl-upd'))
  check('S17 再点开关可关闭', !popOpen(e), `面板存在=${popOpen(e)}`)
}

// S17b：连点两次开关 = 关掉（幂等，不会「关了又冒出来」）
{
  const e = await openPanel()
  e.dispatch('click', e.button('dsh-dl-upd'))   // 关
  e.dispatch('click', e.button('dsh-dl-upd'))   // 又开
  const reopened = popOpen(e)
  e.dispatch('click', e.button('dsh-dl-upd'))   // 再关
  check('S17b 反复开关状态正确', reopened && !popOpen(e), `中途开=${reopened} 最终存在=${popOpen(e)}`)
}

// S18：应用自己在别处 stopPropagation 时也要能收到
// （这是选捕获阶段的原因：React 常这么干，冒泡就丢了）
{
  const e = await openPanel()
  // 造一个「面板之外」的元素，它自己的 click 处理器会 stopPropagation
  const outside = e.makeInside(null, 'div')
  const target = outside || e.body()
  let handlerRan = false
  target._handlers = { click: (ev) => { handlerRan = true; ev.stopPropagation() } }
  e.dispatch('click', target)
  check('S18 别处冒泡被挡也能收起', handlerRan && !popOpen(e),
    `处理器跑过=${handlerRan} 面板存在=${popOpen(e)}`)
}

// S19：Esc 收起
{
  const e = await openPanel()
  e.dispatch('keydown', e.body(), { key: 'Escape' })
  check('S19 Esc 收起面板', !popOpen(e), `面板存在=${popOpen(e)}`)
}

// S20：收起后定时器重绘不许把它画回来（旧实现只置 POP 不清 DOM 会「关不掉」）
{
  const e = await openPanel()
  e.dispatch('click', e.body())
  const afterClose = popOpen(e)
  for (let i = 0; i < 5; i++) { e.tickIntervals(); e.flushTimers(20) }
  check('S20 收起后重绘不会自己冒出来', !afterClose && !popOpen(e), `关闭后=${afterClose} 重绘后=${popOpen(e)}`)
}

// ---------- 8) 页面正文不许被当成顶栏控件（真实 bug 回归） ----------
// 用户报了：装了某个插件后打开它的页面，两个按钮被推到页面中间、还盖住了
// 那个页面的标题。原因：正文（标题 h2 + 说明文字）正好落在按钮那条纵向带子里、
// 尺寸也够小，被判定成「应用顶栏控件」，于是整簇一路左移。
// 判据：顶栏控件必然占据**右上角**；正文不会。
{
  const e8 = makeEnv()
  for (const s of captureScripts({ avoidAppButtons: true })) vm.runInContext(s, e8.sandbox)
  e8.flushTimers(200); e8.tickIntervals()
  check('S21 前提：初始贴右', parseFloat(e8.button('dsh-dl-restart').style.right) === 10,
    `right=${e8.button('dsh-dl-restart').style.right}`)

  // 造一个「页面标题」：位于页面中左部，右上角是空的（还原截图里的几何）
  e8.addWidget({ left: 568, right: 758, top: 8, bottom: 44, width: 190, height: 36 })
  e8.flushTimers(200); e8.tickIntervals()
  const r21 = parseFloat(e8.button('dsh-dl-restart').style.right)
  check('S21 正文标题不触发让位（右上角是空的）', r21 === 10, `right=${r21}（期望 10）`)
}

// S22：真正的顶栏控件（贴右上角）仍然要让位 —— 别把功能修坏了
{
  const e9 = makeEnv()
  // 真实顶栏按钮簇：贴在右上角，宽约 95px（dsh 的文件/窗口/⋯ 那一排）
  e9.addWidget({ left: VW - 100, right: VW - 8, top: 8, bottom: 44, width: 92, height: 36 })
  for (const s of captureScripts({ avoidAppButtons: true })) vm.runInContext(s, e9.sandbox)
  e9.flushTimers(200); e9.tickIntervals()
  const r22 = parseFloat(e9.button('dsh-dl-restart').style.right)
  check('S22 右上角真有控件时仍让位', r22 > 10, `right=${r22}`)
  check('S22 让位后不与控件重叠', VW - r22 <= VW - 100 + 1, `簇右缘=${VW - r22} 控件左缘=${VW - 100}`)
}

// S23：让位距离有上限，绝不被推到屏幕中间
{
  const e10 = makeEnv()
  // 造一片「从右缘一直铺到页面中部」的可疑区域
  e10.addWidget({ left: Math.round(VW * 0.25), right: VW, top: 8, bottom: 44, width: Math.round(VW * 0.75), height: 36 })
  for (const s of captureScripts({ avoidAppButtons: true })) vm.runInContext(s, e10.sandbox)
  e10.flushTimers(200); e10.tickIntervals()
  const r23 = parseFloat(e10.button('dsh-dl-restart').style.right)
  // restart.right 就是「距右缘的距离」，它不该超过窗口宽度的 35% + 一点余量
  check('S23 让位距离有上限（不会被推到屏幕中间）', r23 <= VW * 0.4, `right=${r23} 上限≈${Math.round(VW * 0.35)}`)
}

// S24：忠实还原用户报的那一页 —— 一个居中列页面（max-width:760px; margin:0 auto），
// 它的页头里有真按钮（标题 + 撑开的 spacer + 右侧 Refresh 按钮），
// 但整列**够不到窗口右缘**。这种情况必须不让位；否则按钮会被推到页面中间盖住标题。
{
  const e11 = makeEnv()   // VW = 1200
  const colW = 760
  const colLeft = Math.round((VW - colW) / 2)     // 220
  const colRight = colLeft + colW                 // 980
  // 页头标题（左端）
  e11.addWidget({ left: colLeft, right: colLeft + 190, top: 8, bottom: 44, width: 190, height: 36 })
  // 页头右侧那个 Refresh 按钮（真按钮，但在列的右端，不贴窗口右缘）
  e11.addWidget({ left: colRight - 80, right: colRight, top: 8, bottom: 44, width: 80, height: 36 })
  for (const s of captureScripts({ avoidAppButtons: true })) vm.runInContext(s, e11.sandbox)
  e11.flushTimers(200); e11.tickIntervals()
  const r24 = parseFloat(e11.button('dsh-dl-restart').style.right)
  check('S24 居中列页面（列右端有按钮但不贴窗口右缘）不让位', r24 === 10,
    `right=${r24}（列右缘=${colRight}，窗口右缘=${VW}）`)
}

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
