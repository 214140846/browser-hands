# gif-recorder 模块规格

负责：按会话录下浏览器动作的画面（每次动作成功后存一帧，带动作信息），以及把录好的帧交给 offscreen 合成页做成 GIF，再下载到本地或拖放到页面里的某个元素上。对外就是 MCP 工具 `gif_creator` 的四个动作，外加给 `computer` / `navigate` 工具成功后调用的存帧入口。

合成 GIF 本身（画标注、编码）不在本模块，在 offscreen 页；编码库 `gif.js` / `gif.worker.js` 是第三方 MIT 库（jnordberg/gif.js 0.2.0），保留不重写，本模块不直接调用它。

## 1. 冻结的导出签名

| 导出 | 参数 | 返回 |
|---|---|---|
| `isRecording` | `name: string`（会话名） | `boolean`，同步 |
| `recordAction` | `s: { name: string } \| undefined, tabId: number, tool: 'computer' \| 'navigate', p: object, result: object \| undefined` | `Promise<void>`，**永不 reject** |
| `gifCreator` | `p: object, s: { name: string }, tabId: number` | `Promise<{ output: string }>`，只有 `output` 一个键；出错一律 reject |

只有这 3 个导出。

- `s.name` 是会话名，帧和录制状态都按它隔离；不同会话互不影响。
- `p` 是 MCP 工具参数原样：`recordAction` 里是 `computer`（看 `action`、`coordinate`、`start_coordinate`、`text`）或 `navigate`（看 `url`）的参数；`gifCreator` 里是 `gif_creator` 的参数（`action`、`coordinate`、`download`、`filename`、`options`）。
- `result` 是 `computer` 工具的成功结果；本模块只看其中的 `base64Image`（图片 base64）和 `imageFormat`（`'jpeg' | 'png'`）。

### 导入时的副作用

- 往 `sessions.js` 的 `sessionClosedHooks` 推入**一个**回调：被以 `(tabIds, name)` 调用时，丢掉会话 `name` 的全部帧并结束其录制，其他会话不受影响。
- 不在导入时注册任何 `chrome.*` 监听，也不访问 `chrome`。

## 2. 依赖表

| 模块 | 导出 | 签名 | 本模块依赖它的行为 |
|---|---|---|---|
| `./screenshot.js` | `screenshot` | `(tabId: number, scale?: number) => Promise<{ base64: string, format: 'jpeg', width: number, height: number, frameWidth: number, frameHeight: number }>` | 截可视区；成功时会把该标签的坐标上下文设为这张图的 |
| `./screenshot.js` | `getContext` | `(tabId: number) => { viewportWidth, viewportHeight, screenshotWidth, screenshotHeight } \| undefined` | 读该标签当前坐标上下文（视口 CSS 像素 / 截图帧像素） |
| `./screenshot.js` | `setContext` | `(tabId: number, ctx) => void` | 恢复录制截图之前的坐标上下文 |
| `./screenshot.js` | `toViewport` | `(tabId: number, point: [number, number], label: string) => [number, number]` | 把代理给的截图帧坐标换成视口 CSS 坐标；越界 / 非法时同步抛 `code: 'coordinate_out_of_bounds'` 的 Error。`label` 只进它的报错文案，取值自定 |
| `./background-tab.js` | `withBackground` | `<T>(tabId: number, fn: () => Promise<T>) => Promise<T>` | 在「占住调试器 + 让标签以为自己在前台」的状态下执行 `fn`，透传其结果 / 错误；后台标签不这样包着截图会截到旧画面 |
| `./background-tab.js` | `wakeHidden` | `(tabId: number) => Promise<void>` | 让被遮住 / 最小化窗口里的标签重新出一帧画面；对前台标签无副作用 |
| `./debugger.js` | `send` | `(tabId: number, method: string, params?: object) => Promise<any>` | 发调试协议命令（可选，见第 4 节「等画面稳定」）；失败 reject |
| `./sessions.js` | `sessionClosedHooks` | 数组，元素 `(tabIds: number[], name: string) => unknown` | 见「导入时的副作用」 |

用到的 `chrome.*`（都只在 `gifCreator` 的导出动作里用）：

| API | 用法与依赖的行为 |
|---|---|
| `chrome.offscreen.createDocument` / `closeDocument` | 建 / 关合成页，见第 6 节 |
| `chrome.runtime.sendMessage` / `chrome.runtime.lastError` | 与合成页通信，见第 7 节 |
| `chrome.downloads.download` / `search` / `onChanged` | 下载导出，见第 8 节 |
| `chrome.scripting.executeScript` | 拖放导出，见第 9 节 |

## 3. 录制状态与帧

每个会话有：一个帧列表（按存入顺序），一个「是否在录」标志。

| 情形 | 结果 |
|---|---|
| 从没开始过 / 会话已关闭 | 不在录，0 帧 |
| 某会话帧数超过 50 | 丢掉该会话最早的一帧，始终保留最新 50 帧 |
| `isRecording` 传入未知名、非字符串 | `false` |

50：项目自定。单帧最大约 1 MB（截图模块的单图上限），50 帧把一次录制在 service worker 里的内存封顶在几十 MB；也让合成时间保持在分钟以内。

一帧的内容（也是第 7 节发给合成页的帧字段，除 `delay` 外）：

| 字段 | 含义 |
|---|---|
| `base64` | 图片数据 |
| `format` | `'jpeg' \| 'png'` |
| `action` | 动作记录（见第 4 节）；纯截图帧没有 |
| `viewportWidth` / `viewportHeight` | 截这张图时的视口 CSS 尺寸；合成页用「图宽 ÷ 视口宽」把动作坐标换到图上。不知道时缺省 |

动作记录 `action` 的字段：

| 字段 | 含义 |
|---|---|
| `type` | `computer` 动作名原样（如 `left_click`、`key`）；导航为 `'navigate'` |
| `description` | 给人看的一句话，画在帧上。**文案自定**，非空字符串 |
| `coordinate` | 仅 `computer`：`p.coordinate` 换成的视口 CSS 坐标；没给或换算失败时缺省 |
| `start_coordinate` | 仅 `computer`：`p.start_coordinate` 换算结果，规则同上 |

可以带其他字段（如时间戳、输入文本），合成页不依赖。

**点击类动作**（第 4、6 节共用）：`left_click`、`right_click`、`double_click`、`triple_click`、`left_click_drag`，即 `computer` 工具对外声明的全部点击 / 拖拽动作名。`middle_click` 等不在工具声明里的名字不算点击类。

**发给合成页的帧**（第 7 节）只含上表四个字段加 `delay`，不得带其他字段。

## 4. recordAction：动作后存帧

前提：只有 `s.name` 有值且该会话在录时才做事；否则立即完成，不调用任何依赖。

| 输入情形 | 结果 |
|---|---|
| 不在录 / `s` 缺失 / `s.name` 为空 | 什么都不做 |
| `tool === 'computer'` 且 `p.action` 为空 | 什么都不做 |
| `tool === 'navigate'` 且 `p.url` 为空 | 什么都不做 |
| `computer` 的 `screenshot`，`result.base64Image` 有值 | 存一帧：就用这张图（不再截图），`format` 取 `result.imageFormat`、缺省 `'jpeg'`；无 `action`；视口尺寸取该标签当前坐标上下文的（刚截图设的），没有则缺省 |
| `computer` 的 `zoom`，`result.base64Image` 有值 | 存一帧：就用这张图（不再截图），`format` 缺省 `'png'`（项目自定：局部放大是为了看清字，按无损格式处理更稳妥）；带 `action`（`type: 'zoom'`）；无视口尺寸（局部放大图与视口没有比例关系） |
| `screenshot` / `zoom` 但没有 `result.base64Image` | 什么都不做 |
| 其他 `computer` 动作、`navigate` | 新截一张动作后的画面存一帧，带 `action` 与视口尺寸（见下） |
| 点击类动作（见第 3 节集合），且已有上一帧并且上一帧有视口尺寸 | **额外**在动作后那帧之前存一帧：画面、格式、视口尺寸照抄上一帧，`action` 为本次动作——即「点之前的画面 + 点击标注」，再接「点之后的画面」 |
| 点击类动作，但没有上一帧，或上一帧没有视口尺寸（如 zoom 帧） | 只存动作后那一帧 |

「动作后那一帧」：

- 用 `screenshot(tabId, 1)` 截图（缩放 1：GIF 用帧原尺寸）；截图必须发生在 `withBackground(tabId, …)` 的回调期间，且同一回调里截图前已对该标签 `await wakeHidden(tabId)`。
- 帧的视口尺寸取截图后该标签坐标上下文里的视口宽高；读不到时用截图返回的 `width` / `height`。
- **不改变代理的坐标系**：录制前该标签有坐标上下文时，`recordAction` 结束后 `getContext(tabId)` 必须与录制前相同（录制截图会覆盖上下文，要恢复）。录制前没有上下文时不约束。
- 截图前可以先等页面画完一帧，做法自定；等待本身失败不得影响存帧，等待总时长不超过约 1 秒（项目自定：每个被录动作额外多出的延迟要控制在使用者感觉不到卡的程度）。

坐标换算：`p.coordinate` / `p.start_coordinate` 是长度 2 的数组时，用 `toViewport` 按**录制截图之前**该标签的坐标上下文换算（即代理发出动作时看到的那张图）；不是数组、长度不对、或 `toViewport` 抛错 → 该字段缺省，动作照常记录（动作本身已成功，只是不画标注）。

失败处理：任何一步出错（截图失败、依赖抛错）都只丢掉还没存进去的帧，`recordAction` 照样正常完成，不 reject。点击类动作的「点之前」那帧若已存入，后面截图失败不会把它撤掉。

## 5. gifCreator：四个动作

`p.action` 区分大小写，原样匹配。

| 输入情形 | 结果 |
|---|---|
| `p` 缺失，或 `p.action` 为空 | reject `invalid_params` |
| `p.action` 不是下面四个之一（含大小写不同、非字符串） | reject `invalid_params`，message 应列出合法动作名 |
| `start_recording`，本会话没在录 | 丢掉本会话旧帧，开始录；`output` 文案自定 |
| `start_recording`，本会话已在录 | 不报错；帧保留，继续录；`output` 文案自定，应提示已在录 |
| `stop_recording`，在录 | 停止录制，帧保留；`output` 必须含当前帧数（十进制整数） |
| `stop_recording`，没在录 | 不报错，状态不变；`output` 自定 |
| `clear`，有帧 | 丢掉全部帧并停止录制；`output` 必须含丢掉的帧数 |
| `clear`，0 帧 | 不报错；`output` 自定；是否停止录制不约束 |
| `export` | 见第 6 节 |

## 6. export

参数：`coordinate`（截图帧坐标 `[x, y]`，拖放落点）、`download`（只有严格等于 `true` 才算）、`filename`、`options`。

### 前置校验（任何一条不过都不建合成页、不改帧）

| 情形 | 结果 |
|---|---|
| `download !== true`，且 `coordinate` 不是长度 2 的数组 | reject `invalid_params`，message 应说明要给坐标或 `download: true` |
| 本会话 0 帧 | reject `invalid_params`，message 应提示先开始录制并做动作 |
| 0 帧且坐标越界 | 报哪一个错不约束（两者之一即可） |
| 给了长度 2 的 `coordinate`（不论 `download`） | 用 `toViewport` 换成视口坐标；它抛的错原样 reject（典型 `coordinate_out_of_bounds`） |

### 选项与文件名

| 项 | 规则 | 来由 |
|---|---|---|
| `showClickIndicators` / `showDragPaths` / `showActionLabels` / `showProgressBar` | `options` 里该项为 `undefined` / `null` 或没给 `options` → `true`；否则原样转交 | MCP 工具参数说明里声明默认全开（对外接口） |
| `quality` | 同上，缺省 `10`；给了原样转交，不夹取 | gif.js 公开文档：`quality` 为像素采样间隔，默认 10 |
| 文件名 | `filename` 为非空字符串 → 原样用；否则自动生成：以 `.gif` 结尾、含导出时刻（不同秒导出不重名）、不含 `:` 等文件名非法字符，其余格式自定 | — |

### 帧时长（毫秒，每帧单独给，`delay` 字段）

| 帧 | 时长 |
|---|---|
| 没有 `action`（纯截图帧） | 800 |
| `action.type` 为 `wait` | 300 |
| `action.type` 属于点击类（第 3 节） | 1500 |
| 其他动作（导航、滚动、输入、按键、zoom 等，含未知动作名） | 800 |

来由：项目自定。800 ms 是看清一张普通画面的常用停留；点击类前后两帧都带标注，给 1.5 秒让人看清点在哪；`wait` 本身无画面变化，短停即可。最后一帧多停留的时长由合成页负责，本模块不加。

### 流程结果

| 情形 | 结果 |
|---|---|
| 正常 | `resolve({ output })`；返回时合成页已关、回收通知已发；**之后本会话 0 帧、不在录** |
| 合成、下载、拖放任一步失败 | reject（形状见第 10 节）；合成页照样关掉；本会话帧与录制状态不变，可重试 |
| `download === true` | 下载，不拖放（即使也给了坐标） |
| 否则 | 拖放到坐标处 |

合成页：`chrome.offscreen.createDocument({ url: 'offscreen.html', reasons: ['BLOBS'], justification })`，`justification` 文案自定。每次导出建一次、导出结束（成功或失败）关一次；`closeDocument` 失败忽略。合成页只在导出期间存在。`'offscreen.html'` 是扩展包内文件名；`BLOBS` 是 Chrome offscreen API 公开文档里「需要创建 / 使用 blob 地址」的理由枚举。

回收通知：合成成功后、关合成页之前，无论下载 / 拖放成败，都发一次回收消息（第 7 节）；发送失败忽略，不影响结果。

`output`（文案自定，测试只断言这些内容出现）：

- 导出的帧数（十进制整数）；
- GIF 尺寸，写成 `<宽>x<高>`（小写 x，前后无空格，宽高取合成结果）；
- 下载时：最终落盘路径（见第 8 节）；拖放时：文件名。

## 7. 与 offscreen 合成页的消息协议（与 offscreen 共享的契约，以本规格为准）

经 `chrome.runtime.sendMessage` 发送。

**合成请求**：`{ type: 'gif.compose', frames, options }`

- `frames`：本会话全部帧按存入顺序，每项 `{ base64, format, action, delay, viewportWidth, viewportHeight }`（字段含义见第 3 节与第 6 节帧时长；`action`、视口尺寸可缺省）。
- `options`：`{ showClickIndicators, showDragPaths, showActionLabels, showProgressBar, quality }`，已按第 6 节补好缺省值。

**合成回复**（合成页经 `sendResponse` 回）：

| 回复 | 本模块结果 |
|---|---|
| `{ success: true, result: { base64, blobUrl, size, width, height } }` | 继续下载 / 拖放；`base64` 为 GIF 数据，`blobUrl` 为合成页里的 blob 地址，`size` 字节数，`width` / `height` 像素 |
| `success` 不为真 | 失败；有 `error` 字符串时 message 含它，否则文案自定 |
| 传输失败（回调时 `chrome.runtime.lastError` 有值，或 promise 形式 reject） | 失败；message 含 `lastError.message` / 错误原文 |
| 120 秒内没回复 | 失败；文案自定 |

**回收通知**：`{ type: 'gif.release', blobUrl }`，不等回复，失败忽略。

两个 `type` 取值为本规格新定。120 秒：项目自定，gif.js 在 worker 里编码 50 张大图可达数十秒，留足余量又不让工具调用无限挂住。

## 8. 下载

- 调 `chrome.downloads.download({ url: blobUrl, filename, saveAs: false })`（不弹另存为对话框）；它 reject 则原样失败。
- 等这次下载（按返回的 id）进入终态才结束，**终态前不得关合成页**（blob 地址属于合成页，关了下载会断）：

| 情形 | 结果 |
|---|---|
| 状态变为 `complete`（经 `onChanged` 事件，或发起后查询时已是终态——小文件可能在注册监听前就下完） | 成功 |
| 状态变为 `interrupted` | 失败（普通 Error，文案自定） |
| 30 秒内未到终态 | 失败（普通 Error，文案自定） |

- 结束后（成败都算）不残留 `onChanged` 监听。
- 发起后立即查询时查不到该条目：视为未到终态，继续等事件或超时。
- 最终路径：成功后用 `chrome.downloads.search({ id })` 查到的条目 `filename`（浏览器给的绝对路径）；查不到用导出文件名。

`complete` / `interrupted` / `in_progress` 是 `chrome.downloads.State` 公开枚举值。30 秒：项目自定，本地 blob 下载通常瞬间完成，上限只防卡死。

## 9. 拖放到页面

- 用 `chrome.scripting.executeScript({ target: { tabId }, func, args })` 在目标标签主 frame 执行一个注入函数（`func` + `args` 形式，`args` 只含可序列化值）。
- 注入函数在页面里的行为：
  - 用 `new DataTransfer()` 建数据载体、`items.add(file)` 装入文件（不用其他方式构造）；
  - 把 GIF 的 base64 解码成一个 `File`：名字 = 导出文件名，类型 `image/gif`，内容 = 解码后的字节；
  - 找到视口坐标（第 6 节换算结果）处的元素，依次向它派发 `dragenter`、`dragover`、`drop` 三个 `DragEvent`（HTML 拖放标准的放下序列），每个都 `bubbles: true`、`cancelable: true`，`dataTransfer` 里恰好装这一个文件，`clientX` / `clientY` 为该视口坐标；
  - 该处没有元素 → 抛错；
  - 成功时返回真值（内容自定）。
- 结果判定：`executeScript` reject → 原样失败；返回的第一项没有真值 `result`（注入函数抛错时浏览器就是这样） → 失败（普通 Error，文案自定）。

## 10. 错误形状汇总

本模块主动抛的错误都是 `Error` 实例。

| 错误 | `code` | message |
|---|---|---|
| 参数错（缺动作、未知动作、导出缺坐标且未下载、导出时无帧） | `'invalid_params'` | 英文，自定，非空 |
| 坐标换算失败 | 依赖原样透传（`coordinate_out_of_bounds`） | 依赖给的 |
| 合成失败 / 超时、下载中断 / 超时、拖放没结果 | 无 `code` 字段 | 自定，非空；合成页回了错误文本或有 `lastError` 时须包含该原文 |
| `downloads.download`、`executeScript`、`createDocument` 自身 reject | 原样透传，不包装 | — |

`recordAction` 不抛任何错。

## 11. 计时

本模块所有计时（合成上限、下载上限、截图前等待）只用全局 `setTimeout` / `clearTimeout`，不用其他计时源（测试靠替换全局 `setTimeout` 压缩时间）。

## 12. 自定项（测试不断言）

- 所有 `output` 文案（除第 5、6 节要求必须出现的数字 / 路径 / 文件名）、所有错误 message 措辞。
- 动作描述 `description` 的措辞。
- 自动文件名除第 6 节约束外的格式、`justification` 文案。
- 截图前等画面稳定的做法。
- 叠加在帧上的视觉元素（点击标注、拖拽箭头、动作标签、进度条的颜色、形状、尺寸、字体、位置）：属于合成页，**自定**，本规格不给取值。
