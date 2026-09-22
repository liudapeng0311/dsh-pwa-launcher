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

## 改文件时的两个陷阱

发布前清理注释时**真的踩到了**这两个，记下来。

### 1. `.ps1` 必须保持 UTF-8 BOM，`.vbs` 必须没有 BOM

PowerShell 5.1 判断脚本编码的方式是「有没有 BOM」：**没有 BOM 就按系统 ANSI 代码页解码**。
这些脚本的注释和弹窗文案都是中文，一旦 BOM 丢掉，中文被解成乱码，字符串引号错位，
直接变成语法错误 —— 而报错信息指向的行号毫无意义，很难看出是编码问题。

VBScript 正好相反：`cscript` / `wscript` **不认** UTF-8 BOM，加了会报语法错误。
所以 `assets/*.vbs` 是纯 ASCII、无 BOM，别给它加。

用编辑器或脚本批量改写 `.ps1` 之后，一定复查：

```powershell
# 每个 .ps1 都应该是 True
Get-ChildItem -Recurse -Include *.ps1 -File |
  ForEach-Object { $b = [IO.File]::ReadAllBytes($_.FullName)
                   "{0} BOM={1}" -f $_.Name, ($b[0] -eq 0xEF -and $b[1] -eq 0xBB -and $b[2] -eq 0xBF) }
```

丢了就把 `EF BB BF` 三个字节加回文件开头。改完最好再解析一遍确认：

```powershell
$e = $null; [System.Management.Automation.Language.Parser]::ParseFile('路径', [ref]$null, [ref]$e); $e.Count
```

### 2. 换行符：仓库里 `.ps1` 存的是 LF，`.js`/`.md` 是 CRLF

历史原因，混合的。`.gitattributes` 已经声明了规则（脚本固定 CRLF，文本按平台还原），
但**工作区**里脚本目前仍是 LF —— 这是可以工作的（PowerShell 两种都吃），
不用为了"统一"去批量重写：那会产生一次大 diff，且对功能没有任何影响。
新文件跟着 `.gitattributes` 走即可。

