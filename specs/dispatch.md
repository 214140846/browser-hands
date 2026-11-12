# dispatch 模块规格

负责：浏览器扩展后台里的「方法分发」。MCP 程序把每个工具调用转成 `(method, params, sessionId)` 发来，本模块按方法名找到对应工具并执行，同时对一次调用统一做：会话登记、标签准入、操作指示器、用户点 Stop 时的中止、执行前的「页面没被换站」复查。本模块还直接实现一批工具：`computer`（鼠标 / 键盘 / 截图 / 滚动 / 等待）、`read_page`、`get_page_text`、`form_input`、标签管理、握手 `hello`、连接确认窗口、任务守卫；其余工具只是把调用转给别的模块。

## 1. 冻结的导出签名

| 导出 | 类型 / 参数 | 返回 |
|---|---|---|
| `PROTOCOL_VERSION` | 常量，数字 `1` | — |
| `profileEmail` | 无参数 | `Promise<string>`；永不 reject |
| `handle` | `method: string`，`params: object`，`sessionId?: string` | `Promise<unknown>`，失败 reject |

只有这 3 个导出。实现文件是 `extension/dispatch.js`，只许 import 依赖表里列出的同目录模块（及其列出的导出）。`handle` 异步；`PROTOCOL_VERSION` 是握手时告诉 MCP 程序的协议版本，来由：项目自定，初版为 1，两端协议不兼容改动时递增。

### 导入时的副作用

导入模块后即可观察到（无需任何调用）：
- 在 `chrome.windows.onRemoved` 上挂恰好 1 个监听（第 6 节）。
- 在 `chrome.runtime.onMessage` 上挂恰好 1 个监听（第 6 节）。
- 不调用任何其他 `chrome.*` 接口，不读写存储，不开窗口，不起计时器。

## 2. 依赖

### 同目录模块

| 模块 | 导出 | 签名 | 本模块依赖它的什么 |
|---|---|---|---|
| `./redact.js` | `redactUrl` | `(url: string) => string`，同步 | 一切返回给代理的网址（标签列表、页面文字结果、`read_page` 里的链接属性值）都先经它 |
| `./redact.js` | `redactTitle` | `(title: string, url: string) => string`，同步 | 一切返回给代理的标题；第二个参数给**未脱敏的**网址 |
| `./sessions.js` | `beginCall` | `(sessionId: string) => Promise<Session>` | 登记一次调用并取得会话对象；失败 reject |
| `./sessions.js` | `endCall` | `(s: Session) => void` | 与 `beginCall` 成对 |
| `./sessions.js` | `admit` | `(s: Session, tabId: number) => Promise<void>` | 标签不属于本会话时 reject（`code: 'tab_outside_group'`） |
| `./sessions.js` | `resolveTabId` | `(params: object, s: Session) => number` | 决定本次操作哪个标签（调用方给了 `tabId` 用它，否则用会话主标签） |
| `./sessions.js` | `listTabs` | `(s: Session) => Promise<Tab[]>` | 本会话标签组里的标签，元素形如 `chrome.tabs.Tab`（本模块读 `id`、`title`、`url`、`pendingUrl`，均可能缺） |
| `./sessions.js` | `joinGroup` | `(s: Session, tabId: number) => Promise<void>` | 把新开的标签并入会话标签组 |
| `./sessions.js` | `closeSession` | `(sessionId: string) => Promise<object>` | 清理会话；其结果就是 `session_closed` 的结果 |
| `./guard.js` | `startGuard` | `(tabId: number) => Promise<Guard>` | 记下标签此刻所在网站；`Guard = { tabId, check(stage: string): Promise<void> }`，`check` 发现标签已换到别的网站时 reject（`code: 'navigated_away'`）。`stage` 只用于报错文字 |
| `./indicator.js` | `trackCall` | `(sessionId: string, tabId?: number) => { stopped: Promise<never>, signal: AbortSignal, done(): void }` | 登记进行中的调用并让该标签显示操作指示器；用户点 Stop 时 `signal` 中止，`stopped` 以 `stoppedError()` 同类的错误（`code: 'stopped'`）reject；调用结束时必须调 `done()` |
| `./indicator.js` | `pointIndicator` | `(tabId: number, x: number, y: number) => Promise<void>`，永不 reject | 在标签里画「光标要去的位置」 |
| `./abort.js` | `checkAbort` | `(signal?: AbortSignal) => void`，信号已中止时同步抛 `code: 'stopped'` 的 Error | 判断是否被 Stop |
| `./abort.js` | `abortableSleep` | `(ms: number, signal?: AbortSignal) => Promise<void>`，信号中止时 reject（`code: 'stopped'`） | `wait` 动作 |
| `./abort.js` | `stoppedError` | `() => Error`，`code: 'stopped'` | 会话被 Stop 后拒绝新调用时抛的错误 |
| `./navigate.js` | `navigate` | `(tabId: number, params: object, signal?: AbortSignal) => Promise<{ output: string }>` | `navigate` 工具的实际执行 |
| `./observe.js` | `observe` | `(tabId: number, opts: { max?: number }, signal?: AbortSignal) => Promise<object>` | `jev_observe` 的实际执行；`max` 为 `undefined` 时它自己用缺省值 |
| `./gif-recorder.js` | `recordAction` | `(s: Session, tabId: number, tool: 'computer' \| 'navigate', params: object, result: object) => Promise<void>`，永不 reject | 录制开启时给动作存帧 |
| `./gif-recorder.js` | `gifCreator` | `(params: object, s: Session, tabId: number) => Promise<{ output: string }>` | `gif_creator` 的实际执行 |
| `./input.js` | `click` | `(tabId, x, y, button: 'left' \| 'right', count: number, modifiers: number, before?: () => unknown) => Promise<unknown>` | 点击；坐标已是视口像素。`before` 在鼠标按下前被调用，抛错则中止按下并 reject |
| `./input.js` | `hover` | `(tabId, x, y) => Promise<unknown>` | 悬停 |
| `./input.js` | `type` | `(tabId, text: string, signal?: AbortSignal) => Promise<unknown>` | 输入文字 |
| `./input.js` | `key` | `(tabId, chord: string) => Promise<unknown>` | 按下并抬起一个键 / 组合键 |
| `./input.js` | `wheel` | `(tabId, x, y, deltaX: number, deltaY: number) => Promise<unknown>` | 滚轮，像素 |
| `./input.js` | `drag` | `(tabId, from: [number, number], to: [number, number], signal?: AbortSignal) => Promise<void>` | 拖动 |
| `./input.js` | `modifierMask` | `(names: string) => number`，同步 | 把形如 `ctrl+shift` 的修饰键名换成掩码 |
| `./input.js` | `isZoomChord` | `(chord: string) => boolean`，同步 | 判断某个键是不是页面缩放快捷键 |
| `./background-tab.js` | `withBackground` | `<T>(tabId, fn: () => Promise<T>) => Promise<T>` | 让标签在后台 / 最小化窗口里也能被操作；返回 `fn` 的结果、透传其错误 |
| `./background-tab.js` | `wakeHidden` | `(tabId) => Promise<void>`，永不 reject | 隐藏标签截图前先唤醒渲染 |
| `./background-tab.js` | `beginClickInterception` | `(tabId) => Promise<Token \| null>`，永不 reject | 点击前武装「拦截新标签」；`Token` 不透明，本模块只原样交回 |
| `./background-tab.js` | `abortClickInterception` | `(token: Token \| null) => Promise<void>`，永不 reject | 点击失败时撤销 |
| `./background-tab.js` | `finishClickInterception` | `(token: Token \| null, s: Session) => Promise<number[]>`，永不 reject | 点击后收尾，返回因点击而新开的标签 id |
| `./background-tab.js` | `newTabNote` | `(ids: number[]) => string`，同步 | 把新开标签 id 变成给代理看的附注（无新标签时为空串） |
| `./frames.js` | `parseRef` | `(ref: string) => { frameId: number, ref: string }` | `ref` 形如 `ref_5` 或 `f2:ref_5`；前者 frame 为 0 |
| `./frames.js` | `prefixRefs` | `(text: string, frameId: number) => string` | 给一段 `read_page` 输出里的编号加上 frame 前缀；`frameId` 为 0 时原样返回 |
| `./frames.js` | `scanAll` | `(tabId, args: unknown[]) => Promise<{ frameId: number, result: ScanResult }[]>` | 每个 frame 扫一次页面，主 frame（`frameId` 0）在最前 |
| `./frames.js` | `inPage` | `(tabId, op: string, args: unknown[], frameId?: number) => Promise<any>` | 在指定 frame（缺省主 frame）里调页内函数 |
| `./frames.js` | `callOnRef` | `(tabId, ref: string, op: string, args: unknown[]) => Promise<any>` | 在 `ref` 所属 frame 里调页内函数 `op`，第一个实参由它换成本地编号 |
| `./frames.js` | `locateRef` | `(tabId, ref: string) => Promise<[number, number]>` | 把元素滚到视野中并返回其中心点（主页面视口像素）；找不到时 reject |
| `./screenshot.js` | `toViewport` | `(tabId, point: [number, number], action: string) => [number, number]`，同步 | 把代理看到的截图坐标换成视口坐标；越界等同步抛错，本模块原样透传 |
| `./screenshot.js` | `screenshot` | `(tabId, scale: unknown, guard: Guard) => Promise<{ base64: string, format: 'png' \| 'jpeg', width, height, frameWidth, frameHeight }>` | 截整个视口；`width`/`height` 是返回图尺寸，`frameWidth`/`frameHeight` 是视口帧尺寸 |
| `./screenshot.js` | `zoom` | `(tabId, region: unknown, scale: unknown, guard: Guard) => Promise<{ base64, format, width, height }>` | 截指定区域；区域是否合法由它判断 |
| `./screenshot.js` | `cacheImage` | `(sessionName: string, base64: string, format: string) => string` | 缓存截图供之后 `upload_image` 取用，返回图片 id |
| `./screenshot.js` | `beginBatch` / `endBatch` | `() => void` | 圈出 `browser_batch` 的一批调用 |
| `./logs.js` | `readConsole` / `readNetwork` | `(params, s: Session, g?: Guard) => Promise<object>` | 两个读日志工具的实际执行 |
| `./page-tools.js` | `javascriptTool` / `fileUpload` / `uploadImage` | `(params, s: Session, g?: Guard) => Promise<object>` | 对应三个工具的实际执行 |
| `./page-tools.js` | `resizeWindow` / `uploadStash` | `(params) => Promise<object>` | 对应两个工具的实际执行 |

`PageResult`（`inPage` / `callOnRef` 的结果）：失败时带非空字符串 `error` 和可选 `errorCode`；成功时按函数各自带 `output` 等字段。`ScanResult`：成功为 `{ pageContent: string, viewport, compact?: string }`，失败为 `{ error: string, errorCode?: string, ... }`（页面脚本一侧的约定，见 page-scan 规格）。`Session` 是会话对象，本模块读 `name`、`groupId`、`mainTabId`、`windowId`，并原样交给上表各函数。

### 用到的 Chrome / 平台接口

`chrome.storage.local.get` / `set`、`chrome.identity.getProfileUserInfo`、`chrome.runtime`（`id`、`getURL`、`getManifest`、`getPlatformInfo`、`onMessage`）、`chrome.windows`（`create`、`remove`、`onRemoved`）、`chrome.tabs`（`create`、`remove`、`reload`）、全局 `crypto.randomUUID`、全局 `setTimeout` / `clearTimeout`。约束：`storage.local.get` 的键参数只用字符串或字符串数组；`tabs.create` 的选项恰好 3 个键（所属窗口、是否激活、地址，见第 10 节）；`trackCall` 的第二个参数在不显示指示器的方法上必须显式为 `undefined`（调用时参数个数不约束）。

## 3. 错误形状

本模块主动抛的错误都是 `Error` 实例，`code` 为字符串：

| 情形 | `code` | message 约束 |
|---|---|---|
| 方法名不认识 | `'unknown_method'` | 含该方法名；其余自定 |
| 参数不合法（各节说明） | `'invalid_params'` | 英文，非空，其余自定；个别情形要求含某个入参原文，见各节 |
| 页面脚本报错（`read_page` / `form_input` / `get_page_text`） | 见第 8 节 | 含页面给的错误文字 |
| `computer` 的执行步骤失败 | 见第 9.2 节 | 含原错误 message |
| 会话已被 Stop | `'stopped'`（用 `stoppedError()` 的结果） | — |
| 依赖抛的错误（准入失败、守卫复查失败、`toViewport` 越界、`locateRef` 找不到、`checkAbort` 等） | 原样透传，**同一个错误对象**，不包装 | — |
| 委托给别的模块的工具失败 | 原样透传，同一个错误对象 | — |

**同一次调用里同时存在多个问题**（例如参数不合法又已被 Stop）时报哪一个：不约束，测试不涉及。

## 4. handle：一次调用怎么走

### 4.1 入口分类

| 情形 | 结果 |
|---|---|
| `method` 为 `session_closed` | 结束该会话的全部任务守卫、清除其 Stop 标记（第 5 节），返回 `closeSession(sessionId)` 的结果；不调用 `beginCall` |
| 方法名不在第 7 节表中 | reject `unknown_method`；不开会话 |
| 没有 `sessionId` | 只用 `params` 直接执行该方法并返回它的结果；不登记会话、不准入、不挂指示器、不起守卫，也不受 Stop 标记影响。这条路径只用于 `connect_request`、`connect_cancel`、`hello`，其他方法在无会话时的行为不约束 |
| 该会话被标了 Stop（第 5 节），且方法不是 `jev_task_release` 或 `batch_end` | reject `stoppedError()`；不调用 `beginCall`，方法不执行 |
| 其余（有会话号） | 4.2 |

### 4.2 有会话号时的调用生命周期

| 阶段 | 要求 |
|---|---|
| 登记 | `beginCall(sessionId)` 恰好一次，得到会话对象 `s`。它失败 → 错误原样透传；此时不调用 `endCall`、不调用 `trackCall` |
| 准入 | `params.tabId` 不是 `undefined`（`0` 也算给了）且方法不是 `tabs_context_mcp` / `tabs_create_mcp` → `admit(s, params.tabId)`。失败 → 错误原样透传，方法不执行，不调用 `trackCall`，`endCall` 仍恰好一次 |
| 指示器 | `trackCall(sessionId, tab)`：见第 7 节「指示器」列。`tab` = `resolveTabId(params, s)` 或 `undefined` |
| 守卫 | 第 7 节「守卫」列为是的方法：用 `resolveTabId(params, s)` 起一个守卫，交给方法实现（方法实现的第三个实参）。不守卫的方法，第三个实参为 `undefined` |
| 执行 | 方法收到 `(params, s, 守卫, 本次调用的 signal, sessionId)`，其中 `signal` 就是 `trackCall` 给的那个 |
| 结果 | 方法成功 → 其结果原样作为 `handle` 的结果（`computer`、`navigate`、`gif_creator` 等各自加 `tabId` 的规则见各方法）；方法失败 → 其错误原样透传 |
| Stop | 方法还在执行时用户点了 Stop（`trackCall` 的 `stopped` reject）→ `handle` 立即以那个错误 reject，不等方法结束；之后该方法再失败也不产生未处理的拒绝 |
| 收尾 | 无论成功、失败还是被 Stop，只要 `trackCall` 已调用，就恰好调一次它给的 `done()`；`endCall(s)` 恰好一次 |

方法名大小写敏感，必须与第 7 节完全一致。

## 5. 任务守卫与 Stop 标记

`jev_task_guard`：MCP 程序为每个 `jev_task` 任务发出一次、直到任务收尾才返回的调用，使该会话在整个任务期间始终有一个可被 Stop 的进行中调用。

| 情形 | 结果 |
|---|---|
| `jev_task_guard`，参数 `{ taskId }` | 调用一直不返回，直到下面某种结局。同一个 `taskId` 重复登记：不约束 |
| 用户 Stop（该调用的 `signal` 中止） | 守卫调用以 `stopped` 失败（第 4.2 节「Stop」）；Stop 之后任务登记仍保留（可被别的会话 `jev_task_release` 解除）；Stop 标记在守卫调用的失败对外可见之前就已生效（守卫失败后紧接着的新调用必被拒）；同时**这个会话被标上 Stop**：此后该会话的新调用一律被拒（第 4.1 节），直到下面的解除。登记守卫时 `signal` 已是中止状态的情形：不约束 |
| `jev_task_release`，参数 `{ taskId }`，该任务存在 | 守卫调用以 `{ released: true }` 正常结束（若它已因 Stop 失败，则无可观察效果）；该任务所属会话的 Stop 标记被清除；调用方会话的 Stop 标记也被清除（二者可不是同一个会话）；返回 `{}` |
| `jev_task_release`，任务不存在 | 调用方会话的 Stop 标记仍被清除；返回 `{}` |
| `session_closed` | 该会话登记的**所有**任务守卫都以 `{ released: true }` 结束；该会话的 Stop 标记清除；别的会话的守卫与标记不动 |
| 被 Stop 的会话里发来 `batch_end` / `jev_task_release` | 照常执行（不被拒）；其他方法被拒 |

## 6. 握手与连接确认

### 6.1 `hello`

返回恰好 6 个字段：

| 字段 | 值 |
|---|---|
| `profileId` | 本浏览器配置的稳定标识：存储里已有就原样返回（不重写存储）；没有就生成一个新的非空字符串并存下，之后每次返回同一个。两次并发的首次调用生成两个不同值：不约束 |
| `platform` | `chrome.runtime.getPlatformInfo()` 的 `os` |
| `profileName` | 存储里的昵称；没有则空串 |
| `email` | `profileEmail()` 的结果 |
| `extensionVersion` | 清单里的版本号 |
| `protocolVersion` | `PROTOCOL_VERSION` |

存储键名 `profileId`、`profileName` 是与设置页、连接确认页共用的约定（事实性接口），不可改名。

### 6.2 `profileEmail`

| 情形 | 结果 |
|---|---|
| 接口返回带 `email` | 该字符串；调用时传 `{ accountStatus: 'ANY' }`（任何同步状态都算，Chrome 公开选项） |
| 返回里没有 `email`，或 `email` 缺省 | `''` |
| 接口抛错 / reject | `''`（不抛） |

### 6.3 连接确认窗口

切换浏览器时，MCP 程序向各候选浏览器发 `connect_request { requestId }`，由用户在本浏览器弹出的确认窗口里决定是否连接。

| 情形 | 结果 |
|---|---|
| `connect_request` | 开一个 **popup 类型、获得焦点** 的窗口，地址指向扩展内的确认页 `connect.html`，查询串里带 `rid=<对 requestId 做 URL 组件编码>`（确认页据此回报）；窗口尺寸自定。调用本身一直不返回，直到下面某个结局。窗口开不出来：不约束 |
| 用户在确认页点连接（收到 `connectDecision` 消息，第 6.4 节） | 调用以 `{ connected: true, profileName }` 结束，`profileName` 为消息里截取后的名字（无名字时空串）；关闭该窗口（关窗失败被吞掉） |
| `connect_cancel { requestId }`，请求存在 | 请求以 `{ connected: false, reason: 'cancelled' }` 结束；关闭该窗口；`connect_cancel` 返回 `{}` |
| `connect_cancel`，请求不存在 | 返回 `{}`，不关任何窗口 |
| 用户直接关掉确认窗口（`chrome.windows.onRemoved` 报该窗口 id） | 请求以 `{ connected: false, reason: 'closed' }` 结束；此情形下是否还调 `windows.remove` 不约束 |
| 别的窗口被关闭 | 不影响任何请求 |
| 取消发生在窗口刚好还没开出来时（`windows.create` 尚未 resolve） | 请求照常以 `cancelled` 结束；窗口一开出来就立刻被关掉 |

`reason` 的两个取值 `'cancelled'`、`'closed'` 与 `connected` / `profileName` 字段名是与 MCP 程序之间的协议（事实性接口）。

### 6.4 `chrome.runtime.onMessage` 监听

监听回调形如 `(msg, sender, reply)`。

| 情形 | 返回值 | 效果 |
|---|---|---|
| `sender.id` 不等于本扩展 id | `undefined` | 不处理、不应答 |
| `msg.type` 为 `connectDecision` | `true`（稍后异步应答） | 名字按下表得到；名字非空才写入存储的 `profileName`；`requestId` 对应的请求（若存在）以第 6.3 节的结果结束；应答 `{ ok: true }`。不变量：应答对外可见时，名字已写入（非空时）；请求不存在（已结束或没发过）时同样写存储并应答 |
| `msg.type` 为 `setProfileName` | `true` | 名字规则同上，但**空串也写入**；写完 `reply({ ok: true })` |
| 其他（含 `msg` 为 `null` 或非对象） | `undefined` | 不应答 |

名字的取值：

| `msg.name` | 名字 |
|---|---|
| 缺省或 `null` | `''` |
| 不超过 60 个字符的字符串 | 原样 |
| 超过 60 个字符的字符串 | 前 60 个字符（长度按字符串 `length` 计；非 ASCII 字符的截断位置不约束） |
| 非字符串的其他类型 | 不约束 |

常量来由：60 字符 = 项目自定，设置页输入框同限（昵称要显示在标签组标题与确认页里，限长防撑爆）。

## 7. 方法一览

按「是否显示指示器、是否起守卫」分三类（「标签」= `resolveTabId(params, s)`；「无」= 给 `trackCall` 的标签参数为 `undefined`）。只有下列方法名可被识别，其余按 4.1 节报 `unknown_method`（`session_closed` 另见 4.1）。

| 类别 | 指示器 | 守卫 | 方法 |
|---|---|---|---|
| 页面操作类 | 标签 | 是 | `read_page`、`get_page_text`、`form_input`、`computer`、`javascript_tool`、`file_upload`、`upload_image` |
| 导航与任务类 | 标签 | 否 | `navigate`、`jev_task_guard` |
| 其他 | 无 | 否 | `connect_request`、`connect_cancel`、`hello`、`tabs_context_mcp`、`tabs_create_mcp`、`tabs_close_mcp`、`jev_observe`、`jev_task_release`、`gif_creator`、`batch_begin`、`batch_end`、`read_console_messages`、`read_network_requests`、`resize_window`、`upload_stash` |

各方法的行为见：`connect_*` / `hello` 第 6 节；`jev_task_*` 第 5 节；`read_page` / `get_page_text` / `form_input` 第 8 节；`computer` 第 9 节；其余第 10 节。

守卫复查失败是**动作开始之前**拦下，不是事后报告；复查时传给 `check` 的 `stage` 是非空字符串，具体文字自定（测试只数复查次数）。

## 8. `read_page` / `get_page_text` / `form_input`

### 8.1 `read_page`

执行前先过一次守卫复查；复查失败 → 错误透传，不扫描。

选项（交给页面扫描的对象，恰好这 5 个键）：

| 键 | 取值 |
|---|---|
| `filter` | 调用方的 `filter`，缺省或空串为 `'interactive'` |
| `depth` | 调用方的 `depth`：缺省（`undefined` / `null`）为 `null`；给了数字（含 `0`）就原样 |
| `maxChars` | 调用方的 `max_chars`：缺省（`undefined` / `null`）为 `50000`；给了数字（含 `0`）就原样，`0` 的含义由页面脚本定 |
| `refId` | 不带 `ref_id` 时 `null`；带时见下 |
| `compact` | 调用方 `compact` 的布尔化（真值为 `true`，其余 `false`） |

`50000`：MCP 程序对代理公布的 `max_chars` 缺省值（工具描述里写明）。

| 情形 | 结果 |
|---|---|
| 不带 `ref_id` | 对每个 frame 各扫一次（`scanAll(tabId, [选项])`），以主 frame 的结果为基础 |
| 主 frame 结果带 `error` | reject Error，`code` 为页面给的 `errorCode`（页面没给时 `code` 不约束），message 含页面错误文字 |
| 有子 frame 且其结果无 `error`、`pageContent` 非空 | 子 frame 内容接在主 frame 内容后面：二者之间有换行；子 frame 内容前有一行标题行（自定，含 `f<frameId>` 字样，用于说明下面是哪个 iframe）；子 frame 内容里的编号经 `prefixRefs(内容, frameId)` 加前缀。主 frame 内容为空串时，结果不以换行开头 |
| 子 frame 结果带 `error`，或 `pageContent` 为空串 | 整个跳过，不出现标题行，也不出现它的任何内容 |
| 紧凑清单 `compact`（每行行首是 `ref_`） | 各 frame 的清单按「主 frame 在前」用单个换行拼接（主 frame 没有清单而子 frame 有时，不带前导换行）；子 frame 每一行行首的 `ref_` 前加 `f<frameId>:`。主 frame 以外的其他字段（如 `viewport`）都取主 frame 的 |
| 带 `ref_id` | 只扫那个编号所在的 frame：`inPage(tabId, 'scan', [选项], frameId)`，`选项.refId` 为 `parseRef(ref_id).ref`（本地编号）。不调用 `scanAll`。结果里 `pageContent` 的编号经 `prefixRefs` 加上所在 frame 的前缀；`compact` 存在且 `frameId` 非 0 时，同样把每行行首 `ref_` 改成 `f<frameId>:ref_`；`frameId` 为 0 时都不加前缀。结果带 `error` → 同上抛错（`code` 取 `errorCode`，如 `ref_stale`） |
| 链接脱敏 | 最终 `pageContent`（含所有子 frame 部分）里，每个链接地址属性（形如 `href="…"`）的值被替换为 `redactUrl(值)`；只有该属性值被脱敏，值的边界（含引号、空白的特殊写法）不约束，其余文字原样。`compact` 里的内容不做此替换（页面脚本的紧凑清单不含属性值） |
| 成功 | 返回「扫描结果的全部字段」加 `tabId`；主 frame 与子 frame 都没有紧凑清单时，结果里不出现 `compact` 字段 |

### 8.2 `get_page_text`

执行前过一次守卫复查。

| 情形 | 结果 |
|---|---|
| 成功 | 在**主 frame** 调页内 `pageText`，唯一实参是 `max_chars`（缺省 / `null` 为 `50000`，来由同上；其他值原样）；返回页面结果的全部字段，加 `tabId`，且 `title` 换成 `redactTitle(原 title, 原 url)`、`url` 换成 `redactUrl(原 url)` |
| 页面结果带 `error`（无正文） | reject Error，`code` 恒为 `'get_page_text_no_content'`（不管页面给了什么码），message 含页面错误文字 |

### 8.3 `form_input`

| 情形 | 结果 |
|---|---|
| `ref` 缺省或为空串，或 `value` 为 `undefined` / `null` | `invalid_params`；此时不做守卫复查，不碰页面。`value` 为 `false`、`0`、`''` 都合法 |
| 信号已中止 | `stopped`，不碰页面 |
| 其他 | 先守卫复查（失败则透传），再 `callOnRef(tabId, ref, 'formInput', [value])`；页面结果带 `error` → reject Error，`code` 为页面给的 `errorCode`，message 含页面错误文字；成功返回恰好 `{ tabId, output }`，`output` 取页面结果的 `output` |

## 9. `computer`

调用方参数：`action` 必填，其余按动作见下表。返回值是 `{ tabId, ...动作结果 }`（点击类结果恰好 `{ output, tabId }` 两个键）；动作成功后，**用「去掉 `tabId` 的动作结果」**（含截图的图片字段）调用 `recordAction(s, tabId, 'computer', params, 结果)` 并等它完成。动作失败不记帧。

### 9.1 通则

| 情形 | 结果 |
|---|---|
| 信号在调用开始时就已中止 | `stopped`，不碰任何输入 |
| `action` 不认识（含缺省） | `invalid_params`，message 含该动作名（缺省时含什么不约束） |
| 非 `wait` 的动作 | 动作开始前守卫复查一次（失败则透传，不执行）。`wait` 不复查 |

`ref` 与 `coordinate` 的关系（`left_click` / `right_click` / `double_click` / `triple_click` / `hover` 共用）：

| 入参 | 目标点 |
|---|---|
| `ref` 为真值 | `locateRef(tabId, ref)` 的结果直接作为视口坐标（不再换算）；`coordinate` 若同时给了则忽略 |
| 无 `ref`（含空串），`coordinate` 为长度恰为 2 的数组 | `toViewport(tabId, coordinate, 标签)` 的结果；标签是描述当前动作的非空字符串（自定，越界错误文字会用它，见 screenshot 规格） |
| 无 `ref`，`coordinate` 缺省 / 非数组 / 长度不是 2 | `invalid_params` |
| 下列动作里的坐标类入参（`scroll` 的 `coordinate`、`left_click_drag` 的两个端点） | 必须是长度恰为 2 的数组，否则 `invalid_params`；经 `toViewport` 换算 |

`toViewport` / `locateRef` 抛的错误**原样透传**（不包装）。

「执行步骤」= 进入后台模式并做动作本身：`withBackground(tabId, …)` 整个调用（含里面的输入、等待、截图）。**执行步骤失败时统一包装**：reject Error，`code` 取原错误的 `code`（有就保持原值），原错误没有 `code` 时为 `'computer_action_failed'`；message 含原错误的 message，前面可加自定前缀。参数校验、守卫复查、`toViewport` / `locateRef` / `pointIndicator`、`abortableSleep` 的错误**不属于**执行步骤，不包装。

`output` 里写出的坐标一律是**调用方给的原始截图坐标**（不是换算后的视口坐标）四舍五入取整后的整数（`Math.round` 语义），不含原来的小数部分。除下面明确写了「含」「以…结尾」的，`output` 的句式、大小写、附加说明全部自定。

### 9.2 各动作

| 动作 | 入参与校验 | 行为 | `output` |
|---|---|---|---|
| `left_click` / `double_click` / `triple_click` | 目标点见 9.1。`modifiers`（`+` 连接的修饰键名）为真值时，掩码 = `modifierMask(modifiers)`，否则 `0` | 必须发生：`pointIndicator(tabId, x, y)` 画指示器；点击前 `beginClickInterception(tabId)` 武装拦截并得到凭据；在 `withBackground(tabId, …)` 里调用 `click(tabId, x, y, 'left', 次数 1/2/3, 掩码, 前置检查)`，其中前置检查回调由输入模块在鼠标按下前调用，它检查停止信号（已中止则抛 `stopped`）并做一次守卫复查（所以一次点击共两次复查：动作开始前、按下前各一次）；点击成功后 `finishClickInterception(凭据, s)` 得到新标签 id 列表 | 给了 `ref` 时含 `ref` 原文，否则含取整后的 `coordinate` 两个分量；末尾直接拼上 `newTabNote(新标签 id 列表)` 的返回值（空串即不加）。单 / 双 / 三击的措辞需让人看出区别（自定） |
| `right_click` | 同上，但按钮 `'right'`、次数 1，**不**调 `beginClickInterception`（右键没有新开标签的问题） | 同上（没有拦截的凭据，不用关心 `finishClickInterception`） | 同上，不要求含新标签附注 |
| 点击类执行步骤失败 | — | 调用 `abortClickInterception(凭据)`，并按 9.1 包装失败；此时不调用 `finishClickInterception` | — |
| `hover` | 目标点见 9.1 | 必须发生：`pointIndicator` 画指示器；`withBackground` 里调 `hover(tabId, x, y)`；不拦新标签；失败包装 | 含 `ref` 原文，或取整后的坐标 |
| `left_click_drag` | `start_coordinate` 与 `coordinate`（终点）都必须是长度 2 的数组，否则 `invalid_params`（不调用输入模块） | 两点各自经 `toViewport` 换算；`pointIndicator` 画在**起点**；`withBackground` 里 `drag(tabId, 起点, 终点, signal)`；失败包装 | 含两个端点取整后的坐标 |
| `type` | `text` 必须是非空字符串，否则 `invalid_params` | `withBackground` 里 `type(tabId, text, signal)`；失败包装 | 含该文字原文 |
| `key` | `text` 必须是非空字符串；`repeat`（缺省 / `null` 为 1）必须是 1 到 100 的整数（含 100），其余（`0`、负数、小数、字符串、101）→ `invalid_params` | 见 9.3 | 含每个键（按调用方写的样子）；重复时含重复次数（自定） |
| `scroll` | `coordinate` 必须是长度 2 的数组；`scroll_direction`（缺省 `'down'`，只认 `up` / `down` / `left` / `right`，其他值 → `invalid_params` 且 message 含该值）；`scroll_amount`（缺省、`0` 等假值按 3） | 见 9.4 | 含方向、格数、取整后的坐标 |
| `scroll_to` | `ref` 必须为真值，否则 `invalid_params` | `locateRef(tabId, ref)`（它负责滚进视野），结果不用；`locateRef` 的错误透传 | 含 `ref` 原文 |
| `wait` | `duration` 必须为大于 0 的数，缺省 / `0` / 负数 → `invalid_params`；大于 10 → `invalid_params`（10 本身合法）。非数字类型（如字符串）：不约束 | `abortableSleep(duration × 1000, signal)`；它的错误透传；**不**复查守卫 | 含 `duration` 的数字写法（`0.5` 写作 `0.5`） |
| `screenshot` / `zoom` | `zoom` 的 `region`、两者的 `scale` 原样交给截图模块，合法性由它判断（它抛的错属于执行步骤，按 9.1 包装 / 保留 `code`） | 在 `withBackground` 里做：`wakeHidden(tabId)`（必须在截图开始前完成），以及 `screenshot(tabId, scale, 守卫)` 或 `zoom(tabId, region, scale, 守卫)`（守卫就是本次调用起的那个）；成功后 `cacheImage(会话名, base64, format)` 得图片 id，会话名取 `s.name`（`s` 缺省时空串） | 含图片 id。截图另含视口帧尺寸，写作 `宽x高`（数字 + 小写 `x` + 数字，如 `1280x960`）；同时含返回图尺寸 `宽x高`；两种尺寸相同时是否写两遍：自定。`zoom` 含返回图尺寸 `宽x高` |

截图 / `zoom` 的结果还带 `imageId`（图片 id）、`base64Image`（图片 base64）、`imageFormat`（`'png'` 或 `'jpeg'`），与 `output`、`tabId` 一起返回。

### 9.3 `key` 动作

| 情形 | 结果 |
|---|---|
| `text` 按空白拆成键列表，恰好 1 个键，且转成小写后属于「刷新键」 | 不按任何键，改为 `chrome.tabs.reload(tabId, { bypassCache })`：`bypassCache` 对「强制刷新键」为 `true`，对「普通刷新键」为 `false`；`repeat` 在这条路径上无效；`output` 含该键（按调用方写的样子）。`reload` 自己抛错：不约束 |
| 其他（含刷新键与别的键混在多键里——此时刷新键按普通键处理） | 键列表里**任一**键被 `isZoomChord(键)` 判为真 → `invalid_params`，message 含该键，一个键都不按。否则在 `withBackground` 里把「整个键列表」按顺序重复 `repeat` 遍，逐个 `key(tabId, 键)`；不变量：信号中止之后不再发出任何按键，此时失败的 `code` 为 `'stopped'`。键列表按空白拆分，首尾空白与连续空白产生的空段丢弃。执行步骤失败按 9.1 包装 |

刷新键（Chrome 公开的快捷键）：至少含下面 6 个，其余自定。普通刷新 = `cmd+r`、`ctrl+r`、`f5`；强制刷新（绕过缓存）= `cmd+shift+r`、`ctrl+f5`、`shift+f5`。`text` 只含空白时按几个键：不约束。

### 9.4 `scroll` 动作

滚动量 = 格数 × 100 像素，方向：`up` = `(0, -量)`、`down` = `(0, +量)`、`left` = `(-量, 0)`、`right` = `(+量, 0)`（`wheel` 的 `deltaX, deltaY`）。`100`：浏览器一格鼠标滚轮的常用像素数；缺省 3 格：MCP 程序对代理公布的 `scroll_amount` 缺省值。

| 情形 | 结果 |
|---|---|
| 滚轮正常返回 | 成功；不调页内滚动；兜底计时器被清除（不残留） |
| `wheel(tabId, x, y, dx, dy)` 抛错，或 6 秒内没有返回 | 改调 `inPage(tabId, 'scrollFallback', [x, y, dx, dy])`（`x`、`y` 是换算后的视口坐标，不是调用方给的截图坐标）（主 frame，由页面脚本自行完成等效滚动）；它成功则整个动作成功 |
| 页内滚动也失败 | 按 9.1 包装失败（执行步骤失败） |

「6 秒」用一次全局 `setTimeout` 表达，延时参数就是 `6000`（毫秒）；不用墙钟比较或分段轮询（测试会替换全局 `setTimeout`，把延时恰为 `6000` 的那一次缩短）。来由：项目自定。滚轮事件可能因页面被挂起而一直没有回应，需要一个出口；6 秒远长于正常耗时（毫秒级），又不至于让代理空等太久。

## 10. 其余工具

| 方法 | 行为 |
|---|---|
| `tabs_context_mcp` | `listTabs(s)` 得到标签数组，返回 `{ availableTabs, tabGroupId: s.groupId, initialTabId: s.mainTabId }`。`availableTabs` 与原数组同序，每项 `{ tabId: 标签 id, title: redactTitle(标题, 地址), url: redactUrl(地址) }`；其中「地址」见下表；标题缺省按 `''`；`redactTitle` 的第二个参数是未脱敏的地址。 |
| `tabs_create_mcp` | 在会话所属窗口（`s.windowId`）里新开一个**不激活**的标签，地址 `about:blank`；开出后 `joinGroup(s, 新标签 id)`；返回 `{ tabId: 新标签 id, title: '', url: 'about:blank' }`。参数里的 `tabId` 不做准入 |
| `tabs_close_mcp` | `chrome.tabs.remove(params.tabId)`；返回 `{ tabId: params.tabId }`。（`params.tabId` 在给了时已在 4.2 节准入；组外标签不会被关。缺省时的行为不约束） |
| `navigate` | `navigate(tabId, params, signal)`（`params` 内容原样交给它）；成功后 `recordAction(s, tabId, 'navigate', params, 结果)` 并等它完成；返回 `{ tabId, ...结果 }`。失败：错误透传，不记帧 |
| `jev_observe` | `observe(tabId, { max: params.max }, signal)`——对象里只有 `max` 这一个键，`params.max` 没给就是 `undefined`（不代为填缺省）；结果**原样**返回，不加 `tabId` |
| `gif_creator` | `gifCreator(params, s, tabId)`；返回 `{ tabId, ...结果 }` |
| `batch_begin` / `batch_end` | 分别调一次 `beginBatch()` / `endBatch()`，返回 `{}`。这对调用供 MCP 的 `browser_batch` 圈定一批；批内截图的坐标上下文何时生效由截图模块处理，本模块只负责开关 |
| `javascript_tool` | `javascriptTool(params, s, 守卫)`，结果原样返回 |
| `file_upload` / `upload_image` | `fileUpload(params, s, 守卫)` / `uploadImage(params, s, 守卫)`，结果原样返回 |
| `read_console_messages` / `read_network_requests` | `readConsole(params, s, g)` / `readNetwork(params, s, g)`，其中 `g` 恒为 `undefined`（不守卫）；结果原样返回 |
| `resize_window` / `upload_stash` | `resizeWindow(params)` / `uploadStash(params)`（只传 `params`），结果原样返回 |

`tabs_context_mcp` 的「地址」：

| 标签的 `url` | `pendingUrl` | 地址 |
|---|---|---|
| 有（非空字符串） | 任意 | `url` |
| 缺省（`undefined` / `null`） | 有 | `pendingUrl` |
| 缺省 | 缺省 | `''` |
| 空串 | 有 | 不约束（`url` 或 `pendingUrl` 均可） |

委托类工具（`javascript_tool` 到 `upload_stash`）把调用方的参数不加删改地交给对应模块；错误同一个对象透传。

## 11. 常量一览与来由

| 常量 | 值 | 来由 |
|---|---|---|
| `PROTOCOL_VERSION` | 1 | 项目自定，见第 1 节 |
| 默认输出字符上限 | 50000 | MCP 对代理公布的 `max_chars` 缺省值 |
| 昵称长度 | 60 | 项目自定，见第 6.4 节 |
| 单次 `key` 的 `repeat` | 1 – 100 | MCP 对代理公布的参数范围；防止一次调用无限连按 |
| `wait` 上限 | 10 秒 | MCP 对代理公布的工具描述（最长 10 秒）；更长的等待应拆成多次，免得一次调用长时间占着、Stop 迟迟不能生效 |
| 滚动每格 | 100 像素 | 浏览器滚轮一格的常用像素数 |
| 滚动缺省格数 | 3 | MCP 对代理公布的缺省 |
| 滚轮兜底 | 6000 毫秒 | 项目自定，见第 9.4 节 |
| 刷新键清单 | 见 9.3 | Chrome 公开的刷新快捷键 |
| 连接窗口类型 | popup、获得焦点 | 项目自定：让用户一眼看到并及时确认；尺寸自定 |

## 12. 测试不断言（全部自定）的输出

各动作 `output` 的句式、大小写、标点、附加说明；子 frame 标题行的写法；错误 message 的措辞（除「含某入参原文」的情形外）；确认小窗的宽高；复查守卫时的阶段标签文字。
