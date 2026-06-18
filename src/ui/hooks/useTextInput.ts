import { useCallback, useRef, useState } from "react";

export interface TextInputState {
  value: string;
  cursor: number;
}

export interface TextInputController extends TextInputState {
  setText(value: string): void;
  insert(text: string): void;
  backspace(): void;
  moveLeft(word?: boolean): void;
  moveRight(word?: boolean): void;
  moveLineStart(): void;
  moveLineEnd(): void;
  killToLineStart(): void;
  killToLineEnd(): void;
  deletePreviousWord(): void;
  moveUp(): boolean;
  moveDown(): boolean;
  previousHistory(): void;
  nextHistory(): void;
  submit(): string;
  renderValueWithCursor(): string;
}

function previousWordBoundary(value: string, cursor: number): number {
  let index = cursor;

  while (index > 0 && /\s/.test(value[index - 1]!)) {
    index -= 1;
  }

  while (index > 0 && /\S/.test(value[index - 1]!)) {
    index -= 1;
  }

  return index;
}

function nextWordBoundary(value: string, cursor: number): number {
  let index = cursor;

  while (index < value.length && /\s/.test(value[index]!)) {
    index += 1;
  }

  while (index < value.length && /\S/.test(value[index]!)) {
    index += 1;
  }

  return index;
}

export function getLineInfo(value: string, cursor: number): {
  lineStart: number;
  lineEnd: number;
  column: number;
} {
  const lineStart = value.lastIndexOf("\n", Math.max(0, cursor - 1)) + 1;
  const nextBreak = value.indexOf("\n", cursor);
  const lineEnd = nextBreak === -1 ? value.length : nextBreak;

  return {
    lineStart,
    lineEnd,
    column: cursor - lineStart,
  };
}

export function moveCursorVertically(
  state: TextInputState,
  direction: "up" | "down",
): TextInputState | null {
  const current = getLineInfo(state.value, state.cursor);

  if (direction === "up") {
    if (current.lineStart === 0) {
      return null;
    }

    const previousEnd = current.lineStart - 1;
    const previousStart = state.value.lastIndexOf("\n", previousEnd - 1) + 1;
    const previousLength = previousEnd - previousStart;

    return {
      ...state,
      cursor: previousStart + Math.min(current.column, previousLength),
    };
  }

  if (current.lineEnd >= state.value.length) {
    return null;
  }

  const nextStart = current.lineEnd + 1;
  const nextBreak = state.value.indexOf("\n", nextStart);
  const nextEnd = nextBreak === -1 ? state.value.length : nextBreak;

  return {
    ...state,
    cursor: nextStart + Math.min(current.column, nextEnd - nextStart),
  };
}

export function applyTextInputKey(
  state: TextInputState,
  action:
    | { type: "insert"; text: string }
    | { type: "backspace" }
    | { type: "left"; word?: boolean }
    | { type: "right"; word?: boolean }
    | { type: "line_start" }
    | { type: "line_end" }
    | { type: "kill_line_start" }
    | { type: "kill_line_end" }
    | { type: "delete_previous_word" },
): TextInputState {
  switch (action.type) {
    case "insert":
      return {
        value: state.value.slice(0, state.cursor) +
          action.text +
          state.value.slice(state.cursor),
        cursor: state.cursor + action.text.length,
      };
    case "backspace":
      if (state.cursor === 0) {
        return state;
      }

      return {
        value: state.value.slice(0, state.cursor - 1) +
          state.value.slice(state.cursor),
        cursor: state.cursor - 1,
      };
    case "left":
      return {
        ...state,
        cursor: action.word
          ? previousWordBoundary(state.value, state.cursor)
          : Math.max(0, state.cursor - 1),
      };
    case "right":
      return {
        ...state,
        cursor: action.word
          ? nextWordBoundary(state.value, state.cursor)
          : Math.min(state.value.length, state.cursor + 1),
      };
    case "line_start":
      return { ...state, cursor: getLineInfo(state.value, state.cursor).lineStart };
    case "line_end":
      return { ...state, cursor: getLineInfo(state.value, state.cursor).lineEnd };
    case "kill_line_start": {
      const lineStart = getLineInfo(state.value, state.cursor).lineStart;
      return {
        value: state.value.slice(0, lineStart) + state.value.slice(state.cursor),
        cursor: lineStart,
      };
    }
    case "kill_line_end": {
      const lineEnd = getLineInfo(state.value, state.cursor).lineEnd;
      return {
        value: state.value.slice(0, state.cursor) + state.value.slice(lineEnd),
        cursor: state.cursor,
      };
    }
    case "delete_previous_word": {
      const boundary = previousWordBoundary(state.value, state.cursor);
      return {
        value: state.value.slice(0, boundary) + state.value.slice(state.cursor),
        cursor: boundary,
      };
    }
  }
}

export function renderValueWithCursor(value: string, cursor: number): string {
  return `${value.slice(0, cursor)}_${value.slice(cursor)}`;
}

export function useTextInput(): TextInputController {
  const [state, setState] = useState<TextInputState>({ value: "", cursor: 0 });
  const historyRef = useRef<string[]>([]);
  const historyIndexRef = useRef<number | null>(null);
  const draftRef = useRef("");

  const apply = useCallback((fn: (state: TextInputState) => TextInputState) => {
    setState((prev) => fn(prev));
  }, []);

  const setText = useCallback((value: string) => {
    setState({ value, cursor: value.length });
    historyIndexRef.current = null;
  }, []);

  const previousHistory = useCallback(() => {
    const history = historyRef.current;
    if (history.length === 0) {
      return;
    }

    setState((prev) => {
      if (historyIndexRef.current === null) {
        draftRef.current = prev.value;
        historyIndexRef.current = history.length - 1;
      } else {
        historyIndexRef.current = Math.max(0, historyIndexRef.current - 1);
      }

      const value = history[historyIndexRef.current] ?? prev.value;
      return { value, cursor: value.length };
    });
  }, []);

  const nextHistory = useCallback(() => {
    if (historyIndexRef.current === null) {
      return;
    }

    setState((prev) => {
      historyIndexRef.current = historyIndexRef.current! + 1;

      if (historyIndexRef.current >= historyRef.current.length) {
        historyIndexRef.current = null;
        return {
          value: draftRef.current,
          cursor: draftRef.current.length,
        };
      }

      const value = historyRef.current[historyIndexRef.current] ?? prev.value;
      return { value, cursor: value.length };
    });
  }, []);

  const submit = useCallback(() => {
    const submitted = state.value;
    if (submitted.trim()) {
      historyRef.current.push(submitted);
    }
    setState({ value: "", cursor: 0 });
    historyIndexRef.current = null;
    return submitted;
  }, [state.value]);

  return {
    ...state,
    setText,
    insert: (text) => apply((prev) =>
      applyTextInputKey(prev, { type: "insert", text })
    ),
    backspace: () => apply((prev) => applyTextInputKey(prev, { type: "backspace" })),
    moveLeft: (word = false) => apply((prev) =>
      applyTextInputKey(prev, { type: "left", word })
    ),
    moveRight: (word = false) => apply((prev) =>
      applyTextInputKey(prev, { type: "right", word })
    ),
    moveLineStart: () => apply((prev) => applyTextInputKey(prev, { type: "line_start" })),
    moveLineEnd: () => apply((prev) => applyTextInputKey(prev, { type: "line_end" })),
    killToLineStart: () => apply((prev) =>
      applyTextInputKey(prev, { type: "kill_line_start" })
    ),
    killToLineEnd: () => apply((prev) =>
      applyTextInputKey(prev, { type: "kill_line_end" })
    ),
    deletePreviousWord: () => apply((prev) =>
      applyTextInputKey(prev, { type: "delete_previous_word" })
    ),
    moveUp: () => {
      const next = moveCursorVertically(state, "up");
      if (!next) return false;
      setState(next);
      return true;
    },
    moveDown: () => {
      const next = moveCursorVertically(state, "down");
      if (!next) return false;
      setState(next);
      return true;
    },
    previousHistory,
    nextHistory,
    submit,
    renderValueWithCursor: () => renderValueWithCursor(state.value, state.cursor),
  };
}
