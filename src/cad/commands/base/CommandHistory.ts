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
            if (command.redo) {
                this.redoStack.push(command);
            }
        } else {
            // Put it back if undo failed? Handled basically.
            this.undoStack.push(command);
        }
        return result;
    }

    public redo() {
        if (this.redoStack.length === 0) return { success: false, message: "Nothing to redo" };
        const command = this.redoStack.pop()!;
        if (command.redo) {
            const result = command.redo();
            if (result.success) {
                this.undoStack.push(command);
            } else {
                this.redoStack.push(command);
            }
            return result;
        }
        return { success: false, message: "Command cannot be redone" };
    }
}
