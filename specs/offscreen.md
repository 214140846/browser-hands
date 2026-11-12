# offscreen 模块规格

GIF 合成页的脚本。后台在导出 GIF 时临时开一个扩展内的离屏文档，这个脚本在里面运行：收到一组截图帧，在每帧上画动作标注，统一尺寸后交给 gif.js 编码，把成品以 base64 和对象地址两种形式交回后台；后台下载完后再让它释放对象地址。画布只在这个页面里用，不在网页里用。

## 1. 冻结的接口

### 加载方式与导出

- 由 `offscreen.html` 以**普通脚本**加载，排在 `gif.js` 之后。文件里**不能有** `import` / `export` 语句，也没有导出。单测会把它当模块动态导入，此时导出对象必须为空。
- 导入时的副作用只有一个：往 `chrome.runtime.onMessage` 上挂**一个**监听。除此之外不开计时器，不建画布，也不访问 `GIF`。`GIF` 只在真正合成时才读取。
- 页面只在合成和等待释放期间存在，不需要任何保活手段。

### 依赖

**同目录模块**：无，不 import 任何文件。

**页面全局**（单测会换成替身，实现只能经下表这些接口去用）：

| 全局 | 用到的部分 | 依赖它的什么行为 |
|---|---|---|
| `GIF`（gif.js 0.2.0，MIT，随扩展打包的第三方文件，由 `offscreen.html` 先行加载） | `new GIF(options)`；`on('finished', (blob: Blob) => void)`；`on('abort', () => void)`；`addFrame(canvas, { delay })`；`render()` | 按 gif.js README 的公开 API 编码。`finished` 给出成品 Blob，`abort` 表示编码中止。构造参数也可以改用 `setOption` / `setOptions` 传入，效果相同 |
| `Image` | `new Image()`、`src`；以 `onload` / `onerror`（或对应事件监听、或 `decode()`）得知结果；`width` / `height` | 把帧的 data URL 解成图片并拿到像素尺寸 |
| `document.createElement('canvas')` | `width`、`height`、`getContext('2d')` | 每帧作画。标准 Canvas 2D 方法都能用；不要用 `Path2D`、`OffscreenCanvas`、`createImageBitmap` |
| `FileReader`，或 `Blob.prototype.arrayBuffer` 加 `btoa` | 把成品 Blob 转成 base64 | — |
| `URL.createObjectURL` / `URL.revokeObjectURL` | 为成品生成对象地址；按请求释放 | — |
| `chrome.runtime` | `id`、`getURL(path)`、`onMessage.addListener` | 校验发送方；拿 worker 脚本的扩展内地址；收消息 |

## 2. 消息协议

监听签名遵循 Chrome 扩展消息约定：`(message, sender, sendResponse)`。异步应答时监听必须同步返回 `true`。每条被处理的消息最多应答一次。消息类型名和字段与 `specs/gif-recorder.md` 第 7 节共同冻结，以那边为准。

### 来源与类型

| 情形 | 结果 |
|---|---|
| `sender.id` 与 `chrome.runtime.id` 不同（含缺失） | 忽略：不应答，不产生任何副作用，监听返回值不是 `true` |
| `message.type` 不是下面两种 | 忽略，同上 |
| `message.type === 'gif.release'` | 见「释放」 |
| `message.type === 'gif.compose'` | 见「合成」 |

### 释放：`{ type: 'gif.release', blobUrl: string }`

| 情形 | 结果 |
|---|---|
| 正常 | 对 `blobUrl` 调一次 `URL.revokeObjectURL`。发送方不等回复：应答与否自定，应答的话只能是 `{ success: true }`，监听不返回 `true` |

### 合成：`{ type: 'gif.compose', frames: Frame[], options?: Options }`

监听返回 `true`，合成完成后应答：

- 成功：`{ success: true, result: Result }`
- 失败：`{ success: false, error?: string }`。`error` 是说明文字，文案自定；图片解码失败时允许缺省。

```ts
type Frame = {
  base64: string            // 图片正文（不带 data: 前缀）
  format?: string           // 图片子类型，如 'png'、'jpeg'
  delay?: number            // 这一帧停留的毫秒数
  action?: Action
  viewportWidth?: number    // 截图那一刻视口的 CSS 像素宽
  viewportHeight?: number   // 透传字段，本模块不使用
}
type Action = {
  type: string              // computer 工具的动作名，如 left_click、scroll、left_click_drag、type、key、wait
  coordinate?: [number, number]        // 视口 CSS 像素
  start_coordinate?: [number, number]  // 拖拽起点，视口 CSS 像素
  description?: string      // 给人看的一句动作说明
}
type Options = {
  showClickIndicators?: boolean
  showDragPaths?: boolean
  showActionLabels?: boolean
  showProgressBar?: boolean
  quality?: number          // 透传给 gif.js
}
type Result = {
  base64: string    // 成品 GIF 的 base64，不带 data: 前缀
  blobUrl: string   // URL.createObjectURL(成品 Blob) 的返回值
  size: number      // 成品字节数
  width: number     // 动画宽（像素）
  height: number    // 动画高（像素）
}
```

调用方（gif-recorder）会保证 `frames` 非空、`options` 四个开关和 `quality` 都已填好。空帧列表时的行为不作要求。

## 3. 合成行为

### 解码

| 情形 | 结果 |
|---|---|
| 帧给了 `format` | 以 `data:image/<format>;base64,<base64>` 解码 |
| 没给 `format`（缺失或空串） | 子类型按 `png` 处理 |
| 解码次数 | 每帧图片恰好解码一次（每帧一个 `new Image()`，只设一次 `src`），不为同一帧重复解码 |
| 任一帧解码失败 | 整次合成失败（`success: false`），不编码 |

### 尺寸

| 情形 | 结果 |
|---|---|
| 动画尺寸 | 宽取所有帧图片宽的最大值，高取所有帧图片高的最大值（两者可能来自不同帧）；`result.width/height` 和交给 `GIF` 的 `width/height` 都是它 |
| 交给编码器的每帧画布 | 每帧一张，按输入顺序 `addFrame`，每张都正好是动画尺寸 |
| 帧图片比动画尺寸小 | 原图以原尺寸放在画布左上角 (0, 0)，右侧和下方补白。补白颜色自定 |
| 帧图片正好是动画尺寸 | 不补白：这张画布上除了贴原图和第 4 节要求的标注，不许有任何填充、描边、清除、写字调用（`fill`、`fillRect`、`clearRect`、`stroke`、`strokeRect`、`fillText` 等）。不许先铺底色 |
| 标注与补白的关系 | 标注（含进度条）画在原图范围内，不画进补白区 |

### 停留时长

| 情形 | 结果 |
|---|---|
| 非末帧 | `addFrame` 的 `delay` 等于该帧给的 `delay` |
| 末帧 | 不短于它给的 `delay`；具体多长自定 |
| 帧的 `delay` 缺失或不是正数 | 用一个正数缺省值，取值自定 |

### 编码器参数

| 参数 | 值 |
|---|---|
| `width` / `height` | 动画尺寸 |
| `quality` | `options.quality`；缺失或不是正数时为 10。这是接收方的兜底：发送方原样转交，不做夹取 |
| `repeat` | 0，表示无限循环 |
| `workerScript` | `chrome.runtime.getURL('gif.worker.js')` 的返回值 |
| `workers` | 不小于 1 的整数，项目自定 |

### 结果

| 字段 | 判定 |
|---|---|
| `base64` | 按 base64 解码后，与 gif.js `finished` 给出的 Blob 字节完全一致 |
| `blobUrl` | 对该 Blob 调 `URL.createObjectURL` 得到的地址。合成页不主动释放它，等收到释放消息再放 |
| `size` | Blob 的 `size` |
| 其他字段 | 不作要求，调用方不读 |

| 失败情形 | 结果 |
|---|---|
| gif.js 触发 `abort` | `{ success: false, error: <非空字符串> }` |
| 图片解码失败 | `{ success: false }`，`error` 可缺省 |

## 4. 动作标注

### 开关缺省

`options` 整个缺失，或某个开关缺失（`undefined` / `null`），该开关按**开**处理。只有显式 `false` 才关闭。

### 坐标换算

动作坐标是视口 CSS 像素，要换到这一帧图片的像素上，比例逐帧计算：

| 情形 | 比例 |
|---|---|
| 帧给了 `viewportWidth`（非 0），图片宽非 0 | 图片宽 ÷ `viewportWidth` |
| 其他 | 1 |

所有坐标都乘这个比例后再画。标注本身的尺寸也随比例放大，这样高分屏截图上不会显得过小；基准尺寸自定。

### 判定表

以下「点击类」只认这 5 个动作名：`left_click`、`right_click`、`double_click`、`triple_click`、`left_click_drag`（拖拽也算）。表里没出现的其他动作名，行为不作要求。

「点位标注在某点」的判据（两条同时满足）：

- 标注在换算后的那个点上留下一个几何点：例如以它为圆心作圆或椭圆，或以它为路径端点、矩形中心。
- 标注外沿离该点不超过 22 × 比例像素。

拖拽的起点、终点标注同样适用这两条。两端之间的连线是一条直线段（不画曲线），不受外沿限制；它的几何点只有两个端点，都落在两端的上限内。

| 动作情形 | 需要的开关 | 画什么 |
|---|---|---|
| 点击类或 `scroll`，带 `coordinate` | `showClickIndicators` | 换算后的 `coordinate` 处有点位标注 |
| 同上，且有 `description` | 再加 `showActionLabels` | 有文字标签，内容是 `description`，位置自定。点位标注关闭时，文字标签也不画 |
| `left_click_drag`，`start_coordinate` 和 `coordinate` 都有 | `showDragPaths` | 起点和终点附近都有标注 |
| 同上，且有 `description` | 再加 `showActionLabels` | 有文字标签，内容是 `description`，位置自定；与上面点击类那行同时成立时，至少画出一次即可 |
| `left_click_drag` 缺 `start_coordinate` | — | 不画拖拽标注（点击类那一行仍按自己的条件判断） |
| `type`、`key`、`wait`，**没有** `coordinate`，有 `description` | `showActionLabels` | 有文字标签，内容是 `description`，位置自定 |
| `type`、`key`、`wait` 带了 `coordinate` | — | 不画文字标签，也不画点位标注 |
| `navigate`，或没有 `description` | — | 不画文字标签 |
| 帧没有 `action` | — | 不画动作标注 |
| 每一帧 | `showProgressBar` | 有进度指示，随帧序推进，末帧表示完成；比例与画法自定 |
| 四个开关全关，或没有任何一行成立 | — | 除了把原图画上去（和补白），不做任何绘制 |

文字标签尽量落在画面内，位置自定。

文字内容的要求：

- 120 个字符以内的说明不许截断。
- 需要换行时只能在空格处断开。
- 一张画布上所有写字调用的文字依次用单个空格拼起来后，必须能找到说明原文的完整一段（原文里的连续空白按一个空格算）。
- 超过 120 字符时怎么处理自定。

### 视觉取值

所有颜色、形状、线宽、半径、字体、阴影、透明度、标签偏移、进度条的粗细和位置都**自定**。规格不给取值，测试也不断言。测试只检查四件事：

- 有没有绘制
- 换算后的点上有没有几何点（容差 1 像素）
- 外沿是否超出上面的上限
- 文字里是否含说明原文

## 5. 常量来由

| 常量 | 值 | 来由 |
|---|---|---|
| `quality` 缺省 | 10 | gif.js README 公开的 `quality` 缺省值。与 gif-recorder 那一侧的缺省一致 |
| `repeat` | 0 | gif.js README 约定 0 为无限循环。录屏回放要能反复看 |
| `workers` | 自定 | 项目自定：GIF 编码量级很小，用一到几个 worker 就够；线程开多了反而拖慢临时页 |
| worker 脚本地址 | `getURL('gif.worker.js')` | gif.js 要求显式给出 worker 脚本地址。这个文件随扩展打包，在扩展根目录 |
| 缺省图片子类型 | `png` | 项目自定：无损格式，对任何截图都安全；实际调用方总会给 `format` |
| 缺省停留时长、末帧延长 | 自定 | 属于动画节奏，交给实现 |
| 点位标注外沿上限 | 22 CSS 像素 × 比例 | 取 WCAG 2.5.5 建议的触控目标边长 44 CSS 像素的一半：标注不大于一个可点目标，不盖住旁边的内容。测试靠这个上限区分「画在换算后坐标」和「画在没换算的坐标」 |
| 说明不截断下限 | 120 字符 | 项目自定：computer 工具的动作说明通常是一句话，120 字符能覆盖；再长的说明在 GIF 上也读不完 |

## 6. 运行环境约定（单测替身照此实现）

- 画布只能用 `document.createElement('canvas')` 创建，图片只能用 `new Image()` 创建。替身没有其他创建途径。
- `Image` 的结果异步到达：可以靠 `onload` / `onerror`、`addEventListener('load' | 'error')` 或 `decode()` 得知。
- 2D 上下文：每次调用都会被记录，变换矩阵（`translate` / `scale` / `rotate` / `setTransform` 等）也会被跟踪，`measureText` 返回一个按字符数估算的宽度。
- 上下文属性（`font`、`fillStyle` 等）只能读自己写过的值；没写过就读，拿到的不是标准缺省值。
- 不读像素：不用 `getImageData` 等读回接口，替身不提供真实像素。
- 测试取几何点的方式：`arc` / `ellipse` 记圆心和上下左右四个外沿点；`moveTo` / `lineTo` / 曲线记端点和控制点；矩形类记四角和中心；写字记落笔点；贴另一张画布时按落点和缩放换算它的点。
- gif.js 的 `finished` / `abort` 异步触发。
- `FileReader` 在单测里是替身，支持 `readAsDataURL`，回调用 `onload` / `onloadend` / 事件监听都行；也可以不用它，改用 `Blob.arrayBuffer()`。
- 消息派发是同步的：监听在派发时当场执行，返回值交回派发方。

## 7. 边界清单

- 同一页面里先后来几次合成请求，彼此独立，各自应答各自的。
- 释放消息里的地址不是本页生成的：照样调用释放。
- 所有帧尺寸相同：不需要补白，画布即原图尺寸。
- `viewportWidth` 为 0：比例按 1。
