import { createAgent, modelCallLimitMiddleware, summarizationMiddleware, humanInTheLoopMiddleware } from 'langchain';
import { ChatOpenAI } from '@langchain/openai';
import { project } from '@/project';
import { applyPromptTemplate } from '@/prompts/template';
import { bashTool, grepTool, lsTool, textEditorTool, treeTool } from '@/tools';
import { MemorySaver } from '@langchain/langgraph';
import { loadMcpTools } from '@/mcp';
import { todoListMiddleware } from '@/middlewares/todo-list';

export async function createCodingAgent() {
    const maxTokens = process.env.LLM_MAX_TOKENS
        ? Number(process.env.LLM_MAX_TOKENS)
        : undefined;

    const model = new ChatOpenAI({
        modelName: process.env.LLM_MODEL,
        apiKey: process.env.LLM_API_KEY,
        configuration: {
            baseURL: process.env.LLM_API_BASE,
        },
        temperature: 0,
        ...(maxTokens ? { maxTokens } : {}),
        // streaming: true,
    });

    const mcpTools = await loadMcpTools();

    const tools = [bashTool, grepTool, lsTool, textEditorTool, treeTool, ...mcpTools];

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
            // fraction = 上下文窗口占比，自适应不同模型（128K → ~19K 触发，32K → ~4.8K 触发）
            summarizationMiddleware({
                model,
                trigger: [
                    { fraction: 0.15, messages: 10 },  // 多轮对话，15% 窗口
                    { fraction: 0.25, messages: 6 },   // 少量但超长消息，25% 窗口
                ],
                keep: { messages: 24 },
            }),
            humanInTheLoopMiddleware({
                interruptOn: {
                    bash: {
                        allowedDecisions: ['approve', 'reject'],
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
