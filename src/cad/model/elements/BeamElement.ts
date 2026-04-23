import { BaseElement } from "../base/BaseElement";
import { Vec3 } from "../../geometry/math/Vec3";
import { ElementId } from "../base/ElementId";
import { Profile } from "../profiles/Profile";

export type BeamZJustification = "Top" | "Center" | "Bottom";
export type BeamKind = "Structural" | "Architectural";

// Linear structural element defined by a 2-point axis plus a cross-section
// profile and vertical constraint. See docs/specification/beam_ui_spec.md.
export interface BeamElement extends BaseElement {
    type: "Beam";
    axis: [Vec3, Vec3];
    profile: Profile;
    levelId?: ElementId;
    /** Offset from the beam reference elevation (level elevation + justification). */
    topOffset: number;
    /** How the profile is anchored vertically relative to `level + topOffset`. */
    zJustification: BeamZJustification;
    /** Rotation of the profile around the beam axis, in radians. */
    rotation: number;
    kind: BeamKind;
}
