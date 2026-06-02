import { countTokensApproximately } from 'langchain';
import type { BaseMessage } from '@langchain/core/messages';

/** 安全使用率阈值，超过此比例触发保护 */
const SAFE_USAGE_RATIO = 0.7;

/** 未配置 LLM_CONTEXT_WINDOW 时的兜底上下文窗口大小 */
const DEFAULT_CONTEXT_WINDOW = 128_000;

/**
 * 获取当前模型的上下文窗口大小。
 * 优先级：LLM_CONTEXT_WINDOW 环境变量 > 兜底 128K
 *
 * 模型上下文窗口各不相同且经常变化（如 deepseek-v4-flash = 1M），
 * 查表维护成本高且容易出错，直接走显式配置。换模型时同步改 .env 即可。
 */
export function getContextWindow(): number {
    const envValue = process.env.LLM_CONTEXT_WINDOW;
    if (envValue) {
        const parsed = Number(envValue);
        if (!Number.isNaN(parsed) && parsed > 0) {
            return parsed;
        }
    }
    return DEFAULT_CONTEXT_WINDOW;
}

/**
 * 估算消息列表的 token 数
 * 使用 LangChain 内置的近似算法（字符数 / 4）
 */
export function estimateTokens(messages: BaseMessage[]): number {
    return countTokensApproximately(messages);
}

/**
 * 估算上下文使用率
 * @returns 0-1 之间的比例
 */
export function estimateContextUsage(
    messages: BaseMessage[],
    contextWindow?: number,
): number {
    const window = contextWindow ?? getContextWindow();
    const tokens = estimateTokens(messages);
    return Math.min(tokens / window, 1);
}

/**
 * 是否超过安全阈值，需要触发摘要/裁剪
 */
export function isContextOverloaded(
    messages: BaseMessage[],
    contextWindow?: number,
): boolean {
    return estimateContextUsage(messages, contextWindow) > SAFE_USAGE_RATIO;
}

/**
 * 格式化 token 数为可读字符串
 */
export function formatTokens(tokens: number): string {
    if (tokens >= 1000) {
        return `${(tokens / 1000).toFixed(1)}K`;
    }
    return String(tokens);
}

/**
 * 获取上下文使用情况摘要
 */
export function getContextSummary(
    messages: BaseMessage[],
    contextWindow?: number,
): {
    tokens: number;
    usage: number;
    messageCount: number;
    label: string;
} {
    const window = contextWindow ?? getContextWindow();
    const tokens = estimateTokens(messages);
    const usage = Math.min(tokens / window, 1);

    let label: string;
    if (usage < 0.4) label = 'light';
    else if (usage < 0.8) label = 'moderate';
    else if (usage < 0.9) label = 'heavy';
    else label = 'critical';

    return {
        tokens,
        usage,
        messageCount: messages.length,
        label,
    };
}
