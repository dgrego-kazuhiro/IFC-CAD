import { Command } from "../base/Command";
import { CommandResult } from "../base/CommandResult";
import { useAppState } from "../../application/AppState";
import { Vec3 } from "../../geometry/math/Vec3";
import { ElementId } from "../../model/base/ElementId";
import { ColumnElement } from "../../model/elements/ColumnElement";

/**
 * 配置済み Column の `basePoint` を変更するコマンド。Wall axis の
 * `UpdateWallAxisCommand` と同じパターン。undo / redo 可。
 */
export class UpdateColumnBasePointCommand implements Command {
    private elementId: ElementId;
    private newBasePoint: Vec3;
    private oldBasePoint: Vec3 | null = null;

    constructor(elementId: ElementId, newBasePoint: Vec3) {
        this.elementId = elementId;
        this.newBasePoint = newBasePoint;
    }

    public execute(): CommandResult {
        const state = useAppState.getState();
        const el = state.elements[this.elementId] as ColumnElement | undefined;
        if (!el || el.type !== "Column") {
            return { success: false, message: "Column not found or invalid element type" };
        }
        this.oldBasePoint = [el.basePoint[0], el.basePoint[1], el.basePoint[2]];
        state.updateElement(this.elementId, {
            basePoint: [this.newBasePoint[0], this.newBasePoint[1], this.newBasePoint[2]],
            dirtyFlags: new Set([...(el.dirtyFlags ?? []), "Geometry", "Mesh", "Render"]),
        } as any);
        return { success: true };
    }

    public undo(): CommandResult {
        if (!this.oldBasePoint) return { success: false, message: "Nothing to undo" };
        const state = useAppState.getState();
        const el = state.elements[this.elementId] as ColumnElement | undefined;
        if (!el) return { success: false, message: "Column missing" };
        state.updateElement(this.elementId, {
            basePoint: this.oldBasePoint,
            dirtyFlags: new Set([...(el.dirtyFlags ?? []), "Geometry", "Mesh", "Render"]),
        } as any);
        return { success: true };
    }
}
