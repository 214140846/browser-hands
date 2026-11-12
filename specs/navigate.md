# navigate 模块规格

负责：`navigate` 工具——让标签页打开一个网址、后退或前进；遇到网页的「离开此页？」确认框（`beforeunload`）时按调用参数决定留下还是离开；导航后等页面加载完，再把结果告诉代理。

## 1. 冻结的导出签名

| 导出 | 参数 | 返回 |
|---|---|---|
| `navigate` | `tabId: number`，`params: { url?: unknown, force?: unknown }`，`signal?: AbortSignal` | `Promise<{ output: string }>`，结果对象只有 `output` 一个键；失败时 reject |

只有这 1 个导出。异步。

## 2. 依赖

| 模块 | 导出 | 签名 | 本模块依赖它的什么 |
|---|---|---|---|
| `./debugger.js` | `attach` | `(tabId: number) => Promise<void>`，挂不上时 reject | 挂不上（reject）→ 本次调用不使用 `withDebugger`、不拦截确认框，导航照常 |
| `./debugger.js` | `withDebugger` | `<T>(tabId: number, fn: () => Promise<T>) => Promise<T>`，占用与释放调试器由它自己负责，返回 `fn` 的结果 | `attach` 成功时，整个「发起导航 + 等待」放在其中执行；本模块不自行释放调试器 |
| `./debugger.js` | `send` | `(tabId: number, method: string, params?: object) => Promise<any>`，失败 reject | 发 CDP `Page.handleJavaScriptDialog`（参数 `{ accept: boolean }`）答复确认框 |
| `./debugger.js` | `onDebuggerEvent` | `(handler: (tabId: number, method: string, params: any) => void) => void`，注册后每个 CDP 事件都会回调 | 收 `Page.javascriptDialogOpening`、`Page.frameNavigated`、`Page.navigatedWithinDocument` |
| `./abort.js` | `checkAbort` | `(signal?: AbortSignal) => void`，信号已停止时同步抛出错误（`code: 'stopped'`），否则无事 | 判定用户是否点了 Stop |
| `./redact.js` | `redactUrl` | `(url: string) => string` | 一切写进 `output` 或错误 message 的网址都先经它脱敏 |

用到的 Chrome API：`chrome.tabs.update(tabId, { url })`、`chrome.tabs.goBack(tabId)`、`chrome.tabs.goForward(tabId)`、`chrome.tabs.get(tabId)`（读 `url`、`pendingUrl`）、`chrome.tabs.onUpdated`（`addListener` / `removeListener`，回调 `(tabId, changeInfo)`，看 `changeInfo.status`）、`chrome.debugger.onDetach`（回调 `(source)`，看 `source.tabId`）。

### 导入时的副作用

导入模块后即可观察到（无需任何调用）：
- 没有调用进行中时弹出的离开确认框，也会被拒绝（第 5 节）。
- 本标签调试器断开，随时能结束本标签正在进行的页面切换等待（第 6 节）。
- 导入本身不在 `chrome.tabs.onUpdated` 上留监听；该监听只在一次调用期间存在。

### 计时

每段等待的上限用一次全局 `setTimeout` 表达，延时参数就是该上限的毫秒数；不用墙钟比较或分段轮询（测试会替换全局 `setTimeout`，把 ≥1 秒的延时按比例压缩）。

## 3. 错误形状

本模块主动抛的错误都是 `Error` 实例，`code` 为字符串：

| 情形 | `code` | message 约束 |
|---|---|---|
| `url` 缺失 / 为空 / 补前缀后仍不是合法网址 | `'invalid_params'` | 英文，非空，自定 |
| 被确认框拦下（见第 5 节） | `'navigate_beforeunload_blocked'` | 英文，非空；含**弹框那一页**地址（取自该 `Page.javascriptDialogOpening` 事件 `params.url`，缺省按空串）的脱敏结果，不含目标地址；其余自定 |
| 页面打不开（见第 7 节） | `'navigate_load_failed'` | 英文；含脱敏后的地址（打网址时为目标地址，后退 / 前进时为落到的地址） |
| 用户停止 | 来自 `checkAbort`，原样透传（`'stopped'`） | — |
| `chrome.tabs.*` 自己报错（如没有可后退的历史） | 原样透传，同一个对象，不包装 | — |
| `url` 为非字符串的真值 | 失败，形状不约束 | — |

## 4. 参数 → 浏览器动作

| `url` | 动作 |
|---|---|
| 与 `back` 完全相同（不分大小写，不去空格；`BACK`、`Back` 都是后退） | `chrome.tabs.goBack(tabId)` |
| 前后带空格的 ` back` 等 | 按网址处理：补前缀后解析失败 → `invalid_params` |
| 与 `forward` 完全相同（同上） | `chrome.tabs.goForward(tabId)` |
| 以 `http://` 或 `https://` 开头（不分大小写） | 原样作为目标地址 |
| 其他字符串 | 目标地址 = `https://` + 原文（不管原文里有没有别的协议，如 `ftp://x` 变成 `https://ftp://x`） |
| 目标地址用 WHATWG `URL` 解析失败（如 `foo bar`、`javascript:alert(1)`、` back`） | `invalid_params`，不发起任何动作 |
| `undefined` / `null` / `''` | `invalid_params`，不发起任何动作 |

打网址时 `chrome.tabs.update(tabId, { url: 目标地址 })`。

`force`：任意真值视为「强制」，假值或缺省视为「不强制」。

| 停止信号 | 结果 |
|---|---|
| 调用时已停止，且参数非法 | `invalid_params`（参数错优先报） |
| 调用时已停止，参数合法 | `stopped`，不发起动作 |

## 5. 离开确认框：策略 → 处理 → 工具结果

「进行中的导航」指本模块对**这个标签**的一次调用，从调用开始，到页面已切换（第 6 节页面切换等待结束）或调用已结束为止。确认框事件即 CDP `Page.javascriptDialogOpening` 且 `params.type` 为 `beforeunload`。

| 弹框时本标签的情形 | 对确认框 | 工具结果 |
|---|---|---|
| 有进行中的导航，`force` 为真值 | 接受（`accept: true`），离开此页 | 继续等页面真正切换（确认框本身不结束等待），之后照常成功；`output` 必须与同地址无弹框时的输出不同，说明未保存内容已丢弃（措辞自定） |
| 有进行中的导航，`force` 为假 | 拒绝（`accept: false`），留在原页 | 立刻结束等待，reject `navigate_beforeunload_blocked`；不等加载，不读标签信息 |
| 没有进行中的导航（如点链接触发的跳转、调用结束之后才弹） | 拒绝 | 不影响任何调用；原页面不会被弹框卡住 |
| 别的标签有进行中的导航，本标签弹框 | 拒绝 | 别的标签那次导航不受影响 |
| 同一次导航里接受过一次后又弹第二个 | 拒绝（强制只管一次） | 视为被拦下 |
| 不是 `beforeunload` 的对话框（`alert`、`confirm`、`prompt`） | 不答复，不发任何命令 | 不影响 |
| 答复命令失败 | 吞掉 | 结果同上表，不因此出错 |
| 调试器挂不上（内部页面等） | 无法拦截 | 照常发起导航，不调用 `withDebugger` |

答复一律通过 `send(tabId, 'Page.handleJavaScriptDialog', { accept })`，每个确认框恰好一次。

## 6. 等待：页面切换与加载

一次调用分两段等待，均不产生超时错误码，到上限就静默往下走：

**页面切换等待**——下列任一发生即结束：

| 事件（仅限本标签） | 结束？ |
|---|---|
| 主 frame 提交新文档（`Page.frameNavigated` 且 `params.frame.parentId` 缺省） | 是 |
| 子 frame 提交（`parentId` 存在） | 否 |
| 同文档跳转（`Page.navigatedWithinDocument`） | 是 |
| 确认框被拒绝 | 是（走第 5 节拦截结果） |
| 本标签调试器断开（`chrome.debugger.onDetach`） | 是 |
| 其他标签的上述事件 | 否 |
| 都没有 | 2 秒兜底上限后结束，按「已切换」继续 |

**加载等待**——等 `chrome.tabs.onUpdated` 报本标签 `status === 'complete'`：

| 情形 | 结果 |
|---|---|
| 等到了 | 成功 |
| 30 秒内没等到（只有 `loading`、或只有别的标签完成） | 仍成功；`output` 必须与加载完成时的输出不同，说明页面还在加载（措辞自定） |

| 情形 | 结果 |
|---|---|
| 切换 / 完成 / 确认框事件在发起动作期间同步发出（实现必须在发起动作前就能接住这些事件） | 算数 |
| 发起动作时浏览器报错 | 原样透传同一个错误对象，不残留监听 |
| 调用前标签已处于完成状态 | 不能据此判为已加载 |

任何结局（成功、拦截、打不开、动作报错、停止）之后，本次调用挂的 `chrome.tabs.onUpdated` 监听必须全部移除。

**停止**

| 停止时机 | 结果 |
|---|---|
| 页面切换等待中 | `signal` 一触发 abort 就立刻结束调用，以 `checkAbort(signal)` 抛出的那个错误 reject |
| 加载等待中 | 以 `checkAbort(signal)` 抛出的错误 reject（不要求立刻结束，可等到加载完成或上限后再报） |

常量来由：
- 2 秒：项目自定。确认框在离开前弹出，正常情况下主 frame 切换或弹框事件远在 1 秒内到达；上限只是收不到任何事件时（如目标与当前页相同、调试器不在）的兜底，取短值避免空等。
- 30 秒：与 Puppeteer / Playwright 公开文档中导航默认超时一致，是浏览器自动化的惯用上限。

## 7. 结果判定与输出

等待结束后读 `chrome.tabs.get(tabId)`。

| 情形 | 结果 |
|---|---|
| 正在去往 `chrome-error:` 开头的地址 | `navigate_load_failed` |
| 没有正在去往的地址，已提交地址以 `chrome-error:` 开头 | `navigate_load_failed` |
| 正在去往正常地址（即便已提交地址是错误页） | 成功 |
| 打网址成功 | `output` 含 `redactUrl(目标地址)`（`example.com` 显示的是 `https://example.com` 的脱敏结果） |
| 后退 / 前进成功，有正在去往的地址 | `output` 含它的脱敏结果 |
| 后退 / 前进成功，没有正在去往的地址、有已提交地址 | `output` 含已提交地址的脱敏结果 |
| 后退 / 前进成功，两者都没有 | `output` 非空，不含任何地址 |
| 后退 / 前进落到错误页 | `navigate_load_failed`，message 含落到的那个地址的脱敏结果 |

`chrome-error:` 是 Chrome 加载失败时显示内部错误页所用的协议（公开行为）。

`output` 的句式、大小写、附加说明的措辞都是自定，测试只断言包含关系与「不同」关系。
