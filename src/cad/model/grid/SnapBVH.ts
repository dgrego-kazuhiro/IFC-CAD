import { Vec3 } from '../../geometry/math/Vec3';
import { GridLine, gridSegments } from './GridLine';

export type SnapPointKind = "Origin" | "Intersection";

export interface SnapPoint {
    x: number;
    z: number;
    kind: SnapPointKind;
    gridIds?: [string, string];
}

interface BVHNode {
    minX: number; minZ: number;
    maxX: number; maxZ: number;
    left: BVHNode | null;
    right: BVHNode | null;
    point: SnapPoint | null;
}

function lineLineIntersect(a1: Vec3, a2: Vec3, b1: Vec3, b2: Vec3): Vec3 | null {
    const x1 = a1[0], z1 = a1[2];
    const x2 = a2[0], z2 = a2[2];
    const x3 = b1[0], z3 = b1[2];
    const x4 = b2[0], z4 = b2[2];
    const denom = (x1 - x2) * (z3 - z4) - (z1 - z2) * (x3 - x4);
    if (Math.abs(denom) < 1e-9) return null;
    const t = ((x1 - x3) * (z3 - z4) - (z1 - z3) * (x3 - x4)) / denom;
    return [x1 + t * (x2 - x1), 0, z1 + t * (z2 - z1)];
}

function buildNode(points: SnapPoint[]): BVHNode | null {
    const n = points.length;
    if (n === 0) return null;
    if (n === 1) {
        const p = points[0];
        return { minX: p.x, minZ: p.z, maxX: p.x, maxZ: p.z, left: null, right: null, point: p };
    }
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const p of points) {
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.z < minZ) minZ = p.z;
        if (p.z > maxZ) maxZ = p.z;
    }
    const splitX = (maxX - minX) >= (maxZ - minZ);
    points.sort((a, b) => splitX ? a.x - b.x : a.z - b.z);
    const mid = n >> 1;
    return {
        minX, minZ, maxX, maxZ,
        left: buildNode(points.slice(0, mid)),
        right: buildNode(points.slice(mid)),
        point: null,
    };
}

/**
 * 2D AABB-tree over point snap targets (origin + grid line intersections).
 * Built once per grid-layout change; query cost is O(log N) average.
 */
export class SnapBVH {
    private root: BVHNode | null = null;

    static fromGrids(grids: GridLine[]): SnapBVH {
        const points: SnapPoint[] = [{ x: 0, z: 0, kind: "Origin" }];
        // Precompute per-grid segment lists (flattens Line and Polyline alike)
        const visible = grids
            .filter((g) => g.visible)
            .map((g) => ({ g, segs: gridSegments(g.curve) }))
            .filter(({ segs }) => segs.length > 0);
        for (let i = 0; i < visible.length; i++) {
            for (let j = i + 1; j < visible.length; j++) {
                for (const sa of visible[i].segs) {
                    for (const sb of visible[j].segs) {
                        const ipt = lineLineIntersect(sa.a, sa.b, sb.a, sb.b);
                        if (!ipt) continue;
                        points.push({
                            x: ipt[0], z: ipt[2],
                            kind: "Intersection",
                            gridIds: [visible[i].g.id, visible[j].g.id],
                        });
                    }
                }
            }
        }
        const bvh = new SnapBVH();
        bvh.root = buildNode(points);
        return bvh;
    }

    /**
     * Nearest snap point to (x, z) within `tolerance` (world units).
     * Traverses the tree pruning subtrees whose AABB is farther than the
     * current best distance.
     */
    nearestWithin(x: number, z: number, tolerance: number): SnapPoint | null {
        const root = this.root;
        if (!root) return null;
        let bestPoint: SnapPoint | null = null;
        let bestDist = tolerance;
        const stack: BVHNode[] = [root];
        while (stack.length) {
            const node = stack.pop()!;
            const dx = Math.max(node.minX - x, 0, x - node.maxX);
            const dz = Math.max(node.minZ - z, 0, z - node.maxZ);
            const lb = Math.hypot(dx, dz);
            if (lb > bestDist) continue;
            if (node.point) {
                const d = Math.hypot(x - node.point.x, z - node.point.z);
                if (d <= bestDist) {
                    bestDist = d;
                    bestPoint = node.point;
                }
                continue;
            }
            if (node.left) stack.push(node.left);
            if (node.right) stack.push(node.right);
        }
        return bestPoint;
    }
}
