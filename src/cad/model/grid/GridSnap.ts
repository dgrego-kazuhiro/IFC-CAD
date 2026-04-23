import { Vec3 } from '../../geometry/math/Vec3';
import { GridLine, gridSegments, gridVertices } from './GridLine';

export type GridSnapKind = "Intersection" | "Endpoint" | "Line";

export interface GridSnapResult {
    point: Vec3;
    kind: GridSnapKind;
    gridIds: string[];
}

// World-space tolerance for snapping. For an MVP this is a constant; future
// improvements could derive it from the orthographic camera zoom so the
// snap radius stays roughly constant in screen pixels.
export const DEFAULT_GRID_SNAP_TOLERANCE = 0.4;

// Pick the grid whose line is closest to `cursor` within `tolerance` (world units).
// Returns the grid id, or null if none.
export function pickGrid(
    cursor: Vec3,
    grids: GridLine[],
    tolerance: number = DEFAULT_GRID_SNAP_TOLERANCE,
): string | null {
    let best: { id: string; dist: number } | null = null;
    for (const g of grids) {
        if (!g.visible) continue;
        for (const seg of gridSegments(g.curve)) {
            const proj = projectOnSegment(cursor, seg.a, seg.b);
            if (proj.dist <= tolerance && (!best || proj.dist < best.dist)) {
                best = { id: g.id, dist: proj.dist };
            }
        }
    }
    return best?.id ?? null;
}

function projectOnSegment(p: Vec3, a: Vec3, b: Vec3): { point: Vec3; t: number; dist: number } {
    const dx = b[0] - a[0];
    const dz = b[2] - a[2];
    const len2 = dx * dx + dz * dz;
    if (len2 < 1e-12) {
        const dist = Math.hypot(p[0] - a[0], p[2] - a[2]);
        return { point: [a[0], 0, a[2]], t: 0, dist };
    }
    const t = ((p[0] - a[0]) * dx + (p[2] - a[2]) * dz) / len2;
    const tc = Math.max(0, Math.min(1, t));
    const point: Vec3 = [a[0] + dx * tc, 0, a[2] + dz * tc];
    const dist = Math.hypot(p[0] - point[0], p[2] - point[2]);
    return { point, t: tc, dist };
}

// Intersection of two infinite lines in XZ plane. Returns null if parallel.
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

export interface AngleSnapResult {
    point: Vec3;
    angleDeg: number; // normalized to [0, 360)
}

export const DEFAULT_ANGLE_SNAP_TOLERANCE_DEG = 5;

// Proximity-based angle snap: only snaps when the cursor direction from `start`
// is within `toleranceDeg` of a multiple of `stepDeg`. Returns null otherwise
// so the caller can leave the cursor free. XZ plane, Y=0.
export function snapAngle(
    start: Vec3,
    cursor: Vec3,
    stepDeg: number = 45,
    toleranceDeg: number = DEFAULT_ANGLE_SNAP_TOLERANCE_DEG,
): AngleSnapResult | null {
    const dx = cursor[0] - start[0];
    const dz = cursor[2] - start[2];
    const dist = Math.hypot(dx, dz);
    if (dist < 1e-9 || stepDeg <= 0) return null;
    const rawDeg = Math.atan2(dz, dx) * (180 / Math.PI);
    const snappedDeg = Math.round(rawDeg / stepDeg) * stepDeg;
    let delta = Math.abs(rawDeg - snappedDeg);
    if (delta > 180) delta = 360 - delta;
    if (delta > toleranceDeg) return null;
    const rad = snappedDeg * (Math.PI / 180);
    const normalized = ((snappedDeg % 360) + 360) % 360;
    return {
        point: [start[0] + Math.cos(rad) * dist, 0, start[2] + Math.sin(rad) * dist],
        angleDeg: normalized,
    };
}

export interface AxisAlignSnapResult {
    point: Vec3;
    axis: "horizontal" | "vertical" | "both";
    refPointH?: Vec3; // ref for horizontal guide (constant Z)
    refPointV?: Vec3; // ref for vertical guide (constant X)
}

export const DEFAULT_AXIS_ALIGN_TOLERANCE = 0.4;

// Snap the cursor onto a horizontal (constant-Z) or vertical (constant-X)
// line passing through any reference point, within `tolerance`. When the
// cursor is within tolerance of both a horizontal and a vertical guide
// (from possibly different reference points), snaps to their intersection.
// Returns null when no guide is within tolerance.
export function snapAxisAlign(
    cursor: Vec3,
    refPoints: Vec3[],
    tolerance: number = DEFAULT_AXIS_ALIGN_TOLERANCE,
): AxisAlignSnapResult | null {
    let bestH: { dist: number; ref: Vec3 } | null = null;
    let bestV: { dist: number; ref: Vec3 } | null = null;
    for (const p of refPoints) {
        const dH = Math.abs(cursor[2] - p[2]);
        if (dH <= tolerance && (!bestH || dH < bestH.dist)) {
            bestH = { dist: dH, ref: p };
        }
        const dV = Math.abs(cursor[0] - p[0]);
        if (dV <= tolerance && (!bestV || dV < bestV.dist)) {
            bestV = { dist: dV, ref: p };
        }
    }
    if (!bestH && !bestV) return null;
    if (bestH && bestV) {
        return {
            point: [bestV.ref[0], 0, bestH.ref[2]],
            axis: "both",
            refPointH: bestH.ref,
            refPointV: bestV.ref,
        };
    }
    if (bestH) {
        return {
            point: [cursor[0], 0, bestH.ref[2]],
            axis: "horizontal",
            refPointH: bestH.ref,
        };
    }
    return {
        point: [bestV!.ref[0], 0, cursor[2]],
        axis: "vertical",
        refPointV: bestV!.ref,
    };
}

export interface SnapToGridsOptions {
    excludeId?: string;
    skipIntersections?: boolean;
}

// Per spec §10.3 priority: Grid intersection > endpoint > line
export function snapToGrids(
    cursor: Vec3,
    grids: GridLine[],
    tolerance: number = DEFAULT_GRID_SNAP_TOLERANCE,
    excludeIdOrOptions?: string | SnapToGridsOptions,
): GridSnapResult | null {
    const options: SnapToGridsOptions = typeof excludeIdOrOptions === "string"
        ? { excludeId: excludeIdOrOptions }
        : excludeIdOrOptions ?? {};
    const candidates: GridLine[] = grids.filter(
        (g) => g.visible && g.id !== options.excludeId && gridSegments(g.curve).length > 0,
    );
    if (candidates.length === 0) return null;

    // Precompute segments once per candidate to avoid repeated allocations
    const candidateSegs = candidates.map((g) => ({ g, segs: gridSegments(g.curve) }));

    // 1. Intersections (highest priority) — all segment pairs across distinct grids
    if (!options.skipIntersections) {
        let bestInter: { dist: number; point: Vec3; ids: [string, string] } | null = null;
        for (let i = 0; i < candidateSegs.length; i++) {
            for (let j = i + 1; j < candidateSegs.length; j++) {
                for (const sa of candidateSegs[i].segs) {
                    for (const sb of candidateSegs[j].segs) {
                        const ipt = lineLineIntersect(sa.a, sa.b, sb.a, sb.b);
                        if (!ipt) continue;
                        const d = Math.hypot(cursor[0] - ipt[0], cursor[2] - ipt[2]);
                        if (d <= tolerance && (!bestInter || d < bestInter.dist)) {
                            bestInter = {
                                dist: d, point: ipt,
                                ids: [candidateSegs[i].g.id, candidateSegs[j].g.id],
                            };
                        }
                    }
                }
            }
        }
        if (bestInter) return { point: bestInter.point, kind: "Intersection", gridIds: bestInter.ids };
    }

    // 2. Endpoints (all vertices of the polyline)
    let bestEnd: { dist: number; point: Vec3; id: string } | null = null;
    for (const g of candidates) {
        for (const p of gridVertices(g.curve)) {
            const d = Math.hypot(cursor[0] - p[0], cursor[2] - p[2]);
            if (d <= tolerance && (!bestEnd || d < bestEnd.dist)) {
                bestEnd = { dist: d, point: [p[0], 0, p[2]], id: g.id };
            }
        }
    }
    if (bestEnd) return { point: bestEnd.point, kind: "Endpoint", gridIds: [bestEnd.id] };

    // 3. Line projection — project onto every segment
    let bestLine: { dist: number; point: Vec3; id: string } | null = null;
    for (const { g, segs } of candidateSegs) {
        for (const seg of segs) {
            const proj = projectOnSegment(cursor, seg.a, seg.b);
            if (proj.dist <= tolerance && (!bestLine || proj.dist < bestLine.dist)) {
                bestLine = { dist: proj.dist, point: proj.point, id: g.id };
            }
        }
    }
    if (bestLine) return { point: bestLine.point, kind: "Line", gridIds: [bestLine.id] };

    return null;
}
