import { grepTool, lsTool, treeTool, textEditorTool } from '@/tools';
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
