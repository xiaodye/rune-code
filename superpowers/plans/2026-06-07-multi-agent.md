# Multi-Agent 架构实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 Rune Code 实现统一轻量级 multi-agent 架构（spawn_agent tool + Explorer/Coder/Reviewer 子 agent）

**Architecture:** 主 agent 新增 `spawn_agent` tool，tool 内部创建临时 agent 实例执行任务后返回摘要。三种子 agent 统一走轻量模式：用完即弃、摘要回传、无流式透传。Coder 内部 HITL 自决（dangerous+ 自动拒绝）。

**Tech Stack:** LangGraph ^1.3.2, @langchain/core tools, @langchain/openai ChatOpenAI, zod, execa

---

## File Structure

```
src/agents/sub-agents/
├── types.ts          — SubAgentType enum, SubAgentConfig interface
├── configs.ts        — explorer/coder/reviewer 配置（tools, prompt, middleware）
├── create.ts         — createSubAgent() 工厂函数
└── spawn-tool.ts     — spawn_agent tool 定义 + Coder HITL 自决逻辑

src/tools/terminal/
└── bash-readonly.ts  — Reviewer 专用只读 bash tool

src/agents/coding-agent.ts  — 修改：tools 列表加入 spawnAgentTool
src/prompts/templates/coding_agent.md — 修改：追加路由指引
```

---

## Phase 1: 基础设施 + Explorer

### Task 1: 类型定义

**Files:**
- Create: `src/agents/sub-agents/types.ts`

- [ ] **Step 1: 创建类型文件**

```typescript
// src/agents/sub-agents/types.ts
import type { StructuredToolInterface } from '@langchain/core/tools';

export type SubAgentType = 'explorer' | 'coder' | 'reviewer';

export interface SubAgentConfig {
    type: SubAgentType;
    tools: StructuredToolInterface[];
    systemPrompt: string;
    modelCallLimit: number;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/agents/sub-agents/types.ts
git commit -m "feat(sub-agents): add type definitions for multi-agent system"
```

---

### Task 2: createSubAgent 工厂函数

**Files:**
- Create: `src/agents/sub-agents/create.ts`

- [ ] **Step 1: 实现工厂函数**

```typescript
// src/agents/sub-agents/create.ts
import { createAgent, modelCallLimitMiddleware, humanInTheLoopMiddleware } from 'langchain';
import { ChatOpenAI } from '@langchain/openai';
import { getContextWindow } from '@/utils/token-counter';
import type { SubAgentConfig } from './types';

export function createSubAgent(config: SubAgentConfig) {
    const model = new ChatOpenAI({
        modelName: process.env.LLM_MODEL,
        apiKey: process.env.LLM_API_KEY,
        configuration: {
            baseURL: process.env.LLM_API_BASE,
        },
        temperature: 0.3,
        ...(process.env.LLM_MAX_TOKENS
            ? { maxTokens: Number(process.env.LLM_MAX_TOKENS) }
            : {}),
    });

    const contextWindow = getContextWindow();
    Object.defineProperty(model, 'profile', {
        get() {
            return { maxInputTokens: contextWindow };
        },
        configurable: true,
        enumerable: true,
    });

    const middleware = [
        modelCallLimitMiddleware({
            runLimit: config.modelCallLimit,
            exitBehavior: 'error',
        }),
    ];

    // Coder 需要 HITL middleware（内部自决）
    if (config.type === 'coder') {
        middleware.push(
            humanInTheLoopMiddleware({
                interruptOn: {
                    bash: {
                        allowedDecisions: ['approve', 'reject'],
                    },
                },
            }),
        );
    }

    return createAgent({
        model,
        tools: config.tools,
        systemPrompt: config.systemPrompt,
        middleware,
    });
}
```

- [ ] **Step 2: Commit**

```bash
git add src/agents/sub-agents/create.ts
git commit -m "feat(sub-agents): add createSubAgent factory function"
```

---

### Task 3: Explorer 配置

**Files:**
- Create: `src/agents/sub-agents/configs.ts`

- [ ] **Step 1: 实现 Explorer 配置**

```typescript
// src/agents/sub-agents/configs.ts
import { grepTool, lsTool, treeTool, textEditorTool } from '@/tools';
import type { SubAgentConfig } from './types';

// Explorer 使用 text_editor 的 view 命令作为 read_file
// 因为项目中没有独立的 read_file tool，text_editor view 即可读取文件
const EXPLORER_PROMPT = `你是代码探索助手，只负责搜索和阅读代码。

你的任务是高效地搜索和阅读代码，然后返回结构化摘要。

**输出格式：**
1. 关键发现（1-3 句话总结）
2. 相关文件路径列表
3. 关键代码片段（如有必要）

**规则：**
- 只使用搜索和阅读工具，不要修改任何文件
- 保持摘要简洁，≤300 tokens
- 如果找不到相关内容，明确说明`;

export function getExplorerConfig(): SubAgentConfig {
    return {
        type: 'explorer',
        tools: [grepTool, lsTool, treeTool, textEditorTool],
        systemPrompt: EXPLORER_PROMPT,
        modelCallLimit: 15,
    };
}
```

- [ ] **Step 2: Commit**

```bash
git add src/agents/sub-agents/configs.ts
git commit -m "feat(sub-agents): add Explorer agent configuration"
```

---

### Task 4: spawn_agent Tool 基础框架

**Files:**
- Create: `src/agents/sub-agents/spawn-tool.ts`

- [ ] **Step 1: 实现 spawn_agent tool（Explorer only）**

```typescript
// src/agents/sub-agents/spawn-tool.ts
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { HumanMessage } from '@langchain/core/messages';
import { createSubAgent } from './create';
import { getExplorerConfig } from './configs';
import type { SubAgentType } from './types';

function getConfig(type: SubAgentType) {
    switch (type) {
        case 'explorer':
            return getExplorerConfig();
        default:
            throw new Error(`Sub-agent type "${type}" is not yet implemented`);
    }
}

export const spawnAgentTool = tool(
    async ({ type, task, context }) => {
        const config = getConfig(type as SubAgentType);
        const agent = createSubAgent(config);

        const prompt = context ? `背景信息：\n${context}\n\n任务：${task}` : `任务：${task}`;

        try {
            const result = await agent.invoke({
                messages: [new HumanMessage(prompt)],
            });

            // 提取最终 AIMessage 文本
            const messages = result.messages;
            for (let i = messages.length - 1; i >= 0; i--) {
                const msg = messages[i];
                if (msg._getType() === 'ai' && typeof msg.content === 'string' && msg.content) {
                    return msg.content;
                }
            }

            return '子 agent 未返回有效结果。';
        } catch (error: any) {
            return `子 agent 执行失败: ${error.message}`;
        }
    },
    {
        name: 'spawn_agent',
        description: `派生子 agent 执行独立子任务，结果摘要回传到主上下文。用于上下文隔离和复杂任务分解。

使用原则：
- explorer: 探索性任务（搜索多个文件、理解代码结构），预估需要 3+ 次搜索时使用
- coder: 复杂编码（多文件修改、反复调试），涉及 5+ 个工具调用时使用
- reviewer: 代码审查（变更后验证质量），完成重要变更后使用

注意：子 agent 看不到你的对话历史，通过 context 传递必要背景。`,
        schema: z.object({
            type: z.enum(['explorer', 'coder', 'reviewer']).describe('子 agent 类型'),
            task: z.string().describe('交给子 agent 的任务描述'),
            context: z
                .string()
                .optional()
                .describe('传递给子 agent 的背景信息（≤500 tokens）'),
        }),
    },
);
```

- [ ] **Step 2: Commit**

```bash
git add src/agents/sub-agents/spawn-tool.ts
git commit -m "feat(sub-agents): implement spawn_agent tool with Explorer support"
```

---

### Task 5: 主 Agent 集成 spawn_agent

**Files:**
- Modify: `src/agents/coding-agent.ts:10,45`

- [ ] **Step 1: 在 coding-agent.ts 中导入并注册 spawn_agent tool**

在 import 区域添加：
```typescript
import { spawnAgentTool } from './sub-agents/spawn-tool';
```

修改 tools 数组（第 45 行）：
```typescript
const tools = [bashTool, grepTool, lsTool, textEditorTool, treeTool, spawnAgentTool, ...mcpTools];
```

- [ ] **Step 2: 验证 TypeScript 编译通过**

Run: `npx tsc --noEmit`
Expected: 无错误输出

- [ ] **Step 3: Commit**

```bash
git add src/agents/coding-agent.ts
git commit -m "feat(sub-agents): integrate spawn_agent tool into main agent"
```

---

### Task 6: 主 Agent Prompt 路由指引

**Files:**
- Modify: `src/prompts/templates/coding_agent.md`

- [ ] **Step 1: 在 coding_agent.md 末尾追加路由指引**

追加以下内容到模板末尾：

```markdown
## spawn_agent 使用原则

你可以使用 spawn_agent 工具派生子 agent 执行独立子任务，子 agent 有独立上下文，结果摘要回传。

**何时使用：**
1. 简单任务（改一个函数、加注释）→ 直接用你的工具，不要 spawn
2. 探索性任务（搜索多个文件、理解代码结构）→ spawn explorer
   - 当预估需要 3+ 次文件读取/搜索时
   - 当搜索结果可能很长但你只需要摘要时
3. 复杂编码（多文件修改、需要反复调试）→ spawn coder
   - 当任务涉及 5+ 个工具调用时
   - 当中间输出（编译错误、测试日志）会占用大量上下文时
4. 代码审查（变更后验证质量）→ spawn reviewer
   - 完成重要变更后自动触发

**注意：**
- 子 agent 看不到你的对话历史，你需要通过 context 参数传递必要背景
- 子 agent 返回的是摘要文本，你基于摘要决定下一步
- 可以并行 spawn 多个 explorer，但 coder 同时只能有 1 个
```

- [ ] **Step 2: Commit**

```bash
git add src/prompts/templates/coding_agent.md
git commit -m "feat(sub-agents): add routing guidance to main agent prompt"
```

---

### Task 7: 端到端验证 Explorer

- [ ] **Step 1: TypeScript 全量编译检查**

Run: `npx tsc --noEmit`
Expected: 无错误

- [ ] **Step 2: 手动测试 Explorer**

启动应用，输入一条触发 explorer 的指令，例如：
> "帮我搜索项目中所有和 middleware 相关的代码，给我一个摘要"

验证：
- 主 agent 调用了 spawn_agent(type='explorer', task='...')
- 子 agent 返回了代码搜索摘要
- 摘要正确出现在对话中

---

## Phase 2: Coder + 内部 HITL 自决

### Task 8: Coder 配置

**Files:**
- Modify: `src/agents/sub-agents/configs.ts`

- [ ] **Step 1: 添加 Coder 配置**

在 `configs.ts` 中追加：

```typescript
import { bashTool } from '@/tools';

const CODER_PROMPT = `你是编码助手，负责实现指定的编码任务。

**规则：**
- 完成任务后报告变更摘要：改了哪些文件、做了什么修改、测试是否通过
- 如果某个 bash 命令被安全策略拒绝，不要重试，换一种安全的方式完成任务
- 保持代码简洁，遵循项目现有风格
- 修改完成后尝试运行相关测试验证正确性

**输出格式：**
1. 变更摘要（做了什么）
2. 修改的文件列表
3. 测试结果（如果跑了测试）`;

export function getCoderConfig(): SubAgentConfig {
    return {
        type: 'coder',
        tools: [bashTool, textEditorTool, grepTool, lsTool, treeTool],
        systemPrompt: CODER_PROMPT,
        modelCallLimit: 25,
    };
}
```

- [ ] **Step 2: Commit**

```bash
git add src/agents/sub-agents/configs.ts
git commit -m "feat(sub-agents): add Coder agent configuration"
```

---

### Task 9: Coder HITL 自决逻辑

**Files:**
- Modify: `src/agents/sub-agents/spawn-tool.ts`

- [ ] **Step 1: 实现 Coder 的 HITL 自决循环**

修改 `spawn-tool.ts`，将 `getConfig` switch 加入 coder case，并重写 spawn 逻辑以支持 Coder 的 interrupt-resume 循环：

```typescript
import { Command, type StateSnapshot } from '@langchain/langgraph';
import { MemorySaver } from '@langchain/langgraph';
import { assessRisk } from '@/safety/danger-engine';
import { getExplorerConfig, getCoderConfig } from './configs';

// Coder 互斥锁
let coderLock: Promise<void> = Promise.resolve();

function getConfig(type: SubAgentType) {
    switch (type) {
        case 'explorer':
            return getExplorerConfig();
        case 'coder':
            return getCoderConfig();
        default:
            throw new Error(`Sub-agent type "${type}" is not yet implemented`);
    }
}

async function runCoderAgent(config: SubAgentConfig, prompt: string): Promise<string> {
    const checkpointer = new MemorySaver();
    const agent = createSubAgent(config);
    // Coder 需要 checkpointer 来支持 interrupt-resume
    const coderAgent = createSubAgent({ ...config, _checkpointer: checkpointer });

    const threadId = `coder-${Date.now()}`;
    const configurable = { configurable: { thread_id: threadId } };

    let input: { messages: any[] } | Command = {
        messages: [new HumanMessage(prompt)],
    };

    // 循环处理 HITL 中断
    const MAX_INTERRUPTS = 10;
    for (let i = 0; i < MAX_INTERRUPTS; i++) {
        const result = await coderAgent.invoke(input, {
            ...configurable,
            recursionLimit: 50,
        });

        // 检查是否有 interrupt
        const state: StateSnapshot = await coderAgent.getState(configurable);
        const tasks = state.tasks;

        if (!tasks || tasks.length === 0 || !tasks[0].interrupts || tasks[0].interrupts.length === 0) {
            // 无中断，正常完成 — 提取最终回复
            const messages = result.messages;
            for (let j = messages.length - 1; j >= 0; j--) {
                const msg = messages[j];
                if (msg._getType() === 'ai' && typeof msg.content === 'string' && msg.content) {
                    return msg.content;
                }
            }
            return '子 agent 未返回有效结果。';
        }

        // 有中断：评估风险并自动决策
        const interruptValue = tasks[0].interrupts[0].value as any;
        const actionRequests = Array.isArray(interruptValue?.actionRequests)
            ? interruptValue.actionRequests
            : [];

        const decisions = actionRequests.map((action: any) => {
            if (action.name === 'bash' && action.args?.command) {
                const assessment = assessRisk(action.args.command);
                if (assessment.level === 'dangerous' || assessment.level === 'critical') {
                    return { type: 'reject' };
                }
            }
            return { type: 'approve' };
        });

        // 如果没有 actionRequests，默认 approve
        if (decisions.length === 0) {
            decisions.push({ type: 'approve' });
        }

        input = new Command({ resume: decisions });
    }

    return '子 agent 达到最大中断处理次数，执行终止。';
}
```

- [ ] **Step 2: 修改 spawnAgentTool 使用 Coder 专属流程**

在 tool handler 中区分 coder 和其他类型：

```typescript
export const spawnAgentTool = tool(
    async ({ type, task, context }) => {
        const config = getConfig(type as SubAgentType);
        const prompt = context ? `背景信息：\n${context}\n\n任务：${task}` : `任务：${task}`;

        try {
            if (type === 'coder') {
                // Coder 走互斥锁 + HITL 自决流程
                let result: string;
                const prevLock = coderLock;
                let releaseLock: () => void;
                coderLock = new Promise((resolve) => { releaseLock = resolve; });
                await prevLock;
                try {
                    result = await runCoderAgent(config, prompt);
                } finally {
                    releaseLock!();
                }
                return result;
            }

            // Explorer/Reviewer 走简单 invoke 流程
            const agent = createSubAgent(config);
            const agentResult = await agent.invoke({
                messages: [new HumanMessage(prompt)],
            });

            const messages = agentResult.messages;
            for (let i = messages.length - 1; i >= 0; i--) {
                const msg = messages[i];
                if (msg._getType() === 'ai' && typeof msg.content === 'string' && msg.content) {
                    return msg.content;
                }
            }
            return '子 agent 未返回有效结果。';
        } catch (error: any) {
            return `子 agent 执行失败: ${error.message}`;
        }
    },
    // ... schema 不变
);
```

- [ ] **Step 3: 更新 createSubAgent 支持 checkpointer 参数**

在 `create.ts` 中的 `SubAgentConfig` 扩展和 `createSubAgent` 函数：

```typescript
import { MemorySaver } from '@langchain/langgraph';

// 在 createAgent 调用中加入可选的 checkpointer
export function createSubAgent(config: SubAgentConfig & { _checkpointer?: MemorySaver }) {
    // ... 现有代码 ...

    return createAgent({
        model,
        tools: config.tools,
        systemPrompt: config.systemPrompt,
        middleware,
        ...(config._checkpointer ? { checkpointer: config._checkpointer } : {}),
    });
}
```

- [ ] **Step 4: 验证编译**

Run: `npx tsc --noEmit`
Expected: 无错误

- [ ] **Step 5: Commit**

```bash
git add src/agents/sub-agents/spawn-tool.ts src/agents/sub-agents/create.ts
git commit -m "feat(sub-agents): implement Coder HITL self-decision loop with mutex"
```

---

### Task 10: 端到端验证 Coder

- [ ] **Step 1: 测试安全命令自动放行**

输入触发 coder 的指令：
> "帮我在 src/utils/ 下创建一个 hello.ts 文件，内容为 export const hello = 'world'"

验证：coder 子 agent 使用 text_editor 或 bash 完成创建，返回变更摘要。

- [ ] **Step 2: 测试危险命令自动拒绝**

输入：
> "帮我用 spawn_agent coder 执行 rm -rf /"

验证：coder 内部 assessRisk 返回 critical，自动 reject，子 agent 调整策略或报告无法执行。

- [ ] **Step 3: 清理测试文件**

```bash
rm -f src/utils/hello.ts
```

---

## Phase 3: Reviewer + bash_readonly

### Task 11: bash_readonly Tool

**Files:**
- Create: `src/tools/terminal/bash-readonly.ts`

- [ ] **Step 1: 实现 bash_readonly tool**

```typescript
// src/tools/terminal/bash-readonly.ts
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { getTerminal } from './bash';

const ALLOWED_COMMANDS: RegExp[] = [
    /^\s*git\s+(diff|log|show|status|branch|rev-parse)/,
    /^\s*npm\s+(test|run\s+test|run\s+lint|run\s+typecheck)/,
    /^\s*npx\s+tsc(\s+--noEmit)?/,
    /^\s*npx\s+(jest|vitest|mocha|eslint)/,
    /^\s*cat\s/,
    /^\s*head\s/,
    /^\s*tail\s/,
    /^\s*wc\s/,
    /^\s*diff\s/,
    /^\s*echo\s/,
];

function isCommandAllowed(command: string): boolean {
    return ALLOWED_COMMANDS.some((pattern) => pattern.test(command.trim()));
}

export const bashReadonlyTool = tool(
    async ({ command }) => {
        if (!isCommandAllowed(command)) {
            return `Command not allowed in readonly mode: ${command}\n\nAllowed commands: git (diff/log/show/status/branch), npm test/lint, npx tsc/jest/vitest, cat, head, tail, wc, diff, echo`;
        }

        const terminal = getTerminal();
        const output = await terminal.execute(command);
        return `\`\`\`\n${output}\n\`\`\``;
    },
    {
        name: 'bash_readonly',
        description: `Execute read-only bash commands for code review purposes.

Allowed commands:
- git diff/log/show/status/branch
- npm test/run test/run lint
- npx tsc --noEmit / jest / vitest / eslint
- cat / head / tail / wc / diff / echo

All other commands will be rejected.`,
        schema: z.object({
            command: z.string().describe('The read-only command to execute.'),
        }),
    },
);
```

- [ ] **Step 2: Commit**

```bash
git add src/tools/terminal/bash-readonly.ts
git commit -m "feat(tools): add bash_readonly tool for Reviewer agent"
```

---

### Task 12: Reviewer 配置

**Files:**
- Modify: `src/agents/sub-agents/configs.ts`

- [ ] **Step 1: 添加 Reviewer 配置**

在 `configs.ts` 中追加：

```typescript
import { bashReadonlyTool } from '@/tools/terminal/bash-readonly';

const REVIEWER_PROMPT = `你是代码审查者，负责审查代码变更并验证质量。

**工作流程：**
1. 用 git diff 查看变更内容
2. 用 grep/ls 查看相关上下文
3. 用 bash_readonly 跑测试和类型检查
4. 输出审查结论

**输出格式：**
## 结论：PASS 或 FAIL

## 问题列表（如有）
- [文件:行号] 问题描述

## 测试结果
- 类型检查：PASS/FAIL
- 单元测试：PASS/FAIL（如适用）

**规则：**
- 关注正确性 bug、类型安全、边界情况
- 不要关注代码风格（留给 linter）
- 如果测试通过且无明显 bug，给 PASS`;

export function getReviewerConfig(): SubAgentConfig {
    return {
        type: 'reviewer',
        tools: [bashReadonlyTool, grepTool, lsTool, treeTool],
        systemPrompt: REVIEWER_PROMPT,
        modelCallLimit: 15,
    };
}
```

- [ ] **Step 2: Commit**

```bash
git add src/agents/sub-agents/configs.ts
git commit -m "feat(sub-agents): add Reviewer agent configuration"
```

---

### Task 13: spawn-tool 集成 Reviewer

**Files:**
- Modify: `src/agents/sub-agents/spawn-tool.ts`

- [ ] **Step 1: 在 getConfig 中加入 reviewer case**

```typescript
import { getExplorerConfig, getCoderConfig, getReviewerConfig } from './configs';

function getConfig(type: SubAgentType) {
    switch (type) {
        case 'explorer':
            return getExplorerConfig();
        case 'coder':
            return getCoderConfig();
        case 'reviewer':
            return getReviewerConfig();
    }
}
```

- [ ] **Step 2: 验证编译**

Run: `npx tsc --noEmit`
Expected: 无错误

- [ ] **Step 3: Commit**

```bash
git add src/agents/sub-agents/spawn-tool.ts
git commit -m "feat(sub-agents): integrate Reviewer into spawn_agent tool"
```

---

### Task 14: 端到端验证 Reviewer

- [ ] **Step 1: 测试 Reviewer**

先做一个小修改（如添加注释），然后输入：
> "帮我 review 一下当前的 git diff"

验证：
- 主 agent 调用 spawn_agent(type='reviewer')
- Reviewer 子 agent 执行 git diff、npx tsc --noEmit
- 返回 PASS/FAIL 结论

- [ ] **Step 2: 测试 bash_readonly 拒绝**

在 Reviewer 上下文中验证如果 LLM 尝试执行 `rm` 等命令会被拒绝：
验证 bash_readonly 返回 "Command not allowed in readonly mode"

---

## Phase 4: 优化

### Task 15: 错误处理增强

**Files:**
- Modify: `src/agents/sub-agents/spawn-tool.ts`

- [ ] **Step 1: 添加超时和更好的错误摘要**

在 spawn tool handler 的 try/catch 中增强错误信息：

```typescript
try {
    // ... existing logic ...
} catch (error: any) {
    if (error.message?.includes('runLimit')) {
        return `子 agent 达到工具调用上限（${config.modelCallLimit} 次），任务可能过于复杂。请尝试拆分为更小的子任务。`;
    }
    if (error.message?.includes('recursion')) {
        return `子 agent 执行深度超限，任务可能陷入循环。请检查任务描述是否明确。`;
    }
    return `子 agent 执行失败: ${error.message}`;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/agents/sub-agents/spawn-tool.ts
git commit -m "feat(sub-agents): improve error messages for agent failures"
```

---

### Task 16: 最终编译验证与清理

- [ ] **Step 1: 全量编译检查**

Run: `npx tsc --noEmit`
Expected: 无错误

- [ ] **Step 2: 确认文件结构完整**

Run: `find src/agents/sub-agents -type f && find src/tools/terminal -type f`

Expected:
```
src/agents/sub-agents/types.ts
src/agents/sub-agents/create.ts
src/agents/sub-agents/configs.ts
src/agents/sub-agents/spawn-tool.ts
src/tools/terminal/tool.ts
src/tools/terminal/bash.ts
src/tools/terminal/bash-readonly.ts
```

- [ ] **Step 3: 最终 commit（如有未提交的修改）**

```bash
git add -A
git commit -m "feat(sub-agents): complete multi-agent architecture implementation"
```
