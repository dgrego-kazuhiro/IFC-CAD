import { Command } from "../base/Command";
import { CommandResult } from "../base/CommandResult";
import { useAppState } from "../../application/AppState";
import {
    StairElement,
    BaseStairParams,
    StairExtras,
} from "../../model/elements/StairElement";
import { ElementId } from "../../model/base/ElementId";
import { mat4 } from "gl-matrix";

let nextId = 0;
function genId(): ElementId {
    nextId++;
    return `stair-${Date.now().toString(36)}-${nextId.toString(36)}` as ElementId;
}

/**
 * 階段作成コマンド。直階段 / U 字階段の両方を扱う。
 *
 * 形状はパラメータから StairMeshBuilder が直接生成するため、Type 系は
 * 通さない (= Wall/Column 等と異なり、stair はパラメータが直接 element
 * フィールドになる PoC 設計)。
 */
export class CreateStairCommand implements Command {
    private elementId: ElementId;

    constructor(
        public params: BaseStairParams & StairExtras,
        public name: string = "Stair",
        id?: ElementId,
    ) {
        this.elementId = id ?? genId();
    }

    getElementId(): ElementId { return this.elementId; }

    execute(): CommandResult {
        const state = useAppState.getState();

        const stair: StairElement = {
            id: this.elementId,
            type: "Stair",
            name: this.name,
            visible: true,
            locked: false,
            transform: mat4.create(),
            dirtyFlags: new Set(["Geometry", "Mesh", "Render"]),
            shape: null,
            ...this.params,
        };
        state.addElement(stair);
        state.setSelection([this.elementId]);
        return { success: true };
    }

    undo(): CommandResult {
        const state = useAppState.getState();
        state.removeElement(this.elementId);
        return { success: true };
    }
}
