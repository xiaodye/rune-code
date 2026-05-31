# Rune Code 技术总览

> 每个模块 2-3 分钟讲清楚：问题 → 方案 → 关键决策 → 亮点。详细实现见对应原文档。

---

## 1. 项目总览（开场 1 分钟）

**一句话**：Rune Code 是一个终端 AI 编程助手，类似终端版 Cursor，基于 LangGraph Agent + Ink React TUI，从零手写约 2000 行 TypeScript。

**技术栈**：Node.js 22 / TypeScript / Ink 6（React 渲染到终端）/ LangChain v1.4 + LangGraph / DeepSeek API / marked（Markdown 解析）/ Zod（Schema 校验）

**核心模块**：Agent 引擎 → 流式输出 → Markdown 渲染 → 上下文管理 → Todo 追踪 → 工具系统

---

## 2. 流式输出（讲 2 分钟）

### 问题

LangGraph 默认 `streamMode: 'updates'` 是节点级批量——LLM 完整生成后才一次性吐出，用户看到的是长时间的空白然后瞬间出现全部文字。

### 方案

切换到 `streamMode: 'messages'`（token 级），每个 LLM token 以 `AIMessageChunk` 实时到达。核心挑战是工具调用在流式 API 中是分片到达的，需要按 index 合并。

### 关键设计

**草稿累积模型**：用局部变量 `draftContent` + `draftToolCallChunks` 积攒 token，通过 `commitDraft()` 在两个时机提交为完整 `AIMessage`——工具结果到达时、或流结束时。局部变量而非 React state，因为 token 频率 50-100 次/秒，state 批处理会引入延迟。

**工具调用片段合并**：OpenAI 流式 API 把一个 tool_call 拆成 3-4 个 chunk（name → args 片段 1 → args 片段 2 → id），`mergeToolCallChunks()` 按 `index` 分组拼接 args JSON 字符串，最后一次性 `JSON.parse`。

**ToolMessage 丢失问题**：`todo_write` 等中间件通过 `Command` 直接写 state，其 ToolMessage 不出现于 stream。写了一个状态同步——每轮结束后从 `agent.getState()` 拉取完整消息列表覆盖 UI，过滤掉 SystemMessage。

### 亮点

用局部变量而非 React state 处理高频 token 更新，避免批处理延迟。用 `AIMessageChunk.isInstance()` 判类型而非字符串匹配。流式输出同时正确处理了 HITL 中断恢复。

> 详见 [streaming.md](streaming.md)

---

## 3. Markdown 渲染（讲 2 分钟）

### 问题

终端没有 DOM、没有 CSS，只有 8+16 色 + 粗体/暗色/下划线/删除线。但 LLM 输出天然是 Markdown。需要把 `**粗体**`、`` `代码` ``、` ```代码块``` ` 这些标记语法转成终端样式。

### 方案

`marked.lexer()` 做纯词法分析（不生成 HTML），然后把 token 树映射到 Ink 组件。

### 关键设计

**`marked.lexer()` 做纯词法分析**（不生成 HTML），然后把 token 树直接映射到 Ink 组件——`**粗体**` → `<Text bold>`、`` `代码` `` → `<Text color="cyan">`。

**样式叠加**：`***bold-italic***`（strong 套 em）通过 `{...seg, bold: true, dim: true}` 自动合并，终端用 dimColor 模拟斜体（终端鲜少支持真斜体）。

### 亮点

10 种 Markdown 语法 → Ink 样式映射表（含代码块圆角边框、表格自动列宽、引用块竖线）。流式时也能实时渲染——`marked.lexer()` 对不完整语法容忍度高（未闭合的 `**` 当字面量，下一 token 闭合后立刻切粗体）。

> 详见 [markdown-rendering.md](markdown-rendering.md)

---

## 4. 上下文管理（讲 2 分钟）

### 问题

Agent 对话历史无限增长，最终超过 LLM context window 导致 API 400。需要压缩历史但保留关键上下文。

### 方案

三层策略：摘要中间件 + 前缀缓存友好布局 + UI 用量指示器。

### 关键设计

**`summarizationMiddleware`（LangChain 内置）**：用 `fraction`（上下文窗口占比）而非硬编码 token 数。`fraction: 0.15` 在 128K 模型上约 19K 触发，在 32K 模型上约 4.8K 触发，自适应不同模型。双触发器 AND 逻辑——`(fraction > 0.15 AND messages > 10) OR (fraction > 0.25 AND messages > 6)`，多轮对话和单条长消息分别覆盖。`keep: 24` 条原文保证当前任务连贯。

**前缀缓存布局**：`[System Prompt + Tools]` → `[Summary]` → `[Recent 24 msgs]`。静态放前（始终命中缓存），动态放后（缓存失效范围最小）。摘要换其他模型也可用主模型（复用 API key，触发频率极低，成本可忽略）。

**`modelCallLimitMiddleware`**：`runLimit: 25` 防止 tool call 死循环导致 GraphRecursionError。25 次调用覆盖规划 5 次 + 操作 15 次 + 验证 5 次，超过即抛异常中止。

### 亮点

配置即意图——`fraction` 一次配置适配所有模型，不需要查文档改阈值。UI 底部实时显示 `Context: 4.2Kt · 14 msgs · ██████░░░░ 60%`，颜色分级提示。

> 详见 [context-management.md](context-management.md)

---

## 5. TodoList（讲 1.5 分钟）

### 问题

LLM 无状态——处理"实现用户登录"这种 5 步任务时，容易忘记做到哪了。

### 方案

业界标准模式：全量替换式 `todo_write` 工具 + 状态注入到 system prompt。

### 关键设计

**全量替换而非增量**：模型每次输出完整 `TodoItem[]`，避免增量操作的 ID 管理问题。中间件 `wrapModelCall` 在每次 LLM 调用前把当前列表注入 prompt：`- [x] 已完成 (completed)\n- [ ] 待处理 (pending)`。

**数据同步双路径**：流式时从 `commitDraft()` 的 tool_call chunks 提取（即时），每轮末尾从 `agent.getState().todos` 兜底（完整）。因为 `todo_write` 通过中间件 `Command` 写 state，其 ToolMessage 不出现于 stream。

### 亮点

与 Claude Code / Cline 采用相同的全量替换模式。四态标记（○/▶/✓/✗）在终端 UI 中实时渲染，紫色边框独立区域。

> 详见 [todolist.md](todolist.md)

---

## 6. 工具系统（讲 2 分钟）

### 架构

5 个内置工具 + MCP 扩展。所有工具使用 `tool()` + Zod Schema 封装。

### 关键设计

**`grep`**：基于 `@vscode/ripgrep`（Rust 预编译二进制），比 Node.js 遍历快 10-100 倍。三种输出模式（files_with_matches / content / count），head_limit 默认 100 防止输出过长。

**`bash`**：有状态终端——`BashTerminal` 类维护 CWD，`cd` 手动拦截更新内存中的路径（`execa` 子进程退出后 CWD 丢失）。`TERM=dumb` 禁用 ANSI 颜色码。`humanInTheLoopMiddleware` 拦截所有 bash 调用，危险命令（rm/rmdir）弹窗确认。

**`text_editor`**：四个子命令（view/create/str_replace/insert）。`str_replace` 采用严格字符串匹配——一个空格不对就失败，迫使 LLM 失败后重新 `view` 再试，避免幻觉式编辑。

**统一忽略系统**：70+ 条 glob 规则，`ls`/`tree`/`grep` 共用。grep 通过 `--glob !pattern` 注入 ripgrep，ls/tree 用 `minimatch`。

### 亮点

所有工具"不抛异常，返回自然语言错误"——LLM 能理解 `"File does not exist: /path"` 并自行纠正。专用工具边界明确（bash 的描述中禁止用它做文件操作）。

> 详见 [tools.md](tools.md)

---

## 7. 一句话总结各模块

| 模块       | 一句话                                                        |
| ---------- | ------------------------------------------------------------- |
| 流式输出   | `streamMode: 'messages'` + 草稿累积 + 片段合并 |
| Markdown   | `marked.lexer` → 直接映射 Ink Text 组件，10 种语法终端样式    |
| 上下文管理 | `fraction` 自适应摘要 + 前缀缓存布局 + 步数上限保护           |
| TodoList   | 全量替换 + 状态注入 prompt + 双路径同步                       |
| 工具系统   | 5 内置 + MCP，ripgrep 搜索 + 有状态终端 + 严格编辑            |

## 8. 面试常见追问

**Q: 为什么不用 Web UI 而用终端？**
A: 终端是开发者的原生环境，不需要切换窗口。Ink 用 React 写终端 UI，组件化 + 状态管理跟 Web 一样。

**Q: 流式输出怎么处理中断（HITL）？**
A: 流结束 → commitDraft → getState 检查 interrupt → 如果是危险命令弹窗 → 用户确认后 resume → 新 runAgent 调用。

**Q: Markdown 渲染为什么不用现成的库，要自己写？**
A: 三个现成方案都不兼容 Ink 的 React 终端模型——`marked-terminal` 输出 ANSI 裸字符串，Ink 自己管 ANSI 布局会乱；`react-markdown` 渲染到 HTML DOM，终端没有 DOM；`ink-markdown` 这个库不存在。所以不是重新造轮子，是写了一个约 150 行的胶水层：marked 负责词法分析（占了 90% 的工作），我们只做 token → Ink 组件的映射。Claude Code 没有这层问题因为它不用 Ink，直接操作终端输出。

**Q: 上下文管理为什么选 fraction 而不是固定 token？**
A: 固定 4000 token 在 128K 模型上只占 3% 就触发，太频繁；在 8K 模型上占 50% 触发，太晚。fraction 随模型自适应。

**Q: 怎么防止模型死循环？**
A: 双重保护——`modelCallLimitMiddleware`（单次 25 次 LLM 调用上限）+ `recursionLimit: 50`（LangGraph 节点执行上限）。

**Q: 有做记忆系统吗？**
A: 当前 `MemorySaver` 在内存中，进程重启丢失。下一步计划换 `SqliteSaver` 持久化到 `.rune/checkpoints.db`，改 2 行代码，收益明显。

---

_最后更新：2026-05-31_
