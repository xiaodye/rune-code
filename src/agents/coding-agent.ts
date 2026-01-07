import { createAgent, summarizationMiddleware, humanInTheLoopMiddleware } from 'langchain';
import { StructuredTool } from '@langchain/core/tools';
import { initChatModel } from '@/models/chat-model';
import { ChatOpenAI } from '@langchain/openai';
import { project } from '@/project';
import { applyPromptTemplate } from '@/prompts/template';
import { bashTool, grepTool, lsTool, textEditorTool, todoWriteTool, treeTool } from '@/tools';
import { CodingAgentState } from './state';
import { MemorySaver } from '@langchain/langgraph';
import { loadMcpTools } from '@/mcp';
import { todoListMiddleware } from '@/middlewares/todo-list';

export async function createCodingAgent() {
    // const model = initChatModel();
    const model = new ChatOpenAI({
        modelName: process.env.LLM_MODEL,
        apiKey: process.env.LLM_API_KEY,
        configuration: {
            baseURL: process.env.LLM_API_BASE,
        },
        temperature: 0,
        maxTokens: Number(process.env.LLM_MAX_TOKENS),
        // streaming: true,
    });

    const mcpTools = await loadMcpTools();

    const tools = [
        bashTool,
        grepTool,
        lsTool,
        textEditorTool,
        // todoWriteTool,
        treeTool,
        ...mcpTools,
    ];

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
            // summarizationMiddleware({
            //     model,
            //     trigger: [{ tokens: 3000, messages: 6 }],
            //     keep: { messages: 20 },
            // }),
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
