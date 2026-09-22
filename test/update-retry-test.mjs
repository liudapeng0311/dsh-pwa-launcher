// 验证 checkForUpdate 的重试逻辑 + dist-tags 的 semver 白名单。
// 起因：实测到 npm 的连接会偶发超时/ECONNRESET，而更新检查一次只跑一遍 ——
// 没有重试时，一次瞬时抖动就让界面长期显示「未查到」。
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
// 相对本文件解析，不要写绝对路径：写死自己的检出目录会让 `npm test`
// 在别人的机器和 CI 上直接 ERR_MODULE_NOT_FOUND。
const v = await import(pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'version.js')).href)

let fails = 0
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
  if (!ok) fails++
}
const TAGS = { latest: '0.1.5-rc.2', next: '0.1.5-rc.2', alpha: '0.1.6-alpha.2' }
const base = { pkgName: '@deepseek-ai/dsh', current: '0.1.5-rc.1', channels: ['latest', 'next', 'alpha'], notify: 'all' }

// 1) 第一次失败、第二次成功 -> 应该成功（这就是本次修复的核心）
{
  let n = 0
  const r = await v.checkForUpdate({
    ...base,
    fetchTags: async () => { n += 1; if (n === 1) throw new Error('read ECONNRESET'); return TAGS }
  })
  check('首次 ECONNRESET 后重试成功', r.ok === true && n === 2, `ok=${r.ok} 调用次数=${n} target=${r.target}`)
}

// 2) 前两次都失败、第三次成功
{
  let n = 0
  const r = await v.checkForUpdate({
    ...base,
    fetchTags: async () => { n += 1; if (n <= 2) throw new Error('请求超时 12000ms'); return TAGS }
  })
  check('连续两跳失败后第三次成功', r.ok === true && n === 3, `ok=${r.ok} 调用次数=${n}`)
}

// 3) 三次都失败 -> 明确失败，且错误里带上「已重试」
{
  let n = 0
  const r = await v.checkForUpdate({
    ...base,
    fetchTags: async () => { n += 1; throw new Error('read ECONNRESET') }
  })
  check('全失败时如实报错并说明重试过',
    r.ok === false && n === 3 && /已重试/.test(r.error), `ok=${r.ok} 次数=${n} error=${r.error}`)
}

// 4) HTTP 4xx 是确定性失败，不该重试（白等），也不该谎称重试过
{
  let n = 0
  const r = await v.checkForUpdate({
    ...base,
    fetchTags: async () => { n += 1; throw new Error('HTTP 404') }
  })
  check('HTTP 404 不重试且不谎称重试', r.ok === false && n === 1 && !/已重试/.test(r.error),
    `次数=${n} error=${r.error}`)
}

// 5) attempts=1 可关掉重试（供测试/特殊场景）
{
  let n = 0
  await v.checkForUpdate({ ...base, attempts: 1, fetchTags: async () => { n += 1; throw new Error('x') } })
  check('attempts=1 时只请求一次', n === 1, `次数=${n}`)
}

// 6) 正常路径不受影响：仍能算出 available / target
//    注意 target 取的是「最保守的可更新项」= channels 顺序里第一个比 current 新的，
//    这里 latest(0.1.5-rc.2) 就比 current(0.1.5-rc.1) 新，所以推荐它而不是 alpha。
{
  const r = await v.checkForUpdate({ ...base, fetchTags: async () => TAGS })
  check('正常路径结果不变', r.ok === true && r.available === true && r.target === '0.1.5-rc.2',
    `target=${r.target} available=${r.available} newer=${r.newer.length}`)
  check('正常路径两个通道都列出', r.newer.length === 2, `newer=${JSON.stringify(r.newer.map((n) => n.version))}`)
}

// 7) 当前版本未知时不该去请求网络
{
  let n = 0
  const r = await v.checkForUpdate({ ...base, current: null, fetchTags: async () => { n += 1; return TAGS } })
  check('读不到当前版本时不请求网络', r.ok === false && n === 0, `次数=${n} error=${r.error}`)
}

// 8) dist-tags 是不可信输入：非 semver 的值不能变成候选。
//    这不是洁癖 —— 候选会一路走到 update.ps1 的 `npm install <包>@<值>`，
//    而 npm 接受 file: / https://…tgz 形式的 spec。
{
  const r = await v.checkForUpdate({
    ...base,
    fetchTags: async () => ({ latest: 'https://evil.example/x.tgz', next: null, alpha: 42 })
  })
  check('非 semver 的 dist-tag 不进候选', r.ok === true && r.available === false && r.newer.length === 0,
    `available=${r.available} newer=${JSON.stringify(r.newer.map((n) => n.version))}`)
}

// 9) 恶意值排在一个合法候选前面时，只丢它一个，合法候选照常给出
{
  const r = await v.checkForUpdate({
    ...base,
    // 字符串排序上 'z…' 会「大于」0.1.5-rc.1，旧逻辑下它会混进来
    fetchTags: async () => ({ latest: 'zzz-not-a-version', next: '0.1.5-rc.2', alpha: '0.1.6-alpha.2' })
  })
  check('恶意值被丢弃、合法候选不受影响',
    r.ok === true && r.newer.length === 2 && r.target === '0.1.5-rc.2',
    `target=${r.target} newer=${JSON.stringify(r.newer.map((n) => n.version))}`)
}

// 10) 当前版本本身不是合法 semver 时：不去比较，也不给候选（退回字符串比较会误报）
{
  const r = await v.checkForUpdate({ ...base, current: 'not-a-version', fetchTags: async () => TAGS })
  check('当前版本非法时跳过比较', r.ok === false && r.newer.length === 0 && r.available === false,
    `ok=${r.ok} error=${r.error}`)
}

// 11) looksLikeVersion 的边界：预发布/带 v 前缀认，路径与 URL 不认
{
  const yes = ['0.1.5', '0.1.5-rc.1', 'v1.0.0', '0.1.6-alpha.2']
  const no = ['https://evil.example/x.tgz', 'file:/tmp/x', 'latest', '1.0', '', null, 42, '0.1.5; rm -rf /']
  const bad = yes.filter((s) => !v.looksLikeVersion(s)).concat(no.filter((s) => v.looksLikeVersion(s)))
  check('looksLikeVersion 边界正确', bad.length === 0, `误判=${JSON.stringify(bad)}`)
}

console.log(fails === 0 ? '\n全部通过' : `\n${fails} 项失败`)
process.exit(fails === 0 ? 0 : 1)
