# page-scan 模块规格

负责：注入网页的「页内工具箱」。读页面结构（可交互元素树、正文文字、结构化观察），给元素发稳定编号，再按编号做页内动作（定位中心点、填表单、塞文件），以及坐标处的滚动兜底和拖放投递。所有函数在页面里同步或异步执行，结果是可结构化克隆的普通对象 / 基本值，由扩展侧取回。

## 1. 脚本形态（硬约束）

- **经典脚本，不是 ES 模块**：文件里不得出现 `import` / `export`。扩展用 `chrome.scripting.executeScript({ files: ['page-scan.js'] })` 注入，带 `export` 会直接语法错误；测试也用普通 `<script>` 注入。
- 执行后在 `window.__jevScan` 上挂一个对象，恰好含 8 个函数：`scan`、`pageText`、`locate`、`scrollFallback`、`formInput`、`observe`、`uploadFiles`、`dropFiles`。不挂其他键。`window.__jevScan` 这个名字和 8 个函数名是对外接口（`frames.js` 用 `window.__jevScan[op](...args)` 调用）。
- **同一页面重复执行无副作用**：已存在 `window.__jevScan` 时什么都不做（不替换对象，已发的编号继续有效）。
- 导入时的副作用：只有挂上述全局对象；不挂事件监听、不起定时器、不改 DOM。
- 运行环境：扩展的隔离世界（isolated world），状态只活在当前页面的这个 JS 世界里；页面刷新 / 跳转后全部清空，由扩展重新注入。
- **任何函数都不得返回 `null` / `undefined`**（包括 Promise 的结果）。扩展侧把「结果为空」当作「脚本还没注入」，会重注入并报错。

## 2. 依赖

无。不 import 任何同目录模块，不用任何 `chrome.*` API，只用网页标准 DOM API。

### 调用方依赖的契约（不可改）

| 调用方 | 依赖什么 |
|---|---|
| `frames.js` | 编号形如 `ref_<正整数>`；`scan` 输出里每个编号以 `[ref_N]`（方括号包裹）出现，它会改写成 `[f<frame>:ref_N]` |
| `dispatch.js`（read_page） | `scan` 输出行里的链接写作 ` href="<原始属性值>"`（前面一个空格、双引号包裹、值里不含换行），它用正则把引号里的地址脱敏；`compact` 每行以 `ref_` 开头（它按行首改写前缀）；出错结果带 `error` + `errorCode` |
| `dispatch.js`（get_page_text / form_input） | `pageText` 无正文时带 `error`；`formInput` 失败带 `error` + `errorCode`，成功带 `output` |
| `page-tools.js` | `uploadFiles` 对非文件输入框返回 `errorCode: 'element_unsupported'`（它据此改走 `dropFiles`）；`dropFiles` 的失败结果**不带** `errorCode` |
| `observe.js` | `observe` 结果的 `elements` 数组，每项有 `ref` |
| 所有按编号的动作 | `scan` 和 `observe` 共用一套编号：同一元素在两边拿到同一个编号 |

## 3. 冻结的签名

| 函数 | 参数 | 返回 |
|---|---|---|
| `scan` | `opts: { filter?: 'interactive' \| 'all', depth?: number \| null, maxChars?: number \| null, refId?: string \| null, compact?: boolean }` | 成功 `{ pageContent: string, viewport: { width, height }, compact?: string }`；编号失效 `{ error: string, errorCode: 'ref_stale', pageContent: '', viewport }` |
| `pageText` | `maxChars: number` | `{ text: string, source: string, title: string, url: string, error?: string }` |
| `locate` | `ref: string` | `{ success: true, coordinates: [number, number] }` 或 `{ success: false, errorCode: 'ref_stale', error: string }` |
| `scrollFallback` | `x, y, dx, dy: number` | `true` |
| `formInput` | `ref: string, value: unknown` | `{ output: string }` 或 `{ error: string, errorCode: string }` |
| `observe` | `opts: { max?: number, quietMs?: number, capMs?: number, textChars?: number }` | `Promise<Observation>`（见第 9 节） |
| `uploadFiles` | `ref: string, files: FileSpec[]` | `{ output: string }` 或 `{ error: string, errorCode: string }` |
| `dropFiles` | `x: number, y: number, files: FileSpec[], shown: [number, number]` | `{ output: string }` 或 `{ error: string }` |

`FileSpec = { data: string /* base64 */, name: string, mimeType?: string }`。坐标一律是当前 frame 视口的 CSS 像素。`viewport` 的 `width` / `height` 为窗口内部宽高（CSS 像素）。

除 `observe` 外全部同步。函数自己不抛异常：页内异常一律折成结果对象（见各节）。

### 错误码（结果对象里的 `errorCode`，字符串）

| 码 | 含义 |
|---|---|
| `ref_stale` | 编号没发过，或对应元素已被回收 / 已脱离文档 |
| `element_unsupported` | 元素类型不支持该动作 |
| `element_not_editable` | 表单控件被禁用或只读 |
| `input_invalid` | 值不合法、找不到选项、浏览器拒收或页面拦下了改动 |
| `injected_script_failed` | 动作过程中页面里抛了异常 |

`error` 文案一律英文、非空、自定；测试不断言文案，只断言其中**不出现**敏感值（第 7 节）。

## 4. 编号

| 情形 | 结果 |
|---|---|
| 元素第一次被 `scan` 或 `observe` 收录 | 发一个新编号 `ref_N`，N 为正整数，本页内单调递增、不重复 |
| 同一元素再次被收录（任一函数） | 给回同一个编号 |
| 元素被移除后换上一个长得一样的新元素 | 新元素拿新编号，不复用旧号 |
| 按编号取元素：没发过 / 元素已被回收 / 已不在文档里 | 视为失效（`ref_stale`） |

编号表持有元素的方式不得阻止已移除元素被垃圾回收（弱引用）；已回收的条目可随时清理。

## 5. scan：读元素树

### 5.1 遍历范围

- 从 `document.body` 开始（给了 `refId` 时从该元素开始）按文档顺序深度优先。
- 开放的 shadow root：宿主的子节点改为它 shadow root 里的元素；`<slot>` 的子节点改为分配进来的元素（展平，没有分配时用它自己的子元素）。因此 slot 进来的元素只出现一次。
- 不渲染内容的标签连同子树跳过，至少跳过 `script` 和 `style`；其余哪些标签跳过自定。

### 5.2 两种模式

`filter` 缺省按 `'all'`。其他取值的行为自定，测试不涉及。

| 情形 | `'interactive'` | `'all'` |
|---|---|---|
| 元素不可见（`display:none`、`visibility:hidden`、`opacity:0`） | 不收；`display:none` 的整棵子树都不收，但 `display:contents` 的元素自身不算不可见，子孙照常处理 | 照收 |
| 元素自带 `aria-hidden="true"` | 不收 | 照收 |
| 元素完全在视口外 | 不收（给了 `refId` 时不做视口限制） | 照收 |
| 收录条件 | 「可交互」：原生交互标签（链接 `a`；按钮 `button`；表单控件 `input`、`select`、`textarea`；展开控件 `details`、`summary`），或带 `onclick` 属性、带 `tabindex` 属性、`role` 为 `button` / `link`、`contenteditable="true"`；或「手形起点」：计算样式 `cursor` 为 `pointer` 而父元素不是 `pointer`（`cursor` 会继承，只认开始变成手形的那一层） | 「可交互」（不含手形起点），或有 `role` 属性，或是标题 `h1`–`h6`，或地标标签（`article`、`aside`、`footer`、`header`、`main`、`nav`、`section`），或有名字，或角色不是 `generic` / `image` |

### 5.3 每行格式

每个收录的元素占一行；`pageContent` 的各行（含选项行、提示行）以单个换行 `\n` 连接，末尾不带换行：

- 行首缩进的空格数 = 它的层级。层级只按**被收录的**祖先计数：根层为 0，被收录元素的子孙层级 +1，没被收录的包装元素不加层级。
- 行内依次是：角色（行的第一个词）、名字（有才写，用双引号包裹，空白压成单个空格，名字里的双引号要转义，转义方式自定）、`[ref_N]`，然后元素有 `href` / `type` / `placeholder` 属性时各追加 ` key="原始属性值"`。
- 非敏感的 `<select>`：紧跟每个选项各一行，缩进比下拉多，不带编号，写选项文字；选中的选项带一个标记，未选中的没有（标记自定）；选项的 `value` 与文字不同时也写出 value。
- 敏感 `<select>`（第 7 节）：不列选项，也不再进入它的子树。
- 末尾可能追加提示行（不含任何 `[ref_…]`，措辞自定）：
  - 收满元素上限时：说明被截断以及如何缩小范围。
  - 截断类提示里若提到可用来缩小范围的参数，参数名必须与对外工具参数一致：`ref_id`（不是 `refId`）、`max_chars`、`depth`、`filter`。
  - 有子孙因层级超过 `depth` 没被输出时：说明碰到深度上限。完全没碰到深度上限时不得出现此提示。

### 5.4 角色

| 元素 | 角色 |
|---|---|
| 有 `role` 属性 | 属性原值 |
| `input` 的 type 为 `checkbox` / `radio` | 同名角色 |
| `input` 的 type 为 `submit` / `button` / `file` | `button` |
| 其他 `input` | `textbox` |
| `a`、`button`、`select`、`textarea`、`h1`–`h6`、`img`、`nav` 等常见标签 | 按 HTML-AAM 的隐式角色（`link`、`button`、`combobox`、`textbox`、`heading`、`image`、`navigation` 等），覆盖面自定 |
| 其余 | `generic` |

### 5.5 名字

| 情形 | 名字 |
|---|---|
| 非敏感 `<select>`，没有 `aria-label` | 选中项的文字（下拉同时有 aria-label 和选中项时取哪个自定） |
| 非下拉元素有非空 `aria-label` | 用它（即使元素里有可见文字也以它为准） |
| 输入框有 `placeholder` / `title`；图片有 `alt` | 用该属性 |
| 有 `<label for=…>` 指向它（同一个文档或 shadow root 内） | 用那个 label 的文字 |
| `type="submit"` 且有 `value` | 用 value |
| 普通输入框没有上述来源、当前值是短值（阈值自定，但不少于 4 字符） | 用当前值（长值多半是用户正文，不当名字） |
| 按钮、链接、`summary`，以及 ARIA 角色属于「可点选的条目」一类的元素（至少含 `button`、`link`、`option`、`tab`，其余自定） | 元素内全部可见文字（含嵌套在 `<span>` 等子元素里的字；只看直接文字节点会让「字包在 span 里」的按钮没有名字） |
| 标题 | 标题文字 |
| 其他被收录的可交互元素（靠 `onclick`、`tabindex`、手形光标等认出的 `generic` 元素） | 元素的可见文字（只取自身文字还是含子元素文字自定；只有一两个字符的极短文字是否当名字自定） |
| 敏感字段（第 7 节） | 绝不取值或选项；有 `aria-label` 时用它（敏感下拉同样），否则可用 title / label 文字，都没有时给占位标记或空 |
| 都没有 | 空（不写名字） |

上述来源同时存在时，除表中写明的以外，取哪一个自定。名字超过 100 字符时截断，截断后长度在 90–110 之间（可附省略标记）。100：足够辨认一个按钮或链接，又不让卡片式链接的整段文字刷屏，项目自定。

### 5.6 深度与上限

| 情形 | 结果 |
|---|---|
| `depth` 缺省 / `null` | 按 15 |
| 层级超过 `depth` 的元素 | 不输出；有子孙因此被略去时追加深度提示行 |
| 已收满 10000 个元素 | 停止收录，追加截断提示行 |
| `maxChars` 缺省 / `null` | 不截断 |
| 输出（含提示行）长度超过 `maxChars` | 正文部分 = 原输出中**长度不超过 `maxChars` 的最长整行前缀**（原输出第一行就超长时按 `maxChars` 硬切），后面以单个换行接一行或多行提示（不含编号，措辞自定，需说明被截断及怎样看更多），末尾不带换行 |
| 没超过 `maxChars` | 与不传 `maxChars` 的结果完全相同 |

常量来由：15 层——常见页面的语义嵌套（只计被收录的层）远小于此，再深多半是布局噪声，项目自定；10000 个——每行约几十字符，1 万行已是数十万字符，远超调用方默认的 5 万字符截断，再多只会拖慢页面线程，项目自定。

### 5.7 按编号聚焦（`refId`）

| 情形 | 结果 |
|---|---|
| 编号失效 | `{ error, errorCode: 'ref_stale', pageContent: '', viewport }` |
| 有效 | 只输出以该元素为根的子树；根元素**总是**第一行（层级 0），即使按模式它本不会被收录；子树内不做视口限制，可见性规则照旧 |

### 5.8 精简表（`compact`）

- `compact` 为真：结果多一个 `compact` 字符串，每个被输出且「可交互」（5.2 的标记条件，不含手形起点）的元素一行，按输出顺序；每行以编号开头（不带方括号），后跟一个空格、角色，有名字时再跟带双引号的名字。各行以单个换行 `\n` 连接，末尾不带换行；没有符合的元素时为空串。
- `compact` 为假或缺省：结果里没有 `compact` 键。成功结果只有 `pageContent`、`viewport`（及 `compact`）这几个键。

## 6. pageText：读正文

| 情形 | `source` | `text` |
|---|---|---|
| 页面有 `<article>` | `'article'` | 取文字最多的那个 article |
| 没有 article，有 `<main>` | `'main'` | 同上，取文字最多的 main |
| 都没有，有 `role="main"` 的元素 | 该元素标签名小写 | 同上 |
| 以上都没有 | `'body'` | 整个 body |
| 规整后的文字少于 10 个字符 | `'none'` | `''`，并带 `error` |

- 也可以把常见 CMS 的正文容器（按 class 名识别）作为候选，是否支持、排在哪自定；测试只用上表的几种页面。
- 文字取渲染后的可见文字（`innerText` 语义），规整为：行内连续空白（不含换行）压成一个空格；换行两侧的空格去掉；连续 3 个及以上换行压成两个（最多保留一个空行）；首尾去空白。
- 超过 `maxChars`：保留规整后文字中**长度不超过 `maxChars` 的最长整行前缀**，前缀原样保留（切口处若是空行也不去掉，不再去首尾空白），后接换行和一段提示（措辞自定）。
- 结果总带 `title`（`document.title`）和 `url`（`location.href`）。成功时没有 `error` 键。
- 10 个字符：少于这个数的页面基本只有图片 / 视频 / canvas，正文工具帮不上忙，应提示代理改用截图，项目自定。

## 7. 敏感字段

称一个表单控件「敏感」当且仅当：`input` 的 type 为 `password` 或 `hidden`；或 `autocomplete` 属性含 WHATWG HTML 自动填充规范里的银行卡类令牌（`cc-csc`、`cc-exp`、`cc-exp-month`、`cc-exp-year`、`cc-number`）或密码类令牌（`current-password`、`new-password`、`one-time-code`）；大小写不敏感。

| 函数 | 要求 |
|---|---|
| `scan`（含 `compact`） | 敏感控件的值、敏感下拉的选项文字和值，绝不出现在任何输出里；敏感控件本身照常收录、有编号 |
| `observe` | 敏感控件没有 `value` 字段；敏感下拉的 `options` 为 `[]` |
| `formInput` | 敏感控件的旧值、新值都不出现在 `output` / `error` 里；敏感下拉找不到选项时，报错里不列出任何选项 |

## 8. 页内动作

### 8.1 locate

| 情形 | 结果 |
|---|---|
| 编号失效 | `{ success: false, errorCode: 'ref_stale', error }` |
| 有效 | 立即（无动画）把元素滚到视口正中，返回滚动后元素边框盒中心点的视口坐标 `{ success: true, coordinates: [x, y] }` |

### 8.2 scrollFallback

视口坐标 `(x, y)` 处的元素及其祖先里，离它最近的「可滚动容器」（任一方向的 `overflow` 计算值为 `auto` / `scroll`，且该方向内容确实超出）立即滚动 `(dx, dy)`；点下没有元素、命中的是 `body` / `html`，或一路找不到可滚动容器时，滚动整个窗口。总是返回 `true`。用途：真实滚轮事件被页面吞掉时的兜底。

### 8.3 formInput

只支持 `input`、`select`、`textarea` 三种元素。按控件类型的性质：

| 控件 | 接受的 `value` 与效果 | 拒绝（`input_invalid`） |
|---|---|---|
| 下拉 | `value` 转字符串后等于某选项的 value 或显示文字 → 选中该项 | 找不到匹配选项 |
| 复选框 | 布尔值，表示目标勾选状态 | 不是布尔值（字符串 `'true'` 也不算）；改完状态仍不对（页面拦了） |
| 单选 | 除 `false` 外任何值都表示「选中」 | `false`（单选不能取消，只能选同组另一项）；改完状态仍不对 |
| 数字框 | 能转成数字的值，或空串（表示清空） | 转数字是 `NaN` 的非空值；浏览器把写入的值清空（拒收） |
| 滑块（range） | 能转成数字的值 | 转数字是 `NaN`；浏览器拒收 |
| 日期类（`date`、`time`、`datetime-local`、`month`、`week`） | 浏览器认可格式的字符串 | 非空值写入后浏览器读回为空；此时不派发 input / change 事件，控件里留下什么自定 |
| 其余文字类（含 textarea） | 写入 `String(value)` | — |

复选框 / 单选：当前状态与目标不同时对元素调用一次 `click()`（框架监听的是 click，由浏览器自己派发后续事件）；已是目标状态时不点击，直接成功。

其他错误：

| 性质 | `errorCode` |
|---|---|
| 编号失效 | `ref_stale` |
| 元素不是上述三种（含 `contenteditable` 的普通元素） | `element_unsupported` |
| 控件被禁用；或 `input` / `textarea` 只读（下拉只看禁用） | `element_not_editable` |
| 动作过程中页面里抛异常 | `injected_script_failed` |

编号失效时不再看其他条件。除此之外，多个错误条件同时成立时（如被禁用的 `div`、只读又填了非法值）报哪个自定。

写值的共同要求：

- 用**原型上的原生 setter** 写 `value` / `selectedIndex`，不经过元素实例上的同名属性。React 等框架会在实例上拦截 `value` 来追踪受控值，直接赋值会被框架当作没变化。
- 写值前调用**元素自身的** `focus()`（按元素属性查找，页面若在元素上覆盖了 `focus`，调用的就是覆盖后的那个；它抛错即归入 `injected_script_failed`）。写成功后依次派发 `input`、`change` 两个冒泡事件（与真实用户输入的顺序一致）。
- 支持选区的文字类控件（`text`、`search`、`url`、`tel`、`password`、textarea）写完后光标放到末尾。
- 成功结果只有 `output`（非空，英文，自定；非敏感时宜写明新值）；失败结果只有 `error` + `errorCode`。

### 8.4 uploadFiles

| 情形 | 结果 |
|---|---|
| 编号失效 | `ref_stale` |
| 元素不是 `<input type="file">` | `element_unsupported` |
| base64 解不开等页内异常 | `injected_script_failed` |
| 正常 | 用 `files` 造出 `File` 对象（内容为 base64 解码后的字节，名字为 `name`，类型为 `mimeType`，缺省 `application/octet-stream`——RFC 2046 规定的「任意二进制」类型）整体放进该输入框的 `files`（是否让它获得焦点自定），派发冒泡的 `input` 和 `change`；`output` 列出每个文件名（数量、大小等措辞自定） |

### 8.5 dropFiles

`(x, y)` 为视口坐标，`shown` 是代理原先给的坐标（可能在截图坐标系里），只用于写进 `output` / `error` 给代理看（四舍五入为整数）。

| 情形 | 结果 |
|---|---|
| `(x, y)` 处没有元素（如在视口外） | `{ error }`，没有 `errorCode` |
| 命中同源 `<iframe>` | 改投 iframe 文档里对应位置的元素（坐标减去 iframe 左上角）；跨源拿不到文档时投给 iframe 元素本身 |
| 目标是 `<input type="file">` | 文件放进它的 `files`，派发冒泡的 `change` 和 `input`；`output` 含各文件名 |
| 目标是其他元素 | 依次派发 `dragenter`、`dragover`、`drop` 三个冒泡、可取消的拖放事件，`dataTransfer` 里装着这些文件，事件的 `clientX` / `clientY` 等于 `(x, y)`（iframe 内的情形自定）；`output` 含各文件名和四舍五入后的 `shown` 坐标 |
| 页内异常（如 base64 解不开） | `{ error }`，没有 `errorCode` |

文件构造规则同 8.4。是否先把目标滚到可见、`screenX` / `screenY` 取值自定。

## 9. observe：结构化观察（异步）

### 9.1 等待 DOM 安静

参数都可省：`max` 默认 240，`quietMs` 默认 120，`capMs` 默认 500，`textChars` 默认 6000（毫秒 / 个数 / 字符）。

| 情形 | 何时开始采集 |
|---|---|
| 整个文档（子树的增删、属性、文字）连续 `quietMs` 毫秒没有变化 | 立即 |
| 一直在变 | 从调用起满 `capMs` 毫秒时 |

等待期间新加入的元素会被采到。

常量来由（均为项目自定）：120 ms 大约是框架一次重渲染加一帧的时长，够等点击后的局部更新落定；500 ms 封顶，避免有动画 / 轮播的页面拖慢每一步；240 个元素和 6000 字符让一次观察的体积控制在一个模型回合可读的范围内。

### 9.2 采集哪些元素

遍历范围同 5.1，不可见子树的剪枝同 5.2 的 `'interactive'` 模式。元素被采集当且仅当同时满足：

- 「可交互」或「手形起点」（同 5.2）；
- 自身没有 `aria-hidden="true"`，可见，在视口内，边框盒宽高都大于 0；
- 没被禁用：不匹配 `:disabled`，也不在任何 `aria-disabled="true"` 的元素里面。

按文档顺序收；收满 `max` 个后，再遇到的符合条件的元素只计数（`omitted`）。

去重：某元素与它里面的另一个被采集元素 `label` 完全相同时，丢掉外层、留里层（搜索建议、卡片常是一行和里面的链接同名，留一个免得代理在两个等价选项间犹豫）。可编辑元素和下拉不参与去重（不会被丢）。去重不改变 `omitted`。

### 9.3 每个元素的字段

| 字段 | 何时有 | 值 |
|---|---|---|
| `ref` | 总有 | 编号（与 `scan` 共用） |
| `role` | 总有 | 同 5.4 |
| `label` | 总有 | 名字（同 5.5）空白压成单空格、去首尾、最多 120 字符；名字为空时用 `role` |
| `inView` | 总有 | `true` |
| `value` | `input` / `textarea`，非敏感，不是勾选类（checkbox / radio）、按钮类或文件选择，当前值非空且（规整后，最多 200 字符）与 `label` 不同 | 规整后的当前值 |
| `checked` | checkbox / radio 型 `input` | `'true'` / `'false'`（字符串） |
| `checked` / `selected` / `expanded` | 元素有对应的 `aria-*` 属性 | 属性原值（字符串；与上一行冲突时以 aria 属性为准） |
| `href` | 有 `href` 的 `<a>` | 同源：路径 + 查询串（不含 `#` 片段）；跨源：完整地址；超过 100 字符时只保留前 100 个 |
| `options` | `<select>` | 前 60 个选项，每项 `{ i, label, value, selected, disabled }`（`i` 为下标，`label` 规整后最多 60 字符）；敏感下拉为 `[]` |
| `editable` | 能键入文字的控件：textarea、文字录入类 `input`（如 text、search、email、url、tel、password、number；勾选类、按钮类、文件选择不算，其余类型自定）、`contenteditable="true"` 的元素 | `true` |
| `inputType` | 有 `editable` 且 `type` 属性存在且不是 `text` / `search` | type 原值 |

字符上限都是项目自定：120 / 200 / 60 让单个元素的描述不超过一两行；60 个选项覆盖绝大多数下拉（国家 / 省份列表除外，代理可改用 `form_input` 按文字选）；`href` 100 字符足够区分站内路由。

### 9.4 整体结果

| 字段 | 值 |
|---|---|
| `url` | `location.href` |
| `title` | `document.title` |
| `viewport` | `{ w, h }`：窗口内部宽高 |
| `scroll` | `{ y, height, canDown, canUp }`：`y` 为纵向滚动位置取整；`height` 为文档根元素的滚动高度；`canDown` 为「滚动位置 + 视口高 < 文档高 − 2」；`canUp` 为滚动位置 > 0 |
| `canGoBack` | 布尔，近似为「本标签历史条目多于 1 条」 |
| `text` | `body` 的可见文字，空白压成单空格、去首尾，最多 `textChars` 字符 |
| `elements` | 去重后的元素数组 |
| `omitted` | 超出 `max` 没收的个数 |

2 像素容差：页面缩放时滚动位置是小数，取整误差会让已到底的页面误报还能往下滚，项目自定。

## 10. 测试方式说明

本模块不能被 `import`（bun 里没有 `window`）。按方案「单测机制」，测试读取 `extension/page-scan.js` 源码，用 Playwright 打开静态 HTML（挂在假 http 源上，以便测同源规则和同源 iframe），以普通脚本注入后通过 `page.evaluate` 调 `window.__jevScan` 上的函数。每条用例一张新页面。
