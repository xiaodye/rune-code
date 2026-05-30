import { useState, useEffect } from 'react';
import { Box, Static, Text, useInput } from 'ink';
import SelectInput from 'ink-select-input';
import { AIMessage, BaseMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import { Command } from '@langchain/langgraph';
import { createCodingAgent } from '@/agents/coding-agent';
import { ChatView } from './components/chat-view';
import { ChatInput } from './components/chat-input';
import { TodoListView } from './components/todo-list-view';
import { Banner } from './components/banner';
import type { TodoItem } from '@/middlewares/todo-list';
import { debugLog } from '@/utils/debug';

type CodingAgent = Awaited<ReturnType<typeof createCodingAgent>>;

export const App = () => {
    const [messages, setMessages] = useState<BaseMessage[]>([]);
    const [isGenerating, setIsGenerating] = useState(false);
    const [todos, setTodos] = useState<TodoItem[]>([]);
    const [terminalOutput, setTerminalOutput] = useState('');
    const [interruptInfo, setInterruptInfo] = useState<{
        description: string;
        tool: string;
    } | null>(null);

    // Tab state: 0 = Chat, 1 = Terminal, 2 = Todo
    const [activeTab, setActiveTab] = useState(0);

    const [agent, setAgent] = useState<CodingAgent | null>(null);

    useEffect(() => {
        const initAgent = async () => {
            const agent = await createCodingAgent();
            setAgent(agent);
        };

        initAgent();
    }, []);

    useInput((input, key) => {
        if (key.return && !isGenerating && input.trim().length === 0) {
            // Just focus change maybe?
        }

        // Tab to switch tabs
        // if (key.tab) {
        //     setActiveTab((prev) => (prev + 1) % 2);
        // }
    });

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

                    debugLog(`nodeName: ${nodeName}`);
                    debugLog(`messages: ${JSON.stringify(newMsgs, null, 2)}`);
                    // debugLog(`interrupt: ${nodeUpdate.__interrupt__}`);

                    if (
                        Array.isArray(newMsgs) &&
                        ['human', 'model_request', 'tools'].includes(nodeName)
                    ) {
                        setMessages((prev) => [...prev, ...newMsgs]);

                        for (const msg of newMsgs) {
                            if (ToolMessage.isInstance(msg)) {
                                const toolMsg = msg;
                                if (
                                    toolMsg.name === 'bash' &&
                                    typeof toolMsg.content === 'string'
                                ) {
                                    setTerminalOutput(toolMsg.content);
                                }
                            }

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

                // Inspect the interrupt value (HITLRequest)
                // We check if it's a bash command and if it's dangerous
                let isDangerous = false;

                if (interruptValue && interruptValue.actionRequests) {
                    for (const action of interruptValue.actionRequests) {
                        if (action.name === 'bash') {
                            const command = action.args.command;
                            if (command && /(^|[;&|\s])(rm|rmdir)(\s|$)/.test(command)) {
                                isDangerous = true;
                                break;
                            }
                        }
                    }
                }

                if (isDangerous) {
                    setInterruptInfo({
                        description: 'Tool execution pending approval (Dangerous Command)',
                        tool: 'bash',
                    });
                } else {
                    // Auto-approve safe commands
                    await autoResume();
                }
            }
        } catch (error) {
            setMessages((prev) => [...prev, new HumanMessage(`Error: ${error}`)]);
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
        setInterruptInfo(null);
        await runAgent(
            new Command({
                resume: {
                    decisions: [
                        {
                            type: decision,
                        },
                    ],
                },
            }),
        );
    };

    // Helper to auto-resume
    const autoResume = async () => {
        await runAgent(
            new Command({
                resume: {
                    decisions: [{ type: 'approve' }],
                },
            }),
        );
    };

    return (
        <Box flexDirection="column">
            <Box flexDirection="column">
                <Banner />
                <Box>
                    <Text>Welcome to Rune Code! Type your requests below.</Text>
                </Box>
                <Box>
                    <Text>1. Type your request to start a conversation with Rune Code.</Text>
                </Box>
                <Box>
                    <Text>2. Use the terminal view to execute commands.</Text>
                </Box>
            </Box>
            {/* <Box flexDirection="row" borderStyle="single" borderColor="gray" marginBottom={0}>
                <Text inverse={activeTab === 0}> Chat </Text>
                <Text> | </Text>
                <Text inverse={activeTab === 1}> TodoList </Text>
            </Box> */}
            <Box flexDirection="column" flexGrow={1}>
                <ChatView messages={messages} todos={todos} isGenerating={isGenerating} />
                {interruptInfo ? (
                    <Box
                        flexDirection="column"
                        borderColor="yellow"
                        borderStyle="round"
                        padding={1}
                    >
                        <Text color="yellow">⚠️ Approval Required</Text>
                        <Text>A tool execution requires your confirmation.</Text>
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

            {/* {activeTab === 1 && (
                <Box flexDirection="column" flexGrow={1}>
                    <TerminalView output={terminalOutput} />
                </Box>
            )} */}

            {/* {activeTab === 1 && (
                <Box flexDirection="column" flexGrow={1}>
                    <TodoListView todos={todos} />
                </Box>
            )} */}

            {/* <Box marginTop={1}>
                <Text dimColor>Press Tab to switch views (Chat / Terminal / Todo)</Text>
            </Box> */}
        </Box>
    );
};
