import { Box, Text } from 'ink';
import { TodoItem, TodoStatus } from '@/middlewares/todo-list';

interface TodoListViewProps {
    todos: TodoItem[];
}

export const TodoListView: React.FC<TodoListViewProps> = ({ todos }) => {
    return (
        <Box
            flexDirection="column"
            borderStyle="round"
            borderColor="magenta"
            padding={1}
            flexGrow={1}
        >
            <Text bold>To-do List</Text>
            <Box flexDirection="column" marginTop={1}>
                {todos.length === 0 ? (
                    <Text dimColor>No todos yet.</Text>
                ) : (
                    todos.map((todo) => {
                        let color = 'white';
                        let symbol = ' ';
                        if (todo.status === TodoStatus.completed) {
                            color = 'green';
                            symbol = '✓';
                        } else if (todo.status === TodoStatus.in_progress) {
                            color = 'yellow';
                            symbol = '▶';
                        } else if (todo.status === TodoStatus.cancelled) {
                            color = 'red';
                            symbol = '✗';
                        } else {
                            symbol = '○';
                        }

                        return (
                            <Box key={todo.id}>
                                <Text color={color}>
                                    {symbol} [{todo.priority}] {todo.title}
                                </Text>
                            </Box>
                        );
                    })
                )}
            </Box>
        </Box>
    );
};
