# Rune Code Node 上下文管理实现

本文档详细解析 Agent 对话历史的上下文管理策略 —— 如何防止 context window 溢出、维持前缀缓存命中率、在长对话中保持响应质量。

## 1. 问题背景

Agent 的对话历史是无限增长的：

```
每一轮对话 = HumanMessage + AIMessage + ToolMessage × N + ...
                    ↓
         MemorySaver checkpoint 持久化
                    ↓
        永不裁剪 → tokens 持续增长 → 超过 LLM context window → API 400
        或者 window 没超但前缀缓存被频繁变动的内容挤掉 → 成本飙升
```

**核心矛盾**：既要保留足够的上下文让 LLM 理解当前任务，又要限制总 token 数以控制延迟和成本。

## 2. 三层策略

```
┌──────────────────────────────────────────────────┐
│ Layer 1: 摘要中间件 (summarizationMiddleware)      │
│   触发条件: tokens > 4000 && messages > 8         │
│       或: tokens > 8000 && messages > 6          │
│   动作: 压缩旧消息为 SystemMessage 摘要             │
│   保留: 最近 20 条消息原文                          │
└──────────────────────┬───────────────────────────┘
                       │
┌──────────────────────▼───────────────────────────┐
│ Layer 2: 前缀缓存友好布局                           │
│   [System Prompt + Tools] ← 静态，始终命中缓存       │
│   [Summary Message]       ← 半静态，偶尔变动         │
│   [Recent 20 messages]    ← 动态，频繁变动          │
└──────────────────────┬───────────────────────────┘
                       │
┌──────────────────────▼───────────────────────────┐
│ Layer 3: UI 上下文用量指示器                        │
│   Context: 4.2Kt · 14 msgs · ██████░░░░ 60%       │
│   颜色分级: green(<60%) → yellow(<85%) → red(>85%) │
└──────────────────────────────────────────────────┘
```

## 3. Layer 1: 摘要中间件

### 3.1 触发条件

使用 `fraction`（上下文窗口占比）而非硬编码 token 数，自适应不同模型：

```
触发 = (≥15% 窗口 AND ≥10 条消息) OR (≥25% 窗口 AND ≥6 条消息)
```

| 模型 | Context | 触发 A (15% + 10msgs) | 触发 B (25% + 6msgs) |
|------|---------|----------------------|----------------------|
| GPT-4o | 128K | ~19K tokens | ~32K tokens |
| DeepSeek V3 | 128K | ~19K tokens | ~32K tokens |
| Claude Sonnet | 200K | ~30K tokens | ~50K tokens |
| Doubao Lite | ~32K | ~4.8K tokens | ~8K tokens |

**为什么用 `fraction` 而非 `tokens`？**

- `tokens: 4000` 在 128K 模型上只占 3%，触发过于频繁；在 8K 模型上占 50%，触发太迟
- `fraction: 0.15` 随模型自动缩放，一次配置适用所有模型
- 调整阈值只需改比例，不用查模型文档

**为什么每个触发器同时要求消息数（AND）？**

防止误触发：用户粘贴一段长代码（单条 HumanMessage 就几万 tokens），但对话刚开始。此时不应该摘要——模型需要这段代码的完整上下文。加上 `messages` 条件确保只有真正的"长对话"才触发。

### 3.2 配置

```typescript
// src/agents/coding-agent.ts
summarizationMiddleware({
    model,                                       // 复用主模型做摘要
    trigger: [
        { fraction: 0.15, messages: 10 },        // 多轮对话，15% 窗口
        { fraction: 0.25, messages: 6 },         // 少量超长消息，25% 窗口
    ],
    keep: { messages: 24 },                      // 保留最近 24 条原文
})
```

### 3.3 摘要执行流程

```
1. middleware 在每个 model call 前检查 message 列表
2. 如果满足 trigger 条件:
   a. 从消息列表中取出超过 keep 范围的部分
   b. 调用 LLM 生成摘要: "请总结以下对话的关键信息..."
   c. 将摘要包装为 SystemMessage
   d. 消息列表变为: [SystemPrompt, SummarySystemMessage, ...recent 20 messages]
3. 后续 model call 使用压缩后的消息列表
```

### 3.4 设计决策

**为什么 keep 24 条而不是更多或更少？**

- 24 条 ≈ 6-10 轮工具调用对话，足以覆盖当前子任务的完整上下文
- 太少了（<12）：摘要后的上下文不够精细，模型容易漏掉细节
- 太多了（>36）：压缩效果不明显，token 仍然较多

**为什么用双触发器而不是单阈值？**

单阈值 `fraction > 0.15` 的问题：
- 如果用户发长段代码粘贴，占比瞬间飙升但消息数很少 → 此时触发摘要反而干扰当前任务
- 双触发器通过 AND 关系避免这种误触发：消息数也成为必要条件

**为什么用主模型做摘要而不是用更便宜的模型？**

- 简洁优先：不需要额外配置 API key
- 摘要调用频率极低（每 10+ 轮才触发一次），成本差异可忽略
- 主模型对自身输出的理解最好，摘要质量高

## 4. Layer 2: 前缀缓存布局

LLM API 的前缀缓存机制：如果请求的前缀与之前相同，API 会跳过前缀部分的推理，只处理新增内容。

```
┌──────────────────────────────────┐
│ System Prompt (coding_agent.md)  │ ← 完全静态，100% 缓存命中
│ Tool Definitions (schema)        │
├──────────────────────────────────┤ ← 缓存断点
│ TodoList System Prompt (注入)     │ ← 偶尔变动（todos 状态变化时）
│ Summary (如果有)                  │ ← 偶尔变动
├──────────────────────────────────┤ ← 缓存断点
│ Recent Messages                  │ ← 频繁变动，每次 model call 都在变
│ User's new message               │
└──────────────────────────────────┘
```

**关键设计**：
- System Prompt + Tool Definitions 放最前面，永远不变 → 始终命中缓存 → 省时间、省成本
- 摘要放在中间，只在触发生效时才变 → 缓存失效范围最小
- 新消息在末尾，频繁变动 → 只有这部分无法缓存，但这是必需的

**缓存命中率估算**：

| 对话阶段 | 命中率 | 说明 |
|---------|--------|------|
| 短对话（<6轮） | ~40% | 消息本身变化多，但 system prompt 占比大 |
| 中对话（6-15轮） | ~60% | 摘要未触发，system+tools 稳定命中 |
| 长对话（>15轮） | ~70% | 摘要生成后稳定，recent messages 占比高 |

## 5. Layer 3: UI 指示器

```
Context: 4.2Kt · 14 msgs · ██████░░░░ 60%
         ↑              ↑            ↑
      token 数      消息数量      使用率进度条
```

**颜色语义**：

| 使用率 | 颜色 | 含义 |
|--------|------|------|
| < 30% | green | 轻量，接近新对话 |
| 30-60% | green | 正常范围 |
| 60-85% | yellow | 较高，摘要即将或已触发 |
| > 85% | red | 临界，需关注 |

**实现位置**：ChatView 底部，流式输出结束后显示。

## 6. Token 计数工具

文件：[src/utils/token-counter.ts](src/utils/token-counter.ts)

```typescript
import { countTokensApproximately } from 'langchain';

// 使用 LangChain 内置的近似算法 (字符数 / 4)
export function estimateTokens(messages: BaseMessage[]): number

// 估算使用率 (0-1)
export function estimateContextUsage(messages: BaseMessage[]): number

// 是否超过安全阈值
export function isContextOverloaded(messages: BaseMessage[]): boolean

// 格式化显示
export function formatTokens(tokens: number): string

// 完整摘要
export function getContextSummary(messages: BaseMessage[]): ContextSummary
```

使用 `/4` 近似而不是 `tiktoken` 精确计算的原因：
- 不需要额外的 tokenizer 依赖
- 对中文友好（`字符/4` ≈ `字符*0.25`，中文约 1.5-2 token/字，英文约 0.25-0.3 token/字）
- 摘要中间件只在判断触发条件时需要精度，`/4` 足够

## 7. 边界情况

| 场景 | 处理方式 |
|------|---------|
| 摘要触发时正在 HITL 中断 | 不影响，摘要只压缩已完成的消息，中断中状态独立 |
| 摘要后 TodoList 状态 | 不丢失，todos 在 state 中独立于 messages |
| 流式输出中触发 | 不可能，摘要在 model call 前检查 |
| 首轮对话就超限（超长 system prompt） | 不会触发，摘要需要 messages > 6/8 |
| 摘要模型调用失败 | middleware 内置降级，失败时跳过摘要继续执行 |

## 8. 关键文件

| 文件 | 职责 |
|------|------|
| `src/agents/coding-agent.ts` | 启用 `summarizationMiddleware`，配置 trigger/keep |
| `src/utils/token-counter.ts` | token 估算、使用率计算、格式化 |
| `src/cli/app.tsx` | 每轮末尾计算 `contextSummary` 并传递给 UI |
| `src/cli/components/chat-view.tsx` | 底部渲染上下文用量指示器 |

---

*最后更新：2026-05-31*
