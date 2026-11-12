# input 模块规格

负责：在标签页上发出真实的鼠标 / 键盘输入（点击、悬停、滚轮、拖拽、逐字输入、按键与组合键、整段插入文字），全部经由浏览器调试协议的 Input 域发出，浏览器视其为可信事件。调试器挂不上、或用户在设置里选了「页面内模拟」时，改由页面内模拟事件兜底（拖拽除外）。另提供两个纯函数：修饰键名转掩码、判断某组合键是不是页面缩放快捷键。

## 1. 冻结的导出签名

| 导出 | 参数 | 返回 |
|---|---|---|
| `isMac` | — | `Promise<boolean>` |
| `modifierMask` | `names: string`（用 `+` 连接的修饰键名） | `number`，0–15 的整数 |
| `isZoomChord` | `chord: string` | `boolean` |
| `click` | `tabId: number, x: number, y: number, button?: 'left' \| 'right' \| 'middle', count?: number, modifiers?: number, before?: () => Promise<unknown>` | `Promise<unknown>` |
| `hover` | `tabId: number, x: number, y: number` | `Promise<unknown>` |
| `wheel` | `tabId: number, x: number, y: number, deltaX: number, deltaY: number` | `Promise<unknown>` |
| `drag` | `tabId: number, from: [number, number], to: [number, number], signal?: AbortSignal` | `Promise<void>` |
| `type` | `tabId: number, text: string, signal?: AbortSignal` | `Promise<unknown>` |
| `key` | `tabId: number, chord: string` | `Promise<unknown>` |
| `insertText` | `tabId: number, text: string` | `Promise<unknown>` |

只有这 10 个导出。坐标单位是视口 CSS 像素（调用方已换算好）。`button` 缺省为左键，`count` 缺省 1，`modifiers` 缺省 0。返回值除 `isMac` / `modifierMask` / `isZoomChord` / `drag` 外不约束（调用方不读）；走页面内兜底时返回兜底函数的结果。

## 2. 依赖表

| 模块 | 导出 | 签名 | 本模块依赖它的什么 |
|---|---|---|---|
| `./debugger.js` | `send` | `(tabId: number, method: string, params?: object) => Promise<any>` | 发 CDP 命令；按需自动挂调试器。挂不上时 reject 一个 `code === 'debugger_attach_failed'` 的错误；其他失败 reject 其他错误 |
| `./keys.js` | `KEYS` | `Record<string, KeyDef>`，键为小写键名 | 按键名查键定义（见下） |
| `./keys.js` | `MAC_COMMANDS` | `Record<string, string \| string[]>`，键为小写的整串组合键（如 `ctrl+a`） | Mac 上组合键要附带的编辑命令名 |
| `./abort.js` | `checkAbort` | `(signal?: AbortSignal) => void` | 信号已中止时同步抛 `code === 'stopped'` 的 Error，否则什么都不做 |
| `./dom-input.js` | `domClick` | `(tabId, x, y, button, count, before?) => Promise<unknown>`；内部会先调 `before` | 点击兜底 |
| `./dom-input.js` | `domHover` | `(tabId, x, y) => Promise<unknown>` | 悬停兜底 |
| `./dom-input.js` | `domWheel` | `(tabId, x, y, deltaX, deltaY) => Promise<unknown>` | 滚轮兜底 |
| `./dom-input.js` | `domText` | `(tabId, text) => Promise<unknown>` | 输入文字 / 插入文字兜底 |
| `./dom-input.js` | `domKey` | `(tabId, chord) => Promise<unknown>` | 按键兜底 |
| `chrome.runtime` | `getPlatformInfo` | `() => Promise<{ os: string }>` | 判断是不是 Mac（`os` 为 `'mac'`） |
| `chrome.storage.local` | `get` | `(key) => Promise<object>` | 读设置项 `clickMode` |
| `chrome.storage.onChanged` | `addListener` | `(changes, areaName) => void` | 跟随设置项变化 |

`KeyDef = { key: string, code: string, keyCode: number, text?: string, location?: number, isKeypad?: boolean }`：`key` / `code` 为 W3C UI Events 的键值与物理键码，`keyCode` 为 Windows 虚拟键码，`text` 为该键产生的字符（不产生字符的键没有），`location` 为键位（小键盘为 3，缺省 0）。

## 3. 导入时副作用

- 读一次 `chrome.storage.local` 的 `clickMode`。读完之前到达的输入调用要等它读完再决定走哪条路。
- 在 `chrome.storage.onChanged` 上挂一个监听：只认 `local` 区里 `clickMode` 的变化。
- 不在导入时查平台；`isMac` 首次调用时才查。

## 4. 修饰键掩码与常量来由

修饰位取自 CDP `Input.dispatchKeyEvent` / `Input.dispatchMouseEvent` 的 `modifiers` 定义：Alt = 1，Ctrl = 2，Meta/Command = 4，Shift = 8。

鼠标按键掩码取自 CDP `buttons` 字段（与 W3C `MouseEvent.buttons` 一致）：左 = 1，右 = 2，中 = 4；无键按住 = 0。

### modifierMask

| 输入 | 结果 |
|---|---|
| 各段（按 `+` 切开、去首尾空白、不区分大小写）属于下列名字 | 对应位按位或 |
| `alt` | 1 |
| `ctrl`、`control` | 2 |
| `meta`、`cmd`、`command`、`win`、`windows` | 4 |
| `shift` | 8 |
| 认不出的段 | 记 0，不报错 |
| 重复的段 | 不重复计 |
| 空串 | 0 |
| 非字符串 | 自定（可抛错），不测 |

## 5. 平台（isMac）

| 情形 | 结果 |
|---|---|
| 平台 `os` 为 `'mac'` | `true`，否则 `false` |
| 多次调用 | 平台信息在模块实例内只查一次 |

## 6. 鼠标事件（调试器路径）

全部通过 `Input.dispatchMouseEvent` 发给目标 `tabId`。下面只约束列出的字段，其余字段自由。所有事件的 `x` / `y` 为四舍五入后的整数，`modifiers` 为整数（未给时 0）。

### click

假调试器收到的鼠标事件序列须满足：

| 性质 | 要求 |
|---|---|
| 开头 | 恰好一次 `mouseMoved` 到该点 |
| 之后 | `count` 对「按下 `mousePressed` + 抬起 `mouseReleased`」，成对相邻 |
| 第 i 对（从 1 起） | 按下与抬起的 `clickCount` 都是 i（双击即 1、1、2、2） |
| 按下 | `button` 为按键名，`buttons` 为该键的掩码（左 1 / 右 2 / 中 4） |
| 抬起 | `button` 为按键名，`buttons` 为 0 |
| 修饰位 | 每个事件都带调用方给的 `modifiers` |
| `before` | 每次按下之前各调用一次并等它完成；它失败时错误原样抛出，那次按下不发 |

### hover

恰好一次 `mouseMoved` 到该点，`buttons` 为 0（或不带）。

### wheel

恰好一次 `mouseWheel`，带该点坐标与 `deltaX` / `deltaY`（原样，单位像素）。

### drag

| 情形 | 假调试器收到的序列 / 结果 |
|---|---|
| 正常 | 在起点恰好一次左键按下（`buttons` 1）；之后至少一次 `mouseMoved`，每次都按住左键（`buttons` 1），点落在起止连线上（允许 1 像素取整误差），沿方向单调推进，最后一次移动到达终点；最后一个事件是在终点的左键抬起（`buttons` 0）；全程只有一次按下、一次抬起 |
| 调用时信号已中止 | 抛 `code === 'stopped'`，一个事件都不发 |
| 按下之后信号中止 | 停止移动，补发一次左键抬起（`buttons` 0，位置不约束），再抛 `code === 'stopped'`；补发抬起本身失败不影响抛出的仍是 `stopped` |
| 调试器挂不上 | 错误原样抛出，**不**退到页面内模拟 |

中间移动的步数自定（≥ 1）；目的是让依赖拖动过程（`mousemove`）的页面能感知到拖拽。

## 7. 键盘事件（调试器路径）

通则：一次「按键」是假调试器收到的两条 `Input.dispatchKeyEvent`——同一个键的按下后跟抬起。两条的键身份（`key`、`code`、`windowsVirtualKeyCode`）都取自该键的键定义，修饰位相同；抬起类型为 `keyUp`、不带文字。按下的类型看键定义有没有文字：有为 `keyDown`，且 `text` 与 `unmodifiedText` 都是该文字；没有为 `rawKeyDown`，文字为空。键定义带的键位（`location`）和小键盘标记（`isKeypad`）要体现在事件上。下面各表只写每种输入对应的「键 / 修饰位 / 编辑命令」。

### 键定义从哪来（互斥情形）

| 字符 / 名字 | 键定义 |
|---|---|
| 单个英文字母 | `key` 为该字母原样（保留大小写），`code` 为 `Key` + 大写字母，键码为大写字母的 ASCII 码，文字为该字母（W3C UI Events code 值 + Windows 虚拟键码规则）；`KEYS` 里若另有同名条目，用条目 |
| 单个数字 | `key` 为该数字，`code` 为 `Digit` + 数字，键码为该数字的 ASCII 码，文字为该数字；同上 |
| 其他名字 | 按小写名在 `KEYS` 里查；查不到即「无键定义」 |

### type：输入 → 结果

文本按 Unicode 码点逐个处理（代理对组成的 emoji 算一个），按原顺序发出。

| 输入字符 | 结果 |
|---|---|
| 有键定义的字符 | 一次按键；需要 Shift 时 `modifiers` 为 8，否则 0 |
| 需要 Shift 的字符 | 大写字母 A–Z，以及美式键盘上要按 Shift 才能打出的 21 个符号：`! @ # $ % ^ & * ( )`、`_ +`、`{ } |`、`: "`、`< > ?`、`~` |
| `\n` 或 `\r` | 一次回车键按键（`Enter` 的键定义，文字为回车符），`modifiers` 0；`"\r\n"` 是两次回车 |
| 无键定义的字符（如 `é`、`中`、emoji） | 一次 `Input.insertText`，`text` 为该完整字符 |
| 空串 | 什么都不发 |
| 每处理一个字符之前 | 用 `signal` 检查中止；已中止则抛 `code === 'stopped'`，之后的字符不再发 |

### key：输入 → 结果

| 输入 | 结果 |
|---|---|
| 不含 `+` 且有键定义（键名不区分大小写，如 `Enter`、`tab`、`LEFT`、`a`） | 一次按键，`modifiers` 0，不附带编辑命令（即使在 Mac 上、即使命令表里有这个键）；大写单字母**不**自动加 Shift |
| 不含 `+` 且无键定义（如 `hello`、`é`） | 一次 `Input.insertText`，`text` 为原串 |
| 含 `+` | 按组合键处理：修饰键名（同第 4 节名单，不分大小写）合成掩码，唯一的非修饰段为主键；有多个非修饰段时行为自定 |
| 组合键没有主键（如 `ctrl+`、`ctrl+shift`、`+`、`ctrl++`） | 抛错，见错误表，不发事件 |
| 组合键主键无键定义（如 `ctrl+nosuchkey`、`alt+中`） | 抛错，见错误表，不发事件 |
| 合法组合键 | 一次主键按键，`modifiers` 为合成掩码 |
| 合法组合键且在 Mac 上 | `commands` 为 `MAC_COMMANDS` 里以「整串小写组合键」为键查到的值：字符串包成单元素数组，数组原样；查不到为空。**不**重排修饰键顺序（`alt+ctrl+q` 与 `ctrl+alt+q` 是两个不同的键） |
| 合法组合键且不在 Mac 上 | `commands` 为空 |

Mac 上附带编辑命令的来由：macOS 版 Chrome 收到合成按键时不会自己把全选、删除这类快捷键翻译成编辑动作，需由 `commands` 显式指定（CDP `Input.dispatchKeyEvent` 的 `commands` 参数）。

### insertText

一次 `Input.insertText`，参数只有 `text`，为整段原文（不拆字、不转换换行）。

## 8. isZoomChord

判断是不是浏览器页面缩放快捷键（Ctrl/Cmd 加 加号 / 减号 / 0），不区分大小写，供调用方拦截。

| 输入 | 结果 |
|---|---|
| 至少一个控制类修饰（`ctrl`、`control`、`cmd`、`meta`、`command`、`win`、`windows`），主键为放大类（`+`、`=`、`plus`、`add`、`numpadadd`） | `true` |
| 同上，主键为缩小类（`-`、`minus`、`subtract`、`numpadsubtract`）或复位类（`0`、`numpad0`） | `true` |
| 以 `++` 结尾（主键就是加号，如 `ctrl++`） | 当作主键为加号 |
| 额外带 `shift` 且主键为放大类 | `true`（很多键盘上加号要按 Shift） |
| 带 `shift` 且主键为缩小 / 复位类 | `false` |
| 带其他修饰（如 `alt`） | `false` |
| 没有控制类修饰（如 `=`、`alt+=`） | `false` |
| 主键不在上述名单（如 `ctrl+a`）、主键为空（`ctrl+`）、空串 | `false` |
| 非字符串 | 自定，不测 |

## 9. 点击方式与兜底

设置项 `clickMode`：值为 `'dom'` 表示页面内模拟，其他值或缺省表示调试器。

| 情形 | 结果 |
|---|---|
| 模式为页面内模拟 | `click` / `hover` / `wheel` / `type` / `key` / `insertText` 直接调对应兜底函数，不发任何 CDP 命令 |
| 模式为调试器，调试器路径成功 | 不调兜底 |
| 模式为调试器，调试器路径失败且 `code === 'debugger_attach_failed'` | 改调对应兜底函数，返回其结果（中途可能已发过部分 CDP 命令，不约束） |
| 调试器路径失败且是其他错误 | 原样抛出，不调兜底 |
| `drag` | 始终只走调试器，不受模式影响 |
| `local` 区 `clickMode` 变化 | 立即按新值生效，可来回切换 |
| 其他区（如 `sync`）或其他设置项变化 | 无影响 |

兜底函数的入参：

| 调用 | 兜底 | 入参 |
|---|---|---|
| `click(t, x, y, button, count, modifiers, before)` | `domClick` | `(t, x, y, button, count, before)`，修饰位丢弃（页面内模拟不支持）；`button` / `count` 缺省同第 1 节 |
| `hover(t, x, y)` | `domHover` | 原样 |
| `wheel(t, x, y, dx, dy)` | `domWheel` | 原样 |
| `type(t, text)` / `insertText(t, text)` | `domText` | `(t, text)` |
| `key(t, chord)` | `domKey` | `(t, chord)`，原串 |

## 10. 错误形状

| 错误 | 形状 |
|---|---|
| 组合键无主键 / 主键未知 | `Error` 实例，`code === 'invalid_params'`；message 英文、自定，须含原组合键串 |
| 中止 | 由 `checkAbort` 抛出的错误原样透传（`code === 'stopped'`） |
| `before` 失败、调试器其他错误 | 原样透传，不包装 |

## 11. 测试不断言的部分（自定）

错误文案（除须含组合键串外）；列出字段以外的鼠标 / 键盘事件字段；拖拽中间步数与中途中止时抬起的位置；`insertText` / 兜底的返回值；非字符串输入的行为。
