import { BaseElement } from "../base/BaseElement";
import { Vec3 } from "../../geometry/math/Vec3";
import { ElementId } from "../base/ElementId";
import { Profile } from "../profiles/Profile";
import type { BeamTypeOverride } from "../catalog/ElementTypeDef";

export type BeamZJustification = "Top" | "Center" | "Bottom";
export type BeamKind = "Structural" | "Architectural";

// Linear structural element defined by a 2-point axis plus a cross-section
// profile and vertical constraint. See docs/specification/beam_ui_spec.md.
//
// Type 化: 断面 (`profile`) は BeamType 由来。`typeId` で参照、`profile` は
// その有効値キャッシュ (Type 変更時に Command 側で再投影)。
export interface BeamElement extends BaseElement {
    type: "Beam";
    /** 参照する BeamType の id。 */
    typeId: ElementId;
    overrides?: BeamTypeOverride;
    /** Type+overrides から導出された有効断面のキャッシュ。 */
    profile: Profile;

    axis: [Vec3, Vec3];
    levelId?: ElementId;
    /** Offset from the beam reference elevation (level elevation + justification). */
    topOffset: number;
    /** How the profile is anchored vertically relative to `level + topOffset`. */
    zJustification: BeamZJustification;
    /** Rotation of the profile around the beam axis, in radians. */
    rotation: number;
    kind: BeamKind;
}
