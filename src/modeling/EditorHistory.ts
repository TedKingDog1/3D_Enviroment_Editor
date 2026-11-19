export interface HistoryCommand {
  label: string;
  undo: () => void;
  redo: () => void;
}

/**
 * Central command-based history for editor actions.
 * Commands should represent one completed user action, not every pointer-move frame.
 */
export class EditorHistory {
  private undoStack: HistoryCommand[] = [];
  private redoStack: HistoryCommand[] = [];
  private readonly limit: number;
  private readonly onChange?: () => void;

  constructor(limit = 100, onChange?: () => void) {
    this.limit = limit;
    this.onChange = onChange;
  }

  get canUndo(): boolean { return this.undoStack.length > 0; }
  get canRedo(): boolean { return this.redoStack.length > 0; }
  get undoLabel(): string | null { return this.undoStack[this.undoStack.length - 1]?.label ?? null; }
  get redoLabel(): string | null { return this.redoStack[this.redoStack.length - 1]?.label ?? null; }

  record(command: HistoryCommand): void {
    this.undoStack.push(command);
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack.length = 0;
    this.onChange?.();
  }

  undo(): boolean {
    const command = this.undoStack[this.undoStack.length - 1];
    if (!command) return false;
    command.undo();
    this.undoStack.pop();
    this.redoStack.push(command);
    this.onChange?.();
    return true;
  }

  redo(): boolean {
    const command = this.redoStack[this.redoStack.length - 1];
    if (!command) return false;
    command.redo();
    this.redoStack.pop();
    this.undoStack.push(command);
    this.onChange?.();
    return true;
  }

  clear(): void {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.onChange?.();
  }
}
