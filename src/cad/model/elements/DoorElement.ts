import { BaseElement } from "../base/BaseElement";
import { ElementId } from "../base/ElementId";

export type DoorKind = "Single" | "Double" | "Sliding";
export type DoorSwing = "Left" | "Right";

export interface DoorElement extends BaseElement {
    type: "Door";
    openingId: ElementId;
    kind: DoorKind;
    width: number;
    height: number;
    swingDirection: DoorSwing;
}
