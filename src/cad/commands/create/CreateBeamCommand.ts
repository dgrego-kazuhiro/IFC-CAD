import { Command } from "../base/Command";
import { CommandResult } from "../base/CommandResult";
import { useAppState } from "../../application/AppState";
import { BeamElement, BeamZJustification, BeamKind } from "../../model/elements/BeamElement";
import { ElementId } from "../../model/base/ElementId";
import { Vec3 } from "../../geometry/math/Vec3";
import { Profile, RectangleProfile } from "../../model/profiles/Profile";
import { mat4 } from "gl-matrix";

let nextId = 0;
function genId(): ElementId {
    nextId++;
    return `beam-${Date.now().toString(36)}-${nextId.toString(36)}` as ElementId;
}

export class CreateBeamCommand implements Command {
    private elementId: ElementId;

    constructor(
        public axis: [Vec3, Vec3],
        public profile: Profile = { kind: "Rectangle", width: 0.3, depth: 0.6 } as RectangleProfile,
        public topOffset: number = 0,
        public zJustification: BeamZJustification = "Top",
        public rotation: number = 0,
        public levelId?: ElementId,
        public kind: BeamKind = "Structural",
        id?: ElementId,
    ) {
        this.elementId = id ?? genId();
    }

    getElementId(): ElementId { return this.elementId; }

    execute(): CommandResult {
        const state = useAppState.getState();
        const beam: BeamElement = {
            id: this.elementId,
            type: "Beam",
            name: "New Beam",
            visible: true,
            locked: false,
            transform: mat4.create(),
            dirtyFlags: new Set(["Geometry", "Mesh", "Render"]),
            shape: null,
            axis: this.axis,
            profile: this.profile,
            levelId: this.levelId,
            topOffset: this.topOffset,
            zJustification: this.zJustification,
            rotation: this.rotation,
            kind: this.kind,
        };
        state.addElement(beam);
        state.setSelection([this.elementId]);
        return { success: true };
    }

    undo(): CommandResult {
        const state = useAppState.getState();
        state.removeElement(this.elementId);
        return { success: true };
    }
}
