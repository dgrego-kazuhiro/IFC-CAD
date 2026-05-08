import { Command } from "../base/Command";
import { CommandResult } from "../base/CommandResult";
import { useAppState } from "../../application/AppState";
import { Vec3 } from "../../geometry/math/Vec3";
import { ElementId } from "../../model/base/ElementId";
import { BeamElement } from "../../model/elements/BeamElement";

/**
 * 配置済み Beam の `axis` (= [start, end]) を変更するコマンド。
 * 1 ドラッグ = 1 undo ステップに集約するため、ドラッグ開始時の元 axis を
 * `oldAxis` に保存しておく。
 */
export class UpdateBeamAxisCommand implements Command {
    private elementId: ElementId;
    private newAxis: [Vec3, Vec3];
    private oldAxis: [Vec3, Vec3] | null = null;

    constructor(elementId: ElementId, newAxis: [Vec3, Vec3]) {
        this.elementId = elementId;
        this.newAxis = newAxis;
    }

    public execute(): CommandResult {
        const state = useAppState.getState();
        const el = state.elements[this.elementId] as BeamElement | undefined;
        if (!el || el.type !== "Beam") {
            return { success: false, message: "Beam not found or invalid type" };
        }
        this.oldAxis = [
            [el.axis[0][0], el.axis[0][1], el.axis[0][2]],
            [el.axis[1][0], el.axis[1][1], el.axis[1][2]],
        ];
        state.updateElement(this.elementId, {
            axis: this.newAxis,
            dirtyFlags: new Set([...(el.dirtyFlags ?? []), "Geometry", "Mesh", "Render"]),
        } as any);
        return { success: true };
    }

    public undo(): CommandResult {
        if (!this.oldAxis) return { success: false, message: "Nothing to undo" };
        const state = useAppState.getState();
        const el = state.elements[this.elementId] as BeamElement | undefined;
        if (!el) return { success: false, message: "Beam missing" };
        state.updateElement(this.elementId, {
            axis: this.oldAxis,
            dirtyFlags: new Set([...(el.dirtyFlags ?? []), "Geometry", "Mesh", "Render"]),
        } as any);
        return { success: true };
    }
}
