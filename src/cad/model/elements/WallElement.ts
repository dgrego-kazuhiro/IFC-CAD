import { BaseElement } from "../base/BaseElement";
import { Vec3 } from "../../geometry/math/Vec3";
import { ElementId } from "../base/ElementId";

export interface WallElement extends BaseElement {
    type: "Wall";
    axis: [Vec3, Vec3];
    thickness: number;
    height: number;
    baseLevelId?: ElementId;
    topLevelId?: ElementId;
    baseOffset: number;
    topOffset: number;
    locationLine: "Center" | "FinishExterior" | "FinishInterior" | "CoreCenter";
    joinStart: boolean;
    joinEnd: boolean;
    openings: ElementId[];
    wallTypeId?: ElementId;
}
