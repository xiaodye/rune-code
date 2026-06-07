import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { HumanMessage } from '@langchain/core/messages';
import { Command, type StateSnapshot } from '@langchain/langgraph';
import { MemorySaver } from '@langchain/langgraph';
import { createSubAgent } from './create';
import { getExplorerConfig, getCoderConfig } from './configs';
import { assessRisk } from '@/safety/danger-engine';
import type { SubAgentType, SubAgentConfig } from './types';

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
    const coderAgent = createSubAgent({ ...config, _checkpointer: checkpointer });

    const threadId = `coder-${Date.now()}`;
    const configurable = { configurable: { thread_id: threadId } };

    let input: { messages: any[] } | Command = {
        messages: [new HumanMessage(prompt)],
    };

    const MAX_INTERRUPTS = 10;
    for (let i = 0; i < MAX_INTERRUPTS; i++) {
        const result = await coderAgent.invoke(input, {
            ...configurable,
            recursionLimit: 50,
        });

        const state: StateSnapshot = await coderAgent.getState(configurable);
        const tasks = state.tasks;

        if (!tasks || tasks.length === 0 || !tasks[0].interrupts || tasks[0].interrupts.length === 0) {
            const messages = result.messages;
            for (let j = messages.length - 1; j >= 0; j--) {
                const msg = messages[j];
                if (msg._getType() === 'ai' && typeof msg.content === 'string' && msg.content) {
                    return msg.content;
                }
            }
            return '子 agent 未返回有效结果。';
        }

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

        if (decisions.length === 0) {
            decisions.push({ type: 'approve' });
        }

        input = new Command({ resume: decisions });
    }

    return '子 agent 达到最大中断处理次数，执行终止。';
}

export const spawnAgentTool = tool(
    async ({ type, task, context }) => {
        const config = getConfig(type as SubAgentType);
        const prompt = context ? `背景信息：\n${context}\n\n任务：${task}` : `任务：${task}`;

        try {
            if (type === 'coder') {
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
