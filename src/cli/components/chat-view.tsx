import React, { memo } from 'react';
import { Box, Text } from 'ink';
import { BaseMessage, HumanMessage, AIMessage, ToolMessage } from '@langchain/core/messages';
import Spinner from 'ink-spinner';
import { TodoListView } from './todo-list-view';
import { TodoItem } from '@/middlewares/todo-list';
import { project } from '@/project';

interface ChatViewProps {
    messages: BaseMessage[];
    todos: TodoItem[];
    isGenerating: boolean;
    streamingContent?: string;
}

const MAX_INLINE_LENGTH = 96;
const MAX_TOOL_DETAIL_LENGTH = 56;

function compact(value: unknown, maxLength = MAX_INLINE_LENGTH): string {
    if (value === undefined || value === null || value === '') {
        return '';
    }

    const text = String(value).replace(/\s+/g, ' ').trim();
    if (text.length <= maxLength) {
        return text;
    }

    return `${text.slice(0, maxLength - 1)}...`;
}

function messageText(content: unknown): string {
    if (typeof content === 'string') {
        return content;
    }

    if (Array.isArray(content)) {
        return content
            .map((part) => {
                if (typeof part === 'string') {
                    return part;
                }

                if (part && typeof part === 'object' && 'text' in part) {
                    return String(part.text);
                }

                return '';
            })
            .filter(Boolean)
            .join('\n');
    }

    return content ? String(content) : '';
}

function toolLabel(name: string): string {
    const labels: Record<string, string> = {
        bash: '执行命令',
        grep: '搜索代码',
        ls: '查看目录',
        tree: '查看文件树',
        text_editor: '编辑器',
        todo_write: 'TodoList',
    };

    return labels[name] ?? '调用工具';
}

function toolIcon(name: string): string {
    const icons: Record<string, string> = {
        bash: '$',
        grep: '?',
        ls: '/',
        tree: '#',
        text_editor: '+',
        todo_write: '*',
    };

    return icons[name] ?? '>';
}

function displayPath(value: unknown): string {
    const text = compact(value, 240);
    if (!text) {
        return '';
    }

    if (text === project.rootDir) {
        return '.';
    }

    if (text.startsWith(`${project.rootDir}/`)) {
        return text.slice(project.rootDir.length + 1);
    }

    return text.replace(/^\/Users\/[^/]+\//, '~/');
}

function toolDetail(name: string, args: Record<string, any>): string {
    if (name === 'bash') {
        return compact(args.command, MAX_TOOL_DETAIL_LENGTH);
    }

    if (name === 'grep') {
        const target = args.path ? `in ${displayPath(args.path)}` : '';
        return compact([args.pattern, target].filter(Boolean).join(' '), MAX_TOOL_DETAIL_LENGTH);
    }

    if (name === 'ls' || name === 'tree') {
        return compact(displayPath(args.path), MAX_TOOL_DETAIL_LENGTH);
    }

    if (name === 'text_editor') {
        return compact(
            [args.command, displayPath(args.path)].filter(Boolean).join(' '),
            MAX_TOOL_DETAIL_LENGTH,
        );
    }

    return '';
}

function isErrorToolMessage(msg: ToolMessage): boolean {
    return typeof msg.content === 'string' && /^`{0,3}\s*error[:\s]/i.test(msg.content.trim());
}

export const ChatView: React.FC<ChatViewProps> = memo(
    ({ messages, todos = [], isGenerating, streamingContent }) => {
        return (
            <Box flexDirection="column" paddingX={1} flexGrow={1}>
                <Box flexDirection="column" flexGrow={1}>
                    {messages.map((msg, index) => {
                    if (HumanMessage.isInstance(msg)) {
                        const content = messageText(msg.content);

                        return (
                            <Box key={msg.id ?? index} flexDirection="column" marginTop={1}>
                                <Text color="cyan" bold>
                                    You
                                </Text>
                                <Text wrap="wrap">{content}</Text>
                            </Box>
                        );
                    } else if (AIMessage.isInstance(msg)) {
                        const content = messageText(msg.content);

                        if (content) {
                            return (
                                <Box key={msg.id ?? index} flexDirection="column" marginTop={1}>
                                    <Text color="green" bold>
                                        Rune
                                    </Text>
                                    <Text wrap="wrap">{content}</Text>
                                </Box>
                            );
                        }

                        const visibleToolCalls =
                            msg.tool_calls?.filter((toolCall) => toolCall.name !== 'todo_write') ??
                            [];

                        if (visibleToolCalls.length === 0) {
                            return null;
                        }

                        return (
                            <Box key={msg.id ?? index} flexDirection="column" marginTop={1}>
                                {visibleToolCalls.map((toolCall) => {
                                    const detail = toolDetail(toolCall.name, toolCall.args ?? {});
                                    return (
                                        <Box key={toolCall.id ?? toolCall.name} flexDirection="row">
                                            <Box width={3}>
                                                <Text color="cyan" bold>
                                                    {toolIcon(toolCall.name)}
                                                </Text>
                                            </Box>
                                            <Text color="gray">{toolLabel(toolCall.name)} </Text>
                                            <Text color="magenta" bold>
                                                [{toolCall.name}]
                                            </Text>
                                            {detail ? (
                                                <Text color="gray" wrap="truncate-end">
                                                    {' '}
                                                    {detail}
                                                </Text>
                                            ) : null}
                                        </Box>
                                    );
                                })}
                            </Box>
                        );
                    } else if (ToolMessage.isInstance(msg)) {
                        if (!isErrorToolMessage(msg)) {
                            return null;
                        }

                        return (
                            <Box key={msg.id ?? index} flexDirection="column" marginTop={1}>
                                <Text color="red">
                                    {msg.name ? `${msg.name} failed` : 'Tool failed'}:{' '}
                                    {compact(msg.content)}
                                </Text>
                            </Box>
                        );
                    }
                    return null;
                })}

                {todos.length !== 0 && <TodoListView todos={todos} />}
                {streamingContent ? (
                    <Box flexDirection="column" marginTop={1}>
                        <Text color="green" bold>
                            Rune
                        </Text>
                        <Text wrap="wrap">
                            {streamingContent}
                            <Text color="green">▊</Text>
                        </Text>
                    </Box>
                ) : isGenerating ? (
                    <Box flexDirection="column" marginTop={1}>
                        <Text color="gray">
                            <Spinner type="dots" /> Working
                        </Text>
                    </Box>
                ) : null}
            </Box>
        </Box>
    );
});
