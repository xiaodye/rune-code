# Rune Code 终端 Markdown 渲染实现

本文档详细解析 CLI 中 Markdown 实时渲染的设计原理、架构决策与核心实现。

## 1. 问题背景

AI 模型输出的内容天然是 Markdown 格式 —— 包含 `**粗体**`、`` `代码` ``、` ```代码块``` `、`- 列表` 等语法。终端应用需要将这些标记语法转换为带样式的展示，而非原样显示 ASCII 符号。

### 技术约束

- **环境**：终端（Terminal），非浏览器 DOM
- **UI 框架**：Ink（React → Terminal ANSI），没有 CSS，没有 HTML 标签
- **流式输入**：LLM token 逐字到达，内容是不完整的 Markdown
- **样式手段**：粗体、暗色、下划线、删除线、8+16 色

## 2. 方案选型

| 方案                          | 思路                                 | 问题                                          |
| ----------------------------- | ------------------------------------ | --------------------------------------------- |
| `marked` → HTML → HTML 渲染   | 转 HTML 再用组件渲染                 | 终端不是浏览器，无 DOM                        |
| `marked-terminal`             | marked 插件，直接输出 ANSI 字符串    | 与 Ink 的 React 渲染模型冲突，Ink 自己管 ANSI |
| **`marked` lexer → Ink 组件** | marked 做词法分析，自己写 Ink 渲染器 | ✅ 完全控制，类型安全                         |

最终选择第三条路：用 `marked.lexer()` 做纯词法分析（不生成 HTML），然后逐 token 映射到 Ink 的 `<Text>` / `<Box>` 组件。

## 3. 核心架构：Token → Ink 组件映射

marked 做纯词法分析，然后直接将 token 树映射为 Ink 组件：

```
marked.lexer("Hello **world**")
    ↓
[{ type: "paragraph", tokens: [
    { type: "text",     text: "Hello " },
    { type: "strong",   tokens: [{ type: "text", text: "world" }] },
]}]
    ↓ renderBlock → renderInline
<Box marginTop={1}>
    <Text wrap="wrap">
        Hello <Text bold>world</Text>
    </Text>
</Box>
```

**关键函数**：
- `renderBlock(token)` — 处理块级 token（paragraph / heading / code / list / table / blockquote），返回 `<Box>`
- `renderInline(tokens)` — 递归处理行内 token（strong / em / codespan / link），返回嵌套 `<Text>`

`renderInline` 的递归是核心——`**粗体**` 映射为 `<Text bold>`，`***粗斜体***` 自动双层嵌套为 `<Text bold><Text dimColor>`，文本节点返回纯字符串。

## 4. 块级元素渲染

### 6.1 段落 & 标题

```
renderBlock:
  paragraph → flattenInline → renderSegments
  heading   → flattenInline → renderSegments({ bold, color })
```

标题按深度有 6 级颜色（`#FFD700` → `#B0C4DE`）。H1 额外加 `━ ━ ━ ` 前缀强调。

### 6.2 代码块

```tsx
<Box borderStyle="round" borderColor="gray" paddingX={1}>
    {lang ? <Text dimColor>{lang}</Text> : null}
    <Text color="green">{codeText}</Text>
</Box>
```

- 圆角边框（`round`）模拟 Markdown 代码块背景
- 绿色文字突出代码区域
- 语言标签灰显在顶部

### 6.3 引用块

```tsx
<Box flexDirection="row">
    <Box width={2}>
        <Text dimColor>│</Text>
    </Box>{' '}
    {/* 左边竖线 */}
    <Box flexDirection="column">{childBlocks}</Box> {/* 内容递归 */}
</Box>
```

递归渲染内部块级元素，每行左侧加灰色 `│` 前缀。

### 6.4 列表

```tsx
<Box flexDirection="row">
    <Box width={3}>
        <Text>• </Text>
    </Box>{' '}
    {/* 固定宽度符号 */}
    <Box flexDirection="column">{itemBlocks}</Box> {/* 内容递归 */}
</Box>
```

- 无序列表用 `•`，有序列表用 `1. ` `2. `
- 符号列固定 3 字符宽度，保证内容对齐
- 列表项内部递归渲染（支持嵌套列表、代码块等）

### 6.5 表格

- 自动计算列宽（遍历所有行取最大文本长度 + 2 padding）
- 表头粗体 + 分隔线
- 每列独立 `<Box width={padded[ci]}>` 实现对齐

## 5. 样式映射表

| Markdown | 标记语法      | 输出样式                                   |
| -------- | ------------- | ------------------------------------------ |
| 粗体     | `**text**`    | `<Text bold>`                              |
| 斜体     | `*text*`      | `<Text dimColor>`（终端鲜少支持真斜体）    |
| 删除线   | `~~text~~`    | `<Text dimColor strikethrough>`            |
| 行内代码 | `` `code` ``  | `<Text color="cyan">`                      |
| 链接     | `[text](url)` | `<Text underline color="blue">` + 灰显 URL |
| 图片     | `![alt](url)` | 灰显 `[Image: alt]` 占位符                 |
| 换行     | 两空格 + 回车 | 字面 `\n`                                  |
| HTML     | `<tag>`       | 灰显原文字（安全，不执行）                 |

## 6. 流式兼容

`marked.lexer()` 对不完整 Markdown 容忍度高：

| 流式片段            | 解析结果                                   |
| ------------------- | ------------------------------------------ |
| `**Hello Wor`       | 纯文本段落（未闭合 `**` 当字面量，不报错） |
| `**Hello World**`   | 下一 token 到齐后立刻切为粗体              |
| `` `partial code `` | 未闭合的反引号当字面量                     |
| ` ```js\ncode`      | 代码块正常渲染，未闭合的结尾不影响         |
| `- item\n- `        | 列表正常，空项无异常                       |

每次 `streamingContent` 更新 → `MarkdownText` 重新 `marked.lexer()` → React 协调差异更新。marked 的 lexer 是纯词法分析（微秒级），不会造成性能瓶颈。

## 7. 关键文件

| 文件                                   | 职责                                                                      |
| -------------------------------------- | ------------------------------------------------------------------------- |
| `src/cli/components/markdown-text.tsx` | Markdown → Ink 渲染器：`flattenInline` + `renderSegments` + `renderBlock` |
| `src/cli/components/chat-view.tsx`     | 消费方：AI 消息和流式内容都通过 `<MarkdownText>` 渲染                     |

---

_最后更新：2026-05-31_
