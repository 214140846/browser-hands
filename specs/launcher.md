# launcher 模块规格

负责：在 native host 里认出拉起它的浏览器。Chrome 系浏览器直接 fork 出 host，host 的父进程就是浏览器主程序；只看父进程可执行文件路径里的 `.app` 包名。host 启动后把结果作为第一条消息 `{ method: 'host_info', params: { browser } }`（无 `id`，插件不回）发给插件。

## 1. 冻结的导出签名

| 导出 | 参数 | 返回 |
|---|---|---|
| `browserFromPath` | `path: string` | `'arc' \| 'chrome' \| 'chrome-for-testing' \| 'chromium' \| 'unknown'` |
| `launchingBrowser` | `ppid?: number`（缺省 `process.ppid`） | 同上 |

## 2. browserFromPath

| 路径含 | 结果 |
|---|---|
| `/Arc.app/` | `'arc'` |
| `/Google Chrome for Testing.app/` | `'chrome-for-testing'`（先于 `chrome` 判断） |
| `/Google Chrome.app/` | `'chrome'` |
| `/Chromium.app/` | `'chromium'` |
| 其他（含空串） | `'unknown'` |

## 3. launchingBrowser

- 用 `ps -o comm= -p <ppid>` 读父进程可执行文件路径（参数数组调用，不经 shell），交给 `browserFromPath`。
- 进程不存在、`ps` 失败：返回 `'unknown'`，不抛错。
