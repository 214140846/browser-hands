# logs 模块规格

给代理读标签页的控制台输出和网络请求。监听是懒开启的：某个标签第一次被读取时才开始收集，之前发生的不补。记录按标签分开存，标签换到别的网站时清空，长时间没人读就自动停止收集。

## 1. 冻结的接口

### 导出

| 导出 | 形态 | 参数 | 返回 |
|---|---|---|---|
| `readConsole` | 异步函数 | `p: { tabId?: number, onlyErrors?: boolean, pattern?: string, limit?: number, clear?: boolean }`，`s: { mainTabId: number }`，`g?: { check(toolName: string): Promise<void> }` | `Promise<{ tabId: number, output: string }>` |
| `readNetwork` | 异步函数 | `p: { tabId?: number, urlPattern?: string, limit?: number, clear?: boolean }`，`s`、`g` 同上 | `Promise<{ tabId: number, output: string }>` |

只有这两个导出。

### 全局测试钩子

模块加载后在 `globalThis.__jevLogs` 上放一个对象（端到端测试在 service worker 里靠它查状态，属接口）：

| 成员 | 参数 | 作用 |
|---|---|---|
| `setIdleMs` | `n: number` | 改空闲超时毫秒数，对之后的读取生效 |
| `isListening` | `tabId` | 该标签当前是否在收集，返回 boolean |
| `stop` | `tabId` | 立即停止该标签的收集（同空闲超时的效果） |
| `counts` | `tabId` | `{ console: number, network: number }`，当前存了几条；没跟踪过的标签两项都是 0 |

### 依赖的同仓模块接口（只用这些名字和签名）

| 模块 | 导出 | 签名 | 用途 |
|---|---|---|---|
| `./debugger.js` | `send` | `(tabId, method: string, params?, ms?) => Promise<any>`，没挂就自动挂上，失败 reject | 发开启 / 关闭域命令 |
| `./debugger.js` | `onDebuggerEvent` | `(h: (tabId, method: string, params: any) => void) => void` | 订阅 CDP 事件，同步回调 |
| `./debugger.js` | `onDebuggerAttached` | `(h: (tabId) => void) => void` | 订阅「该标签刚挂上调试器」（含断开后重挂） |
| `./debugger.js` | `holdDebugger` | `(tabId) => void` | 之后不再因空闲断开（Chrome 侧断开不自动重挂、已在走的计时不撤销） |
| `./debugger.js` | `releaseDebugger` | `(tabId) => void` | 不再要求保持 |
| `./debugger.js` | `isAttached` | `(tabId) => boolean` | 当前是否挂着（只看 debugger 模块自己的记账，不问 Chrome） |
| `./sessions.js` | `sessionClosedHooks` | 数组，往里 push 回调 `(tabIds: number[], sessionId: string) => void` | 会话关闭通知 |
| `./sessions.js` | `resolveTabId` | `(p, s) => number`，取 `p.tabId`，没有则 `s.mainTabId` | 目标标签 |
| `./redact.js` | `redactUrl` | `(url: string) => string` | 网址脱敏 |

不用 debugger.js 的其他导出（如 `attach`）。模块加载时就登记：`onDebuggerEvent`、`onDebuggerAttached`、`sessionClosedHooks`、`chrome.tabs.onUpdated`、`chrome.tabs.onRemoved`。

### 同步性

CDP 事件、`tabs.onUpdated`、`tabs.onRemoved`、会话关闭这四个处理器在回调内**同步**改完状态，回调返回后 `counts` / `isListening` 立即反映结果（不能放进微任务或计时器）。

### 运行环境约定（单测替身照此实现）

- `chrome.tabs.get(id)` 返回 Promise，取不到时 reject。
- 事件派发是同步的：`addListener` 登记的回调在派发时当场执行。
- 单测用 `mock.module` 把 `debugger.js`、`sessions.js` 换成按上表签名写的替身，所以本模块只能经上表接口用它们；直接调 `chrome.debugger.*`（真实环境里 `sendCommand` 走回调 + `chrome.runtime.lastError`）属于 debugger.js 的职责，本模块不碰。

## 2. 收集的开与关

| 情形 | 可观察结果 |
|---|---|
| 某标签从未被读取 | 不收集，期间的 CDP 事件不留下任何记录 |
| 第一次读取（任一函数） | 读取返回时：该标签处于收集状态，调试器被要求保持挂载，`Runtime` 与 `Network` 两个域已开启 |
| 开启域失败 | 本次读取抛错；该标签不处于收集状态，也不再要求保持挂载 |
| 自最近一次读取起满空闲时长（默认 60000 ms） | 之后不再记录新事件；不再要求保持挂载；调试器仍挂着时两个域被关闭（关闭失败不影响什么）；已存记录保留 |
| 收集中再次读取 | 空闲期限从这次读取起算；域不会被重复开启 |
| 停止后再读 | 与第一次读取相同 |
| 收集中的标签调试器重新挂上 | 两个域重新处于开启状态（失败不报） |
| 标签关闭；或会话关闭时它在那批标签里 | 不再收集，该标签记录全部消失 |

## 3. CDP 事件 → 记录

只处理正在收集的标签。读取时按事件到达的先后列出。

### 控制台（`Runtime.consoleAPICalled`、`Runtime.exceptionThrown`）

| 情形 | 读出来能看到的 |
|---|---|
| 一次控制台调用 | 一条记录，类型标签为该调用的 CDP 类型（没给时当普通日志），正文为调用参数的文本化结果，可能有调用位置 |
| 参数是字符串、数字、布尔等基本值 | 正文里出现该值的常规文本 |
| 参数是对象、函数等 | 正文里出现 CDP 给出的描述文本 |
| 多个参数 | 各参数文本按出现次序、以空格分隔出现在正文里 |
| 调用带调用位置 | 条目里显示脱敏后的 `地址:行:列` |
| 一次未捕获异常 | 一条类型为 `exception` 的记录；异常对象带描述时，正文里能看到该描述；不带时能看到事件的 text；两者都没有时给一个通用占位（文案自定）；带调用栈时列出各帧，格式自定，但每帧可见函数名（有的话）和脱敏后的 `地址:行:列` |
| 正文里出现 `http://` / `https://` 网址 | 读出来的是脱敏后的网址 |

长度：

| 情形 | 结果 |
|---|---|
| 某个参数文本超过上限 | 读出的该参数只剩开头约上限长度（误差 ≤ 1 字符），不加省略符 |
| 参数总量很大 | 整条正文不超过约两倍上限；第一个参数一定可见 |
| 异常正文超过上限 | 读出的正文恰为上限长度（不含网址脱敏带来的变化） |

上限 = 16384 字符。

### 网络（`Network.requestWillBeSent`、`Network.responseReceived`、`Network.loadingFailed`）

| 情形 | 读出来能看到的 |
|---|---|
| 发出一个请求 | 一条记录，可见脱敏后的地址和方法，状态为「未完成」 |
| 该请求收到响应 | 同一条显示响应状态码 |
| 该请求加载失败 | 同一条显示 503 |
| 响应 / 失败事件对应的请求不在记录里 | 没有任何变化 |

### 容量

| 列表 | 每标签上限 | 超出时 |
|---|---|---|
| 控制台 | 10000 条 | 最早的一条消失 |
| 网络 | 1000 条 | 最早的一条消失，之后它的响应 / 失败事件也不再起作用 |

## 4. 换站清空

| `chrome.tabs.onUpdated` 情形 | 结果 |
|---|---|
| 标签没被跟踪过 | 什么都不做 |
| 更新信息里没有新地址 | 什么都不做 |
| 新地址的主机名与记下的相同（只换路径、查询、片段） | 保留记录 |
| 主机名不同 | 两类记录都清零；之后旧请求的响应 / 失败事件不再生效；收集照旧继续，此后以新主机名判断是否换站 |

主机名：能解析的取 hostname；解析不了或为空的地址之间视为同一站点。标签被跟踪时（第一次读取）记下当时的主机名。

## 5. 读取

两个函数共同的失败情形：

| 情形 | 结果 |
|---|---|
| 取标签信息失败 | 抛错（见第 7 节） |
| 标签没有地址（缺失或空串） | 抛错，消息说明拿不到该标签的地址 |
| 传了守卫 `g`，`g.check` 拒绝 | 抛错；工具名：控制台 `read_console_messages`，网络 `read_network_requests` |

守卫以工具名调用；守卫拒绝或上述任一失败时，读取抛错且不开始收集。

### readConsole 筛选

| 参数 | 规则 |
|---|---|
| `onlyErrors` 为真 | 只要错误级别的：console.error 输出和未捕获异常 |
| `pattern` 是合法正则 | 不区分大小写，对正文做正则测试 |
| `pattern` 不是合法正则 | 不区分大小写的子串包含 |
| `limit` | 默认 100；从最早的开始取前 `limit` 条 |
| `clear` 为真 | 本次照常返回，之后清空该标签**全部**控制台记录（包括没匹配上的） |

### readNetwork 筛选

| 参数 | 规则 |
|---|---|
| `urlPattern` | 在脱敏后的地址上做区分大小写的子串包含 |
| `limit` | 默认 100；从最早的开始取 |
| `clear` 为真 | 本次照常返回，之后清空该标签全部请求并忘掉 id |

## 6. 输出（英文，文案新写）

### 有结果

`output` 先给一句概述，再列条目；排版自定，条目之间要能分清。

标题必须含命中总数；被 `limit` 截断时还要含显示条数和总数；网络读取有 `urlPattern` 时回显它。建议文案：

- 控制台：`{total} console entries captured` / 只看错误时 `{total} error entries captured`，截断时追加 ` — listing the oldest {shown}`，末尾冒号。
- 网络：`{total} request(s) captured`，有过滤时追加 ` matching "{urlPattern}"`，截断时同上。

控制台条目里要能看到：序号、时间（格式自定，测试不断言）、**类型的大写形式**（如 `LOG`、`ERROR`、`WARNING`、`EXCEPTION`，单独成词）、调用位置（有的话）、正文、调用栈（有的话，格式见第 3 节）。

网络条目里要能看到：序号、脱敏后的地址、方法、状态码数字；未完成的用一个不含数字的标记（文案自定）。

### 没有结果

不出现任何条目。文案要说明：没找到（控制台区分「消息」和「错误」两种说法；网络有 `urlPattern` 时带上它）；收集是从第一次调用本工具才开始的，页面早先的输出要刷新页面（网络还可以操作页面触发请求）才能看到。必须含 `refresh` 或 `reload` 一词。建议文案：

- 控制台：`Nothing in the console {log|error} buffer for this tab yet. Capture begins with the first call to this tool, so reload the page to collect output from its initial load.`
- 网络：`No captured requests{ matching "{urlPattern}"} for this tab yet. Capture begins with the first call to this tool; reload the page or interact with it to generate traffic.`

## 7. 错误

读取过程中任何异常都包成新的 `Error` 抛出：

- 消息 = 一段说明是哪个工具读取失败的前缀（新写，如 `Could not read console output` / `Could not read network activity`）+ `: ` + 原错误消息；原错误没有消息时给一个通用占位（文案自定）。
- 原错误带 `code` 时新错误保留同一个 `code`；没有就不带（或为 undefined）。

## 8. 常量来由

- 空闲 60 秒：与调试器模块的空闲断开时长一致。代理读日志通常是「操作一下 → 读一下」的节奏，60 秒足够覆盖一轮；更长会让调试器条幅一直挂着、让 Network 域白白占内存。可经测试钩子调小。
- 正文上限 16384（16 KiB 字符）：与脱敏模块的网址长度上限同值。一条日志超过这个长度对代理已无阅读价值，还会撑爆一次工具返回。
- 控制台 10000 条 / 网络 1000 条：控制台条目小、刷屏型页面一分钟就能产出上千条，给大一些；网络条目在单页会话里很少过千，超过时最早的请求通常已无关。两者都是为了在长时间开着的标签上限制内存。
- 失败记 503：CDP 的加载失败事件没有 HTTP 状态码，用「服务不可用」这个通用 5xx 让代理一眼看出是失败请求，又与真实的 2xx/3xx/4xx 区分开。
- 默认 limit 100：一次返回的条目数控制在代理能读完的量。
- 换站按主机名判断（而不是按每条消息来源脚本的域名）：CDN 上的脚本域名与页面不同，按脚本域名会把正常日志误清。

## 9. 边界清单

- `limit` 为 0：标题照常给总数，没有条目。
- `pattern` 为空串：视为没给。
- 读取时 `onlyErrors` 与 `pattern` 同时给：两个条件都要满足。
- 同一标签控制台与网络共用一次收集开关：读任一个都会让两类事件开始收集。
- 已停止收集的标签，记录还在，`counts` 仍能看到；再读时能读到停止前收集的内容。
- 被丢掉的旧请求之后又来了同 id 的响应：忽略，不新增条目。
