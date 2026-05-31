import { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import SelectInput from 'ink-select-input';
import { AIMessage, AIMessageChunk, BaseMessage, HumanMessage, SystemMessage, ToolCall, ToolCallChunk, ToolMessage } from '@langchain/core/messages';
import { Command, StateSnapshot } from '@langchain/langgraph';
import { createCodingAgent } from '@/agents/coding-agent';
import { getContextSummary } from '@/utils/token-counter';
import { ChatView } from './components/chat-view';
import { ChatInput } from './components/chat-input';
import { Banner } from './components/banner';
import type { TodoItem } from '@/middlewares/todo-list';

interface ContextSummary {
    tokens: number;
    usage: number;
    messageCount: number;
    label: string;
}

type CodingAgent = Awaited<ReturnType<typeof createCodingAgent>>;

/** 将流式 tool_call_chunks 合并为完整的 ToolCall 对象 */
function mergeToolCallChunks(chunks: ToolCallChunk[]): ToolCall[] {
    const merged: Record<number, { name: string; args: string; id: string }> = {};
    for (const chunk of chunks) {
        const idx = chunk.index ?? 0;
        if (!merged[idx]) {
            merged[idx] = {
                name: chunk.name ?? '',
                args: chunk.args ?? '',
                id: chunk.id ?? '',
            };
        } else {
            if (chunk.args) merged[idx].args += chunk.args;
            if (chunk.name && !merged[idx].name) merged[idx].name = chunk.name;
            if (chunk.id && !merged[idx].id) merged[idx].id = chunk.id;
        }
    }
    return Object.values(merged).map(
        (tc): ToolCall => ({
            name: tc.name,
            args: (() => { try { return JSON.parse(tc.args); } catch { return {}; } })(),
            id: tc.id || undefined,
            type: 'tool_call' as const,
        }),
    );
}

export const App = () => {
    const [messages, setMessages] = useState<BaseMessage[]>([]);
    const [isGenerating, setIsGenerating] = useState(false);
    const [streamingContent, setStreamingContent] = useState('');
    const [todos, setTodos] = useState<TodoItem[]>([]);
    const [contextSummary, setContextSummary] = useState<ContextSummary | null>(null);
    const [interruptInfo, setInterruptInfo] = useState<{
        description: string;
        tool: string;
        decisionCount: number;
    } | null>(null);

    const [agent, setAgent] = useState<CodingAgent | null>(null);

    useEffect(() => {
        const initAgent = async () => {
            const agent = await createCodingAgent();
            setAgent(agent);
        };

        initAgent();
    }, []);

    const runAgent = async (input: { messages: BaseMessage[] } | Command) => {
        if (!agent) return;
        setIsGenerating(true);

        // 草稿缓冲区，用于累积流式 token
        let draftContent = '';
        let draftToolCallChunks: ToolCallChunk[] = [];

        const commitDraft = () => {
            if (!draftContent && !draftToolCallChunks.length) return;

            const mergedCalls = mergeToolCallChunks(draftToolCallChunks);
            const aiMsg = new AIMessage({
                content: draftContent || '',
                tool_calls: mergedCalls.length > 0 ? mergedCalls : undefined,
            });

            // 从合并后的工具调用中提取 todo 更新
            for (const tc of mergedCalls) {
                if (tc.name === 'todo_write' && tc.args?.todos) {
                    setTodos(tc.args.todos);
                }
            }

            setMessages((prev) => [...prev, aiMsg]);
            draftContent = '';
            draftToolCallChunks = [];
            setStreamingContent('');
        };

        try {
            const stream = await agent.stream(input, {
                recursionLimit: 50,
                streamMode: 'messages',
                configurable: { thread_id: '1' },
            });

            for await (const chunk of stream) {
                const [msg] = chunk as [BaseMessage, any];

                if (AIMessageChunk.isInstance(msg)) {
                    // 逐 token 累积流式文本
                    if (typeof msg.content === 'string' && msg.content) {
                        draftContent += msg.content;
                        setStreamingContent(draftContent);
                    }
                    // 累积工具调用片段
                    if (msg.tool_call_chunks?.length) {
                        draftToolCallChunks.push(...msg.tool_call_chunks);
                    }
                } else if (ToolMessage.isInstance(msg)) {
                    // 工具结果到达 — 先提交前面的 AI 消息
                    commitDraft();
                    setMessages((prev) => [...prev, msg]);
                }
                // HumanMessage 跳过 — 在调用 runAgent 之前已添加到 UI
            }

            // 提交残余草稿（本轮最终 AI 回复）
            commitDraft();

            // 检查是否有中断（HITL）
            const state: StateSnapshot = await agent.getState({ configurable: { thread_id: '1' } });
            const stateValues = state.values as Record<string, unknown>;
            const tasks = stateValues.tasks as Array<{ interrupts?: Array<{ value: unknown }> }> | undefined;
            if (tasks && tasks.length > 0 && tasks[0].interrupts && tasks[0].interrupts.length > 0) {
                const interruptValue = tasks[0].interrupts[0].value as {
                    actionRequests?: Array<{ name: string; args: { command?: string } }>;
                } | undefined;
                const actionRequests = Array.isArray(interruptValue?.actionRequests)
                    ? interruptValue.actionRequests
                    : [];
                const decisionCount = Math.max(actionRequests.length, 1);

                let isDangerous = false;
                for (const action of actionRequests) {
                    if (action.name === 'bash') {
                        const command = action.args.command;
                        if (command && /(^|[;&|\s])(rm|rmdir)(\s|$)/.test(command)) {
                            isDangerous = true;
                            break;
                        }
                    }
                }

                if (isDangerous) {
                    setInterruptInfo({
                        description: 'Tool execution pending approval (Dangerous Command)',
                        tool: 'bash',
                        decisionCount,
                    });
                } else {
                    // 自动批准安全命令
                    await autoResume(decisionCount);
                }
            }

            // 从 agent state 同步完整消息列表到 UI，补全通过中间件 Command
            // （如 todo_write）直接写入 state 而未出现在 stream 中的 ToolMessage。
            // 否则下轮对话传入的 history 缺少 ToolMessage 会导致 API 400 错误。
            const finalState: StateSnapshot = await agent.getState({ configurable: { thread_id: '1' } });
            const finalValues = finalState.values as Record<string, unknown>;
            if (Array.isArray(finalValues.messages)) {
                // 过滤掉 SystemMessage（摘要、prompt 等），只保留用户可见的会话消息
                const stateMessages = (finalValues.messages as BaseMessage[]).filter(
                    (msg) => !SystemMessage.isInstance(msg),
                );
                setMessages(stateMessages);
                // 上下文统计基于完整消息（含 SystemMessage），更准确反映实际 token 用量
                setContextSummary(getContextSummary(finalValues.messages as BaseMessage[]));
            }
            if (Array.isArray(finalValues.todos)) {
                setTodos(finalValues.todos as TodoItem[]);
            }
        } catch (error) {
            setMessages((prev) => [...prev, new AIMessage(`Error: ${error}`)]);
        } finally {
            setIsGenerating(false);
            setStreamingContent('');
        }
    };

    const handleSubmit = async (value: string) => {
        if (!value.trim() || !agent) return;

        const userMsg = new HumanMessage(value);
        setMessages((prev) => [...prev, userMsg]);

        await runAgent({ messages: [...messages, userMsg] });
    };

    const handleResume = async (decision: string) => {
        const decisionCount = interruptInfo?.decisionCount ?? 1;
        setInterruptInfo(null);
        await runAgent(
            new Command({
                resume: {
                    decisions: Array.from({ length: decisionCount }, () => ({
                        type: decision,
                    })),
                },
            }),
        );
    };

    // 自动恢复执行（批准安全命令）
    const autoResume = async (decisionCount = 1) => {
        await runAgent(
            new Command({
                resume: {
                    decisions: Array.from({ length: decisionCount }, () => ({
                        type: 'approve',
                    })),
                },
            }),
        );
    };

    return (
        <Box flexDirection="column">
            <Box flexDirection="column">
                <Banner />
                <Box>
                    <Text color="gray">
                        Ask for a coding task. Rune will keep the details tidy.
                    </Text>
                </Box>
            </Box>
            <Box flexDirection="column" flexGrow={1}>
                <ChatView
                    messages={messages}
                    todos={todos}
                    isGenerating={isGenerating}
                    streamingContent={streamingContent}
                    contextSummary={contextSummary}
                />
                {interruptInfo ? (
                    <Box
                        flexDirection="column"
                        borderColor="yellow"
                        borderStyle="round"
                        padding={1}
                    >
                        <Text color="yellow" bold>
                            Approval required
                        </Text>
                        <Text>A command needs your confirmation before it runs.</Text>
                        <SelectInput
                            items={[
                                { label: 'Approve (Yes)', value: 'approve' },
                                { label: 'Reject (No)', value: 'reject' },
                            ]}
                            onSelect={(item) => handleResume(item.value)}
                        />
                    </Box>
                ) : (
                    <ChatInput onSubmit={handleSubmit} />
                )}
            </Box>
        </Box>
    );
};
