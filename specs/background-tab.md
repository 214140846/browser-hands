# background-tab 模块规格

负责：让代理在**不在前台**的标签上也能截图、输入、点击。三件事：

1. 后台标签做截图 / 输入时，临时让页面以为自己有焦点（CDP 焦点模拟），并临时静音；做完立即撤掉。
2. 隐藏标签截图前，先请浏览器出一张极小的图，促使它恢复渲染。
3. 窗口最小化时，代理点到「会开新窗口 / 新标签」的链接，浏览器自己开的新窗口会抢前台；改为在页面里拦下这次点击、记下网址，由扩展在后台开标签并放进原标签所在的组。

## 1. 冻结的导出签名

| 导出 | 参数 | 返回 |
|---|---|---|
| `withFocusEmulation` | `tabId: number`，`fn: () => T \| Promise<T>` | `Promise<T>`：`fn` 的结果；`fn` 抛错 / reject 时以**同一个错误对象** reject |
| `withBackground` | 同上 | 同上 |
| `wakeHidden` | `tabId: number` | `Promise<void>`，永不 reject |
| `beginClickInterception` | `tabId: number` | `Promise<凭据 \| null>`，永不 reject |
| `abortClickInterception` | `凭据 \| null` | `Promise<void>`，永不 reject |
| `finishClickInterception` | `凭据 \| null`，`session?: { groupId: number } \| null`（会话对象，本模块只读 `groupId`，并原样交给 `joinGroup`） | `Promise<number[]>`：新开且已就位的标签 id，永不 reject |
| `newTabNote` | `ids: number[]` | `string`，**同步** |

只有这 7 个导出。「凭据」是不透明的非 null 对象，字段自定；调用方只把它原样交回 `abortClickInterception` / `finishClickInterception`，不读字段。

## 2. 依赖

| 模块 | 导出 | 签名 | 本模块依赖它的什么 |
|---|---|---|---|
| `./debugger.js` | `send` | `(tabId: number, method: string, params?: object) => Promise<any>`，失败 reject | 发 CDP 命令：`Emulation.setFocusEmulationEnabled`（参数 `{ enabled: boolean }`）、`Page.captureScreenshot` |
| `./debugger.js` | `withDebugger` | `<T>(tabId: number, fn: () => Promise<T>) => Promise<T>`，调试器的占用与释放由它负责，返回 `fn` 的结果、透传 `fn` 的错误 | `withBackground` 的外层 |
| `./sessions.js` | `joinGroup` | `(session: object, tabId: number) => Promise<unknown>`，把标签并入该会话的组；失败 reject | 新开标签所属的组正是 `session.groupId` 时，用它入组 |

用到的 Chrome API（都按 Promise 形式调用）：

- `chrome.tabs.get(tabId)`：读 `active`、`windowId`、`index`、`groupId`、`audible`、`mutedInfo`；取不到时 reject。
- `chrome.windows.get(windowId)`：读 `focused`、`state`；取不到时 reject。
- `chrome.tabs.update(tabId, { muted })`
- `chrome.tabs.create(props)`、`chrome.tabs.group({ tabIds, groupId })`
- `chrome.scripting.executeScript({ target: { tabId }, injectImmediately: true, func })`：结果是 `{ result }` 数组。
- `chrome.runtime.id`、`chrome.tabGroups.TAB_GROUP_ID_NONE`（不在组里的标签的 `groupId`）。

### 导入时的副作用

- 在 `globalThis.__jevBg` 上放一个对象，含函数 `activeCount(): number`，返回**当前处于焦点模拟中的标签个数**（不是任务个数）。端到端测试在 service worker 里靠它检查有没有残留，名字属接口。
- 不挂任何 Chrome 事件监听，不调用任何 Chrome API。

## 3. 错误形状

本模块不产生自己的错误。所有 Chrome / CDP 失败都吞掉，按下表给出确定结果；唯一会 reject 的是 `withFocusEmulation` / `withBackground` 透传 `fn`（或 `withDebugger`）的错误。

| 失败 | 结果 |
|---|---|
| 读不到标签 | `withFocusEmulation`：按「不需要模拟」直接执行 `fn`；`wakeHidden`：什么都不做；`beginClickInterception`：`null` |
| 读不到窗口 | 前后台判定：按「后台」；`beginClickInterception`：`null` |
| 开启焦点模拟的命令失败 | `fn` 照常执行、结果照常返回；本轮是否加静音不约束；但只要这一轮加了静音，结束时就必须撤掉，不得残留本模块加的静音 |
| 关闭焦点模拟的命令失败 | 吞掉；静音照常按第 4 节撤销 |
| 静音 / 解除静音失败 | 吞掉 |
| 小图截图命令失败 | 吞掉 |
| 注入页面脚本失败 | `beginClickInterception` → `null`；`abortClickInterception` 正常结束；`finishClickInterception` → `[]` |
| 开标签 / 入组失败 | 见第 6 节 |

## 4. 焦点模拟 `withFocusEmulation`

### 前台判定

标签算「前台」，当且仅当：它是所在窗口的活动标签，且该窗口有焦点，且窗口未最小化。

| `tab.active` | 窗口 `focused` | 窗口 `state` | 判定 |
|---|---|---|---|
| `false` | 任意 | 任意 | 后台 |
| `true` | `false` | 非最小化 | 后台 |
| `true` | `true` | `minimized` | 后台 |
| `true` | `true` | `normal` / `maximized` / `fullscreen` | 前台 |
| `true` | 读不到窗口 | — | 后台 |

### 何时模拟

「模拟轮」指同一标签上一段连续处于模拟中的时间：从第一个需要模拟的调用开始，到该标签上所有参与的调用都结束为止。

| 调用时的情形 | 结果 |
|---|---|
| 前台，且本标签没有进行中的模拟轮 | 直接执行 `fn`，不发 CDP 命令，不碰静音 |
| 读不到标签，且没有进行中的模拟轮 | 同上 |
| 后台，且没有进行中的模拟轮 | 开启新一轮 |
| 本标签已有进行中的模拟轮（不论此刻前后台） | 加入这一轮，不再发开启命令 |
| 同一标签上两个首次调用在同一瞬间同时发起（此刻尚无进行中的轮） | 是否合并成一轮**不约束**；测试不覆盖。只要有一个调用已经开始执行 `fn`，后来者就按上一行处理 |

一轮之内：

| 可观察结果 | 约束 |
|---|---|
| 开启命令 `send(tabId, 'Emulation.setFocusEmulationEnabled', { enabled: true })` | 每轮恰好 1 次 |
| 关闭命令（同上，`enabled: false`） | 每轮恰好 1 次，在这一轮最后一个调用的 `fn` 结束之后才发 |
| 每个参与调用的 `fn` 被执行时 | 开启命令已经有了结果（成功或失败）；要静音的话，静音已经生效 |
| 不同标签 | 各自独立成轮，互不影响 |
| `activeCount()` | 一轮进行中计 1；该轮最后一个调用结束后不再计入（不必等关闭命令完成）。「结束」包括 `fn` 失败：失败的调用同样算结束 |

### 静音

目的：后台页面因为「有焦点」而开始播放的声音不打扰用户。只撤销自己加的静音。

| 开启时标签的情形 | 本轮是否静音 |
|---|---|
| 没在出声（`audible` 假）且未静音 | 静音（`chrome.tabs.update(tabId, { muted: true })`） |
| 正在出声 | 不静音 |
| 已经静音（不论谁静的） | 不动 |

| 一轮结束时（本轮加过静音） | 处理 |
|---|---|
| 标签仍静音，且 `mutedInfo.reason === 'extension'`、`mutedInfo.extensionId === chrome.runtime.id` | 解除静音 |
| 期间用户改成了自己静音（`reason` 为 `user` 等） | 保持静音 |
| 期间已被解除静音 | 不动 |
| 读不到标签 | 不动 |

`mutedInfo` 的 `reason` / `extensionId` 是 Chrome `tabs.MutedInfo` 的公开字段。

### 结束时机

| 情形 | 结果 |
|---|---|
| 最后一个 `fn` 成功 | 调用在关闭命令与解除静音都完成后才 resolve |
| 最后一个 `fn` 失败 | 立即以该错误 reject，不等关闭命令（页面跳转挂起时关闭命令可能迟迟不回，不能拖住报错）；关闭命令与解除静音仍会照常发出并完成；`activeCount()` 立即不再计入该标签 |
| 同一轮里非最后一个的 `fn` 失败 | 该调用立即以其错误 reject；这一轮不受影响：不发关闭命令，其余调用继续，仍计入 `activeCount()`，直到最后一个调用结束才关闭 |
| 同一轮里先有 `fn` 失败，最后一个 `fn` 成功 | 最后一个调用按「成功」处理：等关闭命令与解除静音完成才 resolve |
| 同一标签上一轮的关闭（含解除静音）还没完成时来了新调用（不论前后台） | 等它完成后才执行新调用的 `fn` / 发新一轮开启命令 |
| 上一轮已结束、又来后台调用 | 开启新的一轮（再发一次开启命令） |

## 5. `withBackground` 与 `wakeHidden`

`withBackground(tabId, fn)`：在 `withDebugger(tabId, …)` 的回调里执行 `withFocusEmulation(tabId, fn)`。可观察：`withDebugger` 以该 `tabId` 被调用；`fn` 执行时处于 `withDebugger` 回调期间；返回值 / 错误原样穿过。

`wakeHidden(tabId)`：

| 情形 | 结果 |
|---|---|
| 读不到标签 | 不发命令 |
| 前台（判定同第 4 节） | 不发命令 |
| 后台 | 发 1 次 `send(tabId, 'Page.captureScreenshot', params)`，`params.clip` 为页面左上角 1×1 区域（`x: 0, y: 0, width: 1, height: 1, scale: 1`）；其余参数自定，须是该 CDP 方法接受的合法参数。结果丢弃 |

常量来由：1×1 是截图能取的最小区域，只为触发渲染，不要图像本身。

## 6. 点击拦截

### 6.1 `beginClickInterception(tabId)`

| 情形 | 结果 |
|---|---|
| 标签所在窗口已最小化，注入成功 | 返回凭据（非 null 对象） |
| 窗口未最小化（含 `normal`、有无焦点都一样） | `null`，不注入 |
| 标签没有 `windowId`、读不到标签或窗口 | `null`，不注入 |
| 注入失败 | `null` |

注入：`chrome.scripting.executeScript`，`target` 只给 `tabId`（只注入顶层文档），`injectImmediately: true`（点击马上就要发生，不能等页面空闲）。

### 6.2 页内拦截守卫（注入函数的行为）

本模块通过 `executeScript` 注入的函数必须**自包含**：不引用模块作用域里的任何东西，能被单独序列化后在页面里执行（声明式函数、函数表达式或箭头函数）。页内状态挂在页面全局上，名字自定；同一页面先后两次注入（「武装」与「取回」）共用这份状态。

**武装**（`beginClickInterception` 注入）之后，页面上每一次点击按下表判定；「拦截」= 阻止默认动作（不开新窗口 / 新标签）并把链接的绝对地址（`a.href`）追加到记录里。

链接与目标：

| 情形 | 拦截？ |
|---|---|
| 可信点击（用户 / CDP 输入）落在带 `href` 的 `<a>`（或其后代）上，目标为 `_blank`，地址 http(s) | 是 |
| 目标大小写不同（`_BLANK`）或前后有空白 | 按去空白、不分大小写的结果判 |
| 目标为 `_self` / `_parent` / `_top`（不分大小写）或为空 | 否 |
| `<a>` 没有 `target` 属性，文档里有 `<base target="_blank">` | 是 |
| `<a>` 有 `target` 属性但值为空串，即使文档有 `<base target="_blank">` | 否 |
| 目标是别的名字，且不等于当前窗口的 `name`，页面里也没有同名的 `iframe` / `frame` | 是（浏览器会开新窗口） |
| 目标是别的名字，等于当前窗口 `name` | 否 |
| 目标是别的名字，页面里有同名 `iframe` / `frame` | 否 |
| 链接在开放 shadow root 内 | 与在普通文档里相同 |
| 相对地址（`/p`） | 记录解析后的绝对地址 |

目标的解析规则（`target` 属性优先于 `<base target>`）来自 HTML 规范「get an element's target」。

不拦截（不阻止、不记录）：

| 情形 |
|---|
| 不可信点击（脚本调用 `el.click()` / `dispatchEvent`） |
| 页面自己的监听已阻止默认动作 |
| 地址不是 http / https（`mailto:`、`javascript:` 等） |
| `<a>` 没有 `href` |
| 点击落在链接内部的另一个交互元素上（HTML 规范「interactive content」类别，至少包括 `button`、`input`、`label`、可编辑元素；其余成员自定） |
| `<a>` 自身处在可编辑区域内 |
| 带 `download` 属性且与页面同源（浏览器会下载而非导航；跨源的 `download` 按 HTML 规范被忽略，仍按目标判定） |
| 文档源为不透明源（如沙箱页面）（测试不覆盖） |
| 武装后超过 10 秒 |
| 未武装，或已被取回 |

武装状态：

| 情形 | 结果 |
|---|---|
| 武装期间多次拦截 | 记录按点击顺序全部保留（含重复地址） |
| 再次武装 | 记录清空、10 秒重新计；不重复挂监听（一次点击只记一条） |

计时用页面时钟（`Date` / `performance` 均可）；测试会用 Playwright 的页面时钟快进。10 秒来由：项目自定，单次点击动作远在 1 秒内完成，上限只防 `finish` 没被调用时守卫一直生效。

武装与取回注入的函数，参数（`args`）必须能 JSON 序列化（没有参数也可）；取回函数同样自包含。测试取「最后一次注入的脚本」，按 `func` 与 `args` 序列化后在页面里直接运行它，以查看原始记录。

**取回**（`abort` / `finish` 注入）：返回记录的地址数组并解除武装、清空记录；从未武装过的页面返回空数组。

### 6.3 `abortClickInterception(凭据)`

| 情形 | 结果 |
|---|---|
| `null` | 什么都不做，不调 Chrome API |
| 凭据 | 在原标签取回并丢弃记录（之后点击不再被拦）；不开标签 |

### 6.4 `finishClickInterception(凭据, session)`

`null` → `[]`，不调 Chrome API。否则在原标签取回记录：取回结果合并各帧返回值里的数组，不是数组的忽略；注入失败按空。

| 记录 → 要开的地址 | 规则 |
|---|---|
| 重复地址 | 只开一次（按字符串完全相同判） |
| 非 http(s) 地址（协议不分大小写） | 丢弃 |
| 超过 3 个 | 只开前 3 个 |

即：要开的地址 = 去重并过滤后的有序列表中的前 3 个（先后顺序保持取回时的相对顺序）；过滤前的条数、被丢弃的条目不占名额。

常量来由：3 个，项目自定；一次点击正常只开一个标签，留余量的同时防止页面借一次点击开出一串标签。

每个地址开一个标签：

| 情形 | 结果 |
|---|---|
| 正常 | `chrome.tabs.create` 参数含：`url`、`active: false`、原窗口 `windowId`、`openerTabId` 为原标签、`index` 依次为原标签位置 +1、+2、+3（紧挨原标签右侧，按点击顺序） |
| 上面这次创建失败 | 再试一次，只给 `url` 与 `active: false` |
| 两次都失败 | 跳过这个地址，继续下一个 |
| 新标签不在原窗口里（`windowId` 不同）或没有 `id` | 不计入结果 |

新标签的窗口、位置与入组所用的组，都取自 `beginClickInterception` 当时的原标签状态，不取 `finish` 时：begin 之后原标签被拖进别的组、换了位置或换了窗口，不改变结果。

入组（按原标签在 begin 时所在的组）：

| 原标签的组 | 处理 | 计入结果？ |
|---|---|---|
| 不在组里（`TAB_GROUP_ID_NONE` 或缺省） | 不入组 | 是 |
| 在组里，且 `session.groupId` 等于它 | `joinGroup(session, 新标签 id)` | 成功是，失败否 |
| 在组里，`session` 缺省或组不同 | `chrome.tabs.group`，`groupId` 为原组，`tabIds` 为新标签 id（单个 id 或单元素数组均可） | 成功是，失败否 |

返回计入结果的新标签 id，按地址顺序。

## 7. `newTabNote(ids)`

| `ids` | 结果 |
|---|---|
| `[]` | `''` |
| 非空 | 非空英文字符串，以空白字符开头（调用方直接拼在工具输出后面），每个 id 都以十进制整数出现，并告诉代理用这个标签 id 去操作新标签；措辞自定 |
