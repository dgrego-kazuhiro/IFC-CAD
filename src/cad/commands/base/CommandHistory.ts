import { Command } from "./Command";

export class CommandHistory {
    private undoStack: Command[] = [];
    private redoStack: Command[] = [];

    public execute(command: Command) {
        const result = command.execute();
        if (result.success) {
            this.undoStack.push(command);
            this.redoStack = []; // clear redo stack
        }
        return result;
    }

    public undo() {
        if (this.undoStack.length === 0) return { success: false, message: "Nothing to undo" };
        const command = this.undoStack.pop()!;
        const result = command.undo();
        if (result.success) {
            // 既定で execute() を redo として再利用できるよう、redo メソッドの
            // 有無に関わらず redoStack に積む。Command が execute() を冪等に
            // 設計していれば (= 生成 ID をフィールドで保持等)、再実行で同じ
            // 状態が復元される。
            this.redoStack.push(command);
        } else {
            // Put it back if undo failed.
            this.undoStack.push(command);
        }
        return result;
    }

    public redo() {
        if (this.redoStack.length === 0) return { success: false, message: "Nothing to redo" };
        const command = this.redoStack.pop()!;
        // command.redo があればそれを優先、無ければ execute() フォールバック。
        const result = command.redo ? command.redo() : command.execute();
        if (result.success) {
            this.undoStack.push(command);
        } else {
            this.redoStack.push(command);
        }
        return result;
    }

    public canUndo(): boolean {
        return this.undoStack.length > 0;
    }

    public canRedo(): boolean {
        return this.redoStack.length > 0;
    }

    public clear(): void {
        this.undoStack = [];
        this.redoStack = [];
    }
}
