import type { Constraint, RepairPlan, RepairSolution, TEvent } from '../types'
import { describeConstraint } from '../lib/format'
import WindowsTable from './WindowsTable'

interface Props {
  plan: RepairPlan
  events: TEvent[]
  constraints: Constraint[]
  anchorId: string | null
  anchorTime: string
  /** 正在预览的方案（在 plan.solutions 中的下标）；null 表示未预览 */
  previewIndex: number | null
  onPreview: (index: number) => void
  onCancelPreview: () => void
  onApply: (solution: RepairSolution) => void
}

/**
 * 最小修复建议面板：
 * 并列最优方案至多 5 个，每个方案列出需停用的约束（按录入顺序）、
 * 修复后的事件时间窗，并支持「不写入 localStorage 的一键预览」与
 * 「确认应用（批量停用对应约束）」。
 */
export default function RepairPanel({
  plan,
  events,
  constraints,
  anchorId,
  anchorTime,
  previewIndex,
  onPreview,
  onCancelPreview,
  onApply,
}: Props) {
  const nameById = new Map(events.map((e) => [e.id, e.name]))
  const constraintById = new Map(constraints.map((c) => [c.id, c]))
  // 约束录入顺序（用于稳定展示与编号）
  const orderOf = new Map<string, number>()
  constraints.forEach((c, i) => orderOf.set(c.id, i))

  const constraintsOf = (s: RepairSolution): Constraint[] =>
    s.disableConstraintIds
      .map((id) => constraintById.get(id))
      .filter((c): c is Constraint => !!c)
      .sort((a, b) => (orderOf.get(a.id) ?? 0) - (orderOf.get(b.id) ?? 0))

  return (
    <div className="panel repair-panel">
      <h3>
        最小修复建议
        <span className="count">
          按每次发现的负环分支搜索停用约束最少的方案 · 已搜索 {plan.statesExplored}/{plan.budget} 个状态
        </span>
      </h3>

      {plan.solutions.length === 0 ? (
        <div className="repair-note">
          {plan.truncated
            ? `搜索累计达到 ${plan.budget} 个状态仍未找到修复方案，已停止。结果可能不完备，请尝试手动停用部分可疑证词后再观察矛盾环。`
            : '未能在当前约束中找到修复方案。'}
        </div>
      ) : (
        <>
          <div className="repair-summary">
            最少停用 <strong>{plan.minRemovals}</strong> 条约束即可消除全部矛盾；
            共找到 <strong>{plan.solutions.length}</strong> 个并列最优方案
            {plan.solutions.length >= 5 ? '（并列方案超过 5 个，仅展示录入顺序最靠前的 5 个）' : ''}
            ，已按约束录入顺序稳定排序。
          </div>

          {plan.truncated && (
            <div className="repair-truncated">
              ⚠️ 搜索累计达到 {plan.budget} 个状态后停止，以下结果
              <strong>可能不完备</strong>（停用数 {plan.minRemovals} 对已找到的方案仍是最小值）。
            </div>
          )}

          <div className="repair-list">
            {plan.solutions.map((s, i) => {
              const toDisable = constraintsOf(s)
              const isPreviewing = previewIndex === i
              return (
                <div
                  key={s.disableConstraintIds.join('|') || i}
                  className={`repair-card${isPreviewing ? ' previewing' : ''}`}
                >
                  <div className="repair-card-head">
                    <span className="repair-index">方案 {i + 1}</span>
                    <span className="repair-count">停用 {toDisable.length} 条</span>
                    <div className="repair-actions">
                      <button
                        className="small"
                        onClick={() => (isPreviewing ? onCancelPreview() : onPreview(i))}
                      >
                        {isPreviewing ? '退出预览' : '一键预览'}
                      </button>
                      <button
                        className="small primary"
                        onClick={() => {
                          if (
                            window.confirm(
                              `确认应用方案 ${i + 1}？将批量停用 ${toDisable.length} 条约束（写入本地数据）。`,
                            )
                          ) {
                            onApply(s)
                          }
                        }}
                      >
                        确认应用
                      </button>
                    </div>
                  </div>

                  <ul className="repair-constraints">
                    {toDisable.map((c) => (
                      <li key={c.id}>
                        <span className="repair-order">#{orderOf.get(c.id)! + 1}</span>{' '}
                        {describeConstraint(c, (id) => nameById.get(id) ?? '（已删除事件）')}
                      </li>
                    ))}
                  </ul>

                  <details className="repair-windows" open={isPreviewing}>
                    <summary>修复后的事件时间窗（相对锚点）</summary>
                    <WindowsTable
                      events={events}
                      windows={s.windows}
                      cycleEventIds={new Set()}
                      anchorId={anchorId}
                      anchorTime={anchorTime}
                    />
                  </details>
                </div>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}
