import { Command } from "../base/Command";
import { CommandResult } from "../base/CommandResult";
import { useAppState } from "../../application/AppState";
import { OpeningElement } from "../../model/elements/OpeningElement";
import { DoorElement, DoorKind, DoorSwing } from "../../model/elements/DoorElement";
import { WallElement } from "../../model/elements/WallElement";
import { ElementId } from "../../model/base/ElementId";
import { mat4 } from "gl-matrix";

let nextId = 0;
function genId(): ElementId {
    nextId++;
    return `door-${Date.now().toString(36)}-${nextId.toString(36)}` as ElementId;
}

export class CreateDoorCommand implements Command {
    private openingId: ElementId;
    private doorId: ElementId;

    constructor(
        public hostWallId: ElementId,
        public position: number, // 0..1 along the wall
        public width: number,
        public height: number,
        public kind: DoorKind = "Single",
        public swingDirection: DoorSwing = "Right",
    ) {
        this.openingId = genId().replace("door-", "opening-") as ElementId;
        this.doorId = genId();
    }

    getDoorId(): ElementId { return this.doorId; }
    getOpeningId(): ElementId { return this.openingId; }

    execute(): CommandResult {
        const state = useAppState.getState();
        const wall = state.elements[this.hostWallId] as WallElement | undefined;
        if (!wall || wall.type !== "Wall") {
            return { success: false, message: `Host wall ${this.hostWallId} not found` };
        }

        const opening: OpeningElement = {
            id: this.openingId,
            type: "Opening",
            name: "Opening",
            visible: true,
            locked: false,
            transform: mat4.create(),
            dirtyFlags: new Set(["Geometry", "Mesh", "Render"]),
            shape: null,
            hostWallId: this.hostWallId,
            position: this.position,
            width: this.width,
            height: this.height,
            sillHeight: 0,
        };

        const door: DoorElement = {
            id: this.doorId,
            type: "Door",
            name: `Door (${this.kind})`,
            visible: true,
            locked: false,
            transform: mat4.create(),
            dirtyFlags: new Set(["Geometry", "Mesh", "Render"]),
            shape: null,
            openingId: this.openingId,
            kind: this.kind,
            width: this.width,
            height: this.height,
            swingDirection: this.swingDirection,
        };

        state.addElement(opening);
        state.addElement(door);
        // Link the opening into the host wall
        state.updateElement(this.hostWallId, {
            openings: [...(wall.openings ?? []), this.openingId],
            dirtyFlags: new Set([...wall.dirtyFlags, "Geometry", "Mesh", "Render"]),
        } as Partial<WallElement>);
        return { success: true };
    }

    undo(): CommandResult {
        const state = useAppState.getState();
        const wall = state.elements[this.hostWallId] as WallElement | undefined;
        if (wall) {
            state.updateElement(this.hostWallId, {
                openings: (wall.openings ?? []).filter((id) => id !== this.openingId),
                dirtyFlags: new Set([...wall.dirtyFlags, "Geometry", "Mesh", "Render"]),
            } as Partial<WallElement>);
        }
        state.removeElement(this.doorId);
        state.removeElement(this.openingId);
        return { success: true };
    }
}
