import { Vec3 } from "../../geometry/math/Vec3";

export interface NotchModifier {
    type: "Notch";
    width: number;
    depth: number;
    z0: number;
    z1: number;
    face: "X+" | "X-" | "Y+" | "Y-";
}

export interface ClipPlaneModifier {
    type: "ClipPlane";
    origin: Vec3;
    normal: Vec3;
}

export interface CutModifier {
    type: "Cut";
}

export interface VoidModifier {
    type: "Void";
}

export type Modifier = CutModifier | VoidModifier | NotchModifier | ClipPlaneModifier;
