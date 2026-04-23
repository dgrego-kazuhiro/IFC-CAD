import { BaseElement } from "../base/BaseElement";
import { Vec2 } from "../../geometry/math/Vec2";
import { ElementId } from "../base/ElementId";

export interface SlabElement extends BaseElement {
    type: "Slab";
    boundary: Vec2[];
    holes?: Vec2[][];
    thickness: number;
    elevation: number;
    levelId?: ElementId;
}
