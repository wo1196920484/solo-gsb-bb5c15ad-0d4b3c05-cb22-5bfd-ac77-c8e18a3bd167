import { analyze } from '../src/lib/graph'
import {
  findMinimumRepairs,
  REPAIR_MAX_SOLUTIONS,
  REPAIR_STATE_BUDGET,
} from '../src/lib/repair'
import { buildConsistentSample, buildContradictionSample } from '../src/lib/samples'
import type { Constraint, TEvent } from '../src/types'

let passed = 0
let failed = 0

function assert(cond: boolean, msg: string) {
  if (cond) {
    passed++
  } else {
    failed++
    console.error('FAIL:', msg)
  }
}

let cid = 0
function mkConstraint(
  events: TEvent[],
  a: string,
  b: string,
  relation: 'earlier' | 'later',
  min: number,
  max: number,
  enabled = true,
): Constraint {
  cid++
  const id = `c${cid}`
  const aId = events.find((e) => e.name === a)!.id
  const bId = events.find((e) => e.name === b)!.id
  return { id, aId, bId, relation, min, max, enabled }
}

function mkEvents(names: string[]): TEvent[] {
  return names.map((name, i) => ({ id: `e${i}`, name }))
}

/** 停用方案 id 集合后系统必须恢复可满足 */
function assertFixes(events: TEvent[], constraints: Constraint[], ids: string[], msg: string) {
  const kill = new Set(ids)
  const patched = constraints.map((c) => (kill.has(c.id) ? { ...c, enabled: false } : c))
  assert(analyze(events, patched, null).satisfiable, msg)
}

// ---- 可满足系统：不需要修复 ----
{
  const s = buildConsistentSample()
  const plan = findMinimumRepairs(s.events, s.constraints, s.anchorId)
  assert(plan.minRemovals === 0, '可满足示例最小停用数为 0')
  assert(plan.solutions.length === 0, '可满足示例不给出方案')
  assert(!plan.truncated, '可满足示例未截断')
  assert(plan.statesExplored === 1, '可满足示例仅判定 1 个状态')
}

// ---- 矛盾示例：3 条约束构成一个负环，最少停用 1 条，3 个并列方案 ----
{
  const s = buildContradictionSample()
  const plan = findMinimumRepairs(s.events, s.constraints, s.anchorId)
  assert(plan.minRemovals === 1, '矛盾示例最少停用 1 条')
  assert(plan.solutions.length === 3, '矛盾示例给出 3 个并列方案')
  assert(!plan.truncated, '矛盾示例未截断')

  // 每个方案恰好停用 1 条，且停用后确实可满足
  for (const sol of plan.solutions) {
    assert(sol.disableConstraintIds.length === 1, '每个方案停用 1 条')
    assertFixes(
      s.events,
      s.constraints,
      sol.disableConstraintIds,
      `停用 ${sol.disableConstraintIds[0]} 后矛盾消除`,
    )
  }

  // 稳定排序：按约束录入顺序（方案对应的下标升序）
  const orderOf = new Map(s.constraints.map((c, i) => [c.id, i]))
  const orders = plan.solutions.map((sol) => orderOf.get(sol.disableConstraintIds[0])!)
  assert(
    JSON.stringify(orders) === JSON.stringify([...orders].sort((a, b) => a - b)),
    '并列方案按录入顺序稳定排序',
  )
  // 环外约束（D 相关，录入第 4 条）不应出现在任何方案中
  const dConstraint = s.constraints[3]
  assert(
    plan.solutions.every((sol) => !sol.disableConstraintIds.includes(dConstraint.id)),
    '环外正常约束不进入修复方案',
  )

  // 修复后时间窗可计算：锚点窗口为 0，其余状态合法
  const sol0 = plan.solutions[0]
  const anchorIdx = s.events.findIndex((e) => e.id === s.anchorId)
  const w0 = sol0.windows.get(anchorIdx)
  assert(w0?.status === 'anchor' && w0.earliestOffset === 0 && w0.latestOffset === 0, '方案窗口中锚点正确')
}

// ---- 两个不相交负环：最少停用 2 条（命中集） ----
{
  const events = mkEvents(['A', 'B', 'C', 'D', 'E'])
  // 环 1（A-B）：A 早于 B 10~20，A 晚于 B 5~8
  // 环 2（C-D）：C 早于 D 10~20，C 晚于 D 5~8
  // E 通过一条正常约束连接 D
  const constraints = [
    mkConstraint(events, 'A', 'B', 'earlier', 10, 20),
    mkConstraint(events, 'A', 'B', 'later', 5, 8),
    mkConstraint(events, 'C', 'D', 'earlier', 10, 20),
    mkConstraint(events, 'C', 'D', 'later', 5, 8),
    mkConstraint(events, 'E', 'D', 'later', 1, 4),
  ]
  const plan = findMinimumRepairs(events, constraints, events[0].id)
  const idxOfInRing = (id: string) => constraints.findIndex((c) => c.id === id)
  assert(plan.minRemovals === 2, '两个不相交负环最少停用 2 条')
  assert(plan.solutions.length === 4, '两个二选一环给出 2×2=4 个并列方案')
  for (const sol of plan.solutions) {
    assert(sol.disableConstraintIds.length === 2, '每个方案停用 2 条')
    const idx = sol.disableConstraintIds.map(idxOfInRing)
    // 下标 0,1 属环 1（A-B）；2,3 属环 2（C-D），每环恰好停用一条
    assert(idx.filter((i) => i <= 1).length === 1, '环 1 恰好停用一条')
    assert(idx.filter((i) => i >= 2 && i <= 3).length === 1, '环 2 恰好停用一条')
    assertFixes(events, constraints, sol.disableConstraintIds, '组合停用后可满足')
  }
  assert(!plan.solutions.some((s) => s.disableConstraintIds.includes(constraints[4].id)), '无关约束不在方案中')

  // 稳定排序：方案的下标序列字典序：[0,2],[0,3],[1,2],[1,3]
  const idxOf = new Map(constraints.map((c, i) => [c.id, i]))
  const seqs = plan.solutions.map((sol) => sol.disableConstraintIds.map((id) => idxOf.get(id)!))
  assert(
    JSON.stringify(seqs) === JSON.stringify([[0, 2], [0, 3], [1, 2], [1, 3]]),
    '组合方案按下标字典序稳定排序',
  )
}

// ---- 并列方案超过 5 个：最多展示 5 个（6 条约束同属一个负环） ----
{
  // 6 节点环 P0..P5，约束 i：P_i 晚于 P_{i+1} 1~100。
  // 每条约束给出环向边 P_i -> P_{i+1} 权 -1（下界侧），
  // 6 条 -1 边首尾相接构成总权 -6 的负环。
  // 停用任意 1 条后，剩余至多 5 条 -1 边，要再成环必须补一条 +100 上界边，
  // 环权 ≥ 100 − 5 > 0，故 6 个单点方案并列最优。
  const ev6 = mkEvents(['P0', 'P1', 'P2', 'P3', 'P4', 'P5'])
  const ring: Constraint[] = []
  for (let i = 0; i < 6; i++) {
    ring.push(mkConstraint(ev6, ev6[i].name, ev6[(i + 1) % 6].name, 'later', 1, 100))
  }
  const plan = findMinimumRepairs(ev6, ring, ev6[0].id)
  assert(plan.minRemovals === 1, '6 边单环最少停用 1 条')
  assert(plan.solutions.length === REPAIR_MAX_SOLUTIONS, '并列超过 5 个时只展示 5 个')
  // 展示的是录入顺序最靠前的 5 个
  const idxOf = new Map(ring.map((c, i) => [c.id, i]))
  const shown = plan.solutions.map((s) => idxOf.get(s.disableConstraintIds[0])!)
  assert(JSON.stringify(shown) === JSON.stringify([0, 1, 2, 3, 4]), '展示录入顺序最靠前的 5 个')
  for (const sol of plan.solutions) {
    assertFixes(ev6, ring, sol.disableConstraintIds, '停用任意一条环边后可满足')
  }
}

// ---- 预算截断：budget=1 时初始状态后立即停止，标记可能不完备 ----
{
  const s = buildContradictionSample()
  const plan = findMinimumRepairs(s.events, s.constraints, s.anchorId, 1)
  assert(plan.statesExplored === 1, '预算 1：只判定初始状态')
  assert(plan.truncated, '预算用尽标记 truncated')
  assert(plan.minRemovals === null && plan.solutions.length === 0, '未找到方案时 minRemovals 为 null')
  assert(plan.budget === 1, '回传预算值')
}

// ---- 大预算下小问题不会截断，状态数不超过上限 ----
{
  const s = buildContradictionSample()
  const plan = findMinimumRepairs(s.events, s.constraints, s.anchorId, REPAIR_STATE_BUDGET)
  assert(plan.statesExplored <= REPAIR_STATE_BUDGET, '状态数不超过 2000 上限')
  assert(!plan.truncated, '小规模示例在 2000 预算内搜索完备')
}

// ---- 已停用的约束不参与修复候选 ----
{
  const s = buildContradictionSample()
  // 手工停用环上第一条后，系统仍矛盾（另外 3 条 later 沿环：B-A, C-B, A-C 仍为负环？
  // 停用 1 条边后环即破），预期变为可满足，repairPlan 为 minRemovals=0。
  const patched = s.constraints.map((c, i) => (i === 0 ? { ...c, enabled: false } : c))
  const r = analyze(s.events, patched, s.anchorId)
  assert(r.satisfiable, '手工停用环上一条后可满足')
  const plan = findMinimumRepairs(s.events, patched, s.anchorId)
  assert(plan.minRemovals === 0, '已部分修复时不再给方案')
}

// ---- 修复方案窗口：精确间隔下退化为点 ----
{
  const events = mkEvents(['A', 'B'])
  const constraints = [
    mkConstraint(events, 'A', 'B', 'earlier', 10, 20),
    mkConstraint(events, 'A', 'B', 'later', 5, 8), // 与上者冲突
  ]
  const plan = findMinimumRepairs(events, constraints, events[0].id)
  assert(plan.minRemovals === 1 && plan.solutions.length === 2, '两点冲突 2 个单点方案')
  // 停用 later（保留 earlier 10~20）：B 的窗口应为 +10 ~ +20
  const keepEarlier = plan.solutions.find(
    (sol) => sol.disableConstraintIds[0] === constraints[1].id,
  )!
  const wB = keepEarlier.windows.get(1)!
  assert(wB.earliestOffset === 10 && wB.latestOffset === 20, '保留 earlier 时 B 窗口 +10~+20')
  assert(wB.status === 'bounded', '修复后 B 可定时')
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
