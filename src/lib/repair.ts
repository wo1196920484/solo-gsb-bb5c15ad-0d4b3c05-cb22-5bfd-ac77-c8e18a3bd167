import type {
  Constraint,
  DiffEdge,
  RepairPlan,
  RepairSolution,
  TEvent,
} from '../types'
import { buildEdges, computeWindows, detectNegativeCycle } from './graph'

/** 搜索累计状态数上限：每做一次负环判定记一个状态，超过即停止 */
export const REPAIR_STATE_BUDGET = 2000
/** 并列最优方案最多展示个数 */
export const REPAIR_MAX_SOLUTIONS = 5

/**
 * 位集形式的状态（被停用的约束集合）。
 * 约束规模可能超过 31（JS 位运算安全位数），故用 bigint。
 */
type Mask = bigint

function countBits(x: Mask): number {
  let c = 0
  while (x > 0n) {
    x &= x - 1n
    c++
  }
  return c
}

/**
 * 最小修复建议搜索。
 *
 * 问题等价于：寻找需要停用的最少约束（一个“边删除”集合），使差分图中
 * 不再存在负环 —— 即负环族的最小击中集（minimum hitting set）。
 *
 * 分支依据：每发现一个负环，修复方案必须至少停用环上的一条原始约束。
 * 因此做按层（BFS）分支限界搜索：
 *   - 初始状态为“未停用任何约束”；
 *   - 对当前状态检测负环；无环即为可行方案（BFS 保证第一批可行状态的
 *     停用数就是全局最小值）；
 *   - 有环时取出环上涉及的、尚未被停用的约束，按录入顺序逐个分叉；
 *   - 用全局 visited 去重，避免不同分叉路径到达同一状态。
 *
 * 累计负环判定次数达到 REPAIR_STATE_BUDGET 后不再展开新状态，立即停止
 * 并标记 truncated，提示结果可能不完备。
 *
 * 只考虑当前启用且引用事件仍存在的约束（与图的实际边来源一致）。
 */
export function findMinimumRepairs(
  events: TEvent[],
  constraints: Constraint[],
  anchorId: string | null,
  budget: number = REPAIR_STATE_BUDGET,
  maxSolutions: number = REPAIR_MAX_SOLUTIONS,
): RepairPlan {
  const n = events.length
  const { edges: baseEdges } = buildEdges(events, constraints)

  // 可停用候选：当前启用且引用事件存在的约束，按录入顺序编号
  const candidates = constraints.filter(
    (c) =>
      c.enabled &&
      events.some((e) => e.id === c.aId) &&
      events.some((e) => e.id === c.bId),
  )
  const m = candidates.length
  const idxOfConstraint = new Map<string, number>()
  candidates.forEach((c, i) => idxOfConstraint.set(c.id, i))

  // 每条候选约束对应的两条差分边（下标与 candidates 对齐）
  const edgesByCandidate: DiffEdge[][] = candidates.map((c) =>
    baseEdges.filter((e) => e.constraintId === c.id),
  )

  const anchorIdx = anchorId != null ? events.findIndex((e) => e.id === anchorId) : -1

  /** 在停用集 mask 下重新构建边集 */
  const edgesFor = (mask: Mask): DiffEdge[] => {
    if (mask === 0n) return baseEdges
    const es: DiffEdge[] = []
    for (let i = 0; i < m; i++) {
      if (((mask >> BigInt(i)) & 1n) === 0n) es.push(...edgesByCandidate[i])
    }
    return es
  }

  /** 取负环上“仍启用”的候选约束下标，按录入顺序升序 */
  const cycleBranches = (cycleEdges: DiffEdge[], mask: Mask): number[] => {
    const branchSet = new Set<number>()
    for (const e of cycleEdges) {
      const ci = idxOfConstraint.get(e.constraintId)
      if (ci === undefined) continue
      if (((mask >> BigInt(ci)) & 1n) !== 0n) continue // 已停用，不能作为新分叉
      branchSet.add(ci)
    }
    return [...branchSet].sort((a, b) => a - b)
  }

  // —— 按层 BFS：每个状态恰好做一次负环判定，初始状态为“未停用任何约束” ——
  let frontier: Mask[] = [0n]
  const visited = new Set<Mask>([0n])
  const foundMasks: Mask[] = []
  let statesExplored = 0
  let truncated = false
  let minRemovals: number | null = null

  while (frontier.length > 0) {
    const nextSet = new Set<Mask>()
    const nextFrontier: Mask[] = []

    for (const mask of frontier) {
      if (statesExplored >= budget) {
        truncated = true
        break
      }
      const det = detectNegativeCycle(n, edgesFor(mask))
      statesExplored++

      if (!det.hasNegativeCycle) {
        foundMasks.push(mask)
        continue
      }
      if (!det.cycle) {
        // 检测到负环却无法抽出：无法安全分叉，跳过该状态
        continue
      }
      for (const ci of cycleBranches(det.cycle.edges, mask)) {
        const child = mask | (1n << BigInt(ci))
        if (!visited.has(child) && !nextSet.has(child)) {
          nextSet.add(child)
          nextFrontier.push(child)
        }
      }
    }

    if (foundMasks.length > 0) {
      // BFS：本层全部是相同停用数，第一批可行方案即全局最小
      minRemovals = countBits(foundMasks[0])
      break
    }
    if (truncated) break
    for (const child of nextFrontier) visited.add(child)
    frontier = nextFrontier
  }

  if (minRemovals === null) {
    return { minRemovals: null, solutions: [], statesExplored, budget, truncated }
  }
  if (minRemovals === 0) {
    // 初始状态即可满足：无需停用任何约束，不给出方案
    return { minRemovals: 0, solutions: [], statesExplored, budget, truncated }
  }

  // 并列最优：按约束录入顺序稳定排序。
  // 方案对应“停用约束下标（升序）序列”，按序列字典序排列：
  // 取两个位集最低的不同位 i，在 i 处置位者序列中更早出现 i，应排在前面。
  const compareMasks = (a: Mask, b: Mask): number => {
    const diff = a ^ b
    if (diff === 0n) return 0
    const low = diff & -diff
    return (a & low) !== 0n ? -1 : 1
  }
  foundMasks.sort(compareMasks)

  const solutions: RepairSolution[] = foundMasks.slice(0, maxSolutions).map((mask) => {
    const ids: string[] = []
    for (let i = 0; i < m; i++) {
      if (((mask >> BigInt(i)) & 1n) === 1n) ids.push(candidates[i].id)
    }
    // 修复后的时间窗（在“停用集”生效的边集上计算）
    const windows = computeWindows(n, edgesFor(mask), anchorIdx)
    return { disableConstraintIds: ids, windows }
  })

  return { minRemovals, solutions, statesExplored, budget, truncated }
}
