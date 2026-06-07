import { createAgent, modelCallLimitMiddleware, humanInTheLoopMiddleware } from 'langchain';
import { ChatOpenAI } from '@langchain/openai';
import { getContextWindow } from '@/utils/token-counter';
import type { SubAgentConfig } from './types';

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
