import { CommandResult } from "./CommandResult";

export interface Command {
    execute(): CommandResult;
    undo(): CommandResult;
    redo?(): CommandResult;
}
