import earcut from "earcut";
import { MeshData } from "../MeshData";
import { AABB } from "../../geometry/primitives/AABB";
import { Vec2 } from "../../geometry/math/Vec2";
import { SlabElement } from "../../model/elements/SlabElement";

// Signed area for ring orientation
function signedArea(ring: Vec2[]): number {
    let s = 0;
    for (let i = 0, n = ring.length; i < n; i++) {
        const a = ring[i];
        const b = ring[(i + 1) % n];
        s += a[0] * b[1] - b[0] * a[1];
    }
    return s / 2;
}

function ensureCCW(ring: Vec2[]): Vec2[] {
    return signedArea(ring) >= 0 ? ring : [...ring].reverse();
}
function ensureCW(ring: Vec2[]): Vec2[] {
    return signedArea(ring) < 0 ? ring : [...ring].reverse();
}

export class SlabMeshBuilder {
    /**
     * Build a slab mesh by triangulating its 2D profile and extruding it
     * upward by `thickness`. Concave outer rings and holes are supported via
     * earcut. Per spec §6 / §15: NOT a CSG/mesh-boolean approach.
     */
    public static build(slab: SlabElement): MeshData {
        const outer = ensureCCW(slab.boundary);
        const holes = (slab.holes ?? []).map(ensureCW);
        if (outer.length < 3) {
            return emptyMesh();
        }

        // Flatten for earcut + record hole start indices
        const flat: number[] = [];
        for (const p of outer) flat.push(p[0], p[1]);
        const holeIdx: number[] = [];
        for (const h of holes) {
            holeIdx.push(flat.length / 2);
            for (const p of h) flat.push(p[0], p[1]);
        }
        const ringCount = flat.length / 2;
        const tris = earcut(flat, holeIdx.length > 0 ? holeIdx : undefined, 2);

        const yBase = slab.elevation;
        const yTop = slab.elevation + slab.thickness;

        const positions: number[] = [];
        const normals: number[] = [];
        const indices: number[] = [];
        const edges: number[] = [];

        // Map (i, layer) to vertex index. layer: 0 = top, 1 = bottom
        const topStart = 0;
        const bottomStart = ringCount;

        // Top vertices (Y = top, normal = +Y)
        for (let i = 0; i < ringCount; i++) {
            const x = flat[i * 2];
            const z = flat[i * 2 + 1];
            positions.push(x, yTop, z);
            normals.push(0, 1, 0);
        }
        // Bottom vertices (Y = base, normal = -Y)
        for (let i = 0; i < ringCount; i++) {
            const x = flat[i * 2];
            const z = flat[i * 2 + 1];
            positions.push(x, yBase, z);
            normals.push(0, -1, 0);
        }

        // Top triangles (CCW from above)
        for (let i = 0; i < tris.length; i += 3) {
            indices.push(topStart + tris[i], topStart + tris[i + 1], topStart + tris[i + 2]);
        }
        // Bottom triangles (reverse winding)
        for (let i = 0; i < tris.length; i += 3) {
            indices.push(bottomStart + tris[i + 2], bottomStart + tris[i + 1], bottomStart + tris[i]);
        }

        // Side faces — separate vertices per side so each gets its own normal.
        // Walk each ring (outer + every hole) and emit a side quad per edge.
        const buildRingSides = (ring: Vec2[], baseIdx: number) => {
            const n = ring.length;
            for (let i = 0; i < n; i++) {
                const a = ring[i];
                const b = ring[(i + 1) % n];
                const dx = b[0] - a[0];
                const dz = b[1] - a[1];
                const len = Math.hypot(dx, dz) || 1;
                // Outward normal = right-perpendicular for CCW ring (outward),
                // left-perp for CW (hole, points into slab volume → outward).
                const nx = dz / len;
                const nz = -dx / len;

                const off = positions.length / 3;
                positions.push(a[0], yBase, a[1]); normals.push(nx, 0, nz);
                positions.push(b[0], yBase, b[1]); normals.push(nx, 0, nz);
                positions.push(b[0], yTop,  b[1]); normals.push(nx, 0, nz);
                positions.push(a[0], yTop,  a[1]); normals.push(nx, 0, nz);
                indices.push(off, off + 1, off + 2, off, off + 2, off + 3);

                // Edge: bottom + top of this side
                const e0 = positions.length / 3;
                positions.push(a[0], yBase, a[1]); normals.push(0, 1, 0);
                positions.push(b[0], yBase, b[1]); normals.push(0, 1, 0);
                positions.push(a[0], yTop,  a[1]); normals.push(0, 1, 0);
                positions.push(b[0], yTop,  b[1]); normals.push(0, 1, 0);
                edges.push(e0, e0 + 1, e0 + 2, e0 + 3);
                // (no vertical edges along the ring — only top/bottom outline)
                // Avoid a corner-vertical line too dense; let render show silhouette via top+bottom rings.
            }
            void baseIdx;
        };

        buildRingSides(outer, 0);
        for (const h of holes) buildRingSides(h, 0);

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
