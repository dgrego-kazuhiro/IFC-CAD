import { BaseElement } from "../base/BaseElement";
import { ElementId } from "../base/ElementId";

export type WindowKind = "Fixed" | "Sliding" | "Casement";

export interface WindowElement extends BaseElement {
    type: "Window";
    openingId: ElementId;
    kind: WindowKind;
    width: number;
    height: number;
    sillHeight: number;
}
