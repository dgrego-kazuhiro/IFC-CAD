import { Shape } from "./Shape";
import { SweptSolidShape } from "./SweptSolidShape";
import { Modifier } from "../modifiers/Modifier";

export interface ClippingSolidShape extends Shape {
    kind: "ClippingSolid";
    base: SweptSolidShape;
    modifiers: Modifier[];
}
