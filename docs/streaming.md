# Rune Code Node 流式输出实现原理

本文档详细解析 CLI 中 token 级流式输出的设计方案、数据流与核心实现。

## 1. 问题背景

### 原有实现

原始代码使用 LangGraph 的 `streamMode: 'updates'`：

```typescript
const stream = await agent.stream(input, {
    streamMode: 'updates',  // 节点级批量
    configurable: { thread_id: '1' },
});

for await (const chunk of stream) {
    // chunk = { nodeName: { messages: [...完整消息] } }
    for (const [nodeName, nodeUpdate] of Object.entries(chunk)) {
        setMessages((prev) => [...prev, ...nodeUpdate.messages]);
    }
}
```

**问题**：`updates` 模式在一个节点（如 `model_request`）完全执行完毕后，才将完整消息一次性吐出。用户在 LLM 生成期间只能看到空白，然后所有文本瞬间出现——没有"正在输入"的体验。

### 改造目标

- LLM 每生成一个 token，终端立即显示
- 工具调用信息在流结束后正确合并展示
- 保持 HITL 中断确认、Todo 同步等既有功能不受影响

## 2. LangGraph 流模式对比

| 模式 | 粒度 | chunk 结构 | 适用场景 |
|------|------|-----------|---------|
| `values` | 状态快照 | 完整 state | 状态监听 |
| `updates` | 节点级 | `{ nodeName: { ... } }` | 节点完成后回调 |
| `messages` | token 级 | `[Message, Metadata]` | **流式 UI 渲染** |

`messages` 模式下，每个 chunk 是一个二元组 `[message, metadata]`：

```typescript
// LLM token
[AIMessageChunk { content: "Hello" }, { langgraph_node: "model_request" }]

// Tool result
[ToolMessage { content: "...", tool_call_id: "..." }, { langgraph_node: "tools" }]
```

关键的 `AIMessageChunk` 结构：

```typescript
class AIMessageChunk {
    content: string;              // 增量文本，每次一个新 token
    tool_call_chunks?: ToolCallChunk[];  // 工具调用的流式片段
}

interface ToolCallChunk {
    name?: string;    // 工具名（仅在首片段出现）
    args?: string;    // JSON 参数字符串的增量片段
    id?: string;      // 调用 ID（仅在首片段出现）
    index?: number;   // 多工具调用时的序号
}
```

## 3. 核心设计：草稿累积模型

### 3.1 整体数据流

```
┌──────────────────────────────────────────────────────────┐
│                    agent.stream()                         │
│                 streamMode: 'messages'                    │
└──────────┬───────────────────────────────┬───────────────┘
           │                               │
           ▼                               ▼
    AIMessageChunk                    ToolMessage
    (token by token)                 (tool result)
           │                               │
           ▼                               ▼
   draftContent += token            commitDraft()
   draftToolCallChunks.push()              │
           │                        ┌──────┴──────┐
           ▼                        │ 合并片段     │
   setStreamingContent()            │ → ToolCall[] │
   → UI 立即重绘                    │ → AIMessage  │
                                    │ → setMessages│
                                    └─────────────┘
```

### 3.2 三个缓冲区的生命周期

在 `runAgent` 函数内部，每次流式交互维护三个局部变量：

```typescript
let draftContent = '';                  // 文本缓冲
let draftToolCallChunks: ToolCallChunk[] = [];  // 工具调用片段缓冲
```

> **为什么用局部变量而非 React state？**
>
> 流式 token 到达频率极高（可达 50-100 次/秒）。若每次都用 `setState` 更新缓冲区，React 批处理会引入延迟和额外渲染开销。用局部变量累积，仅在需要 UI 刷新时通过 `setStreamingContent` 发出当前完整文本。

### 3.3 commitDraft：提交时机

```typescript
const commitDraft = () => {
    if (!draftContent && !draftToolCallChunks.length) return;

    const mergedCalls = mergeToolCallChunks(draftToolCallChunks);
    const aiMsg = new AIMessage({
        content: draftContent || '',
        tool_calls: mergedCalls.length > 0 ? mergedCalls : undefined,
    });

    // 从合并后的工具调用中提取 todo 更新
    for (const tc of mergedCalls) {
        if (tc.name === 'todo_write' && tc.args?.todos) {
            setTodos(tc.args.todos);
        }
    }

    setMessages((prev) => [...prev, aiMsg]);
    draftContent = '';
    draftToolCallChunks = [];
    setStreamingContent('');  // 清空流式显示
};
```

**提交时机有两个**：

| 时机 | 触发条件 | 说明 |
|------|---------|------|
| 工具结果到达 | `ToolMessage.isInstance(msg)` | LLM 完成文本+工具调用 → 工具已执行 → 提交前一个 AI 消息 |
| 流结束 | `for await` 循环退出 | 最后一轮 AI 回复（无工具调用或对话结束）→ 提交残余草案 |

```
时间线示例：
  User: "列出文件"
  → AIMessageChunk("我") → draftContent = "我"
  → AIMessageChunk("来") → draftContent = "我来"
  → AIMessageChunk("列出") → draftContent = "我来列出"
  → ... 更多 token ...
  → AIMessageChunk(tool_call: ls) → draftToolCallChunks = [...]
  → ToolMessage(ls result) → commitDraft() ✅
  → AIMessageChunk("当前目") → draftContent = "当前目"
  → ... 流结束 ...
  → commitDraft() ✅
```

## 4. 工具调用片段合并

### 4.1 为什么需要合并

OpenAI 兼容的流式 API 将工具调用拆分成多个 `ToolCallChunk`：

```
Chunk 1: { index: 0, name: "bash", id: "call_001" }
Chunk 2: { index: 0, args: '{"comma' }
Chunk 3: { index: 0, args: 'nd":"ls' }
Chunk 4: { index: 0, args: ' -la"}' }
```

需要按 `index` 分组合并，并将 JSON args 字符串累积后解析为对象。

### 4.2 mergeToolCallChunks 实现

```typescript
function mergeToolCallChunks(chunks: ToolCallChunk[]): ToolCall[] {
    const merged: Record<number, { name: string; args: string; id: string }> = {};

    for (const chunk of chunks) {
        const idx = chunk.index ?? 0;
        if (!merged[idx]) {
            merged[idx] = {
                name: chunk.name ?? '',
                args: chunk.args ?? '',
                id: chunk.id ?? '',
            };
        } else {
            if (chunk.args) merged[idx].args += chunk.args;      // args 拼接
            if (chunk.name && !merged[idx].name) merged[idx].name = chunk.name;
            if (chunk.id && !merged[idx].id) merged[idx].id = chunk.id;
        }
    }

    return Object.values(merged).map(
        (tc): ToolCall => ({
            name: tc.name,
            args: JSON.parse(tc.args),   // 累积完成后一次性解析
            id: tc.id || undefined,
            type: 'tool_call' as const,
        }),
    );
}
```

**设计要点**：

- `index` 区分多工具调用（如同时调 bash + grep），不同 index 的片段互不干扰
- `name` 和 `id` 只在首个 chunk 出现，后续 chunk 用已有值
- `args` 是 JSON 字符串的增量拼接，最后一次性 `JSON.parse`
- 若 parse 失败（理论上不会），降级为空对象 `{}`

## 5. UI 渲染

### 5.1 ChatView 的三态显示

```typescript
{streamingContent ? (
    // 状态 1：正在流式输出 — 实时显示文本 + 光标
    <Box flexDirection="column" marginTop={1}>
        <Text color="green" bold>Rune</Text>
        <Text wrap="wrap">
            {streamingContent}
            <Text color="green">▊</Text>  {/* 闪烁光标效果 */}
        </Text>
    </Box>
) : isGenerating ? (
    // 状态 2：等待首 token — 显示 Spinner
    <Box flexDirection="column" marginTop={1}>
        <Text color="gray">
            <Spinner type="dots" /> Working
        </Text>
    </Box>
) : null}
```

| 状态 | 条件 | 显示 |
|------|------|------|
| 流式输出中 | `streamingContent` 非空 | 实时文本 + `▊` 光标 |
| 等待首 token | `isGenerating` 且 `streamingContent` 为空 | `⠋ Working` 动画 |
| 空闲 | 两者皆空 | 不显示 |

### 5.2 状态流转

```
handleSubmit()
  → setIsGenerating(true)              [状态: Spinner]
  → agent.stream()
  → 首个 AIMessageChunk
    → setStreamingContent("Hello")     [状态: 流式文本]
  → 更多 token 到达...
    → setStreamingContent("Hello wo...") [状态: 持续更新]
  → ToolMessage 到达
    → commitDraft() → setStreamingContent('')
                                       [状态: Spinner（若未结束）]
  → 流结束
    → commitDraft()
    → finally: setIsGenerating(false)
       setStreamingContent('')         [状态: 空闲]
```

## 6. 类型系统

整个流式输出链路使用了 LangChain 提供的精确类型，零 `any`：

```typescript
import {
    AIMessage, AIMessageChunk, BaseMessage,
    HumanMessage, ToolCall, ToolCallChunk, ToolMessage
} from '@langchain/core/messages';
import { Command, StateSnapshot } from '@langchain/langgraph';

// 流式输入可能是新对话或是中断恢复
const runAgent = async (input: { messages: BaseMessage[] } | Command) => {
    // 本地缓冲使用明确的 LangChain 类型
    let draftContent = '';
    let draftToolCallChunks: ToolCallChunk[] = [];

    // 合并函数签名完全类型化
    function mergeToolCallChunks(chunks: ToolCallChunk[]): ToolCall[] { ... }
};
```

| 类型 | 来源 | 用途 |
|------|------|------|
| `AIMessageChunk` | `@langchain/core/messages` | `isInstance` 判定流式 token |
| `ToolCallChunk` | `@langchain/core/messages` | 工具调用片段缓冲 |
| `ToolCall` | `@langchain/core/messages` | 合并后的完整工具调用 |
| `ToolMessage` | `@langchain/core/messages` | `isInstance` 判定工具结果 |
| `StateSnapshot` | `@langchain/langgraph` | `getState()` 返回值 |

## 7. 与 HITL 中断的协作

流式输出与 Human-in-the-Loop 中断的交互流程：

```
User: "删掉临时文件"
  → LLM 流式输出: "我来帮你删除..."
  → AIMessageChunk(tool_call: bash "rm -rf /tmp/*")
  → setStreamingContent 显示文本
  → 流暂停（中断点）
  → commitDraft() 提交包含 tool_call 的 AIMessage
  → agent.getState() 检测到 interrupt
  → isDangerous = true → setInterruptInfo(...)
  → UI 显示审批弹窗，覆盖输入框
  → 用户选择 Approve
  → handleResume("approve")
    → runAgent(Command { resume: ... })
    → 新流继续：ToolMessage(执行结果) → AI 后续回复
```

关键点：`commitDraft()` 在 `for await` 循环结束后、中断检查之前调用，确保 AI 的"计划"（包括危险工具调用）已写入消息历史。

## 8. 边界情况处理

### 8.1 首 token 延迟

LLM 从收到请求到生成首 token 可能需要数秒。此时 `draftContent` 为空、`isGenerating` 为 true → UI 显示 Spinner 而非空白，避免用户误以为卡死。

### 8.2 仅有工具调用无文本

某些场景下 LLM 直接发起工具调用（如 "list files" → `ls`），`draftContent` 为空但 `draftToolCallChunks` 有数据。`commitDraft` 的条件 `!draftContent && !draftToolCallChunks.length` 保证不会丢失纯工具调用消息。

### 8.3 流异常中断

`finally` 块中强制清理：

```typescript
finally {
    setIsGenerating(false);
    setStreamingContent('');
}
```

确保即使抛出异常，UI 也不会卡在"生成中"状态。

### 8.4 连续多轮对话

每次 `runAgent` 调用都创建独立的 `draftContent` 和 `draftToolCallChunks`，互不污染。`handleSubmit` 和 `handleResume`/`autoResume` 分别以不同入参调用同一个 `runAgent`，复用同一套流式逻辑。

## 9. 关键文件

| 文件 | 职责 |
|------|------|
| `src/cli/app.tsx` | 流式数据源：`streamMode: 'messages'`、草稿累积、`commitDraft`、中断检测 |
| `src/cli/components/chat-view.tsx` | 流式渲染：三态显示、`streamingContent` prop、光标动画 |

---

*最后更新：2026-05-31*
