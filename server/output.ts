// MCP 工具输出的体积预算与「连续调用提醒器」，全部同步纯逻辑。

export const DEFAULT_MAX_OUTPUT_TOKENS = 8000

/** 单个码元的价格，单位：四分之一 token（ASCII=1，其余=4） */
const unitCost = (code: number): number => (code < 128 ? 1 : 4)

/** 字符串总价（四分之一 token 单位） */
function quarterUnits(s: string): number {
  let u = 0
  for (let i = 0; i < s.length; i++) u += unitCost(s.charCodeAt(i))
  return u
}

export function estimateTokens(s: string): number {
  return Math.ceil(quarterUnits(s) / 4)
}

export function maxOutputTokens(): number {
  const raw = process.env.JEV_MAX_OUTPUT_TOKENS
  if (!raw || !/^\d+$/.test(raw)) return DEFAULT_MAX_OUTPUT_TOKENS
  const n = Number(raw)
  return n > 0 ? n : DEFAULT_MAX_OUTPUT_TOKENS
}

export function truncateOutput(text: string, max?: number): string {
  const limit = max === undefined ? maxOutputTokens() : max
  const total = estimateTokens(text)
  if (total <= limit) return text

  const budget = limit * 4 // 四分之一 token 单位
  const lines = text.split('\n')
  let kept: string
  if (estimateTokens(lines[0]) < limit) {
    // 按行：每行取整后的 token 价，行间换行各算 1 单位
    let used = 0
    let n = 0
    for (const line of lines) {
      const cost = Math.ceil(quarterUnits(line) / 4) * 4 + (n > 0 ? 1 : 0)
      if (used + cost > budget) break
      used += cost
      n++
    }
    kept = lines.slice(0, n).join('\n')
  } else {
    // 首行放不下：按字符逐个累计，直到再加一个就超
    let used = 0
    let i = 0
    for (; i < text.length; i++) {
      const c = unitCost(text.charCodeAt(i))
      if (used + c > budget) break
      used += c
    }
    kept = text.slice(0, i)
  }

  const note =
    `[Output truncated: the full text is about ${total} tokens, over the limit of ${limit} tokens.` +
    ` To narrow it down, call read_page again with ref_id to focus on one element, or with a smaller max_chars.` +
    ` To raise the limit, set the environment variable JEV_MAX_OUTPUT_TOKENS.]`
  return `${kept}\n\n${note}`
}

const WHOLE_TOOLS = new Set(['navigate', 'tabs_context_mcp', 'upload_image', 'gif_creator', 'resize_window', 'file_upload', 'tabs_create_mcp'])
const BATCH_ACTIONS = new Set(['key', 'type', 'wait', 'left_click_drag', 'left_click', 'scroll_to', 'hover', 'right_click', 'triple_click', 'double_click', 'scroll'])
const CLICKS = new Set(['left_click', 'double_click', 'triple_click', 'right_click'])
const LOOKS = new Set(['screenshot', 'zoom'])
const PASSIVE = new Set(['wait', 'scroll'])

export function isBatchable(name: string, input: any): boolean {
  if (WHOLE_TOOLS.has(name)) return true
  if (name !== 'computer') return false
  const action = input?.action
  return typeof action === 'string' && BATCH_ACTIONS.has(action)
}

const CLICK_LIMIT = 5
const SINGLE_LIMIT = 2

const wrap = (s: string) => `<system-reminder>${s}</system-reminder>`

export function makeHinter(): { note(name: string, input: any, isError: boolean): string | null } {
  let clicks = 0
  let singles = 0

  const clickHint = (n: number) =>
    wrap(`You have made ${n} consecutive clicks. This looks like a simple flow on one page; consider delegating the whole sequence to quick_task instead of clicking step by step.`)
  const batchHint = () =>
    wrap('You are making consecutive single-step calls that could be combined. Use browser_batch to run several actions in one call.')

  const actionOf = (input: any): string | undefined => {
    const a = input?.action
    return typeof a === 'string' ? a : undefined
  }

  return {
    note(name, input, isError) {
      if (isError) return null

      if (name === 'browser_batch') {
        singles = 0
        const actions = input?.actions
        if (Array.isArray(actions)) {
          for (const sub of actions) {
            const subAction = sub && sub.name === 'computer' ? actionOf(sub.input) : undefined
            if (subAction && CLICKS.has(subAction)) clicks++
            else if (subAction && (LOOKS.has(subAction) || PASSIVE.has(subAction))) continue
            else clicks = 0
          }
        }
        if (clicks >= CLICK_LIMIT) {
          const n = clicks
          clicks = 0
          return clickHint(n)
        }
        return null
      }

      const action = name === 'computer' ? actionOf(input) : undefined
      if (action && LOOKS.has(action)) {
        singles = 0 // 看一眼：打断单调用，点击计数不动
        return null
      }
      if (action && CLICKS.has(action)) {
        clicks++
        singles++
      } else if (action && PASSIVE.has(action)) {
        singles++
      } else if (isBatchable(name, input)) {
        clicks = 0
        singles++
      } else {
        clicks = 0
        singles = 0
      }

      if (clicks >= CLICK_LIMIT) {
        const n = clicks
        clicks = 0
        singles = 0
        return clickHint(n)
      }
      if (singles >= SINGLE_LIMIT) {
        singles = 0
        return batchHint()
      }
      return null
    },
  }
}
