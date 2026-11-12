# mcp 模块规格（server 端入口）

本模块是 MCP 服务器的入口：启动时注册一组浏览器操作工具，通过标准输入输出与 MCP 客户端（Agent）说话；每次工具调用选定一个在线浏览器，把调用转给该浏览器里的插件，再把插件返回的东西整理成文本（外加图片）交给客户端。另有三个管理多浏览器的工具、一组「快速小模型」工具（找元素 / 判断页面真假 / 多步任务）和一个把多项调用打包顺序执行的批处理工具。

对外接口 = 工具名、参数名 / 类型 / 必填性 / 取值范围、错误码、转发行为。工具和参数的 description 文案、服务器说明文案**全部自定**，本规格不给也不冻结。

## 1. 导出与导入时的副作用

本模块**没有任何导出**（`Object.keys` 为空）。它是入口脚本，导入即启动：

| 副作用 | 要求 |
|---|---|
| 创建 MCP 服务器 | 对客户端报告的服务器名为 `thundermcp`；版本号自定 |
| 服务器说明（instructions） | 取自同目录的说明文本文件，整份下发；文件开头若有一行 HTML 注释（`<!-- ... -->` 独占首行），该行不下发。下发的说明为非空字符串，且不以 `<!--` 开头。内容自定 |
| 注册工具 | 恰好 26 个，见第 3 节 |
| 连上标准输入输出传输 | 导入时同步等待连接完成（顶层 await）；用的是 SDK 的标准输入输出服务器传输 |
| 监听标准输入关闭 | 对 `process.stdin` 挂一个 `close` 监听：触发时以退出码 0 结束进程（父进程退出后不留孤儿进程） |

不启动计时器，不读取环境变量（`switch_browser` 调用时才读，见第 9 节）。

可观察的跨调用行为：会话标识在整个进程内跨调用不变（5.2）；批内各项不附标签块，批结束后独立调用恢复附标签块（第 8 节）。

## 2. 依赖表

| 模块 | 导出 | 签名 | 本模块依赖它的行为 |
|---|---|---|---|
| `./paths` | `PROTOCOL_VERSION` | `number` | 与插件握手时报告的协议版本比对 |
| `./browsers` | `explainNoBrowser` | `() => Promise<string>` | 没有在线浏览器时给出的解释文字 |
| `./browsers` | 类型 `Conn` | `{ call(method: string, params?: unknown, sessionId?: string): Promise<any> }` | 与插件通信。失败时 reject 一个 `Error`，其 message 通常形如 `code: 文字`；本模块只透传 message，不解析 |
| `./registry` | `refresh` | `() => Promise<void>` | 每次需要浏览器前先等它扫完在线浏览器 |
| `./registry` | `refreshInfo` | `() => Promise<void>` | 重新握手刷新浏览器名称 / 邮箱 |
| `./registry` | `pick` | `() => { browser: { conn: Conn, info: { protocolVersion: number, ... } } } \| { error: string, code?: string, none?: boolean }` | 选出本次要用的浏览器。`none: true` 表示一个都不在线（此时 `error` 为空串）；其他 `error` 是可直接给客户端看的文字 |
| `./registry` | `online` | `() => unknown[]` | 在线浏览器列表，只看长度是否为 0 |
| `./registry` | `describe` | `() => string` | 在线浏览器的文字列表 |
| `./registry` | `select` | `(deviceId: string) => void` | 选定浏览器；deviceId 不在线时同步抛 `Error` |
| `./registry` | `switchBrowser` | `(timeoutMs: number) => Promise<unknown \| null>` | 让用户在浏览器里点连接；超时返回 `null`，否则返回被选中的浏览器 |
| `./jev` | `getJev` | `() => Promise<Jev>` | 取小模型接口对象（不透明，本模块只把它转交给 `rank` / `check` / `startJevTask`） |
| `./jev-task` | `startJevTask` | `(conn: Conn, sessionId: string, params: object, jev: Jev) => Promise<object>` | 启动 / 运行小模型多步任务，返回可 JSON 化的对象 |
| `./jev-task` | `jevStatus` | `(taskId: string) => object`，同步 | 后台任务进度 |
| `./jev-task` | `jevResult` | `(taskId: string) => object`，同步 | 后台任务结果 |
| `./jev-task` | `jevStop` | `(taskId: string) => Promise<object>` | 停后台任务 |
| `./jev-tools` | `parseTree` | `(pageContent: string) => rows` | 把无障碍树文本解析成行 |
| `./jev-tools` | `prefilter` | `(rows, query: string) => rows` | 按描述预筛行 |
| `./jev-tools` | `rank` | `(jev: Jev, o: { description: string, rows, url: string, title: string }) => Promise<ranked>` | 小模型排序；`ranked` 含 `candidates` 与 `none` |
| `./jev-tools` | `formatFind` | `(candidates, none) => { ok: true, text: string } \| { ok: false, error: string }` | 把候选格式化成给客户端看的文字，或给出找不到的原因 |
| `./jev-tools` | `jevFindJson` | `(ranked) => object` | 把排序结果转成 JSON 对象 |
| `./jev-tools` | `check` | `(jev: Jev, o: { statement: string, url: string, title: string, text: string }) => Promise<{ p: number, cost: number, model?: string }>` | 小模型判断陈述为真的概率 |
| `./output` | `makeHinter` | `() => { note(method: string, params: unknown, isError: boolean): string \| undefined }` | 返回「附加提醒」文字；空串 / `undefined` 表示无提醒 |
| `./output` | `truncateOutput` | `(text: string) => string` | 把过长文字截到输出预算内 |
| `../extension/redact.js` | `escapeJson` | `(text: string) => string` | 把 JSON 文本转成可安全放进文字的形式 |
| `../extension/redact.js` | `sanitizeText` | `(text: string) => string` | 脱敏 |
| 同目录说明文本文件 | — | 文本 | 服务器说明的来源 |

### 与插件的约定（`conn.call` 的方法名与返回形状）

本模块给插件发的方法名是**冻结**的（插件按名字分派）。每次 `conn.call` 的第三个参数都是同一个会话标识（见 5.2）。

| 插件方法 | 本模块发的参数 | 插件返回 |
|---|---|---|
| `tabs_context_mcp` | `{}` | `{ availableTabs: { tabId: number, title: string, url: string }[], tabGroupId, initialTabId }` |
| `tabs_create_mcp` | `{}` | `{ tabId: number }` |
| `tabs_close_mcp` | `{ tabId }` | `{ tabId: number }` |
| `read_page` | 客户端给的参数原样 | `{ pageContent: string, viewport: { width: number, height: number }, tabId: number }` |
| `get_page_text` | 客户端给的参数原样 | `{ title: string, url: string, source: string, text: string, tabId: number }` |
| `computer` | 客户端给的参数原样 | `{ output: string, tabId: number, base64Image?: string, imageFormat?: string }` |
| `form_input` `navigate` `javascript_tool` `resize_window` `read_console_messages` `read_network_requests` `file_upload` `upload_image` `gif_creator` | 客户端给的参数原样（`file_upload` 见第 8 节） | `{ output: string, tabId: number }` |
| `batch_begin` / `batch_end` | `{}` | 任意 |
| `upload_stash` | `{ key: string, data: string }` | 任意 |

「客户端给的参数原样」指经 schema 解析后的参数：只含第 3 节声明过的参数名，客户端多塞的未声明参数不转发；客户端没给的可选参数不出现（不是 `undefined` 占位以外的默认值）。

## 3. 工具与参数（冻结）

恰好 26 个工具。下表「必填」之外的参数都可选。类型写 JSON Schema 语义；数组长度、数值范围是 schema 的一部分，越界调用必须被拒（见 5.1）。**每个工具必须有非空字符串的 description；每个参数的 description 自定，可有可无。**

| 工具 | 参数（类型；约束） | 必填 |
|---|---|---|
| `tabs_context_mcp` | `createIfEmpty`: boolean | 无 |
| `tabs_create_mcp` | 无参数 | 无 |
| `tabs_close_mcp` | `tabId`: number | `tabId` |
| `read_page` | `filter`: 字符串枚举 `interactive` \| `all`；`tabId`: number；`depth`: number；`ref_id`: string；`max_chars`: number | 无 |
| `get_page_text` | `tabId`: number；`max_chars`: number | 无 |
| `computer` | `action`: 枚举 `left_click` `right_click` `type` `screenshot` `wait` `scroll` `key` `left_click_drag` `double_click` `triple_click` `zoom` `scroll_to` `hover`；`coordinate`: number[]，长度恰为 2；`text`: string；`duration`: number，0 ≤ 值 ≤ 30；`scroll_direction`: 枚举 `up` `down` `left` `right`；`scroll_amount`: number，1 ≤ 值 ≤ 30；`start_coordinate`: number[]，长度恰为 2；`region`: number[]，长度恰为 4；`scale`: number（无范围约束）；`repeat`: number，1 ≤ 值 ≤ 100；`ref`: string；`modifiers`: string；`tabId`: number | `action`、`tabId` |
| `find` | `query`: string；`tabId`: number | `query` |
| `quick_find` | `description`: string；`tabId`: number | `description` |
| `quick_check` | `statement`: string；`tabId`: number | `statement` |
| `quick_task` | `goal`: string；`url`: string；`details`: string；`allowIrreversible`: boolean；`stopBefore`: string[]；`tabId`: number；`background`: boolean | `goal` |
| `quick_task_status` | `taskId`: string | `taskId` |
| `quick_task_result` | `taskId`: string | `taskId` |
| `quick_task_stop` | `taskId`: string | `taskId` |
| `form_input` | `ref`: string；`value`: string \| boolean \| number 三选一；`tabId`: number | `ref`、`value`、`tabId` |
| `navigate` | `url`: string；`tabId`: number；`force`: boolean | `url`、`tabId` |
| `browser_batch` | `actions`: 数组，元素是对象 `{ name: string, input: 对象（键为字符串、值任意） }`，元素内 `name`、`input` 都必填 | `actions` |
| `resize_window` | `width`: number；`height`: number；`tabId`: number | 三者 |
| `javascript_tool` | `action`: string（**任意字符串，不是枚举**）；`text`: string；`tabId`: number | 三者 |
| `read_console_messages` | `tabId`: number；`onlyErrors`: boolean；`clear`: boolean；`pattern`: string；`limit`: number | `tabId` |
| `read_network_requests` | `tabId`: number；`urlPattern`: string；`clear`: boolean；`limit`: number | `tabId` |
| `file_upload` | `files`: 数组，元素对象 `{ data: string, name: string, mimeType?: string }`（`data`、`name` 必填）；`paths`: string[]；`ref`: string；`tabId`: number | `ref`、`tabId` |
| `upload_image` | `imageId`: string；`ref`: string；`coordinate`: number[]，长度恰为 2；`tabId`: number；`filename`: string | `imageId`、`tabId` |
| `gif_creator` | `action`: string（**任意字符串，不是枚举**）；`tabId`: number；`coordinate`: number[]，长度恰为 2；`download`: boolean；`filename`: string；`options`: 对象 `{ showClickIndicators?: boolean, showDragPaths?: boolean, showActionLabels?: boolean, showProgressBar?: boolean, quality?: number }`（五项全可选） | `action`、`tabId` |
| `list_connected_browsers` | 无参数 | 无 |
| `select_browser` | `deviceId`: string | `deviceId` |
| `switch_browser` | 无参数 | 无 |

常量来由：`computer` 的 `duration` 上限 30、`scroll_amount` 上限 30、`repeat` 上限 100 是与 Claude in Chrome 同名工具对齐的公开接口取值（让 Agent 现成的使用习惯可迁移），属接口，冻结。

### 3.1 参数不合法时

任一工具收到违反上表的参数（缺必填、类型错、越界、枚举外、数组长度不对）：调用被拒，**不得有任何 `conn.call`**，也不得触发选浏览器。被拒的呈现形态由所用 SDK 决定（协议错误或 `isError` 结果均可），不约束。

## 4. 对外工具 → 行为分类

| 类别 | 工具 | 处理 |
|---|---|---|
| 标签管理 | `tabs_context_mcp` `tabs_create_mcp` `tabs_close_mcp` | 6.1 |
| 读页面 | `read_page` `get_page_text` | 6.2 |
| 带 `output` 的动作 | `computer`（可带图）、`form_input` `navigate` `javascript_tool` `resize_window` `read_console_messages` `read_network_requests` `file_upload` `upload_image` `gif_creator` | 6.3 |
| 小模型 | `find` `quick_find` `quick_check` | 7 |
| 小模型任务 | `quick_task` `quick_task_status` `quick_task_result` `quick_task_stop` | 6.4 |
| 批处理 | `browser_batch` | 8 |
| 浏览器管理 | `list_connected_browsers` `select_browser` `switch_browser` | 9 |

除第 9 节三个工具外，**所有工具**都走同一条通用流程（第 5 节：选浏览器、会话标识、协议版本提醒、脱敏、截断、提示器、错误处理）。

提示器（`makeHinter().note`）收到的第一个参数是**内部方法名**，与对外工具名的对应是冻结的：

| 对外工具名 | 提示器收到的方法名 |
|---|---|
| `quick_find` | `jev_find` |
| `quick_check` | `jev_check` |
| `quick_task` | `jev_task` |
| `quick_task_status` | `jev_status` |
| `quick_task_result` | `jev_result` |
| `quick_task_stop` | `jev_stop` |
| 其余工具 | 与对外工具名相同 |

第二个参数是经 schema 解析后的该次调用参数，第三个是本次结果是否为错误（布尔）。

## 5. 通用流程（第 9 节三个工具除外）

### 5.1 选浏览器

| 情形 | 结果 |
|---|---|
| 选浏览器之前 | `refresh()` 已完成（`refresh` 在 `pick` 之前被调用并等待） |
| `pick` 返回 `none: true` | 结果为错误（`isError: true`），文字为 `explainNoBrowser()` 的返回；不发任何 `conn.call` |
| `pick` 返回 `error` | 结果为错误，文字为该 `error`；不发任何 `conn.call` |
| `pick` 返回浏览器 | 用该浏览器执行；`quick_task_status` / `quick_task_result` / `quick_task_stop` 也要先选到浏览器，没有在线浏览器时同样报错 |

上面两种选浏览器失败的结果同样要过提示器和截断：提示器被问的参数是内部方法名、**解析后的**调用参数、`isError` 为真；是否脱敏不约束。

### 5.2 会话标识

- 在第一次**成功选到浏览器**的调用里确定，之后整个进程保持不变（没选到浏览器的调用不确定它）。
- 形态：MCP 客户端在初始化握手里自报的名字 + `-` + 非空后缀；客户端没报名字时名字部分用 `agent`。后缀的字符集与长度自定，但要足以区分同名客户端的不同进程。
- 本模块对插件的**每一次** `conn.call`（含标签上下文查询、批处理开关、分段存放、`find` / `quick_task` 内部读树与标签查询）和传给 `startJevTask` 的会话参数都是这同一个标识；内部查询的次数与时机不约束。

### 5.3 协议版本提醒

选中浏览器的 `info.protocolVersion` 与 `PROTOCOL_VERSION` 不相等时，在结果文字里多出一段提醒，其中同时出现两个版本号（十进制）和「更新插件 / 重启」的意思；文案自定。相等时无此段。批处理里这段作为单独的一个文字块追加在末尾（见第 8 节）。

### 5.4 脱敏

- 工具成功结果的**每个文字块**都要过 `sanitizeText`（含协议版本提醒、标签块）。
- 插件 / 依赖抛出的错误：错误文字取其 `message`，同样过 `sanitizeText` 后作为 `isError: true` 的结果返回。
- 图片内容不处理。
- 提示器给出的提醒文字是否脱敏不约束。

### 5.5 截断

- 结果里每个**文字块**要过 `truncateOutput`；图片不处理；提示器追加的提醒块不再截。
- **例外**：调用者给了数字 `max_chars`（含 `0`）则该次结果不截断。
- 判定看的是**调用本身**的 `max_chars`；`browser_batch` 里面某项带了 `max_chars` 不影响批整体的截断。

### 5.6 提示器

每次通用流程的调用结束后，用「内部方法名、解析后的参数、是否错误」问一次提示器。返回非空字符串时，结果的内容末尾多出一个文字块（原样，`type` 为 `text`）；返回空串或 `undefined` 时不追加。

### 5.7 结果形状

| 项 | 要求 |
|---|---|
| 返回值 | `{ content, isError }`，`isError` 一定是布尔 |
| 成功 | `isError: false` |
| 内容块 | 文字块 `{ type: 'text', text }`；图片块 `{ type: 'image', data, mimeType }` |
| 任何一步抛错（插件报错、依赖抛错、本模块主动报错） | 不会让工具调用本身 reject，一律变成 `isError: true` 的文字结果，文字为错误 `message`（经 5.4 脱敏） |

插件报错的 message 原样出现在结果文字里（`Conn` 已把插件错误码拼在 message 前面，如 `code: 文字`），本模块不改写、不二次加前缀。

## 6. 各工具的结果文字

「标签块」指一段附在工具自身输出之后的、描述当前标签组的文字，由一次 `tabs_context_mcp` 的插件调用得到。要求：

- 文中含一行**可被 `JSON.parse` 的 JSON 对象**，键 `availableTabs`、`tabGroupId`、`initialTabId` 取自插件返回；
- 另有可读的标签清单，每个标签的 `tabId`、标题、网址都出现；
- 标题与网址进入文字前经 `escapeJson` 处理（含 `<` 等字符的标题在结果里不得以原样出现，具体转成什么由 `escapeJson` 决定）；
- 若该工具有「执行所在标签」（插件返回了 `tabId`），文中也要出现该 `tabId`；
- 具体排版、项目符号、标题行文案**自定**。

标签块出现在工具自身输出**之后**。

### 6.1 标签管理

| 工具 | 插件调用 | 结果文字 |
|---|---|---|
| `tabs_context_mcp` | `tabs_context_mcp`，参数恒为 `{}`（`createIfEmpty` 是否转发不约束） | 只有标签块；块内无「执行所在标签」。首个 JSON 行就是上面说的那一行 |
| `tabs_create_mcp` | `tabs_create_mcp`，`{}` | 说明新建了标签并含新标签 id（十进制），后接标签块 |
| `tabs_close_mcp` | `tabs_close_mcp`，`{ tabId }`（客户端给的值） | 说明关了标签并含插件返回的 id，后接标签块 |

### 6.2 读页面

| 工具 | 结果文字 |
|---|---|
| `read_page` | 依次含：`pageContent` 原文；视口宽高（`宽x高` 形式，如 `1280x720`）；标签块（带执行所在标签） |
| `get_page_text` | 含：页面标题（经 `escapeJson`）、网址、取文本的元素名（`source`）、正文 `text`；然后标签块（带执行所在标签）。各项在文中的排版自定，但正文在标签块之前 |

### 6.3 带 `output` 的动作

文字 = 插件返回的 `output`（先）+ 标签块（带执行所在标签）。参数原样转发。

`computer` 若插件返回了 `base64Image`：结果内容在文字块**之后**再加一个图片块，`data` 为该 base64，`mimeType` 为 `image/` 加 `imageFormat`（如 `image/png`）。没有 `base64Image` 则无图片块。

`output` 非字符串时的呈现不约束。

### 6.4 小模型任务

| 工具 | 结果 |
|---|---|
| `quick_task` | 先 `getJev()`，调 `startJevTask(conn, 会话标识, 解析后的参数, jev)`；文字**首行**是其返回值的 JSON（单行），后接标签块（无「执行所在标签」） |
| `quick_task_status` | 文字就是 `jevStatus(taskId)` 返回值的 JSON，无标签块 |
| `quick_task_result` | 同上，用 `jevResult(taskId)` |
| `quick_task_stop` | 等 `jevStop(taskId)` 完成，文字是其返回值的 JSON，无标签块 |

「JSON」指 `JSON.stringify` 的结果；测试用 `JSON.parse` 还原后深比较。

## 7. `find` / `quick_find` / `quick_check`

三者都不把自己的名字发给插件，而是读页面后在本进程里用小模型处理。

### 7.1 `find` 与 `quick_find`

本节数据流的来由：测试依赖替身，靠替身可观察到入参与出参。

两者读页面的方式相同；差别是描述来源和输出。描述：`find` 取参数 `query`，`quick_find` 取参数 `description`。

| 步骤结果（可观察） | 要求 |
|---|---|
| 向插件读页 | 发 `read_page`，参数为 `{ filter: 'all', tabId: 客户端给的 tabId }`（客户端没给 `tabId` 时该键值为 `undefined`，即无标签 id）；另需用 `tabs_context_mcp` 查标签以取得该页的网址与标题 |
| 页面行 | 对 `pageContent` 依次 `parseTree`、`prefilter(rows, 描述)`，结果连同 `getJev()` 的对象交给 `rank`，`rank` 收到的 `description`、`url`、`title`：描述为上面取得的描述；`url` / `title` 为标签清单中 `tabId` 等于 `read_page` 返回 `tabId` 的那个标签的网址 / 标题，找不到该标签时两者均为空串 |
| `quick_find` 成功 | 文字**首行**是 `jevFindJson(ranked)` 的 JSON，后接标签块（带执行所在标签）。「没找到」也算成功，不报错 |
| `find` 成功（`formatFind` 返回 `ok: true`） | 文字含 `formatFind` 给的 `text`（先），后接标签块（带执行所在标签） |
| `find` 失败（`formatFind` 返回 `ok: false`） | 结果为错误，文字含 `formatFind` 给的 `error`；前缀自定；**不附标签块** |
| `formatFind` 的入参 | `ranked.candidates` 与 `ranked.none` |

### 7.2 `quick_check`

本节数据流的来由：测试依赖替身，靠替身可观察到入参与出参。

| 情形 | 结果 |
|---|---|
| 正常 | 向插件发 `get_page_text`，参数为 `{ tabId: 客户端给的值, max_chars: 20000 }`；用返回的 `url`、`title`、`text` 加客户端的 `statement` 调 `check(jev, ...)` |
| `get_page_text` 失败，且错误 message 含 `get_page_text_no_content`（页面几乎没文字） | 改为发 `read_page`（`{ filter: 'all', tabId }`）取 `pageContent` 当正文，网址 / 标题从 `tabs_context_mcp` 的标签清单里按返回 `tabId` 查，查不到为空串 |
| `get_page_text` 因其他原因失败 | 错误照常变成 `isError` 结果，不退回 `read_page` |
| 成功结果 | 文字**首行**是单行 JSON，含键：`probability_true`（`check` 返回 `p` 四舍五入到 3 位小数）、`url`、`title`、`cost_usd`（`cost` 四舍五入到 6 位小数）、`model`（`check` 返回的 `model`）；后接标签块（带执行所在标签） |

常量来由：`max_chars: 20000` 项目自定，足够判断一句话又不让判断请求过大。3 位 / 6 位小数项目自定，对应概率 0.1% 精度与百万分之一美元精度。

## 8. `browser_batch`

把若干项调用在一次往返里顺序执行。

### 8.1 允许的项

每项是 `{ name, input }`。`name` 可用：`tabs_context_mcp` `tabs_create_mcp` `tabs_close_mcp` `read_page` `get_page_text` `computer` `find` `quick_find` `quick_check` `form_input` `navigate` `javascript_tool` `resize_window` `read_console_messages` `read_network_requests` `file_upload` `upload_image` `gif_creator`，以及三个别名 `tabs_context` `tabs_create` `tabs_close`（等价于对应的 `_mcp` 名）。

### 8.2 参数校验

下列情形结果为 `isError: true`，文字以错误码 `batch_invalid_input` 开头（其后跟冒号和一句说明，说明自定，需指出是哪一项或「列表为空」）；**不得有任何 `conn.call`**（不发开始 / 结束信号）：

| 输入情形 | 结果 |
|---|---|
| `actions` 为空数组 | 错误码 `batch_invalid_input` |
| 某项 `name` 是 `browser_batch`（嵌套） | 错误码 `batch_invalid_input` |
| 某项 `name` 不在 8.1 的名单里（包括 `quick_task` 系列、`list_connected_browsers`、`select_browser`、`switch_browser`、任何未知名） | 错误码 `batch_invalid_input` |
| 某项 `input` 不是对象 / 缺 `name` 或 `input` / `actions` 不是数组 | 被 schema 拒绝（见 3.1），形态不约束 |

多项同时不合法时报哪一项不约束。校验全部在执行任何一项之前完成。注意：选浏览器（5.1）先于这些校验，没有在线浏览器时报的是选浏览器的错。

### 8.3 执行

| 情形 | 结果 |
|---|---|
| 开始 | 先向插件发 `batch_begin`（`{}`） |
| 每项 | 按顺序执行，每项的处理与它作为独立工具调用时一致（包括 `file_upload` 的分段、`quick_find` / `quick_check` / `find` 的小模型流程），区别是：**项内不附标签块**（含 `tabs_context_mcp` 项本身：它在批内没有标签块文字） |
| 一项成功 | 结果里加一个文字块，含该项的输出文字（可去首尾空白；块的排版、是否带序号 / 工具名自定）；该项若产生图片（`computer`），图片块紧跟在这个文字块之后 |
| 一项抛错 | 加一个文字块，含该项错误的 message 和「后面还有几项没执行」的十进制数（0 也要写），之后**停止**，剩余项不执行；整个结果 `isError: true`。该文字块里除「未执行条数」外不得出现其他独立数字（以 `\b` 单词边界计） |
| 结束 | 无论全部成功还是中途出错，都向插件发 `batch_end`（`{}`）；`batch_end` 自身失败被忽略。批结束后（成功或出错），后续独立调用恢复附标签块 |
| 末尾 | 在所有项之后追加**一个**标签块文字块（只此一次）。协议版本不一致时再追加一个提醒文字块 |
| 全部成功 | `isError: false` |

- `batch_begin` 本身失败：整个调用变成 `isError: true` 的错误结果；此时是否发 `batch_end` 不约束。
- 文字块的脱敏、截断、提示器与 5.4~5.6 一致（截断对每个文字块各调用一次；图片块不处理）；提示器收到的方法名为 `browser_batch`，参数为整个调用的参数。
- 「批内坐标以批前最后一张截图为准」由插件侧依 `batch_begin` / `batch_end` 实现，本模块只负责发这两个信号。

## 9. 浏览器管理三工具

这三个工具**不走**第 5 节通用流程：不选浏览器、不附标签块、不过提示器、不截断、不脱敏、不确定会话标识。成功时结果为 `{ content: [一个文字块], isError: false }`。

| 工具 | 情形 | 结果 |
|---|---|---|
| `list_connected_browsers` | 任何时候 | 先 `refresh()`，再 `refreshInfo()`，文字含 `describe()` 的返回；不报错（没有浏览器时也一样） |
| `select_browser` | `deviceId` 被 `select` 接受 | 先 `refresh()`、`refreshInfo()`，再 `select(deviceId)`；成功文字含该 `deviceId` 和 `describe()` 的返回 |
| `select_browser` | `select` 抛错 | `isError: true`，文字含错误 message 和 `describe()` 的返回 |
| `switch_browser` | 先 `refresh()`；`online()` 为空 | `isError: true`，文字为 `explainNoBrowser()` 的返回 |
| `switch_browser` | 有在线浏览器，`switchBrowser` 返回 `null` | `isError: true`，文字以 `timed_out` 开头（冒号后说明自定） |
| `switch_browser` | `switchBrowser` 返回浏览器 | 成功，文字含 `describe()` 的返回 |

`switch_browser` 传给 `switchBrowser` 的超时（毫秒）：环境变量 `JEV_SWITCH_TIMEOUT_MS` 转成数字后为正有限数时用它；未设置、空串、非数字、0 → 默认值 120000（2 分钟）；负数不约束。每次调用时读环境变量，不在导入时读。

常量来由：2 分钟是让用户有时间在多个浏览器窗口里找到并点连接，项目自定。环境变量是给自动化测试把等待缩短用的接口。

## 10. `file_upload` 的分段与总量限制

通用流程之前先处理 `files`（仅当 `files` 是数组时；没给 `files`、只给 `paths` 时参数原样转发）：

| 输入情形 | 结果 |
|---|---|
| 所有 `files[i].data` 解码后的字节总数 **> 10485760**（字符串 `data` 才计；按解码后字节数计；测试以 base64 `==` / `=` 填充的两个边界为准） | `isError: true`，文字以错误码 `input_invalid` 开头，并含 `10 MB` 字样（建议拆成多次上传，文案自定）；**不发任何** `conn.call` |
| 总数 ≤ 10485760（正好 10485760 字节通过） | 继续 |
| 某个文件 `data` 长度（字符数）≤ 600000 | 该文件原样放进发给插件的 `files` |
| 某个文件 `data` 长度 > 600000（600001 即分段） | 生成一个随机的非空字符串 key（两个文件的 key 不同）；把 `data` 按每段**不超过** 600000 字符顺序切段，逐段 `await` 地发 `upload_stash`，参数 `{ key, data: 段 }`；全部发完后，发给 `file_upload` 的该文件项**不含 `data`、含 `stash: key`**，其余字段（`name`、`mimeType` 等）保留。按顺序拼接各段必须还原原 `data` |
| 分段中某次 `upload_stash` 失败 | 结果为错误（`isError: true`，文字为该错误 message），不再发 `file_upload` |
| 多个文件 | 保持原顺序；只有超长的文件被分段，其余仍内联 |

`file_upload` 的 `ref`、`tabId`、`paths` 等其他参数原样转发。

常量来由：
- 10485760 = 10 MiB：与插件侧上传上限一致，项目自定（`file_upload` 的契约里已写「合计最多 10 MB」）。
- 600000：Chrome native messaging 公开规定「宿主发给浏览器的单条消息 ≤ 1 MB（1048576 字节）」，而 base64 文本再被包成一条消息要留余量，故取 600000 字符；项目自定。

## 11. 不约束 / 保留项

1. `tabs_context_mcp` 的 `createIfEmpty` 是否转发：不约束。
2. 会话标识只在第一次成功选到浏览器的调用里确定；没选到浏览器的调用不确定它（保留）。
3. `batch_begin` 失败时是否发 `batch_end`：不约束。
4. `output` 非字符串时的呈现：不约束。

## 12. 不冻结（自定）

- 每个工具、每个参数的 description 文案；服务器说明文件的内容与排版。
- 标签块的排版、标题行；`read_page` / `get_page_text` / 动作类结果里各部分之间的分隔、标题措辞。
- `browser_batch` 每个文字块的序号 / 工具名措辞；协议版本提醒、`input_invalid` / `batch_invalid_input` / `timed_out` 冒号之后的说明、`find` 失败的前缀、`select_browser` / `switch_browser` 成功文案。
- 会话标识的后缀字符集与长度；`file_upload` 分段 key 的字符集与长度。
- 服务器版本号。
- 选浏览器失败文字是否脱敏。
