# docs

发布相关的资料，不参与打包、也不影响运行。

## `awesome-list-entry.yml`

提交给 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 的条目文件。

那个列表的数据源在它自己的 `data/plugins/<owner>__<repo>.yml`，两个 README 由脚本生成，
**不接受手工编辑 README**。这里留一份副本是为了：以后要改描述时，知道当初提交了什么、
以及为什么那么写。

* 提交的 PR：[#5672](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/5672)
* 实际入库路径：`data/plugins/liudapeng0311__dsh-pwa-launcher.yml`

改这个文件**不会**影响已经提交的条目 —— 需要去那个仓库提一个新 PR（或者改自己 fork 里的那份）。
这一份只是记录。

### 两个容易踩的点

* `description.en` 里含 `: `（冒号加空格）时**必须加引号**，否则 YAML 会把它读成嵌套键。
  现在这版是加引号的。
* `tarball:` 这里钉的是 **tag**（`releases/download/v1.10.3/…`）而不是
  `releases/latest/download/…`。后者只在请求时解析 `latest`、文件名却按字面取，
  一旦资产名里带版本号，下次发版就会静默 404。
