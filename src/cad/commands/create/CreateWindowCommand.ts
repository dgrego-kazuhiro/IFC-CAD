import { Command } from "../base/Command";
import { CommandResult } from "../base/CommandResult";
import { useAppState } from "../../application/AppState";
import { OpeningElement } from "../../model/elements/OpeningElement";
import { WindowElement, WindowKind } from "../../model/elements/WindowElement";
import { WallElement } from "../../model/elements/WallElement";
import { ElementId } from "../../model/base/ElementId";
import { mat4 } from "gl-matrix";

let nextId = 0;
function genId(prefix: string): ElementId {
    nextId++;
    return `${prefix}-${Date.now().toString(36)}-${nextId.toString(36)}` as ElementId;
}

export class CreateWindowCommand implements Command {
    private openingId: ElementId;
    private windowId: ElementId;

    constructor(
        public hostWallId: ElementId,
        public position: number,
        public width: number,
        public height: number,
        public sillHeight: number = 0.9,
        public kind: WindowKind = "Fixed",
    ) {
        this.openingId = genId("opening");
        this.windowId = genId("window");
    }

    getWindowId(): ElementId { return this.windowId; }
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
            sillHeight: this.sillHeight,
        };

        const window: WindowElement = {
            id: this.windowId,
            type: "Window",
            name: `Window (${this.kind})`,
            visible: true,
            locked: false,
            transform: mat4.create(),
            dirtyFlags: new Set(["Geometry", "Mesh", "Render"]),
            shape: null,
            openingId: this.openingId,
            kind: this.kind,
            width: this.width,
            height: this.height,
            sillHeight: this.sillHeight,
        };

        state.addElement(opening);
        state.addElement(window);
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
        state.removeElement(this.windowId);
        state.removeElement(this.openingId);
        return { success: true };
    }
}
