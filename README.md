# rune-code

一个基于 Node.js、LangChain 和 Ink 构建的强大终端 AI 编程助手。`rune-code` 帮助您通过交互式聊天界面编写代码、执行终端命令并管理开发任务。

## ✨ 功能特性

- 🤖 **AI 编程代理**：由先进的 LLM（OpenAI、DeepSeek 等）驱动，能够理解并协助处理复杂的编程任务。
- 🖥️ **终端 UI**：基于 [Ink](https://github.com/vadimdemedes/ink) 构建的现代化交互式命令行界面。
- 🛠️ **丰富工具集**：
    - **文件系统**：使用 `ls`、`tree`、`grep` 以及内置编辑器浏览和操作文件。
    - **终端集成**：直接在聊天中执行 Shell 命令。
    - **任务管理**：智能 Todo 列表管理，实时追踪任务进度。
- 🔌 **MCP 支持**：扩展性架构，支持 [Model Context Protocol (MCP)](https://modelcontextprotocol.io/)，可连接外部工具和上下文。
- ⚙️ **灵活配置**：支持 `.env` 和 `config.yaml` 两种配置方式，便于自定义。

## 📦 前置要求

- **Node.js**：22.x 或更高版本
- **pnpm**：10.x 或更高版本

## 🚀 安装指南

1. 克隆仓库：

    ```bash
    git clone <repository-url>
    cd deer-code-node
    ```

2. 安装依赖：
    ```bash
    pnpm install
    ```

## ⚙️ 配置说明

1. 复制示例环境文件：

    ```bash
    cp .env.example .env
    ```

2. 编辑 `.env` 配置您的 LLM 提供商：

    ```env
    LLM_API_BASE=https://api.openai.com/v1
    LLM_API_KEY=your_api_key_here
    LLM_MODEL=gpt-4o
    LLM_TEMPERATURE=0
    LLM_MAX_TOKENS=8192
    ```

    或者，您可以使用 `config.yaml` 进行更高级的配置（参考 `config.example.yaml`）。

## 💡 使用指南

在当前目录下启动代理：

```bash
pnpm start
```

或者指定目标项目目录：

```bash
pnpm start /path/to/your/project
```

## 💻 开发指南

- **构建**：使用 tsup 编译项目。

    ```bash
    pnpm build
    ```

- **格式化**：使用 Prettier 格式化代码。
    ```bash
    pnpm format
    ```

## 📄 许可证

ISC
