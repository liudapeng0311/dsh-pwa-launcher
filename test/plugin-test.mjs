/**
 * 验证浏览器半边（lib/client.js）的形状与行为。
 *
 * 这里刻意不装 React / jsdom：本包没有第三方依赖，测试也不该为了跑一次就引入它们。
 * 做法是自己写一层够用的替身 —— createElement 返回可遍历的节点树，useState/useEffect/useRef
 * 在 render 期间同步落实（效果在 render 后冲刷一次），于是「点了会怎样」是可断言的。
 *
 * 验的是**真正会被浏览器加载的那个文件**（lib/client.js），不是我对源文件的复述。
 *
 * 用法（在本包目录下）：node test/plugin-test.mjs
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import vm from 'node:vm'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')

/**
 * 断言包装。
 *
 * 必须支持异步：这个文件的用例一半要走 promise（fetch 替身是异步的）。
 * 早期的版本是同步的，结果 `check('x', async () => {…})` 里抛的断言变成
 * 未处理的 rejection —— 测试照样报「全部通过」。别改回同步。
 */
const checks = []
function check(name, fn) {
  checks.push({ name, fn })
}

/** 冲刷微任务队列，让 fetch 替身的 then 链彻底跑完。 */
async function settle(times = 20) {
  for (let i = 0; i < times; i += 1) await Promise.resolve()
}

// ---------------------------------------------------------------- React 替身

/** 当前正在渲染的组件状态槽；render 期间由 useState/useEffect/useRef 读写。 */
let currentSlots = null
/** 本次 render 收集到的副作用（render 结束后冲刷）。 */
let pendingEffects = []

function createElement(type, props, ...children) {
  const flat = []
  for (const child of children) {
    if (Array.isArray(child)) flat.push(...child)
    else if (child !== null && child !== undefined && child !== false) flat.push(child)
  }
  // 函数组件要**当场调用**（真实 React 就是这么做的）。
  // 早期版本只把它原样塞进树里，于是「进度卡渲染出来没有」这类断言一直在看一个函数对象，
  // 永远为假 —— 一个不还原渲染语义的替身，会把整类 bug 藏起来。
  if (typeof type === 'function') return type({ ...(props ?? {}), children: flat })
  return { type, props: props ?? {}, children: flat }
}

function useState(initial) {
  assert.ok(currentSlots !== null, 'useState 只能在 render 期间调用')
  const index = currentSlots.cursor
  currentSlots.cursor += 1
  if (!(index in currentSlots.values)) currentSlots.values[index] = typeof initial === 'function' ? initial() : initial
  // 必须读 currentSlots 而不是捕获当时的对象：effect 是在 render 外面冲刷的
  // （见 flush），那会儿 currentSlots 已经还原。捕获的话 setState 会指向 null。
  const setState = (next) => {
    if (currentSlots === null) return
    currentSlots.values[index] = typeof next === 'function' ? next(currentSlots.values[index]) : next
  }
  return [currentSlots.values[index], setState]
}

function useEffect(fn, deps) {
  assert.ok(currentSlots !== null, 'useEffect 只能在 render 期间调用')
  const index = currentSlots.cursor
  currentSlots.cursor += 1
  const previous = currentSlots.effects[index]
  const changed = previous === undefined || deps === undefined || previous.deps === undefined ||
    deps.length !== previous.deps.length || deps.some((dep, i) => !Object.is(dep, previous.deps[i]))
  if (!changed) return
  pendingEffects.push({ index, fn, deps })
}

function useRef(initial) {
  assert.ok(currentSlots !== null, 'useRef 只能在 render 期间调用')
  const index = currentSlots.cursor
  currentSlots.cursor += 1
  if (!(index in currentSlots.values)) currentSlots.values[index] = { current: initial }
  return currentSlots.values[index]
}

const ReactStub = { createElement, useState, useEffect, useRef }

// ---------------------------------------------------------------- DOM 替身

function makeDom() {
  const listeners = []
  return {
    visibilityState: 'visible',
    head: { appendChild: () => {} },
    createElement: () => ({ dataset: {}, textContent: '' }),
    querySelector: () => null,
    addEventListener: (type, fn) => listeners.push({ type, fn }),
    removeEventListener: (type, fn) => {
      const at = listeners.findIndex((entry) => entry.type === type && entry.fn === fn)
      if (at >= 0) listeners.splice(at, 1)
    },
    _listeners: listeners
  }
}

// ---------------------------------------------------------------- 沙箱

/**
 * 把 lib/client.js 跑进沙箱，返回截获到的模块契约。
 *
 * @param opts.fetch - fetch 替身；返回 { ok, status, json() }。
 * @param opts.nonce - window.__DSH_DL_NONCE__（本页所属进程的指纹）。
 * @param opts.confirm - window.confirm 的返回值。
 * @param opts.document - 自定义 document；默认一份空壳。
 */
function loadBundle(opts = {}) {
  const registered = []
  const dom = opts.document ?? makeDom()
  const calls = { fetch: [], confirm: 0, replace: [], timers: [], clearedTimers: [] }

  const win = {
    __ModuleLoader__: { load: (record) => registered.push(record) },
    __DSH_DL_NONCE__: opts.nonce,
    console,
    confirm: () => {
      calls.confirm += 1
      return opts.confirm === undefined ? true : opts.confirm
    },
    location: {
      origin: 'http://127.0.0.1:3080',
      replace: (url) => calls.replace.push(url)
    }
  }

  const sandbox = {
    document: dom,
    window: win,
    fetch: (path, init) => {
      calls.fetch.push({ path, init })
      return opts.fetch
        ? opts.fetch(path, init)
        : Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ status: 'idle' }) })
    },
    setTimeout: (fn, ms) => {
      calls.timers.push({ fn, ms })
      return calls.timers.length
    },
    clearTimeout: (id) => calls.clearedTimers.push(id)
  }

  // 浏览器里 window 和 globalThis 是**同一个**对象，沙箱必须照做。
  // 早期版本把它们搭成两个对象，于是 globalThis.__DSH_DL_NONCE__ 读到 undefined，
  // 让「nonce 未变不跳转」那条用例假装通过 —— 一个不忠于运行环境的替身，会替你把 bug 藏起来。
  sandbox.self = sandbox
  sandbox.globalThis = sandbox
  Object.assign(sandbox, win)
  win.window = sandbox
  win.document = dom
  sandbox.location = win.location
  sandbox.console = console

  vm.createContext(sandbox)
  vm.runInContext(readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8'), sandbox, { filename: 'lib/client.js' })

  assert.equal(registered.length, 1, 'lib/client.js 必须恰好注册一个模块')
  const record = registered[0]
  const mod = record.factory((spec) => {
    if (spec === 'react') return { ...ReactStub, default: ReactStub }
    throw new Error(`沙箱不提供模块：${spec}`)
  })
  return { record, mod, calls, dom, sandbox }
}

/** 造一个假的 ctx，记录 slot 注册、词典与 effect。 */
function makeCtx() {
  const state = { registered: [], injected: [], effects: [], locales: [], cleanups: [] }
  const ctx = {
    effect: (fn, label) => {
      // 真实 host 会**调用**这个回调，并保存它返回的清理函数。测试必须照做 ——
      // 早期版本只把回调记下来不执行，于是 ctx.locale.register 从未被调用，
      // 「词典注册」那条断言一直在验一个空集合。
      const cleanup = fn()
      state.effects.push({ label, cleanup })
      state.cleanups.push(cleanup)
      return () => {}
    },
    locale: {
      register: (ns, dicts) => {
        state.locales.push({ ns, dicts })
        return () => {}
      }
    },
    slots: {
      // 与 dsh 的 slots 服务同形：inject(名字, 回调) 返回 dispose；回调里 register。
      inject: (name, cb) => {
        state.injected.push(name)
        cb()
        return () => {}
      },
      register: (entry, Component) => {
        state.registered.push({ entry, Component })
        return () => {}
      }
    }
  }
  return { ctx, state }
}

/** 跑一个 effect 的清理函数。 */
function runCleanup(state, label) {
  const entry = state.effects.find((effect) => effect.label === label)
  assert.ok(entry, `没找到 effect：${label}`)
  if (typeof entry.cleanup === 'function') entry.cleanup()
}

/** 加载 + apply + 取出注册项，返回后续断言需要的一切。 */
function setup(opts = {}) {
  const bundle = loadBundle(opts)
  const made = makeCtx()
  bundle.mod.apply(made.ctx)
  const registration = made.state.registered[0]
  const injected = registration.entry.inject()
  return { ...bundle, ...made, registration, injected, controller: injected.controller }
}

/**
 * 渲染一棵元素树，返回 { tree, flush }。
 *
 * 参数是**元素**（createElement 的产物），不是组件：createElement 现在会当场调用
 * 函数组件，所以「调用组件」必须发生在 currentSlots 设好之后 —— 也就是在这里
 * 通过 createElement 走一遍，而不是自己调 element.type()。
 */
function render(element) {
  const slots = { cursor: 0, values: {}, effects: {} }
  const savedSlots = currentSlots
  const savedEffects = pendingEffects
  currentSlots = slots
  pendingEffects = []
  let tree
  try {
    tree = createElement(element.type, element.props, ...(element.children ?? []))
  } finally {
    currentSlots = savedSlots
  }
  const effects = pendingEffects
  pendingEffects = savedEffects
  const flush = () => {
    for (const { index, fn, deps } of effects) slots.effects[index] = { deps, cleanup: fn() }
  }
  return { tree, flush, slots }
}

/** 渲染注册的组件。t 默认回显键与参数，方便断言「用的是词典键」。 */
function renderControls(Component, injected, t) {
  const translate = t ?? ((key, params) => (params ? `${key}(${JSON.stringify(params)})` : key))
  // ⚠️ 这里不能写成 render(createElement(Component, ...))：createElement 现在会当场调用
  // 函数组件，那样 hooks 会跑在 render 设 currentSlots **之前**，直接抛
  // 「useState 只能在 render 期间调用」。交给 render 去建元素。
  return render({ type: Component, props: { ...injected, t: translate }, children: [] })
}

/** 在元素树里按 className 找第一个节点。 */
function find(node, className) {
  if (node === null || typeof node !== 'object') return null
  if (node.props?.className === className) return node
  for (const child of node.children ?? []) {
    const hit = find(child, className)
    if (hit !== null) return hit
  }
  return null
}

/** 取一个节点的全部文本。 */
function textOf(node) {
  if (typeof node === 'string') return node
  if (node === null || typeof node !== 'object') return ''
  return (node.children ?? []).map(textOf).join('')
}

/** 最后一个指定周期的定时器。 */
// 别用 timers.at(-1)：apply 时那次 update-check 会先排一个 4000ms 重试，
// 而 700ms 的才是重启/升级轮询。撞错了就会验错东西（S12 第一版就是这么挂的）。
function lastTimer(calls, ms) {
  const found = calls.timers.filter((timer) => timer.ms === ms)
  assert.ok(found.length > 0, `没有 ${ms}ms 的定时器`)
  return found[found.length - 1]
}

/**
 * 触发一个定时器并**等它的 promise 链跑完**。
 *
 * 早先用 settle()（空转若干微任务）来等，那是靠轮数赌链条长度 —— fetch 替身、
 * requestJson、then/catch 各占几跳都算在内，改一处实现就可能不够。
 * 我们的 setTimeout 替身是同步调用的，回调会把内部那个 promise 返回出来，直接 await 它。
 */
async function fire(timer) {
  const result = timer.fn()
  if (result && typeof result.then === 'function') await result
  await settle(4)
}

/** 胶囊元素（按钮的父节点）。 */
function clusterOf(tree) {
  const cluster = find(tree, 'dsh-launcher-cluster')
  assert.ok(cluster, '没找到 .dsh-launcher-cluster')
  return cluster
}

/** 胶囊里的按钮节点。 */
function buttonsOf(tree) {
  return (clusterOf(tree).children ?? []).filter((child) => child?.type === 'button')
}

/** 进度卡节点（没有动作时为 null）。 */
function cardOf(tree) {
  return find(tree, 'dsh-launcher-card')
}

/**
 * 选版卡里的候选项按钮。
 *
 * 必须递归找，不能只下一层：选版卡的 DOM 比进度卡多一层
 * （card → cardbox-wide → picks → 候选项），写死层数就会数出 0 个。
 */
function pickButtonsOf(card) {
  const out = []
  const walk = (node) => {
    if (node === null || typeof node !== 'object') return
    if (node.props?.className === 'dsh-launcher-pick') out.push(node)
    for (const child of node.children ?? []) walk(child)
  }
  walk(card)
  return out
}

/** 卡片底部的操作按钮（含主按钮与取消）。 */
function cardButtonsOf(card) {
  const out = []
  const walk = (node) => {
    if (node === null || typeof node !== 'object') return
    if (node.type === 'button' && String(node.props?.className ?? '').includes('dsh-launcher-cardbtn')) out.push(node)
    for (const child of node.children ?? []) walk(child)
  }
  walk(card)
  return out
}

/** 两个候选版本：V2 在更保守的通道，V3 在更激进的通道。 */
const V2 = '0.1.7-rc.1'
const V3 = '0.1.7-alpha.2'

/**
 * 一个「有两个候选」的 update-check 响应替身。
 * 宿主那边的推荐值是 newer 里第一个未忽略的 —— 也就是 V2。
 */
function multiCandidateFetch({ canApply = true } = {}) {
  return (path) => {
    if (path === '/pwa-launcher/update-check') {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({
          status: 'done',
          available: true,
          canApply,
          current: '0.1.5-rc.3',
          target: V2,
          channel: 'next',
          newer: [
            { channel: 'next', version: V2, ignored: false },
            { channel: 'alpha', version: V3, ignored: false }
          ]
        })
      })
    }
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) })
  }
}

// ---------------------------------------------------------------- 用例

// S1 —— 包形状。
check('S1 模块 id 与导出', () => {
  const { record, mod } = loadBundle()
  assert.equal(record.id, 'dsh-pwa-launcher')
  // 逐项比，不用 deepEqual：VM 里的数组和这里的数组跨 realm，原型不同。
  assert.equal(mod.inject.length, 2)
  assert.equal(mod.inject[0], 'slots')
  assert.equal(mod.inject[1], 'locale')
  assert.equal(typeof mod.apply, 'function')
  assert.equal(mod.apply.length, 1)
})

// S2 —— 样式幂等，id 稳定（HMR 去重靠它），视觉数值与 open-in-app 对齐。
check('S2 样式幂等且与分裂按钮同规格', () => {
  const appended = []
  const styles = []
  const dom = makeDom()
  dom.createElement = (tag) => {
    const el = { tag, dataset: {}, textContent: '' }
    return el
  }
  dom.head.appendChild = (tag) => {
    appended.push(tag)
    styles.push(tag)
  }
  dom.querySelector = (selector) => styles.find((tag) => selector.includes(tag.dataset.pluginCss)) ?? null
  const { mod } = loadBundle({ document: dom })
  mod.apply(makeCtx().ctx)
  mod.apply(makeCtx().ctx)

  assert.equal(appended.length, 1, `apply 两次应只插一份样式，实际 ${appended.length}`)
  assert.equal(appended[0].dataset.plugin, 'dsh-pwa-launcher')
  assert.equal(appended[0].dataset.pluginCss, 'dsh-launcher-controls-style')
  const css = appended[0].textContent
  assert.ok(css.includes('.dsh-launcher-cluster'))
  assert.ok(css.includes('height:28px'), '高度要与 open-in-app 的胶囊一致（28px）')
  assert.ok(css.includes('border-radius:14px'))
  assert.ok(css.includes('--dsw-alias-border-l4'), '边框走 dsh 设计变量，跟随主题')
  assert.ok(css.includes('--dsw-alias-interactive-bg-hover'), 'hover 也走设计变量')
})

// S3 —— 注册进 utilities 槽，locale 声明齐全。
check('S3 slot 注册与词典', () => {
  const { state } = setup()
  assert.equal(state.injected.length, 1)
  assert.equal(state.injected[0], 'conversation.session.header.utilities')
  assert.equal(state.registered.length, 1)
  const { entry, Component } = state.registered[0]
  assert.equal(entry.name, 'conversation.session.header.utilities')
  assert.equal(entry.id, 'pwa-launcher')
  assert.equal(entry.locale, 'pwa-launcher')
  assert.ok(entry.order > -10, '要排在 open-in-app（order -10）之后，才跟在它右边')
  assert.equal(typeof Component, 'function')

  assert.equal(state.locales.length, 1, 'apply 时必须真的注册词典（effect 回调要被调用）')
  const { ns, dicts } = state.locales[0]
  assert.equal(ns, 'pwa-launcher')
  const zhKeys = Object.keys(dicts.zh).sort()
  const enKeys = Object.keys(dicts.en).sort()
  assert.deepEqual(enKeys, zhKeys, 'en 与 zh 必须键完全一致，否则英文界面会缺字')
  assert.ok(zhKeys.length >= 20, `词典键太少（${zhKeys.length}）`)

  // 只比键集合是不够的 —— 它比不出「值是空串」和「两种语言占位符不一致」。
  // 前者渲染出一个空按钮，后者会把 {version} 原样显示给用户。两种都在真实界面上
  // 很难一眼发现，所以钉在这里。
  const empty = zhKeys.filter((key) => !String(dicts.zh[key]).trim() || !String(dicts.en[key]).trim())
  assert.deepEqual(empty, [], `有键的值为空：${empty.join(', ')}`)

  const placeholders = (text) => (String(text).match(/\{[a-zA-Z]+\}/g) ?? []).sort().join(',')
  const mismatched = zhKeys.filter((key) => placeholders(dicts.zh[key]) !== placeholders(dicts.en[key]))
  assert.deepEqual(mismatched, [], `中英占位符不一致：${mismatched.join(', ')}`)
})

// S4 —— 每次 apply 一份全新控制器；effect 会在 dispose 时停掉它。
check('S4 控制器随 apply 新建且可释放', () => {
  const first = setup()
  const second = setup()
  assert.notEqual(
    first.controller,
    second.controller,
    '每次 apply 都该拿一份全新控制器，避免 HMR 后旧轮询没停'
  )
  assert.equal(typeof first.controller.restart, 'function')
  assert.equal(typeof first.controller.recheck, 'function')

  const labels = first.state.effects.map((effect) => effect.label)
  assert.ok(labels.includes('pwa-launcher: controller'), `实际 labels: ${labels.join(', ')}`)
  assert.ok(labels.includes('pwa-launcher: dictionaries'))

  runCleanup(first.state, 'pwa-launcher: controller')
  assert.equal(first.controller.disposed, true, 'dispose 后控制器必须自断轮询')
})

// S5 —— apply 时就取一次更新状态。
check('S5 apply 触发一次 update-check 读取', async () => {
  const { calls } = setup()
  const hit = calls.fetch.find((call) => call.path === '/pwa-launcher/update-check')
  assert.ok(hit, 'apply 后应该已经请求过 /pwa-launcher/update-check')
  assert.notEqual(hit.init?.method, 'POST', '首次读取不是手动重查')
})

// S6 —— 渲染结构。
check('S6 结构与无障碍属性', () => {
  const { registration, injected } = setup()
  const { tree, flush } = renderControls(registration.Component, injected)
  flush()
  assert.equal(tree.type, 'div')
  assert.equal(tree.props.className, 'dsh-launcher-root')
  const buttons = buttonsOf(tree)
  assert.equal(buttons.length, 2, '应该正好两个按钮：重启 + 版本')
  assert.notEqual(find(tree, 'dsh-launcher-sep'), null, '两个按钮之间要有分隔线')
  for (const button of buttons) {
    assert.equal(button.props.type, 'button', 'type=button，免得在表单里提交')
    assert.equal(typeof button.props.title, 'string')
    assert.ok(button.props.title.length > 0)
    assert.equal(typeof button.props['aria-label'], 'string')
    assert.ok(button.props['aria-label'].includes(button.props.title))
  }
  assert.equal(cardOf(tree), null, '没有动作时不该渲染进度卡')
})

check('S6b 文案走词典键', () => {
  const { registration, injected } = setup()
  const { tree, flush } = renderControls(registration.Component, injected)
  flush()
  const labels = buttonsOf(tree).map(textOf)
  assert.ok(labels[0].includes('restart.label'), `第一个按钮应为重启，实际 ${labels[0]}`)
  assert.ok(labels[1].includes('update.'), `第二个按钮应为更新状态，实际 ${labels[1]}`)
})

check('S6c 挂上 visibilitychange，标签页解冻后能续上轮询', () => {
  const { registration, injected, dom } = setup()
  const { flush } = renderControls(registration.Component, injected)
  flush()
  assert.equal(dom._listeners.filter((entry) => entry.type === 'visibilitychange').length, 1)
  dom.visibilityState = 'hidden'
  dom._listeners.find((entry) => entry.type === 'visibilitychange').fn()
})

// S7 —— 取消确认就什么都不发。
check('S7 取消确认后不发重启请求', () => {
  const { registration, injected, calls } = setup({ confirm: false })
  const { tree, flush } = renderControls(registration.Component, injected)
  flush()
  buttonsOf(tree)[0].props.onClick()
  assert.equal(calls.confirm, 1, '点重启必须先确认')
  assert.equal(calls.fetch.filter((call) => call.path === '/pwa-launcher/restart').length, 0)
})

// S8 —— 确认后 POST，并安排轮询。
check('S8 确认后 POST 重启并安排轮询', async () => {
  const { registration, injected, calls } = setup({ confirm: true })
  const { tree, flush } = renderControls(registration.Component, injected)
  flush()
  buttonsOf(tree)[0].props.onClick()
  const post = calls.fetch.filter((call) => call.path === '/pwa-launcher/restart')
  assert.equal(post.length, 1)
  assert.equal(post[0].init?.method, 'POST')
  assert.equal(post[0].init?.credentials, 'same-origin', '宿主路由要带 cookie')
  await settle()
  // 注意别断言「第一个定时器」—— apply 时那次 update-check 会先排一个 4s 重试。
  // 要找的是重启轮询那一个。
  const poll = calls.timers.find((timer) => timer.ms === 700)
  assert.ok(poll, '应该安排了一次 restart-status 轮询')
})

// S9 —— 有新版时强调 + 带版本号。
check('S9 有新版时按钮强调且带版本号', async () => {
  const fetchStub = (path) => {
    if (path !== '/pwa-launcher/update-check') {
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) })
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({
        status: 'done', available: true, canApply: true, current: '0.1.5-rc.3', target: '0.2.0', newer: [{ version: '0.2.0' }]
      })
    })
  }
  const { registration, injected } = setup({ fetch: fetchStub })
  await settle()
  const { tree, flush } = renderControls(registration.Component, injected)
  flush()
  const versionBtn = buttonsOf(tree)[1]
  assert.equal(versionBtn.props['data-accent'], 'true')
  assert.ok(textOf(versionBtn).includes('0.2.0'), `文案里要有目标版本，实际 ${textOf(versionBtn)}`)
  assert.ok(versionBtn.props.title.includes('0.2.0'))
})

// S9b —— 有新版时点版本按钮 = 发起升级（确认后 POST update-apply）。
check('S9b 有新版时点击即为升级', async () => {
  const fetchStub = (path) => {
    if (path === '/pwa-launcher/update-check') {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({
          status: 'done', available: true, canApply: true, current: '0.1.5-rc.3', target: '0.2.0', newer: [{ version: '0.2.0' }]
        })
      })
    }
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) })
  }
  const { registration, injected, calls, controller } = setup({ fetch: fetchStub, confirm: true })
  await settle()
  const { tree, flush } = renderControls(registration.Component, injected)
  flush()
  buttonsOf(tree)[1].props.onClick()
  assert.equal(calls.confirm, 1, '升级前必须先确认')
  const post = calls.fetch.filter((call) => call.path === '/pwa-launcher/update-apply')
  assert.equal(post.length, 1)
  assert.equal(post[0].init?.method, 'POST')
  assert.equal(JSON.parse(post[0].init?.body).version, '0.2.0', '要把用户点的那个版本送过去')
  assert.equal(controller.action, 'upgrade')
})

// S9c —— canApply=false（只提醒模式）：点它只重新检查，绝不发起安装。
check('S9c 只提醒模式不发起安装', async () => {
  const fetchStub = (path) => {
    if (path === '/pwa-launcher/update-check') {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({
          status: 'done', available: true, canApply: false, current: '0.1.5-rc.3', target: '0.2.0', newer: [{ version: '0.2.0' }]
        })
      })
    }
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) })
  }
  const { registration, injected, calls, controller } = setup({ fetch: fetchStub, confirm: true })
  await settle()
  const { tree, flush } = renderControls(registration.Component, injected)
  flush()
  const versionBtn = buttonsOf(tree)[1]
  assert.equal(versionBtn.props['data-accent'], 'true', '仍然要强调，用户该知道有新版本')
  buttonsOf(tree)[1].props.onClick()
  assert.equal(calls.fetch.filter((call) => call.path === '/pwa-launcher/update-apply').length, 0, '只提醒模式下绝不能装')
  assert.equal(calls.confirm, 0, '不该弹升级确认')
  assert.equal(controller.action, null)
  assert.equal(
    calls.fetch.filter((call) => call.path === '/pwa-launcher/update-check' && call.init?.method === 'POST').length,
    1,
    '应该退化成「重新检查」'
  )
})

// S9f —— 候选不止一个时，点版本按钮打开选版卡（而不是直接升推荐的那个）。
check('S9f 多候选时打开选版卡', async () => {
  const { registration, injected, calls, controller } = setup({
    fetch: multiCandidateFetch(),
    confirm: true
  })
  await settle()
  const { tree, flush } = renderControls(registration.Component, injected)
  flush()
  buttonsOf(tree)[1].props.onClick()

  assert.equal(calls.confirm, 0, '多候选时不该直接弹升级确认')
  assert.equal(calls.fetch.filter((call) => call.path === '/pwa-launcher/update-apply').length, 0, '更不该直接开装')
  assert.equal(controller.phase, 'select')
  assert.equal(controller.action, 'select')

  const card = cardOf(renderControls(registration.Component, injected).tree)
  assert.ok(card, '应该渲染选版卡')
  const picks = pickButtonsOf(card)
  assert.equal(picks.length, 2, `候选两个就该列两行，实际 ${picks.length}`)
  assert.ok(textOf(picks[0]).includes(V2), `第一行应是 ${V2}`)
  assert.ok(textOf(picks[1]).includes(V3), `第二行应是 ${V3}`)
  assert.equal(picks[0].props['data-selected'], 'true', '默认选中宿主推荐的那个')
  assert.equal(picks[1].props['data-selected'], undefined)
})

// S9g —— 在卡里换一个版本，确认后装的是**选中的那个**。
check('S9g 选另一个版本后装的是它', async () => {
  const { registration, injected, calls, controller } = setup({
    fetch: multiCandidateFetch(),
    confirm: true
  })
  await settle()
  renderControls(registration.Component, injected).flush()
  buttonsOf(renderControls(registration.Component, injected).tree)[1].props.onClick()

  const card = cardOf(renderControls(registration.Component, injected).tree)
  pickButtonsOf(card)[1].props.onClick()
  assert.equal(controller.selectedVersion, V3, '点击第二行应把它设为选中')

  const afterPick = cardOf(renderControls(registration.Component, injected).tree)
  assert.ok(afterPick, '换选之后卡片应该还在（还在挑，没开装）')
  assert.equal(pickButtonsOf(afterPick)[1].props['data-selected'], 'true')
  assert.equal(pickButtonsOf(afterPick)[0].props['data-selected'], undefined)

  // 注意用 cardButtonsOf 而不是 find(…, '类名')：主按钮身上有两个 class，
  // 而 find 是按 className 全等比的，匹配不到。
  const confirm = cardButtonsOf(afterPick).find((b) => String(b.props.className).includes('cardbtn-primary'))
  assert.ok(confirm, '选版卡要有主按钮')
  confirm.props.onClick()
  assert.equal(calls.confirm, 1, '确认时仍要问一句')
  const post = calls.fetch.filter((call) => call.path === '/pwa-launcher/update-apply')
  assert.equal(post.length, 1)
  assert.equal(JSON.parse(post[0].init?.body).version, V3, '装的必须是用户选的那个版本')
  assert.equal(controller.action, 'upgrade')
})

// S9h —— 取消选版：什么都不发，回到空闲。
check('S9h 取消选版不发任何请求', async () => {
  const { registration, injected, calls, controller } = setup({ fetch: multiCandidateFetch(), confirm: true })
  await settle()
  renderControls(registration.Component, injected).flush()
  buttonsOf(renderControls(registration.Component, injected).tree)[1].props.onClick()

  const card = cardOf(renderControls(registration.Component, injected).tree)
  const cancel = cardButtonsOf(card).find((b) => textOf(b).includes('pick.cancel'))
  assert.ok(cancel, '选版卡要有取消按钮')
  cancel.props.onClick()

  assert.equal(controller.phase, 'idle')
  assert.equal(controller.selectedVersion, null)
  assert.equal(calls.fetch.filter((call) => call.path === '/pwa-launcher/update-apply').length, 0)
  assert.equal(calls.confirm, 0)
  assert.equal(cardOf(renderControls(registration.Component, injected).tree), null, '取消后卡片要消失')
})

// S9i —— 只提醒模式下多候选也不给选（选了也装不了）。
check('S9i 只提醒模式下多候选不给选版卡', async () => {
  const { registration, injected, calls, controller } = setup({
    fetch: multiCandidateFetch({ canApply: false }),
    confirm: true
  })
  await settle()
  const { tree, flush } = renderControls(registration.Component, injected)
  flush()
  buttonsOf(tree)[1].props.onClick()
  assert.equal(controller.phase, 'idle')
  assert.equal(calls.fetch.filter((call) => call.path === '/pwa-launcher/update-apply').length, 0)
  assert.equal(
    calls.fetch.filter((call) => call.path === '/pwa-launcher/update-check' && call.init?.method === 'POST').length,
    1,
    '应该退化成重新检查'
  )
})

// S9j —— 列表外的版本一律不接受（服务端也会拦，但界面不该先把脏值送出去）。
check('S9j 只接受候选列表里的版本', async () => {
  const { controller } = setup({ fetch: multiCandidateFetch() })
  await settle()
  controller.openPicker()
  assert.equal(controller.selectedVersion, V2, '默认选中推荐版本')

  assert.equal(controller.selectVersion('9.9.9'), false, '列表外的版本必须拒绝')
  assert.equal(controller.selectedVersion, V2, '拒绝后选中项不变')
  assert.equal(controller.selectVersion(V3), true)
  assert.equal(controller.selectedVersion, V3)
})

// S9k —— 选版卡开着的时候不算忙：重启按钮照常可用。
check('S9k 选版期间按钮不禁用', async () => {
  const { registration, injected, controller } = setup({ fetch: multiCandidateFetch() })
  await settle()
  renderControls(registration.Component, injected).flush()
  buttonsOf(renderControls(registration.Component, injected).tree)[1].props.onClick()
  assert.equal(controller.phase, 'select')
  assert.equal(controller.busy, false, '挑版本不是「进行中」，不该把按钮全禁掉')

  const { tree, flush } = renderControls(registration.Component, injected)
  flush()
  const buttons = buttonsOf(tree)
  assert.notEqual(buttons[0].props.disabled, true, '选版时重启按钮仍应可点')
  assert.notEqual(buttons[1].props.disabled, true, '再点一次版本按钮应该能收起卡片')
})

// S9l —— 再点一次版本按钮 = 收起选版卡。
check('S9l 再点版本按钮收起选版卡', async () => {
  const { registration, injected, controller } = setup({ fetch: multiCandidateFetch() })
  await settle()
  renderControls(registration.Component, injected).flush()
  buttonsOf(renderControls(registration.Component, injected).tree)[1].props.onClick()
  assert.equal(controller.phase, 'select')
  buttonsOf(renderControls(registration.Component, injected).tree)[1].props.onClick()
  assert.equal(controller.phase, 'idle')
  assert.equal(cardOf(renderControls(registration.Component, injected).tree), null)
})

// S9d —— 升级中要显示进度卡，而不是只有一个变灰的按钮。
check('S9d 升级中显示进度卡', async () => {
  const { registration, injected, controller } = setup({ nonce: 'old' })
  // 先渲染一次让组件把订阅接上，再改状态、再渲染 —— 这套替身没有重渲染机制，
  // 所以「状态变化后长什么样」必须靠重新渲染来观察。
  renderControls(registration.Component, injected).flush()
  controller.setAction('upgrade', 'waiting', null, '0.2.0')
  const { tree, flush } = renderControls(registration.Component, injected)
  flush()
  const card = cardOf(tree)
  assert.ok(card, '升级中应该渲染进度卡')
  const text = textOf(card)
  assert.ok(text.includes('action.upgrade.title'), `标题应是升级中，实际 ${text}`)
  assert.ok(text.includes('0.2.0'), '标题里要带目标版本')
  assert.ok(text.includes('action.waiting'))
  const buttons = buttonsOf(tree)
  assert.equal(buttons[0].props.disabled, true, '进行中重启按钮要禁用')
  assert.equal(buttons[1].props.disabled, true, '进行中版本按钮要禁用')
})

// S9e —— 失败时卡片给出原因并可以收起。
check('S9e 失败卡片可收起', async () => {
  const { registration, injected, controller } = setup()
  renderControls(registration.Component, injected).flush()
  controller.setAction('upgrade', 'error', 'server', 'HTTP 400')
  const first = renderControls(registration.Component, injected)
  first.flush()
  const text = textOf(cardOf(first.tree))
  assert.ok(text.includes('action.failed.title'), `应是失败标题，实际 ${text}`)
  assert.ok(text.includes('HTTP 400'), '要把服务端的理由带出来')

  const dismiss = find(cardOf(first.tree), 'dsh-launcher-cardbtn')
  assert.ok(dismiss, '失败卡要有一个收起按钮')
  dismiss.props.onClick()
  const second = renderControls(registration.Component, injected)
  second.flush()
  assert.equal(cardOf(second.tree), null, '收起后卡片应该消失')
})

// S10 —— 未就绪时自己重试。
check('S10 未就绪时安排重试', async () => {
  const { calls } = setup({
    fetch: () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ status: 'checking' }) })
  })
  await settle()
  const retry = calls.timers.find((timer) => timer.ms === 4000)
  assert.ok(retry, '应该安排一次 4s 后的重试，否则页面会永远停在「检查…」')
})

// S11 —— 401 = 登录态失效，不是网络问题。
check('S11 401 被识别为登录失效', async () => {
  const { controller } = setup({
    fetch: () => Promise.resolve({ ok: false, status: 401, json: () => Promise.resolve({}) })
  })
  await controller.restart()
  assert.equal(controller.phase, 'error')
  assert.equal(controller.failure, 'unauthorized')
  assert.equal(controller.action, 'restart')
})

// S11b —— 网络不通是另一档提示。
check('S11b 连不上服务时报 offline', async () => {
  const { controller } = setup({
    fetch: () => Promise.reject(new Error('ECONNREFUSED'))
  })
  await controller.restart()
  assert.equal(controller.phase, 'error')
  assert.equal(controller.failure, 'server')
})

// S11c —— 服务端拒绝升级时把它的理由带出来（比如版本号不在候选里）。
check('S11c 升级被拒时带上服务端理由', async () => {
  const { controller } = setup({
    fetch: (path) => {
      if (path === '/pwa-launcher/update-apply') {
        return Promise.resolve({
          ok: false,
          status: 400,
          json: () => Promise.resolve({ error: '只能更新到已检测到的候选版本' })
        })
      }
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) })
    }
  })
  await controller.upgrade('9.9.9')
  assert.equal(controller.action, 'upgrade')
  assert.equal(controller.phase, 'error')
  assert.equal(controller.failure, 'server')
  assert.ok(String(controller.failureDetail).includes('400'))
})

// S12 —— 换进程 + ready 才跳转。
check('S12 换进程并就绪后跳回带令牌地址', async () => {
  const responses = [
    { phase: 'restarting', nonce: 'old' },
    { phase: 'ready', nonce: 'new', authUrl: 'http://127.0.0.1:3080/?token=abc' }
  ]
  let at = 0
  const { controller, calls } = setup({
    nonce: 'old',
    fetch: (path) => {
      if (path !== '/pwa-launcher/restart-status') {
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) })
      }
      const body = responses[Math.min(at, responses.length - 1)]
      at += 1
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) })
    }
  })
  await controller.restart()
  await settle()
  // 第一拍：老进程还在（restarting）
  await fire(lastTimer(calls, 700))
  // 第二拍：新进程 ready —— 这时只进入 reconnecting，真正的跳转还压着一个短延迟，
  // 免得撞上新进程刚 ready 还没准备好接客的那一瞬间。
  await fire(lastTimer(calls, 700))
  assert.equal(controller.phase, 'reconnecting')
  assert.deepEqual(calls.replace, [], '刚 ready 时还不该跳，先等一下')

  // 延迟到点才真的跳，而且用的是服务端给的带令牌地址。
  const reconnect = calls.timers.filter((timer) => timer.ms === 300).at(-1)
  assert.ok(reconnect, '应该安排一次延迟跳转')
  await fire(reconnect)
  assert.deepEqual(calls.replace, ['http://127.0.0.1:3080/?token=abc'])
})

// S13 —— 老进程还活着时报 ready，不能被误判成完成。
check('S13 nonce 未变则不跳转，继续轮询', async () => {
  const { controller, calls } = setup({
    nonce: 'same',
    fetch: (path) => {
      if (path !== '/pwa-launcher/restart-status') {
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) })
      }
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ phase: 'ready', nonce: 'same' }) })
    }
  })
  await controller.restart()
  await settle()
  const before = calls.timers.filter((t) => t.ms === 700).length
  await fire(lastTimer(calls, 700))
  assert.equal(calls.replace.length, 0, 'nonce 没变就不是新进程，绝不能跳转')
  assert.notEqual(controller.restartPhase, 'reconnecting')
  assert.ok(calls.timers.filter((t) => t.ms === 700).length > before, '要继续轮询，而不是停在半路')
})

// S14 —— 超时要收手，不能无限轮询。
check('S14 超过总时长后停在超时态', async () => {
  const { controller, calls } = setup({
    nonce: 'old',
    fetch: (path) => {
      if (path !== '/pwa-launcher/restart-status') {
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) })
      }
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ phase: 'restarting', nonce: 'old' }) })
    }
  })
  await controller.restart()
  await settle()
  const before = calls.timers.filter((t) => t.ms === 700).length
  controller.startedAt = Date.now() - 200000
  await fire(lastTimer(calls, 700))
  assert.equal(controller.phase, 'timeout')
  assert.equal(calls.timers.filter((t) => t.ms === 700).length, before, '超时后不该再安排下一次轮询')
})

// S14b —— 超时后允许重新发起（否则用户被卡在一个死掉的按钮上）。
check('S14b 超时后可以再发一次', async () => {
  let restarts = 0
  const { controller, calls } = setup({
    nonce: 'old',
    fetch: (path) => {
      if (path === '/pwa-launcher/restart') {
        restarts += 1
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) })
      }
      if (path === '/pwa-launcher/restart-status') {
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ phase: 'restarting', nonce: 'old' }) })
      }
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) })
    }
  })
  await controller.restart()
  await settle()
  controller.startedAt = Date.now() - 200000
  await fire(lastTimer(calls, 700))
  assert.equal(controller.phase, 'timeout')
  assert.equal(restarts, 1)

  await controller.restart()
  assert.equal(restarts, 2, '超时后应该能再发一次重启')
  assert.equal(controller.action, 'restart')
  assert.ok(controller.busy, `第二次发起后应处于进行中，实际 ${controller.phase}`)
})

// S14c —— 失败提示可以收起，收完回到空闲。
check('S14c dismiss 回到空闲', async () => {
  const { controller } = setup({
    fetch: () => Promise.reject(new Error('ECONNREFUSED'))
  })
  await controller.restart()
  assert.equal(controller.phase, 'error')
  controller.dismiss()
  assert.equal(controller.phase, 'idle')
  assert.equal(controller.action, null)
})

// S14d —— 进行中不允许重复发起（连点两次不能变成两次重启）。
check('S14d 进行中拒绝重复发起', async () => {
  let posts = 0
  const { controller } = setup({
    nonce: 'old',
    fetch: (path) => {
      if (path === '/pwa-launcher/restart') {
        posts += 1
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) })
      }
      if (path === '/pwa-launcher/restart-status') {
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ phase: 'restarting', nonce: 'old' }) })
      }
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) })
    }
  })
  await controller.restart()
  await controller.restart()
  await controller.restart()
  await settle()
  assert.equal(posts, 1, '连点三次只该发一次重启请求')
})

// S15 —— 页面切回前台时能续上被冻结的轮询。
check('S15 resume 会重新踢起轮询', async () => {
  const { controller, calls } = setup({
    nonce: 'old',
    fetch: (path) => {
      if (path !== '/pwa-launcher/restart-status') {
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) })
      }
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ phase: 'restarting', nonce: 'old' }) })
    }
  })
  await controller.restart()
  await settle()
  const before = calls.timers.filter((t) => t.ms === 700).length
  controller.resume()
  await settle()
  assert.ok(calls.timers.filter((t) => t.ms === 700).length > before, 'resume 后应该又安排了一次轮询')
})

// ---------------------------------------------------------------- 结果

let passed = 0
const failures = []
for (const { name, fn } of checks) {
  try {
    await fn()
    passed += 1
  } catch (error) {
    failures.push(`${name}\n    ${String(error.stack ?? error.message).split('\n').slice(0, 4).join('\n    ')}`)
  }
}

const total = passed + failures.length
if (failures.length > 0) {
  console.error(`\nplugin-test: ${passed}/${total} 通过，${failures.length} 条失败\n`)
  for (const failure of failures) console.error(`  ✗ ${failure}\n`)
  process.exit(1)
}
console.log(`plugin-test: ${passed}/${total} 全部通过`)
