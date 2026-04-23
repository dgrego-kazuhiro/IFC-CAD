import { Shape } from "./Shape";

export interface BrepShape extends Shape {
    kind: "Brep";
    faces: unknown[];
}
