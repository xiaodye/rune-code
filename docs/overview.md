# Rune Code Node 项目讲解文档

## 项目简介

Rune Code Node 是一个运行在终端（CLI）中的智能 AI 编程助手。它旨在通过自然语言对话，辅助开发者完成代码编写、文件操作、任务管理等工作。项目深度集成了 LLM（大语言模型）能力，通过 Agent 架构实现自主规划和执行。麻雀虽小，五脏俱全。

## 功能特性

- **ReAct 模式 Agent**
  - think → action → observe → think → ... → final response

- **流式输出**
  - token 级实时渲染，LLM 每生成一个字终端立即显示
  - 详见 [streaming.md](streaming.md)

- **Markdown 渲染**
  - 终端原生渲染粗体、代码块、列表、表格、引用等 Markdown 语法
  - 采用展平架构避免 Ink 嵌套样式丢失
  - 详见 [markdown-rendering.md](markdown-rendering.md)

- **上下文管理**
  - 三层策略：摘要中间件 + 前缀缓存布局 + UI 用量指示器
  - 基于模型上下文窗口比例自适应触发，无需硬编码 token 阈值
  - 详见 [context-management.md](context-management.md)

- **工具集成**
  - 文本编辑器：提供 `view`、`create`、`str_replace`、`insert` 四种操作
  - 文件系统：`ls`、`tree` 用于探索目录结构；`grep` 基于 `@vscode/ripgrep` 实现高性能代码搜索
  - Shell 命令执行：有状态终端，保持 CWD，支持 `cd`
  - 详见 [tools.md](tools.md)

- **复杂任务 TodoList**
  - `todoListMiddleware` 拦截每次模型调用，将最新的 TODO 列表追加到 System Prompt 中
  - 四态标记（○ pending / ▶ in_progress / ✓ completed / ✗ cancelled）
  - 终端 UI 实时渲染
  - 详见 [todolist.md](todolist.md)

- **多轮对话记忆**
  - 使用 `MemorySaver` 作为 Checkpointer，实现短期记忆，支持对话上下文持久化

- **Human-in-the-Loop**
  - 集成 LangChain 原生 `humanInTheLoopMiddleware`
  - 针对 `bash` 工具的所有调用进行拦截：
    - 自动放行普通命令（如 `ls`、`grep`）
    - 检测到危险命令（`rm`、`rmdir`）时弹窗确认（Approve/Reject）

- **MCP 协议支持**
  - 支持 Model Context Protocol (MCP)，可连接外部工具和上下文
  - 配置文件 `mcp.json` 定义 MCP 服务的接口和参数

## 技术栈

本项目主要采用 TypeScript 编写，运行于 Node.js 环境。

- **核心语言**: TypeScript (Node.js 22.x)
- **构建工具**: tsup
- **包管理器**: pnpm
- **UI 框架**: Ink 6 (基于 React 的 CLI 渲染库)
- **AI/Agent 框架**:
  - LangChain: 基础 LLM 调用与工具封装
  - LangGraph: 构建有状态的 Agent 工作流
  - @modelcontextprotocol/sdk: 支持 MCP 协议，扩展工具能力
- **Markdown 解析**: marked
- **工具库**:
  - fs-extra: 文件系统操作
  - zod: 数据结构校验
  - execa: 命令行执行
  - handlebars: Prompt 模板引擎

## 目录结构说明

```text
/
├── src/
│   ├── agents/           # Agent 核心逻辑
│   │   └── coding-agent.ts   # Agent 创建：模型、工具、中间件注册
│   ├── cli/              # 终端 UI 组件 (React + Ink)
│   │   ├── app.tsx           # 主应用：状态管理、流式调度
│   │   └── components/
│   │       ├── banner.tsx         # 渐变标题
│   │       ├── chat-view.tsx      # 消息列表、流式渲染、上下文指示器
│   │       ├── chat-input.tsx     # 用户输入
│   │       ├── markdown-text.tsx  # Markdown → Ink 渲染器
│   │       └── todo-list-view.tsx # TodoList UI
│   ├── mcp/              # Model Context Protocol 集成
│   ├── middlewares/      # Agent 中间件
│   │   └── todo-list.ts      # todo_write 工具 + 状态注入
│   ├── prompts/          # Prompt 模板 (Handlebars)
│   │   ├── template.ts
│   │   └── templates/
│   │       └── coding_agent.md
│   ├── tools/            # 工具实现
│   │   ├── fs/               # ls, tree, grep
│   │   ├── text-editor/      # view, create, str_replace, insert
│   │   └── terminal/         # bash (有状态终端)
│   ├── utils/            # 通用工具函数
│   │   ├── debug.ts          # 调试日志
│   │   └── token-counter.ts  # Token 估算、使用率计算
│   ├── index.tsx         # 程序主入口
│   └── project.ts        # 项目全局上下文
├── docs/                 # 文档
│   ├── overview.md            # 项目概述（本文件）
│   ├── streaming.md           # 流式输出实现
│   ├── markdown-rendering.md  # Markdown 渲染实现
│   ├── context-management.md  # 上下文管理实现
│   ├── todolist.md            # TodoList 实现
│   └── tools.md               # 工具实现
├── mcp.json             # MCP 服务配置
├── langgraph.json       # LangGraph 开发服务器配置
└── package.json
```

## 相关文档

| 文档 | 内容 |
|------|------|
| [streaming.md](streaming.md) | token 级流式输出：`streamMode: 'messages'`、草稿累积、commitDraft |
| [markdown-rendering.md](markdown-rendering.md) | 终端 Markdown 渲染：展平模型、`flattenInline`、`renderSegments` |
| [context-management.md](context-management.md) | 上下文管理：`summarizationMiddleware`、fraction 触发、前缀缓存 |
| [todolist.md](todolist.md) | TodoList 实现：全量替换 + 状态注入 + 双路径同步 |
| [tools.md](tools.md) | 工具实现：bash、grep、ls、tree、text_editor |

---

*最后更新：2026-05-31*
