// 错误归一模块：把各种来源的异常统一成「错误码 + 说明 + 建议」三件套。

// 页面脚本注入的等待上限（毫秒）
export const INJECT_TIMEOUT_MS = 45000

// 兜底码：只表示出错，不表示原因，需要再看报错正文
const GENERIC_CODES = new Set(['internal', 'computer_action_failed', 'tool_execution_exception'])

// Chrome / CDP 原生报错规则，按规格第 3 节行序排列（区分大小写）
const NATIVE_RULES = [
  ['tab_not_found', [/No tab with (?:given )?id:? ?\d+/]],
  ['debugger_detached', [/Debugger is not attached to the tab/, /Detached while handling command/]],
  ['page_navigated_or_closed', [
    /Inspected target navigated or closed/,
    /Execution context was destroyed/,
    /Cannot find default execution context/,
    /Cannot find context with specified id/,
    /Promise was collected/,
    /Frame with ID \d+ was removed/,
    /The frame was removed/,
    /The tab was closed/,
  ]],
  ['js_result_not_serializable', [/Object reference chain is too long/, /Object couldn't be returned by value/]],
  ['blocked_by_other_extension', [/Cannot access a chrome-extension:\/\/ URL of different extension/]],
  ['debugger_attach_failed', [/Another debugger is already attached/, /Cannot attach to this target/]],
  ['chrome_protected_page', [/Cannot access a chrome:\/\/ URL/, /The extensions gallery cannot be scripted/]],
  ['navigate_no_history', [/Cannot find a (?:next|previous) page in history/]],
]

// 错误码 → 给代理看的中文建议
const HINTS = {
  navigated_away: 'The tab navigated to another site during the call, so the action was not run. Check where the tab is now (read_page / tabs_context_mcp) before continuing.',
  ref_stale: 'The element this ref pointed to is gone. Get a fresh ref with read_page or find.',
  tab_outside_group: 'This tab is not in the session tab group. List usable tabs with tabs_context_mcp, or open one with tabs_create_mcp.',
  tab_not_found: 'Tab not found, probably closed. Use tabs_context_mcp to see current tab ids.',
  debugger_detached: 'The debugger connection dropped (e.g. the user opened DevTools). Retry once.',
  debugger_attach_failed: 'Cannot attach the debugger. Close DevTools on this tab, or check for another debugging tool using it.',
  page_navigated_or_closed: 'The page navigated or closed mid-action. Run read_page to get the current page first.',
  page_loading: 'The page is still loading or navigating. Wait a moment and retry.',
  chrome_protected_page: 'Built-in browser pages cannot be controlled. Navigate to an http(s) page first.',
  blocked_by_other_extension: 'This page is protected by another extension and cannot be controlled.',
  cdp_timeout: 'The page may be unresponsive. Retry, or reload it with navigate.',
  input_invalid: 'Invalid input value. Fix it using the format or options given in the error.',
  element_unsupported: 'The target is not a fillable form control. Use read_page to find the input, select or textarea.',
  element_not_editable: 'The target is disabled or read-only. Meet the page conditions that enable it first.',
  navigate_beforeunload_blocked: 'The page blocked leaving because of unsaved changes. Deal with them first, or pass force: true to discard them and leave.',
  navigate_no_history: 'No page to go back or forward to in history.',
  navigate_load_failed: 'Page failed to load (bad URL, network error or certificate problem). Check the URL and retry.',
  coordinate_out_of_bounds: 'The coordinate is outside the viewport. Pick a point again using the screenshot size.',
  injected_script_failed: 'The injected page script failed, possibly because the page is navigating. Retry once.',
  invalid_params: 'Invalid parameters. Fix them using the error message.',
  unknown_method: 'Unknown method. Make sure the MCP server and extension versions match.',
}

// CDP 把错误包成 {"code":<整数>,"message":"...，只认开头这段前缀
const CDP_PREFIX = /^\{"code":-?\d+,"message":"/

// 取报错正文：Error 用 message，其余转字符串，null / undefined 为空串
const bodyOf = (e) => {
  const raw = e instanceof Error ? e.message : e == null ? '' : String(e)
  return raw.replace(CDP_PREFIX, '')
}

// 在正文里按行序找第一类匹配；atStart 为真时只认开头
const classify = (text, atStart) => {
  for (const [code, patterns] of NATIVE_RULES) {
    for (const re of patterns) {
      const m = re.exec(text)
      if (m && (!atStart || m.index === 0)) return code
    }
  }
  return null
}

export const errorCode = (e) => {
  const own = e == null ? undefined : e.code
  // 自带具体码：原样返回，不看正文
  if (own && !GENERIC_CODES.has(own)) return own
  const text = bodyOf(e)
  // 自带兜底码：正文任意位置可归类
  if (own) return classify(text, false) ?? own
  // 没带码：只认开头
  return classify(text, true) ?? 'internal'
}

export const toError = (e) => {
  const code = errorCode(e)
  const hasMessage = e != null && e.message !== undefined
  const message = String(hasMessage ? e.message : e)
  let hint = e != null && e.hint != null ? e.hint : undefined
  if (hint === undefined && typeof code === 'string' && Object.hasOwn(HINTS, code)) hint = HINTS[code]
  const out = { code, message }
  if (hint !== undefined && hint !== '') out.hint = hint
  return out
}

export const pageLoadingError = (ms) => {
  const err = new Error(
    `Page script did not respond within ${ms}ms; the page is probably busy or still navigating (possibly from the previous action). Retry shortly.`,
  )
  err.code = 'page_loading'
  return err
}

export const withTimeout = (promise, ms, makeError) => {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(makeError(ms)), ms)
  })
  // 不论原 promise 成败，都清掉计时器
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}
