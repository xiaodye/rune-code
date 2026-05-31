import { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import SelectInput from 'ink-select-input';
import {
    AIMessage,
    AIMessageChunk,
    BaseMessage,
    HumanMessage,
    SystemMessage,
    ToolCall,
    ToolCallChunk,
    ToolMessage,
} from '@langchain/core/messages';
import { Command, StateSnapshot } from '@langchain/langgraph';
import { createCodingAgent } from '@/agents/coding-agent';
import { getContextSummary } from '@/utils/token-counter';
import { ChatView } from './components/chat-view';
import { ChatInput } from './components/chat-input';
import { Banner } from './components/banner';
import type { TodoItem } from '@/middlewares/todo-list';
import {
    assessRisk,
    getCategoryLabel,
    getLevelColor,
    getLevelIcon,
    type DangerAssessment,
} from '@/safety/danger-engine';

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
            args: (() => {
                try {
                    return JSON.parse(tc.args);
                } catch {
                    return {};
                }
            })(),
            id: tc.id || undefined,
            type: 'tool_call' as const,
        }),
    );
}

interface ActionRequest {
    name: string;
    args: { command?: string };
}

interface InterruptInfo {
    description: string;
    tool: string;
    decisionCount: number;
    assessment: DangerAssessment;
    actionRequests: ActionRequest[];
}

export const App = () => {
    const [messages, setMessages] = useState<BaseMessage[]>([]);
    const [isGenerating, setIsGenerating] = useState(false);
    const [streamingContent, setStreamingContent] = useState('');
    const [todos, setTodos] = useState<TodoItem[]>([]);
    const [contextSummary, setContextSummary] = useState<ContextSummary | null>(null);
    const [interruptInfo, setInterruptInfo] = useState<InterruptInfo | null>(null);
    const [criticalCooldown, setCriticalCooldown] = useState(0);

    const [agent, setAgent] = useState<CodingAgent | null>(null);

    // critical 倒计时
    useEffect(() => {
        if (criticalCooldown > 0) {
            const timer = setTimeout(() => {
                setCriticalCooldown((prev) => prev - 1);
            }, 1000);
            return () => clearTimeout(timer);
        }
    }, [criticalCooldown]);

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

            // ─── HITL 中断处理 + 分级风险评估 ───
            const state: StateSnapshot = await agent.getState({ configurable: { thread_id: '1' } });
            const stateValues = state.values as Record<string, unknown>;
            const tasks = stateValues.tasks as
                | Array<{ interrupts?: Array<{ value: unknown }> }>
                | undefined;
            if (
                tasks &&
                tasks.length > 0 &&
                tasks[0].interrupts &&
                tasks[0].interrupts.length > 0
            ) {
                const interruptValue = tasks[0].interrupts[0].value as
                    | {
                          actionRequests?: ActionRequest[];
                      }
                    | undefined;
                const actionRequests: ActionRequest[] = Array.isArray(
                    interruptValue?.actionRequests,
                )
                    ? interruptValue.actionRequests
                    : [];
                const decisionCount = Math.max(actionRequests.length, 1);

                // 对 bash 命令进行分级风险评估
                let assessment: DangerAssessment = {
                    level: 'safe',
                    score: 0,
                    matchedRules: [],
                    description: null,
                    category: null,
                };

                for (const action of actionRequests) {
                    if (action.name === 'bash') {
                        const command = action.args.command;
                        if (command) {
                            assessment = assessRisk(command);
                            break;
                        }
                    }
                }

                if (assessment.level === 'safe') {
                    // 安全：直接放行
                    await autoResume(decisionCount);
                } else if (assessment.level === 'warning') {
                    // 低风险：静默记录，短暂提示后自动执行
                    setInterruptInfo({
                        description: `Low-risk command: ${assessment.description}`,
                        tool: 'bash',
                        decisionCount,
                        assessment,
                        actionRequests,
                    });
                    await new Promise((r) => setTimeout(r, 1200));
                    setInterruptInfo(null);
                    await autoResume(decisionCount);
                } else {
                    // dangerous / critical：显示审批 UI
                    setInterruptInfo({
                        description:
                            assessment.level === 'critical'
                                ? 'CRITICAL: This command could cause irreversible damage'
                                : `Tool execution pending approval (risk: ${assessment.score})`,
                        tool: 'bash',
                        decisionCount,
                        assessment,
                        actionRequests,
                    });

                    if (assessment.level === 'critical') {
                        setCriticalCooldown(3);
                    }
                }
            }

            // 从 agent state 同步完整消息列表到 UI，补全通过中间件 Command
            // （如 todo_write）直接写入 state 而未出现在 stream 中的 ToolMessage。
            // 否则下轮对话传入的 history 缺少 ToolMessage 会导致 API 400 错误。
            const finalState: StateSnapshot = await agent.getState({
                configurable: { thread_id: '1' },
            });
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
        setCriticalCooldown(0);

        // 构建 decisions：reject 时用 edit 把危险命令替换成无害 echo，
        // 绕过 langchain v1.4.2 HITL 中间件的已知 bug：
        // 当 AIMessage 同时包含 bash 和自动放行的工具调用时，reject 路径
        // 会把自动放行的 tool_call 保留但不生成 ToolMessage → API 400
        const decisions = Array.from({ length: decisionCount }, (_, i) => {
            if (decision === 'reject') {
                return {
                    type: 'edit' as const,
                    editedAction: {
                        name: 'bash',
                        args: { command: 'echo "[SAFETY] User rejected this command"' },
                    },
                };
            }
            return { type: decision as 'approve' };
        });

        await runAgent(
            new Command({
                resume: { decisions },
            }),
        );
    };

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
                    /* ── 审批 UI ── */
                    <Box
                        flexDirection="column"
                        borderColor={getLevelColor(interruptInfo.assessment.level)}
                        borderStyle="round"
                        padding={1}
                    >
                        <Text color={getLevelColor(interruptInfo.assessment.level)} bold>
                            {getLevelIcon(interruptInfo.assessment.level)}{' '}
                            {interruptInfo.assessment.level === 'critical'
                                ? 'CRITICAL Command'
                                : interruptInfo.assessment.level === 'dangerous'
                                  ? 'Dangerous Command'
                                  : 'Command Warning'}
                        </Text>

                        {/* 命令内容 */}
                        <Box marginTop={1}>
                            <Text color="gray">Command: </Text>
                            <Text>
                                {interruptInfo.actionRequests[0]?.args?.command ?? '(unknown)'}
                            </Text>
                        </Box>

                        {/* 风险详情 */}
                        {interruptInfo.assessment.description && (
                            <Box>
                                <Text color="gray">Risk: </Text>
                                <Text color={getLevelColor(interruptInfo.assessment.level)}>
                                    {interruptInfo.assessment.description}
                                </Text>
                            </Box>
                        )}
                        {interruptInfo.assessment.category && (
                            <Box>
                                <Text color="gray">Category: </Text>
                                <Text>{getCategoryLabel(interruptInfo.assessment.category)}</Text>
                            </Box>
                        )}
                        <Box>
                            <Text color="gray">Risk score: </Text>
                            <Text color={getLevelColor(interruptInfo.assessment.level)}>
                                {interruptInfo.assessment.score}/100
                            </Text>
                        </Box>

                        {/* critical 额外警告 + 倒计时 */}
                        {interruptInfo.assessment.level === 'critical' && (
                            <Box marginTop={1} flexDirection="column">
                                <Text color="red" bold>
                                    ⛔ This command could cause irreversible system damage.
                                </Text>
                                {criticalCooldown > 0 && (
                                    <Text color="red">
                                        Please wait {criticalCooldown}s before approving...
                                    </Text>
                                )}
                            </Box>
                        )}

                        <Box marginTop={1}>
                            <SelectInput
                                items={(() => {
                                    const items: Array<{ label: string; value: string }> = [];

                                    if (
                                        interruptInfo.assessment.level === 'critical' &&
                                        criticalCooldown > 0
                                    ) {
                                        items.push({
                                            label: `Approve (wait ${criticalCooldown}s...)`,
                                            value: 'approve',
                                        });
                                    } else {
                                        items.push({ label: 'Approve (Yes)', value: 'approve' });
                                    }

                                    items.push({ label: 'Reject (No)', value: 'reject' });
                                    return items;
                                })()}
                                onSelect={(item) => {
                                    if (
                                        item.value === 'approve' &&
                                        interruptInfo.assessment.level === 'critical' &&
                                        criticalCooldown > 0
                                    ) {
                                        // 冷却中不允许 approve
                                        return;
                                    }
                                    handleResume(item.value);
                                }}
                            />
                        </Box>
                    </Box>
                ) : (
                    <ChatInput onSubmit={handleSubmit} />
                )}
            </Box>
        </Box>
    );
};
