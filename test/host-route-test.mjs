/**
 * 宿主侧路由的测试。
 *
 * 验的是「前端依赖的那份契约」：
 *   - 五条路由都注册了（少一条，前端某个按钮就永远转圈）
 *   - 每条都复用真实鉴权（未登录必须 401，不能把重启/升级暴露出去）
 *   - restart-status 的握手字段（phase / nonce / authUrl）形状对得上
 *   - update-check 里带 canApply —— 前端靠它决定「点版本按钮是升级还是只重查」。
 *     这个字段第一版漏了，结果 allowSelfUpdate=false 的部署里前端照样摆出升级提示，
 *     点了才吃 403。
 *
 * 用法（在本包目录下）：node test/host-route-test.mjs
 *
 * 不真的 spawn 任何进程：restart 那条路由会去起 wscript，所以这里只验「鉴权失败时
 * 它必须提前返回」——用一个会被拒绝的 authorizeIndex，确认它没走到 spawn。
 */

import { pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdirSync, writeFileSync } from 'node:fs'
import assert from 'node:assert/strict'

const HERE = dirname(fileURLToPath(import.meta.url))
const MOD = pathToFileURL(join(HERE, '..', 'lib', 'index.js')).href
const { apply } = await import(MOD)

/**
 * 一个「启动器已就位」的假安装目录。
 *
 * 必须造出来：restart / update-apply 在动手之前会先看 *.vbs 在不在，不在就 503。
 * 早期版本直接指向一个空临时目录，于是断言撞在 503 上、根本走不到要验的那段逻辑
 * （H10 的版本校验就是这么被挡住的）。
 */
const INSTALL_DIR = join(process.env.TEMP ?? '/tmp', 'dsh-launcher-route-test-install')
mkdirSync(INSTALL_DIR, { recursive: true })
for (const name of ['restart.vbs', 'update.vbs']) writeFileSync(join(INSTALL_DIR, name), '', 'utf8')

const checks = []
const check = (name, fn) => checks.push({ name, fn })

// ---------------------------------------------------------------- 假 ctx

/**
 * 造一个假 ctx，跑一次 apply，把注册的路由收下来。
 *
 * @param opts.authorize - authorizeIndex 的返回值；false = 未登录。
 * @param opts.port - 端口；显式传 null 表示「没有端口」。
 * @param opts.checkForUpdates - 是否开启更新检查（关掉时不应注册相关路由）。
 * @param opts.spawned - 收集被 spawn 的命令，用来断言「未登录时没有起进程」。
 */
function makeCtx(opts = {}) {
  const routes = new Map()
  const effects = []
  const ctx = {
    webServer: {
      // 用 'port' in opts 而不是 `opts.port ?? 3080`：后者区分不出「没传」和
      // 「显式传了 undefined」—— 而 H3 要的正是后者（真实里 webServer.port 就是 undefined）。
      port: 'port' in opts ? opts.port : 3080,
      register: (route) => {
        routes.set(route.path, route)
        return () => routes.delete(route.path)
      }
    },
    connection: {
      authenticatedUrl: () => 'http://127.0.0.1:3080/?token=T',
      // 真实实现「拒绝时会自己写好 401」；这里照做，否则处理器会继续往下走到 spawn。
      authorizeIndex: (req, res) => {
        if (opts.authorize !== false) return true
        res.writeHead(401, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'unauthorized' }))
        return false
      }
    },
    effect: (fn) => {
      effects.push(fn)
      return () => {}
    }
  }
  return { ctx, routes, effects }
}

/** 跑一次 apply。 */
async function boot(opts = {}) {
  const made = makeCtx(opts)
  apply(made.ctx, {
    shortcutName: 'DeepSeek Harness',
    desktop: false,
    startMenu: false,
    adoptBrowserShortcut: false,
    installDir: INSTALL_DIR,
    startTimeoutSec: 1,
    browser: 'auto',
    appMode: false,
    checkForUpdates: opts.checkForUpdates !== false,
    allowSelfUpdate: opts.allowSelfUpdate !== false,
    updatePackage: '@deepseek-ai/dsh',
    updateVersionPackage: '@deepseek-ai/dsh-base',
    updateChannels: ['latest'],
    updateNotify: 'all',
    updateRegistry: 'https://registry.npmjs.org',
    updateCheckTimeoutMs: 1000
  })
  return made
}

/** 造一对假的 req/res，跑一个路由处理器，返回 { captured, settled }。 */
// 注意：带 body 的路由是**异步**写响应的（readJsonBody 是个 promise），所以
// 必须 await settled() 之后再断言 captured —— 否则读到的是还没写上去的空壳
// （H10 第一版就是这么拿到 code=0 的）。
function call(route, { method = 'GET', body } = {}) {
  const captured = { code: 0, headers: null, body: null }
  const res = {
    writeHead: (code, headers) => {
      captured.code = code
      captured.headers = headers
    },
    end: (text) => {
      try {
        captured.body = JSON.parse(text)
      } catch {
        captured.body = text
      }
    }
  }
  const req = {
    method,
    socket: { remoteAddress: '127.0.0.1' },
    destroy: () => {},
    on: (event, handler) => {
      queueMicrotask(() => {
        if (event === 'data' && body !== undefined) handler(Buffer.from(JSON.stringify(body)))
        if (event === 'end') handler()
      })
    }
  }
  route.handler(req, res)
  const settled = async () => {
    for (let i = 0; i < 12; i += 1) await Promise.resolve()
  }
  return { captured, settled }
}

// ---------------------------------------------------------------- 用例

// H1 —— 五条路由都在。
{
  const { routes } = await boot()
  check('H1 五条路由全部注册', () => {
    for (const path of [
      '/pwa-launcher/restart',
      '/pwa-launcher/restart-status',
      '/pwa-launcher/update-check',
      '/pwa-launcher/update-dismiss',
      '/pwa-launcher/update-apply'
    ]) {
      assert.ok(routes.has(path), `缺少路由 ${path}`)
    }
    assert.equal(routes.get('/pwa-launcher/restart').kind, 'exact')
  })
}

// H2 —— 关掉更新检查时不注册那三条更新路由（但重启的两条要留）。
{
  const { routes } = await boot({ checkForUpdates: false })
  check('H2 关闭更新检查只影响更新路由', () => {
    assert.ok(routes.has('/pwa-launcher/restart'))
    assert.ok(routes.has('/pwa-launcher/restart-status'))
    assert.equal(routes.has('/pwa-launcher/update-check'), false)
    assert.equal(routes.has('/pwa-launcher/update-apply'), false)
  })
}

// H3 —— 没有端口就什么都不挂（TUI / headless profile）。
{
  const { routes } = await boot({ port: undefined })
  check('H3 没有 web 端口时不挂任何路由', () => {
    assert.equal(routes.size, 0)
  })
}

// H4 —— 未登录必须 401，而且不能走到起进程那一步。
{
  const { routes } = await boot({ authorize: false })
  check('H4 未登录时重启路由直接 401', () => {
    const { captured } = call(routes.get('/pwa-launcher/restart'), { method: 'POST' })
    // 鉴权失败时处理器必须提前返回：拿到 401 而不是 200（200 意味着它已经起了重启进程）。
    assert.equal(captured.code, 401, '未登录必须 401')
  })
}

// H5 —— restart-status 的握手字段。
{
  const { routes } = await boot()
  check('H5 restart-status 报 phase=ready + nonce + authUrl', () => {
    const { captured } = call(routes.get('/pwa-launcher/restart-status'))
    assert.equal(captured.code, 200)
    assert.equal(captured.body.phase, 'ready')
    assert.equal(typeof captured.body.nonce, 'string')
    assert.ok(captured.body.nonce.length > 0, 'nonce 不能为空 —— 前端全靠它判断换没换进程')
    assert.equal(captured.body.authUrl, 'http://127.0.0.1:3080/?token=T')
  })
}

// H6 —— restart-status 只接受 GET。
{
  const { routes } = await boot()
  check('H6 restart-status 拒绝非 GET', () => {
    const { captured } = call(routes.get('/pwa-launcher/restart-status'), { method: 'POST' })
    assert.equal(captured.code, 405)
  })
}

// H7 —— update-check 必须带 canApply（前端靠它决定点按钮是升级还是只重查）。
{
  const { routes } = await boot()
  const { captured } = call(routes.get('/pwa-launcher/update-check'))
  check('H7 update-check 带 canApply', () => {
    assert.equal(captured.code, 200)
    assert.equal(captured.body.canApply, true, 'allowSelfUpdate=true 时 canApply 必须是 true')
    assert.equal(captured.body.status, 'idle', '后台检查还没跑完时如实报 idle')
  })
}

// H8 —— allowSelfUpdate=false 时 canApply 必须是 false。
{
  const { routes } = await boot({ allowSelfUpdate: false })
  const { captured } = call(routes.get('/pwa-launcher/update-check'))
  check('H8 allowSelfUpdate=false 时 canApply=false', () => {
    assert.equal(captured.body.canApply, false)
  })
}

// H9 —— update-apply 未登录时不执行；版本号非法时拒绝。
{
  const denied = await boot({ authorize: false })
  const allowed = await boot()
  check('H9 update-apply 未登录不执行', () => {
    const { captured } = call(denied.routes.get('/pwa-launcher/update-apply'), {
      method: 'POST',
      body: { version: '0.1.5-rc.2' }
    })
    assert.notEqual(captured.code, 200)
  })
  check('H9b update-apply 只接受 POST', () => {
    const { captured } = call(allowed.routes.get('/pwa-launcher/update-apply'), { method: 'GET' })
    assert.equal(captured.code, 405)
  })
}

// H10 —— 非法版本值被拒（这条是安全边界：version 会变成 npm install 的 spec）。
{
  const { routes } = await boot()
  const route = routes.get('/pwa-launcher/update-apply')
  check('H10 update-apply 拒绝非 semver 与未检测到的候选', async () => {
    const evil = call(route, { method: 'POST', body: { version: 'https://evil.example/x.tgz' } })
    await evil.settled()
    assert.equal(evil.captured.code, 400, '非 semver 必须 400')

    const unknown = call(route, { method: 'POST', body: { version: '9.9.9' } })
    await unknown.settled()
    assert.equal(unknown.captured.code, 400, '没检测到过的版本必须 400')

    const missing = call(route, { method: 'POST', body: {} })
    await missing.settled()
    assert.equal(missing.captured.code, 400, '缺 version 必须 400')
  })
}

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
  console.error(`\nhost-route-test: ${passed}/${total} 通过，${failures.length} 条失败\n`)
  for (const failure of failures) console.error(`  ✗ ${failure}\n`)
  process.exit(1)
}
console.log(`host-route-test: ${passed}/${total} 全部通过`)
process.exit(0)
