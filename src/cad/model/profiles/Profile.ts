import { Vec2 } from "../../geometry/math/Vec2";

export interface RectangleProfile {
    kind: "Rectangle";
    width: number;
    depth: number;
}

export interface CircleProfile {
    kind: "Circle";
    radius: number;
}

export interface IShapeProfile {
    kind: "IShape";
    // ... other parameters ...
}

export interface TShapeProfile {
    kind: "TShape";
}

export interface LShapeProfile {
    kind: "LShape";
}

export interface UShapeProfile {
    kind: "UShape";
}

export interface ArbitraryClosedProfile {
    kind: "Arbitrary";
    points: Vec2[];
}

export type Profile =
    | RectangleProfile
    | CircleProfile
    | IShapeProfile
    | TShapeProfile
    | LShapeProfile
    | UShapeProfile
    | ArbitraryClosedProfile;
