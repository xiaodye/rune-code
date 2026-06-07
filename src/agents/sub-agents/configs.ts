import { grepTool, lsTool, treeTool, textEditorTool, bashTool } from '@/tools';
import { bashReadonlyTool } from '@/tools/terminal/bash-readonly';
import type { SubAgentConfig } from './types';

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
