import { MeshData } from "./MeshData";
import { AABB } from "../geometry/primitives/AABB";

export class MeshBuilder {
    public static createCube(): MeshData {
        const s = 1.0;
        const positions = new Float32Array([
            // front
            -s, -s, s, s, -s, s, s, s, s, -s, s, s,
            // back
            -s, -s, -s, -s, s, -s, s, s, -s, s, -s, -s,
            // top
            -s, s, -s, -s, s, s, s, s, s, s, s, -s,
            // bottom
            -s, -s, -s, s, -s, -s, s, -s, s, -s, -s, s,
            // right
            s, -s, -s, s, s, -s, s, s, s, s, -s, s,
            // left
            -s, -s, -s, -s, -s, s, -s, s, s, -s, s, -s,
        ]);

        const normals = new Float32Array([
            // front
            0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1,
            // back
            0, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0, -1,
            // top
            0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0,
            // bottom
            0, -1, 0, 0, -1, 0, 0, -1, 0, 0, -1, 0,
            // right
            1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0,
            // left
            -1, 0, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0,
        ]);

        const indices = new Uint32Array([
            0, 1, 2, 0, 2, 3,    // front
            4, 5, 6, 4, 6, 7,    // back
            8, 9, 10, 8, 10, 11,   // top
            12, 13, 14, 12, 14, 15,   // bottom
            16, 17, 18, 16, 18, 19,   // right
            20, 21, 22, 20, 22, 23,   // left
        ]);

        const bounds: AABB = {
            min: [-s, -s, -s],
            max: [s, s, s],
        };

        return { positions, normals, indices, bounds };
    }
}
