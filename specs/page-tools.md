# page-tools 模块规格

负责四个工具的扩展侧执行：`javascript_tool`（在页面里跑一段代理写的脚本并把结果脱敏后返回）、`resize_window`（改标签所在窗口的尺寸）、`file_upload`（把调用方送来的文件内容塞进页面上的文件输入框）、`upload_image`（把本会话截过的图塞进文件输入框，或拖放到页面某处）；外加 `upload_stash`，用来分段接收大文件。另导出一个纯函数，对任意 JSON 值做脱敏与截短。

## 1. 冻结的导出签名

| 导出 | 参数 | 返回 |
|---|---|---|
| `filterValue` | `v: unknown` | 脱敏后的值（JSON 可表示的值） |
| `javascriptTool` | `p: { action?: unknown, text?: unknown, tabId?: number }`，`s?: Session`，`g?: Guard` | `Promise<{ tabId: number, output: string }>` |
| `resizeWindow` | `p: { width?: unknown, height?: unknown, tabId?: unknown }` | `Promise<{ tabId: number, output: string }>` |
| `uploadStash` | `p: { key?: unknown, data?: unknown }` | `Promise<{}>`（空对象） |
| `fileUpload` | `p: { files?: FileIn[], paths?: unknown[], ref?: string, tabId?: number }`，`s?: Session`，`g?: Guard` | `Promise<{ tabId: number, output: unknown }>` |
| `uploadImage` | `p: { imageId?: string, ref?: string, coordinate?: [number, number], filename?: string, tabId?: number }`，`s?: Session`，`g?: Guard` | `Promise<{ tabId: number, output: unknown }>` |

- 只有这 6 个导出。除 `filterValue` 外全部异步（返回 Promise，失败为 reject）。工具类返回对象恰好 `tabId`、`output` 两个键。
- `Session = { name?: string, mainTabId?: number, ... }`（会话对象，本模块只读 `name`，并把它原样交给 `resolveTabId`）。
- `Guard = { check(kind: string): Promise<unknown> }`：执行前的权限 / 页面状态复查，失败时 reject。
- `FileIn = { data?: unknown, name?: unknown, mimeType?: unknown, stash?: unknown }`。

### 导入时的副作用

- 在 `globalThis.__jevUpload` 上放一个可写对象 `{ upload: 10485760 }`。端到端测试会在运行中改写 `upload` 的值来缩小上限，`fileUpload` 与 `uploadImage` 每次调用都按当时的值判断（单位：字节）。
- 不挂任何 `chrome.*` 监听，不启动计时器。

## 2. 依赖表

| 模块 | 导出 | 签名 | 本模块依赖它的什么 |
|---|---|---|---|
| `./debugger.js` | `withDebugger` | `<T>(tabId: number, fn: () => Promise<T>) => Promise<T>` | 调试器的占用与释放由它负责，返回 `fn` 的结果；挂不上等失败时 reject（错误可能带 `code`） |
| `./debugger.js` | `send` | `(tabId: number, method: string, params?: object, ms?: number) => Promise<any>` | 发 CDP `Runtime.evaluate`，resolve 为 CDP 响应（含 `result` / `exceptionDetails`）；`ms` 为本次命令的等待上限（毫秒），超时或失败 reject |
| `./frames.js` | `callOnRef` | `(tabId: number, ref: string, op: string, args: unknown[]) => Promise<PageResult>` | 在 `ref` 所属 frame 里调用页内函数 `op`，页内函数的第一个参数是该 frame 内的本地编号、其后接 `args` |
| `./frames.js` | `inPage` | `(tabId: number, op: string, args: unknown[], frameId?: number) => Promise<PageResult>` | 在指定 frame（缺省主 frame，即 0）里调用页内函数 `op` |
| `./frames.js` | `locateRef` | `(tabId: number, ref: string) => Promise<[number, number]>` | 元素中心点（主页面视口 CSS 像素）；找不到时 reject |
| `./screenshot.js` | `getImage` | `(session: string, id: string) => { base64: string, format: string } \| undefined` | 按会话名 + 图片 id 取缓存的截图；`format` 实际为 `'png'` 或 `'jpeg'` |
| `./screenshot.js` | `toViewport` | `(tabId: number, point: [number, number], action: string) => [number, number]` | 截图坐标换成视口坐标；越界时同步抛错（`code: 'coordinate_out_of_bounds'`），本模块原样透传 |
| `./sessions.js` | `resolveTabId` | `(params: object, s: Session) => number` | 决定操作哪个标签（调用方给了 `tabId` 就用它，否则用会话主标签） |

用到的 Chrome API：`chrome.tabs.get(tabId)`（读 `url`、`windowId`）、`chrome.windows.update(windowId, { width, height })`。它们 reject 时原样透传。

### 与页面脚本的约定（page-scan 提供的页内函数）

| 页内函数 | 调用方式 | 参数 |
|---|---|---|
| `uploadFiles` | 经 `callOnRef(tabId, ref, 'uploadFiles', [文件数组])` | 文件数组元素为 `{ data: base64 字符串, name: string, mimeType?: string }` |
| `dropFiles` | 经 `inPage(tabId, 'dropFiles', [x, y, 文件数组, 显示用坐标])`，主 frame | `x`、`y` 为主页面视口坐标；第 4 个参数是给用户看的坐标（`[number, number]`），只用于页面侧拼结果文字 |

`PageResult`：成功为 `{ output: unknown }`；失败为 `{ error: string, errorCode?: string }`。`error` 为非空字符串才算失败；空串视同成功。`uploadFiles` 遇到目标不是文件输入框时返回 `errorCode: 'element_unsupported'`。

## 3. 错误形状

本模块主动抛的错误都是 `Error` 实例。

| 情形 | `code` | message 约束 |
|---|---|---|
| 参数不合法（见各节） | `'invalid_params'` | 英文，非空，自定 |
| 在受保护页面上跑脚本 | `'chrome_protected_page'` | 含该页协议名加 `://`（如 `chrome://`）；其余自定 |
| 调试器 / CDP 命令失败 | 原错误的 `code`；原错误没有 `code` 时为 `'js_exception'` | 含原错误 message；见第 5 节 |
| 页面脚本抛异常 | `'js_execution_error'` | 含异常描述；见第 5 节 |
| 页面脚本超时 | `'js_timeout'` | 含 `40`（秒数上限） |
| `file_upload` 收到旧式本机路径参数 | `'upload_caller_outdated'` | 英文，非空，自定 |
| 暂存分片找不到 / 已取走 | `'input_invalid'` | 英文，非空，自定 |
| 上传总量超限 | `'input_invalid'` | 含 `10 MB`（即使上限被钩子改小，文字不变） |
| 截图 id 找不到 | `'screenshot_bytes_unavailable'` | 含该 `imageId` 原文 |
| 页面侧上传 / 拖放失败 | 页面给的 `errorCode`（可能缺省） | 含页面给的 `error` 原文 |
| `upload_image` 缺 `imageId`；`ref` 与 `coordinate` 都没给或都给了；标签读不到网址；标签没有所属窗口 | 不约束 | 英文，非空，自定 |
| 守卫 `check` 失败、`chrome.*` 失败、`resolveTabId` / `locateRef` / `toViewport` 抛错 | 原样透传，同一个对象，不包装 | — |

多个错误同时成立时报哪一个不约束，除非下文另有说明。所有参数错误都在调用守卫、读标签、碰调试器之前报出。

## 4. filterValue：脱敏与截短

输入是 JSON 可表示的值（来自页面按值返回的结果）：字符串、有限数字、布尔、`null`、数组、普通对象。其他类型的处理不约束。同步，不修改输入。

「层」：顶层值为第 0 层；对象属性值、数组元素比所在容器深一层。

| 输入情形 | 结果 |
|---|---|
| 第 6 层或更深的任何值（含数字、布尔、`null`、对象） | 整体换成一个标记字符串 |
| 数字、布尔、`null`（第 5 层以内） | 原样 |
| 对象 | 新对象，键与顺序不变，每个值按下面「键名规则」得出 |
| 数组，长度 ≤ 100 | 新数组，逐项递归 |
| 数组，长度 > 100 | 前 100 项逐项递归，末尾再追加一个标记字符串，其中含被省掉的项数（十进制数字），结果长度 101 |
| 字符串，属于「凭证形态」（见下） | 整串换成标记（不论长短） |
| 其他字符串，长度 ≤ 1000 | 原样 |
| 其他字符串，长度 > 1000 | 前 1000 个字符原样保留，紧接一个截断标记；1000 之后的原文不出现 |

**凭证形态的字符串**（只看整串的形态）：

| 形态 | 必须屏蔽 | 必须原样 |
|---|---|---|
| cookie 串 / 查询串 | 由 `名=值` 对组成、以 `;` 或 `&` 相连的串，如 `sid=abc; theme=dark`、`a=1&b=2` | 只有一个 `=` 而没有 `;` / `&` 的串；没有 `=` 的串 |
| JWT（RFC 7519 紧凑序列化：三段 base64url 以 `.` 相连） | 真实形态的 JWT | 两段点分的串（如 `example.com`） |
| base64 数据（RFC 4648 标准字母表，可带 `=` 填充） | 长度 ≥ 20、含数字或 `+` `/` `=` 的 base64 串 | 长度 < 20 的串 |
| 十六进制密钥 | 长度 ≥ 32 的十六进制串（大小写不限） | — |
| 含空格的普通文字 | — | 原样（长度规则仍适用） |

误伤范围不约束：像三段点分的域名（`www.example.com`）、版本号（`1.2.3`）、20 个以上纯字母的单词，实现可屏蔽也可放行。

**键名规则**（只看对象自己的键；键名比较一律不分大小写）：

| 键名 | 该键的值 |
|---|---|
| 含下列任一词：`password`、`token`、`secret`、`authorization`、`credential`、`bearer`、`oauth`、`session`、`api key`、`private key`、`access key`（后三个词中间可用 `_`、`-` 或直接相连，如 `api_key`、`X-Api-Key`、`privatekey`） | 整体换成标记（不论值是什么类型） |
| `cookie`、`cookies` | 整体换成标记 |
| 只是恰好包含上述词片段的普通词（如 `author`） | 不约束 |
| 其他 | 按值递归 |

标记：都是字符串，文案自定，不得包含被替换掉的原值。测试只断言「是字符串、不含原值」以及上表中的长度 / 数字关系。

常量来由（均为项目自定，用于控制回给代理的文本量与泄密面）：
- 深度 5 层：页面数据很少需要更深才能看懂，再深多是框架内部对象，展开只会膨胀。
- 字符串 1000 字符、数组 100 项：足够看清形状与样本，又让单个值不至于淹没整段输出。
- base64 至少 20 字符、十六进制至少 32 字符：分别约为 15 字节、16 字节随机数据的编码长度，短于此的串几乎不可能是密钥，避免误伤短 id。

## 5. javascriptTool

### 参数与前置检查

| 情形 | 结果 |
|---|---|
| `action` 不是恰好的 `'javascript_exec'`（区分大小写，缺省也算） | `invalid_params` |
| `text` 缺省、空串或其他假值 | `invalid_params` |
| 目标标签（`resolveTabId(p, s)`）的 `url` 为空 / 缺省 | 失败，code 不约束 |
| `url` 的协议恰为 `chrome:`、`chrome-extension:`、`devtools:`、`edge:`（按 Chrome 给出的小写形式；大写写法不约束） | `chrome_protected_page`；不调守卫、不碰调试器 |
| 其他协议（`http(s):`、`about:`、`file:`、`data:` 等） | 放行 |
| 守卫存在 | 以 `'javascript_tool'` 调 `check`；失败原样透传，不碰调试器 |
| 守卫缺省 | 跳过 |

### 求值

整个求值（含下面可能的第二次）在**一次** `withDebugger(tabId, fn)` 里完成，命令全部经 `send(tabId, 'Runtime.evaluate', params, ms)` 发出。

每次 `params` 必须带：`returnByValue: true`、`awaitPromise: true`、`timeout: 40000`；`expression` 含用户代码原文。`ms` 必须大于 40000（给调试通道留余量，项目取 5 秒）。

第一次求值：`replMode: true`（CDP 的 REPL 模式：允许顶层 `await`，表达式的完成值即结果）。`expression` 要满足：
- 作为普通脚本求值时，完成值就是用户代码的完成值（`1 + 2` → 3）；
- 用户代码末行是 `//` 注释也不破坏结构；
- 同一页面上连续两次调用都在顶层写 `let a = …`，第二次不因重复声明报错（用户代码里的顶层声明不泄漏到全局）。

**顶层 `return` 的重跑**：第一次求值在编译期就失败（CDP 对编译期错误不给 `stackTrace`；运行中抛出的错误带 `stackTrace`），且错误是 V8 原生的 `Illegal return statement`（见 `exceptionDetails.exception.description`）时，另发一次 `Runtime.evaluate`：不用 REPL 模式（`replMode` 为 `false` 或缺省），`expression` 把用户代码当作异步函数体执行并取其返回值（作为普通脚本求值时得到一个 Promise，resolve 为 `return` 的值）。以第二次的响应为准。其他任何情形都只求值一次。

### 失败

| 情形 | 结果 |
|---|---|
| `withDebugger` 或 `send` reject，原错误带 `code` | 同一个 `code`；message 含原 message |
| 同上，原错误不带 `code` | `'js_exception'`；message 含原 message（原错误无 message 时为自定非空文字） |
| 同上，且原 message 含（不分大小写）`navigated or closed`（Chrome 原生报错「Inspected target navigated or closed」的片段） | 同上，message 另附一句给代理的处理建议（内容与措辞自定）；因此与不含该片段时的 message 不同 |
| 最终响应带 `exceptionDetails`，`exception.description` 含 `execution was terminated`（V8 因求值超时终止脚本时的描述；小写形式必须识别，其他大小写不约束） | `js_timeout`，message 含 `40` |
| 最终响应带 `exceptionDetails`，非超时，异常有 `description` | `js_execution_error`；message 含该 description |
| 同上，异常无 `description`、有 `value`（抛出的是原始值） | `js_execution_error`；message 含该 value |
| 同上，两者都没有 | `js_execution_error`；message 非空，自定 |

### 输出

`output` 由最终响应的 `result`（CDP RemoteObject）决定：

| `result` | `output` |
|---|---|
| 缺省 | `'undefined'` |
| `type: 'undefined'` | `'undefined'` |
| `type: 'object'`、`subtype: 'null'` | `'null'` |
| `type: 'function'` 或 `subtype: 'node'`（DOM 节点） | 它的 `description` |
| 其他对象 / 数组，带 `value` | `filterValue(value)` 的 JSON 文本，2 空格缩进（`JSON.stringify` 的标准缩进排版，冒号后有空格） |
| 其他对象 / 数组，无 `value` | 它的 `description` |
| 以上三类但缺 `description` | 非空，自定 |
| 原始值，带 `value`，脱敏后是字符串 | 该字符串本身（不加引号） |
| 原始值，带 `value`，脱敏后不是字符串（数字、布尔） | 它的 JSON 文本（`3`、`true`） |
| 原始值，无 `value`（`NaN`、`Infinity`、`-0`、大整数，CDP 只给 `unserializableValue` / `description`） | 它的 `description` |

`output` 超过 51200 个字符（即 50 × 1024，按字符计）：保留前 51200 个字符，后面接一段说明已截断（换行开头，文案自定）。截断后总长大于 51200，第 51201 个字符起的原文不出现。

返回 `{ tabId, output }`，`tabId` 为实际操作的标签。

常量来由：
- 40 秒：项目自定。比常见页面脚本（等待加载、轮询元素）宽裕，又远低于 MCP 客户端常见的单次工具调用超时，超时能以本模块的错误码返回而不是让客户端干等。
- 5 秒余量：项目自定。CDP 自身的 `timeout` 到点后还要经调试通道把异常送回，留出余量避免通道先超时把可读的超时错误吞掉。
- 50 KB：项目自定的单次返回文本上限，防止一次脚本输出撑爆代理上下文。

## 6. resizeWindow

不经 `resolveTabId`，只认参数里的 `tabId`；同步部分只做校验。

合法域：`width` 是有限的 number 且 1 ≤ `width` ≤ 7680；`height` 是有限的 number 且 1 ≤ `height` ≤ 4320；`tabId` 为真值。

| 情形 | 结果 |
|---|---|
| `width` / `height` 缺省、不是 number（如字符串 `'800'`）、非有限数、小于 1 | `invalid_params` |
| `width` / `height` 超过上限 | `invalid_params`，message 含 `7680x4320` |
| `tabId` 缺省或为假值（即使有会话主标签） | `invalid_params` |
| 标签没有 `windowId` | 失败，code 不约束 |
| 合法 | `chrome.windows.update(该标签的 windowId, { width: ⌊width⌋, height: ⌊height⌋ })` |

所有参数错误都在读标签之前报出。成功返回 `{ tabId, output }`，`output` 含 `{⌊width⌋}x{⌊height⌋}`（如 `900x700`，小写 `x`），其余自定。

常量来由：7680 × 4320 是 8K UHD（ITU-R BT.2020 / SMPTE ST 2036-1 定义的 7680×4320），作为窗口尺寸的合理上限，防止误传巨大数值。

## 7. uploadStash 与暂存

背景：浏览器 native messaging 发往扩展的单条消息上限为 1 MB（Chrome 公开文档），所以大文件由 MCP 程序切段送进暂存，`file_upload` 按键取回整串。

| 情形 | 结果 |
|---|---|
| `key` 或 `data` 不是字符串 | `invalid_params` |
| 正常 | 把 `data` 追加到 `key` 名下（按调用顺序拼接），resolve `{}` |
| 同一 `key` 多次追加，之后取用 | 得到各段按追加顺序拼接的整串 |
| 被取用一次后 | 该 `key` 清空；再取报 `input_invalid` |
| 某 `key` 最后一次追加后超过 5 分钟（「过期」），往它追加 | 视为新建：只留新追加的这段 |
| 取用过期的 `key` | `input_invalid` |

时间源为 `Date.now()`（测试会替换它）。不使用计时器。

5 分钟：项目自定。一次上传的分段通常在几秒内发完紧接着取用，5 分钟足够慢速链路，又能让中途放弃的上传不长期占内存。

## 8. fileUpload

### 参数

| 情形 | 结果 |
|---|---|
| `files` 缺省或空数组，且 `paths` 是非空数组 | `upload_caller_outdated`（旧版调用方传本机路径；扩展不读本机文件） |
| `files` 缺省或空数组，其他 | `invalid_params` |
| 某项带字符串 `stash` | 用该键从暂存取回整串作为它的 `data`；取不到 → `input_invalid` |
| 任一项不合法、超限、缺 `ref`、守卫拒绝或页面报错 | 整次调用失败；本次 `files` 里引用到的暂存键一律视为已消耗，之后再取报 `input_invalid`（调用方须重新分段上传） |
| 某项的 `data` 不是字符串，或 `name` 不是非空字符串 | `invalid_params` |
| `name` 含 `/` 或 `\` | 只取最后一个分隔符之后的部分作为文件名（`../../etc/passwd` → `passwd`，`a\b.txt` → `b.txt`） |
| 取出的文件名为空、`.`、`..`，或超过 255 个字符 | `invalid_params` |
| 各项 `data` 解码后字节数**累计**超过上限 | `input_invalid`，message 含 `10 MB` |
| 累计恰好等于上限 | 放行 |
| `ref` 缺省或为空 | `invalid_params` |

字节数指该串按标准 base64（RFC 4648，含 `=` 填充）解码后的长度，只由串长与末尾填充个数推算，不校验字符是否合法；空串为 0。

上限读 `globalThis.__jevUpload.upload`，初值 10485760 字节（10 MiB）。来由：项目自定；MCP 的 stdio 传输对十几 MB 以上的单条消息不可靠，10 MiB 留出余量。

### 执行

- 目标标签：`resolveTabId(p, s)`。
- 守卫存在时以 `'file_upload'` 调 `check`；失败原样透传，不碰页面。
- 调 `callOnRef(tabId, p.ref, 'uploadFiles', [文件数组])`，文件数组与 `files` 一一对应、顺序不变，每项为 `{ data, name: 取出的文件名 }`；原项 `mimeType` 是字符串 → 原样带上；不是字符串或缺省 → 结果里**不出现** `mimeType` 键。
- 页面结果的 `error` 为非空字符串 → 失败（第 3 节「页面侧上传 / 拖放失败」）；`error` 缺省或为空串 → 成功，返回 `{ tabId, output: 页面结果的 output }`。

## 9. uploadImage

### 参数

| 情形 | 结果 |
|---|---|
| `imageId` 缺省或为空 | 失败，code 不约束 |
| `ref`、`coordinate` 都没给 | 失败，code 不约束 |
| `ref`、`coordinate` 都给了 | 失败，code 不约束 |
| `getImage(会话名, imageId)` 取不到；会话名为 `s.name`，没有会话时为空串 `''` | `screenshot_bytes_unavailable`，message 含 `imageId` |
| 图片解码后字节数超过上限（同第 8 节，读同一个钩子） | `input_invalid` |

目标标签：`resolveTabId(p, s)`。守卫存在时以 `'upload_image'` 调 `check`；失败原样透传，不碰页面。

可观察结果：
- 图片不存在、图片超限这两种失败都**不调守卫**、不碰页面；
- 参数合法时 `getImage` 恰好被调用一次（成功时也是），参数为（会话名, `imageId`）；参数错误时不取图。

### 文件

| 字段 | 取值 |
|---|---|
| `data` | 缓存图片的 base64 |
| `name`，调用方给了 `filename`（真值） | 该值原样（不做路径清洗） |
| `name`，未给，图片 `format` 为 `'jpeg'` | `image.jpg` |
| `name`，未给，其他格式 | `image.<format>`（如 `image.png`） |
| `mimeType` | `image/<format>`（如 `image/jpeg`） |

### 投放

| 情形 | 页面动作 |
|---|---|
| 给了 `ref` | `callOnRef(tabId, ref, 'uploadFiles', [[文件]])` |
| 给了 `ref`，且上一步返回 `errorCode: 'element_unsupported'`（目标不是文件输入框） | 改为拖放到该元素中心：`inPage(tabId, 'dropFiles', [x, y, [文件], [x, y]])`（主 frame），`[x, y]` 为 `locateRef(tabId, ref)` 的结果；以拖放结果为准 |
| 给了 `ref`，返回其他错误码 | 不拖放，直接按失败处理 |
| 给了 `coordinate` | `inPage(tabId, 'dropFiles', [x, y, [文件], coordinate])`（主 frame），`[x, y]` 为 `toViewport(tabId, coordinate, 'upload_image')` 的结果，第 4 个参数是调用方给的原坐标 |

最终页面结果的 `error` 为非空字符串 → 失败（code 为页面的 `errorCode`，message 含页面的 `error`）；`error` 缺省或为空串 → 成功，返回 `{ tabId, output: 页面结果的 output }`。
