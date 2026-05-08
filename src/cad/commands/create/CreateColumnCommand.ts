import { Command } from "../base/Command";
import { CommandResult } from "../base/CommandResult";
import { useAppState } from "../../application/AppState";
import { ColumnElement, ColumnKind } from "../../model/elements/ColumnElement";
import { ElementId } from "../../model/base/ElementId";
import { Vec3 } from "../../geometry/math/Vec3";
import { ColumnTypeOverride } from "../../model/catalog/ElementTypeDef";
import { effectiveColumnType } from "../../model/catalog/TypeResolver";
import { mat4 } from "gl-matrix";

let nextId = 0;
function genId(): ElementId {
    nextId++;
    return `column-${Date.now().toString(36)}-${nextId.toString(36)}` as ElementId;
}

export class CreateColumnCommand implements Command {
    private elementId: ElementId;

    constructor(
        public basePoint: Vec3,
        /** ColumnType の id。AppState.types から引いて profile を導出。 */
        public typeId: ElementId,
        public baseLevelId?: ElementId,
        public topLevelId?: ElementId,
        public baseOffset: number = 0,
        public topOffset: number = 0,
        public rotation: number = 0,
        public kind: ColumnKind = "Structural",
        public overrides?: ColumnTypeOverride,
        id?: ElementId,
    ) {
        this.elementId = id ?? genId();
    }

    getElementId(): ElementId { return this.elementId; }

    execute(): CommandResult {
        const state = useAppState.getState();
        // Spec §16 validation
        if (this.baseLevelId && this.topLevelId && this.baseLevelId !== this.topLevelId) {
            const bl = state.levels.find((l) => l.id === this.baseLevelId);
            const tl = state.levels.find((l) => l.id === this.topLevelId);
            if (bl && tl && tl.elevation <= bl.elevation) {
                return { success: false, message: "Top level must be above base level" };
            }
        }

        const eff = effectiveColumnType(state.types, this.typeId, this.overrides);
        if (!eff) {
            return { success: false, message: `ColumnType not found: ${this.typeId}` };
        }

        const column: ColumnElement = {
            id: this.elementId,
            type: "Column",
            name: "New Column",
            visible: true,
            locked: false,
            transform: mat4.create(),
            dirtyFlags: new Set(["Geometry", "Mesh", "Render"]),
            shape: null,
            typeId: this.typeId,
            overrides: this.overrides,
            // profile は Type+overrides 由来のキャッシュ。Type 変更時に再投影。
            profile: eff.profile,
            basePoint: this.basePoint,
            baseLevelId: this.baseLevelId,
            topLevelId: this.topLevelId,
            baseOffset: this.baseOffset,
            topOffset: this.topOffset,
            rotation: this.rotation,
            kind: this.kind,
        };
        state.addElement(column);
        state.setSelection([this.elementId]);
        return { success: true };
    }

    undo(): CommandResult {
        const state = useAppState.getState();
        state.removeElement(this.elementId);
        return { success: true };
    }
}
