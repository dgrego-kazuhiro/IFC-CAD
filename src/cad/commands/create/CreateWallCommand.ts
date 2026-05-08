import { Command } from '../base/Command';
import { CommandResult } from '../base/CommandResult';
import { useAppState } from '../../application/AppState';
import { WallElement } from '../../model/elements/WallElement';
import { ElementId } from '../../model/base/ElementId';
import { Vec3 } from '../../geometry/math/Vec3';
import { WallTypeOverride } from '../../model/catalog/ElementTypeDef';
import { effectiveWallType } from '../../model/catalog/TypeResolver';
import { mat4 } from 'gl-matrix';

export class CreateWallCommand implements Command {
    private elementId: ElementId;

    constructor(
        public axis: [Vec3, Vec3],
        /** WallType の id。AppState.types から引いて thickness / locationLine を導出。 */
        public typeId: ElementId,
        public height: number = 3.0,
        id?: ElementId,
        public baseLevelId?: ElementId,
        public overrides?: WallTypeOverride,
    ) {
        this.elementId = id || (Math.random().toString(36).substring(2, 11) as ElementId);
    }

    getElementId(): ElementId {
        return this.elementId;
    }

    execute(): CommandResult {
        const state = useAppState.getState();
        const eff = effectiveWallType(state.types, this.typeId, this.overrides);
        if (!eff) {
            return { success: false, message: `WallType not found: ${this.typeId}` };
        }

        const newWall: WallElement = {
            id: this.elementId,
            type: "Wall",
            name: "New Wall",
            visible: true,
            locked: false,
            transform: mat4.create(),
            dirtyFlags: new Set(["Geometry", "Mesh", "Render", "Topology"]),
            shape: null,
            typeId: this.typeId,
            overrides: this.overrides,
            axis: this.axis,
            // Type 由来のキャッシュ。Type 変更時に再投影。
            thickness: eff.thickness,
            height: this.height,
            baseOffset: 0,
            topOffset: 0,
            locationLine: eff.locationLine,
            baseLevelId: this.baseLevelId,
            joinStart: true,
            joinEnd: true,
            openings: []
        };

        state.addElement(newWall);
        return { success: true };
    }

    undo(): CommandResult {
        const state = useAppState.getState();
        state.removeElement(this.elementId);
        return { success: true };
    }
}
