import { createAgent, modelCallLimitMiddleware, humanInTheLoopMiddleware } from 'langchain';
import { ChatOpenAI } from '@langchain/openai';
import { getContextWindow } from '@/utils/token-counter';
import type { SubAgentConfig } from './types';

/**
 * 创建子 agent 实例。
 * 复用主 agent 相同的 model 配置（env vars），但无 summarization、无 todoList。
 * Coder 类型额外注入 HITL middleware，由 spawn-tool 内部自决（非冒泡到 CLI）。
 * _checkpointer 仅 Coder 需要（支持 interrupt-resume 循环）。
 */
export function createSubAgent(config: SubAgentConfig & { _checkpointer?: any }) {
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

    // 注入正确的上下文窗口大小，与主 agent 保持一致
    const contextWindow = getContextWindow();
    Object.defineProperty(model, 'profile', {
        get() {
            return { maxInputTokens: contextWindow };
        },
        configurable: true,
        enumerable: true,
    });

    const middleware: any[] = [
        modelCallLimitMiddleware({
            runLimit: config.modelCallLimit,
            exitBehavior: 'error',
        }),
    ];

    // Coder 需要 HITL middleware 拦截 bash 调用，由 spawn-tool 内部自动决策
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
        ...(config._checkpointer ? { checkpointer: config._checkpointer } : {}),
    });
}
