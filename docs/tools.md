# Rune Code 工具系统实现

本文档详细解析 Agent 工具系统的架构设计、各工具的实现原理、关键设计决策，以及与其他模块的协作关系。

## 1. 工具总览

Agent 拥有 5 个内置工具 + MCP 动态扩展工具：

| 工具 | 文件 | 类型 | 核心职责 |
|------|------|------|---------|
| `ls` | `tools/fs/ls.ts` | 文件系统 | 列出目录内容，支持 glob 过滤 |
| `tree` | `tools/fs/tree.ts` | 文件系统 | 树形展示目录结构 |
| `grep` | `tools/fs/grep.ts` | 文件系统 | 基于 ripgrep 的代码搜索 |
| `text_editor` | `tools/text-editor/editor.ts` | 文件编辑 | view / create / str_replace / insert |
| `bash` | `tools/terminal/` | 终端 | 有状态 Shell 命令执行 |
| MCP | `mcp/index.ts` | 扩展 | 通过 MCP 协议接入外部工具 |

所有工具通过 `src/tools/index.ts` 统一导出，在 `src/agents/coding-agent.ts` 中注册到 Agent。

## 2. 统一封装模式

### 2.1 `tool()` + Zod Schema

所有工具使用 LangChain 的 `tool()` 函数式 API：

```typescript
export const myTool = tool(
    async (args) => {
        // 1. 参数校验（Zod 已自动完成）
        // 2. 执行操作
        // 3. 返回格式化文本
    },
    {
        name: 'my_tool',        // LLM 通过此名称调用
        description: '...',     // 自然语言描述，LLM 据此决策
        schema: z.object({}),   // Zod → JSON Schema，自动转给 LLM
    },
);
```

**为什么用 `tool()` 而非继承 `StructuredTool`？**

- 更简洁：一个函数 + 一个 schema 对象，无需定义类
- 类型完整：回调参数自动从 `z.object` 推导类型
- 官方推荐：LangChain v1.4+ 的主力 API

### 2.2 错误处理约定

所有工具遵循统一模式：

```typescript
try {
    return `成功结果描述`;
} catch (error) {
    return `Error: ${error.message}`;
}
```

**设计意图**——不抛异常，返回自然语言错误。Agent 的 ReAct 循环中，工具抛出异常会导致 LangGraph 进入错误恢复路径；返回错误文本则 LLM 可以理解并自行纠正（如换路径重试）。

### 2.3 输出格式

工具返回使用 Markdown 代码块包裹结构化输出：

```
Here's the result in /path/to/dir:
\`\`\`
file1.ts
file2.ts
\`\`\`
```

Markdown 代码块让 LLM 更容易区分"工具输出"和"我的下一步思考"，与系统 prompt 中"每次调用前先解释思路"的要求形成 `解释 → 调用 → 结果` 的清晰节奏。

## 3. 文件系统工具

三个工具共享同一份忽略规则（[`src/tools/fs/ignore.ts`](src/tools/fs/ignore.ts)），覆盖 8 个技术栈、70+ 条 glob 模式：`.git/**`、`node_modules/**`、`dist/**`、`__pycache__/**`、`.vscode/**`、`*.log` 等。`grep` 通过 `--glob !pattern` 传给 ripgrep，`ls` 和 `tree` 在 Node.js 侧用 `minimatch` 过滤。

### 3.1 `ls` — 目录列表

文件：[src/tools/fs/ls.ts](src/tools/fs/ls.ts)

```
参数: { path, match?, ignore? }
    ↓
1. 校验绝对路径 → 路径存在 → 是目录
2. fs.readdir(withFileTypes) → 目录优先排序
3. match 白名单过滤 → ignore 黑名单过滤 → DEFAULT_IGNORE_PATTERNS
4. 目录加 / 后缀 → 换行输出
```

**设计要点**：

- **绝对路径强制**：Schema 描述明确 "Relative paths are not allowed"。bash 可能改变 CWD，相对路径在不同时机解析到不同位置，绝对路径消除歧义
- **目录优先排序**：目录在前（加 `/` 后缀）、文件在后，各自字母序，符合 `ls -l` 直觉
- **双层过滤**：`match` 白名单先缩小范围，`ignore` 黑名单二次剔除。白名单为空时跳过，性能无损

### 3.2 `tree` — 目录树

文件：[src/tools/fs/tree.ts](src/tools/fs/tree.ts)

```
参数: { path?, max_depth = 3 }
    ↓
1. 校验路径存在且为目录
2. 递归遍历 → shouldIgnore 逐层过滤
3. Unicode 字符绘制：├── └── │
4. max_depth 限制深度
```

**关键设计**：

- **`max_depth` 默认 3**：Schema 中明确 "should be less than or equal to 3"。过深输出消耗大量 token 但对 LLM 规划无益——3 层足以看清项目骨架
- **逐层过滤**：`shouldIgnore` 在每个递归层级执行，`node_modules` 在根目录就被排除后不再深入
- **权限降级**：无权限目录输出 `[Permission Denied]` 而非中断遍历

### 3.3 `grep` — 代码搜索

文件：[src/tools/fs/grep.ts](src/tools/fs/grep.ts)

```
参数: { pattern, path?, glob?, output_mode?, A?, B?, C?, n?, i?, head_limit=100, ... }
    ↓
1. 定位 rgPath (@vscode/ripgrep 预编译二进制)
2. 参数映射为 rg 命令行参数
3. --glob !pattern 注入默认忽略
4. execa 执行 → 输出截断（head_limit）
5. exitCode === 1 特殊处理 → "No matches found"
```

**为什么用 ripgrep 而非 Node.js 遍历？**

`@vscode/ripgrep` 是预编译的 `rg` 二进制，Rust 实现，比 `fs.readFile` + 正则快 10-100 倍。大型仓库秒级返回。

**三种输出模式**：

| 模式 | 用途示例 | 典型输出量 |
|------|---------|-----------|
| `files_with_matches`（默认） | "哪个文件用了 useState？" | 小 |
| `content` | "具体怎么调用的，给我上下文" | 中 |
| `count` | "这个 API 影响了多少文件？" | 极小 |

**`head_limit` 默认 100**：前 100 条匹配足以让 LLM 推断模式。过多匹配反而稀释关键信息、浪费 token。

## 4. 文件编辑器：`text_editor`

文件：[src/tools/text-editor/editor.ts](src/tools/text-editor/editor.ts)

### 4.1 架构

`TextEditor` 是一个纯逻辑类，不持有文件句柄或缓冲区。每次操作独立 open → op → close，适合 Agent 的无状态工作模式。

```
text_editor 工具 { command, path, ... }
    ↓
command 路由:
  'view'        → TextEditor.view(path, viewRange?)
  'create'      → TextEditor.writeFile(path, fileText)
  'str_replace' → TextEditor.strReplace(path, oldStr, newStr)
  'insert'      → TextEditor.insert(path, insertLine, newStr)
```

### 4.2 四种子命令

**`view` — 带行号读取**

```
输入: path, view_range? [start, end]
输出: cat -n 风格，行号右对齐 3 位

  1 import React from 'react';
  2
  3 export const App = () => {
```

- `end = -1` 读至文件末尾
- `end > 行数` 自动截断，不抛错
- 1-indexed 行号（与编辑器一致），内部 slice 时转为 0-indexed

**`str_replace` — 精确字符串替换**

```
输入: path, old_str, new_str
逻辑: readFile → 检查包含 old_str → split/join 全量替换 → writeFile
返回: "Successfully replaced N occurrences"
```

- **严格匹配**：一个空格不对就失败。LLM 被指示 "失败后重新 view 确认准确内容"
- **全量替换**：`split(old).join(new)` 替换所有出现。LLM 需要提供足够长的 `old_str` 保证唯一性
- **删除即替换为空**：`new_str = ''`

**`insert` — 指定行插入**

```
输入: path, insert_line, new_str
逻辑: readFile → 按 \n 拆行 → splice(insertLine, 0, newStr) → writeFile
```

- `insert_line = 0`：文件开头
- `insert_line = lines.length`：文件末尾追加

**`create` — 新建或覆盖**

```
输入: path, file_text
逻辑: ensureDir(父目录) → writeFile
```

- 自动创建不存在的父目录
- 已存在的文件直接覆盖（与 Schema 描述一致）
- 目标为目录时拒绝

## 5. 终端工具：`bash`

文件：[src/tools/terminal/tool.ts](src/tools/terminal/tool.ts) + [src/tools/terminal/bash.ts](src/tools/terminal/bash.ts)

### 5.1 有状态终端

`BashTerminal` 类维护跨命令的 CWD：

```typescript
class BashTerminal {
    private _cwd: string;

    async execute(command: string): Promise<string> {
        // cd 被手动拦截，更新 _cwd
        if (command.startsWith('cd ')) {
            this._cwd = path.resolve(this._cwd, targetDir);
            return '';
        }
        // 其他命令在 _cwd 下执行
        const { stdout, stderr } = await execa(command, {
            cwd: this._cwd,
            shell: true,
            env: { ...process.env, TERM: 'dumb' },
        });
        return (stdout + stderr).trim();
    }
}
```

**为什么手动处理 `cd`？**

`execa` 在子进程中执行命令，子进程退出后 CWD 修改丢失。手动拦截 `cd` 更新内存中的 `_cwd`，模拟持久终端的目录切换行为。

**为什么 `TERM=dumb`？**

强制 CLI 工具输出纯文本，去掉 ANSI 颜色码。Agent 不需要颜色。

### 5.2 安全机制

`bash` 是唯一被 `humanInTheLoopMiddleware` 拦截的工具：

```
Agent 调 bash("rm -rf /tmp/*")
  → HITL 中间件中断
  → app.tsx 检测命令内容
  → 匹配 /(^|[;&|\s])(rm|rmdir)(\s|$)/ → 弹窗
  → 用户确认后继续
```

安全的命令（`ls`、`echo` 等）自动放行，不打断用户体验。

### 5.3 工具边界

Schema 描述中明确告诉 LLM 什么不能用 bash 做：

> "Use `ls`, `grep` and `tree` tools for file system operations instead of this tool."
> "Use `text_editor` tool with `create` command to create new files."

避免 LLM 绕过专用工具直接用 `bash ls`。专用工具有更好的输出格式、错误处理和忽略规则。

## 6. MCP 扩展工具

文件：[src/mcp/index.ts](src/mcp/index.ts)

```
loadMcpTools()
    ↓
1. 读取 mcp.json → 解析 mcpServers
2. streamable_http → sse 传输兼容
3. MultiServerMCPClient.getTools()
4. 返回 DynamicStructuredTool[] 合并到内置工具列表
```

**失败降级**：`mcp.json` 不存在或加载失败 → 返回 `[]`，不影响内置工具。错误信息写入 `debug.log`。

## 7. 工具与系统的协作

```
createAgent 注册 tools
       │
       ▼
┌──────────┐  HITL 拦截  ┌──────────┐
│   bash   │◀────────────│middleware│
└──────────┘             └──────────┘
       │
       ▼
  ToolMessage ──▶ app.tsx commitDraft() ──▶ chat-view.tsx 渲染
```

| 系统模块 | 与工具的交互 |
|---------|------------|
| `humanInTheLoopMiddleware` | 拦截 bash 调用，危险命令弹窗 |
| `summarizationMiddleware` | 压缩时保留最近 ToolMessage |
| `app.tsx` commitDraft | 从流式 chunk 合并 `tool_call_chunks` |
| `chat-view.tsx` | 渲染 ToolCall 指示器（图标 + 标签 + 详情） |
| `markdown-text.tsx` | 工具返回的 Markdown 代码块正常渲染 |
| `todoListMiddleware` | `todo_write` 通过中间件注册（非 `tools/` 目录） |

## 8. 关键文件

| 文件 | 职责 |
|------|------|
| `src/tools/fs/ls.ts` | 目录列表：排序、glob 过滤、绝对路径校验 |
| `src/tools/fs/tree.ts` | 目录树：递归遍历、深度限制、Unicode 绘制 |
| `src/tools/fs/grep.ts` | 代码搜索：ripgrep 封装、三模式、head_limit |
| `src/tools/fs/ignore.ts` | 统一忽略规则：70+ glob，三工具共用 |
| `src/tools/text-editor/editor.ts` | TextEditor 类：view/create/str_replace/insert |
| `src/tools/terminal/tool.ts` | bash 工具定义：Schema + HITL 描述 |
| `src/tools/terminal/bash.ts` | BashTerminal：有状态 CWD、cd 拦截、TERM=dumb |
| `src/tools/index.ts` | 统一导出入口 |
| `src/mcp/index.ts` | MCP 客户端：配置加载、传输兼容、工具提取 |

---

*最后更新：2026-05-31*
