# 事件时序约束校验器（Temporal Constraint Checker）

用于**采访证词核对**与**事故复盘时间线分析**的 Web 应用。用户以自然语言形式录入约束：

> 事件 A 比事件 B **早 / 晚** `x` 到 `y` 分钟

再指定一个**锚点事件及其绝对时间**，系统实时将约束转换为**差分约束图**（Difference
Constraint System）并完成：

1. **可满足性实时判定** —— 约束间一旦矛盾（图中出现负环）立即报警；
2. **矛盾环高亮复核** —— 突出显示一条具体的矛盾环：图上红色节点/边、约束列表红色行，
   并逐条列出环上的差分不等式，求和得到 `0 ≤ 负数` 的代数证据，映射回原始证词；
3. **时间窗计算** —— 可满足时给出每个事件相对锚点的**最早 / 最晚偏移**与对应的绝对时间；
4. **无法定时标记** —— 与锚点在图上没有有向通路的事件标记为「无法定时」；
5. **示例数据 + 本地持久化** —— 内置「事故复盘（可满足）」与「采访证词冲突」两套示例，
   全部编辑内容自动保存在浏览器 `localStorage`。

技术栈：React 18 + TypeScript + Vite，纯前端、无后端依赖。

---

## 一条命令启动

需要已安装 Docker（含 Compose 插件）。在项目根目录执行：

```bash
docker compose up --build -d
```

启动后访问：

> **http://localhost:8080**

镜像构建时会自动完成依赖安装（`npm ci`）与生产构建（`tsc + vite build`），
容器启动即由 nginx 直接托管静态产物，**无需任何额外初始化步骤**。

常用命令：

```bash
docker compose logs -f        # 查看日志
docker compose down           # 停止并移除容器
docker compose up --build -d  # 代码更新后重新构建启动
```

### 修改访问端口

编辑 `docker-compose.yml` 的端口映射，例如改用 9090：

```yaml
ports:
  - "9090:80"
```

然后重新 `docker compose up -d`。

---

## 本地开发（不用 Docker）

要求 Node.js 18+（推荐 20）：

```bash
npm install
npm run dev
```

访问 Vite 输出的地址（默认 **http://localhost:5173**）。

其他脚本：

```bash
npm run build     # 类型检查 + 生产构建到 dist/
npm run preview   # 本地预览生产构建（http://localhost:4173）
```

### 算法自测

```bash
npx esbuild scripts/test-graph.ts --bundle --platform=node --format=esm \
  --outfile=/tmp/test-graph.mjs && node /tmp/test-graph.mjs
```

覆盖：约束→差分边转换、可满足示例的窗口数值、负环提取与边/节点对齐、
精确间隔退化为点、无锚点、双向冲突等用例。

---

## 配置项

本应用无数据库、无第三方服务、无必需环境变量。可选配置：

| 配置位置 | 说明 | 默认值 |
| --- | --- | --- |
| `docker-compose.yml` 中 `ports` 左侧 | 宿主机访问端口 | `8080` |
| `vite.config.ts` 中 `server.port` | 本地开发端口 | `5173` |
| 浏览器 `localStorage` 键 `temporal-constraint-checker:v1` | 自动持久化的事件/约束/锚点 | 首次打开载入可满足示例 |

数据只存于当前浏览器，点击页面右上角「清空全部数据」可清除。

---

## 使用指南

1. **添加事件**：在「事件」面板录入关键时点（如：告警触发、服务恢复）；
2. **指定锚点**：点事件前的单选按钮，或使用顶部「锚点」下拉框，并设置锚点绝对时间；
3. **录入约束**：在「时序约束」面板选择 `事件 A —（早于/晚于）— 事件 B`，
   填写分钟区间 `x ~ y`（要求 `0 ≤ x ≤ y`；`x = y` 表示精确间隔）；
4. **查看实时结论**：
   - 顶部绿色横幅：系统可满足，底部表格给出每个事件的时间窗；
   - 红色横幅：存在矛盾，红色矛盾环给出可逐步复核的不等式链；
   - 黄色「无法定时」：该事件与锚点之间没有任何约束通路，请补充连接二者的约束；
5. **核对矛盾**：可逐条**取消勾选**可疑证词，观察矛盾环是否消失，快速定位冲突来源。

### 状态图例（时间窗表）

| 状态 | 含义 |
| --- | --- |
| **锚点** | 时间即用户指定的锚点绝对时间 |
| **可定时** | 最早与最晚偏移都能由约束推出 |
| **仅单边有界** | 只能推出最早或最晚一侧（另一侧无界） |
| **无法定时** | 与锚点无有向通路，图上属于另一连通分量 |

---

## 算法说明

每条约束 `A 比 B 早 x~y 分钟`（即 `x ≤ t_B − t_A ≤ y`）转换为两条
**差分不等式**，在图中对应两条带权有向边（边 `u → v` 权 `w` 表示 `t_v − t_u ≤ w`）：

- 上界：`t_B − t_A ≤ y` ⇒ `A → B, 权 y`
- 下界：`t_A − t_B ≤ −x` ⇒ `B → A, 权 −x`

`A 比 B 晚 x~y` 时方向互换。

- **可满足性**：差分系统可满足 ⇔ 图中不存在负权环。使用带「超级源点」（全部节点初始
  距离为 0）的 Bellman-Ford 在第 n 轮检测松弛，时间复杂度 O(V·E)，对复盘场景规模足够；
- **矛盾环提取**：从第 n 轮仍被松弛的边沿前驱指针回溯，先走入环内再裁掉环外尾巴，
  得到一条权重之和严格小于 0 的环；
- **时间窗**：以锚点为源跑最短路得到各事件「最晚偏移」`t_i − t_anchor` 的最小上界；
  在反向图上跑最短路得到「最早偏移」。正/反向均不可达即为「无法定时」。

---

## 项目结构

```
.
├── Dockerfile              # 多阶段构建：node 构建 + nginx 托管
├── docker-compose.yml      # 单命令编排
├── nginx.conf              # SPA 路由回退与静态资源缓存
├── index.html
├── vite.config.ts
├── src
│   ├── main.tsx
│   ├── App.tsx             # 状态管理、实时分析、布局
│   ├── types.ts            # 领域类型
│   ├── lib
│   │   ├── graph.ts        # 差分图构建 / Bellman-Ford / 负环提取 / 时间窗
│   │   ├── samples.ts      # 两套示例数据
│   │   ├── storage.ts      # localStorage 持久化
│   │   └── format.ts       # 时间与自然语言格式化
│   └── components
│       ├── GraphView.tsx        # SVG 差分图与矛盾环高亮
│       ├── EventEditor.tsx
│       ├── ConstraintEditor.tsx
│       ├── CyclePanel.tsx       # 矛盾环不等式复核
│       └── WindowsTable.tsx     # 最早/最晚时间窗表
└── scripts/test-graph.ts   # 算法测试
```
