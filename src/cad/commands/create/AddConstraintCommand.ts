import { Command } from "../base/Command";
import { CommandResult } from "../base/CommandResult";
import { useAppState } from "../../application/AppState";
import { Constraint } from "../../model/constraint/Constraint";

let nextId = 0;
export function generateConstraintId(): string {
    nextId++;
    return `constraint-${Date.now().toString(36)}-${nextId.toString(36)}`;
}

export class AddConstraintCommand implements Command {
    constructor(
        public constraint: Constraint,
        private options: { solve?: boolean } = {},
    ) {}

    execute(): CommandResult {
        if (this.options.solve === false) {
            useAppState.setState((state) => ({
                constraints: { ...state.constraints, [this.constraint.id]: this.constraint },
            }));
        } else {
            useAppState.getState().addConstraint(this.constraint);
        }
        return { success: true };
    }

    undo(): CommandResult {
        if (this.options.solve === false) {
            useAppState.setState((state) => {
                const { [this.constraint.id]: _removed, ...rest } = state.constraints;
                return {
                    constraints: rest,
                    selectedConstraintId: state.selectedConstraintId === this.constraint.id
                        ? null
                        : state.selectedConstraintId,
                };
            });
        } else {
            useAppState.getState().removeConstraint(this.constraint.id);
        }
        return { success: true };
    }
}

export class RemoveConstraintCommand implements Command {
    private snapshot: Constraint | null = null;

    constructor(public constraintId: string) {}

    execute(): CommandResult {
        const state = useAppState.getState();
        const c = state.constraints[this.constraintId];
        if (!c) return { success: false, message: `Constraint ${this.constraintId} not found` };
        this.snapshot = c;
        state.removeConstraint(this.constraintId);
        return { success: true };
    }

    undo(): CommandResult {
        if (this.snapshot) useAppState.getState().addConstraint(this.snapshot);
        return { success: true };
    }
}
