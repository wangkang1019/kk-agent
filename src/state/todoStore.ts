import type { TodoItem, ParseTodosResult } from "../types/todo.js";
import { parseTodos as parseTodoInput } from "../types/todo.js";

export type TodoListener = (sessionId: string, todos: TodoItem[]) => void;

const todosBySession = new Map<string, TodoItem[]>();
const listeners = new Set<TodoListener>();

export function parseTodos(input: Record<string, unknown>): ParseTodosResult {
  return parseTodoInput(input);
}

export function getTodos(sessionId: string): TodoItem[] {
  return todosBySession.get(sessionId) ?? [];
}

export function setTodos(sessionId: string, todos: TodoItem[]): void {
  todosBySession.set(sessionId, todos);

  for (const listener of listeners) {
    listener(sessionId, todos);
  }
}

export function clearTodos(sessionId: string): void {
  setTodos(sessionId, []);
}

export function subscribeTodos(listener: TodoListener): () => void {
  listeners.add(listener);

  return () => {
    listeners.delete(listener);
  };
}
