import { MeshData } from "../MeshData";
import { AABB } from "../../geometry/primitives/AABB";
import { Vec3 } from "../../geometry/math/Vec3";
import { vec3 } from "gl-matrix";

export interface WindowMeshParams {
    center: Vec3;     // bottom-center of the window opening
    axisDir: Vec3;
    normalDir: Vec3;
    width: number;
    height: number;
    thickness: number;
}

// Simple window: a thin transparent-ish glass panel inside the opening.
// Matches the door builder shape but typically rendered with a different color.
export class WindowMeshBuilder {
    public static build(p: WindowMeshParams): MeshData {
        const halfW = p.width / 2;
        const halfT = p.thickness / 2;
        const ax = p.axisDir;
        const nx = p.normalDir;

        const c = (sw: number, sn: number, sy: number): Vec3 => [
            p.center[0] + ax[0] * sw + nx[0] * sn,
            p.center[1] + sy,
            p.center[2] + ax[2] * sw + nx[2] * sn,
        ];

        const b0 = c(-halfW, -halfT, 0);
        const b1 = c( halfW, -halfT, 0);
        const b2 = c( halfW,  halfT, 0);
        const b3 = c(-halfW,  halfT, 0);
        const t0 = c(-halfW, -halfT, p.height);
        const t1 = c( halfW, -halfT, p.height);
        const t2 = c( halfW,  halfT, p.height);
        const t3 = c(-halfW,  halfT, p.height);

        const positions: number[] = [];
        const normals: number[] = [];
        const indices: number[] = [];
        const edges: number[] = [];
        let off = 0;

        const addFace = (p0: Vec3, p1: Vec3, p2: Vec3, p3: Vec3) => {
            positions.push(...p0, ...p1, ...p2, ...p3);
            const v1 = vec3.subtract(vec3.create(), p1, p0);
            const v2 = vec3.subtract(vec3.create(), p2, p1);
            const n = vec3.cross(vec3.create(), v1, v2);
            vec3.normalize(n, n);
            for (let i = 0; i < 4; i++) normals.push(...n);
            indices.push(off, off + 1, off + 2, off, off + 2, off + 3);
            off += 4;
        };

        addFace(b0, b1, t1, t0);
        addFace(b2, b3, t3, t2);
        addFace(b1, b2, t2, t1);
        addFace(b3, b0, t0, t3);
        addFace(t0, t1, t2, t3);
        addFace(b3, b2, b1, b0);

        // Glass pane outline: only the 4-sided rectangle on each face,
        // appended as edge-only vertices so we don't reuse the per-face
        // quad outlines (which would emit duplicated lines that overlap
        // with the surrounding wall opening edges).
        const addEdgePoint = (p: Vec3): number => {
            const idx = positions.length / 3;
            positions.push(p[0], p[1], p[2]);
            normals.push(0, 1, 0);
            return idx;
        };
        const addEdge = (a: Vec3, b: Vec3) => {
            edges.push(addEdgePoint(a), addEdgePoint(b));
        };
        // Front face frame
        addEdge(b2, b3); addEdge(b3, t3); addEdge(t3, t2); addEdge(t2, b2);
        // Back face frame
        addEdge(b0, b1); addEdge(b1, t1); addEdge(t1, t0); addEdge(t0, b0);

        const posArray = new Float32Array(positions);
        let minX = Infinity, minY = Infinity, minZ = Infinity;
        let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
        for (let i = 0; i < posArray.length; i += 3) {
            const x = posArray[i], y = posArray[i + 1], z = posArray[i + 2];
            if (x < minX) minX = x; if (x > maxX) maxX = x;
            if (y < minY) minY = y; if (y > maxY) maxY = y;
            if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
        }
        const bounds: AABB = { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] };

        return {
            positions: posArray,
            normals: new Float32Array(normals),
            indices: new Uint32Array(indices),
            edgeIndices: new Uint32Array(edges),
            bounds,
        };
    }
}
