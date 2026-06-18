import type { TextInputController } from "./useTextInput.js";

interface PromptKey {
  return?: boolean;
  meta?: boolean;
  leftArrow?: boolean;
  rightArrow?: boolean;
  upArrow?: boolean;
  downArrow?: boolean;
  ctrl?: boolean;
  backspace?: boolean;
  delete?: boolean;
}

export function handlePromptInputKey(params: {
  input: string;
  key: PromptKey;
  editor: TextInputController;
  onSubmit: (text: string) => void;
}): boolean {
  const { input, key, editor, onSubmit } = params;

  if (key.return && key.meta) {
    editor.insert("\n");
    return true;
  }

  if (key.return) {
    onSubmit(editor.submit());
    return true;
  }

  if (key.leftArrow) {
    editor.moveLeft(key.meta);
    return true;
  }

  if (key.rightArrow) {
    editor.moveRight(key.meta);
    return true;
  }

  if (key.upArrow) {
    if (!editor.moveUp()) {
      editor.previousHistory();
    }
    return true;
  }

  if (key.downArrow) {
    if (!editor.moveDown()) {
      editor.nextHistory();
    }
    return true;
  }

  if (key.ctrl && input === "a") {
    editor.moveLineStart();
    return true;
  }

  if (key.ctrl && input === "e") {
    editor.moveLineEnd();
    return true;
  }

  if (key.ctrl && input === "w") {
    editor.deletePreviousWord();
    return true;
  }

  if (key.ctrl && input === "u") {
    editor.killToLineStart();
    return true;
  }

  if (key.ctrl && input === "k") {
    editor.killToLineEnd();
    return true;
  }

  if (key.backspace || key.delete) {
    editor.backspace();
    return true;
  }

  if (input && !key.ctrl && !key.meta) {
    editor.insert(input);
    return true;
  }

  return false;
}
