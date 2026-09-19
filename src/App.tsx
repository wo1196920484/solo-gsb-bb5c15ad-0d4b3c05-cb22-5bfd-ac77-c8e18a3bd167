import { useEffect, useMemo, useState } from 'react'
import type { AppState, Constraint, TEvent } from './types'
import { analyze } from './lib/graph'
import {
  buildConsistentSample,
  buildContradictionSample,
  defaultAnchorTime,
  emptyState,
  uid,
} from './lib/samples'
import { clearState, loadState, saveState } from './lib/storage'
import { formatFullDateTime } from './lib/format'
import EventEditor from './components/EventEditor'
import ConstraintEditor from './components/ConstraintEditor'
import GraphView from './components/GraphView'
import CyclePanel from './components/CyclePanel'
import WindowsTable from './components/WindowsTable'

export default function App() {
  const [state, setState] = useState<AppState>(() => loadState() ?? buildConsistentSample())

  // 本地持久化：任何修改实时写入 localStorage
  useEffect(() => {
    saveState(state)
  }, [state])

  const { events, constraints, anchorId, anchorTime } = state

  // —— 实时分析 ——
  const result = useMemo(
    () => analyze(events, constraints, anchorId),
    [events, constraints, anchorId],
  )

  // 矛盾环相关集合（用于跨组件高亮）
  const cycleEventIds = useMemo(() => {
    const s = new Set<string>()
    if (!result.satisfiable && result.cycle) {
      for (const i of result.cycle.nodes) if (events[i]) s.add(events[i].id)
    }
    return s
  }, [result, events])

  const cycleConstraintIds = useMemo(() => {
    const s = new Set<string>()
    if (!result.satisfiable && result.cycle) {
      for (const e of result.cycle.edges) s.add(e.constraintId)
    }
    return s
  }, [result])

  const cycleEdgeIds = useMemo(() => {
    const s = new Set<string>()
    if (!result.satisfiable && result.cycle) {
      for (const e of result.cycle.edges) s.add(`${e.constraintId}:${e.bound}`)
    }
    return s
  }, [result])

  const cycleNodeIdx = useMemo(() => {
    const s = new Set<number>()
    if (!result.satisfiable && result.cycle) for (const i of result.cycle.nodes) s.add(i)
    return s
  }, [result])

  const activeCount = constraints.filter((c) => c.enabled).length

  // —— 编辑操作 ——
  const addEvent = (name: string, note: string) => {
    const ev: TEvent = { id: uid('ev'), name, note: note || undefined }
    setState((s) => ({
      ...s,
      events: [...s.events, ev],
      anchorId: s.anchorId ?? ev.id,
    }))
  }

  const removeEvent = (id: string) => {
    setState((s) => ({
      ...s,
      events: s.events.filter((e) => e.id !== id),
      constraints: s.constraints.filter((c) => c.aId !== id && c.bId !== id),
      anchorId: s.anchorId === id ? null : s.anchorId,
    }))
  }

  const renameEvent = (id: string, name: string) => {
    setState((s) => ({
      ...s,
      events: s.events.map((e) => (e.id === id ? { ...e, name } : e)),
    }))
  }

  const setAnchor = (id: string) => setState((s) => ({ ...s, anchorId: id }))

  const addConstraint = (c: Omit<Constraint, 'id'>) => {
    setState((s) => ({ ...s, constraints: [...s.constraints, { ...c, id: uid('ct') }] }))
  }

  const removeConstraint = (id: string) => {
    setState((s) => ({ ...s, constraints: s.constraints.filter((c) => c.id !== id) }))
  }

  const updateConstraint = (id: string, patch: Partial<Constraint>) => {
    setState((s) => ({
      ...s,
      constraints: s.constraints.map((c) => {
        if (c.id !== id) return c
        const next = { ...c, ...patch }
        // 防止输入过程中出现 min > max / 负数
        if (!Number.isFinite(next.min) || next.min < 0) next.min = 0
        if (!Number.isFinite(next.max) || next.max < next.min) next.max = next.min
        if (Number.isFinite(next.min) && next.min > next.max) next.min = next.max
        return next
      }),
    }))
  }

  const loadSample = (kind: 'ok' | 'conflict') => {
    setState(kind === 'ok' ? buildConsistentSample() : buildContradictionSample())
  }

  const resetAll = () => {
    if (!window.confirm('确定清空全部事件、约束与本地存储数据吗？')) return
    clearState()
    setState(emptyState())
  }

  // —— 顶部状态 ——
  const anchorExists = anchorId != null && events.some((e) => e.id === anchorId)
  const banner = (() => {
    if (events.length === 0) {
      return {
        cls: 'warn',
        icon: '📋',
        title: '等待录入',
        desc: '添加事件并指定锚点后开始分析。也可以直接载入下方示例数据。',
      }
    }
    if (!result.satisfiable) {
      return {
        cls: 'danger',
        icon: '⛔',
        title: '约束相互矛盾，不存在任何可行的事件时间安排',
        desc: `差分约束图中检测到负环（环上权重之和为 ${result.cycle?.totalWeight} 分钟 < 0）。红色标出的环即一条可复核的矛盾链：请核对对应证词或记录。`,
      }
    }
    if (!anchorExists) {
      return {
        cls: 'warn',
        icon: '🎯',
        title: '约束系统本身一致，但尚未指定锚点事件',
        desc: '在事件列表中点选单选按钮指定锚点，并设置锚点绝对时间，即可得到各事件的最早 / 最晚时间窗。',
      }
    }
    return {
      cls: 'ok',
      icon: '✅',
      title: '约束可满足：存在与全部约束相容的时间安排',
      desc: `共 ${events.length} 个事件、${activeCount} 条生效约束。下表给出每个事件相对锚点的最早与最晚时间；与锚点无约束通路的事件标记为“无法定时”。`,
    }
  })()

  return (
    <div className="app">
      <header className="app-header">
        <div>
          <h1>事件时序约束校验器</h1>
          <div className="subtitle">
            采访证词 / 事故复盘 · 差分约束图（Difference Constraints）实时可满足性判定
          </div>
        </div>
        <div className="toolbar">
          <button onClick={() => loadSample('ok')}>载入可满足示例</button>
          <button onClick={() => loadSample('conflict')}>载入矛盾示例</button>
          <button className="danger-ghost" onClick={resetAll}>
            清空全部数据
          </button>
        </div>
      </header>

      {/* 锚点 */}
      <div className="anchor-bar">
        <label className="title">锚点</label>
        <select
          value={anchorId ?? ''}
          onChange={(e) => setAnchor(e.target.value)}
          aria-label="锚点事件"
        >
          <option value="">（未选择）</option>
          {events.map((e) => (
            <option key={e.id} value={e.id}>
              {e.name}
            </option>
          ))}
        </select>
        <label className="title" style={{ fontWeight: 400 }}>
          锚点绝对时间
        </label>
        <input
          type="datetime-local"
          value={anchorTime}
          onChange={(e) => setState((s) => ({ ...s, anchorTime: e.target.value || defaultAnchorTime() }))}
        />
        <span className="anchor-absolute">= {formatFullDateTime(anchorTime)}</span>
      </div>

      {/* 判定横幅 */}
      <div className={`status-banner ${banner.cls}`}>
        <div className="icon">{banner.icon}</div>
        <div>
          <h2>{banner.title}</h2>
          <p>{banner.desc}</p>
          {!result.satisfiable && result.cycle && (
            <CyclePanel cycle={result.cycle} events={events} constraints={constraints} />
          )}
        </div>
      </div>

      {/* 差分图 */}
      <div className="panel graph-panel" style={{ marginBottom: 16 }}>
        <h3>
          差分约束图
          <span className="count">边标签 w 表示 t终点 − t起点 ≤ w（分钟）</span>
        </h3>
        <GraphView
          events={events}
          constraints={constraints}
          anchorId={anchorId}
          cycleNodes={cycleNodeIdx}
          cycleEdgeIds={cycleEdgeIds}
        />
      </div>

      {/* 编辑器 */}
      <div className="grid-2">
        <EventEditor
          events={events}
          anchorId={anchorId}
          cycleEventIds={cycleEventIds}
          onAdd={addEvent}
          onRemove={removeEvent}
          onRename={renameEvent}
          onSetAnchor={setAnchor}
        />
        <ConstraintEditor
          events={events}
          constraints={constraints}
          cycleConstraintIds={cycleConstraintIds}
          onAdd={addConstraint}
          onRemove={removeConstraint}
          onUpdate={updateConstraint}
        />
      </div>

      {/* 时间窗 */}
      {result.satisfiable && (
        <WindowsTable
          events={events}
          windows={result.windows}
          cycleEventIds={cycleEventIds}
          anchorId={anchorId}
          anchorTime={anchorTime}
        />
      )}

      <div className="footer-note">
        数据自动保存在浏览器 localStorage，刷新不丢失 · 停用某条约束可即时验证“去掉该证词后矛盾是否消除”
      </div>
    </div>
  )
}
