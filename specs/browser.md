# browser 模块规格

负责：记住「是哪个浏览器拉起了 native host」。host 连上后第一条消息 `host_info` 报告浏览器类型（见 `specs/launcher.md`），`background.js` 收到后交给本模块；其他模块只在浏览器行为和 Chrome 不同的地方查它选路径。

## 1. 冻结的导出签名

| 导出 | 参数 | 返回 |
|---|---|---|
| `setBrowser` | `kind: unknown` | `Promise<void>` |
| `browserKind` | 无 | `Promise<string>` |

只有这 2 个导出。

## 2. 依赖

用到的 Chrome API：`chrome.storage.session.get('browser')`、`chrome.storage.session.set({ browser })`。不依赖其他模块。

## 3. 行为

| 情形 | 结果 |
|---|---|
| `setBrowser('arc')` 之后 `browserKind()` | `'arc'`；同时写进 `chrome.storage.session` 的 `browser` 键 |
| `setBrowser` 收到非字符串（`undefined`、数字、对象） | 记为 `'unknown'` |
| 从没 `setBrowser`，`storage.session` 里也没有 | `browserKind()` 为 `'unknown'`；调用方按 Chrome 处理 |
| service worker 重启后（内存清空、`storage.session` 还在） | `browserKind()` 读回之前存的值 |
| 读存储期间又 `setBrowser` | 以 `setBrowser` 的值为准，不被存储里的旧值覆盖 |

取值目前有 `'arc'`、`'chrome'`、`'chrome-for-testing'`、`'chromium'`、`'unknown'`，本模块不校验，原样保存。
