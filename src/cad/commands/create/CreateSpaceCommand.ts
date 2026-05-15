import { Command } from '../base/Command';
import { CommandResult } from '../base/CommandResult';
import { useAppState } from '../../application/AppState';
import { SpaceElement } from '../../model/elements/SpaceElement';
import { ElementId } from '../../model/base/ElementId';
import { mat4 } from 'gl-matrix';

export class CreateSpaceCommand implements Command {
    private elementId: ElementId;

    constructor(
        public name: string,
        public height: number = 3.0,
        id?: ElementId,
        public baseLevelId?: ElementId,
    ) {
        this.elementId = id || (Math.random().toString(36).substring(2, 11) as ElementId);
    }

    getElementId(): ElementId {
        return this.elementId;
    }

    execute(): CommandResult {
        const state = useAppState.getState();

        const newSpace: SpaceElement = {
            id: this.elementId,
            type: "Space",
            name: this.name,
            visible: true,
            locked: false,
            transform: mat4.create(),
            dirtyFlags: new Set(["Geometry", "Mesh", "Render"]),
            shape: null,
            boundary: [],
            polygons: [],
            entities: [],
            area: 0,
            height: this.height,
            levelId: this.baseLevelId,
            // 重なり領域のピック優先度に使う作成時刻。後から作った Room ほど
            // 値が大きく、矩形が重なったときに上側として優先的に選ばれる。
            createdAt: Date.now(),
        };

        state.addElement(newSpace);
        return { success: true };
    }

    undo(): CommandResult {
        const state = useAppState.getState();
        state.removeElement(this.elementId);
        return { success: true };
    }
}
