/**
 * 把 client/src/*.js 合成 dsh 客户端模块系统要求的 lib/client.js。
 *
 * 为什么要有这一步：dsh 的浏览器半边不是普通 ESM —— 它是一个「惰性 CJS 工厂」，
 * 外层必须是 window.__ModuleLoader__.load({ id, factory })，模块体在工厂闭包里，
 * import 变成显式 require(...)。仓库内那些 TS 插件是靠 tsdown 的 clientBundle
 * preset 产出这个形状的，而那个 preset 没有随包发布（见 dsh-client-modules 的
 * README：「仓库外的插件得自己复现这个构建」）。所以要自己来。
 *
 * 这里刻意只用 node 内建模块，和本包「不引第三方依赖」的既有取向一致。
 *
 * 三个源文件被拼成**同一个**闭包作用域（各自删掉 import/export 行），
 * 因此它们之间不需要任何 import 就能互相看见 —— 这也是为什么源文件里
 * 彼此不写相对 import。真正的 import 只允许指向上面的 external 列表。
 *
 * 用法：node client/build.mjs        （或 npm run build:client）
 */

import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')

/** 包名。必须和 package.json 的 name 逐字一致 —— 它是浏览器模块表里的键。 */
const MODULE_ID = 'dsh-pwa-launcher'

/**
 * 允许被 require 的模块，以及工厂开头要绑定的局部名。
 *
 * 只有这张表里的模块能出现在源文件的 import 里：平台种子表（PLATFORM_MODULES）
 * 提供 React / Cordis / 静态 UI 库，其余必须写进 package.json 的 dsh.client.external。
 * 我们只用 React 一个 —— 少一个 external 就少一处版本耦合。
 */
const EXTERNAL = {
  react: { local: 'React', member: 'default' }
}

/** 拼接顺序：被依赖的在前。同作用域，所以顺序只影响可读性。 */
const SOURCES = [
  'client/src/locales.js',
  'client/src/LauncherController.js',
  'client/src/LauncherControls.js',
  'client/src/index.js'
]

const IMPORT_RE = /^\s*import\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"]\s*;?\s*$/
const BARE_IMPORT_RE = /^\s*import\s+['"][^'"]+['"]\s*;?\s*$/
const EXPORT_RE = /^\s*export\s+(?=(?:const|let|var|function|class|async)\b)/

/**
 * 解析一条 `import <clause> from '<spec>'`。
 *
 * 只支持三种写法，且只支持单条语句跨行——写不出来的形状直接报错退出，
 * 不猜。猜错的代价是产出一个能加载但导入了 undefined 的 bundle，
 * 那种错误在浏览器里只会表现为「按钮没出现」。
 *
 * @param clause - `from` 左边那截（已 trim）。
 * @param spec - 模块说明符。
 * @returns 该 import 要绑定的所有局部名。
 */
function parseImport(clause, spec) {
  const external = EXTERNAL[spec]
  if (external === undefined) {
    throw new Error(
      `构建失败：client/src 里 import 了未登记的模块 "${spec}"。\n` +
      `只有 ${Object.keys(EXTERNAL).join(' / ')} 可以直接 import（平台种子表提供）；` +
      '其它模块要么内联进本包，要么写进 package.json 的 dsh.client.external。'
    )
  }

  const named = clause.match(/^\{([\s\S]*)\}$/)
  if (named !== null) {
    const locals = []
    for (const part of named[1].split(',')) {
      const piece = part.trim()
      if (piece === '') continue
      const alias = piece.split(/\s+as\s+/)
      if (alias.length !== 2) {
        throw new Error(`构建失败：只支持 "import { a as b } from '${spec}'" 形式，收到 "${piece}"`)
      }
      locals.push({ local: alias[1].trim(), member: alias[0].trim() })
    }
    return locals
  }

  const bare = clause.trim()
  if (bare !== external.local) {
    throw new Error(
      `构建失败："${spec}" 必须绑定成 ${external.local}（收到 "${bare}"）。` +
      '浏览器模块表按模块对象返回，默认导出要显式取 .default。'
    )
  }
  return [{ local: bare, member: external.member }]
}

/** 把一份源文件转成同一闭包里的裸代码：删掉 import/export，收集 require。 */
function transform(file, code) {
  const used = new Map()
  const kept = []

  code.split(/\r?\n/).forEach((line, index) => {
    if (BARE_IMPORT_RE.test(line)) return

    const matched = line.match(IMPORT_RE)
    if (matched !== null) {
      for (const binding of parseImport(matched[1], matched[2])) {
        const spec = matched[2]
        if (!used.has(spec)) used.set(spec, [])
        used.get(spec).push(binding)
      }
      return
    }
    if (/^\s*import\b/.test(line)) {
      throw new Error(`构建失败：${file}:${index + 1} 的 import 形状无法解析（跨多行？）：${line.trim()}`)
    }

    kept.push(line.replace(EXPORT_RE, ''))
  })

  // 所有源文件拼在同一个闭包里，React 只需要绑定一次。这里按「用到了就绑」
  // 来补，而不是要求每个文件都写一行 import —— 写重复的绑定反而会撞名。
  const body = kept.join('\n')
  const reactExternal = EXTERNAL.react
  if (new RegExp(`\\b${reactExternal.local}\\b`).test(body) && !used.has('react')) {
    used.set('react', [{ local: reactExternal.local, member: reactExternal.member }])
  }

  return { code: body, used }
}

async function build() {
  const requires = new Map()
  const bodies = []

  for (const relative of SOURCES) {
    const file = join(ROOT, relative)
    const source = await readFile(file, 'utf8')
    const { code, used } = transform(relative, source)
    for (const [spec, bindings] of used) {
      if (!requires.has(spec)) requires.set(spec, [])
      requires.get(spec).push(...bindings)
    }
    bodies.push(`\t\t//#region ${relative}\n${code.trimEnd()}`)
  }

  // 每个模块只 require 一次，绑定的局部名去重（同一文件里可能 import 两次）。
  const requireLines = []
  for (const [spec, bindings] of requires) {
    const seen = new Set()
    for (const binding of bindings) {
      if (seen.has(binding.local)) continue
      seen.add(binding.local)
      const expr = binding.member === 'default'
        ? `require(${JSON.stringify(spec)}).default`
        : `require(${JSON.stringify(spec)}).${binding.member}`
      requireLines.push(`\t\tlet ${binding.local} = ${expr};`)
    }
  }
  if (requireLines.length === 0) throw new Error('构建失败：没有任何 require，源文件是不是空了？')

  const bundle = [
    '// 本文件由 client/build.mjs 从 client/src/*.js 生成 —— 不要手改。',
    '// 改源文件后跑：node client/build.mjs',
    'window.__ModuleLoader__.load({',
    `\tid: ${JSON.stringify(MODULE_ID)},`,
    '\tfactory: (require) => {',
    '\t\tvar module = { exports: {} };',
    '\t\tvar exports = module.exports;',
    '\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: "Module" });',
    ...requireLines,
    '',
    bodies.join('\n\n'),
    '',
    '\t\texports.apply = apply;',
    '\t\texports.inject = inject;',
    '\t\treturn module.exports;',
    '\t}',
    '});',
    ''
  ].join('\n')

  const out = join(ROOT, 'lib', 'client.js')
  await writeFile(out, bundle, 'utf8')
  return { out, bytes: Buffer.byteLength(bundle) }
}

const { out, bytes } = await build()
console.log(`built ${out} (${bytes} bytes)`)
