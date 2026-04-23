// 統合スナップ
//   優先順位: 柱中心 → 梁端点 → 壁端点 → 部屋頂点 → 部屋エッジ
//           → 通芯交点 → 通芯線 → 壁軸線 → 軸整列 → フリー点
//
// Wall / Room の作図操作から共通で呼べる単一の API。返り値にはどの対象に
// スナップしたか (SnapInfo) を含めて、呼び出し側で拘束の自動生成 (Coincident
// や PointOnGrid など) に使える。

import { Vec3 } from "../geometry/math/Vec3";
import { GridLine, gridVertices } from "../model/grid/GridLine";
import {
    snapToGrids,
    snapAxisAlign,
    DEFAULT_GRID_SNAP_TOLERANCE,
} from "../model/grid/GridSnap";
import { SnapBVH } from "../model/grid/SnapBVH";
import { WallElement } from "../model/elements/WallElement";
import { BeamElement } from "../model/elements/BeamElement";
import { ColumnElement } from "../model/elements/ColumnElement";
import { SpaceElement, polygonEdges } from "../model/elements/SpaceElement";

export type SnapKind =
    | "Column"
    | "BeamEndpoint"
    | "WallEndpoint"
    | "WallAxis"
    | "RoomVertex"
    | "RoomEdge"
    | "GridIntersection"
    | "Grid"
    | "Axis"
    | null;

/** Identity of a snapped-to geometric entity — used to chain Coincident
 *  constraints (wall endpoint or polygon vertex) when placing a new wall.
 */
export type SnapSource =
    | { kind: "wall"; wallId: string; endIdx: 0 | 1 }
    | { kind: "polyVertex"; spaceId: string; polyId: string; vertexIdx: number };

export interface SnapInfo {
    point: Vec3;
    kind: SnapKind;
    targetId?: string;
    secondaryTargetId?: string;
    /** Reference point that generated the horizontal axis projection (Axis). */
    axisRefH?: Vec3;
    /** Reference point that generated the vertical axis projection (Axis). */
    axisRefV?: Vec3;
    /** Entity the cursor snapped to — set for wall endpoint / polygon vertex
     *  hits so the caller can create a Coincident constraint automatically. */
    source?: SnapSource;
}

export const DEFAULT_SNAP_TOLERANCE = DEFAULT_GRID_SNAP_TOLERANCE;

export interface UnifiedSnapOptions {
    tolerance?: number;
    /** Opt-out: skip BeamEndpoint / Column / WallAxis when the caller only
     *  cares about plan-view sketch snaps (room-mode drafting). */
    enableElementSnaps?: boolean;
    /** Pre-built BVH for grid intersection snaps. Recommended to avoid the
     *  quadratic scan baked into snapToGrids. If null, falls back to the
     *  scan but still enables grid line + axis alignment. */
    snapBVH?: SnapBVH | null;
    /** Disable the room polygon pass (used when we want only grid snaps). */
    skipRoomPolygons?: boolean;
    /** Exclude these wall ids from wall endpoint / wall axis snap. Used to
     *  avoid snapping to the wall currently being drawn. */
    excludeWallIds?: Set<string>;
}

function projectOnSegment(
    p: Vec3,
    a: Vec3,
    b: Vec3,
): { point: Vec3; t: number; dist: number } {
    const dx = b[0] - a[0];
    const dz = b[2] - a[2];
    const len2 = dx * dx + dz * dz;
    if (len2 < 1e-12) {
        return { point: [a[0], p[1], a[2]], t: 0, dist: Math.hypot(p[0] - a[0], p[2] - a[2]) };
    }
    const t = ((p[0] - a[0]) * dx + (p[2] - a[2]) * dz) / len2;
    const tc = Math.max(0, Math.min(1, t));
    const point: Vec3 = [a[0] + dx * tc, p[1], a[2] + dz * tc];
    return { point, t: tc, dist: Math.hypot(p[0] - point[0], p[2] - point[2]) };
}

export function unifiedSnap(
    cursor: Vec3,
    elements: Record<string, any>,
    grids: GridLine[],
    options: UnifiedSnapOptions = {},
): SnapInfo {
    const tolerance = options.tolerance ?? DEFAULT_SNAP_TOLERANCE;
    const enableElementSnaps = options.enableElementSnaps !== false;
    const exclude = options.excludeWallIds;

    // 1. Column center (highest priority)
    if (enableElementSnaps) {
        let best: { dist: number; point: Vec3; id: string } | null = null;
        for (const id in elements) {
            const el = elements[id];
            if (!el || el.type !== "Column") continue;
            const col = el as ColumnElement;
            if (!col.basePoint) continue;
            const d = Math.hypot(cursor[0] - col.basePoint[0], cursor[2] - col.basePoint[2]);
            if (d <= tolerance && (!best || d < best.dist)) {
                best = { dist: d, point: [col.basePoint[0], cursor[1], col.basePoint[2]], id: id as string };
            }
        }
        if (best) return { point: best.point, kind: "Column", targetId: best.id };
    }

    // 2. Beam endpoint
    if (enableElementSnaps) {
        let best: { dist: number; point: Vec3; id: string } | null = null;
        for (const id in elements) {
            const el = elements[id];
            if (!el || el.type !== "Beam") continue;
            const beam = el as BeamElement;
            for (const p of beam.axis) {
                const d = Math.hypot(cursor[0] - p[0], cursor[2] - p[2]);
                if (d <= tolerance && (!best || d < best.dist)) {
                    best = { dist: d, point: [p[0], cursor[1], p[2]], id: id as string };
                }
            }
        }
        if (best) return { point: best.point, kind: "BeamEndpoint", targetId: best.id };
    }

    // 3. Wall endpoint (emits source for Coincident auto-constraint)
    {
        let best: { dist: number; point: Vec3; id: string; endIdx: 0 | 1 } | null = null;
        for (const id in elements) {
            const el = elements[id];
            if (!el || el.type !== "Wall") continue;
            if (exclude?.has(id)) continue;
            const w = el as WallElement;
            for (let i = 0; i < 2; i++) {
                const p = w.axis[i];
                const d = Math.hypot(cursor[0] - p[0], cursor[2] - p[2]);
                if (d <= tolerance && (!best || d < best.dist)) {
                    best = { dist: d, point: [p[0], cursor[1], p[2]], id: id as string, endIdx: i as 0 | 1 };
                }
            }
        }
        if (best) {
            return {
                point: best.point,
                kind: "WallEndpoint",
                targetId: best.id,
                source: { kind: "wall", wallId: best.id, endIdx: best.endIdx },
            };
        }
    }

    // Collect room-linked walls once so later passes can skip their centerline
    // (room-mode walls expose their inner face through the RoomEdge pass).
    const roomLinkedWallIds = new Set<string>();
    if (!options.skipRoomPolygons) {
        for (const id in elements) {
            const el = elements[id];
            if (!el || el.type !== "Space") continue;
            for (const poly of (el as SpaceElement).polygons ?? []) {
                for (const wid of poly.wallIds ?? []) if (wid) roomLinkedWallIds.add(wid);
            }
        }
    }

    // 4. Room polygon vertex
    if (!options.skipRoomPolygons) {
        let best: { dist: number; point: Vec3; source: SnapSource } | null = null;
        for (const id in elements) {
            const el = elements[id];
            if (!el || el.type !== "Space") continue;
            for (const poly of (el as SpaceElement).polygons ?? []) {
                for (let vi = 0; vi < poly.outer.length; vi++) {
                    const p = poly.outer[vi];
                    const d = Math.hypot(cursor[0] - p[0], cursor[2] - p[1]);
                    if (d <= tolerance && (!best || d < best.dist)) {
                        best = {
                            dist: d,
                            point: [p[0], cursor[1], p[1]],
                            source: { kind: "polyVertex", spaceId: id as string, polyId: poly.id, vertexIdx: vi },
                        };
                    }
                }
            }
        }
        if (best) return { point: best.point, kind: "RoomVertex", source: best.source };
    }

    // 5. Room polygon edge (projection onto nearest segment)
    if (!options.skipRoomPolygons) {
        let best: { dist: number; point: Vec3 } | null = null;
        for (const id in elements) {
            const el = elements[id];
            if (!el || el.type !== "Space") continue;
            for (const poly of (el as SpaceElement).polygons ?? []) {
                const edges = polygonEdges(poly);
                for (const [ai, bi] of edges) {
                    const a = poly.outer[ai];
                    const b = poly.outer[bi];
                    const dx = b[0] - a[0];
                    const dy = b[1] - a[1];
                    const lenSq = dx * dx + dy * dy;
                    if (lenSq < 1e-12) continue;
                    let t = ((cursor[0] - a[0]) * dx + (cursor[2] - a[1]) * dy) / lenSq;
                    t = Math.max(0, Math.min(1, t));
                    const px = a[0] + t * dx;
                    const py = a[1] + t * dy;
                    const d = Math.hypot(cursor[0] - px, cursor[2] - py);
                    if (d <= tolerance && (!best || d < best.dist)) {
                        best = { dist: d, point: [px, cursor[1], py] };
                    }
                }
            }
        }
        if (best) return { point: best.point, kind: "RoomEdge" };
    }

    // 6. Grid intersection via BVH (O(1)), falls back to snapToGrids below.
    if (options.snapBVH) {
        const hit = options.snapBVH.nearestWithin(cursor[0], cursor[2], tolerance);
        if (hit) {
            return {
                point: [hit.x, cursor[1], hit.z],
                kind: "GridIntersection",
            };
        }
    }

    // 7. Grid line / intersection (full scan — still runs to cover line snaps
    //    even when the BVH has no intersections to report).
    {
        const gsnap = snapToGrids(cursor, grids, tolerance, options.snapBVH ? { skipIntersections: true } : undefined);
        if (gsnap) {
            return {
                point: [gsnap.point[0], cursor[1], gsnap.point[2]],
                kind: gsnap.kind === "Intersection" ? "GridIntersection" : "Grid",
                targetId: gsnap.gridIds[0],
                secondaryTargetId: gsnap.gridIds[1],
            };
        }
    }

    // 8. Standalone wall centerline projection
    if (enableElementSnaps) {
        let best: { dist: number; point: Vec3; id: string } | null = null;
        for (const id in elements) {
            const el = elements[id];
            if (!el || el.type !== "Wall") continue;
            if (exclude?.has(id)) continue;
            if (roomLinkedWallIds.has(id)) continue;
            const w = el as WallElement;
            const proj = projectOnSegment(cursor, w.axis[0], w.axis[1]);
            if (proj.dist <= tolerance && (!best || proj.dist < best.dist)) {
                best = { dist: proj.dist, point: proj.point, id: id as string };
            }
        }
        if (best) return { point: best.point, kind: "WallAxis", targetId: best.id };
    }

    // 9. Axis alignment through grid endpoints (same feel as room mode).
    {
        const refPoints: Vec3[] = [];
        for (const g of grids) {
            if (!g.visible) continue;
            for (const v of gridVertices(g.curve)) refPoints.push(v);
        }
        if (refPoints.length > 0) {
            const axis = snapAxisAlign(cursor, refPoints);
            if (axis) {
                return {
                    point: [axis.point[0], cursor[1], axis.point[2]],
                    kind: "Axis",
                    axisRefH: axis.refPointH ?? undefined,
                    axisRefV: axis.refPointV ?? undefined,
                };
            }
        }
    }

    return { point: cursor, kind: null };
}
