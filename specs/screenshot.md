# screenshot 模块规格

负责：给标签页截图（整个可视区域，或其中一块区域放大）、决定出图尺寸、记住「最近一张截图的坐标系」并把代理给的截图坐标换成页面坐标、按会话缓存图片。出图一律由浏览器调试协议按目标尺寸直接生成，不在网页里用 canvas 处理。

## 1. 冻结的导出签名

| 导出 | 参数 | 返回 |
|---|---|---|
| `targetSize` | `w: number, h: number`（正整数像素） | `[number, number]`，正整数 |
| `beginBatch` | — | `void` |
| `endBatch` | — | `void` |
| `setContext` | `tabId: number, ctx: Ctx` | `void` |
| `getContext` | `tabId: number` | `Ctx \| undefined` |
| `toViewport` | `tabId: number, point: [number, number], action: string` | `[number, number]`，失败抛错 |
| `cacheImage` | `session: string, base64: string, format: 'png' \| 'jpeg'` | `string`（图片 id） |
| `getImage` | `session: string, id: string` | `{ base64: string, format: string } \| undefined` |
| `recheckBeforeCapture` | `guard?: { check(kind: string): Promise<unknown> }` | `Promise<void>` |
| `imageSize` | `base64: string` | `{ width: number, height: number } \| null` |
| `screenshot` | `tabId: number, scale?: number, guard?` | `Promise<{ base64, format: 'jpeg', width, height, frameWidth, frameHeight }>` |
| `zoom` | `tabId: number, region: [x0, y0, x1, y1], scale?: number, guard?` | `Promise<{ base64, format: 'png', width, height }>`，只有这四个键 |

`Ctx = { viewportWidth, viewportHeight, screenshotWidth, screenshotHeight }`（视口 CSS 像素 / 截图帧像素）。

只有这 12 个导出。另外在 `globalThis.__jevShot` 上挂 `{ beginBatch, endBatch, getContext, setContext }`（与导出为同一函数），供端到端测试在 service worker 里调用。

依赖（只用到这些导出）：

| 模块 | 导出 | 签名 | 用途 |
|---|---|---|---|
| `./debugger.js` | `send` | `(tabId: number, method: string, params?: object, ms?: number) => Promise<any>`，resolve 为 CDP 响应对象，失败 reject | 发 `Runtime.evaluate`、`Page.captureScreenshot` |
| `./sessions.js` | `sessionClosedHooks` | 数组，元素 `(tabIds: number[], sessionName: string) => unknown`；本模块加载时推入一个回调，会话关闭时被调用 | 清该会话图片缓存、结束批次 |
| `chrome.tabs.onRemoved` | `addListener` | `(tabId: number) => void` | 清该标签坐标上下文 |

### 错误形状

本模块主动抛的错误一律是 `Error` 实例；带错误码的在 `code` 字段上放字符串码：

| 错误 | `code` | message 约束 |
|---|---|---|
| 坐标 / 区域越界 | `'coordinate_out_of_bounds'` | 英文，见第 4、9 节；toViewport 的必须含 `action` 参数原文 |
| zoom 参数非法 | `'invalid_params'` | 英文，见第 9 节 |
| 拿不到视口、截图无数据 | 无 `code` 字段 | 英文，自定，非空 |
| 守卫失败、调试命令失败 | 原样透传，不包装 | — |

## 2. 出图尺寸约束（targetSize）

称一个尺寸「合格」当且仅当同时满足：

- 长、宽都 ≤ 1568；
- 按 28 像素见方切块（不足一块按一块算），块数 ≤ 1568。

| 输入情形 | 输出 |
|---|---|
| 输入本身合格 | 原样返回 |
| 不合格 | 返回合格的 `[w', h']`：`w' ≤ w`，`h' = max(1, round(w' × h / w))`（等比，四舍五入，至少 1）；在此等比规则下 `w'` 取最大——`w'+1` 按同规则得到的尺寸不合格 |
| 竖图（h > w） | 结果等于把宽高对调后的结果再对调回来（横竖对称） |

常量来由：Claude API 视觉文档建议图片长边不超过 1568 像素，超过会被服务端先缩小（多花延迟却不增加信息）；模型按约 28 像素的方块读图，块数上限 1568 让单张图的 token 开销封顶在约 1.2 百万像素量级，与文档给的「约 1.15 百万像素以内不会被缩」同量级。

## 3. 坐标上下文与批次

| 情形 | 结果 |
|---|---|
| `setContext` 后 `getContext` 同一标签 | 得到同样四个字段 |
| 从未设置 / 标签已关闭 | `undefined` |
| 批次进行中（`beginBatch` 之后、`endBatch` 之前）`setContext` | 暂存，`getContext` 仍返回批前的值 |
| `endBatch` | 暂存的全部生效；没有批次时无副作用 |
| 批次进行中再 `beginBatch` | 不清掉已暂存的内容 |
| 任一会话关闭 | 视同 `endBatch`（防止批次因会话断开一直挂着） |

批次的意义：一组连续动作里中途截的图不改变坐标系，组内坐标统一以组开始前最后一张截图为准。批次是全局一个，不分标签。

## 4. 坐标换算（toViewport）

记上下文为 `c`，点为 `(x, y)`。

| 情形 | 结果 |
|---|---|
| `x` 或 `y` 非有限数或为负 | 抛错 `coordinate_out_of_bounds` |
| 有 `c`，且 `x ≥ c.screenshotWidth + 2` 或 `y ≥ c.screenshotHeight + 2` | 抛错 `coordinate_out_of_bounds` |
| 无 `c`，坐标合法 | 原样返回（当作视口像素） |
| 有 `c`，坐标合法 | `[round(x × c.viewportWidth / c.screenshotWidth), round(y × c.viewportHeight / c.screenshotHeight)]` |

容差 2 像素：代理常点在图片最右 / 最下一列，取整误差会让它恰好压线，留 2 像素避免误判。

错误文案（英文，新写），`{action}` 为第三个参数，坐标四舍五入显示：
- 有上下文：`{action}: point ({x}, {y}) lies outside the last screenshot ({W}x{H}). Use coordinates from the full-size screenshot frame, not from a downscaled copy; if the page moved, take a new screenshot.`
- 无上下文：`{action}: point ({x}, {y}) is invalid. Coordinates must be finite, non-negative pixels.`

## 5. 图片缓存

| 情形 | 结果 |
|---|---|
| `cacheImage` | 返回进程内唯一的 id（不同会话也不重复），之后 `getImage` 用同一会话 + id 取回 `{ base64, format }` |
| 用别的会话名取 | `undefined` |
| 某会话缓存超过 30 张 | 淘汰该会话最早存入的一张 |
| 会话关闭 | 清空该会话全部缓存，其他会话不受影响 |

30 张：够一次 GIF 录制或多次上传引用，又不至于让 service worker 内存无限涨。

## 6. 截图前复查（recheckBeforeCapture）

- 没给守卫：直接完成。
- 给了：以 `'screenshot'` 调用其 `check`，失败原样透传（典型为 `navigated_away`）。

## 7. imageSize

| 输入 | 输出 |
|---|---|
| PNG（看文件签名） | 头部记录的宽高 |
| JPEG | 第一个帧起始段（SOF 系列，排除哈夫曼表 / 算术编码表等非尺寸标记）里的宽高；跳过前面的其他段 |
| 其他 / 结构坏掉 | `null` |

只需读开头约 128 KB 的 base64。

## 8. screenshot

视口信息通过调试协议 `Runtime.evaluate`（按值返回）在页面里求值拿到，结果在响应的 `result.value` 上，字段名固定为 `{ width, height, dpr, x, y }`：视口 CSS 宽高、设备像素比、横纵滚动位置。物理尺寸 = 视口 × 像素比（四舍五入，像素比缺失按 1）。

| 情形 | 结果 |
|---|---|
| 守卫拒绝 | 原样失败，不发截图命令 |
| 视口宽或高拿不到 / 为 0 | 失败（普通 Error，文案自定） |
| 截图命令没返回数据 | 失败（普通 Error，文案自定） |
| 正常 | 见下 |

正常结果：
- 「帧」= 物理尺寸经第 2 节缩到合格：`frameWidth` 为其宽，`frameHeight = max(1, round(物理高 × min(1, frameWidth / 物理宽)))`。
- 输出宽 ≈ `frameWidth × s`，`s` 为 `scale`；`scale` 不是 [0.1, 1] 内的有限数时按 1。输出高按同比例。
- 裁剪框为当前视口（左上角 = 滚动位置，宽高 = 视口 CSS 宽高），只截可视区域。
- 每次截图命令都是 `Page.captureScreenshot`，参数：`format`（`'jpeg'` 或 `'png'`）；`quality`（仅 JPEG 带）；`captureBeyondViewport: false`；`fromSurface: true`；`clip: { x, y, width, height, scale }`（x/y/width/height 为视口 CSS 像素，含滚动偏移；`scale` 为 0~1 的缩放系数，浏览器出图尺寸 = 宽高 × scale × 实际像素比）。
- 格式 JPEG，质量 75；数据超过约 1 MB（base64 长度 1398100）时用质量 50 再截一次，只重截这一次。
- 浏览器实际出图宽或高与预期相差超过 1 像素（页面报的像素比与实际不一致）：按「预期宽 / 实际宽」修正缩放系数（不超过 1）后再截一次。最多修正一次；重截后不再校验，不论尺寸是否相符都接受，返回尺寸以重截图片读出的为准。
- 返回 `width` / `height` 为实际图片尺寸（读不出时取预期值）。
- 设置该标签的坐标上下文为 `{ 视口宽, 视口高, frameWidth, frameHeight }`（受第 3 节批次规则约束）。`scale` 不影响上下文，代理始终用帧坐标。

常量来由：1398100 = 1 MB（1048576 字节）按 base64 膨胀 4/3 换算成的字符数（向上取整到约值）；1 MB 是本项目自定的单图传输上限（远低于 Claude API 单图 5 MB 的硬限，留给 MCP 消息其余内容和多图同发的余量）；75 是 JPEG 常用的「肉眼难辨失真」质量，50 用作一次性兜底以压到上限内。

## 9. zoom

| 情形 | 结果 |
|---|---|
| `region` 不是长度 4 的数组 | 抛 `invalid_params`，不发任何命令 |

检查顺序（HEAD 行为）：① region 是否长度 4 的数组 → ② 守卫 → ③ 取视口 → ④ 区域数值合法性 → ⑤ 越界。即守卫在数值校验之前、数组形状校验之后。

| 守卫拒绝 | 原样失败，不截图 |
| 坐标有非有限数、有负数，或 `x1 ≤ x0` / `y1 ≤ y0` | 抛 `invalid_params` |
| 换算后区域右 / 下边（视口坐标）大于「视口宽 / 高 + 2 帧像素换算到视口的长度」（即 2 × 视口/帧比例；无上下文时比例为 1，就是 2 视口像素） | 抛 `coordinate_out_of_bounds` |
| 正常 | PNG（局部放大要看清字，用无损） |

换算：有上下文时 `region` 是帧坐标，乘以「视口 / 帧」比例变成视口坐标；无上下文时比例为 1。裁剪框 = 换算后的区域加滚动偏移。输出尺寸 = 区域物理尺寸经第 2 节约束后再乘 `scale`（同第 8 节夹取规则），且不放大超过物理尺寸。实际尺寸不符时的修正重截同第 8 节。zoom 不改坐标上下文。

错误文案（英文，新写）：
- region 缺失：`zoom needs a region [x0, y0, x1, y1].`
- region 非法：`region must be four non-negative numbers with x1 > x0 and y1 > y0.`
- 越界：`region falls outside the visible viewport ({W}x{H}); pick an area inside it.`
