# Rune Code TodoList 实现原理

本文档详细解析 Agent TodoList 功能的设计原理、数据流与核心实现。

## 1. 设计目标

让 LLM 在处理复杂多步任务时具备"记忆"能力 —— 规划步骤、跟踪进度、向用户展示当前状态。终端 UI 实时渲染任务列表，类似 IDE 中的任务面板。

## 2. 核心架构：全量替换 + 状态注入

这是业界标准模式（Claude Code、Cline、Aider 均采用）：

```
                        ┌─────────────────────┐
                        │    System Prompt     │
                        │  + TODO_USAGE_RULES  │  ← 使用说明（静态）
                        │  + Current Todo List │  ← 当前状态（动态注入）
                        └──────────┬──────────┘
                                   │
                                   ▼
┌──────────┐  tool_call   ┌───────────────┐  Command  ┌─────────┐
│   LLM    │─────────────▶│ todoListMiddleware │─────────▶│  State  │
│          │  todo_write  │               │  update   │  todos  │
└──────────┘              └───────┬───────┘           └────┬────┘
                                  │                        │
                                  │ ToolMessage            │ setTodos()
                                  ▼                        ▼
                            ┌──────────┐            ┌──────────────┐
                            │  Stream  │            │  TodoListView │
                            └──────────┘            └──────────────┘
```

**为什么是全量替换而非增量？**

- LLM 每次调用是无状态的，增量操作（add/update/delete）需要模型记住之前的 ID，容易出错
- 全量替换让模型每次输出完整列表，幂等且可靠
- 状态注入到 prompt 后，模型天然"看到"最新状态

## 3. 数据结构

```typescript
enum TodoStatus {
    pending = 'pending', // ○ 待处理
    in_progress = 'in_progress', // ▶ 进行中
    completed = 'completed', // ✓ 已完成
    cancelled = 'cancelled', // ✗ 已取消
}

interface TodoItem {
    id: number; // 唯一标识，模型生成
    title: string; // 任务标题
    priority: 'low' | 'medium' | 'high'; // 优先级
    status: TodoStatus; // 当前状态
}
```

- `id` 由模型自行分配（通常是 0, 1, 2, ...），不需要全局唯一，只在单次 `todo_write` 调用内区分
- `priority` 目前仅在 UI 显示，未用于排序或逻辑控制

## 4. 核心实现

### 4.1 中间件层：`todoListMiddleware`

文件：[src/middlewares/todo-list.ts](src/middlewares/todo-list.ts)

中间件做了两件事：

**A. 注册 `todo_write` 工具**

```typescript
const todoWriteTool = tool(
    async ({ todos }, config) => {
        // 统计未完成任务数
        const unfinishedTodos = todos.filter(
            (todo) => todo.status !== 'completed' && todo.status !== 'cancelled',
        );

        // 通过 Command 同时更新 state 和返回 ToolMessage
        return new Command({
            update: {
                todos, // 更新 state.todos
                messages: [
                    new ToolMessage({
                        content: `成功更新 ${todos.length} 项，${unfinishedTodos.length} 项未完成`,
                        tool_call_id: config.toolCall?.id || '',
                        name: 'todo_write',
                    }),
                ],
            },
        });
    },
    {
        name: 'todo_write',
        description: '更新整个 TODO 列表',
        schema: z.object({
            todos: z.array(
                z.object({
                    id: z.number().min(0),
                    title: z.string().min(1),
                    priority: z.enum(['low', 'medium', 'high']).default('medium'),
                    status: z
                        .enum(['pending', 'in_progress', 'completed', 'cancelled'])
                        .default('pending'),
                }),
            ),
        }),
    },
);
```

关键设计：

- 返回 `Command` 而非纯文本 —— 同时更新 `state.todos` 和消息列表
- `config.toolCall?.id` 关联 ToolMessage 到工具调用，满足 LLM API 的 tool_call_id 匹配要求
- 反馈信息包含统计摘要，提醒模型还有多少任务未完成

**B. `wrapModelCall` 注入状态到 Prompt**

```typescript
wrapModelCall: (request, handler) => {
    const todos = request.state.todos;
    let todoSP = '';

    if (todos.length > 0) {
        const todoListString = todos
            .map((t) => `- [${t.status === 'completed' ? 'x' : ' '}] ${t.title} (${t.status})`)
            .join('\n');
        todoSP += `\n\n当前 Todo 列表:\n${todoListString}`;
    }

    return handler({
        ...request,
        systemMessage: request.systemMessage
            .concat(`\n\n${TODO_LIST_SYSTEM_PROMPT}`)  // 追加使用说明
            .concat(todoSP),                            // 追加当前列表
    });
},
```

关键设计：

- 每次模型调用前动态拼接，不修改原始 system prompt
- 使用类似 Markdown 的 `- [x]` / `- [ ]` 格式，LLM 易于理解
- 仅在 `todos.length > 0` 时才追加列表，减少无意义的 token 消耗

### 4.2 Agent 注册

文件：[src/agents/coding-agent.ts](src/agents/coding-agent.ts)

```typescript
const codingAgent = createAgent({
    model,
    tools,          // bash, grep, ls, tree, text_editor, mcp tools
    systemPrompt,   // 基础 coding_agent 提示词
    middleware: [
        todoListMiddleware(),     // ← 注册 todo 中间件
        humanInTheLoopMiddleware({ interruptOn: { bash: { ... } } }),
    ],
    checkpointer,
});
```

`todoListMiddleware` 排在第一位，这样它的 `wrapModelCall` 最先执行，后续中间件（如 HITL）也能看到已注入的 todo 信息。

### 4.3 UI 渲染

文件：[src/cli/components/todo-list-view.tsx](src/cli/components/todo-list-view.tsx)

```
┌─ To-do List ─────────────────┐
│                               │
│ ○ [medium] 分析项目结构       │
│ ▶ [high]   实现用户认证       │
│ ✓ [low]    添加 README       │
│ ✗ [medium] 配置 CI/CD        │
│                               │
└───────────────────────────────┘
```

- 四态视觉：`○` pending（白）/ `▶` in_progress（黄）/ `✓` completed（绿）/ `✗` cancelled（红）
- 紫色圆角边框（`magenta`），与 message 区域区分
- 仅在 `todos.length > 0` 时显示，空列表不占空间

### 4.4 数据同步

文件：[src/cli/app.tsx](src/cli/app.tsx)

Todo 数据有两条路径进入 UI：

| 路径     | 代码位置                                                    | 时机               |
| -------- | ----------------------------------------------------------- | ------------------ |
| 流式提取 | `commitDraft()` 解析 `todo_write` tool_call 的 `args.todos` | 流式过程中，即时   |
| 状态兜底 | 每轮末尾 `agent.getState()` → `setTodos(state.todos)`       | 流结束后，保证完整 |

双路径的原因：`todo_write` 通过中间件 `Command` 直接写 state，其 ToolMessage 不会出现在 `streamMode: 'messages'` 的 stream 中。末尾的 `getState()` 确保即使流式提取漏了，最终状态也是完整的。

## 5. Prompt 设计

`TODO_LIST_SYSTEM_PROMPT` 包含三个核心部分：

**使用时机（When to Use）**：

- 需要 3 步以上的复杂任务
- 用户直接要求使用 todo list
- 任务可能需要根据中间结果调整计划

**不用时机（When to Not Use）**：

- 单步简单任务
- 纯对话/信息咨询
- 3 步以内能完成的琐碎操作

**关键规则**：

- 不要并行调用 `todo_write`（避免竞态）
- 完成一步立即标记，不要批量标记
- 根据新信息随时修订 todo 列表

## 6. 数据流示例

以"添加用户登录功能"为例：

```
User: "添加用户登录功能"

Step 1 — 模型创建计划
  AIMessage(tool_calls: [todo_write({ todos: [
    {id:0, title:"创建 User 模型", status:pending},
    {id:1, title:"实现登录 API", status:pending},
    {id:2, title:"添加前端登录表单", status:pending},
  ]})])
  → todoListMiddleware Command → state.todos = [...]
  → UI 渲染：○ ○ ○ 三个 pending 任务

Step 2 — 模型开始第一个任务
  AIMessage(tool_calls: [todo_write({ todos: [
    {id:0, title:"创建 User 模型", status:in_progress},  ← 标记进行中
    {id:1, title:"实现登录 API", status:pending},
    {id:2, title:"添加前端登录表单", status:pending},
  ]})])
  → UI 更新：▶ ○ ○

Step 3 — 模型执行工具调用
  AIMessage(tool_calls: [text_editor({ command:"create", path:"/models/User.ts" })])
  → ToolMessage("文件创建成功")

Step 4 — 模型标记完成，开始下一个
  AIMessage(tool_calls: [todo_write({ todos: [
    {id:0, title:"创建 User 模型", status:completed},   ← 已完成
    {id:1, title:"实现登录 API", status:in_progress},   ← 下一个
    {id:2, title:"添加前端登录表单", status:pending},
  ]})])
  → UI 更新：✓ ▶ ○
```

## 7. 与其他模块的协作

| 协作模块      | 关系                                                   |
| ------------- | ------------------------------------------------------ |
| HITL 中间件   | 互不干扰。`todoListMiddleware` 在前，HITL 在后         |
| 流式输出      | `commitDraft()` 提取 todo 更新；末尾 `getState()` 兜底 |
| Markdown 渲染 | 无关。Todo 是独立 UI 组件                              |
| MCP 工具      | 无关。`todo_write` 不在 MCP 工具列表中                 |
| Checkpointer  | `todos` 随 state 持久化，多轮对话间保持                |

## 8. 关键文件

| 文件                                    | 职责                                   |
| --------------------------------------- | -------------------------------------- |
| `src/middlewares/todo-list.ts`          | 中间件定义：工具注册、状态注入、schema |
| `src/agents/coding-agent.ts`            | 将中间件注册到 agent                   |
| `src/cli/components/todo-list-view.tsx` | UI 渲染：四态标记、颜色区分            |
| `src/cli/app.tsx`                       | 数据同步：流式提取 + 状态兜底          |
| `src/prompts/templates/coding_agent.md` | 基础 prompt，与 todo 说明拼接          |

---

_最后更新：2026-05-31_
