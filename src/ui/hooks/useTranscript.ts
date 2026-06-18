import { useMemo, useState } from "react";
import type { Dispatch, SetStateAction } from "react";

export interface TranscriptState {
  isOpen: boolean;
  scroll: number;
  search: string;
  isSearching: boolean;
}

export function createTranscriptState(): TranscriptState {
  return {
    isOpen: false,
    scroll: 0,
    search: "",
    isSearching: false,
  };
}

export function clampScroll(scroll: number, lineCount: number, height: number): number {
  return Math.max(0, Math.min(scroll, Math.max(0, lineCount - height)));
}

export function findSearchMatch(
  lines: string[],
  search: string,
  start: number,
  direction: "next" | "previous",
): number {
  if (!search.trim()) {
    return start;
  }

  const needle = search.toLowerCase();
  const step = direction === "next" ? 1 : -1;
  let index = start;

  for (let checked = 0; checked < lines.length; checked += 1) {
    index = (index + step + lines.length) % lines.length;
    if (lines[index]?.toLowerCase().includes(needle)) {
      return index;
    }
  }

  return start;
}

export function reduceTranscriptState(
  state: TranscriptState,
  action:
    | { type: "open" }
    | { type: "close" }
    | { type: "scroll"; delta: number; lineCount: number; height: number }
    | { type: "top" }
    | { type: "bottom"; lineCount: number; height: number }
    | { type: "search_start" }
    | { type: "search_append"; text: string }
    | { type: "search_backspace" }
    | { type: "search_commit"; lines: string[] }
    | { type: "search_next"; lines: string[] }
    | { type: "search_previous"; lines: string[] },
): TranscriptState {
  switch (action.type) {
    case "open":
      return { ...state, isOpen: true, isSearching: false };
    case "close":
      return { ...state, isOpen: false, isSearching: false };
    case "scroll":
      return {
        ...state,
        scroll: clampScroll(
          state.scroll + action.delta,
          action.lineCount,
          action.height,
        ),
      };
    case "top":
      return { ...state, scroll: 0 };
    case "bottom":
      return {
        ...state,
        scroll: clampScroll(action.lineCount, action.lineCount, action.height),
      };
    case "search_start":
      return { ...state, isSearching: true, search: "" };
    case "search_append":
      return { ...state, search: state.search + action.text };
    case "search_backspace":
      return { ...state, search: state.search.slice(0, -1) };
    case "search_commit":
      return {
        ...state,
        isSearching: false,
        scroll: findSearchMatch(action.lines, state.search, state.scroll, "next"),
      };
    case "search_next":
      return {
        ...state,
        scroll: findSearchMatch(action.lines, state.search, state.scroll, "next"),
      };
    case "search_previous":
      return {
        ...state,
        scroll: findSearchMatch(
          action.lines,
          state.search,
          state.scroll,
          "previous",
        ),
      };
  }
}

export function useTranscript(lines: string[]): {
  state: TranscriptState;
  visibleLines: string[];
  setState: Dispatch<SetStateAction<TranscriptState>>;
  height: number;
} {
  const [state, setState] = useState(createTranscriptState);
  const height = 24;
  const visibleLines = useMemo(
    () => lines.slice(state.scroll, state.scroll + height),
    [height, lines, state.scroll],
  );

  return { state, visibleLines, setState, height };
}
