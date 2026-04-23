export type ShapeKind =
    | "SweptSolid"
    | "ClippingSolid"
    | "Brep"
    | "Mesh";

export interface Shape {
    kind: ShapeKind;
}
