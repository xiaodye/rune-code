# Rune Code 技术总览

> 每个模块 2-3 分钟讲清楚：问题 → 方案 → 关键决策 → 亮点。详细实现见对应原文档。

---

## 1. 项目总览（开场 1 分钟）

**一句话**：Rune Code 是一个终端 AI 编程助手，类似终端版 Cursor，基于 LangGraph Agent + Ink React TUI，从零手写约 2000 行 TypeScript。

**技术栈**：Node.js 22 / TypeScript / Ink 6（React 渲染到终端）/ LangChain v1.4 + LangGraph / DeepSeek API / marked（Markdown 解析）/ Zod（Schema 校验）

**核心模块**：Agent 引擎 → 流式输出 → Markdown 渲染 → 上下文管理 → Todo 追踪 → 工具系统 → 围栏与人机交互

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

`marked-terminal`（marked 官方终端渲染器）把 Markdown 转成 ANSI 终端字符串，Ink `<Text>` 直接透传 ANSI 码到终端。

### 关键设计

**为什么从手写渲染器切换到 marked-terminal？**第一版用 `marked.lexer()` 做词法分析，手动把 10 种 token 类型映射到 Ink `<Text>/<Box>` 组件，写了 285 行。但每次 marked 新增语法都需要手动维护，且自己实现的表格渲染（纯文本对齐）远不如 `marked-terminal` 的 ASCII 框线表格。

**切换的顾虑和验证**：担心 `marked-terminal` 输出的 ANSI 裸字符串和 Ink 自己管理的 ANSI 布局冲突。实际测试后发现 Ink `<Text>` 可以安全透传 ANSI 码 —— 终端对这两层 ANSI 各管各的，定位控制归 Ink，样式控制归 marked-terminal，互不干扰。

**代码精简**：285 行 → 30 行。`marked.parse(content, { renderer: new TerminalRenderer() })` 一行搞定所有语法。

### 亮点

ASCII 框线表格、标题彩色加粗、代码块语法高亮、引用块缩进 —— 全是 marked-terminal 内置的。30 行代码，markdown 覆盖度反而比手写更高（手写版没做嵌套列表等边界情况）。

> 详见 [markdown-rendering.md](markdown-rendering.md)

---

## 4. 上下文管理（讲 2 分钟）

### 问题

Agent 对话历史无限增长，最终超过 LLM context window 导致 API 400。需要压缩历史但保留关键上下文。

### 方案

三层策略：摘要中间件 + 前缀缓存友好布局 + UI 用量指示器。

### 关键设计

**`summarizationMiddleware`（LangChain 内置）**：用 `fraction`（上下文窗口占比）而非硬编码 token 数。但有两个发现：

1. **langchain 内置的 `getModelContextSize` 只覆盖 OpenAI/Anthropic 模型**，对 DeepSeek 返回兜底值 4097，导致 `fraction: 0.15` 实际触发在 4097×0.15=614 tokens——完全错误。解决方案：用 `Object.defineProperty` 重写模型实例的 `profile` getter，注入正确的 `maxInputTokens`（来自 `LLM_CONTEXT_WINDOW` 环境变量，兜底 128K）。

2. **阈值参考业界标准重新设计**：Claude Code 在 ~80% 窗口触发，OpenAI Codex 在 ~95% 触发。采用双触发器：`(fraction > 0.8 AND messages > 6) OR (fraction > 0.9 AND messages > 3)`。keep 也用 `fraction: 0.25` 保留最近 25% 窗口的原文，自适应不同模型。

**前缀缓存布局**：`[System Prompt + Tools]` → `[Summary]` → `[Recent messages]`。静态放前（始终命中缓存），动态放后（缓存失效范围最小）。

**`modelCallLimitMiddleware`**：`runLimit: 25` 防止 tool call 死循环导致 GraphRecursionError。

### 亮点

`fraction` 自适应 + profile 注入解决非 OpenAI 模型的上下文检测 bug。UI 底部实时显示 `Context: 4.2Kt · 14 msgs · ██████░░░░ 60%`，颜色分级提示，上下文窗口通过 `LLM_CONTEXT_WINDOW` env var 显式配置。

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

**`bash`**：有状态终端——`BashTerminal` 类维护 CWD，`cd` 手动拦截更新内存中的路径（`execa` 子进程退出后 CWD 丢失）。`TERM=dumb` 禁用 ANSI 颜色码。所有 bash 调用由 HITL 中间件拦截，经危险规则引擎分级评估后放行或弹窗（详见第 7 节）。

**`text_editor`**：四个子命令（view/create/str_replace/insert）。`str_replace` 采用严格字符串匹配——一个空格不对就失败，迫使 LLM 失败后重新 `view` 再试，避免幻觉式编辑。

**统一忽略系统**：70+ 条 glob 规则，`ls`/`tree`/`grep` 共用。grep 通过 `--glob !pattern` 注入 ripgrep，ls/tree 用 `minimatch`。

### 亮点

所有工具"不抛异常，返回自然语言错误"——LLM 能理解 `"File does not exist: /path"` 并自行纠正。专用工具边界明确（bash 的描述中禁止用它做文件操作）。

> 详见 [tools.md](tools.md)

---

## 7. 围栏与人机交互（讲 2.5 分钟）

### 问题

Agent 可以执行任意 bash 命令——`rm -rf /`、`curl | bash`、`git push --force origin main`、`shutdown`。两个核心挑战：

1. **覆盖面**：单一正则 `/(rm|rmdir)/` 只能检测 2% 的危险命令，`dd`、`chmod 777`、`iptables -F` 等全部漏网
2. **审批粒度**：`rm file.txt` 和 `rm -rf / --no-preserve-root` 触发完全一样的审批，用户容易「审批疲劳」，对真正危险的命令也随手 approve

### 方案

结构化危险规则引擎 + 四级分级审批策略。不是简单拦截/放行，而是给每个命令打 0-100 分，映射到四级响应。

### 关键设计

**危险规则引擎**（`src/safety/danger-engine.ts`，约 570 行）：

```
60+ 条规则 × 6 大分类 × 0-100 风险评分
```

- 6 大分类：`file_destruction`（文件销毁）、`system_modification`（系统修改）、`network_danger`（网络危险）、`git_destructive`（Git 破坏）、`privilege_escalation`（权限提升）、`rce`（代码执行/供应链攻击）
- 每条规则包含：正则模式 + 语义分类 + 风险分数 + 人类可读描述
- 取最高分策略（非累加）：避免"3 个低危规则凑出高危"的伪阳性
- 19 条内置白名单：`rm -rf node_modules`、`git status` 等常见无害操作直接 safe 放行，`isWhitelisted()` 先于规则匹配执行

**四级审批策略**：

| 等级 | 分数 | 行为 | 用户感知 |
|------|------|------|---------|
| `safe` | 0-29 | 自动放行 | 无感知 |
| `warning` | 30-59 | 1.2s 提示后自动执行 | 底部闪现风险提示 |
| `dangerous` | 60-89 | 审批弹窗 | 看到命令、类别、评分、Approve/Reject |
| `critical` | 90-100 | 审批弹窗 + 3s 倒计时 | "此命令可能对系统造成不可逆影响"，倒计时结束前 Approve 不可点击 |

**HITL 中断流**（`app.tsx:174-248`）：

```
stream 结束 → commitDraft → getState 检查 tasks[0].interrupts
  → 提取 actionRequests → assessRisk(command)
  → safe: autoResume(approve)
  → warning: setInterruptInfo + 1.2s 后 autoResume
  → dangerous/critical: setInterruptInfo → 审批 UI → handleResume
```

审批 UI（Ink 终端组件）根据风险等级动态显示：`🛑 CRITICAL`（红色）/ `⚠ Dangerous`（黄色），展示命令原文、风险类别标签、评分 `/100`。critical 级别还有 3 秒倒计时。

**LangChain HITL 中间件 Bug 绕过**（`app.tsx:287-320`）：

langchain v1.4.2 HITL 中间件在混合工具调用场景有已知 bug：当 AIMessage 同时包含 bash（被拦截）和 grep（自动放行）时，用户 reject 后自动放行的 tool_call 保留在消息中但无对应 ToolMessage → LLM API 400。当前方案：`allowedDecisions` 扩展为 `['approve', 'edit', 'reject']`，reject 时走 edit 路径，把命令原地替换为 `echo "[SAFETY] User rejected"` —— 无害但完整执行，保证 ToolMessage 齐全。

### 亮点

- **评分而非二元**：`rm file.txt`（60 分，dangerous）和 `rm -rf /`（100 分，critical）触发不同 UI，消除审批疲劳
- **白名单热路径**：`isWhitelisted()` O(n) 精确匹配在所有正则之前执行，常见操作零开销放行
- **终端原生**：审批 UI 是纯 Ink React 组件，边框颜色/图标/倒计时都随风险等级动态切换，不需要弹出新窗口
- **工程卫生**：规则引擎是纯函数，测试友好；审批策略在 app 层实现，与中间件解耦

> 详见 [hitl-safety.md](hitl-safety.md)

---

## 8. 一句话总结各模块

| 模块       | 一句话                                                        |
| ---------- | ------------------------------------------------------------- |
| 流式输出   | `streamMode: 'messages'` + 草稿累积 + 片段合并 |
| Markdown   | `marked-terminal` 转 ANSI 字符串，Ink 透传，30 行覆盖全语法     |
| 上下文管理 | `fraction` 自适应 + profile 注入修复非 OpenAI 模型 + UI 指示器  |
| TodoList   | 全量替换 + 状态注入 prompt + 双路径同步                       |
| 工具系统   | 5 内置 + MCP，ripgrep 搜索 + 有状态终端 + 严格编辑            |
| 围栏与HITL | 60+ 规则引擎 + 四级审批 + 白名单 + Ink 终端审批 UI             |

## 9. 面试常见追问

**Q: 为什么不用 Web UI 而用终端？**
A: 终端是开发者的原生环境，不需要切换窗口。Ink 用 React 写终端 UI，组件化 + 状态管理跟 Web 一样。

**Q: 流式输出怎么处理中断（HITL）？**
A: 流结束 → commitDraft → getState 检查 interrupt → assessRisk 分级 → safe/warning 自动放行，dangerous/critical 弹审批 UI。详细流程见第 7 节。

**Q: 危险规则引擎怎么设计的？**
A: 60+ 条结构化正则规则 × 6 大分类，每条 0-100 风险评分，取最高分 + 白名单优先。详见第 7 节「围栏与人机交互」。

**Q: Markdown 渲染为什么从手写切换到 marked-terminal？**
A: 第一版手写了 285 行 token → Ink 组件映射。后来发现 `marked-terminal` 和 Ink 其实可以共存——Ink 管终端布局的 ANSI 码（光标定位），marked-terminal 管文本样式的 ANSI 码（颜色/粗体），互不冲突。迁移后 285 行变 30 行，还免费获得了 ASCII 框线表格、语法高亮等手写版没覆盖的能力。唯一要注意的是 `marked-terminal@7.x` 的 peer dep 只声明支持 `marked@<16`，但实测兼容 `marked@18`。

**Q: 上下文管理的 fraction 遇到什么问题？**
A: langchain 内置的 `getModelContextSize` 只认识 OpenAI/Anthropic 模型，对 DeepSeek 返回兜底值 4097。`fraction: 0.8` 在 128K 模型上本应 102K 触发，实际变成 3277 tokens 就触发。解决方案：用 `Object.defineProperty` 给模型实例注入正确的 `profile.maxInputTokens`，值来自 `LLM_CONTEXT_WINDOW` 环境变量（兜底 128K）。fraction 优势保留——换 200K 的 Claude 模型时 0.8 自动变成 160K 触发。

**Q: 怎么防止模型死循环？**
A: 双重保护——`modelCallLimitMiddleware`（单次 25 次 LLM 调用上限）+ `recursionLimit: 50`（LangGraph 节点执行上限）。

**Q: 有做记忆系统吗？**
A: 当前 `MemorySaver` 在内存中，进程重启丢失。下一步计划换 `SqliteSaver` 持久化到 `.rune/checkpoints.db`，改 2 行代码，收益明显。

---

_最后更新：2026-06-02_
