// 把握度三档闸门和可撤回步骤的试错。思路参考 ~/Github/jev-mcp 的 decide/gating.ts（gateChoice）和 runner/rollback.ts（rollbackPlan / hadEffect）。
// 纯函数，不碰网络和浏览器：jev-task.ts 的循环调用它们做决定。

export type Thresholds = { act: number; escalate: number }
export type Gate = 'act' | 'look' | 'escalate'

// 默认值按真 Jev 跑 jev_task 的数据定（见施工方案「把握度」节）：选对的步最低 0.59、九成在 0.79 以上；少数选错的步都在 0.4 以下。样本少，需复核。
export function thresholds(env: Record<string, string | undefined> = process.env): Thresholds {
  const n = (v: string | undefined, d: number) => (v !== undefined && v !== '' && Number(v) >= 0 && Number(v) <= 1 ? Number(v) : d)
  const act = n(env.JEV_TASK_ACT, 0.75)
  return { act, escalate: Math.min(n(env.JEV_TASK_ESCALATE, 0.5), act) }
}

// 一步的把握 = 「做哪种操作」和「选哪个目标」里较低的那个
export const stepConfidence = (d: { confidence: number; target_confidence?: number | null }) => Math.min(d.confidence, d.target_confidence ?? 1)

// ≥ act 直接做；< escalate 停下回报；中间再看一眼
export function gate(conf: number, th: Thresholds): Gate {
  if (conf >= th.act) return 'act'
  if (conf < th.escalate) return 'escalate'
  return 'look'
}

// 再看一眼：两次选的操作和目标一致才取平均，不一致说明 Jev 自己都拿不准，按 0 处理（停下）
export function mergeLooks(a: { operation: string; target?: { ref: string; label: string } }, ac: number, b: typeof a, bc: number): number {
  const same = a.operation === b.operation && a.target?.ref === b.target?.ref && a.target?.label === b.target?.label
  return same ? (ac + bc) / 2 : 0
}

// 可撤回的步骤：填字段、选下拉、切开关 / 单选 / 复选。提交、跳转类的点击不在此列，不试错
const TOGGLE_ROLES = new Set(['checkbox', 'radio', 'switch'])
export function trialable(target: { kind: string; element: Record<string, any> } | undefined | null): boolean {
  if (!target) return false
  if (target.kind === 'fill' || target.kind === 'select') return true
  return target.kind === 'click' && TOGGLE_ROLES.has(String(target.element.role))
}

type Snap = { url: string; elements: Record<string, any>[] }

const stateOf = (e: Record<string, any>) => JSON.stringify([e.value, e.checked, e.selected, e.expanded])

// 这一步有没有效果：目标元素的值 / 选中 / 展开状态变了；元素在新页面里找不到（重渲染）就看整页有没有变
export function hadEffect(before: Snap, after: Snap, ref: string, pageChanged: boolean): boolean {
  if (before.url !== after.url) return true
  const b = before.elements.find((e) => e.ref === ref)
  const a = after.elements.find((e) => e.ref === ref)
  if (b && a) return stateOf(a) !== stateOf(b) || pageChanged
  return pageChanged
}

export type Rollback = { op: 'back' } | { op: 'escape' } | { op: 'restore'; ref: string; value: string } | { op: 'reclick'; ref: string }

// 撤回计划：地址变了 → 后退；多出展开的东西 → Escape；值变了 → 恢复原值；开关变了 → 再点一次
export function rollbackPlan(before: Snap, after: Snap, ref: string, kind: string): Rollback[] {
  if (before.url !== after.url) return [{ op: 'back' }]
  const plan: Rollback[] = []
  const b = before.elements.find((e) => e.ref === ref)
  const a = after.elements.find((e) => e.ref === ref)
  if (after.elements.some((e) => e.expanded === true && !before.elements.find((x) => x.ref === e.ref)?.expanded)) plan.push({ op: 'escape' })
  if (b && a) {
    if (kind === 'click' && (b.checked !== a.checked || b.selected !== a.selected)) plan.push({ op: 'reclick', ref })
    else if ((kind === 'fill' || kind === 'select') && (a.value ?? '') !== (b.value ?? '')) {
      const original = b.value ?? (b.options ?? []).filter((o: any) => o.selected).map((o: any) => o.label).join(', ')
      plan.push({ op: 'restore', ref, value: String(original) })
    }
  }
  return plan
}
