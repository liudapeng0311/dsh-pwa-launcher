/**
 * version.js —— 更新检查的纯逻辑（第一期：只查不改）。
 *
 * 职责边界（很重要）：本模块**只读**。它读当前正在运行的 dsh 版本、查 npm registry、
 * 比较并判断「有没有可用的新版本」，仅此而已。它绝不 npm install、不碰安装目录、
 * 不写任何用户文件。真正「换版本」是第二期的事，而且按设计必须由外部脚本
 * （先停掉正在跑的 dsh）来做，不在进程内动自己。
 *
 * 只用 node 内置模块（https / fs / path），不 import 任何 @deepseek-ai/* ——
 * 与插件其它部分保持一致，避免不同安装方式下的解析路径问题。
 *
 * @module pwa-launcher/version
 */

import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import https from 'node:https'

/**
 * 解析 semver（支持 -prerelease 与 +build）。不合法返回 null。
 * 例：0.1.5-rc.1 → { major:0, minor:1, patch:5, prerelease:['rc','1'], hasPrerelease:true }
 */
export function parseSemver(input) {
  if (typeof input !== 'string') return null
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/.exec(input.trim())
  if (!m) return null
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] ? m[4].split('.') : [],
    hasPrerelease: Boolean(m[4]),
    build: m[5] || ''
  }
}

function comparePreIdent(a, b) {
  const aNum = /^\d+$/.test(a)
  const bNum = /^\d+$/.test(b)
  if (aNum && bNum) {
    const d = Number(a) - Number(b)
    return d < 0 ? -1 : d > 0 ? 1 : 0
  }
  if (aNum) return -1 // 数字标识符优先级低于字母标识符
  if (bNum) return 1
  return a < b ? -1 : a > b ? 1 : 0 // 纯字母按 ASCII
}

/**
 * semver 2.0 优先级比较：a>b 返回 1，a<b 返回 -1，相等返回 0。
 * 解析不了的输入退回字符串比较（够用，且不至于抛异常）。
 */
export function compareSemver(a, b) {
  const pa = parseSemver(a)
  const pb = parseSemver(b)
  if (!pa || !pb) {
    if (a === b) return 0
    return a > b ? 1 : -1
  }
  for (const key of ['major', 'minor', 'patch']) {
    if (pa[key] !== pb[key]) return pa[key] > pb[key] ? 1 : -1
  }
  // 主/次/补丁相同：带预发布号的一方优先级更低（正式版 > 同版本的预发布）
  if (!pa.hasPrerelease && !pb.hasPrerelease) return 0
  if (!pa.hasPrerelease) return 1
  if (!pb.hasPrerelease) return -1
  const len = Math.max(pa.prerelease.length, pb.prerelease.length)
  for (let i = 0; i < len; i += 1) {
    const xa = pa.prerelease[i]
    const xb = pb.prerelease[i]
    if (xa === undefined) return -1 // 预发布段更短 → 优先级更低
    if (xb === undefined) return 1
    if (xa !== xb) return comparePreIdent(xa, xb)
  }
  return 0
}

/**
 * 读「当前正在运行的 dsh」版本号。
 *
 * 依据是 dsh 的入口文件（process.argv[1]，形如 .../@deepseek-ai/dsh/lib/bin.js）：
 * 它同包目录里的 package.json 就是这份安装的真实版本，不受 PATH / 链接布局影响。
 * 读不到就返回 null（调用方据此安静跳过）。
 */
export async function readInstalledVersion(entryPath) {
  if (!entryPath) return null
  const pkgPath = resolve(dirname(entryPath), '..', 'package.json')
  try {
    const json = JSON.parse(await readFile(pkgPath, 'utf8'))
    return typeof json?.version === 'string' ? json.version : null
  } catch {
    return null
  }
}

/**
 * 读「用户实际运行的 harness 版本」= 从运行入口解析到的应用核心包（默认
 * `@deepseek-ai/dsh-base`）的安装版本。
 *
 * 为什么不用 CLI 包 @deepseek-ai/dsh 自己的版本：那个只是启动器壳（npm 精锁），
 * 真正跑起来的应用由 dsh-base / dsh-web-app 这类 bundle 决定，它们是 caret 浮动解析的，
 * 版本可以和壳不一致（比如壳停在 rc.1、应用已经解析到 rc.2）。用 createRequire 从入口
 * 解析走的是 Node 标准解析（含 pnpm 软链），不猜目录布局；解析不到返回 null，
 * 由调用方回退到 CLI 版本。
 */
export async function resolveAppVersion(entryPath, pkgName = '@deepseek-ai/dsh-base') {
  if (!entryPath) return null
  let entry
  try {
    entry = createRequire(entryPath).resolve(pkgName)
  } catch {
    return null
  }
  let dir = dirname(entry)
  for (let i = 0; i < 8; i += 1) {
    try {
      const json = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'))
      if (json.name === pkgName && typeof json.version === 'string') return json.version
    } catch {
      // 这一层不是目标包，继续往上
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

function httpsGetJson(url, { timeoutMs = 8000 } = {}) {
  return new Promise((res, rej) => {
    const req = https.get(
      url,
      {
        headers: {
          // corgi（精简元数据）：含 dist-tags，去掉 README 等大字段，比完整 packument 轻很多
          accept: 'application/vnd.npm.install-v1+json',
          'user-agent': 'dsh-pwa-launcher'
        },
        // node core 的 https 不读 http_proxy 环境变量，所以这里是**绕过系统代理直连**
        // registry —— 需要走代理才能访问 npm 的环境下要留意这一点。
        timeout: timeoutMs
      },
      (resp) => {
        const status = resp.statusCode || 0
        if (status < 200 || status >= 300) {
          resp.resume()
          rej(new Error(`HTTP ${status}`))
          return
        }
        let body = ''
        resp.setEncoding('utf8')
        resp.on('data', (chunk) => { body += chunk })
        resp.on('end', () => {
          try { res(JSON.parse(body)) } catch { rej(new Error('registry 响应不是合法 JSON')) }
        })
      }
    )
    req.on('timeout', () => { req.destroy(new Error(`请求超时 ${timeoutMs}ms`)) })
    req.on('error', rej)
  })
}

/**
 * 查 registry 的 dist-tags（latest / next / alpha …）。
 * registry 允许带尾斜杠；scoped 包名要按 npm 规则编码（@scope%2Fname）。
 */
export async function fetchDistTags(pkgName, { registry = 'https://registry.npmjs.org', timeoutMs = 8000 } = {}) {
  const base = registry.replace(/\/+$/, '')
  const encoded = pkgName.startsWith('@')
    ? `@${encodeURIComponent(pkgName.slice(1))}`
    : encodeURIComponent(pkgName)
  const doc = await httpsGetJson(`${base}/${encoded}`, { timeoutMs })
  const tags = doc && typeof doc['dist-tags'] === 'object' ? doc['dist-tags'] : {}
  return tags
}

/**
 * 这个值能不能当一个版本号用 —— parseSemver 的自然语言别名。
 * 凡是要把一个来自远端的字符串当成版本号使的地方（比较、拼 npm spec），先用它挡一道。
 * @param input - 待判定的值，可以是任意类型。
 * @returns 是合法 semver 时为 true。
 */
export function looksLikeVersion(input) {
  return parseSemver(input) !== null
}

/**
 * 列出所有「严格比 current 新」的通道版本，按 channels 给定的顺序（保守 → 激进）。
 * 同一版本被多个通道指向时只保留第一个（更保守那个）。current 缺失/非法 → 空数组。
 *
 * ⚠️ 两端都必须是合法 semver，否则一律不列。dist-tags 的值来自远端 registry，是**不可信输入**：
 * 它不是 semver 时 compareSemver 会退回字符串比较，于是 `https://…/x.tgz` 这类字符串排序上
 * 就能「比当前版本新」而混进候选；候选会一路走到 update.ps1 的 `npm install <包>@<值>`，
 * 而 npm 接受 file: / https://…tgz 形式的 spec —— 等于让 registry 决定用户机器上装什么。
 * 在这里挡掉，比在下游每一步都记得校验可靠。
 */
export function listNewer(current, tags, channels = ['latest', 'next', 'alpha']) {
  if (!current || !tags) return []
  if (!looksLikeVersion(current)) return [] // 当前版本本身读歪了：没有可比的基准，不是「有更新」
  const out = []
  const seen = new Set()
  for (const ch of channels) {
    const v = tags[ch]
    if (typeof v !== 'string' || seen.has(v)) continue
    seen.add(v)
    if (!looksLikeVersion(v)) continue // 非 semver 直接丢，不进候选、不落状态
    if (compareSemver(v, current) > 0) out.push({ channel: ch, version: v })
  }
  return out
}

/**
 * 跨通道判断有没有可提醒的更新（第一期：只查不改）。返回统一结构：
 *   { ok, current, target, channel, newer[], distTags, available, error, checkedAt }
 *
 * - newer：所有比 current 新的通道版本（notify=recommended-only 时只留 channels[0]），
 *   每项 { channel, version, ignored }，顺序保守 → 激进。
 * - target / channel：newer 里第一个「未被忽略」的 = 徽标推荐值（最保守的可更新项）。
 * - available：是否存在至少一个未忽略的较新版本。
 * - notify=recommended-only：只看主通道（channels[0]，默认 latest），不拿 rc/alpha 骚扰稳定用户。
 * - fetchTags 供测试注入假的，线上走 fetchDistTags。
 * - attempts：网络抖动的重试次数（默认 3）。**这条是必须的**：到 npm 的连接会偶发
 *   超时/ECONNRESET（并发请求时尤其明显），而检查每个进程只跑一次；
 *   没有重试的话，一次瞬时抖动就会让界面长期显示「未查到」，看起来像功能坏了。
 *   重试只针对网络类错误，HTTP 4xx（比如包名不存在）不重试 —— 那是确定性失败。
 */
export async function checkForUpdate(opts = {}) {
  const {
    pkgName = '@deepseek-ai/dsh',
    channels = ['latest', 'next', 'alpha'],
    notify = 'all',
    ignored = [],
    current = null,
    registry = 'https://registry.npmjs.org',
    timeoutMs = 8000,
    attempts = 3,
    fetchTags = fetchDistTags
  } = opts

  const checkedAt = new Date().toISOString()
  const ignoredSet = new Set(Array.isArray(ignored) ? ignored : [])
  const base = { current, checkedAt, distTags: {}, newer: [], target: null, channel: null, available: false }

  if (!current) {
    return { ...base, ok: false, error: '无法确定当前 dsh 版本' }
  }

  // 当前版本不是合法 semver 时，比较本身就没有意义（会退回字符串比较），
  // 而且候选会被拿去当 npm 安装的 spec。宁可报「查不了」，也不给一串不可信的候选。
  if (!looksLikeVersion(current)) {
    return { ...base, ok: false, error: `当前版本号不是合法 semver（${String(current)}），已跳过比较` }
  }

  // 带重试地取 dist-tags。退避 400ms / 1200ms —— 启动高峰通常几百毫秒就过去了。
  let tags = null
  let lastError = null
  let used = 0
  const tries = Math.max(1, attempts)
  for (let i = 0; i < tries; i += 1) {
    used = i + 1
    try {
      tags = await fetchTags(pkgName, { registry, timeoutMs })
      lastError = null
      break
    } catch (error) {
      lastError = error
      // HTTP 4xx = 确定性失败（包名错、源不对），重试没意义，直接报错
      if (/^HTTP 4\d\d$/.test(String(error?.message ?? ''))) break
      if (i < tries - 1) await new Promise((r) => setTimeout(r, i === 0 ? 400 : 1200))
    }
  }
  if (lastError || !tags) {
    const msg = String(lastError?.message ?? lastError ?? '未知错误')
    // 只在「真的重试过」时才加这个后缀 —— 否则会误导（HTTP 4xx 那次并没重试）
    return { ...base, ok: false, error: used > 1 ? `${msg}（已重试 ${used} 次）` : msg }
  }

  let newer = listNewer(current, tags, channels)
  if (notify === 'recommended-only') newer = newer.filter((n) => n.channel === channels[0])
  newer = newer.map((n) => ({ ...n, ignored: ignoredSet.has(n.version) }))

  const active = newer.find((n) => !n.ignored) || null
  return {
    ...base,
    distTags: tags,
    newer,
    target: active ? active.version : null,
    channel: active ? active.channel : null,
    available: Boolean(active),
    ok: true,
    error: null
  }
}
