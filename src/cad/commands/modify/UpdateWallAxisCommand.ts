import { Command } from "../base/Command";
import { CommandResult } from "../base/CommandResult";
import { useAppState } from "../../application/AppState";
import { Vec3 } from "../../geometry/math/Vec3";
import { ElementId } from "../../model/base/ElementId";
import { WallElement } from "../../model/elements/WallElement";

export class UpdateWallAxisCommand implements Command {
    private elementId: ElementId;
    private newAxis: [Vec3, Vec3];
    private oldAxis: [Vec3, Vec3] | null = null;

    constructor(elementId: ElementId, newAxis: [Vec3, Vec3]) {
        this.elementId = elementId;
        this.newAxis = newAxis;
    }

    public execute(): CommandResult {
        const state = useAppState.getState();
        const element = state.elements[this.elementId] as WallElement;

        if (!element || element.type !== "Wall") {
            return { success: false, message: "Wall not found or invalid element type" };
        }

        this.oldAxis = [...element.axis] as [Vec3, Vec3];

        state.updateElement(this.elementId, {
            axis: this.newAxis,
            dirtyFlags: new Set([...element.dirtyFlags, "Geometry", "Mesh", "Render"])
        } as any);

        return { success: true };
    }

    public undo(): CommandResult {
        if (!this.oldAxis) {
            return { success: false, message: "Nothing to undo" };
        }

        const state = useAppState.getState();
        const element = state.elements[this.elementId];

        state.updateElement(this.elementId, {
            axis: this.oldAxis,
            dirtyFlags: new Set([...element.dirtyFlags, "Geometry", "Mesh", "Render"])
        } as any);

        return { success: true };
    }
}
