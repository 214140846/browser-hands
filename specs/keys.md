# keys 模块规格

纯数据模块：给「按键 / 组合键」工具提供两张查找表——按键名查到要发给浏览器的键事件字段，以及在 macOS 上按组合键查到对应的系统编辑命令。两张表都**按公开标准生成**，不对照任何既有实现的条目抄写。

## 1. 冻结的接口

### 导出

| 导出 | 形态 | 读法 | 值 |
|---|---|---|---|
| `KEYS` | 普通对象（不是函数），可冻结 | `KEYS[name]`，`name` 为小写键名 | `KeyInfo` 或 `undefined` |
| `MAC_COMMANDS` | 普通对象（不是函数），可冻结 | `MAC_COMMANDS[chord]`，`chord` 为小写组合键串 | `string`、`string[]`（非空）或 `undefined` |

只有这两个导出。

```ts
interface KeyInfo {
  key: string          // W3C key 值，非空
  code: string         // W3C code 值
  keyCode: number      // Windows 虚拟键码，0–255 的整数
  text?: string        // 该键在无修饰时产生的字符；不产生字符的键不得有此字段
  isKeypad?: boolean   // 小键盘上的键为 true，其余省略或 false
  windowsVirtualKeyCode?: number // 可选，见下表
  location?: number    // 可选；W3C KeyboardEvent.location 取值（0 标准、3 小键盘）
}
```

### 依赖表

无。本模块不 import 任何同目录模块，也不碰 `chrome.*`。

### 导入副作用

无。不挂监听、不读环境、不打印。

### 同步性

纯同步数据，导入完成即可读。

| 条目情形 | 调用方发出的虚拟键码 |
|---|---|
| 有 `windowsVirtualKeyCode` | 等于该字段 |
| 没有 | 等于 `keyCode` |

本规格生成的条目都不需要 `windowsVirtualKeyCode`（`keyCode` 本身就是 Windows 虚拟键码）。

### 调用方怎么用（决定了下面的硬约束）

| 调用方 | 读法 | 拿到之后 |
|---|---|---|
| CDP 输入（`input.js`） | 把用户给的键名整串转小写后查 `KEYS`；查不到且是单个字母 / 数字时自己合成 | `text` 有值 → 发「产生字符」的按下事件，并把它作为输入文字；无值 → 发「不产生字符」的按下事件 |
| CDP 输入 | 只在 macOS、且输入含 `+` 时，把**整个组合键串**转小写后原样查 `MAC_COMMANDS`（不重排、不换别名） | 值为字符串时包成单元素数组，数组原样，作为键事件的编辑命令列表 |
| DOM 输入（`dom-input.js`） | 组合键最后一段转小写后查 `KEYS` | 用 `key` / `code` / `keyCode`；查不到时自己兜底 |

## 2. 通用规则

| 情形 | 结果 |
|---|---|
| 两张表的属性名 | 全部是小写（`toLowerCase()` 后不变） |
| 用大写或混合大小写的名字直接查表（如 `KEYS.Enter`、`MAC_COMMANDS['CMD+A']`） | `undefined`（大小写归一由调用方负责） |
| 未收录的名字 | `undefined`，不抛错 |
| 名字恰好是对象原型成员（`constructor`、`tostring`、`__proto__`、`hasownproperty`） | 要求：查表得 `undefined`（用空原型对象或等效手段）；单测只断言它们不是自有属性 |
| 非字符串的名字 | 不在约定范围内（调用方只传字符串） |
| 表在运行时被改 | 不在约定范围内；实现可以冻结 |

## 3. `KEYS`：键名 → 键事件字段

### 3.1 字段取值来源

| 字段 | 取值依据 |
|---|---|
| `key` | W3C UI Events KeyboardEvent key Values：功能键用其命名键值（如 `Enter`、`ArrowLeft`）；产生字符的键用该字符本身（空格键为一个空格） |
| `code` | W3C UI Events KeyboardEvent code Values，取美式（US）布局下该字符所在的物理键 |
| `keyCode` | Windows 虚拟键码（`VK_*`），与 MDN `KeyboardEvent.keyCode` 表中 Chrome on Windows 的值一致；标点用 US 布局下的 `VK_OEM_*` 值 |
| `text` | 该键不带修饰时输入的字符；Enter 为回车符 `"\r"`（与浏览器发出的键事件一致），空格为 `" "`，标点为字符本身 |
| `isKeypad` | 键位于数字小键盘时为 `true` |

### 3.2 覆盖范围

| 类别 | 收录的键名（小写） | 判定 / 例子 |
|---|---|---|
| 回车 | `enter`，别名 `return` | 两者结果相同；`keyCode` 13，`code` `Enter`，有 `text` |
| 小键盘回车 | `kp_enter`、`numpadenter`（两者结果相同） | `key` 为 `Enter`，`keyCode` 13，`isKeypad: true`，有 `text`；`code` 按 W3C 应为 `NumpadEnter`（单测不断言） |
| 编辑 / 控制键 | `tab`、`backspace`、`delete`、`insert`、`escape`（别名 `esc`） | `key` 与 `code` 同为命名键值；无 `text`；例：Tab 9、Backspace 8、Escape 27、Delete 46 |
| 空格 | `space`，别名 `" "`（一个空格） | `key` 与 `text` 都是一个空格，`code` `Space`，`keyCode` 32 |
| 方向键 | `arrowup` `arrowdown` `arrowleft` `arrowright`，各自短别名 `up` `down` `left` `right` | 短别名与全名结果相同；`key` 与 `code` 同为 `ArrowXxx`；`keyCode` 左 37、上 38、右 39、下 40；无 `text` |
| 翻页 / 行首尾 | `home`、`end`、`pageup`、`pagedown` | 无 `text`；`keyCode` 落在 Windows 的 33–36 段 |
| 功能键 | `f1` … `f12` | `key` 与 `code` 为 `F1`…`F12`；`keyCode` 从 112 起按序号连续递增；无 `text` |
| 锁定 / 系统键 | `capslock`、`numlock`、`scrolllock`、`pause`、`printscreen` | 无 `text`；`keyCode` 按 Windows VK 表取：CapsLock 20、NumLock 144、ScrollLock 145、Pause 19、PrintScreen 44 |
| 小键盘数字 | `numpad0` … `numpad9` | `key` 为对应数字，`code` 为 `Numpad0`…`Numpad9`，`keyCode` 为 96 加数字，`isKeypad: true`；`text` 可选，给了就必须等于 `key` |
| 小键盘运算 | `numpadmultiply`、`numpadadd`、`numpadsubtract`、`numpaddecimal`、`numpaddivide` | `key` 为对应字符，`code` 同名（首字母大写驼峰），`keyCode` 为 Windows 小键盘运算键码（106、107、109、110、111），`isKeypad: true`；`text` 规则同上 |
| US 布局标点（下档） | `` ` `` `-` `=` `[` `]` `\` `;` `'` `,` `.` `/` | `key` 与 `text` 为字符本身；`code` / `keyCode` 为该物理键的 W3C code 与 `VK_OEM_*`；例：`;` → `Semicolon` 186，`'` → `Quote` 222 |
| US 布局标点（上档） | `~ ! @ # $ % ^ & * ( ) _ + { } \| : " < > ?` | 与同一物理键的下档字符**共用** `code` 与 `keyCode`（如 `!` 与数字 1 键同为 `Digit1` / 49，`{` 与 `[` 同为 `BracketLeft` / 219）；`key` 与 `text` 为上档字符本身 |
| 引号别名 | `quote` | 与 `'` 结果相同（让组合键表里的 `ctrl+quote` 主键可解析） |

**不收录**（明确要求）：单个字母 `a`–`z` 与单个数字 `0`–`9`。调用方会自己合成这些键（区分大小写），表里一旦收录就会盖掉大写字母的输入。

其余键（媒体键、F13 以上、非 US 布局字符等）不要求，收录了也必须遵守 3.1。

### 3.3 不变式

| 不变式 | |
|---|---|
| 每个条目 `key` 非空、`code` 为字符串、`keyCode` 为 0–255 整数 | 必须 |
| 不产生字符的键（编辑 / 控制、方向、翻页、功能、锁定）没有 `text` 字段 | 必须（`text` 决定调用方发哪种按下事件） |
| 有 `text` 的条目 `text` 恰为一个字符 | 必须 |
| 同一别名组结果深度相等 | 必须 |

## 4. `MAC_COMMANDS`：组合键串 → macOS 编辑命令

### 4.1 组合键串的写法

| 部分 | 规则 |
|---|---|
| 分隔 | `+`，无空格 |
| 修饰键名 | `shift`、`ctrl`、`alt`、`cmd`；顺序固定为 shift → ctrl → alt → cmd，只出现用到的 |
| 主键名 | `KEYS` 里的键名（含别名，如 `up`、`arrowup` 都要有），或单个小写字母 / 数字 |
| 其他修饰键拼法（`control`、`option`、`command`、`meta`）或其他顺序（`cmd+shift+z`） | 不要求，查不到即 `undefined` |

不变式：每个组合键串的主键要么是单个小写字母 / 数字，要么能在 `KEYS` 里查到（否则调用方会报「未知键」）。

### 4.2 值

- 选择器名取自 Apple `NSStandardKeyBindingResponding` 协议（以及 4.3 第三行的标准菜单动作），**去掉末尾冒号**（CDP `Input.dispatchKeyEvent` 的 `commands` 字段要求的是不带冒号的命令名）。
- 一个组合对应一个命令时值为字符串；对应多个时为字符串数组，顺序同 Apple 绑定表。

### 4.3 覆盖范围（生成规则）

| 来源 | 判定 | 例子 |
|---|---|---|
| macOS 自带的 `StandardKeyBinding.dict` | 其中每条不是 `noop` 的绑定，若按键能用本模块键名表示，都有对应条目，值与该绑定一致。dict 里的修饰符号 `^` `~` `$` `@` 依次对应 ctrl、alt、shift、cmd；功能键字符按 `NSEvent.h` 的功能键常量（`NSUpArrowFunctionKey` 等）换成键名；Delete 字符（0x7F）对应 backspace，回车符对应 enter，0x03 对应小键盘回车；大写字母、`"`、backtab 视为「带 shift 的对应键」 | `backspace` → `deleteBackward`；`ctrl+a` → `moveToBeginningOfParagraph`；`alt+arrowleft` → `moveWordLeft`；`cmd+arrowup` → `moveToBeginningOfDocument`；`ctrl+o` → `insertNewlineIgnoringFieldEditor`、`moveBackward` 两个；`ctrl+v` → `pageDown` |
| 带 shift 的组合，dict 里没有它、但有去掉 shift 后的组合 | 值与去掉 shift 后的组合相同（项目自定：让带 shift 的组合与不带 shift 时编辑效果一致，不留空档） | `shift+backspace` → `deleteBackward`；`shift+ctrl+arrowup` → `scrollPageUp` |
| Apple 人机界面指南列出的标准编辑快捷键 | `cmd+a` 全选、`cmd+c` 复制、`cmd+x` 剪切、`cmd+v` 粘贴、`cmd+z` 撤销、`shift+cmd+z` 重做，值为对应的标准动作名（`selectAll`、`copy`、`cut`、`paste` 见 NSText；`undo`、`redo` 为项目自定：AppKit 撤销菜单项发出的同名动作，CDP 的 `commands` 接受它们） | `cmd+a` → `selectAll`，`shift+cmd+z` → `redo` |
| 方向键别名 | 每个含方向键的条目，`arrowxxx` 和短名 `xxx` 两种写法都要有，值相同 | `shift+left` 与 `shift+arrowleft` 相同 |
| 小键盘回车 / 引号别名 | 含小键盘回车的条目 `numpadenter`、`kp_enter` 两种写法都要有；含 `'` 的条目 `'` 与 `quote` 两种写法都要有 | |

dict 里用空格键做主键的输入法切换类绑定（切换输入源、切换输入系统）不要求。上面规则之外的条目不要求，也不应添加与 Apple 默认行为相矛盾的条目。

### 4.4 方向键与 `+` 主键

| 情形 | 结果 |
|---|---|
| 任一方向键、任一出现在本表中的修饰组合 | 全名（`arrowxxx`）与短名（`xxx`）两种写法都存在，值相同 |
| 主键是 `+` 本身（如 `ctrl++`） | 不要求：与分隔符冲突，调用方按 `+` 拆分后取不到主键，不会以这种串查表 |

## 5. 常量来由

| 常量 | 来由 |
|---|---|
| 所有 `code` 值 | W3C UI Events KeyboardEvent code Values：https://www.w3.org/TR/uievents-code/ |
| 所有命名 `key` 值 | W3C UI Events KeyboardEvent key Values：https://www.w3.org/TR/uievents-key/ |
| `keyCode` | MDN KeyboardEvent.keyCode（含各浏览器键码表）：https://developer.mozilla.org/en-US/docs/Web/API/KeyboardEvent/keyCode ；微软 Virtual-Key Codes：https://learn.microsoft.com/en-us/windows/win32/inputdev/virtual-key-codes |
| `location` 取值 | W3C UI Events `KeyboardEvent.location`：https://www.w3.org/TR/uievents/#dom-keyboardevent-location |
| 编辑命令选择器名 | Apple NSStandardKeyBindingResponding：https://developer.apple.com/documentation/appkit/nsstandardkeybindingresponding |
| 默认键绑定 | macOS 自带 `/System/Library/Frameworks/AppKit.framework/Resources/StandardKeyBinding.dict`；格式说明见 Apple「Text System Defaults and Key Bindings」：https://developer.apple.com/library/archive/documentation/Cocoa/Conceptual/EventOverview/TextDefaultsBindings/TextDefaultsBindings.html |
| 功能键字符 → 键名 | Apple NSEvent 功能键常量（`NSUpArrowFunctionKey` = U+F700 起），见 macOS SDK 头文件 `AppKit.framework/Headers/NSEvent.h`（命令行工具自带，可本地核对）；NSEvent 文档：https://developer.apple.com/documentation/appkit/nsevent |
| 标准菜单快捷键 | Apple Human Interface Guidelines · Keyboards：https://developer.apple.com/design/human-interface-guidelines/keyboards |
| `selectAll` / `copy` / `cut` / `paste` 动作名 | Apple NSText：https://developer.apple.com/documentation/appkit/nstext |
| `undo` / `redo` 动作名、shift 退回规则 | 项目自定（理由见 4.3） |
| 命令名不带冒号 | Chrome DevTools Protocol `Input.dispatchKeyEvent` 的 `commands` 参数：https://chromedevtools.github.io/devtools-protocol/tot/Input/#method-dispatchKeyEvent |

## 6. 单测范围

单测抽样断言上述公开事实值、别名相等、不变式、调用方依赖的读法（小写查表、右方向键各种写法、单字母不收录、`text` 有无）。以下按标准写进规格但**单测不断言**：`kp_enter` 的 `code`、`numpadenter` / `quote` 是否在 `KEYS`、`ctrl+v` 的值、原型成员名查表得 `undefined`、4.1 主键可解析不变式。
