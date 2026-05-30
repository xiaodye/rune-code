# Rune Code Node 项目讲解文档

## 项目简介

Rune Code Node 是一个运行在终端（CLI）中的智能 AI 编程助手。它旨在通过自然语言对话，辅助开发者完成代码编写、文件操作、任务管理等工作。项目深度集成了 LLM（大语言模型）能力，通过 Agent 架构实现自主规划和执行。麻雀虽小，五脏俱全。

## 功能特性

- ReAct 模式 Agent
    - think -》 action -》 observe -》 think -》 ... -》 final response
- 工具集成
    - 文本编辑器：提供 `view`, `create`, `str_replace`, `insert` 四种操作。
    - 文件系统：`ls`, `tree`: 用于探索目录结构; `grep`: 基于 `@vscode/ripgrep` 实现高性能代码搜索。
    - shell 命令执行: 允许 Agent 执行 Shell 命令。
    - 复杂任务 TodoList: 允许 Agent 增删改查任务列表。todoListMiddleware: 这是一个关键组件。它拦截每次模型调用，将最新的 TODO 列表追加到 System Prompt 中。这样模型就能始终“记住”当前任务进度
- 多轮对话记忆:
    - 使用 `MemorySaver` 作为 Checkpointer，实现短期记忆, 支持对话上下文的持久化。
- 上下文总结
    - 利用 `summarizationMiddleware` 对每次模型调用的上下文进行总结，保留关键信息。
- MCP 协议支持
    - 项目支持 Model Context Protocol (MCP)，可连接外部工具和上下文。
    - 配置文件 `mcp.json` 定义了 MCP 服务的接口和参数。

- Human-in-the-loop
    - 集成 LangChain 原生 `humanInTheLoopMiddleware`。
    - 针对 `bash` 工具的所有调用进行拦截，并结合 **CLI 层的智能策略**：
        - 自动放行普通命令（如 `ls`, `grep`）。
        - 仅当检测到危险命令（如 `rm`, `rmdir`）时，才在 UI 界面弹出确认框（Approve/Reject）。
    - 这种模式既保留了使用标准中间件的规范性，又提供了流畅的用户体验。

## 技术栈

本项目主要采用 TypeScript 编写，运行于 Node.js 环境。

- **核心语言**: TypeScript (Node.js 22.x)
- **构建工具**: tsup
- **包管理器**: pnpm
- **UI 框架**: Ink (基于 React 的 CLI 渲染库)
- **AI/Agent 框架**:
    - LangChain: 基础 LLM 调用与工具封装
    - LangGraph: 构建有状态的 Agent 工作流
    - @modelcontextprotocol/sdk: 支持 MCP 协议，扩展工具能力
- **工具库**:
    - fs-extra: 文件系统操作
    - zod: 数据结构校验（Schema Validation）
    - execa: 命令行执行

## 目录结构说明

```text
/
├── bin/            # CLI 执行入口
├── src/
│   ├── agents/     # Agent 核心逻辑 (coding-agent, state)
│   ├── cli/        # 终端 UI 组件 (React + Ink)
│   ├── config/     # 配置管理
│   ├── mcp/        # Model Context Protocol 集成
│   ├── middlewares/# Agent 中间件 (如 Todo 列表管理)
│   ├── models/     # 模型初始化
│   ├── prompts/    # Prompt 模板
│   ├── tools/      # 工具实现 (fs, edit, terminal, todo)
│   ├── utils/      # 通用工具函数
│   ├── index.tsx   # 程序主入口
│   └── project.ts  # 项目全局上下文
├── docs/           # 文档
├── mcp.json        # MCP 服务配置
└── package.json
```
