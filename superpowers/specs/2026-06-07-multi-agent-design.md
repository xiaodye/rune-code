# Multi-Agent 架构设计规格

## 概述

为 Rune Code 实现统一轻量级 multi-agent 架构：单主 Agent + 按需 spawn 子 Agent（Explorer / Coder / Reviewer），所有子 agent 采用相同模式——执行完成后返回摘要，不做流式透传和 HITL 冒泡。

## 设计决策

### 为什么是统一轻量模式

对比过三种方案后选定：

| 方案 | 描述 | 否决原因 |
|------|------|----------|
| A: Tool-as-Spawn 纯文本 | spawn tool 内 invoke，返回摘要 | 采用（即本方案） |
| B: StateGraph 子图嵌套 | 重构为多节点 StateGraph | 工作量大，破坏现有架构 |
| C: Tool-as-Spawn + EventBridge | 流式透传 + HITL 冒泡 | Coder 不需要重量级，统一更简单 |

关键取舍：用户在子 agent 执行期间看不到中间过程（只看到状态行），换来的是零额外 UI 复杂度和统一的实现模式。

### 与 Claude Code Agent Tool 的关系

采用与 Claude Code 相同的哲学——"约束而非桥接"：
- Explorer/Reviewer 只给只读工具，不可能触发危险操作
- Coder 遇到 dangerous+ 命令自动拒绝，让它换方式
- 不透传流式，不冒泡 HITL，CLI 层无改动

---

## 架构总览

```
┌─────────────────────────────────────────────────────────────┐
│                     CLI (app.tsx)                            │
│  - 主 agent token → 直接渲染                                 │
│  - 子 agent 执行期间 → 显示状态行 "⏳ [Explorer] ..."        │
│  - ToolMessage 返回后 → 摘要作为普通消息渲染                  │
│  - 无流式透传、无 HITL 冒泡、无额外 UI 组件                   │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                   Main Agent (coding-agent)                  │
│  Tools: [bash, grep, ls, tree, text_editor, MCP,            │
│          spawn_agent]  ← 新增                               │
│  Middleware: [todo, modelCallLimit, summarization, HITL]     │
└─────────────────────────────────────────────────────────────┘
                              │
                    spawn_agent tool
                    ┌─────────┼──────────┐
                    ▼         ▼          ▼
            ┌──────────┐ ┌────────┐ ┌──────────┐
            │ Explorer │ │ Coder  │ │ Reviewer │
            │ 只读工具  │ │ 全工具  │ │ 只读+git │
            │ 摘要回传  │ │ 摘要回传│ │ 摘要回传  │
            └──────────┘ └────────┘ └──────────┘
```

---

## spawn_agent Tool 定义

```typescript
// src/tools/agent/spawn-tool.ts
{
  name: 'spawn_agent',
  description: '派生子 agent 执行独立子任务，结果摘要回传到主上下文。用于上下文隔离和复杂任务分解。',
  schema: z.object({
    type: z.enum(['explorer', 'coder', 'reviewer']),
    task: z.string().describe('交给子 agent 的任务描述'),
    context: z.string().optional().describe('传递给子 agent 的背景信息（≤500 tokens）'),
  }),
}
```

**执行流程**：
1. 根据 `type` 选择对应的工具集和 system prompt
2. 创建临时 agent（复用主 agent 的 model 配置，无 checkpointer，无 summarization）
3. 调用 `agent.invoke({ messages: [HumanMessage] })` 执行任务
4. 提取最终 AIMessage 文本作为 tool result 返回给主 agent
5. 子 agent 实例及其消息历史立即丢弃

---

## 子 Agent 配置

### Explorer（只读探索）

| 属性 | 值 |
|------|---|
| 工具集 | `[grep, ls, tree, read_file]` |
| HITL | 无（全只读，不可能触发） |
| middleware | `modelCallLimit(15)` |
| system prompt | "你是代码探索助手，只负责搜索和阅读代码。返回结构化摘要，包含关键发现、相关文件路径和代码片段。" |
| 触发场景 | 主 agent 预估需要 3+ 次文件读取/搜索 |

### Coder（隔离编码）

| 属性 | 值 |
|------|---|
| 工具集 | `[bash, text_editor, grep, ls, tree]` |
| HITL | 内部自决：safe/warning 自动放行，dangerous+ 自动拒绝 |
| middleware | `modelCallLimit(25)` + 内部自决 HITL |
| system prompt | "你是编码助手，负责实现指定的编码任务。遇到被安全策略拒绝的命令时换一种方式。完成后报告变更摘要。" |
| 触发场景 | 涉及 5+ 个工具调用，中间输出会占用大量上下文 |

### Reviewer（审查）

| 属性 | 值 |
|------|---|
| 工具集 | `[bash_readonly, grep, ls, tree]` |
| HITL | 无（bash_readonly 只允许白名单命令） |
| middleware | `modelCallLimit(15)` |
| system prompt | "你是代码审查者，审查变更的 diff 并跑测试。输出审查结论（pass/fail）和具体问题列表。" |
| 触发场景 | 完成重要变更后验证质量 |

---

## Coder 内部 HITL 自决策略

Coder 子 agent 不冒泡审批到主 CLI，而是在 tool 执行层自行决策：

```typescript
// 子 agent 的 HITL middleware 配置
humanInTheLoopMiddleware({
  interruptOn: {
    bash: {
      // 子 agent 收到 interrupt 后，spawn-tool 内部检查 risk level
      // safe/warning → 自动 approve
      // dangerous/critical → 自动 reject，返回错误信息给子 agent
      allowedDecisions: ['approve', 'reject'],
    },
  },
})
```

spawn-tool 内部的 resume 逻辑：
1. 子 agent stream 结束后检查 `state.tasks[0].interrupts`
2. 对 interrupt 中的 bash 命令调用 `assessRisk()`
3. safe/warning → `Command({ resume: [{ type: 'approve' }] })`
4. dangerous/critical → `Command({ resume: [{ type: 'reject' }] })`
5. 子 agent 收到 reject 的 ToolMessage 后会自行调整策略

---

## bash_readonly Tool

Reviewer 专用的受限 bash，通过命令白名单过滤：

```typescript
// src/tools/terminal/bash-readonly.ts
const ALLOWED_COMMANDS = [
  /^\s*git\s+(diff|log|show|status|branch)/,
  /^\s*npm\s+(test|run\s+test|run\s+lint)/,
  /^\s*npx\s+tsc\s+--noEmit/,
  /^\s*npx\s+(jest|vitest|mocha)/,
  /^\s*cat\s/,
  /^\s*head\s/,
  /^\s*wc\s/,
];

// 不在白名单的命令 → 返回错误文本（不抛异常）
// "Command not allowed in readonly mode: <command>"
```

---

## 并行策略

主 agent 可以在同一轮回复中发起多个 `spawn_agent` tool call（LangGraph parallel tool calls）：

- **Explorer × N**：安全并行，只读
- **Reviewer × N**：安全并行，只读
- **Coder × N**：互斥锁，同时只允许 1 个 Coder 执行，其余排队

互斥实现：spawn-tool 内部维护一个模块级 `coderLock: Promise<void>`，后续 Coder 调用 await 前一个完成。

---

## 主 Agent 路由指引

注入到 coding_agent system prompt 尾部：

```markdown
## spawn_agent 使用原则

你可以使用 spawn_agent 工具派生子 agent 执行独立子任务，子 agent 有独立上下文，结果摘要回传。

**何时使用：**
1. 简单任务（改一个函数、加注释）→ 直接用你的工具，不要 spawn
2. 探索性任务（搜索多个文件、理解代码结构）→ spawn explorer
   - 当预估需要 3+ 次文件读取/搜索时
   - 当搜索结果可能很长但你只需要摘要时
3. 复杂编码（多文件修改、需要反复调试）→ spawn coder
   - 当任务涉及 5+ 个工具调用时
   - 当中间输出（编译错误、测试日志）会占用大量上下文时
4. 代码审查（变更后验证质量）→ spawn reviewer
   - 完成重要变更后自动触发

**注意：**
- 子 agent 看不到你的对话历史，你需要通过 context 参数传递必要背景
- 子 agent 返回的是摘要文本，你基于摘要决定下一步
- 可以并行 spawn 多个 explorer，但 coder 同时只能有 1 个
```

---

## CLI 集成（app.tsx 改动）

改动极小：
- spawn_agent 作为普通 tool，其 tool_call 在 UI 中显示为 `[spawn_agent] type=explorer, task="..."`
- 子 agent 执行期间，主 agent 流处于等待状态（正常的 tool 执行等待）
- ToolMessage 返回后，摘要文本在 UI 中渲染为普通 tool result

无需新 UI 组件、无需修改 StreamRenderer、无需修改 HITL 审批 UI。

---

## 文件结构

```
src/
├── agents/
│   ├── coding-agent.ts              # 主 agent（tools 加入 spawnAgentTool）
│   └── sub-agents/
│       ├── types.ts                 # SubAgentType, SubAgentConfig
│       ├── configs.ts               # explorer/coder/reviewer 配置（工具集、prompt、middleware）
│       ├── create.ts                # createSubAgent() 工厂函数
│       └── spawn-tool.ts            # spawn_agent tool 定义 + Coder HITL 自决逻辑
├── tools/
│   └── terminal/
│       ├── tool.ts                  # 现有 bashTool
│       ├── bash.ts                  # 现有 BashTerminal
│       └── bash-readonly.ts         # 新增：Reviewer 专用只读 bash
```

---

## 实施路径

### Phase 1：基础设施 + Explorer

1. 创建 `src/agents/sub-agents/` 目录结构
2. 实现 `types.ts`（类型定义）
3. 实现 `create.ts`（createSubAgent 工厂）
4. 实现 `spawn-tool.ts`（spawn_agent tool 基础框架）
5. 实现 Explorer 配置（只读工具集 + prompt）
6. 主 agent tools 列表加入 spawnAgentTool
7. 主 agent system prompt 加入路由指引
8. 验证 Explorer 端到端工作

### Phase 2：Coder + 内部 HITL

9. 实现 Coder 配置（全工具集 + prompt）
10. 实现 Coder 内部 HITL 自决逻辑（spawn-tool 内的 interrupt 检测 + 自动 approve/reject）
11. 实现 Coder 互斥锁
12. 验证 Coder 端到端工作（含 dangerous 命令自动拒绝场景）

### Phase 3：Reviewer + bash_readonly

13. 实现 `bash-readonly.ts`（命令白名单过滤）
14. 实现 Reviewer 配置（bash_readonly + prompt）
15. 验证 Reviewer 端到端工作

### Phase 4：优化

16. 主 agent 完成重要变更后自动 spawn reviewer（prompt 引导）
17. Explorer 并行 spawn 验证
18. 错误处理：子 agent 超时/失败时返回有意义的错误摘要
19. 日志：子 agent 执行过程写入 debug 日志（方便排查）

---

## 边界与约束

- 子 agent 不持久化（无 checkpointer），执行完即丢弃
- 子 agent 不继承主 agent 的 todoListMiddleware 和 summarizationMiddleware
- 子 agent 共享文件系统，Coder 写入的文件修改立即对主 agent 可见
- spawn_agent 的 tool 执行超时跟随主 agent 的 recursionLimit（不单独设超时）
- 子 agent 的 modelCallLimit 是硬上限（Explorer/Reviewer 15 次，Coder 25 次）
