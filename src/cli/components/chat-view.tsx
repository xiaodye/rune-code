import React, { memo } from 'react';
import { Box, Text } from 'ink';
import { BaseMessage, HumanMessage, AIMessage, ToolMessage } from '@langchain/core/messages';
import Spinner from 'ink-spinner';
import { TodoListView } from './todo-list-view';
import { TodoItem } from '@/middlewares/todo-list';

interface ChatViewProps {
    messages: BaseMessage[];
    todos: TodoItem[];
    isGenerating: boolean;
}

const MAX_INLINE_LENGTH = 96;

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
        bash: 'Running command',
        grep: 'Searching code',
        ls: 'Reading directory',
        tree: 'Inspecting project tree',
        text_editor: 'Editing file',
        todo_write: 'Updating plan',
    };

    return labels[name] ?? `Using ${name}`;
}

function toolDetail(name: string, args: Record<string, any>): string {
    if (name === 'bash') {
        return compact(args.command);
    }

    if (name === 'grep') {
        return compact([args.pattern, args.path].filter(Boolean).join(' in '));
    }

    if (name === 'ls' || name === 'tree') {
        return compact(args.path);
    }

    if (name === 'text_editor') {
        return compact([args.command, args.path].filter(Boolean).join(' '));
    }

    return '';
}

function isErrorToolMessage(msg: ToolMessage): boolean {
    return typeof msg.content === 'string' && /^`{0,3}\s*error[:\s]/i.test(msg.content.trim());
}

export const ChatView: React.FC<ChatViewProps> = memo(({ messages, todos = [], isGenerating }) => {
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
	                                        <Text key={toolCall.id ?? toolCall.name} color="gray">
	                                            {toolLabel(toolCall.name)}
	                                            {detail ? `: ${detail}` : ''}
	                                        </Text>
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
                {isGenerating && (
                    <Box flexDirection="column" marginTop={1}>
                        <Text color="gray">
                            <Spinner type="dots" /> Working
                        </Text>
                    </Box>
                )}
            </Box>
        </Box>
    );
});
