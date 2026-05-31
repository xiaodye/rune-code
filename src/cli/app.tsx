import { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import SelectInput from 'ink-select-input';
import { AIMessage, AIMessageChunk, BaseMessage, HumanMessage, ToolCall, ToolCallChunk, ToolMessage } from '@langchain/core/messages';
import { Command, StateSnapshot } from '@langchain/langgraph';
import { createCodingAgent } from '@/agents/coding-agent';
import { ChatView } from './components/chat-view';
import { ChatInput } from './components/chat-input';
import { Banner } from './components/banner';
import type { TodoItem } from '@/middlewares/todo-list';

type CodingAgent = Awaited<ReturnType<typeof createCodingAgent>>;

/** Merge streaming tool_call_chunks into complete ToolCall objects */
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

        // Draft buffers for accumulating streaming tokens
        let draftContent = '';
        let draftToolCallChunks: ToolCallChunk[] = [];

        const commitDraft = () => {
            if (!draftContent && !draftToolCallChunks.length) return;

            const mergedCalls = mergeToolCallChunks(draftToolCallChunks);
            const aiMsg = new AIMessage({
                content: draftContent || '',
                tool_calls: mergedCalls.length > 0 ? mergedCalls : undefined,
            });

            // Extract todo updates from merged tool calls
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
                    // Accumulate streaming text content token by token
                    if (typeof msg.content === 'string' && msg.content) {
                        draftContent += msg.content;
                        setStreamingContent(draftContent);
                    }
                    // Accumulate tool call chunks
                    if (msg.tool_call_chunks?.length) {
                        draftToolCallChunks.push(...msg.tool_call_chunks);
                    }
                } else if (ToolMessage.isInstance(msg)) {
                    // Tool result arrived — commit the preceding AI message first
                    commitDraft();
                    setMessages((prev) => [...prev, msg]);
                }
                // HumanMessage is skipped — already added to UI before calling runAgent
            }

            // Commit any remaining draft (final AI response of this turn)
            commitDraft();

            // Check for interrupt (HITL)
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
                    // Auto-approve safe commands
                    await autoResume(decisionCount);
                }
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

    // Helper to auto-resume
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
                <ChatView messages={messages} todos={todos} isGenerating={isGenerating} streamingContent={streamingContent} />
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
