import { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import SelectInput from 'ink-select-input';
import { AIMessage, BaseMessage, HumanMessage } from '@langchain/core/messages';
import { Command } from '@langchain/langgraph';
import { createCodingAgent } from '@/agents/coding-agent';
import { ChatView } from './components/chat-view';
import { ChatInput } from './components/chat-input';
import { Banner } from './components/banner';
import type { TodoItem } from '@/middlewares/todo-list';

type CodingAgent = Awaited<ReturnType<typeof createCodingAgent>>;

export const App = () => {
    const [messages, setMessages] = useState<BaseMessage[]>([]);
    const [isGenerating, setIsGenerating] = useState(false);
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

    const runAgent = async (input: any) => {
        if (!agent) return;
        setIsGenerating(true);

        try {
            const stream = await agent.stream(input, {
                recursionLimit: 50,
                streamMode: 'updates',
                configurable: { thread_id: '1' },
            });

            for await (const chunk of stream) {
                for (const [nodeName, nodeUpdate] of Object.entries(chunk)) {
                    const newMsgs = nodeUpdate.messages;

                    if (Array.isArray(newMsgs) && ['model_request', 'tools'].includes(nodeName)) {
                        setMessages((prev) => [...prev, ...newMsgs]);

                        for (const msg of newMsgs) {
                            if (AIMessage.isInstance(msg) && msg.tool_calls) {
                                for (const tc of msg.tool_calls) {
                                    if (tc.name === 'todo_write') {
                                        setTodos(tc.args.todos);
                                    }
                                }
                            }
                        }
                    }
                }
            }

            // Check for interrupt
            const state = (await agent.getState({ configurable: { thread_id: '1' } })) as any;
            if (
                state.tasks &&
                state.tasks.length > 0 &&
                state.tasks[0].interrupts &&
                state.tasks[0].interrupts.length > 0
            ) {
                const interruptValue = state.tasks[0].interrupts[0].value;
                const actionRequests = Array.isArray(interruptValue?.actionRequests)
                    ? interruptValue.actionRequests
                    : [];
                const decisionCount = Math.max(actionRequests.length, 1);

                // Inspect the interrupt value (HITLRequest)
                // We check if it's a bash command and if it's dangerous
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
                <ChatView messages={messages} todos={todos} isGenerating={isGenerating} />
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
