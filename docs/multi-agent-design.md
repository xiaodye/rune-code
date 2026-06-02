# Multi-Agent 架构设计

## 现状

单 agent 架构：一个 `coding-agent` 持有所有工具（bash、grep、ls、tree、text-editor、MCP），单 thread 跑到底。

**问题**：

- 上下文膨胀快 — 搜索结果、文件内容、命令输出全部堆积在同一个窗口
- 不同类型任务互相干扰 — 探索阶段的大量中间信息污染后续编码阶段
- 无法并行 — 复杂任务只能串行执行，效率低

## 目标架构：单主 Agent + 按需子 Agent

参考 Claude Code 验证过的模式：主 agent 保持全能，遇到需要上下文隔离的子任务时按需 spawn 子 agent。

```
┌─────────────────────────────────────────────┐
│            Main Agent (全工具)                │
│                                              │
│  简单任务 → 直接执行                          │
│  探索任务 → spawn Explorer (只读，摘要回传)    │
│  复杂任务 → spawn Coder (隔离上下文)          │
│  审查任务 → spawn Reviewer (diff + test)     │
└─────────────────────────────────────────────┘
```

**核心思路**：不引入额外的路由层，主 agent 自己决定何时需要子 agent。

## 与 Supervisor 架构的对比

| 维度 | Supervisor (之前的设计) | 单主 Agent + 子 Agent (当前方案) |
|------|------------------------|--------------------------------|
| 路由 | 独立 Orchestrator LLM 显式路由 | 主 agent 自主决定（隐式） |
| 简单任务开销 | 多一轮路由 call（~1-2s） | 零开销，直接执行 |
| 上下文隔离 | specialist 有持久 scratchpad | 子 agent 用完即弃，摘要回传 |
| 复杂度 | StateGraph 多节点 + channel 设计 | 主 agent 加一个 spawn_agent tool |
| 参考实现 | LangGraph multi-agent 模板 | Claude Code / Cursor |

## 子 Agent 类型定义

### Explorer（只读探索）

**触发场景**：主 agent 需要大量搜索/阅读代码但不想污染主上下文

```typescript
interface ExplorerConfig {
  tools: ['grep', 'ls', 'tree', 'read_file'];
  systemPrompt: '你是代码探索助手，只负责搜索和阅读代码，返回结构化摘要。';
  returnFormat: {
    summary: string;       // ≤200 tokens 的自然语言摘要
    files: string[];       // 相关文件路径
    codeSnippets?: string; // 关键代码片段
  };
}
```

**示例**：用户说"帮我理解这个项目的认证流程"，主 agent spawn Explorer 去搜索 auth 相关代码，Explorer 返回摘要，主 agent 基于摘要回答用户。

### Coder（隔离编码）

**触发场景**：复杂编码任务，中间过程会产生大量工具调用输出

```typescript
interface CoderConfig {
  tools: ['bash', 'text_editor', 'grep', 'ls', ...mcpTools];
  systemPrompt: '你是编码助手，负责实现指定的编码任务。完成后返回变更摘要。';
  returnFormat: {
    summary: string;         // 做了什么
    filesChanged: string[];  // 改了哪些文件
    testsPassed: boolean;    // 测试是否通过
  };
  hitl: true; // 继承 danger-engine 审批
}
```

### Reviewer（审查）

**触发场景**：代码变更完成后，需要独立视角审查质量

```typescript
interface ReviewerConfig {
  tools: ['bash_readonly', 'grep', 'git_diff'];
  systemPrompt: '你是代码审查者，审查 diff 并跑测试，输出 pass/fail 和问题列表。';
  returnFormat: {
    verdict: 'pass' | 'fail';
    issues: Array<{ file: string; line: number; description: string }>;
    testResults?: string;
  };
}
```

## spawn_agent Tool 设计

主 agent 通过一个统一的工具来派生子 agent：

```typescript
{
  name: 'spawn_agent',
  description: '派生子 agent 执行独立任务，结果摘要回传到主上下文',
  parameters: {
    type: {
      enum: ['explorer', 'coder', 'reviewer'],
      description: '子 agent 类型',
    },
    task: {
      type: 'string',
      description: '交给子 agent 的任务描述',
    },
    context: {
      type: 'string',
      description: '传递给子 agent 的背景信息（≤500 tokens）',
    },
  },
}
```

**关键行为**：
- 子 agent 有独立的消息历史，不与主 agent 共享
- 子 agent 执行完毕后，只有返回的摘要进入主 agent 上下文
- 子 agent 的工具调用输出、中间推理过程全部丢弃
- 主 agent 可以基于摘要决定是否需要再次 spawn

## 路由策略

主 agent 的 system prompt 中包含路由指引：

```
你可以使用 spawn_agent 工具派生子 agent 来执行子任务。使用原则：

1. 简单任务（改个函数、加个注释）→ 直接用自己的工具执行，不要 spawn
2. 探索性任务（理解代码结构、搜索多个文件）→ spawn explorer
   - 当预估需要 3+ 次文件读取/搜索时
   - 当搜索结果可能很长但你只需要摘要时
3. 复杂编码（多文件修改、需要反复调试）→ spawn coder
   - 当任务涉及 5+ 个工具调用时
   - 当中间输出（编译错误、测试日志）会占用大量上下文时
4. 代码审查（变更后验证质量）→ spawn reviewer
   - 完成重要变更后自动触发
```

## 实现方案

### 在 LangGraph 中的实现

子 agent 不需要独立的 graph 节点。通过 tool 内部实现：

```typescript
// src/tools/agent/spawn.ts
async function spawnAgent(params: SpawnParams): Promise<string> {
  const { type, task, context } = params;
  const config = agentConfigs[type];

  // 创建临时 agent（独立 LLM 实例 + 独立消息历史）
  const subAgent = await createSubAgent({
    tools: config.tools,
    systemPrompt: config.systemPrompt,
  });

  // 执行任务
  const result = await subAgent.invoke({
    messages: [new HumanMessage(`${context}\n\n任务：${task}`)],
  });

  // 只返回最终回复文本（摘要），中间过程丢弃
  return extractFinalResponse(result);
}
```

### 文件结构

```
src/
├── agents/
│   ├── coding-agent.ts          # 主 agent（现有，增加 spawn_agent tool）
│   └── sub-agents/
│       ├── types.ts             # SubAgentConfig 类型定义
│       ├── explorer.ts          # Explorer 配置 + prompt
│       ├── coder.ts             # Coder 配置 + prompt
│       ├── reviewer.ts          # Reviewer 配置 + prompt
│       └── spawn.ts             # spawn_agent tool 实现
```

## 实施路径

### Phase 1：基础设施

1. 实现 `spawn_agent` tool 框架（spawn、执行、摘要回传）
2. 实现 Explorer 子 agent（最简单，只读工具）
3. 主 agent prompt 加入路由指引
4. 验证上下文隔离效果

### Phase 2：Coder 子 agent

5. 实现 Coder 子 agent（继承 HITL 审批）
6. 处理子 agent 中的 HITL 中断（事件冒泡到主 CLI）
7. 文件变更同步（子 agent 改了文件，主 agent 需要知道）

### Phase 3：Reviewer + 自动化

8. 实现 Reviewer 子 agent
9. 主 agent 在重要变更后自动 spawn reviewer
10. 子 agent 失败重试机制

### Phase 4：优化

11. 子 agent 结果缓存（相同探索任务不重复执行）
12. 并行 spawn（同时派多个 explorer 搜不同方向）
13. 流式输出透传（子 agent 执行时主 CLI 显示进度）

## 取舍分析

| 维度 | 收益 | 代价 |
|------|------|------|
| 上下文利用率 | 搜索/编译输出不进主上下文，窗口更干净 | 子 agent 也消耗 token（独立 call） |
| 简单任务延迟 | 零开销，直接执行 | — |
| 复杂任务质量 | 隔离后各阶段上下文更聚焦 | 总 token 消耗增加 ~15-30% |
| 实现复杂度 | 一个 tool 搞定，不需要 StateGraph 重构 | 子 agent HITL 冒泡需要额外处理 |
| 可维护性 | 渐进式，不破坏现有架构 | 子 agent prompt 需要独立维护 |

## 与其他架构的关系

本方案是渐进式的。如果后续发现需要更强的协调能力（比如 Coder↔Reviewer 多轮迭代），可以在此基础上升级为 Supervisor 模式——把 spawn_agent 替换为 StateGraph 路由，子 agent 配置复用。
