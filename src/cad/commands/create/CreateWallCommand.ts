import { Command } from '../base/Command';
import { CommandResult } from '../base/CommandResult';
import { useAppState } from '../../application/AppState';
import { WallElement } from '../../model/elements/WallElement';
import { ElementId } from '../../model/base/ElementId';
import { Vec3 } from '../../geometry/math/Vec3';
import { mat4 } from 'gl-matrix';

export class CreateWallCommand implements Command {
    private elementId: ElementId;

    constructor(
        public axis: [Vec3, Vec3],
        public thickness: number = 0.2, // 200mm default
        public height: number = 3.0,    // 3m height default
        id?: ElementId,
        public baseLevelId?: ElementId,
        public locationLine: WallElement["locationLine"] = "Center",
    ) {
        this.elementId = id || (Math.random().toString(36).substring(2, 11) as ElementId);
    }

    getElementId(): ElementId {
        return this.elementId;
    }

    execute(): CommandResult {
        const state = useAppState.getState();
        
        const newWall: WallElement = {
            id: this.elementId,
            type: "Wall",
            name: "New Wall",
            visible: true,
            locked: false,
            transform: mat4.create(),
            dirtyFlags: new Set(["Geometry", "Mesh", "Render", "Topology"]), // Needs to be built
            shape: null,
            axis: this.axis,
            thickness: this.thickness,
            height: this.height,
            baseOffset: 0,
            topOffset: 0,
            locationLine: this.locationLine,
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
