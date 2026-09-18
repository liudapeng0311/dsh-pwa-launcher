// 验证 checkForUpdate 的重试逻辑。
// 起因：实测本机到 npm 的连接会偶发超时/ECONNRESET（并发 8 个请求挂 2 个），
// 而更新检查一次只跑一次 —— 没有重试时，一次瞬时抖动就让界面长期显示「未查到」。
import { pathToFileURL } from 'node:url'
const v = await import(pathToFileURL('D:/works/vibecoding/dsh/dsh-pwa-launcher/lib/version.js').href)

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

console.log(fails === 0 ? '\n全部通过' : `\n${fails} 项失败`)
process.exit(fails === 0 ? 0 : 1)
