import { Shape } from "./Shape";

export interface MeshShape extends Shape {
    kind: "Mesh";
    vertices: Float32Array;
    indices: Uint32Array;
}
