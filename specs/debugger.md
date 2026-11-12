# debugger 模块规格

管理扩展对各标签页的 Chrome 调试器（`chrome.debugger`）挂载，供日志、截图、输入、导航等模块发 CDP 命令。全扩展只此一处直接碰 `chrome.debugger.*`。

要点：本模块自己记账「哪些标签挂着」，不向 Chrome 枚举调试目标；同一标签的并发挂载合并；挂载失败会短暂记住以便调用方快速退回其他手段；有任务在用或有人要求保持时不断开，闲下来一段时间后自动断开。

## 1. 冻结的接口

### 导出（恰好九个）

| 导出 | 同步 / 异步 | 参数 | 返回 |
|---|---|---|---|
| `attach` | 异步 | `tabId: number` | `Promise<void>` |
| `detach` | 异步 | `tabId: number` | `Promise<void>`，永不 reject |
| `send` | 异步 | `tabId: number, method: string, params?: object, ms?: number` | `Promise<any>`，resolve 为 Chrome 回调给出的 CDP 响应对象（原样） |
| `withDebugger` | 异步 | `tabId: number, fn: () => Promise<T> \| T` | `Promise<T>`，即 `fn` 的结果 |
| `holdDebugger` | 同步 | `tabId: number` | `void` |
| `releaseDebugger` | 同步 | `tabId: number` | `void` |
| `isAttached` | 同步 | `tabId: number` | `boolean` |
| `onDebuggerEvent` | 同步 | `h: (tabId: number, method: string, params: any) => void` | 无约束（调用方不用返回值） |
| `onDebuggerAttached` | 同步 | `h: (tabId: number) => void` | 无约束 |

`ms` 单位毫秒；不传时用默认命令超时（第 8 节）。`tabId` 一律是 Chrome 的数字标签 id，不做类型校验。

### 全局测试钩子

模块加载后在 `globalThis.__jevDebugger` 放一个对象（端到端测试在 service worker 里靠它操作，属接口）：

| 成员 | 形态 | 作用 |
|---|---|---|
| `attach` / `detach` / `isAttached` | 同名导出本身 | 同导出 |
| `inject` | 可写对象 `{ msg: string, times: number, delayMs: number }`，初值 `msg` 为空串、两个数为 0 | 故障注入，见第 4 节 |
| `forgetFailure` | `(tabId) => void` | 清掉该标签的挂载失败记忆 |

### 依赖的同仓模块接口

| 模块 | 导出 | 签名 | 依赖它的什么 |
|---|---|---|---|
| `./sessions.js` | `sessionClosedHooks` | 数组；元素为 `(tabIds: number[], sessionId: string) => unknown` | 本模块导入时往里放一个回调。依赖 sessions 在会话关闭时以该会话组的标签 id 列表调用它、等待它返回的 Promise、吞掉它抛的错 |

不 import 其他同目录模块。

### 导入时的副作用

- `chrome.debugger.onEvent`、`chrome.debugger.onDetach`、`chrome.tabs.onRemoved` 各登记一个监听（全模块只这三个，之后不再增加）。
- `sessionClosedHooks` 里放一个回调。
- 设置 `globalThis.__jevDebugger`。

### 运行环境约定（单测替身照此实现）

- `chrome.debugger.attach / detach / sendCommand` 走回调形式，失败经回调期间的 `chrome.runtime.lastError` 表达。
- `chrome.tabs.get(id)` 返回 Promise，取不到时 reject；`chrome.scripting.executeScript` 返回 Promise。
- 计时一律用全局 `setTimeout` / `clearTimeout`，当前时间用 `Date.now()`（单测会替换这三者以推进时间）。
- 除挂载超时、命令超时、空闲计时、外部扩展拦截后的退避、`inject.delayMs` 这五处外，不使用任何定时等待（成功路径只经过 Promise 与 Chrome 回调）。

## 2. 错误形状

本模块抛出的都是 `Error` 实例。

| 码（`code` 字段） | 何时 | message |
|---|---|---|
| `chrome_protected_page` | 目标标签是浏览器内部页面（第 3 节） | 新写；说明内部页面不能挂调试器、请先打开普通网页 |
| `debugger_attach_failed` | 挂载失败或超时（第 3 节） | 新写；**必须包含** Chrome 给出的原报错文本（超时则说明超时，可提示 DevTools 开着或渲染进程卡死） |
| `cdp_timeout` | 命令超时（第 5 节） | 新写；可带方法名与毫秒数 |
| 不带 `code` | Chrome 命令报错、取标签信息失败 | message 为 Chrome / 原错误的原话，不改写（下游错误分类模块靠这段原话的前缀判断） |

## 3. attach

| 情形 | 可观察结果 |
|---|---|
| 本模块记着已挂上 | 立即 resolve，不找 Chrome |
| 同一标签已有一次挂载在进行 | 返回同一结局；Chrome 只被要求挂一次 |
| 处于失败记忆期内（见下） | 立即以记住的那个 `debugger_attach_failed` 错误 reject，不找 Chrome，也不读取标签信息（即使标签已不存在或已变成受保护页，结果仍是这个错误） |
| 取标签信息失败 | 以原错误 reject（不带码），不记失败 |
| 地址的 scheme 是 `chrome:`、`chrome-extension:`、`devtools:`、`edge:`、`about:` 之一，且地址不恰为 `about:blank` | reject `chrome_protected_page`，不尝试挂载，不记失败 |
| 地址缺失、空、`about:blank`、普通网页 | 尝试挂载，协议版本 `1.3` |
| Chrome 挂载成功 | resolve；`isAttached` 为真；失败记忆清除；该标签 CDP `Page` 域处于开启状态（开启失败忽略）；每个挂上回调以 tabId 被调用一次 |
| Chrome 报错，消息含 `already attached`（不区分大小写） | 当作挂载成功，结果同上一行 |
| Chrome 报外部扩展 iframe 拦截（`Cannot access a chrome-extension:// URL of different extension`） | 见下方「外部扩展拦截」 |
| Chrome 报其他错误 | reject `debugger_attach_failed`，不等待、不重试，记入失败记忆 |
| 某一次挂载尝试 8 秒内 Chrome 不回应 | reject `debugger_attach_failed`，记入失败记忆。8 秒按每次尝试单独计（外部扩展拦截后的每次重试各有 8 秒）；某次重试超时即以超时结束，不再继续重试 |

scheme 判断大小写敏感（Chrome 给出的地址 scheme 本就是小写）；其他 scheme（如 `file:`、`data:`、`chrome-search:`）不算受保护。

挂上回调：在 `Page` 域开启尝试结束之后被调用；某个回调抛错不影响其他回调，也不影响 `attach` 的结局。每次挂上都会调用，包括断开后重挂、`send` 内部的重挂。

### 失败记忆

| 情形 | 结果 |
|---|---|
| 挂载以 `debugger_attach_failed` 失败 | 失败后不满 30000 毫秒内对该标签的 `attach` / `send` 立即失败，`withDebugger` 立即跳过挂载；满 30000 毫秒起重新尝试 |
| 满 30 秒 | 下一次调用重新尝试挂载 |
| 挂载成功 / 该标签关闭 / 测试钩子 `forgetFailure` | 立即清除 |
| `chrome_protected_page`、取标签信息失败 | 不记 |

### 外部扩展拦截

别的扩展在页面里放了 `chrome-extension://` iframe 时，Chrome 会拒绝挂载并报上表那句原话。遇到这种报错，该标签所有框架里来源不是本扩展的扩展 iframe（含开放与封闭 shadow root 内的）会被移除（只在首次被拦截时移除一次，重试前不再移除），挂载会被重试，重试次数由这一次移除的结果决定：

| 情形 | 结果 |
|---|---|
| 首次移除删掉了至少一个 | 最多再重试 4 次 |
| 首次移除一个没删到，或注入本身失败 | 只再重试 1 次 |
| 某次重试成功，或报「already attached」 | 按挂载成功处理 |
| 某次重试报别的错误 | 立刻停止重试，按「其他错误」处理（`debugger_attach_failed`，消息含这次的原话） |
| 重试次数用完仍被拦截 | `debugger_attach_failed`，消息含最初那次的原话 |

每次重试前有短暂等待，逐次变长，全部重试的等待合计不超过 750 毫秒（不含各次尝试本身的耗时）。只有这一种报错会触发清理与等待。单测只断言重试次数与一秒上界；页内清理的实际删除效果单测不覆盖（由端到端测试覆盖）。

## 4. 测试钩子 inject

| 情形 | 结果 |
|---|---|
| `times > 0` 时发生一次挂载尝试（含外部扩展拦截后的每次重试） | 不调用 Chrome；`times` 减 1；`delayMs` 毫秒后这次尝试以 `msg` 为报错文本失败，之后按第 3 节对该文本的规则处理 |
| 同一标签并发挂载 | 因合并只算一次尝试，只消耗 1 |
| `delayMs` 超过挂载超时 | 按挂载超时处理 |
| `times` 为 0 | 正常调用 Chrome |

## 5. send

| 情形 | 可观察结果 |
|---|---|
| 没挂上 | 自动挂上（规则同 `attach`），命令发出时该标签已挂着；挂载失败则以挂载的那个错误原样 reject（码与消息不变），命令不会发出 |
| 命令成功 | resolve 为 CDP 响应对象原样，`params` 原样交给 Chrome |
| 命令报错，消息含 `debugger is not attached` 或 `detached while handling command`（不区分大小写） | 视为已断开：重新挂载一次（挂上回调会再被调用）后重发；重挂失败时以重挂的那个错误原样 reject，重发不会发生；重发的结局即最终结局，不再重挂 |
| 命令报其他错误 | reject 不带码的 Error，message 为 Chrome 原话 |
| 一次命令发出后超过 `ms`（默认 30000）没回应 | reject `cdp_timeout`。超时只计命令本身，不含自动挂载 / 重挂的时间；重发时重新计满 `ms` |

只经 `send` / `attach` 挂上的标签不会因空闲自动断开（空闲断开只由 `withDebugger` 结束和 `releaseDebugger` 启动）。

## 6. withDebugger、hold 与空闲断开

`withDebugger` 表示「这段任务在用这个标签的调试器」。

| 情形 | 可观察结果 |
|---|---|
| 调用 | `fn` 执行时，能挂上的标签 `isAttached` 已为真；resolve / reject 为 `fn` 的结局 |
| 挂载以 `debugger_attach_failed` 失败 | 吞掉，照样执行 `fn`（调用方可退回不依赖调试器的手段） |
| 挂载以其他错误失败（受保护页、取标签失败） | 以该错误 reject，不执行 `fn` |
| 进入时该标签有待执行的空闲断开 | 取消 |
| 同一标签同时有多个任务 | 只有最后一个结束时才可能开始空闲计时 |
| 最后一个任务结束，且仍挂着、未被 hold | 开始空闲计时：60000 毫秒后断开（效果同 `detach`） |
| 最后一个任务结束，但没挂着或被 hold | 不计时 |

| hold / release 情形 | 结果 |
|---|---|
| `holdDebugger` | 之后任务结束不再启动空闲计时。**不**撤销已在走的计时，也**不会**在 Chrome 那边断开后自动重挂 |
| `releaseDebugger`，此前没 hold | 什么都不做 |
| `releaseDebugger`，此前 hold 了，且仍挂着、没有任务在用 | 重新开始 60000 毫秒空闲计时（取消旧的） |
| `releaseDebugger`，此前 hold 了，但有任务在用或没挂着 | 只解除 hold，不计时；任务结束时按上表处理 |
| hold 多次 | 一次 release 即解除（不计数） |

## 7. 其他导出与事件

| 情形 | 结果 |
|---|---|
| `detach(tabId)` | 取消该标签空闲计时，`isAttached` 立即为假，请 Chrome 断开；Chrome 报错也正常 resolve |
| `isAttached(tabId)` | 只看本模块记账，不问 Chrome。扩展重启后到下次挂上之前为假 |
| Chrome `onEvent` 带 tabId | 同步按登记顺序调用每个 `onDebuggerEvent` 订阅者 `(tabId, method, params)`；某个抛错不影响其他 |
| Chrome `onEvent` 不带 tabId（如扩展目标） | 忽略 |
| Chrome `onDetach` 带 tabId | `isAttached` 为假，空闲计时取消；之后 `send` 会重新挂载 |
| Chrome `onDetach` 不带 tabId | 忽略 |
| `tabs.onRemoved` | 忘掉该标签的 hold 与失败记忆；不改挂载记账（Chrome 会另发断开事件） |
| 会话关闭回调收到一批 tabId | 对其中本模块记着挂上的每个标签执行 `detach`；返回在它们全部完成后 resolve 的 Promise；没挂的不碰 |

## 8. 常量来由

- 协议版本 `1.3`：Chrome 扩展文档 `chrome.debugger.attach` 要求的 `requiredVersion`，1.3 是 CDP 公开的稳定协议版本。
- 空闲断开 60 秒（项目自定）：挂着调试器时 Chrome 会在页面顶部显示「正在调试」横幅并影响用户；代理的操作通常是「做一步 → 看一眼」的节奏，60 秒能覆盖一轮，免得每步都重挂（重挂会让横幅闪烁、丢掉已开启的 CDP 域）。日志模块的空闲时长与此对齐。
- 挂载超时 8 秒（项目自定）：正常挂载在 1 秒内完成；卡住通常是该标签开着 DevTools 或渲染进程挂了，再等无益。取值让一次失败的挂载远小于工具调用的整体超时。
- 命令超时默认 30 秒（项目自定）：覆盖整页截图、大页面求值这类慢命令；页面冻结时不让调用方无限等。调用方可用 `ms` 改。
- 失败记忆 30 秒（项目自定）：DevTools 开着或另有调试器占用时，短时间内再挂几乎必然失败；记住结果能让依赖调试器的调用方马上改走备用路径，不必每次白等一个挂载超时。
- 外部扩展拦截重试 4 次 / 1 次、退避逐次变长（项目自定）：被移除的 iframe 有时会被那个扩展立刻重新注入，给几次短退避；一个都没删到说明清理无效，只象征性再试一次。总等待上限 750 毫秒，不拖慢正常调用。
- `send` 只重挂 1 次（项目自定）：断开多因页面跳转或 DevTools 抢占，重挂一次足以恢复；再失败说明是持续性问题，交给调用方。
- 受保护 scheme 列表：Chrome 不允许扩展调试这些内部页面（`chrome:`、`chrome-extension:`、`devtools:`；`edge:` 为 Edge 的对应 scheme；`about:` 下除空白页外的页面）。`about:blank` 是新建标签的常见初始页，Chrome 允许调试。

## 9. 边界清单

- 并发的 `attach` 失败时，所有等待者拿到同一个错误。
- 失败记忆期内 `withDebugger` 不找 Chrome，直接执行 `fn`，结束后也不计时（没挂着）。
- `send` 内部重挂成功后，挂上回调会再次被调用（日志模块靠它恢复监听）。
- 空闲断开后再 `send`：重新挂载，挂上回调再被调用。
- 测试不断言：所有 message 的具体文案、页内清理函数的形状与参数。
