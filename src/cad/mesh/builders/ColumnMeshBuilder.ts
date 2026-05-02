import { MeshData } from "../MeshData";
import { AABB } from "../../geometry/primitives/AABB";
import { Vec3 } from "../../geometry/math/Vec3";
import { Vec2 } from "../../geometry/math/Vec2";
import { vec3 } from "gl-matrix";
import { ColumnElement } from "../../model/elements/ColumnElement";
import { Profile } from "../../model/profiles/Profile";

export interface ColumnMeshParams {
    basePoint: Vec3;
    profile: Profile;
    baseY: number;
    topY: number;
    rotation: number;
}

/** Build a 2D profile ring (closed, CCW from +Y top view). */
export function profileRing(profile: Profile, rotation: number): [number, number][] {
    const c = Math.cos(rotation);
    const s = Math.sin(rotation);
    const rot = (x: number, z: number): [number, number] => [x * c - z * s, x * s + z * c];
    switch (profile.kind) {
        case "Rectangle": {
            const hw = profile.width / 2;
            const hd = profile.depth / 2;
            // CCW order in XZ (will be flipped to CW-from-top → front-facing down in the top cap)
            return [rot(-hw, -hd), rot(hw, -hd), rot(hw, hd), rot(-hw, hd)];
        }
        case "Circle": {
            const segs = 32;
            const pts: [number, number][] = [];
            for (let i = 0; i < segs; i++) {
                const a = (i / segs) * Math.PI * 2;
                pts.push(rot(Math.cos(a) * profile.radius, Math.sin(a) * profile.radius));
            }
            return pts;
        }
        case "Arbitrary": {
            return profile.points.map((p) => rot(p[0], p[1]));
        }
        default: {
            // Fallback 0.4×0.4 rectangle
            return [rot(-0.2, -0.2), rot(0.2, -0.2), rot(0.2, 0.2), rot(-0.2, 0.2)];
        }
    }
}

/**
 * Column の 2D 床面フットプリントを世界 XZ 座標で返す (CCW)。
 * Clipper diff の被クリップ形状として壁矩形から差し引くために使う。
 */
export function columnFootprint2D(col: ColumnElement): Vec2[] {
    const ring = profileRing(col.profile, col.rotation);
    return ring.map<Vec2>((r) => [col.basePoint[0] + r[0], col.basePoint[2] + r[1]]);
}

export class ColumnMeshBuilder {
    public static buildFromElement(el: ColumnElement, baseY: number, topY: number): MeshData {
        return ColumnMeshBuilder.build({
            basePoint: el.basePoint,
            profile: el.profile,
            baseY,
            topY,
            rotation: el.rotation,
        });
    }

    public static build(p: ColumnMeshParams): MeshData {
        const { basePoint, profile, baseY, topY, rotation } = p;
        if (topY - baseY < 1e-6) return emptyMesh();

        const ring = profileRing(profile, rotation);
        const n = ring.length;
        if (n < 3) return emptyMesh();

        const positions: number[] = [];
        const normals: number[] = [];
        const indices: number[] = [];
        const edges: number[] = [];
        let off = 0;

        const addFace = (p0: Vec3, p1: Vec3, p2: Vec3, p3: Vec3) => {
            positions.push(...p0, ...p1, ...p2, ...p3);
            const v1 = vec3.subtract(vec3.create(), p1, p0);
            const v2 = vec3.subtract(vec3.create(), p2, p1);
            const nrm = vec3.cross(vec3.create(), v1, v2);
            vec3.normalize(nrm, nrm);
            for (let i = 0; i < 4; i++) normals.push(...nrm);
            indices.push(off, off + 1, off + 2, off, off + 2, off + 3);
            off += 4;
        };

        // Build ring world positions at base and top
        const base: Vec3[] = ring.map((r) => [basePoint[0] + r[0], baseY, basePoint[2] + r[1]]);
        const top: Vec3[] = ring.map((r) => [basePoint[0] + r[0], topY, basePoint[2] + r[1]]);

        // Side walls — each segment becomes a quad.
        // The ring is CCW in (X,Z) as if it were XY, which appears CW when
        // viewed from +Y (top-down). So to get outward-facing normals we
        // emit the quad in reversed winding (j→i→i_top→j_top).
        for (let i = 0; i < n; i++) {
            const j = (i + 1) % n;
            addFace(base[j], base[i], top[i], top[j]);
        }

        // Top cap (fan triangulation from ring[0]) — front-facing up
        const topStart = positions.length / 3;
        for (let i = 0; i < n; i++) {
            positions.push(top[i][0], top[i][1], top[i][2]);
            normals.push(0, 1, 0);
        }
        for (let i = 1; i < n - 1; i++) {
            indices.push(topStart, topStart + i + 1, topStart + i);
        }

        // Bottom cap — front-facing down
        const botStart = positions.length / 3;
        for (let i = 0; i < n; i++) {
            positions.push(base[i][0], base[i][1], base[i][2]);
            normals.push(0, -1, 0);
        }
        for (let i = 1; i < n - 1; i++) {
            indices.push(botStart, botStart + i, botStart + i + 1);
        }

        // Edges: ring outlines at base + top + vertical pillars at each ring vertex
        const addEdgePoint = (pt: Vec3): number => {
            const idx = positions.length / 3;
            positions.push(pt[0], pt[1], pt[2]);
            normals.push(0, 1, 0);
            return idx;
        };
        for (let i = 0; i < n; i++) {
            const j = (i + 1) % n;
            edges.push(addEdgePoint(base[i]), addEdgePoint(base[j]));
            edges.push(addEdgePoint(top[i]), addEdgePoint(top[j]));
            edges.push(addEdgePoint(base[i]), addEdgePoint(top[i]));
        }

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

function emptyMesh(): MeshData {
    return {
        positions: new Float32Array(),
        normals: new Float32Array(),
        indices: new Uint32Array(),
        edgeIndices: new Uint32Array(),
        bounds: { min: [0, 0, 0], max: [0, 0, 0] },
    };
}
