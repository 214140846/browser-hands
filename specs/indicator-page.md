# indicator-page 模块规格

负责：注入网页的「操作指示器」。Agent 操作页面期间，页面上显示：一圈柔和呼吸的辉光边缘、顶部（或底部）的状态条（文案 "Browser Hands is working in this tab"，带 Stop 与「移到底部/顶部」按钮）、以及沿弧线移动的常驻光标。全部放在封闭 shadow root 里，与页面 DOM / 样式 / 脚本隔离。

## 1. 脚本形态（硬约束）

- 经典脚本，不是 ES 模块：文件里不得出现 `import` / `export`。扩展用 `chrome.scripting.executeScript({ files: [...] })` 注入。
- 运行在扩展隔离世界，用 `chrome.runtime.sendMessage` 与扩展通信。
- 执行后在 `window.__jevIndicator` 上挂一个对象，函数为：`show`、`hide`、`moveCursor`、`state`、`stopCenter`、`suppress`、`restore`、`plan`、`moveCenter`。这个名字是后台调用的对外接口。
- 同一页面重复执行无副作用：已存在 `window.__jevIndicator` 时直接返回。
- 导入时不改 DOM、不挂监听、不起定时器；页面刷新 / 跳转后状态清空，由扩展重新注入。

## 2. 依赖

无其他模块。只用标准 DOM API 与 `chrome.runtime.sendMessage`（点击 Stop 时发 `{ type: 'STOP' }`；没有接收方时 Promise 拒绝，须静默忽略）。

## 3. 函数

| 函数 | 说明 |
|---|---|
| `show()` | 显示辉光与状态条，300ms 淡入；已显示时不重复创建，并清除 suppress 状态。返回 `true` |
| `hide()` | 光框连条、光标 300ms 淡出，之后统一移除；淡出期间再 `show` 则取消移除。没显示过也不报错。返回 `true` |
| `moveCursor(x, y)` | 光标常驻到会话结束；首次直接就位，之后从当前位置沿弧线走过去。返回落点完成时 resolve 的 Promise（后台标签有兜底超时） |
| `suppress(point?)` | 截图 / 点击前调用：光框连条不透明度立即 0、无过渡（不用 display none，条仍在命中测试里）；`point` 落在 Stop 上时把 Stop 置为不可交互，避免 Agent 的点击误触叫停。。返回 `true` |
| `restore()` | 取消 suppress，300ms 淡回。返回 `true` |
| `state()` | 返回 `border` / `stop` / `cursor` 及 `captured`、`side`、`cursorPos` 等调试字段 |
| `stopCenter()` / `moveCenter()` | Stop / 移位按钮中心的视口坐标；不存在时 `null` |
| `plan(x0, y0, x1, y1)` | 纯计算：光标弧线轨迹（`T`、`points`、`leans`），供测试 |

## 4. 行为约束

| 约束 | 说明 |
|---|---|
| 不挡页面 | 辉光、光标不拦截鼠标事件；状态条之外的页面照常可点 |
| 层级 | 位于页面最高层级，页面有全屏遮罩时 Stop 仍能真点到 |
| 只认真实输入 | Stop 只响应 `isTrusted` 为 true 的点击；脚本伪造的点击无效 |
| 隔离 | 封闭 shadow root，页面脚本看不到任何新增元素 |
| 点击反馈 | 点击 Stop 后条内短暂显示已请求叫停；若请求没送达（没有接收方），弹出气泡提示用户关闭调试提示条或刷新页面 |
| 减少动效 | 系统开启减少动效时，光标直接跳到落点，不播弧线 |

## 5. 测试

- `test/unit/indicator-page.test.ts`：脚本形态、隔离、Stop 真 / 假点击、光标不挡点击等不依赖动画细节的行为。
- `test/indicator.test.ts`：真实浏览器里的端到端，覆盖呼吸辉光、状态条、suppress / restore、光标弧线与截图期间隐藏。

## 6. 常量来由

`FADE_MS = 300`、`STOP_ACK_MS = 1500`、`STRIP_H = 47` 为视觉定稿的取值，项目自定。强调色 `#D97757` 与条底色为项目自定。
