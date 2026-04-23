import { BaseElement } from "../base/BaseElement";
import { Profile } from "../profiles/Profile";
import { Modifier } from "../modifiers/Modifier";
import { ElementId } from "../base/ElementId";
import { Vec3 } from "../../geometry/math/Vec3";

export type ColumnKind = "Structural" | "Architectural";

// Point-based structural element (spec §2/§3). Anchored by basePoint in XZ
// and vertically by base/top level references plus offsets. Extruded from
// the profile over the full height.
export interface ColumnElement extends BaseElement {
    type: "Column";
    basePoint: Vec3;
    profile: Profile;
    baseLevelId?: ElementId;
    topLevelId?: ElementId;
    baseOffset: number;
    topOffset: number;
    /** Rotation around the vertical axis, in radians. */
    rotation: number;
    kind: ColumnKind;
    stackId?: ElementId;
    modifiers?: Modifier[];
}
