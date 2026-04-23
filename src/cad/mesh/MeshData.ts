import { ElementId } from "../model/base/ElementId";

export interface AABB {
    min: [number, number, number];
    max: [number, number, number];
}

export interface MeshData {
    positions: Float32Array;
    normals: Float32Array;
    indices: Uint32Array;
    edgeIndices?: Uint32Array;
    bounds: AABB;
    topology?: "triangle-list" | "line-list";
}
