// 包住真 Jev 的模块（JEV_FAKE_MODULE 指向它）：原样转发给真模型，同时把每步选择题的完整概率分布和「选得对不对」写进 JEV_TRACE_PATH。
// key 只在 makeProvider 里用，不进 trace。累计费用到上限（JEV_REAL_LIMIT，默认 $0.9）立刻抛错停下；text() 也走真 Jev，费用同样累计。
import { appendFileSync } from 'node:fs'
import { loadSettings, makeProvider } from '../server/jev'
import { fieldValues, fixtureOf } from './real-jev-fixtures'

const LIMIT = Number(process.env.JEV_REAL_LIMIT ?? 0.9)
let spent = 0
let real: ReturnType<typeof makeProvider> | undefined
const provider = () => (real ||= makeProvider(loadSettings()))

export default async (body: any) => {
  if (spent >= LIMIT) throw new Error('real-jev-wrap: 累计费用到上限，停')
  const r = await provider().decide(body)
  const cost = Number(r.usage?.cost) || 0
  spent += cost
  const url = new URL(body.state.page.url)
  const fx = fixtureOf(url.pathname)
  const opA = r.answers?.operation
  const op: string = opA?.choice
  const tA = r.answers?.[`${String(op).toLowerCase()}_target`]
  const crit = tA ? body.questions[`${op.toLowerCase()}_target`].criteria[tA.choice] : undefined
  const tgt: string = crit ? `${crit.element ?? ''} ${crit.context ?? ''}`.trim() : ''
  const sorted = tA ? (Object.values(tA.probabilities) as number[]).sort((a, b) => b - a) : []
  const opP = opA?.probabilities ?? {}
  appendFileSync(
    process.env.JEV_TRACE_PATH!,
    JSON.stringify({
      fixture: fx?.key,
      url: body.state.page.url,
      op,
      target: tgt,
      op_conf: opA?.confidence,
      target_conf: tA?.confidence ?? null,
      top: sorted[0] ?? null,
      second: sorted[1] ?? 0,
      none: (opP.DONE ?? 0) + (opP.BLOCKED ?? 0) + (opP.WAIT ?? 0), // 「别动 / 做完 / 卡住」三个选项的概率和
      op_probs: opP,
      recent: body.state.recent_actions ?? [],
      els: body.state.elements.map((e: any) => [e.label, e.value, e.checked]),
      ok: fx ? fx.ok({ op, tgt, els: body.state.elements, text: body.state.page.text, recent: body.state.recent_actions ?? [] }) : null,
      cost,
      spent,
    }) + '\n',
  )
  return r
}
// 小模型默认走真 text()（当前 provider）；JEV_TEXT_TABLE=1 才换成按标签查表（不花钱）
export const text = async (ctx: any) => {
  if (process.env.JEV_TEXT_TABLE === '1') return { text: fieldValues[ctx.field?.label] ?? null, usage: { cost: 0 } }
  if (spent >= LIMIT) throw new Error('real-jev-wrap: 累计费用到上限，停')
  const r = await provider().text(ctx)
  spent += Number(r.usage?.cost) || 0
  return r
}
