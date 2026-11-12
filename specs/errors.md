# errors 模块规格

插件里所有工具失败时，统一对外返回「错误码 + 说明 + 下一步建议」三件套。本模块负责：把各种来源的异常归一成固定错误码、给每个码配一句给代理看的建议、提供页面脚本超时的错误和通用超时包装。

## 1. 冻结的导出签名

| 导出 | 形态 | 参数 | 返回 |
|---|---|---|---|
| `errorCode` | 函数 | `e: unknown` | `unknown`：通常为字符串错误码；入参自带真值非兜底 code 时原样返回其值（可为数字等） |
| `toError` | 函数 | `e: unknown` | `{ code: unknown（同 errorCode）, message: string, hint?: unknown }` |
| `INJECT_TIMEOUT_MS` | 数值常量 | — | `45000` |
| `pageLoadingError` | 函数 | `ms: number` | `Error`，额外带 `code: 'page_loading'` |
| `withTimeout` | 函数 | `promise: Promise<T>`, `ms: number`, `makeError: (ms: number) => unknown` | `Promise<T>` |

只有这五个导出，不多不少。

## 2. 可观察行为

### errorCode

兜底码共三个：`internal`、`computer_action_failed`、`tool_execution_exception`，只表示「出错了」不表示原因。「报错正文」：入参是 `Error` 实例时为其 message；其他任何入参（字符串、普通对象等）为其字符串形式，`null` / `undefined` 为空串。所以普通对象 `{ message: 'No tab with id: 1' }` 的正文是 `[object Object]`，不会被归类。

| 输入情形 | 输出 |
|---|---|
| 带真值 `code`，且不是兜底码（任意类型，含数字、未登记字符串） | 原样返回该 `code`，不看正文 |
| 无 `code` / `code` 为假值（空串、0 等），正文**开头**是第 3 节某类报错 | 该类错误码 |
| 同上，但可归类报错只出现在正文中间 | `internal` |
| 带兜底码，正文任意位置出现第 3 节某类报错（动作前缀如「点击时出错：」不影响） | 该类错误码 |
| 带兜底码，正文无可归类报错 | 该兜底码 |
| 其他 | `internal` |

补充：
- CDP 包装：正文开头若是 `{"code":<整数，可负>,"message":"` 这段固定前缀，则忽略这段前缀再判断（只认前缀，不做 JSON 解析，结尾的 `"}` 留着不影响）；前缀不符就按原文判断。
- 匹配区分大小写，按 Chrome 原生英文报错的原样大小写。
- 一段正文同时含多类报错时，按第 3 节行序取靠前的一类。

### toError

- `code` = `errorCode(e)` 的结果。
- `message` = 入参的 message 字段转字符串；没有 message 字段时把入参本身转字符串（所以 `null` → `"null"`，`undefined` → `"undefined"`）。
- `hint`：入参的 `hint` 字段不是 null / undefined 时用它（即使是空串）；否则查第 4 节表。最终 hint 为空串或没有时，**不出现** `hint` 键。
- 普通对象入参：`message` 取其 message 字段，`code` 按 errorCode 规则（正文为 `[object Object]`），两者可能不一致，这是有意冻结的行为。
- 返回的是普通对象，不是 Error 实例。

### pageLoadingError

- 返回一个 `Error`，`code` 为 `page_loading`。
- message 用英文，必须包含传入的毫秒数紧跟 `ms`（如传 30 时含 `30ms`），并说明页面忙或正在跳转、稍后再试。文案见第 5 节。

### withTimeout

- `makeError` 自身抛异常：未定义行为，调用方不得依赖。
- 原 promise 在时限内成功 → 以同一个值成功；在时限内失败 → 以同一个原因失败。
- 超过 `ms` 毫秒仍未结束 → 以 `makeError(ms)` 的返回值失败。`makeError` 只在超时时调用，参数就是 `ms`。
- 不论哪种结局，计时器都要清掉，不能让进程因残留计时器挂住，也不能在已结束后再调用 `makeError`。

## 3. 原生报错 → 错误码

各行互不重叠，行序只在一段正文同时含两类报错时起作用。「匹配依据」是对 Chrome 原生英文报错的语义描述，实现者自行查 Chrome / CDP 实际报错写匹配。

| 序 | 报错说的是 | 错误码 |
|---|---|---|
| 1 | 找不到指定数字 id 的标签页（可能写成「给定 id」，id 前冒号可有可无） | `tab_not_found` |
| 2 | 调试器当前没附着在标签上，或处理命令过程中被断开 | `debugger_detached` |
| 3 | 被检查的目标已跳转或关闭；执行上下文已销毁；找不到默认执行上下文；找不到指定 id 的上下文；Promise 被回收；某数字 id 的 frame 被移除；frame 被移除；标签页已关闭 | `page_navigated_or_closed` |
| 4 | 返回对象的引用链过长；对象无法按值返回 | `js_result_not_serializable` |
| 5 | 不能访问其他扩展的 `chrome-extension://` 页面 | `blocked_by_other_extension` |
| 6 | 已有别的调试器附着；无法附着到该目标 | `debugger_attach_failed` |
| 7 | 不能访问 `chrome://` 页面；扩展商店页面不允许注入脚本 | `chrome_protected_page` |
| 8 | 历史记录里没有下一页 / 上一页 | `navigate_no_history` |


## 4. 错误码 → 建议文案（新写）

建议文案写给调用插件的 AI 代理看，用英文。未列出的码（`internal`、三个兜底码、`js_result_not_serializable`、任何自定义码）没有建议。

| 错误码 | 建议 |
|---|---|
| `navigated_away` | The tab navigated to another site during the call, so the action was not run. Check where the tab is now (read_page / tabs_context_mcp) before continuing. |
| `ref_stale` | The element this ref pointed to is gone. Get a fresh ref with read_page or find. |
| `tab_outside_group` | This tab is not in the session tab group. List usable tabs with tabs_context_mcp, or open one with tabs_create_mcp. |
| `tab_not_found` | Tab not found, probably closed. Use tabs_context_mcp to see current tab ids. |
| `debugger_detached` | The debugger connection dropped (e.g. the user opened DevTools). Retry once. |
| `debugger_attach_failed` | Cannot attach the debugger. Close DevTools on this tab, or check for another debugging tool using it. |
| `page_navigated_or_closed` | The page navigated or closed mid-action. Run read_page to get the current page first. |
| `page_loading` | The page is still loading or navigating. Wait a moment and retry. |
| `chrome_protected_page` | Built-in browser pages cannot be controlled. Navigate to an http(s) page first. |
| `blocked_by_other_extension` | This page is protected by another extension and cannot be controlled. |
| `cdp_timeout` | The page may be unresponsive. Retry, or reload it with navigate. |
| `input_invalid` | Invalid input value. Fix it using the format or options given in the error. |
| `element_unsupported` | The target is not a fillable form control. Use read_page to find the input, select or textarea. |
| `element_not_editable` | The target is disabled or read-only. Meet the page conditions that enable it first. |
| `navigate_beforeunload_blocked` | The page blocked leaving because of unsaved changes. Deal with them first, or pass force: true to discard them and leave. |
| `navigate_no_history` | No page to go back or forward to in history. |
| `navigate_load_failed` | Page failed to load (bad URL, network error or certificate problem). Check the URL and retry. |
| `coordinate_out_of_bounds` | The coordinate is outside the viewport. Pick a point again using the screenshot size. |
| `injected_script_failed` | The injected page script failed, possibly because the page is navigating. Retry once. |
| `invalid_params` | Invalid parameters. Fix them using the error message. |
| `unknown_method` | Unknown method. Make sure the MCP server and extension versions match. |

## 5. pageLoadingError 文案（新写）

英文，结构：「Page script did not respond within {ms}ms; the page is probably busy or still navigating (possibly from the previous action). Retry shortly.」其中 `{ms}` 替换为传入数字。

## 6. 常量来由

- `INJECT_TIMEOUT_MS = 45000`：沿用 Claude in Chrome 扩展公开行为里对页面脚本注入的等待上限（45 秒）。取这么长是因为重页面、慢网络下首次注入可能要几十秒，太短会把「正在加载」误报成失败；超过它基本可判定页面卡死或在跳转，交给 `page_loading` 让代理稍后重试。
- 兜底码三个：分别对应「未分类内部错误」「坐标 / 鼠标键盘动作失败」「工具执行时抛异常」这三种只表示失败、不表示原因的场景，因此需要再看报错正文。
- 「新增 `navigated_away`」：原参照实现只有「调用中途被拦截导航」且依赖站点分类，本项目改为与站点无关的「调用中途离开原站点」。
- 去掉了权限、遥测相关错误码：本项目不做权限弹窗和遥测。

## 7. 边界清单

- 自带码为空串 → 视为没带码。
- 输入是字符串而非 Error → 按字符串内容归类。
- 输入是 `null` / `undefined` → `errorCode` 返回 `internal`。
- 带具体码、正文却是标签不存在 → 仍返回自带码。
- 带兜底码、正文无法归类 → 返回该兜底码，且无 hint。
- 没带码、正文中间（非开头）出现可归类报错 → 不归类，返回 `internal`。
- JSON 包装里的协议数字码可为负数。
