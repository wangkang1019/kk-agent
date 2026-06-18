import { Box, Text } from "ink";
import type { ReactNode } from "react";

import type { TodoItem } from "../../types/todo.js";

export function countCompletedTodos(todos: TodoItem[]): number {
  return todos.filter((todo) => todo.status === "completed").length;
}

export function getInProgressTodo(todos: TodoItem[]): TodoItem | null {
  return todos.find((todo) => todo.status === "in_progress") ?? null;
}

export function formatTodoRow(todo: TodoItem): string {
  if (todo.status === "completed") {
    return `✓ ${todo.content}`;
  }

  if (todo.status === "in_progress") {
    return `▸ ${todo.activeForm}`;
  }

  return `○ ${todo.content}`;
}

export function TodoList({ todos }: { todos: TodoItem[] }): ReactNode {
  if (todos.length === 0) {
    return null;
  }

  const completed = countCompletedTodos(todos);

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold color="cyan">
        Todos ({completed}/{todos.length} done)
      </Text>
      {todos.map((todo, index) => (
        <Text
          key={`${todo.status}-${todo.content}-${index}`}
          color={todo.status === "in_progress" ? "yellow" : undefined}
          dimColor={todo.status === "completed"}
        >
          {"  "}
          {formatTodoRow(todo)}
        </Text>
      ))}
    </Box>
  );
}
