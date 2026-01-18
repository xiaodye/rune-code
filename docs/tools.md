# Deer Code Node 工具实现原理解析

本文档详细解析了 `src/tools` 目录下各个 Agent 工具的实现原理。

## 1. 概览

所有工具均使用 `@langchain/core/tools` 的 `tool` 函数进行封装，并使用 `zod` 定义输入 Schema。这确保了 LLM 能够准确理解工具的用途和参数格式。

## 2. 文件系统工具 (File System Tools)

位于 `src/tools/fs/` 目录下，用于文件和目录的探索与搜索。

### 2.1 `ls` 工具

- **文件**: `src/tools/fs/ls.ts`
- **功能**: 列出指定目录下的文件和子目录。
- **实现原理**:
    - 使用 `fs-extra` 读取目录内容。
    - **排序**: 优先显示目录，然后是文件，按字母顺序排列。
    - **过滤**: 支持 `match` (白名单) 和 `ignore` (黑名单) 模式，使用 `minimatch` 库进行 glob 匹配。
    - **默认忽略**: 会自动加载 `DEFAULT_IGNORE_PATTERNS` (如 `node_modules`, `.git` 等) 以减少噪音。
    - **输出**: 返回格式化的文件名列表，目录以 `/` 结尾。

### 2.2 `tree` 工具

- **文件**: `src/tools/fs/tree.ts`
- **功能**: 以树状图形式展示目录结构。
- **实现原理**:
    - 递归遍历目录。
    - **深度限制**: 通过 `max_depth` 参数控制递归深度，防止输出过长。
    - **可视化**: 使用 Unicode 字符 (`├──`, `└──`, `│`) 绘制树形结构。
    - 同样支持默认的忽略模式。

### 2.3 `grep` 工具

- **文件**: `src/tools/fs/grep.ts`
- **功能**: 基于正则的全库代码搜索。
- **实现原理**:
    - **核心引擎**: 调用 `@vscode/ripgrep` (即 `rg` 命令) 的二进制文件，通过 `execa` 执行。
    - **参数映射**: 将工具参数映射为 `rg` 的命令行参数 (如 `-i` 忽略大小写, `-C` 上下文行数)。
    - **输出控制**: 实现了 `head_limit`，当匹配结果过多时截断输出，避免撑爆 Context Window。
    - **错误处理**: 优雅处理 `exitCode === 1` (未找到匹配) 的情况。

## 3. 编辑器工具 (Editor Tool)

### `text_editor` 工具

- **文件**: `src/tools/edit/editor.ts`
- **功能**: 文件的查看、创建和修改。
- **核心类**: `TextEditor` 类封装了底层逻辑。
- **支持命令**:
    1.  **`view`**:
        - 读取文件内容。
        - 支持 `view_range` 参数 (startLine, endLine)，仅读取特定行。
        - 返回内容带行号 (类似 `cat -n`)，方便后续基于行号的操作。
    2.  **`create`**:
        - 创建新文件或覆盖现有文件。
        - 会检查路径是否误指向了目录。
    3.  **`str_replace`**:
        - **全量替换**: 读取文件 -> 检查 `old_str` 是否存在 -> 使用 `split(old).join(new)` 替换所有出现的地方 -> 写回文件。
        - 如果 `old_str` 不匹配（哪怕差一个空格），操作会失败并报错。
    4.  **`insert`**:
        - 在指定行号 (`insert_line`) 后插入新文本。
        - 支持在文件开头插入 (line 0)。
        - 基于数组 `splice` 操作实现。

## 4. 终端工具 (Terminal Tool)

### `bash` 工具

- **文件**: `src/tools/terminal/tool.ts` & `src/tools/terminal/bash.ts`
- **功能**: 执行 Shell 命令。
- **实现原理**:
    - **会话保持**: 使用 `BashTerminal` 单例模式 (`keepAliveTerminal`)。
    - **模拟 cd**: 因为 `execa` 每次都在子进程运行，无法保留 `cd` 后的状态。因此，工具内部手动拦截 `cd` 命令，解析路径并更新内存中的 `_cwd` (Current Working Directory) 变量。后续命令都会在这个 `_cwd` 下执行。
    - **执行**: 使用 `execa` (`shell: true`) 执行命令，合并 `stdout` 和 `stderr` 返回。
    - **人机交互 (Human-in-the-Loop)**:
        - 集成 LangChain 原生 `humanInTheLoopMiddleware`。
        - **机制**: 中间件配置为拦截所有 `bash` 调用。
        - **策略**: 实际的“删除确认”逻辑下沉到 Client 端 (CLI) 实现。
        - **流程**: Agent 发起 `bash` 调用 -> 中间件中断 -> CLI 接收中断请求 -> 检查命令内容 -> 若含 `rm` 则弹窗确认，否则自动发送 Approve 指令恢复执行。

## 5. 任务管理工具 (Todo Tool)

### `todo_write` 工具

- **文件**: `src/tools/todo/tool.ts`
- **功能**: 更新 Agent 的任务清单。
- **实现原理**:
    - **状态更新**: 不同于其他工具只返回文本，该工具利用 LangGraph 的 `Command` 机制，直接更新全局状态 (`State`) 中的 `todos` 字段。
    - **todoListMiddleware**: 这是一个关键组件。它拦截每次模型调用，将最新的 TODO 列表追加到 System Prompt 中。这样模型就能始终“记住”当前任务进度。
    - **交互**: 接收一个完整的 `TodoItem` 数组，全量替换当前列表。
    - **反馈**: 返回更新成功的摘要信息（如 "5 todos are not completed"），提醒 Agent 继续工作。
