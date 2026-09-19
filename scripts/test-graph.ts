import { analyze, buildEdges, constraintToEdges } from '../src/lib/graph'
import { buildConsistentSample, buildContradictionSample } from '../src/lib/samples'
import type { Constraint } from '../src/types'

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

function approxEq(a: number | null, b: number | null) {
  if (a === null || b === null) return a === b
  return a === b
}

// ---- 单条约束的边转换 ----
{
  const c: Constraint = {
    id: 'c1', aId: 'A', bId: 'B', relation: 'earlier', min: 3, max: 8, enabled: true,
  }
  const idx = new Map([['A', 0], ['B', 1]])
  const es = constraintToEdges(c, (id) => idx.get(id)!)
  // earlier: A->B +8 (t_B - t_A <= 8), B->A -3 (t_A - t_B <= -3)
  assert(es.some((e) => e.u === 0 && e.v === 1 && e.w === 8), 'earlier 上界边 A->B +8')
  assert(es.some((e) => e.u === 1 && e.v === 0 && e.w === -3), 'earlier 下界边 B->A -3')

  const c2: Constraint = {
    id: 'c2', aId: 'A', bId: 'B', relation: 'later', min: 3, max: 8, enabled: true,
  }
  const es2 = constraintToEdges(c2, (id) => idx.get(id)!)
  assert(es2.some((e) => e.u === 1 && e.v === 0 && e.w === 8), 'later 上界边 B->A +8')
  assert(es2.some((e) => e.u === 0 && e.v === 1 && e.w === -3), 'later 下界边 A->B -3')
}

// ---- 禁用约束不产生边 ----
{
  const state = buildConsistentSample()
  const all = buildEdges(state.events, state.constraints).edges.length
  const disabled = state.constraints.map((c) => ({ ...c, enabled: false }))
  assert(buildEdges(state.events, disabled).edges.length === 0, '全部停用时边集为空')
  assert(all === state.constraints.length * 2, '每条约束产生 2 条边')
}

// ---- 可满足示例的窗口 ----
{
  const s = buildConsistentSample()
  const r = analyze(s.events, s.constraints, s.anchorId)
  assert(r.satisfiable, '可满足示例判定为可满足')
  assert(!r.cycle, '可满足示例无矛盾环')
  const byName = new Map(s.events.map((e, i) => [e.name, i]))
  const w = (name: string) => r.windows.get(byName.get(name)!)!

  assert(approxEq(w('值班工程师介入').earliestOffset, 2), '介入最早 +2')
  assert(approxEq(w('值班工程师介入').latestOffset, 5), '介入最晚 +5')
  assert(approxEq(w('定位到故障节点').earliestOffset, 5), '定位最早 +5')
  assert(approxEq(w('定位到故障节点').latestOffset, 15), '定位最晚 +15')
  assert(approxEq(w('完成流量切换').earliestOffset, 6), '切换最早 +6')
  assert(approxEq(w('完成流量切换').latestOffset, 19), '切换最晚 +19（受恢复反推约束）')
  assert(approxEq(w('服务恢复').earliestOffset, 10), '恢复最早 +10（受"定位早于恢复5~15"收紧）')
  assert(approxEq(w('服务恢复').latestOffset, 20), '恢复最晚 +20（整体约束）')
  assert(approxEq(w('复盘会议').earliestOffset, 70), '复盘最早 +70')
  assert(approxEq(w('复盘会议').latestOffset, 200), '复盘最晚 +200')
  assert(w('媒体报道').status === 'disconnected', '媒体报道未连通 -> 无法定时')
  assert(w('值班告警触发').status === 'anchor', '告警为锚点')
}

// ---- 矛盾示例：负环提取 ----
{
  const s = buildContradictionSample()
  const r = analyze(s.events, s.constraints, s.anchorId)
  assert(!r.satisfiable, '矛盾示例判定为不可满足')
  assert(!!r.cycle, '提取出矛盾环')
  if (r.cycle) {
    assert(r.cycle.totalWeight === -25, '环权重之和 = -25')
    // 环必须覆盖 A、B、C（不含 D）
    const names = r.cycle.nodes.map((i) => s.events[i].name[0]).sort()
    assert(JSON.stringify(names) === JSON.stringify(['A', 'B', 'C']), '环为 A-B-C')
    // 校验 edges[i] 从 nodes[i] 指向 nodes[(i+1)%n]
    const n = r.cycle.nodes.length
    let aligned = true
    for (let i = 0; i < n; i++) {
      const e = r.cycle.edges[i]
      if (e.u !== r.cycle.nodes[i] || e.v !== r.cycle.nodes[(i + 1) % n]) aligned = false
    }
    assert(aligned, '环边与环节点严格对齐 edges[i]: nodes[i] -> nodes[i+1]')
    // 环上的每条边权重确实来自对应约束
    const sum = r.cycle.edges.reduce((a, e) => a + e.w, 0)
    assert(sum === r.cycle.totalWeight, '环权重求和一致')
  }
}

// ---- 精确间隔约束（min == max）：窗口退化为点 ----
{
  const s = buildConsistentSample()
  s.constraints = s.constraints.map((c) =>
    c.aId === s.events[1].id ? { ...c, min: 4, max: 4 } : c,
  )
  const r = analyze(s.events, s.constraints, s.anchorId)
  const w = r.windows.get(1)!
  assert(r.satisfiable, '改精确间隔后仍可满足')
  assert(w.earliestOffset === 4 && w.latestOffset === 4, '介入窗口退化为 +4 单点')
}

// ---- 空系统 / 无锚点 ----
{
  const r0 = analyze([], [], null)
  assert(r0.satisfiable, '空系统可满足')
  const s = buildConsistentSample()
  const r1 = analyze(s.events, s.constraints, null)
  assert(r1.satisfiable, '无锚点时系统仍判可满足')
  assert([...r1.windows.values()].every((w) => w.status === 'disconnected'), '无锚点时全部无法定时')
}

// ---- 经典矛盾：A 早于 B 10 分钟，又晚于 B 5 分钟（两点环） ----
{
  const ev = [
    { id: 'a', name: 'A' },
    { id: 'b', name: 'B' },
  ]
  const cs: Constraint[] = [
    { id: 'x', aId: 'a', bId: 'b', relation: 'earlier', min: 10, max: 20, enabled: true },
    { id: 'y', aId: 'a', bId: 'b', relation: 'later', min: 5, max: 8, enabled: true },
  ]
  const r = analyze(ev, cs, 'a')
  assert(!r.satisfiable, '双向时间冲突判为矛盾')
  // t_B - t_A <= 20 且 t_B - t_A <= -5（A later B min5 => B->A +8, A->B -5）
  // 负环 A->B -5, B->A +8? = +3 不为负；另一环 A->B +20, B->A -8 = +12。
  // 实际矛盾: A->B -5 与 B->A -8？A later B 5..8: B->A +8(上界), A->B -5(下界)
  // A earlier B 10..20: A->B +20, B->A -10
  // 环 A->B(-5) B->A(-10) = -15 <0 ✓
  assert(r.cycle !== undefined && r.cycle.totalWeight < 0, '两点负环权重为负')
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
