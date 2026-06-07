import {
    createAgent,
    modelCallLimitMiddleware,
    summarizationMiddleware,
    humanInTheLoopMiddleware,
} from 'langchain';
import { ChatOpenAI } from '@langchain/openai';
import { project } from '@/project';
import { applyPromptTemplate } from '@/prompts/template';
import { bashTool, grepTool, lsTool, textEditorTool, treeTool } from '@/tools';
import { MemorySaver } from '@langchain/langgraph';
import { loadMcpTools } from '@/mcp';
import { todoListMiddleware } from '@/middlewares/todo-list';
import { getContextWindow } from '@/utils/token-counter';
import { spawnAgentTool } from './sub-agents/spawn-tool';

export async function createCodingAgent() {
    const maxTokens = process.env.LLM_MAX_TOKENS ? Number(process.env.LLM_MAX_TOKENS) : undefined;

    const model = new ChatOpenAI({
        modelName: process.env.LLM_MODEL,
        apiKey: process.env.LLM_API_KEY,
        configuration: {
            baseURL: process.env.LLM_API_BASE,
        },
        temperature: 0.3,
        ...(maxTokens ? { maxTokens } : {}),
        // streaming: true,
    });

    // langchain 内置的 getModelContextSize 只覆盖 OpenAI/Anthropic 模型，
    // 对 DeepSeek/豆包等返回错误兜底值 4097，导致 fraction 计算完全错误。
    // 通过重写 profile getter 注入正确的上下文窗口，让 fraction 正确生效。
    // 优先级：LLM_CONTEXT_WINDOW 环境变量 > 模型名查表 > 兜底 128K
    const contextWindow = getContextWindow();
    Object.defineProperty(model, 'profile', {
        get() {
            return { maxInputTokens: contextWindow };
        },
        configurable: true,
        enumerable: true,
    });

    const mcpTools = await loadMcpTools();

    const tools = [bashTool, grepTool, lsTool, textEditorTool, treeTool, spawnAgentTool, ...mcpTools];

    const systemPrompt = applyPromptTemplate('coding_agent', {
        PROJECT_ROOT: project.rootDir,
    });

    const checkpointer = new MemorySaver();

    const codingAgent = createAgent({
        model,
        tools,
        systemPrompt,
        middleware: [
            todoListMiddleware(),
            // 单次运行最多 25 次 LLM 调用，防止 tool call 死循环
            modelCallLimitMiddleware({ runLimit: 25, exitBehavior: 'error' }),
            // 上下文摘要：当对话历史超过模型上下文窗口的指定比例时，
            // 自动将旧消息压缩为 SystemMessage 摘要，保留最近原文。
            // fraction 正确性由上方 Object.defineProperty 注入 profile.maxInputTokens 保证。
            // 阈值参考业界标准：
            //   - Claude Code: ~80% 窗口触发
            //   - OpenAI Codex: ~95% 有效窗口触发
            // 两层触发：60% 留给多轮对话充足余量，85% 应对少量超长消息（如大文件）
            summarizationMiddleware({
                model,
                trigger: [
                    // 多轮对话：达到 80% 窗口 + 6 条以上消息时触发
                    { fraction: 0.8, messages: 6 },
                    // 少量超长消息：达到 90% 窗口 + 3 条以上消息时紧急触发
                    { fraction: 0.9, messages: 3 },
                ],
                // 保留最近 25% 窗口的原文（128K → ~32K，200K → ~50K）
                keep: { fraction: 0.25 },
            }),
            humanInTheLoopMiddleware({
                interruptOn: {
                    bash: {
                        allowedDecisions: ['approve', 'edit', 'reject'],
                        description: 'Sensitive command execution',
                    },
                },
            }),
        ],
        checkpointer,
        // stateSchema: CodingAgentState,
    });

    return codingAgent;
}

// 调试使用
export const agent = createCodingAgent();
