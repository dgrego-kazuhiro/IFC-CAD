import { Command } from '../base/Command';
import { CommandResult } from '../base/CommandResult';

export class TransactionCommand implements Command {
    private commands: Command[] = [];
    private executed: Command[] = [];

    constructor(public name: string = "Transaction") {}

    add(command: Command) {
        this.commands.push(command);
    }

    execute(): CommandResult {
        this.executed = [];
        for (const cmd of this.commands) {
            const result = cmd.execute();
            if (!result.success) {
                // Rollback executed commands
                this.undo();
                return { success: false, message: `Command in transaction failed: ${result.message}` };
            }
            this.executed.push(cmd);
        }
        return { success: true };
    }

    undo(): CommandResult {
        // Undo in reverse order
        for (let i = this.executed.length - 1; i >= 0; i--) {
            this.executed[i].undo();
        }
        this.executed = [];
        return { success: true };
    }
}
