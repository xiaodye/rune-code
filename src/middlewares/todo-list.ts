import { createMiddleware, tool, ToolMessage } from 'langchain';
import { Command } from '@langchain/langgraph';
import { z } from 'zod';

export enum TodoStatus {
    pending = 'pending',
    in_progress = 'in_progress',
    completed = 'completed',
    cancelled = 'cancelled',
}

export enum TodoPriority {
    low = 'low',
    medium = 'medium',
    high = 'high',
}

export interface TodoItem {
    id: number;
    title: string;
    priority: TodoPriority;
    status: TodoStatus;
}

export const TODO_LIST_SYSTEM_PROMPT = `
## \`todo_write\`

You have access to the \`todo_write\` tool to help you manage and plan complex objectives.
Use this tool for complex objectives to ensure that you are tracking each necessary step and giving the user visibility into your progress.
This tool is very helpful for planning complex objectives, and for breaking down these larger complex objectives into smaller steps.

It is critical that you mark todos as completed as soon as you are done with a step. Do not batch up multiple steps before marking them as completed.
For simple objectives that only require a few steps, it is better to just complete the objective directly and NOT use this tool.
Writing todos takes time and tokens, use it when it is helpful for managing complex many-step problems! But not for simple few-step requests.

## Important To-Do List Usage Notes to Remember
- The \`todo_write\` tool should never be called multiple times in parallel.
- Don't be afraid to revise the To-Do list as you go. New information may reveal new tasks that need to be done, or old tasks that are irrelevant.
`;

export function todoListMiddleware(options: { systemPrompt?: string } = {}) {
    const todoWriteTool = tool(
        async ({ todos }, config) => {
            const unfinishedTodos = todos.filter(
                (todo) =>
                    todo.status !== TodoStatus.completed && todo.status !== TodoStatus.cancelled,
            );

            let message = `Successfully updated the TODO list with ${todos.length} items.`;
            if (unfinishedTodos.length > 0) {
                message += ` ${unfinishedTodos.length} todo${unfinishedTodos.length === 1 ? ' is' : 's are'} not completed.`;
            } else {
                message += ' All todos are completed.';
            }

            return new Command({
                update: {
                    todos,
                    messages: [
                        new ToolMessage({
                            content: message,
                            tool_call_id: config.toolCall?.id || '',
                            name: 'todo_write',
                        }),
                    ],
                },
            });
        },
        {
            name: 'todo_write',
            description: 'Update the entire TODO list with the latest items.',
            schema: z.object({
                todos: z
                    .array(
                        z.object({
                            id: z.number().min(0),
                            title: z.string().min(1),
                            priority: z.enum(TodoPriority).default(TodoPriority.medium),
                            status: z.enum(TodoStatus).default(TodoStatus.pending),
                        }),
                    )
                    .describe('A list of TodoItem objects.'),
            }),
        },
    );

    return createMiddleware({
        name: 'todoListMiddleware',
        tools: [todoWriteTool],
        stateSchema: z.object({
            todos: z
                .array(
                    z.object({
                        id: z.number().min(0),
                        title: z.string().min(1),
                        priority: z.enum(TodoPriority).default(TodoPriority.medium),
                        status: z.enum(TodoStatus).default(TodoStatus.pending),
                    }),
                )
                .default([]),
        }),
        wrapModelCall: (request, handler) => {
            const todos = request.state.todos;
            let todoSP = '';

            if (todos.length > 0) {
                const todoListString = todos
                    .map(
                        (t) =>
                            `- [${t.status === 'completed' ? 'x' : ' '}] ${t.title} (${t.status})`,
                    )
                    .join('\n');

                todoSP += `\n\nCurrent To-Do List:\n${todoListString}`;
            }

            return handler({
                ...request,
                systemMessage: request.systemMessage
                    .concat(`\n\n${options?.systemPrompt ?? TODO_LIST_SYSTEM_PROMPT}`)
                    .concat(todoSP),
            });
        },
    });
}
