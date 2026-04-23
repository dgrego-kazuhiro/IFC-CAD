import { MeshData } from "../MeshData";
import { Vec3 } from "../../geometry/math/Vec3";

export interface LineMeshOptions {
    thickness?: number;   // world units
    jointSize?: number;   // world units; set to 0 to skip joint squares
    y?: number;           // world Y for the generated quad strip (default 0.01)
}

export class LineMeshBuilder {
    public static build(points: Vec3[], opts?: LineMeshOptions): MeshData {
        const positions: number[] = [];
        const normals: number[] = [];
        const indices: number[] = [];

        let minX = Infinity, minY = Infinity, minZ = Infinity;
        let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

        const thickness = opts?.thickness ?? 0.1;
        const halfT = thickness / 2;
        const jointSize = opts?.jointSize ?? 0.15;
        const halfJ = jointSize / 2;
        const drawJoints = jointSize > 0;
        const segY = opts?.y ?? 0.01;
        // Joints stay just above the segment so rounded corners visually cap
        // line ends instead of z-fighting with them.
        const jointY = segY + 0.005;

        for (let i = 0; i < points.length; i++) {
            const p = points[i];

            if (drawJoints) {
                const baseIdx = positions.length / 3;
                positions.push(
                    p[0] - halfJ, jointY, p[2] - halfJ,
                    p[0] + halfJ, jointY, p[2] - halfJ,
                    p[0] + halfJ, jointY, p[2] + halfJ,
                    p[0] - halfJ, jointY, p[2] + halfJ
                );
                for (let j = 0; j < 4; j++) normals.push(0, 1, 0);
                indices.push(
                    baseIdx, baseIdx + 1, baseIdx + 2,
                    baseIdx, baseIdx + 2, baseIdx + 3
                );
            }

            if (p[0] < minX) minX = p[0];
            if (p[0] > maxX) maxX = p[0];
            if (p[2] < minZ) minZ = p[2];
            if (p[2] > maxZ) maxZ = p[2];
        }

        // Connect as thick line segments (quads)
        for (let i = 0; i < points.length - 1; i++) {
            const p1 = points[i];
            const p2 = points[i + 1];

            const dx = p2[0] - p1[0];
            const dz = p2[2] - p1[2];
            const len = Math.sqrt(dx * dx + dz * dz) || 1;

            const nx = (-dz / len) * halfT;
            const nz = (dx / len) * halfT;

            const baseIdx = positions.length / 3;

            positions.push(
                p1[0] - nx, segY, p1[2] - nz,
                p1[0] + nx, segY, p1[2] + nz,
                p2[0] + nx, segY, p2[2] + nz,
                p2[0] - nx, segY, p2[2] - nz
            );

            for (let j = 0; j < 4; j++) normals.push(0, 1, 0);

            indices.push(
                baseIdx, baseIdx + 1, baseIdx + 2,
                baseIdx, baseIdx + 2, baseIdx + 3
            );
        }

        return {
            positions: new Float32Array(positions),
            normals: new Float32Array(normals),
            indices: new Uint32Array(indices),
            bounds: {
                min: [minX - jointSize, 0, minZ - jointSize],
                max: [maxX + jointSize, 0, maxZ + jointSize]
            },
            topology: "triangle-list"
        };
    }
}
