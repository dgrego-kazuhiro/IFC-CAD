import { mat4 } from "gl-matrix";
import { ElementId } from "./ElementId";
import { ElementType } from "./ElementType";
import { DirtyFlags } from "./DirtyFlags";
import { Shape } from "../shapes/Shape";

export interface BaseElement {
    id: ElementId;
    type: ElementType;
    name?: string;
    visible: boolean;
    locked: boolean;
    transform: mat4;
    dirtyFlags: DirtyFlags;
    shape: Shape | null; // null initially until built
}
