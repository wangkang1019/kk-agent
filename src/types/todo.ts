export const TODO_STATUSES = ["pending", "in_progress", "completed"] as const;

export type TodoStatus = (typeof TODO_STATUSES)[number];

export interface TodoItem {
  content: string;
  status: TodoStatus;
  activeForm: string;
}

export type ParseTodosResult = TodoItem[] | { error: string };

export function isTodoItem(value: unknown): value is TodoItem {
  if (!value || typeof value !== "object") {
    return false;
  }

  const item = value as Partial<Record<keyof TodoItem, unknown>>;

  return (
    typeof item.content === "string" &&
    item.content.trim().length > 0 &&
    typeof item.activeForm === "string" &&
    item.activeForm.trim().length > 0 &&
    typeof item.status === "string" &&
    TODO_STATUSES.includes(item.status as TodoStatus)
  );
}

export function parseTodos(input: Record<string, unknown>): ParseTodosResult {
  const raw = input.todos;

  if (!Array.isArray(raw)) {
    return { error: "`todos` must be an array of TodoItem objects." };
  }

  const todos: TodoItem[] = [];

  for (let index = 0; index < raw.length; index += 1) {
    const item = raw[index];

    if (!isTodoItem(item)) {
      return {
        error:
          `todos[${index}] is not a valid TodoItem ` +
          "(need non-empty content, activeForm, and status in pending|in_progress|completed).",
      };
    }

    todos.push({
      content: item.content,
      status: item.status,
      activeForm: item.activeForm,
    });
  }

  return todos;
}
