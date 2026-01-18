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

export const ChatView: React.FC<ChatViewProps> = memo(({ messages, todos = [], isGenerating }) => {
    return (
        <Box
            flexDirection="column"
            // borderStyle="single"
            // borderColor="green"
            padding={1}
            flexGrow={1}
        >
            <Box flexDirection="column" flexGrow={1}>
                {messages.map((msg, index) => {
                    if (HumanMessage.isInstance(msg)) {
                        return (
                            <Box key={msg.id} flexDirection="column" marginTop={1}>
                                <Text color="blue" bold>
                                    User:
                                </Text>
                                <Text>{msg.content as string}</Text>
                            </Box>
                        );
                    } else if (AIMessage.isInstance(msg)) {
                        // Only show text content, skip tool calls for brevity in chat view
                        // (Tool calls usually have empty content or we show them differently)
                        const content = msg.content as string;

                        if (content) {
                            return (
                                <Box key={msg.id} flexDirection="column" marginTop={1}>
                                    <Text color="green" bold>
                                        AI:
                                    </Text>
                                    <Text>{content}</Text>
                                </Box>
                            );
                        }

                        return (
                            <Box key={msg.id}>
                                {msg.tool_calls?.length && (
                                    <Box
                                        key={msg.tool_calls[0].id}
                                        flexDirection="column"
                                        marginTop={1}
                                    >
                                        <Text color="blue" dimColor>
                                            使用了工具 {msg.tool_calls[0].name}
                                        </Text>
                                        {msg.tool_calls[0].name !== 'todo_write' && (
                                            <Box borderStyle="classic" borderColor="blue">
                                                <Text color="gray">
                                                    {JSON.stringify(
                                                        msg.tool_calls[0].args,
                                                        null,
                                                        2,
                                                    )}
                                                </Text>
                                            </Box>
                                        )}
                                    </Box>
                                )}
                            </Box>
                        );
                    } else if (ToolMessage.isInstance(msg)) {
                        const content = msg.content as string;
                        return (
                            <>
                                <Box key={msg.id} flexDirection="column" marginTop={1}>
                                    <Text color="gray" dimColor>
                                        Tool Output ({msg.name}):
                                    </Text>
                                    <Box borderStyle="round" borderColor="yellow">
                                        <Text color="gray">
                                            {content.substring(0, 150) + '...'}
                                        </Text>
                                    </Box>
                                </Box>
                            </>
                        );
                    }
                    return null;
                })}

                {todos.length !== 0 && <TodoListView todos={todos} />}
                {isGenerating && (
                    <Box flexDirection="column" marginTop={1}>
                        <Text>
                            <Spinner type="dots" /> Thinking...
                        </Text>
                    </Box>
                )}
            </Box>
        </Box>
    );
});
