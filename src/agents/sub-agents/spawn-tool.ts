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
