import { countTokensApproximately } from 'langchain';
import type { BaseMessage } from '@langchain/core/messages';

/** 模型上下文窗口大小（可配置） */
const DEFAULT_CONTEXT_WINDOW = 8192;

/** 安全使用率阈值，超过此比例触发保护 */
const SAFE_USAGE_RATIO = 0.7;

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
    contextWindow: number = DEFAULT_CONTEXT_WINDOW,
): number {
    const tokens = estimateTokens(messages);
    return Math.min(tokens / contextWindow, 1);
}

/**
 * 是否超过安全阈值，需要触发摘要/裁剪
 */
export function isContextOverloaded(
    messages: BaseMessage[],
    contextWindow: number = DEFAULT_CONTEXT_WINDOW,
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
    contextWindow: number = DEFAULT_CONTEXT_WINDOW,
): {
    tokens: number;
    usage: number;
    messageCount: number;
    label: string;
} {
    const tokens = estimateTokens(messages);
    const usage = Math.min(tokens / contextWindow, 1);

    let label: string;
    if (usage < 0.3) label = 'light';
    else if (usage < 0.6) label = 'moderate';
    else if (usage < 0.85) label = 'heavy';
    else label = 'critical';

    return {
        tokens,
        usage,
        messageCount: messages.length,
        label,
    };
}
