# Changelog

本文件记录用户可感知的变更。格式参照 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [1.10.3] - 2026-09-22

第一个公开版本。发布前的三处必修。

### 修复

* **更新候选不再接受非 semver 的版本值（安全）**。registry 的 `dist-tags` 是**不可信输入**：
  当一个 tag 的值不是合法 semver 时，比较会退回字符串比较，于是 `https://…/x.tgz` 这类字符串
  排序上就能「比当前版本新」而混进候选；候选会一路走到升级脚本的 `npm install <包>@<值>`，
  而 npm 接受 `file:` / `https://…tgz` 形式的 spec。等于让 registry（或中间人镜像）决定
  用户机器上装什么。现在候选列表两端都要求合法 semver，「当前版本」本身读歪时直接跳过比较，
  触发升级的路由也会独立再校验一次。
* **`npm test` 不再依赖作者本机的目录**。测试里写死的绝对路径会让任何其他检出与 CI 直接报
  `ERR_MODULE_NOT_FOUND`。

### 变更

* 删除 `package.json` 里的 `dsh.compatibility`。该字段**不在 DSH 的 manifest schema 里**
  （官方只定义 `bundle` / `profile` / `client` / `configTrees` / `sessionFormatMigration` /
  `moduleFallback`），runtime 里没有任何代码读它。留着它比不写更糟——会让人误以为装到不兼容的
  版本上会被拦住。兼容环境改为在 README 里写明（实测 dsh 0.1.5-rc.1 / 0.1.5-rc.2 + Node 24 + Edge）。
* README 的安装段改写：说明为什么当前要按 tarball 直链装、为什么不能用 `github:` 形式
  （会被 pnpm 解析成 `git+ssh://`，需要 SSH key）。
* 修正 README 中的测试项数（原文写的与实际不符）。

### 测试

* 更新重试测试从 8 项增至 12 项，其中 4 项专门钉住上面那条安全修复——包括一个伪造的
  registry 响应（`latest: 'https://evil.example/x.tgz'`），断言它不会进入候选列表。

---

## 关于版本号

这个仓库从 `1.10.3` 开始公开发布，此前的版本号是私有开发期间的计数，
没有对应的 tag 与发布记录。公开发布之后按语义化版本推进。
