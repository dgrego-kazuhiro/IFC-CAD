"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { mat4, vec4 } from "gl-matrix";
import { useAppState, AppState, RESIDENTIAL_GRID_SECONDARY_M } from "../../application/AppState";
import { SpaceElement, RoomPolygon, PolygonJoint, polygonEdges, isPolygonClosed, WallSkip, unskippedRanges } from "../../model/elements/SpaceElement";
import { WallElement } from "../../model/elements/WallElement";
import { Camera } from "../../renderer/camera/Camera";
import { ViewportHandle } from "../layout/Viewport";
import { generateId } from "../../utils/ids";
import { computeMiteredCorners, computeMiteredWallAxes } from "./wallSync";
import { regenerateAllWalls } from "./wallRegenerate";
import { computeWallHexagon } from "../../geometry/wall/EdgeGeometry";
import { Vec2 } from "../../geometry/math/Vec2";
import { Vec3 } from "../../geometry/math/Vec3";
import polygonClipping from "polygon-clipping";
import earcut from "earcut";
import {
    SketchOverlayRenderer,
    SketchLine,
    SketchQuad,
    SketchMarker,
} from "./webgpu/SketchOverlayRenderer";
import { AddConstraintCommand, RemoveConstraintCommand, generateConstraintId } from "../../commands/create/AddConstraintCommand";
import { CreateSpaceCommand } from "../../commands/create/CreateSpaceCommand";
import { pickNewRoomName } from "./roomNaming";
import { ElementId } from "../../model/base/ElementId";
import { Constraint, ConstraintTarget } from "../../model/constraint/Constraint";
import { snapToGrids, snapAxisAlign, DEFAULT_GRID_SNAP_TOLERANCE } from "../../model/grid/GridSnap";
import { GridLine, gridVertices } from "../../model/grid/GridLine";
import { SnapBVH } from "../../model/grid/SnapBVH";
import { unifiedSnap } from "../../snapping/UnifiedSnap";
import {
    SNAP_RGBA_OBJ, SNAP_RGBA_AXIS, SNAP_RGBA_WHITE,
    SNAP_RGBA_POLAR_GUIDE, SNAP_RGBA_POLAR_ACTIVE, SNAP_MARKER_HALF,
    ORIGIN_RGBA_X, ORIGIN_RGBA_Z, ORIGIN_RGBA_DOT_STROKE,
    ORIGIN_AXIS_LEN_PX, ORIGIN_DOT_RADIUS, ORIGIN_STROKE_WIDTH, SNAP_STROKE_WIDTH,
    SNAP_MARKER_STYLES, SnapKind,
} from "../snapStyle";
import {
    SketchEntity,
    LineEntity,
    PolylineEntity,
    CircleEntity,
    ArcEntity,
    arcSweep,
    wrap2pi,
    pickEntity,
    trimCircleToArc,
} from "../../model/sketch/SketchEntity";

function worldToScreen(wx: number, wz: number, vpMatrix: mat4, w: number, h: number): [number, number] {
    const c = vec4.fromValues(wx, 0, wz, 1);
    vec4.transformMat4(c, c, vpMatrix);
    return [((c[0] / c[3]) + 1) * 0.5 * w, (1 - (c[1] / c[3])) * 0.5 * h];
}

function screenToWorld(sx: number, sy: number, cam: Camera, w: number, h: number): [number, number] | null {
    const nx = (sx / w) * 2 - 1, ny = -((sy / h) * 2 - 1);
    const inv = mat4.create(), vp = mat4.create();
    mat4.multiply(vp, cam.projectionMatrix, cam.viewMatrix);
    mat4.invert(inv, vp);
    const near = vec4.fromValues(nx, ny, 0, 1), far = vec4.fromValues(nx, ny, 1, 1);
    vec4.transformMat4(near, near, inv); vec4.transformMat4(far, far, inv);
    vec4.scale(near, near, 1 / near[3]); vec4.scale(far, far, 1 / far[3]);
    const dy = far[1] - near[1];
    if (Math.abs(dy) < 1e-4) return null;
    const t = -near[1] / dy;
    if (t < 0) return null;
    return [near[0] + (far[0] - near[0]) * t, near[2] + (far[2] - near[2]) * t];
}

function pointInRing(px: number, py: number, ring: Vec2[]): boolean {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const xi = ring[i][0], yi = ring[i][1];
        const xj = ring[j][0], yj = ring[j][1];
        const intersect = ((yi > py) !== (yj > py)) &&
            (px < ((xj - xi) * (py - yi)) / ((yj - yi) || 1e-12) + xi);
        if (intersect) inside = !inside;
    }
    return inside;
}

function pointInRoomPolygon(
    px: number, py: number,
    outer: Vec2[], holes: Vec2[][],
): boolean {
    if (!pointInRing(px, py, outer)) return false;
    for (const h of holes) {
        if (pointInRing(px, py, h)) return false;
    }
    return true;
}

/**
 * Fast local propagation of simple constraints during drag. Updates `outer`
 * in-place so constrained neighbours of `draggedIdx` follow in the same frame
 * (before the async solver runs).
 *
 * Step 1: derive a horizontal/vertical "orientation" for each polygon edge by
 *   tracing Horizontal/Vertical seeds through Parallel (same) and Perpendicular
 *   (swap) constraints to a fixed point. This lets a rectangle that only has
 *   Horizontal on one edge + Parallel between opposite edges treat both
 *   horizontal edges as horizontal during local propagation.
 *
 * Step 2: walk polygon edges; when one endpoint has already moved, mirror its
 *   x (Vertical edge) or y (Horizontal edge) onto the other endpoint. Also
 *   handle Coincident(p1, p2) pairs on the same polygon.
 */
function propagateSimpleConstraints(
    outer: Vec2[],
    polyId: string,
    draggedIdx: number,
    constraints: Record<string, { type: string; targets: any[] }>,
): void {
    const n = outer.length;
    const key = (pid: string, idx: number) => `${pid}:${idx}`;

    // ─── Step 1: derive horizontal/vertical edges transitively ───
    const isH = new Map<string, boolean>();
    const isV = new Map<string, boolean>();
    for (const cid in constraints) {
        const c = constraints[cid];
        const t = c.targets[0];
        if (!t || t.kind !== "SketchEdge") continue;
        if (c.type === "Horizontal") isH.set(key(t.polyId, t.edgeIdx), true);
        else if (c.type === "Vertical") isV.set(key(t.polyId, t.edgeIdx), true);
    }
    for (let iter = 0; iter < 8; iter++) {
        let progressed = false;
        for (const cid in constraints) {
            const c = constraints[cid];
            if (c.type !== "Parallel" && c.type !== "Perpendicular") continue;
            const t1 = c.targets[0], t2 = c.targets[1];
            if (!t1 || !t2 || t1.kind !== "SketchEdge" || t2.kind !== "SketchEdge") continue;
            const k1 = key(t1.polyId, t1.edgeIdx);
            const k2 = key(t2.polyId, t2.edgeIdx);
            if (c.type === "Parallel") {
                if (isH.get(k1) && !isH.get(k2)) { isH.set(k2, true); progressed = true; }
                if (isH.get(k2) && !isH.get(k1)) { isH.set(k1, true); progressed = true; }
                if (isV.get(k1) && !isV.get(k2)) { isV.set(k2, true); progressed = true; }
                if (isV.get(k2) && !isV.get(k1)) { isV.set(k1, true); progressed = true; }
            } else {
                if (isH.get(k1) && !isV.get(k2)) { isV.set(k2, true); progressed = true; }
                if (isH.get(k2) && !isV.get(k1)) { isV.set(k1, true); progressed = true; }
                if (isV.get(k1) && !isH.get(k2)) { isH.set(k2, true); progressed = true; }
                if (isV.get(k2) && !isH.get(k1)) { isH.set(k1, true); progressed = true; }
            }
        }
        if (!progressed) break;
    }

    // ─── Step 2: propagate moved vertices through H/V edges + Coincident ───
    const moved = new Set<number>([draggedIdx]);
    for (let iter = 0; iter < 8; iter++) {
        let anyChanged = false;
        for (let i = 0; i < n; i++) {
            const a = i, b = (i + 1) % n;
            const driveA = moved.has(a), driveB = moved.has(b);
            if (driveA === driveB) continue;
            const src = driveA ? a : b;
            const dst = driveA ? b : a;
            const ek = key(polyId, i);
            if (isH.get(ek)) {
                if (outer[dst][1] !== outer[src][1]) {
                    outer[dst] = [outer[dst][0], outer[src][1]];
                    moved.add(dst); anyChanged = true;
                }
            } else if (isV.get(ek)) {
                if (outer[dst][0] !== outer[src][0]) {
                    outer[dst] = [outer[src][0], outer[dst][1]];
                    moved.add(dst); anyChanged = true;
                }
            }
        }
        for (const cid in constraints) {
            const c = constraints[cid];
            if (c.type !== "Coincident" || c.targets.length < 2) continue;
            const t1 = c.targets[0], t2 = c.targets[1];
            if (!t1 || !t2 || t1.kind !== "SketchPoint" || t2.kind !== "SketchPoint") continue;
            if (t1.polyId !== polyId || t2.polyId !== polyId) continue;
            const a = t1.vertexIdx, b = t2.vertexIdx;
            if (a < 0 || a >= n || b < 0 || b >= n) continue;
            const driveA = moved.has(a), driveB = moved.has(b);
            if (driveA === driveB) continue;
            const src = driveA ? a : b;
            const dst = driveA ? b : a;
            if (outer[dst][0] !== outer[src][0] || outer[dst][1] !== outer[src][1]) {
                outer[dst] = [outer[src][0], outer[src][1]];
                moved.add(dst); anyChanged = true;
            }
        }
        if (!anyChanged) break;
    }
}

/**
 * Unsigned turn angle at `outer[i]`, in radians [0, π]. 0 = collinear,
 * π = 180° reversal. Used to suppress vertex handles on arc-like runs
 * (e.g., the arc portion left behind after merging a circle with a rect).
 */
function turnAngleAt(outer: Vec2[], i: number): number {
    const n = outer.length;
    const a = outer[(i - 1 + n) % n];
    const b = outer[i];
    const c = outer[(i + 1) % n];
    const v1x = b[0] - a[0], v1y = b[1] - a[1];
    const v2x = c[0] - b[0], v2y = c[1] - b[1];
    const cross = v1x * v2y - v1y * v2x;
    const dot = v1x * v2x + v1y * v2y;
    return Math.atan2(Math.abs(cross), dot);
}

// Vertices whose turn is smaller than this are treated as arc-interior
// points (tessellation artifacts) and hidden from the user.
const ARC_VERTEX_ANGLE_THRESHOLD = (15 * Math.PI) / 180;

function isArcVertex(outer: Vec2[], i: number): boolean {
    return turnAngleAt(outer, i) < ARC_VERTEX_ANGLE_THRESHOLD;
}

/**
 * 既存エッジ (弦 = p0→p1) と任意のカーソル位置から円弧パラメータを導出。
 * カーソルを弦の **垂直二等分線方向** に投影した bulge で円弧の膨らみを
 * 決定する。bulge=0 (= 弦上) では円弧化できず null。
 *
 * 戻り値の `aStart`/`aEnd` は、CCW 方向に進むと **カーソル側を通る** 向きで
 * セットされる。`|bulge| > half` でも同じロジックで「カーソル側を通る major
 * arc」を選ぶ (sweep > π)。
 */
/**
 * Sketch entity を (dx, dy) だけ平行移動した新しい entity を返す (= 不変)。
 *  - line:     p0, p1 を平行移動
 *  - polyline: 全 points を平行移動
 *  - circle:   center を平行移動 (radius 不変)
 *  - arc:      center を平行移動 (radius / aStart / aEnd 不変)
 *
 * polygon ドラッグ系で「entity を真実の単一情報源」として直接動かすために
 * 使う。polygon は entity から再派生されるので、entity を動かせば polygon も
 * 自動的に追従し、polygon と entity の不一致状態が原理的に発生しない。
 */
/**
 * polyId に紐付く space.entities のスナップショットを集める。
 *  polyIdByEntity (entityId → polyId 対応表) を逆引き。値は **deep copy**
 *  なので、後で entity が更新されても snapshot は変わらない。
 *  poly が entity に裏付けられていない (= legacy 等) なら空配列を返す。
 */
function collectPolyEntitiesSnapshot(
    space: SpaceElement,
    polyId: string,
): { entityId: string; snapshot: SketchEntity }[] {
    const out: { entityId: string; snapshot: SketchEntity }[] = [];
    const map = space.polyIdByEntity ?? {};
    const ents = space.entities ?? [];
    for (const eid in map) {
        if (map[eid] !== polyId) continue;
        const ent = ents.find((e) => e.id === eid);
        if (!ent) continue;
        // deep clone (= 値だけコピー、参照を切る)
        out.push({ entityId: eid, snapshot: cloneEntity(ent) });
    }
    return out;
}

function cloneEntity(e: SketchEntity): SketchEntity {
    if (e.kind === "line") {
        return { ...e, p0: [e.p0[0], e.p0[1]], p1: [e.p1[0], e.p1[1]] };
    }
    if (e.kind === "polyline") {
        return { ...e, points: e.points.map((p) => [p[0], p[1]] as Vec2) };
    }
    if (e.kind === "circle") {
        return { ...e, center: [e.center[0], e.center[1]] };
    }
    if (e.kind === "arc") {
        return { ...e, center: [e.center[0], e.center[1]] };
    }
    return e;
}

/**
 * 全体移動 (= poly translate) で「一緒に動かすべき別 polygon」を BFS で集める。
 *
 * 対象拘束:
 *   - Collinear / Parallel / Perpendicular: 辺同士の **向き** 拘束
 *   - Length: 距離 / 長さ拘束
 *  これらは「両 polygon が同じ delta だけ平行移動」した時に拘束が保たれる
 *  (= 連結 polygon を rigid に一緒に動かせば OK)。Coincident は別途ブロック
 *  処理されるのでここには含めない。
 *  outline polygon (wallOutlineOf 付き) は派生扱いなので除外。
 *
 * 戻り値: seedPolyId/seedSpaceId 以外の連結 polygon のスナップショット。
 *  各 polygon について origEntities / origOuter / origHoles を deep copy で保持。
 */
function collectLinkedPolysForTranslate(
    seedPolyId: string,
    seedSpaceId: string,
    elements: Record<string, any>,
    constraints: Record<string, any>,
): {
    spaceId: string;
    polyId: string;
    origEntities: { entityId: string; snapshot: SketchEntity }[];
    origOuter: Vec2[];
    origHoles: Vec2[][];
}[] {
    const TRANSLATE_PRESERVING = new Set([
        "Collinear", "Parallel", "Perpendicular", "Length",
    ]);
    // polyId → spaceId の lookup
    const polyToSpace = new Map<string, string>();
    for (const eid in elements) {
        const el = elements[eid];
        if (!el || el.type !== "Space") continue;
        const sp = el as SpaceElement;
        for (const p of sp.polygons ?? []) {
            polyToSpace.set(p.id, eid);
        }
    }
    // BFS: seed から「TRANSLATE_PRESERVING 拘束で共有する別 polygon」を辿る
    const visited = new Set<string>([seedPolyId]);
    const queue: string[] = [seedPolyId];
    const result: ReturnType<typeof collectLinkedPolysForTranslate> = [];
    while (queue.length > 0) {
        const cur = queue.shift() as string;
        for (const cid in constraints) {
            const c = constraints[cid];
            if (!TRANSLATE_PRESERVING.has(c.type)) continue;
            if (!Array.isArray(c.targets)) continue;
            // この拘束が cur を含むか
            const targetsCur = c.targets.some((t: any) =>
                (t.kind === "SketchPoint" || t.kind === "SketchEdge")
                && t.polyId === cur,
            );
            if (!targetsCur) continue;
            // 同じ拘束の中の **別 polyId** を集めて queue に追加
            for (const t of c.targets) {
                if (t.kind !== "SketchPoint" && t.kind !== "SketchEdge") continue;
                const otherPid = (t as any).polyId as string | undefined;
                if (!otherPid || otherPid === cur) continue;
                if (visited.has(otherPid)) continue;
                const otherSpaceId = polyToSpace.get(otherPid);
                if (!otherSpaceId) continue;
                const otherSp = elements[otherSpaceId] as SpaceElement | undefined;
                if (!otherSp) continue;
                const otherPoly = otherSp.polygons?.find((p) => p.id === otherPid);
                if (!otherPoly) continue;
                if (otherPoly.wallOutlineOf) continue;
                visited.add(otherPid);
                queue.push(otherPid);
                result.push({
                    spaceId: otherSpaceId,
                    polyId: otherPid,
                    origEntities: collectPolyEntitiesSnapshot(otherSp, otherPid),
                    origOuter: otherPoly.outer.map((p) => [p[0], p[1]] as Vec2),
                    origHoles: (otherPoly.holes ?? []).map((h) =>
                        h.map((p) => [p[0], p[1]] as Vec2),
                    ),
                });
                // outline 兄弟 polygon (= 同じ Space 内で wallOutlineOf === otherPid)
                // も合わせて記録。entity を持たないので origEntities は空のまま
                // (= 後段の legacy path で polygon.outer を直接 translate)。
                for (const sibling of otherSp.polygons ?? []) {
                    if (sibling.wallOutlineOf !== otherPid) continue;
                    if (visited.has(sibling.id)) continue;
                    visited.add(sibling.id);
                    result.push({
                        spaceId: otherSpaceId,
                        polyId: sibling.id,
                        origEntities: [],
                        origOuter: sibling.outer.map((p) => [p[0], p[1]] as Vec2),
                        origHoles: (sibling.holes ?? []).map((h) =>
                            h.map((p) => [p[0], p[1]] as Vec2),
                        ),
                    });
                }
            }
        }
    }
    void seedSpaceId;
    return result;
}

function translateEntity(e: SketchEntity, dx: number, dy: number): SketchEntity {
    if (e.kind === "line") {
        return {
            ...e,
            p0: [e.p0[0] + dx, e.p0[1] + dy],
            p1: [e.p1[0] + dx, e.p1[1] + dy],
        };
    }
    if (e.kind === "polyline") {
        return {
            ...e,
            points: e.points.map((p) => [p[0] + dx, p[1] + dy] as Vec2),
        };
    }
    if (e.kind === "circle") {
        return { ...e, center: [e.center[0] + dx, e.center[1] + dy] };
    }
    if (e.kind === "arc") {
        return { ...e, center: [e.center[0] + dx, e.center[1] + dy] };
    }
    return e;
}

function arcFromChordAndCursor(p0: Vec2, p1: Vec2, cursor: Vec2): {
    center: Vec2; radius: number; aStart: number; aEnd: number;
} | null {
    const dx = p1[0] - p0[0], dy = p1[1] - p0[1];
    const chord = Math.hypot(dx, dy);
    if (chord < 1e-6) return null;
    const half = chord / 2;
    // 弦中点 M、単位接線 t、単位法線 n (CCW 90° 回転)。
    const mx = (p0[0] + p1[0]) / 2, my = (p0[1] + p1[1]) / 2;
    const tx = dx / chord, ty = dy / chord;
    const nx = -ty, ny = tx;
    // bulge = (cursor - M) · n  (符号付き)。
    const bulge = (cursor[0] - mx) * nx + (cursor[1] - my) * ny;
    if (Math.abs(bulge) < 1e-4) return null;
    // 中心は M + s·n の位置。s² + half² = (bulge - s)² より:
    //   s = (bulge² - half²) / (2 · bulge)
    const s = (bulge * bulge - half * half) / (2 * bulge);
    const cx = mx + s * nx, cy = my + s * ny;
    const radius = Math.hypot(p0[0] - cx, p0[1] - cy);
    if (!Number.isFinite(radius) || radius < 1e-6) return null;
    const a0 = Math.atan2(p0[1] - cy, p0[0] - cx);
    const a1 = Math.atan2(p1[1] - cy, p1[0] - cx);
    // ArcEntity は aStart→aEnd を CCW で描く。カーソル側を通る弧を選ぶ:
    //   - bulge > 0 (+n 側): 中心は -n 側 → +n 側を通る弧は CCW で a1→a0
    //   - bulge < 0 (-n 側): 中心は +n 側 → -n 側を通る弧は CCW で a0→a1
    if (bulge > 0) return { center: [cx, cy] as Vec2, radius, aStart: a1, aEnd: a0 };
    return { center: [cx, cy] as Vec2, radius, aStart: a0, aEnd: a1 };
}

/** Detect axis-aligned 4-vertex polygon. Returns its AABB or null. */
function polygonAsAxisAlignedRect(poly: RoomPolygon): { minX: number; minY: number; maxX: number; maxY: number } | null {
    if (poly.outer.length !== 4) return null;
    const xs = poly.outer.map((p) => p[0]);
    const ys = poly.outer.map((p) => p[1]);
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minY = Math.min(...ys), maxY = Math.max(...ys);
    // Each vertex must be a corner of the AABB
    const corners = new Set([
        `${minX},${minY}`, `${maxX},${minY}`, `${maxX},${maxY}`, `${minX},${maxY}`,
    ]);
    for (const p of poly.outer) {
        if (!corners.has(`${p[0]},${p[1]}`)) return null;
    }
    return { minX, minY, maxX, maxY };
}

interface Props { viewportRef: React.RefObject<ViewportHandle | null>; }

interface DragPolyState {
    kind: "poly";
    polyId: string;
    spaceId: string;
    startWorld: [number, number];
    origOuter: Vec2[];
    origHoles: Vec2[][];
    /** Snapshot of the dragged polygon's parametric shape at drag start. */
    origShapeCenter?: Vec2;
    origShapeRadius?: number;
    origWallAxes: { id: string; a: Vec3; b: Vec3 }[];
    // Snapshot of every concentric-group partner at drag start, so we can
    // translate them by the total delta each frame (NOT incrementally).
    origConcentric: { polyId: string; outer: Vec2[]; holes: Vec2[][]; shapeCenter: Vec2; shapeRadius: number }[];
    // Snapshot of any wall-outline polygons whose inner is this dragged
    // polygon — same translate-by-delta treatment so the outline follows.
    origOutlines: { polyId: string; outer: Vec2[]; holes: Vec2[][] }[];
    /**
     * ドラッグされる polygon に紐付く entity のスナップショット。
     * polyId → polyIdByEntity の逆引きで決まる。**毎フレーム origin から
     * 累計 delta** で平行移動するため (= incremental に動かすと FP 誤差が
     * 累積するため)、drag 開始時の値を保存する。空配列なら entity を持たない
     * polygon (= legacy / outline 等) → polygon 直接更新フォールバックを使う。
     */
    origEntities: { entityId: string; snapshot: SketchEntity }[];
    /**
     * cross-poly 拘束 (Collinear / Parallel / Perpendicular / Length) で
     * 連結された **別 polygon** のスナップショット。同じ delta で一緒に平行
     * 移動することで、向き・距離系の拘束が保たれる。Coincident は別途ブロック
     * 処理されるのでここには含めない。
     */
    linkedPolys: {
        spaceId: string;
        polyId: string;
        origEntities: { entityId: string; snapshot: SketchEntity }[];
        origOuter: Vec2[];
        origHoles: Vec2[][];
    }[];
    moved: boolean;
}
interface DragPolyVertexState {
    kind: "polyVertex";
    polyId: string;
    vertexIdx: number;
    origOuter: Vec2[];
    origHoles: Vec2[][];
    wallThickness?: number;
    moved: boolean;
    /** drag 開始時点で確定した「対応 entity の ID と point index」。entity 駆動 drag
     *  で毎フレーム位置探索すると、第 1 フレームの後で entity の point が動いて
     *  探索が失敗するので、ここに固定する。entity 不在 (= legacy polygon) なら null。 */
    entityId?: string | null;
    entityPointIdx?: number;
    /**
     * cross-poly 拘束 (Collinear / Parallel / Perpendicular / Length) で連結された
     * 別 polygon。頂点ドラッグでも、propagateSimpleConstraints の cascade で
     * 「ある edge の両端点が同じ delta で動いた」場合はその edge が剛体平行移動
     * したことになるので、連結 polygon も同じ delta で平行移動して collinear
     * 関係を保つ。
     */
    linkedPolys?: {
        spaceId: string;
        polyId: string;
        origEntities: { entityId: string; snapshot: SketchEntity }[];
        origOuter: Vec2[];
        origHoles: Vec2[][];
    }[];
}
interface DragPolyEdgeState {
    kind: "polyEdge";
    polyId: string;
    edgeIdx: number;
    origOuter: Vec2[];
    origHoles: Vec2[][];
    normal: [number, number];
    wallThickness?: number;
    startWorld: [number, number];
    moved: boolean;
    /**
     * cross-poly 拘束 (Collinear / Parallel / Perpendicular / Length) で連結
     * された別 polygon。エッジを perp 方向にドラッグした時、これらも同じ
     * (normal * perp) 分だけ rigid 平行移動する → Collinear が drag 中も保たれる。
     */
    linkedPolys?: {
        spaceId: string;
        polyId: string;
        origEntities: { entityId: string; snapshot: SketchEntity }[];
        origOuter: Vec2[];
        origHoles: Vec2[][];
    }[];
    /** drag 開始時点で確定した「対応 entity の ID と edge 両端の point index」。
     *  entity 駆動 drag で毎フレーム位置探索すると、第 1 フレーム後で entity の
     *  point が動いて探索が失敗するので、ここに固定する。entity 不在なら null。 */
    entityId?: string | null;
    entityPointIdxA?: number;
    entityPointIdxB?: number;
    /**
     * polygon の chain が「直線（line / open polyline）+ 弧 1 本」で構成される
     * 単純な D 形状の場合に、ドラッグ開始時の entity スナップショットを保存。
     * 直線辺の perp ドラッグで両端が同じ delta だけ動くケースは、updatePolysAndSync
     * の case A 検知に頼らず、ここに保存した snapshot を perp delta で平行移動して
     * setSpaceEntities に渡すことで「弧と直線の chain 接続が確実に保たれる」。
     * line+arc 以外（矩形 / polyline 単独 / 複雑な chain）では undefined を残し、
     * 従来の polygon 更新経路にフォールバックする。
     */
    origEntitiesForTranslate?: { entityId: string; snapshot: SketchEntity }[];
}
/**
 * Arc entity 全体を平行移動するドラッグ。
 *  - origCenter: arc.center の元値 (= ドラッグ開始時)
 *  - origAdjacentPoints: 同 space 内の polyline / line で、初期 chord 端点
 *    位置と一致していた端点の元位置。ドラッグ delta だけ並行移動して追従
 *    させるためのキャッシュ。
 *  - startWorld: ドラッグ開始世界座標 (delta 計算用)。
 */
interface DragEntityArcState {
    kind: "entityArc";
    spaceId: string;
    entityId: string;
    polyId: string;
    origCenter: [number, number];
    origAdjacentPoints: Array<{
        entityId: string;
        kind: "polyline" | "line";
        /** polyline なら index、line なら 0/1 */
        idx: number;
        orig: [number, number];
        /** この端点が arc の `aStart` 端点 (true) か `aEnd` 端点 (false) か。
         *  ドラッグ中は **新しい chord 端点** にスナップさせて、polyline と
         *  arc の chain 接続が壊れないようにする。 */
        matchesArcStart: boolean;
    }>;
    startWorld: [number, number];
    moved: boolean;
}
/**
 * 弧の端点 (start/end) ハンドルをドラッグ。
 *  - which: "start" → aStart を更新、"end" → aEnd を更新
 *  - origCenter / origRadius: ドラッグ開始時のスナップショット (center は据置、
 *    radius は cursor との距離で更新する FreeCAD 流の挙動)
 *  - 反対端点 (other endpoint) は radius が変わると世界座標も動くため、
 *    その「動く先」に追従させる polyline / line の端点キャッシュも保持。
 */
interface DragEntityArcEndpointState {
    kind: "entityArcEndpoint";
    spaceId: string;
    entityId: string;
    polyId: string;
    which: "start" | "end";
    origCenter: [number, number];
    origRadius: number;
    origAStart: number;
    origAEnd: number;
    /** dragged 端点 (= which 側) と一致していた polyline / line 端点。
     *  他端点 (= 反対側) の追従用キャッシュも別配列で保持。 */
    origDraggedAdj: Array<{
        entityId: string;
        kind: "polyline" | "line";
        idx: number;
    }>;
    /** 反対端点と一致していた polyline / line 端点 (= radius 変化に追従)。 */
    origOtherAdj: Array<{
        entityId: string;
        kind: "polyline" | "line";
        idx: number;
    }>;
    startWorld: [number, number];
    moved: boolean;
}
/** 円中心ハンドル (mid) ドラッグ — 円全体を平行移動。 */
interface DragEntityCircleCenterState {
    kind: "entityCircleCenter";
    spaceId: string;
    entityId: string;
    polyId: string;
    origCenter: [number, number];
    startWorld: [number, number];
    moved: boolean;
}
/** 円の周をドラッグ → 半径変更 (FreeCAD 流: cursor との距離で radius)。 */
interface DragEntityCircleRadiusState {
    kind: "entityCircleRadius";
    spaceId: string;
    entityId: string;
    polyId: string;
    center: [number, number];
    moved: boolean;
}
type DragState =
    | DragPolyState
    | DragPolyVertexState
    | DragPolyEdgeState
    | DragEntityArcState
    | DragEntityArcEndpointState
    | DragEntityCircleCenterState
    | DragEntityCircleRadiusState;
interface HoveredPolyVertex { polyId: string; vertexIdx: number; wx: number; wz: number; }
interface HoveredEdge { polyId: string; edgeIdx: number; midWx: number; midWz: number; }
interface EditingDim { polyId: string; axis: "w" | "h"; value: string; }

const VERTEX_SCREEN_RADIUS = 10;

type RGBA = [number, number, number, number];
const rgba = (r: number, g: number, b: number, a = 1): RGBA => [r / 255, g / 255, b / 255, a];
const ROOM_SHAPE_DEBUG = true;
const fmtDbgPt = (p: Vec2 | [number, number]) => `(${p[0].toFixed(3)},${p[1].toFixed(3)})`;
const fmtDbgRing = (pts: Array<Vec2 | [number, number]>) => `[${pts.map(fmtDbgPt).join(" ")}]`;

const C_RECT          = rgba(59, 130, 246);
const C_RECT_FILL     = rgba(59, 130, 246, 0.06);
const C_RECT_HOV      = rgba(96, 165, 250);
const C_RECT_HOV_FILL = rgba(96, 165, 250, 0.12);
const C_RECT_SEL      = rgba(249, 115, 22);
// 部屋領域のハイライト塗り — 旧 0.10 透過は薄くて視認しづらかったので
// 0.25 に上げて濃いオレンジ感を出す。
const C_RECT_SEL_FILL = rgba(249, 115, 22, 0.25);
const C_TEMP          = rgba(34, 197, 94);
const C_TEMP_FILL     = rgba(34, 197, 94, 0.08);
const C_WHITE         = SNAP_RGBA_WHITE;
const C_HL_ORANGE     = rgba(234, 88, 12);
const C_HL_FILL       = rgba(234, 88, 12, 0.25);
const C_WALL_SLAB     = rgba(140, 140, 145, 0.85);
// 仮壁 (provisional wall) — light gray band shown outside a freshly drawn
// room polygon, before walls have been generated. Per docs/specification/new.md
// §1: "仮壁: 薄いグレー" / §4: "仮壁: 薄いグレーの帯".
const C_VIRTUAL_WALL  = rgba(160, 170, 185, 0.55);
// Default wall thickness for the provisional band (105mm — residential mode default).
const VIRTUAL_WALL_THICKNESS_M = 0.105;
const C_OVERLAP       = rgba(236, 72, 153);
const C_OVERLAP_FILL  = rgba(236, 72, 153, 0.18);
const C_SNAP_OBJ      = SNAP_RGBA_OBJ;
const C_SNAP_AXIS     = SNAP_RGBA_AXIS;
const C_POLAR_GUIDE   = SNAP_RGBA_POLAR_GUIDE;
const C_POLAR_ACTIVE  = SNAP_RGBA_POLAR_ACTIVE;
const C_EDGE_HOV      = rgba(251, 146, 60);
// 壁省略 (= wallSkip) を可視化するときの色。dashed thin で描画。
const C_WALL_SKIP     = rgba(120, 130, 145, 0.85);
const C_WALL_SKIP_PICK = rgba(220, 90, 90); // wallSkip ピック中のプレビュー
// 他階の壁を「参照線」として描く色 (スケッチライン非表示・壁外周だけ薄グレー)。
//   部屋編集中、他レベルの壁を見ながら同位置に重ねる (= 上下階の柱・通り芯
//   合わせ) 用途のため、目立ちすぎず 視認できる薄さで採用。
const C_OTHER_LEVEL_REF = rgba(140, 140, 145, 0.55);

/** [0, 1] の中で `kept` が占めない部分 (= 補集合) を返す。`kept` は
 *  `unskippedRanges` の出力と同形式 (start で sort 済み、互いに重ならない)。 */
function complementRanges01(kept: Array<[number, number]>): Array<[number, number]> {
    const out: Array<[number, number]> = [];
    let prev = 0;
    for (const [a, b] of kept) {
        if (a > prev) out.push([prev, a]);
        prev = b;
    }
    if (prev < 1) out.push([prev, 1]);
    return out;
}
const C_ORIGIN_X   = ORIGIN_RGBA_X;
const C_ORIGIN_Z   = ORIGIN_RGBA_Z;
const C_ORIGIN_DOT = ORIGIN_RGBA_DOT_STROKE;

function autoRectConstraints(spaceId: string, polyId: string): Constraint[] {
    return [
        {
            id: generateConstraintId(),
            type: "Horizontal",
            targets: [{ kind: "SketchEdge", spaceId, polyId, edgeIdx: 0 }],
        },
        {
            id: generateConstraintId(),
            type: "Horizontal",
            targets: [{ kind: "SketchEdge", spaceId, polyId, edgeIdx: 2 }],
        },
        {
            id: generateConstraintId(),
            type: "Vertical",
            targets: [{ kind: "SketchEdge", spaceId, polyId, edgeIdx: 1 }],
        },
        {
            id: generateConstraintId(),
            type: "Vertical",
            targets: [{ kind: "SketchEdge", spaceId, polyId, edgeIdx: 3 }],
        },
    ];
}

export default function RoomSketchOverlay({ viewportRef }: Props) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const rendererRef = useRef<SketchOverlayRenderer | null>(null);
    const dimLayerRef = useRef<HTMLDivElement>(null);

    const activeRoomId = useAppState((s: AppState) => s.activeRoomId);
    const pendingRoomLevelId = useAppState((s: AppState) => s.pendingRoomLevelId);
    const setPendingRoomLevel = useAppState((s: AppState) => s.setPendingRoomLevel);
    const activeTool = useAppState((s: AppState) => s.activeTool);
    const roomEditMode = useAppState((s: AppState) => s.roomEditMode);
    const grids = useAppState((s: AppState) => s.grids);
    const designMode = useAppState((s: AppState) => s.designMode);
    const setRoomEditMode = useAppState((s: AppState) => s.setRoomEditMode);
    const elements = useAppState((s: AppState) => s.elements);
    const selection = useAppState((s: AppState) => s.selection);
    const setSelection = useAppState((s: AppState) => s.setSelection);
    const updateElement = useAppState((s: AppState) => s.updateElement);
    const removeElement = useAppState((s: AppState) => s.removeElement);
    const setSpaceEntities = useAppState((s: AppState) => s.setSpaceEntities);
    const sketchSelection = useAppState((s: AppState) => s.sketchSelection);
    const constraints = useAppState((s: AppState) => s.constraints);
    const toggleSketchSelection = useAppState((s: AppState) => s.toggleSketchSelection);
    const clearSketchSelection = useAppState((s: AppState) => s.clearSketchSelection);
    const setSolverDragHint = useAppState((s: AppState) => s.setSolverDragHint);
    const executeCommand = useAppState((s: AppState) => s.executeCommand);
    const setActiveRoom = useAppState((s: AppState) => s.setActiveRoom);

    const [rectStart, setRectStart] = useState<[number, number] | null>(null);
    const [mouseWorld, setMouseWorld] = useState<[number, number] | null>(null);
    // Polyline draft: one [x,z] pair per committed click. Last leg to cursor is shown dashed.
    const [polyDraftPoints, setPolyDraftPoints] = useState<[number, number][]>([]);
    /**
     * WallPath ドラフト中の "live" polygon を追跡する ref。1 点目のクリック時点
     * では undefined のまま、2 点目以降のクリック直後に polygon を実体化して
     * 3D 壁を即時表示する。各追加クリックでは同じ polyId / entityId を持った
     * まま entity の points を拡張するため、ここで全部保持。確定 (Enter /
     * 右クリック / ダブルクリック) または mode 切替でクリア。
     *
     * entityId は WallPath を裏付ける open PolylineEntity の id。これがある
     * ことで、隣の図形 commit や solver writeback で setSpaceEntities が走っ
     * ても derivePolygonsFromEntities が同 polyId で polygon を再生成し、
     * WallPath が消えない。
     */
    const wallPathDraftRef = useRef<{
        polyId: string;
        roomId: ElementId;
        entityId: string;
    } | null>(null);
    /**
     * WallPath 各ドラフト点に紐づくスナップ target の履歴。`polyDraftPoints`
     * と同じ index で対応。スナップしなかった点は undefined。`commitWallPath
     * Draft` で polygon の `joints[]` に変換して保存する。
     */
    type WallPathSnapTargetSafe =
        | { kind: "polyVertex"; spaceId: string; polyId: string; targetVertexIdx: number }
        | { kind: "polyEdge"; spaceId: string; polyId: string; targetEdgeIdx: number; t: number };
    const wallPathDraftSnapsRef = useRef<(WallPathSnapTargetSafe | undefined)[]>([]);
    // Circle draft: center set on 1st click, radius committed on 2nd click
    const [circleCenter, setCircleCenter] = useState<[number, number] | null>(null);
    // Circle live preview ref (= マウス移動中に 3D 壁を出すための incremental
    // CircleEntity)。WallPath / polyline と同じ機構。
    const circleLiveDraftRef = useRef<{
        polyId: string;
        roomId: ElementId;
        entityId: string;
    } | null>(null);
    // Single-line draft (mode = "line"): first click sets start, second commits.
    const [lineStart, setLineStart] = useState<[number, number] | null>(null);
    // 3-click arc draft (mode = "arc"): 弦端点 P0 → 弦端点 P1 → bulge カーソル
    // (= 弧の膨らみ位置)。1 点目と 2 点目で弦 (= ChordEntity の 2 端点) が
    // 確定し、3 点目で `arcFromChordAndCursor` 経由でカーソル側を通る弧の
    // 中心 / 半径 / 角度を確定する。
    const [arcChordP0, setArcChordP0] = useState<[number, number] | null>(null);
    const [arcChordP1, setArcChordP1] = useState<[number, number] | null>(null);
    // Arc-from-edge draft (mode = "arcEdge"): 既存エッジを chord として固定し、
    // マウスで bulge (= chord 中点からの垂直距離) を決定する。
    type ArcEdgeChord = {
        spaceId: string;
        polyId: string;
        edgeIdx: number;
        p0: Vec2;
        p1: Vec2;
    };
    const [arcEdgeChord, setArcEdgeChord] = useState<ArcEdgeChord | null>(null);
    // wallSkip mode の進行状況。1 クリックで t0 を確定 → 2 クリックで t1 確定 →
    // WallSkip を polygon.wallSkips に push して mode を抜ける。
    type WallSkipDraft = {
        spaceId: string; polyId: string; edgeIdx: number;
        /** 1 クリック目で確定する弦上の比率 (0..1)。null なら未確定。 */
        t0: number | null;
    };
    const [wallSkipDraft, setWallSkipDraft] = useState<WallSkipDraft | null>(null);
    // 右クリック直後に表示する選択エッジ用のコンテキストメニュー。
    const [edgeContextMenu, setEdgeContextMenu] = useState<{
        x: number; y: number;
        spaceId: string; polyId: string; edgeIdx: number;
    } | null>(null);
    // Trim draft (mode = "trim"): picked target + first cut point.
    const [trimTargetEntityId, setTrimTargetEntityId] = useState<string | null>(null);
    const [trimFirstPoint, setTrimFirstPoint] = useState<[number, number] | null>(null);
    const [gridSnapInfo, setGridSnapInfo] = useState<{
        point: [number, number];
        // 各 kind のシンボル形状・色は ../snapStyle.ts の SNAP_MARKER_STYLES で定義。
        kind: SnapKind;
        refH?: [number, number];
        refV?: [number, number];
    } | null>(null);
    const [hoveredPolyId, setHoveredPolyId] = useState<string | null>(null);
    // hoveredPolyId が属する Space。アクティブ Room 上なら activeRoomId と一致するが、
    // 別 Room (重なり領域で上に乗っている Room) をホバーした場合は別の値を持つ。
    // ハイライト描画とカーソル切替の両方で「どの Room の polygon を指しているか」を
    // 判別するために必要。
    const [hoveredPolySpaceId, setHoveredPolySpaceId] = useState<string | null>(null);
    const [hoveredPolyVertex, setHoveredPolyVertex] = useState<HoveredPolyVertex | null>(null);
    const [hoveredEdge, setHoveredEdge] = useState<HoveredEdge | null>(null);
    // 通芯 (gridLine / gridPoint) のホバー — カーソル形状を pointer に切り替える
    // ためだけに使う。クリック判定自体は handlePointerDown 側の hitTestGrid。
    const [hoveredGrid, setHoveredGrid] = useState<
        | { kind: "gridPoint"; gridId: string; vertexIdx: number }
        | { kind: "gridLine"; gridId: string }
        | null
    >(null);
    const [dragState, setDragState] = useState<DragState | null>(null);
    const [editingDim, setEditingDim] = useState<EditingDim | null>(null);
    const [lastDraggedPolyId, setLastDraggedPolyId] = useState<string | null>(null);

    const [, setTick] = useState(0);

    // Pass-through flag: when the wall tool is active and the user clicks an
    // empty area (no sketch vertex/edge hit), we dispatch the pointer event
    // to the 3D canvas beneath so wall drawing can run while this overlay
    // stays live for picking room geometry. This flag stays true for the
    // remainder of that gesture so pointermove / pointerup are forwarded too.
    const wallPassthroughRef = useRef(false);
    const suppressSelectDragUntilPointerUpRef = useRef(false);
    const lastRectangleCommitAtRef = useRef(0);
    // クリック / ドラッグ判定のしきい値 (CSS px)。pointerdown 時の画面座標を
    // ここに保存し、pointermove で距離が DRAG_THRESHOLD_PX 未満ならまだクリック
    // 扱いにする → dragState.moved を true にせず、ドラッグ系の reflow も走らせ
    // ない。これがないと「Shift+クリックで複数選択」しようとした際にわずかな
    // マウスジッタで毎回 setSelection([]) (ドラッグ確定) が走り、選択が捨てら
    // れていた。
    const DRAG_THRESHOLD_PX = 4;
    const dragStartScreenRef = useRef<[number, number] | null>(null);

    // Refs mirroring state so the render loop reads latest values
    const roomEditModeRef = useRef(roomEditMode); roomEditModeRef.current = roomEditMode;
    const elementsRef = useRef(elements); elementsRef.current = elements;
    const selectionRef = useRef(selection); selectionRef.current = selection;
    const activeRoomIdRef = useRef(activeRoomId); activeRoomIdRef.current = activeRoomId;
    // 部屋モードに入ったが Space 未生成の状態 (= "Add Room" 直後) で、編集中
    // レベルを保持する。buildDrawLists / snap が「現在編集中のレベル」を参照
    // するために必要 (= 他レベルの壁を参照線として描く / スナップ判定に使う)。
    const pendingRoomLevelIdRef = useRef(pendingRoomLevelId); pendingRoomLevelIdRef.current = pendingRoomLevelId;
    const rectStartRef = useRef(rectStart); rectStartRef.current = rectStart;
    const mouseWorldRef = useRef(mouseWorld); mouseWorldRef.current = mouseWorld;
    const polyDraftPointsRef = useRef(polyDraftPoints); polyDraftPointsRef.current = polyDraftPoints;
    const circleCenterRef = useRef(circleCenter); circleCenterRef.current = circleCenter;
    const lineStartRef = useRef(lineStart); lineStartRef.current = lineStart;
    const arcChordP0Ref = useRef(arcChordP0); arcChordP0Ref.current = arcChordP0;
    const arcChordP1Ref = useRef(arcChordP1); arcChordP1Ref.current = arcChordP1;
    const arcEdgeChordRef = useRef(arcEdgeChord); arcEdgeChordRef.current = arcEdgeChord;
    const wallSkipDraftRef = useRef(wallSkipDraft); wallSkipDraftRef.current = wallSkipDraft;
    const trimTargetEntityIdRef = useRef(trimTargetEntityId); trimTargetEntityIdRef.current = trimTargetEntityId;
    const trimFirstPointRef = useRef(trimFirstPoint); trimFirstPointRef.current = trimFirstPoint;
    // Populated by the body below — lets the Enter-key effect (declared before
    // the early return) call the latest closure.
    const commitPolyDraftRef = useRef<(pts: [number, number][]) => void>(() => {});
    const commitWallPathDraftRef = useRef<(pts: [number, number][]) => void>(() => {});
    const discardLiveWallPathDraftRef = useRef<() => void>(() => {});
    const discardLiveCircleDraftRef = useRef<() => void>(() => {});
    const hoveredPolyIdRef = useRef(hoveredPolyId); hoveredPolyIdRef.current = hoveredPolyId;
    const hoveredPolySpaceIdRef = useRef(hoveredPolySpaceId); hoveredPolySpaceIdRef.current = hoveredPolySpaceId;
    const hoveredPolyVertexRef = useRef(hoveredPolyVertex); hoveredPolyVertexRef.current = hoveredPolyVertex;
    const hoveredEdgeRef = useRef(hoveredEdge); hoveredEdgeRef.current = hoveredEdge;
    const dragStateRef = useRef(dragState); dragStateRef.current = dragState;
    const lastDraggedPolyIdRef = useRef(lastDraggedPolyId); lastDraggedPolyIdRef.current = lastDraggedPolyId;
    const sketchSelectionRef = useRef(sketchSelection); sketchSelectionRef.current = sketchSelection;
    const gridsRef = useRef<GridLine[]>(grids); gridsRef.current = grids;
    const designModeRef = useRef(designMode); designModeRef.current = designMode;
    const gridSnapInfoRef = useRef(gridSnapInfo); gridSnapInfoRef.current = gridSnapInfo;
    const snapBVH = useMemo(() => SnapBVH.fromGrids(grids), [grids]);
    const snapBVHRef = useRef(snapBVH); snapBVHRef.current = snapBVH;

    // pending と activeRoom のどちらも「部屋モード on」として扱う。
    // pending は最初の図形を描く直前の状態 (Space 実体まだ無し)。
    const inRoomMode = !!activeRoomId || !!pendingRoomLevelId;

    // ── Init WebGPU renderer ──
    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas || !inRoomMode) return;

        let disposed = false;
        let rafId = 0;
        const renderer = new SketchOverlayRenderer(canvas);
        rendererRef.current = renderer;

        const resize = () => {
            if (!canvas.parentElement) return;
            const r = canvas.parentElement.getBoundingClientRect();
            renderer.resize(r.width, r.height, window.devicePixelRatio || 1);
        };

        (async () => {
            const ok = await renderer.init();
            if (!ok || disposed) return;
            resize();
            const loop = () => {
                if (disposed) return;
                const cam = viewportRef.current?.getCamera() ?? null;
                if (cam) {
                    resize();
                    const { lines, quads, markers } = buildDrawLists();
                    renderer.render(cam.viewProjectionMatrix as mat4, lines, quads, markers);
                }
                rafId = requestAnimationFrame(loop);
            };
            loop();
        })();

        window.addEventListener("resize", resize);
        return () => {
            disposed = true;
            cancelAnimationFrame(rafId);
            window.removeEventListener("resize", resize);
            renderer.destroy();
            rendererRef.current = null;
        };
    }, [inRoomMode]);

    // ── Trigger React re-renders (for HTML dim labels which depend on camera) ──
    useEffect(() => {
        if (!inRoomMode || editingDim) return;
        let running = true;
        const loop = () => { if (!running) return; setTick(t => t + 1); requestAnimationFrame(loop); };
        requestAnimationFrame(loop);
        return () => { running = false; };
    }, [inRoomMode, editingDim]);

    // ── Re-dispatch wheel / RMB / MMB to the 3D canvas behind ──
    useEffect(() => {
        const cvs = canvasRef.current;
        if (!cvs || !inRoomMode) return;
        const bgCanvas = cvs.parentElement?.querySelector("canvas:not([data-sketch-overlay])");
        if (!bgCanvas) return;
        const onWheel = (e: WheelEvent) => { bgCanvas.dispatchEvent(new WheelEvent("wheel", e)); };
        const onMouse = (e: MouseEvent) => { if (e.button === 1 || e.button === 2) bgCanvas.dispatchEvent(new MouseEvent("mousedown", e)); };
        const onCtx = (e: MouseEvent) => { e.preventDefault(); };
        cvs.addEventListener("wheel", onWheel, { passive: true });
        cvs.addEventListener("mousedown", onMouse);
        cvs.addEventListener("contextmenu", onCtx);
        return () => {
            cvs.removeEventListener("wheel", onWheel);
            cvs.removeEventListener("mousedown", onMouse);
            cvs.removeEventListener("contextmenu", onCtx);
        };
    }, [inRoomMode]);

    // Refs for callbacks used in DOM event listeners
    const editingDimRef = useRef(editingDim);
    editingDimRef.current = editingDim;

    const commitDimRef = useRef((_v: string) => {});
    const startDimRef = useRef((_pid: string, _axis: "w" | "h", _mm: number) => {});
    const mergeRef = useRef<(focusPolyId?: string) => void>(() => {});
    const clipRef  = useRef<(focusPolyId?: string) => void>(() => {});
    const applyCollinearRef = useRef(
        (_polyIdA: string, _edgeIdxA: number, _polyIdB: string, _edgeIdxB: number) => {},
    );

    // Dim label DOM update
    useEffect(() => {
        const layer = dimLayerRef.current;
        if (!layer) return;

        const camera = viewportRef.current?.getCamera() ?? null;
        if (!activeRoomId || !camera || editingDimRef.current) return;

        const el = elements[activeRoomId];
        if (!el || el.type !== "Space") { layer.innerHTML = ""; return; }
        const room = el as SpaceElement;

        const r = canvasRef.current?.getBoundingClientRect();
        if (!r) return;
        const proj = (wx: number, wz: number) => worldToScreen(wx, wz, camera.viewProjectionMatrix as mat4, r.width, r.height);

        layer.innerHTML = "";

        // Axis-aligned 4-vertex polygon dimension labels (editable)
        for (const poly of room.polygons) {
            const aabb = polygonAsAxisAlignedRect(poly);
            if (!aabb) continue;
            const [x1, y1] = proj(aabb.minX, aabb.minY);
            const [x2, y2] = proj(aabb.maxX, aabb.maxY);
            const rx = Math.min(x1, x2), ry = Math.min(y1, y2);
            const rw = Math.abs(x2 - x1), rh = Math.abs(y2 - y1);
            const dimW = aabb.maxX - aabb.minX;
            const dimH = aabb.maxY - aabb.minY;

            const isSel = selection.includes(`poly:${poly.id}`);
            const isHov = hoveredPolyId === poly.id
                && hoveredPolySpaceId === activeRoomId
                && !isSel;
            const color = isSel ? "#f97316" : isHov ? "#60a5fa" : "#3b82f6";

            const mkLabel = (text: string, left: number, top: number, center: boolean, axis: "w" | "h", mm: number) => {
                const d = document.createElement("div");
                d.textContent = text;
                d.style.cssText = `position:absolute;left:${left}px;top:${top}px;font-size:11px;font-family:monospace;color:${color};cursor:text;user-select:none;white-space:nowrap;pointer-events:auto;padding:2px 4px;border-radius:3px;${center ? "transform:translateX(-50%);" : ""}`;
                d.addEventListener("mousedown", (ev) => {
                    ev.stopPropagation();
                    ev.preventDefault();
                    startDimRef.current(poly.id, axis, mm);
                });
                layer.appendChild(d);
            };

            if (rw > 40) mkLabel(`${(dimW * 1000).toFixed(0)}mm`, rx + rw / 2, ry - 20, true, "w", dimW * 1000);
            if (rh > 40) mkLabel(`${(dimH * 1000).toFixed(0)}mm`, rx + rw + 6, ry + rh / 2 - 8, false, "h", dimH * 1000);
        }

        // Selected wall length label
        for (const id in elements) {
            const we = elements[id];
            if (we.type !== "Wall") continue;
            if (!selection.includes(id)) continue;
            const w = we as WallElement;
            const [sx1, sy1] = proj(w.axis[0][0], w.axis[0][2]);
            const [sx2, sy2] = proj(w.axis[1][0], w.axis[1][2]);
            const len = Math.hypot(w.axis[1][0] - w.axis[0][0], w.axis[1][2] - w.axis[0][2]);
            const d = document.createElement("div");
            d.textContent = `${(len * 1000).toFixed(0)}mm`;
            d.style.cssText = `position:absolute;left:${(sx1+sx2)/2}px;top:${(sy1+sy2)/2 - 22}px;transform:translateX(-50%);font-size:11px;font-family:monospace;color:#f97316;user-select:none;white-space:nowrap;pointer-events:none;`;
            layer.appendChild(d);
        }

        // Merge / Clip icons (shown at top-right of an overlapping polygon)
        //
        // 仕様: 部屋同士が重なっている間は常時表示する (= 他の要素を選択しても
        // 消えない)。focus polygon の選択優先度:
        //   1. lastDraggedPolyId (= 直近で動かした polygon) が今も重なっていれば
        //      それを focus にする。
        //   2. そうでなければ全 Space の polygon を走査して、最初に重なっている
        //      ものを focus にする。
        // 「1図形=1Room」仕様 (449b326 / 4d3b0cc) のため、全 Space を横断して
        // 検索する。outline polygon (wallOutlineOf) は派生形状なので除外。
        // レベルガード: 異なる階の polygon 同士は重なり判定しない。
        {
            const eps = 1e-6;
            interface PolyRef { poly: RoomPolygon; spaceId: string; }
            const aabb = (p: RoomPolygon) => {
                const xs = p.outer.map((q) => q[0]);
                const ys = p.outer.map((q) => q[1]);
                return [
                    Math.min(...xs), Math.max(...xs),
                    Math.min(...ys), Math.max(...ys),
                ];
            };
            const overlaps = (a: RoomPolygon, b: RoomPolygon) => {
                const [aMinX, aMaxX, aMinY, aMaxY] = aabb(a);
                const [bMinX, bMaxX, bMinY, bMaxY] = aabb(b);
                return aMinX < bMaxX - eps && aMaxX > bMinX + eps
                    && aMinY < bMaxY - eps && aMaxY > bMinY + eps;
            };
            const lvlOf = (spaceId: string): string | undefined => {
                const sp = elements[spaceId];
                return sp && sp.type === "Space"
                    ? (sp as SpaceElement).levelId : undefined;
            };
            // 全 non-outline polygon を集める。
            const allPolys: PolyRef[] = [];
            for (const id in elements) {
                const el = elements[id];
                if (!el || el.type !== "Space") continue;
                const sp = el as SpaceElement;
                for (const p of sp.polygons ?? []) {
                    if (p.wallOutlineOf) continue;
                    allPolys.push({ poly: p, spaceId: id });
                }
            }
            const findOverlapPartner = (ref: PolyRef): boolean => {
                const refLvl = lvlOf(ref.spaceId);
                for (const other of allPolys) {
                    if (other.poly.id === ref.poly.id) continue;
                    const oLvl = lvlOf(other.spaceId);
                    if (refLvl !== undefined && oLvl !== undefined && oLvl !== refLvl) continue;
                    if (overlaps(ref.poly, other.poly)) return true;
                }
                return false;
            };
            // focus 選択: lastDragged が今も重なっていれば優先、なければ任意。
            let focus: RoomPolygon | undefined;
            let focusSpaceId: string | undefined;
            if (lastDraggedPolyId) {
                const ld = allPolys.find((r) => r.poly.id === lastDraggedPolyId);
                if (ld && findOverlapPartner(ld)) {
                    focus = ld.poly;
                    focusSpaceId = ld.spaceId;
                }
            }
            if (!focus) {
                for (const ref of allPolys) {
                    if (findOverlapPartner(ref)) {
                        focus = ref.poly;
                        focusSpaceId = ref.spaceId;
                        break;
                    }
                }
            }
            if (focus && focusSpaceId) {
                const xs = focus.outer.map(p => p[0]);
                const ys = focus.outer.map(p => p[1]);
                const fMinX = Math.min(...xs), fMaxX = Math.max(...xs);
                const fMinZ = Math.min(...ys), fMaxZ = Math.max(...ys);
                {
                    const [mx1, my1] = proj(fMinX, fMinZ);
                    const [mx2, my2] = proj(fMaxX, fMaxZ);
                    const rightX = Math.max(mx1, mx2);
                    const topY = Math.min(my1, my2);
                    const btn = document.createElement("button");
                    btn.type = "button";
                    btn.title = "重なる部屋を結合";
                    btn.textContent = "⛶";
                    btn.style.cssText = `position:absolute;left:${rightX + 6}px;top:${topY - 14}px;width:24px;height:24px;border-radius:12px;border:1.5px solid #ec4899;background:#fff;color:#ec4899;font-size:14px;font-weight:700;cursor:pointer;display:flex;align-items:center;justify-content:center;box-shadow:0 2px 6px rgba(236,72,153,0.35);pointer-events:auto;user-select:none;padding:0;line-height:1;`;
                    const focusPolyIdForClick = focus.id;
                    btn.addEventListener("mousedown", (ev) => {
                        ev.stopPropagation();
                        ev.preventDefault();
                        mergeRef.current(focusPolyIdForClick);
                    });
                    layer.appendChild(btn);

                    // ── Clip (subtract) button ──
                    const clipBtn = document.createElement("button");
                    clipBtn.type = "button";
                    clipBtn.title = "重なる部屋を差し引き（上の部屋の形で下の部屋を切り取る）";
                    clipBtn.textContent = "⊖";
                    clipBtn.style.cssText = `position:absolute;left:${rightX + 6}px;top:${topY + 16}px;width:24px;height:24px;border-radius:12px;border:1.5px solid #f97316;background:#fff;color:#f97316;font-size:14px;font-weight:700;cursor:pointer;display:flex;align-items:center;justify-content:center;box-shadow:0 2px 6px rgba(249,115,22,0.35);pointer-events:auto;user-select:none;padding:0;line-height:1;`;
                    clipBtn.addEventListener("mousedown", (ev) => {
                        ev.stopPropagation();
                        ev.preventDefault();
                        clipRef.current(focusPolyIdForClick);
                    });
                    layer.appendChild(clipBtn);
                }

                // ── Collinear-suggestion icons ──────────────────────────
                // For every edge of the last-dragged polygon, find any edge
                // of another polygon that is almost parallel and almost on
                // the same infinite line. Show a clickable icon that applies
                // a Collinear constraint between them.
                const ANGLE_EPS = (5 * Math.PI) / 180;      // 5° tolerance
                const DIST_EPS = 0.3;                       // 0.3 m (world)
                const focusIsCircle = focus.shape?.type === "circle";
                if (!focusIsCircle) {
                    const seen = new Set<string>();
                    const fN = focus.outer.length;
                    for (let i = 0; i < fN; i++) {
                        const fa = focus.outer[i];
                        const fb = focus.outer[(i + 1) % fN];
                        const fdx = fb[0] - fa[0], fdy = fb[1] - fa[1];
                        const fLen = Math.hypot(fdx, fdy);
                        if (fLen < 1e-6) continue;
                        const fUx = fdx / fLen, fUy = fdy / fLen;
                        const fAngle = Math.atan2(fdy, fdx);
                        for (const other of room.polygons) {
                            if (other.id === focus.id) continue;
                            if (other.shape?.type === "circle") continue;
                            const oN = other.outer.length;
                            for (let j = 0; j < oN; j++) {
                                const oa = other.outer[j];
                                const ob = other.outer[(j + 1) % oN];
                                const odx = ob[0] - oa[0], ody = ob[1] - oa[1];
                                const oLen = Math.hypot(odx, ody);
                                if (oLen < 1e-6) continue;
                                const oAngle = Math.atan2(ody, odx);
                                // Directed difference folded to [0, π/2]:
                                // parallel lines can point opposite ways and
                                // still be collinear.
                                let dAng = Math.abs(fAngle - oAngle) % Math.PI;
                                if (dAng > Math.PI / 2) dAng = Math.PI - dAng;
                                if (dAng > ANGLE_EPS) continue;
                                // Perpendicular distance: project (oa - fa)
                                // onto the normal of f's direction.
                                const nx = -fUy, ny = fUx;
                                const perp = Math.abs((oa[0] - fa[0]) * nx + (oa[1] - fa[1]) * ny);
                                if (perp > DIST_EPS) continue;
                                // Require midpoint proximity so we don't
                                // suggest pairing parallel edges on the
                                // opposite ends of the room.
                                const fmx = (fa[0] + fb[0]) / 2, fmy = (fa[1] + fb[1]) / 2;
                                const omx = (oa[0] + ob[0]) / 2, omy = (oa[1] + ob[1]) / 2;
                                const mid2mid = Math.hypot(fmx - omx, fmy - omy);
                                if (mid2mid > (fLen + oLen)) continue;

                                // Dedup in both orderings
                                const key = [focus.id, i, other.id, j].join(":");
                                const keyR = [other.id, j, focus.id, i].join(":");
                                if (seen.has(key) || seen.has(keyR)) continue;
                                seen.add(key);

                                const [ix, iy] = proj((fmx + omx) / 2, (fmy + omy) / 2);
                                const polyIdA = focus.id, edgeIdxA = i;
                                const polyIdB = other.id, edgeIdxB = j;
                                const cbtn = document.createElement("button");
                                cbtn.type = "button";
                                cbtn.title = "2 辺を同一軸上に揃える (Collinear)";
                                cbtn.textContent = "━";
                                cbtn.style.cssText = `position:absolute;left:${ix - 12}px;top:${iy - 12}px;width:24px;height:24px;border-radius:12px;border:1.5px solid #2563eb;background:#fff;color:#2563eb;font-size:13px;font-weight:700;cursor:pointer;display:flex;align-items:center;justify-content:center;box-shadow:0 2px 6px rgba(37,99,235,0.35);pointer-events:auto;user-select:none;padding:0;line-height:1;`;
                                cbtn.addEventListener("mousedown", (ev) => {
                                    ev.stopPropagation();
                                    ev.preventDefault();
                                    applyCollinearRef.current(polyIdA, edgeIdxA, polyIdB, edgeIdxB);
                                });
                                layer.appendChild(cbtn);
                            }
                        }
                    }
                }
            }
        }

        // Temp rect dimension labels while drawing
        if (roomEditMode === "rectangle" && rectStart && mouseWorld) {
            const [tx1, ty1] = proj(rectStart[0], rectStart[1]);
            const [tx2, ty2] = proj(mouseWorld[0], mouseWorld[1]);
            const rx = Math.min(tx1, tx2), ry = Math.min(ty1, ty2);
            const rw = Math.abs(tx2 - tx1), rh = Math.abs(ty2 - ty1);
            const ww = Math.abs(mouseWorld[0] - rectStart[0]);
            const wh = Math.abs(mouseWorld[1] - rectStart[1]);
            if (rw > 40) {
                const d = document.createElement("div");
                d.textContent = `${(ww * 1000).toFixed(0)}mm`;
                d.style.cssText = `position:absolute;left:${rx+rw/2}px;top:${ry-18}px;transform:translateX(-50%);font-size:11px;font-family:monospace;color:#22c55e;user-select:none;white-space:nowrap;pointer-events:none;`;
                layer.appendChild(d);
            }
            if (rh > 40) {
                const d = document.createElement("div");
                d.textContent = `${(wh * 1000).toFixed(0)}mm`;
                d.style.cssText = `position:absolute;left:${rx+rw+6}px;top:${ry+rh/2-8}px;font-size:11px;font-family:monospace;color:#22c55e;user-select:none;white-space:nowrap;pointer-events:none;`;
                layer.appendChild(d);
            }
        }
    }); // runs every render for position tracking

    // Editing input mount
    useEffect(() => {
        const layer = dimLayerRef.current;
        if (!layer || !editingDim || !activeRoomId) return;

        const camera = viewportRef.current?.getCamera() ?? null;
        const el = elements[activeRoomId];
        if (!camera || !el || el.type !== "Space") return;
        const room = el as SpaceElement;
        const poly = room.polygons.find(p => p.id === editingDim.polyId);
        if (!poly) return;
        const aabb = polygonAsAxisAlignedRect(poly);
        if (!aabb) return;

        const r = canvasRef.current?.getBoundingClientRect();
        if (!r) return;
        const proj = (wx: number, wz: number) => worldToScreen(wx, wz, camera.viewProjectionMatrix as mat4, r.width, r.height);

        const [x1, y1] = proj(aabb.minX, aabb.minY);
        const [x2, y2] = proj(aabb.maxX, aabb.maxY);
        const rx = Math.min(x1, x2), ry = Math.min(y1, y2);
        const rw = Math.abs(x2 - x1), rh = Math.abs(y2 - y1);

        layer.innerHTML = "";
        const input = document.createElement("input");
        input.type = "text";
        input.value = editingDim.value;
        const isW = editingDim.axis === "w";
        input.style.cssText = `position:absolute;width:72px;height:20px;font-size:11px;font-family:monospace;border:1px solid #f97316;border-radius:3px;outline:none;background:#fff;color:#333;padding:0 4px;pointer-events:auto;z-index:100;text-align:${isW ? "center" : "left"};left:${isW ? rx + rw / 2 - 36 : rx + rw + 6}px;top:${isW ? ry - 24 : ry + rh / 2 - 10}px;`;

        input.addEventListener("keydown", (ev) => {
            if (ev.key === "Enter") commitDimRef.current(input.value);
            if (ev.key === "Escape") setEditingDim(null);
        });
        input.addEventListener("blur", () => commitDimRef.current(input.value));
        input.addEventListener("mousedown", (ev) => ev.stopPropagation());

        layer.appendChild(input);
        input.focus();
        input.select();

        return () => { if (layer.contains(input)) layer.removeChild(input); };
    }, [editingDim?.polyId, editingDim?.axis]);

    // Enter / Escape while polyline drafting. Declared here (above the early
    // return) so the hook order is stable even when there's no active room.
    // wallPath モード (単独壁用ポリライン) も同じドラフトバッファを使う。
    useEffect(() => {
        if (roomEditMode !== "polyline" && roomEditMode !== "wallPath") return;
        const minPoints = roomEditMode === "polyline" ? 3 : 2;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Enter" && polyDraftPoints.length >= minPoints) {
                e.preventDefault();
                if (roomEditMode === "polyline") commitPolyDraftRef.current(polyDraftPoints);
                else commitWallPathDraftRef.current(polyDraftPoints);
            } else if (e.key === "Escape" && polyDraftPoints.length > 0) {
                e.preventDefault();
                // incremental 3D 壁 / open polyline live ドラフトも破棄する
                // (polyline / wallPath どちらのモードでも同じ ref を共有)。
                discardLiveWallPathDraftRef.current();
                setPolyDraftPoints([]);
                setMouseWorld(null);
                setGridSnapInfo(null);
            }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [roomEditMode, polyDraftPoints]);

    // Trim モードの Esc キャンセル: target 解除 / firstPoint クリア / Select に戻る。
    // ステージごとに段階キャンセル (= firstPoint 解除 → target 解除 → モード抜け)
    // にすると操作の取り消しが直感的になる。
    useEffect(() => {
        if (roomEditMode !== "trim") return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key !== "Escape") return;
            e.preventDefault();
            if (trimFirstPoint) {
                setTrimFirstPoint(null);
                setMouseWorld(null);
                setGridSnapInfo(null);
                return;
            }
            if (trimTargetEntityId) {
                setTrimTargetEntityId(null);
                setMouseWorld(null);
                setGridSnapInfo(null);
                return;
            }
            setRoomEditMode("select");
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [roomEditMode, trimFirstPoint, trimTargetEntityId, setRoomEditMode]);

    // Reset drafts when leaving polyline / wallPath / circle / line / arc / trim mode
    useEffect(() => {
        if (roomEditMode !== "polyline" && roomEditMode !== "wallPath" && polyDraftPoints.length > 0) {
            setPolyDraftPoints([]);
            // モード離脱時の auto-finalize:
            // incremental commit で作った entity は「実体」として残す
            // (= 削除しない)。ドラフトの ref / snaps state だけクリアして、
            // entity と polygon と 3D 壁はそのまま保持。
            // これがないと「クリックで描画した WallPath が、Room モードを
            // 離れた瞬間に消える」現象になる。
            wallPathDraftRef.current = null;
            wallPathDraftSnapsRef.current = [];
        }
        if (roomEditMode !== "circle" && (circleCenter || circleLiveDraftRef.current)) {
            // Circle も同じ: live entity は実体として残し、ref state だけクリア。
            circleLiveDraftRef.current = null;
            setCircleCenter(null);
        }
        if (roomEditMode !== "line" && lineStart) setLineStart(null);
        if (roomEditMode !== "arc" && (arcChordP0 || arcChordP1)) {
            setArcChordP0(null); setArcChordP1(null);
        }
        if (roomEditMode !== "arcEdge" && arcEdgeChord) {
            setArcEdgeChord(null);
            setMouseWorld(null);
        }
        if (roomEditMode !== "trim" && (trimTargetEntityId || trimFirstPoint)) {
            setTrimTargetEntityId(null); setTrimFirstPoint(null);
        }
        if (roomEditMode !== "wallSkip" && wallSkipDraft) {
            setWallSkipDraft(null);
        }
    }, [roomEditMode]);

    // ─── Conditional early return (after all hooks) ───

    const camera = viewportRef.current?.getCamera() ?? null;
    if ((!activeRoomId && !pendingRoomLevelId) || !camera) return null;

    // pending 中は実体 Space が無いので、表示・ヒットテスト用の空 Space を渡す。
    // 最初の図形 commit (pickShapeTargetRoom) で本物の Space が生成される。
    const PHANTOM_ROOM: SpaceElement = {
        id: "__pending_room__" as ElementId,
        type: "Space",
        name: "",
        visible: true,
        locked: false,
        transform: mat4.create(),
        dirtyFlags: new Set(),
        shape: null,
        boundary: [],
        polygons: [],
        entities: [],
        area: 0,
        height: 3.0,
        levelId: pendingRoomLevelId ?? undefined,
    };
    const room: SpaceElement = activeRoomId
        ? ((elements[activeRoomId] as SpaceElement | undefined) ?? PHANTOM_ROOM)
        : PHANTOM_ROOM;
    if (room.type !== "Space") return null;

    // ─── Helpers ───
    const getCanvasRect = () => canvasRef.current?.getBoundingClientRect() ?? null;
    const project = (wx: number, wz: number): [number, number] => {
        const r = getCanvasRect();
        if (!r) return [0, 0];
        return worldToScreen(wx, wz, camera.viewProjectionMatrix as mat4, r.width, r.height);
    };
    const unproject = (cx: number, cy: number): [number, number] | null => {
        const r = getCanvasRect();
        if (!r) return null;
        return screenToWorld(cx - r.left, cy - r.top, camera, r.width, r.height);
    };
    // Snap a 2D (XZ) world point against the visible grids. Priority:
    // grid object snap (intersection/endpoint/line) > axis alignment through
    // grid endpoints. Returns the snapped point and snap info for display,
    // or the original point when no snap is within tolerance.
    const applyGridSnap = (xy: [number, number]): {
        p: [number, number];
        info: typeof gridSnapInfo;
    } => {
        // Origin + grid intersections via BVH (highest priority)
        const bvhHit = snapBVHRef.current.nearestWithin(xy[0], xy[1], DEFAULT_GRID_SNAP_TOLERANCE);
        if (bvhHit) {
            const p: [number, number] = [bvhHit.x, bvhHit.z];
            return { p, info: { point: p, kind: "obj" } };
        }
        // Residential grid step snap (910mm primary / 455mm secondary). The
        // secondary step covers both — every 910mm intersection is also a
        // 455mm one. Skipped in freeZoning mode.
        if (designModeRef.current === "jpResidentialGrid") {
            const step = RESIDENTIAL_GRID_SECONDARY_M;
            const sx = Math.round(xy[0] / step) * step;
            const sz = Math.round(xy[1] / step) * step;
            if (Math.hypot(xy[0] - sx, xy[1] - sz) <= DEFAULT_GRID_SNAP_TOLERANCE) {
                const p: [number, number] = [sx, sz];
                return { p, info: { point: p, kind: "obj" } };
            }
        }
        const gs = gridsRef.current;
        if (!gs || gs.length === 0) return { p: xy, info: null };
        const cursor: Vec3 = [xy[0], 0, xy[1]];
        // Intersections already covered by the BVH — skip the O(N²) scan.
        const obj = snapToGrids(cursor, gs, DEFAULT_GRID_SNAP_TOLERANCE, { skipIntersections: true });
        if (obj) {
            const p: [number, number] = [obj.point[0], obj.point[2]];
            return { p, info: { point: p, kind: "obj" } };
        }
        const refPoints: Vec3[] = [];
        for (const g of gs) {
            if (!g.visible) continue;
            for (const v of gridVertices(g.curve)) refPoints.push(v);
        }
        const axis = snapAxisAlign(cursor, refPoints);
        if (axis) {
            const p: [number, number] = [axis.point[0], axis.point[2]];
            return {
                p,
                info: {
                    point: p,
                    kind: "axis",
                    refH: axis.refPointH ? [axis.refPointH[0], axis.refPointH[2]] : undefined,
                    refV: axis.refPointV ? [axis.refPointV[0], axis.refPointV[2]] : undefined,
                },
            };
        }
        return { p: xy, info: null };
    };
    /**
     * 描画モード共通の snap ラッパ。`applyGridSnap` の通芯系スナップに加え、
     * 既存形状 (= 部屋ポリゴンの頂点・辺、Line/Polyline/Arc/Circle entity の
     * 端点・中心・曲線上投影、既存壁の端点) へのスナップを最優先で行う。
     *
     * 部屋モードで figure を新規描画する際 (rectangle / polyline / circle /
     * line / arc / arcEdge / trim) のクリック位置に適用する。ドラッグ操作には
     * 使わない (= 自分自身の頂点に吸着して動けなくなるため)。
     */
    const applyDrawSnap = (xy: [number, number]): {
        p: [number, number];
        info: typeof gridSnapInfo;
    } => {
        const tol = DEFAULT_GRID_SNAP_TOLERANCE;
        const cursor: Vec3 = [xy[0], 0, xy[1]];
        // 編集中レベル: active room の levelId、無ければ pending 状態のレベル。
        // currentLevelId を渡すと unifiedSnap が「他階壁の axis」もスナップ対象に
        // 含めるので、参照線として描画している他階壁の上にもクリックで吸着する。
        const editingLvl: string | undefined = (() => {
            const els2 = elementsRef.current;
            const rid2 = activeRoomIdRef.current;
            const real2 = rid2 ? els2[rid2] : undefined;
            const lvl = real2 && real2.type === "Space"
                ? (real2 as SpaceElement).levelId
                : pendingRoomLevelIdRef.current;
            return (lvl as string | undefined) ?? undefined;
        })();
        const snap = unifiedSnap(cursor, elements, gridsRef.current, {
            tolerance: tol,
            // 部屋モードの 2D 作図では Column / Beam / WallAxis のスナップは
            // 不要。Wall endpoint / Room polygon / Sketch entity / Grid /
            // Axis は引き続き有効。
            enableElementSnaps: false,
            snapBVH: snapBVHRef.current,
            // 他階壁の axis (= 参照線) には吸着可能にする。同階壁は polygon
            // edge スナップと被るので除外される (= UnifiedSnap 側で制御)。
            currentLevelId: editingLvl,
        });
        if (snap.kind) {
            const p: [number, number] = [snap.point[0], snap.point[2]];
            if (snap.kind === "Axis") {
                return {
                    p,
                    info: {
                        point: p,
                        kind: "axis",
                        refH: snap.axisRefH ? [snap.axisRefH[0], snap.axisRefH[2]] : undefined,
                        refV: snap.axisRefV ? [snap.axisRefV[0], snap.axisRefV[2]] : undefined,
                    },
                };
            }
            return { p, info: { point: p, kind: "obj" } };
        }
        // unifiedSnap が空振りした時の住居系 grid step フォールバック
        // (applyGridSnap と同じ振る舞い)。
        if (designModeRef.current === "jpResidentialGrid") {
            const step = RESIDENTIAL_GRID_SECONDARY_M;
            const sx = Math.round(xy[0] / step) * step;
            const sz = Math.round(xy[1] / step) * step;
            if (Math.hypot(xy[0] - sx, xy[1] - sz) <= tol) {
                const p: [number, number] = [sx, sz];
                return { p, info: { point: p, kind: "obj" } };
            }
        }
        return { p: xy, info: null };
    };
    /**
     * WallPath モード専用の snap ラッパ。`applyGridSnap` の上に「壁スケッチ線
     * へのスナップ」(= 既存ポリゴン外周の頂点・辺) を被せる。
     *  優先度: 既存壁の頂点 > 通芯交点 / 原点 > 既存壁の辺 (垂直投影) >
     *          通芯軸整列 (= applyGridSnap の axis fallback)
     *
     * 戻り値の `target` は壁の頂点 / 辺にスナップ確定した時に作図側へ
     * 渡す接合ヒント。`commitWallPathDraft` でこれを polygon の `joints[]`
     * に積めば、`regen` / `JunctionGraph` 側は幾何検出に頼らず確定的な
     * T 字接合 split が出来るようになる。
     */
    type WallPathSnapTarget =
        | { kind: "polyVertex"; spaceId: string; polyId: string; targetVertexIdx: number }
        | { kind: "polyEdge"; spaceId: string; polyId: string; targetEdgeIdx: number; t: number };
    const applyWallPathSnap = (
        xy: [number, number],
        opts: { excludePolyId?: string } = {},
    ): {
        p: [number, number];
        info: typeof gridSnapInfo;
        target?: WallPathSnapTarget;
    } => {
        const tol = DEFAULT_GRID_SNAP_TOLERANCE;
        const excludeId = opts.excludePolyId;
        // 1. Vertex snap (existing wall corners).
        let bestV: {
            p: [number, number];
            d: number;
            spaceId: string;
            polyId: string;
            vertexIdx: number;
        } | null = null;
        for (const eid in elements) {
            const el = elements[eid];
            if (!el || el.type !== "Space") continue;
            const sp = el as SpaceElement;
            for (const poly of sp.polygons ?? []) {
                if (poly.wallOutlineOf) continue;
                if (excludeId && poly.id === excludeId) continue;
                for (let vi = 0; vi < poly.outer.length; vi++) {
                    const v = poly.outer[vi];
                    const d = Math.hypot(xy[0] - v[0], xy[1] - v[1]);
                    if (d < tol && (!bestV || d < bestV.d)) {
                        bestV = {
                            p: [v[0], v[1]], d,
                            spaceId: eid, polyId: poly.id, vertexIdx: vi,
                        };
                    }
                }
            }
        }
        if (bestV) {
            return {
                p: bestV.p,
                info: { point: bestV.p, kind: "vertex" },
                target: {
                    kind: "polyVertex",
                    spaceId: bestV.spaceId,
                    polyId: bestV.polyId,
                    targetVertexIdx: bestV.vertexIdx,
                },
            };
        }
        // 2. Grid intersection / origin (existing applyGridSnap の高優先パス)。
        const grid = applyGridSnap(xy);
        if (grid.info && grid.info.kind === "obj") return grid;
        // 3. Edge perpendicular projection (= 壁スケッチ線への垂直スナップ)。
        let bestE: {
            p: [number, number];
            d: number;
            t: number;
            spaceId: string;
            polyId: string;
            edgeIdx: number;
        } | null = null;
        for (const eid in elements) {
            const el = elements[eid];
            if (!el || el.type !== "Space") continue;
            const sp = el as SpaceElement;
            for (const poly of sp.polygons ?? []) {
                if (poly.wallOutlineOf) continue;
                if (excludeId && poly.id === excludeId) continue;
                const edges = polygonEdges(poly);
                for (let ei = 0; ei < edges.length; ei++) {
                    const [a, b] = edges[ei];
                    const p1 = poly.outer[a];
                    const p2 = poly.outer[b];
                    const dx = p2[0] - p1[0];
                    const dy = p2[1] - p1[1];
                    const lenSq = dx * dx + dy * dy;
                    if (lenSq < 1e-12) continue;
                    let t = ((xy[0] - p1[0]) * dx + (xy[1] - p1[1]) * dy) / lenSq;
                    t = Math.max(0, Math.min(1, t));
                    const px = p1[0] + dx * t;
                    const py = p1[1] + dy * t;
                    const d = Math.hypot(xy[0] - px, xy[1] - py);
                    if (d < tol && (!bestE || d < bestE.d)) {
                        bestE = {
                            p: [px, py], d, t,
                            spaceId: eid, polyId: poly.id, edgeIdx: ei,
                        };
                    }
                }
            }
        }
        if (bestE) {
            return {
                p: bestE.p,
                info: { point: bestE.p, kind: "edge" },
                target: {
                    kind: "polyEdge",
                    spaceId: bestE.spaceId,
                    polyId: bestE.polyId,
                    targetEdgeIdx: bestE.edgeIdx,
                    t: bestE.t,
                },
            };
        }
        // 4. Polar angle snap (45° 刻み) — 最後の確定点が基準。
        //    grid や vertex よりは低優先だが、フリー描画時に角度を拘束できる。
        const draftPts = polyDraftPointsRef.current;
        if (draftPts.length > 0) {
            const last = draftPts[draftPts.length - 1];
            const dx = xy[0] - last[0];
            const dz = xy[1] - last[1];
            const dist = Math.hypot(dx, dz);
            if (dist > 0.05) {
                const POLAR_STEP = Math.PI / 4;
                const POLAR_TOL  = 10 * Math.PI / 180;
                const raw = Math.atan2(dz, dx);
                const nearest = Math.round(raw / POLAR_STEP);
                const snapped = nearest * POLAR_STEP;
                let diff = raw - snapped;
                while (diff >  Math.PI) diff -= Math.PI * 2;
                while (diff < -Math.PI) diff += Math.PI * 2;
                if (Math.abs(diff) < POLAR_TOL) {
                    const sp: [number, number] = [
                        last[0] + dist * Math.cos(snapped),
                        last[1] + dist * Math.sin(snapped),
                    ];
                    return { p: sp, info: { point: sp, kind: "axis" as const } };
                }
            }
        }

        // 5. Fallback: grid axis 整列 or 何も無し。
        return grid;
    };

    const hitTestPoly = (wx: number, wz: number): string | null => {
        if (!room.polygons) return null;
        // Prefer the non-outline (inner) polygon on interior clicks. Wall
        // outline polygons still participate in vertex/edge hit-testing.
        // Open boundaries have no well-defined interior — skip for click-pick.
        for (let i = room.polygons.length - 1; i >= 0; i--) {
            const p = room.polygons[i];
            if (p.wallOutlineOf) continue;
            if (!isPolygonClosed(p)) continue;
            if (pointInRoomPolygon(wx, wz, p.outer, p.holes ?? [])) return p.id;
        }
        return null;
    };

    /**
     * 全 Space を横断して、点 (wx, wz) を内包する polygon を返す。複数候補が
     * あるときは Space の `createdAt` が最大 (= 後から追加した Room) を優先し、
     * 「重なり領域では上に乗せた矩形が勝つ」というレイヤ原則に揃える。
     * 編集中レベル (= activeRoom or pendingRoomLevel) の Space のみを対象とし、
     * 他階の参照線は除外する。ホバーハイライトのターゲット検出に使う。
     */
    const hitTestPolyAcrossSpaces = (wx: number, wz: number): { spaceId: string; polyId: string } | null => {
        const editingLvl: ElementId | null =
            (activeRoomId
                ? ((elements[activeRoomId] as SpaceElement | undefined)?.levelId as ElementId | undefined)
                : (pendingRoomLevelId as ElementId | null | undefined))
            ?? null;
        let bestSpaceId: string | null = null;
        let bestPolyId: string | null = null;
        let bestCreatedAt = -Infinity;
        for (const sid in elements) {
            const el = elements[sid];
            if (!el || el.type !== "Space") continue;
            const sp = el as SpaceElement;
            if (!sp.polygons) continue;
            if (editingLvl !== null && sp.levelId && sp.levelId !== editingLvl) continue;
            let candidate: string | null = null;
            for (let i = sp.polygons.length - 1; i >= 0; i--) {
                const p = sp.polygons[i];
                if (p.wallOutlineOf) continue;
                if (!isPolygonClosed(p)) continue;
                if (pointInRoomPolygon(wx, wz, p.outer, p.holes ?? [])) {
                    candidate = p.id;
                    break;
                }
            }
            if (!candidate) continue;
            const c = sp.createdAt ?? -Infinity;
            if (c >= bestCreatedAt) {
                bestCreatedAt = c;
                bestSpaceId = sid;
                bestPolyId = candidate;
            }
        }
        if (!bestSpaceId || !bestPolyId) return null;
        return { spaceId: bestSpaceId, polyId: bestPolyId };
    };
    /**
     * 弧 / 円 entity に **完全に内包される** tessellation 頂点 (= chord の
     * 両側 incident edge が同一 arc/circle owner) かを判定。これに該当する
     * 頂点は、ドラッグハンドルも提示せずヒットテストでもスキップする。
     *
     * ユーザが弧の途中の点を引っ張ると弧が分割され、添付画像のような
     * ジグザグ形状になってしまうため、弧の形状を保つには interior 点の
     * ドラッグ自体を不可にする必要がある。`edgeOwners` ベースの判定は
     * `isArcVertex` の角度ヒューリスティック (15°閾値) より堅牢で、弧の
     * 端点 (= polyline と接続するつなぎ目) は polyline / line owner と隣接
     * するので false を返し、依然としてドラッグ可能となる。
     */
    const isCurveInteriorVertex = (poly: RoomPolygon, vIdx: number): boolean => {
        if (!poly.edgeOwners) return false;
        const polyEdgeList = polygonEdges(poly);
        let owner: string | undefined;
        let count = 0;
        for (let ei = 0; ei < polyEdgeList.length; ei++) {
            const [va, vb] = polyEdgeList[ei];
            if (va !== vIdx && vb !== vIdx) continue;
            const o = poly.edgeOwners[ei];
            if (!o) return false;
            if (owner === undefined) owner = o;
            else if (owner !== o) return false;
            count++;
        }
        if (count < 2 || !owner) return false; // 端点 (open chain の先頭/末尾) は除外
        const ent = (room.entities ?? []).find((e) => e.id === owner);
        if (!ent) return false;
        return ent.kind === "arc" || ent.kind === "circle";
    };

    const hitTestPolyVertex = (sx: number, sy: number): HoveredPolyVertex | null => {
        if (!room.polygons) return null;
        let best: HoveredPolyVertex | null = null, bestD = VERTEX_SCREEN_RADIUS;
        for (const p of room.polygons) {
            if (p.shape?.type === "circle") continue; // no vertex picking on circles
            for (let i = 0; i < p.outer.length; i++) {
                if (isCurveInteriorVertex(p, i)) continue; // 弧/円の途中点はドラッグ不可
                // edgeOwners が無い旧データのみ角度ヒューリスティックを併用。
                // 新データは `isCurveInteriorVertex` のみで弧/円判定が完結するので、
                // 切断点 (= 直線上に挿入された実頂点) を誤って弾かない。
                if (!p.edgeOwners && isArcVertex(p.outer, i)) continue;
                // 180° collinear な split 頂点 (= wallRegen が junction split で
                // 挿入したもの、entity に対応点なし) はドラッグ不可。これを返すと
                // entity 駆動 drag が「対応点なし」で何もしないため。
                // ※ turnAngleAt は 0..π。0 ≒ collinear (180° 連続)。
                if (turnAngleAt(p.outer, i) < ARC_VERTEX_ANGLE_THRESHOLD) continue;
                const [wx, wz] = p.outer[i];
                const [px, py] = project(wx, wz);
                const d = Math.hypot(sx - px, sy - py);
                if (d < bestD) { bestD = d; best = { polyId: p.id, vertexIdx: i, wx, wz }; }
            }
        }
        return best;
    };
    const EDGE_SCREEN_TOLERANCE = 6;
    const hitTestEdge = (sx: number, sy: number): HoveredEdge | null => {
        if (!room.polygons) return null;
        let best: HoveredEdge | null = null, bestD = EDGE_SCREEN_TOLERANCE;
        for (const poly of room.polygons) {
            if (poly.shape?.type === "circle") continue; // no edge picking on circles
            const edges = polygonEdges(poly);
            for (let i = 0; i < edges.length; i++) {
                const [ai, bi] = edges[i];
                const [ax, az] = poly.outer[ai];
                const [bx, bz] = poly.outer[bi];
                const [px0, py0] = project(ax, az);
                const [px1, py1] = project(bx, bz);
                const dx = px1 - px0, dy = py1 - py0;
                const lenSq = dx * dx + dy * dy;
                const t = lenSq > 0
                    ? Math.max(0, Math.min(1, ((sx - px0) * dx + (sy - py0) * dy) / lenSq))
                    : 0;
                const qx = px0 + dx * t, qy = py0 + dy * t;
                const d = Math.hypot(sx - qx, sy - qy);
                if (d < bestD) {
                    bestD = d;
                    best = {
                        polyId: poly.id, edgeIdx: i,
                        midWx: (ax + bx) / 2, midWz: (az + bz) / 2,
                    };
                }
            }
        }
        return best;
    };
    /**
     * Cross-space 版のヒットテスト。非アクティブ Room のエッジ・頂点も拾える
     * よう全 Space の polygon を走査する。アクティブ Room の polygon ヒットも
     * 当然候補に入る。レベルガード: 編集中レベル以外の部屋は対象外
     * (= 参照線として描画している他階壁を誤クリックしない)。
     * 同一スクリーン位置に複数候補がある場合は `createdAt` が新しい Space を
     * 優先する (= 重ねた時に「上に乗せた方」が確実に拾える)。
     */
    const hitTestEdgeAcrossSpaces = (
        sx: number, sy: number,
    ): { spaceId: string; polyId: string; edgeIdx: number; midWx: number; midWz: number } | null => {
        const editingLvl: string | undefined = (() => {
            const lvl = activeRoomId
                ? (elements[activeRoomId] as SpaceElement | undefined)?.levelId
                : pendingRoomLevelId;
            return (lvl as string | undefined) ?? undefined;
        })();
        let best: { spaceId: string; polyId: string; edgeIdx: number; midWx: number; midWz: number; createdAt: number } | null = null;
        let bestD = EDGE_SCREEN_TOLERANCE;
        for (const eid in elements) {
            const el = elements[eid];
            if (!el || el.type !== "Space") continue;
            const sp = el as SpaceElement;
            if (editingLvl !== undefined && sp.levelId && sp.levelId !== editingLvl) continue;
            const createdAt = sp.createdAt ?? -Infinity;
            for (const poly of sp.polygons ?? []) {
                if (poly.shape?.type === "circle") continue;
                if (poly.wallOutlineOf) continue;
                const edges = polygonEdges(poly);
                for (let i = 0; i < edges.length; i++) {
                    const [ai, bi] = edges[i];
                    const [ax, az] = poly.outer[ai];
                    const [bx, bz] = poly.outer[bi];
                    const [px0, py0] = project(ax, az);
                    const [px1, py1] = project(bx, bz);
                    const dx = px1 - px0, dy = py1 - py0;
                    const lenSq = dx * dx + dy * dy;
                    const t = lenSq > 0
                        ? Math.max(0, Math.min(1, ((sx - px0) * dx + (sy - py0) * dy) / lenSq))
                        : 0;
                    const qx = px0 + dx * t, qy = py0 + dy * t;
                    const d = Math.hypot(sx - qx, sy - qy);
                    if (d < bestD || (d <= bestD + 0.5 && best && createdAt > best.createdAt)) {
                        bestD = d;
                        best = {
                            spaceId: eid, polyId: poly.id, edgeIdx: i,
                            midWx: (ax + bx) / 2, midWz: (az + bz) / 2,
                            createdAt,
                        };
                    }
                }
            }
        }
        if (!best) return null;
        const { createdAt: _ca, ...out } = best;
        void _ca;
        return out;
    };
    const hitTestPolyVertexAcrossSpaces = (
        sx: number, sy: number,
    ): { spaceId: string; polyId: string; vertexIdx: number; wx: number; wz: number } | null => {
        const editingLvl: string | undefined = (() => {
            const lvl = activeRoomId
                ? (elements[activeRoomId] as SpaceElement | undefined)?.levelId
                : pendingRoomLevelId;
            return (lvl as string | undefined) ?? undefined;
        })();
        let best: { spaceId: string; polyId: string; vertexIdx: number; wx: number; wz: number; createdAt: number } | null = null;
        let bestD = VERTEX_SCREEN_RADIUS;
        for (const eid in elements) {
            const el = elements[eid];
            if (!el || el.type !== "Space") continue;
            const sp = el as SpaceElement;
            if (editingLvl !== undefined && sp.levelId && sp.levelId !== editingLvl) continue;
            const createdAt = sp.createdAt ?? -Infinity;
            for (const poly of sp.polygons ?? []) {
                if (poly.shape?.type === "circle") continue;
                if (poly.wallOutlineOf) continue;
                for (let i = 0; i < poly.outer.length; i++) {
                    if (isCurveInteriorVertex(poly, i)) continue;
                    if (!poly.edgeOwners && isArcVertex(poly.outer, i)) continue;
                    if (turnAngleAt(poly.outer, i) < ARC_VERTEX_ANGLE_THRESHOLD) continue;
                    const [wx, wz] = poly.outer[i];
                    const [px, py] = project(wx, wz);
                    const d = Math.hypot(sx - px, sy - py);
                    if (d < bestD || (d <= bestD + 0.5 && best && createdAt > best.createdAt)) {
                        bestD = d;
                        best = { spaceId: eid, polyId: poly.id, vertexIdx: i, wx, wz, createdAt };
                    }
                }
            }
        }
        if (!best) return null;
        const { createdAt: _ca, ...out } = best;
        void _ca;
        return out;
    };

    /**
     * 選択中の弧 / 円エンティティのハンドルクリック判定 (FreeCAD 流)。
     *  - arcCenter:    弧中心 diamond
     *  - arcEndpoint:  弧の start / end 四角
     *  - circleCenter: 円中心 diamond
     *
     * 選択中エンティティ (= sketchSelection に kind: "entity" / "circle" として
     * 含まれるもの) のみ対象。Vertex / Edge ヒットより優先する。
     */
    type EntityHandleHit =
        | { kind: "arcCenter"; entityId: string; polyId: string }
        | { kind: "arcEndpoint"; entityId: string; polyId: string; which: "start" | "end" }
        | { kind: "circleCenter"; entityId: string; polyId: string };
    const HANDLE_SCREEN_RADIUS = 10;
    const hitTestEntityHandle = (sx: number, sy: number): EntityHandleHit | null => {
        if (!room.entities || room.entities.length === 0) return null;
        // 選択中の弧 / 円 entity ID 集合 (entity 直接 + circle 経由の polyIdByEntity 逆引き)
        const sel = sketchSelectionRef.current;
        const selEntityIds = new Set<string>();
        for (const s of sel) {
            if (s.kind === "entity") selEntityIds.add(s.entityId);
        }
        const map = room.polyIdByEntity ?? {};
        for (const s of sel) {
            if (s.kind === "circle") {
                for (const eid in map) if (map[eid] === s.polyId) selEntityIds.add(eid);
            }
        }
        let best: EntityHandleHit | null = null;
        let bestD = HANDLE_SCREEN_RADIUS;
        for (const ent of room.entities) {
            if (!selEntityIds.has(ent.id)) continue;
            const polyId = map[ent.id];
            if (!polyId) continue;
            if (ent.kind === "arc") {
                const [cpx, cpy] = project(ent.center[0], ent.center[1]);
                const dC = Math.hypot(sx - cpx, sy - cpy);
                if (dC < bestD) {
                    bestD = dC;
                    best = { kind: "arcCenter", entityId: ent.id, polyId };
                }
                const sxw = ent.center[0] + ent.radius * Math.cos(ent.aStart);
                const syw = ent.center[1] + ent.radius * Math.sin(ent.aStart);
                const [spx, spy] = project(sxw, syw);
                const dS = Math.hypot(sx - spx, sy - spy);
                if (dS < bestD) {
                    bestD = dS;
                    best = { kind: "arcEndpoint", entityId: ent.id, polyId, which: "start" };
                }
                const exw = ent.center[0] + ent.radius * Math.cos(ent.aEnd);
                const eyw = ent.center[1] + ent.radius * Math.sin(ent.aEnd);
                const [epx, epy] = project(exw, eyw);
                const dE = Math.hypot(sx - epx, sy - epy);
                if (dE < bestD) {
                    bestD = dE;
                    best = { kind: "arcEndpoint", entityId: ent.id, polyId, which: "end" };
                }
            } else if (ent.kind === "circle") {
                const [cpx, cpy] = project(ent.center[0], ent.center[1]);
                const dC = Math.hypot(sx - cpx, sy - cpy);
                if (dC < bestD) {
                    bestD = dC;
                    best = { kind: "circleCenter", entityId: ent.id, polyId };
                }
            }
        }
        return best;
    };

    /**
     * 円ポリゴン (`shape: circle`) の周上クリック判定。
     *  - 円は `hitTestEdge` で除外しているため、専用ヒットテストで「outline を
     *    クリックしたら円全体を `kind: "circle"` で選択」できるようにする。
     *  - 円心からの距離を半径と比較し、screen 距離 (= radial diff × pxPerM) が
     *    `EDGE_SCREEN_TOLERANCE` 以内なら hit。
     */
    const hitTestCircleOutline = (sx: number, sy: number): { polyId: string } | null => {
        if (!room.polygons) return null;
        let best: { polyId: string } | null = null;
        let bestD = EDGE_SCREEN_TOLERANCE;
        for (const poly of room.polygons) {
            if (poly.shape?.type !== "circle") continue;
            const c = poly.shape.center;
            const r = poly.shape.radius;
            const [cx, cy] = project(c[0], c[1]);
            const [ex, ey] = project(c[0] + r, c[1]);
            const pxR = Math.hypot(ex - cx, ey - cy);
            if (pxR < 1e-6) continue;
            const dxs = sx - cx;
            const dys = sy - cy;
            const ds = Math.hypot(dxs, dys);
            const d = Math.abs(ds - pxR);
            if (d < bestD) { bestD = d; best = { polyId: poly.id }; }
        }
        return best;
    };

    /**
     * 通芯 (Grid) のヒットテスト — 部屋モード select で通芯端点 / 通芯線を
     * 拘束選択候補に拾うため。
     *  - gridPoint: 通芯線の端点 / Polyline 各頂点 (VERTEX_SCREEN_RADIUS)
     *  - gridLine:  通芯線本体 (EDGE_SCREEN_TOLERANCE)
     * 端点優先 (= 端点ヒット時は線ヒットを返さない) で、Viewport の通常モード
     * と同じ振る舞いを室モードでも再現する。
     */
    const hitTestGrid = (sx: number, sy: number):
        | { kind: "gridPoint"; gridId: string; vertexIdx: number }
        | { kind: "gridLine"; gridId: string }
        | null => {
        let bestPt: { kind: "gridPoint"; gridId: string; vertexIdx: number } | null = null;
        let bestPtD = VERTEX_SCREEN_RADIUS;
        for (const g of grids) {
            if (!g.visible) continue;
            const verts = gridVertices(g.curve);
            for (let i = 0; i < verts.length; i++) {
                const v = verts[i];
                const [px, py] = project(v[0], v[2]);
                const d = Math.hypot(sx - px, sy - py);
                if (d < bestPtD) { bestPtD = d; bestPt = { kind: "gridPoint", gridId: g.id, vertexIdx: i }; }
            }
        }
        if (bestPt) return bestPt;
        let bestLine: { kind: "gridLine"; gridId: string } | null = null;
        let bestLineD = EDGE_SCREEN_TOLERANCE;
        for (const g of grids) {
            if (!g.visible) continue;
            const verts = gridVertices(g.curve);
            for (let i = 0; i < verts.length - 1; i++) {
                const a = verts[i];
                const b = verts[i + 1];
                const [ax, ay] = project(a[0], a[2]);
                const [bx, by] = project(b[0], b[2]);
                const dx = bx - ax, dy = by - ay;
                const lenSq = dx * dx + dy * dy;
                if (lenSq < 1e-9) continue;
                const t = Math.max(0, Math.min(1, ((sx - ax) * dx + (sy - ay) * dy) / lenSq));
                const qx = ax + dx * t, qy = ay + dy * t;
                const d = Math.hypot(sx - qx, sy - qy);
                if (d < bestLineD) { bestLineD = d; bestLine = { kind: "gridLine", gridId: g.id }; }
            }
        }
        return bestLine;
    };

    /** Update polygons on the room AND sync linked walls + wall-outline polys.
     *  Outline polygons are always re-derived from their inner so dragging
     *  the outer outline cannot break the thickness-offset invariant; inner
     *  drags also propagate through this path. Works for any vertex count.
     *
     *  **Entity sync** — for any polygon whose outer changed, the corresponding
     *  entity (polyline / line) point coordinates are also updated. Without
     *  this, `polygon.outer` and `entity.points` drift apart on vertex drag,
     *  and any subsequent `setSpaceEntities` re-derive (via solver writeback or
     *  user edit) snaps polygon back to the stale entity points — which
     *  breaks the connection to neighbouring entities (e.g., arc chord
     *  endpoint stops matching polyline endpoint, leaving a visible gap).
     */
    const updatePolysAndSync = (newPolys: RoomPolygon[]) => {
        // pending 中 (実体 Space 無し) は polygons 編集が発生しない。安全側で無視。
        if (!activeRoomId) return;

        // ── 形状崩壊ガード ─────────────────────────────────────
        // 以前は正常サイズだった polygon が今回の更新で 1mm 未満まで潰れたら、
        // この更新フレーム自体を棄却。drag・拘束ソルバ・cross-room 切替後の
        // 中間状態など、どこかのパスで bbox 一辺が 0 に近づいた瞬間に Room が
        // 線状にロックされるのを防ぐ。棄却されても次フレームの正常な入力で
        // 更新が反映されるので連続ドラッグは止まらない。`setSpaceEntities` 側に
        // も同等のガードがあるが、こちらは entity を経由しない直接 polygon 書き
        // 戻し経路 (wallOutline / Coincident propagation / 寸法ラベル編集など) を
        // カバーする。
        {
            const MIN_DIM = 0.001;
            const bbox = (ring: Vec2[]): [number, number] => {
                let mnX = Infinity, mxX = -Infinity, mnY = Infinity, mxY = -Infinity;
                for (const [x, y] of ring) {
                    if (x < mnX) mnX = x; if (x > mxX) mxX = x;
                    if (y < mnY) mnY = y; if (y > mxY) mxY = y;
                }
                return [mxX - mnX, mxY - mnY];
            };
            for (const np of newPolys) {
                if (np.wallOutlineOf) continue;
                if (!np.outer || np.outer.length < 3) continue;
                const [nw, nh] = bbox(np.outer);
                if (nw >= MIN_DIM && nh >= MIN_DIM) continue;
                const prev = room.polygons?.find((p) => p.id === np.id);
                if (!prev || !prev.outer || prev.outer.length < 3) continue;
                const [pw, ph] = bbox(prev.outer);
                if (pw >= MIN_DIM && ph >= MIN_DIM) {
                    // eslint-disable-next-line no-console
                    console.warn(
                        `[updatePolysAndSync] rejected degenerate polygon ${np.id}: `
                        + `${pw.toFixed(3)}x${ph.toFixed(3)} → ${nw.toFixed(3)}x${nh.toFixed(3)}`,
                    );
                    return;
                }
            }
        }
        // ─────────────────────────────────────────────────────

        const synced = newPolys.map((p) => {
            if (!p.wallOutlineOf) return p;
            const inner = newPolys.find((q) => q.id === p.wallOutlineOf);
            if (!inner || inner.wallThickness == null || inner.outer.length < 3) return p;
            let cx = 0, cy = 0;
            for (const v of inner.outer) { cx += v[0]; cy += v[1]; }
            cx /= inner.outer.length; cy /= inner.outer.length;
            const derived = computeMiteredCorners(inner.outer, [cx, cy], inner.wallThickness);
            return { ...p, outer: derived };
        });
        // Compute entity-point updates from the polygon outer differences.
        // Iterate per (poly, vertex) and use edgeOwners to find which entity
        // point this vertex corresponds to. Only non-arc-interior vertices
        // are propagated (arc tessellation interior is parametric — its
        // positions come from the arc entity, not entity points).
        // Circle polygons (`shape.type === "circle"`) sync `entity.center` /
        // `entity.radius` from `polygon.shape` so the circle entity follows
        // poly drag / radius edits and the rendered center marker stays put.
        const entityUpdates = new Map<string,
            | { kind: "polyline"; points: Vec2[] }
            | { kind: "line"; p0?: Vec2; p1?: Vec2 }
            | { kind: "circle"; center?: Vec2; radius?: number }
            | { kind: "arc"; cx: number; cy: number;
                radius?: number; aStart?: number; aEnd?: number }
        >();
        const ents = room.entities ?? [];
        const polyIdByEntity = room.polyIdByEntity ?? {};
        const ensurePolylinePatch = (pl: PolylineEntity) => {
            let p = entityUpdates.get(pl.id) as { kind: "polyline"; points: Vec2[] } | undefined;
            if (!p) {
                p = { kind: "polyline", points: pl.points.map((q) => [q[0], q[1]] as Vec2) };
                entityUpdates.set(pl.id, p);
            }
            return p;
        };
        const ensureLinePatch = (ln: LineEntity) => {
            let p = entityUpdates.get(ln.id) as { kind: "line"; p0?: Vec2; p1?: Vec2 } | undefined;
            if (!p) { p = { kind: "line" }; entityUpdates.set(ln.id, p); }
            return p;
        };
        // Arc 用パッチ: 端点が動いた arc の処理。
        //  ケース A) 両端点が同じ delta で動く (= polygon 全体平行移動):
        //           center を delta だけ平行移動。半径 / 角度は不変。
        //  ケース B) 片端だけ動く (= vertex drag で arc 端点を掴んだ):
        //           動いた端点 → cursor、反対端点 → 不動を満たす **新しい弧**
        //           を `arcFromChordAndCursor` で再構成。bulge は元の弧の中心
        //           側を継承するため、元 center 位置を bulgeSide として渡す。
        //           これをしないと「arc 全体が平行移動 → 反対端も動く →
        //           line 端点が剥がれる → 弦が消える」現象になる。
        type ArcPatch = { kind: "arc"; cx: number; cy: number;
            radius?: number; aStart?: number; aEnd?: number };
        const ensureArcPatch = (a: ArcEntity): ArcPatch => {
            let p = entityUpdates.get(a.id) as ArcPatch | undefined;
            if (!p) {
                p = { kind: "arc", cx: a.center[0], cy: a.center[1] };
                entityUpdates.set(a.id, p);
            }
            return p;
        };
        // 弧の reshape vs translate を正しく判定するため、先に「動いた頂点
        // 全部 + その新位置」を集める。同じ arc に対する 2 端点を同フレームで
        // 評価してから、case A (両端同 delta = translate) / case B (片端だけ
        // = reshape) を確定する。ループ中に都度 arc を平行移動する旧実装は
        // 「最後に処理した端点の delta だけが arc 全体に反映」されてしまい、
        // arc 端点ドラッグで反対端まで動いて弦が剥がれる原因だった。
        interface MovedVertex { newPos: Vec2; oldPos: Vec2 }
        const movedByPos: { newPos: Vec2; oldPos: Vec2 }[] = [];
        for (const newPoly of synced) {
            const oldPoly = room.polygons.find((p) => p.id === newPoly.id);
            if (!oldPoly) continue;
            // Circle polygon: sync center / radius from the polygon's parametric
            // shape back to the circle entity (= source of truth). Poly drag and
            // radius edits update `shape.center` / `shape.radius` directly; we
            // must mirror those into the entity so the rendered center marker
            // and subsequent re-derive don't snap back to stale entity values.
            if (newPoly.shape?.type === "circle") {
                let circleEntId: string | null = null;
                for (const eid in polyIdByEntity) {
                    if (polyIdByEntity[eid] === newPoly.id) { circleEntId = eid; break; }
                }
                const ent = circleEntId ? ents.find((x) => x.id === circleEntId) : undefined;
                if (ent && ent.kind === "circle") {
                    const dCenter = Math.hypot(
                        newPoly.shape.center[0] - ent.center[0],
                        newPoly.shape.center[1] - ent.center[1],
                    );
                    const dRadius = Math.abs(newPoly.shape.radius - ent.radius);
                    if (dCenter > 1e-9 || dRadius > 1e-9) {
                        entityUpdates.set(ent.id, {
                            kind: "circle",
                            center: [newPoly.shape.center[0], newPoly.shape.center[1]],
                            radius: newPoly.shape.radius,
                        });
                    }
                }
                continue;
            }
            if (newPoly.outer === oldPoly.outer) continue;
            if (newPoly.outer.length !== oldPoly.outer.length) continue;
            if (!newPoly.edgeOwners) continue;
            const polyEdgeList = polygonEdges(oldPoly);
            for (let vi = 0; vi < oldPoly.outer.length; vi++) {
                const oldPos = oldPoly.outer[vi];
                const newPos = newPoly.outer[vi];
                if (Math.hypot(newPos[0] - oldPos[0], newPos[1] - oldPos[1]) < 1e-9) continue;
                const incEdges: number[] = [];
                for (let ei = 0; ei < polyEdgeList.length; ei++) {
                    const [va, vb] = polyEdgeList[ei];
                    if (va === vi || vb === vi) incEdges.push(ei);
                }
                const incOwners = Array.from(new Set(
                    incEdges.map((ei) => newPoly.edgeOwners![ei]).filter(Boolean) as string[],
                ));
                // 弧/円 interior: 頂点が arc / circle entity 単独所有なら
                // テッセレーション中間点 (= パラメトリックに再生成される) なので
                // skip。両端点 (= line 系と接続される共有頂点) はこのブロック
                // ではなく後段の「arc owner なら center 平行移動」で扱う。
                if (incOwners.length === 1) {
                    const e = ents.find((x) => x.id === incOwners[0]);
                    if (e && (e.kind === "arc" || e.kind === "circle")) continue;
                }
                // この vertex が動いたことを記録 (= 後で arc 端点との位置一致を
                // 判定して、弧の translate / reshape を一括決定するため)。
                movedByPos.push({ newPos, oldPos });
                // Update each non-arc owner's point at this vertex.
                for (const ow of incOwners) {
                    const e = ents.find((x) => x.id === ow);
                    if (!e) continue;
                    if (e.kind === "polyline") {
                        // Find the polyline point matching oldPos.
                        let bestIdx = -1, bestD = 1e-3;
                        for (let i = 0; i < e.points.length; i++) {
                            const d = Math.hypot(e.points[i][0] - oldPos[0], e.points[i][1] - oldPos[1]);
                            if (d < bestD) { bestD = d; bestIdx = i; }
                        }
                        if (bestIdx >= 0) {
                            const p = ensurePolylinePatch(e);
                            p.points[bestIdx] = [newPos[0], newPos[1]];
                        }
                    } else if (e.kind === "line") {
                        const d0 = Math.hypot(e.p0[0] - oldPos[0], e.p0[1] - oldPos[1]);
                        const d1 = Math.hypot(e.p1[0] - oldPos[0], e.p1[1] - oldPos[1]);
                        if (d0 < 1e-3 && d0 <= d1) {
                            const p = ensureLinePatch(e);
                            p.p0 = [newPos[0], newPos[1]];
                        } else if (d1 < 1e-3) {
                            const p = ensureLinePatch(e);
                            p.p1 = [newPos[0], newPos[1]];
                        }
                    }
                }
            }
        }
        // ── Arc 一括処理: ループで集めた movedByPos を arc 端点と突き合わせて
        //    translate or reshape を確定する。
        const ARC_TOL = 1e-3;
        for (const e of ents) {
            if (e.kind !== "arc") continue;
            const startPt: Vec2 = [
                e.center[0] + e.radius * Math.cos(e.aStart),
                e.center[1] + e.radius * Math.sin(e.aStart),
            ];
            const endPt: Vec2 = [
                e.center[0] + e.radius * Math.cos(e.aEnd),
                e.center[1] + e.radius * Math.sin(e.aEnd),
            ];
            const startMoved = movedByPos.find(
                (m) => Math.hypot(m.oldPos[0] - startPt[0], m.oldPos[1] - startPt[1]) < ARC_TOL,
            );
            const endMoved = movedByPos.find(
                (m) => Math.hypot(m.oldPos[0] - endPt[0], m.oldPos[1] - endPt[1]) < ARC_TOL,
            );
            if (!startMoved && !endMoved) continue;
            // 元の弧の **bulge 比率** (= chord の半長に対する bulge の比)。
            // この比率を新 chord に合わせて再投影することで、chord 長が
            // 大きく変わっても弧の「曲がり具合」が原形を保つ (= 1/4 円弧
            // は 1/4 円弧のまま、半円は半円のまま)。
            //
            // 元 chord 半長 half_old = |startPt - endPt| / 2。
            // 元 bulge_old = (arc midpoint − chord midpoint) · n_old (符号付き)。
            // 比率 r = bulge_old / half_old を保存し、新 chord 半長 half_new に
            // 掛けて新 bulge_new = r * half_new を得る。
            //
            // Edge case: chord が degenerate (= 両端一致) なら何もしない。
            const oldChordDx = endPt[0] - startPt[0];
            const oldChordDy = endPt[1] - startPt[1];
            const oldChordLen = Math.hypot(oldChordDx, oldChordDy);
            if (oldChordLen < ARC_TOL) continue;
            const oldHalf = oldChordLen / 2;
            const oldUx = oldChordDx / oldChordLen;
            const oldUy = oldChordDy / oldChordLen;
            const oldNx = -oldUy; // CCW 90° 回転 (chord 方向 → 法線)
            const oldNy = oldUx;
            // 元 arc 中点 (= aStart→aEnd を CCW で進む半分の角度位置)。
            let oldSweep = e.aEnd - e.aStart;
            while (oldSweep <= 0) oldSweep += Math.PI * 2;
            while (oldSweep > Math.PI * 2) oldSweep -= Math.PI * 2;
            const arcMidAngle = e.aStart + oldSweep / 2;
            const arcMidX = e.center[0] + e.radius * Math.cos(arcMidAngle);
            const arcMidY = e.center[1] + e.radius * Math.sin(arcMidAngle);
            const oldChordMx = (startPt[0] + endPt[0]) / 2;
            const oldChordMy = (startPt[1] + endPt[1]) / 2;
            const oldBulge = (arcMidX - oldChordMx) * oldNx
                           + (arcMidY - oldChordMy) * oldNy;
            const bulgeRatio = oldBulge / oldHalf;
            // bulgeSide を **新 chord** に対して再構築する内部ヘルパ。
            // chordP0 → chordP1 順で渡される (= e.aStart 端点 → e.aEnd 端点)。
            const computeBulgeSide = (chordP0: Vec2, chordP1: Vec2): Vec2 => {
                const dx = chordP1[0] - chordP0[0];
                const dy = chordP1[1] - chordP0[1];
                const len = Math.hypot(dx, dy) || 1;
                const ux = dx / len, uy = dy / len;
                const nx = -uy, ny = ux;
                const mx = (chordP0[0] + chordP1[0]) / 2;
                const my = (chordP0[1] + chordP1[1]) / 2;
                const newBulge = bulgeRatio * (len / 2);
                return [mx + nx * newBulge, my + ny * newBulge];
            };
            // ── ケース A: 両端点が動いて、delta が同じ → translate ──
            if (startMoved && endMoved) {
                const dx0 = startMoved.newPos[0] - startMoved.oldPos[0];
                const dy0 = startMoved.newPos[1] - startMoved.oldPos[1];
                const dx1 = endMoved.newPos[0] - endMoved.oldPos[0];
                const dy1 = endMoved.newPos[1] - endMoved.oldPos[1];
                if (Math.abs(dx0 - dx1) < ARC_TOL && Math.abs(dy0 - dy1) < ARC_TOL) {
                    const patch = ensureArcPatch(e);
                    patch.cx = e.center[0] + dx0;
                    patch.cy = e.center[1] + dy0;
                    continue;
                }
                // 両端動いたが delta が違う → reshape。bulge 比率を新 chord に
                // 合わせて再投影 (= 弧の「曲がり具合」を保つ)。
                const newStart = startMoved.newPos;
                const newEnd = endMoved.newPos;
                const cursorSide = computeBulgeSide(newStart, newEnd);
                const arc = arcFromChordAndCursor(newStart, newEnd, cursorSide);
                if (arc) {
                    const patch = ensureArcPatch(e);
                    patch.cx = arc.center[0];
                    patch.cy = arc.center[1];
                    patch.radius = arc.radius;
                    patch.aStart = arc.aStart;
                    patch.aEnd = arc.aEnd;
                }
                continue;
            }
            // ── ケース B: 片端だけ動いた → reshape (= もう片端は不動) ──
            const movedSide = startMoved ?? endMoved!;
            const movedIsStart = !!startMoved;
            const newMoved = movedSide.newPos;
            const fixedEnd = movedIsStart ? endPt : startPt;
            // arcFromChordAndCursor は chord = aStart→aEnd 順 (= e.aStart 端点
            // が p0、e.aEnd 端点が p1)。movedIsStart なら新 start = newMoved。
            const chordP0 = movedIsStart ? newMoved : fixedEnd;
            const chordP1 = movedIsStart ? fixedEnd : newMoved;
            const cursorSide = computeBulgeSide(chordP0, chordP1);
            const arc = arcFromChordAndCursor(chordP0, chordP1, cursorSide);
            if (arc) {
                const patch = ensureArcPatch(e);
                patch.cx = arc.center[0];
                patch.cy = arc.center[1];
                patch.radius = arc.radius;
                patch.aStart = arc.aStart;
                patch.aEnd = arc.aEnd;
            }
        }
        const applyEntityPatch = (e: SketchEntity): SketchEntity => {
            const p = entityUpdates.get(e.id);
            if (!p) return e;
            if (p.kind === "polyline" && e.kind === "polyline") {
                return { ...e, points: p.points };
            }
            if (p.kind === "line" && e.kind === "line") {
                return {
                    ...e,
                    ...(p.p0 ? { p0: p.p0 } : {}),
                    ...(p.p1 ? { p1: p.p1 } : {}),
                };
            }
            if (p.kind === "circle" && e.kind === "circle") {
                return {
                    ...e,
                    ...(p.center ? { center: p.center } : {}),
                    ...(p.radius !== undefined ? { radius: p.radius } : {}),
                };
            }
            if (p.kind === "arc" && e.kind === "arc") {
                return {
                    ...e,
                    center: [p.cx, p.cy],
                    ...(p.radius !== undefined ? { radius: p.radius } : {}),
                    ...(p.aStart !== undefined ? { aStart: p.aStart } : {}),
                    ...(p.aEnd !== undefined ? { aEnd: p.aEnd } : {}),
                };
            }
            return e;
        };
        const isDragging = useAppState.getState().solverDragHint.length > 0;
        if (entityUpdates.size > 0 && isDragging) {
            // drag 中: polygons と entities を **同一 updateElement で 1 回** に
            // まとめて書き込む。以前は updateElement(polygons) + setSpaceEntities(entities)
            // と 2 回 state 更新していたが、React の再レンダーが毎フレーム 2 回起きて
            // 「全体ドラッグが重い」原因になっていた。setSpaceEntities は drag 中に
            // polygon を再 derive しないので、entities だけ直接 patch すれば derive を
            // 経由する必要は無い。mouseup で solverDragHint がクリアされると次回
            // setSpaceEntities/solver で正しく再 derive される。
            const liveSpace = useAppState.getState().elements[activeRoomId] as SpaceElement | undefined;
            const newEntities = (liveSpace?.entities ?? []).map(applyEntityPatch);
            updateElement(activeRoomId, {
                polygons: synced,
                entities: newEntities,
                dirtyFlags: new Set([...room.dirtyFlags, "Geometry", "Mesh", "Render"]),
            } as any);
        } else if (entityUpdates.size > 0) {
            // Non-drag: 既存経路。setSpaceEntities が再 derive を実施。
            setSpaceEntities(activeRoomId, (entities) => entities.map(applyEntityPatch));
        } else {
            // No entity-mappable changes — fall back to direct polygon writeback.
            updateElement(activeRoomId, {
                polygons: synced,
                dirtyFlags: new Set([...room.dirtyFlags, "Geometry", "Mesh", "Render"]),
            } as any);
        }
        // drag 中は 3D 壁の毎フレーム再描画を skip する。
        // wall axis を更新すると 3D mesh が再生成されて重いうえ、ユーザは
        // 「ドラッグ中の 3D 壁は不要、オレンジの polygon プレビューだけ見たい」
        // という運用 (= スケッチ専念) を望んでいる。`maybeRealtimeRegenWalls`
        // が mouseup 時に呼ばれて wall axis と 3D mesh が再構築されるので、
        // ドラッグ中の wall 表示は意図的に静止 (= 別経路で hide される)。
        const isDraggingForWalls = useAppState.getState().solverDragHint.length > 0;
        if (!isDraggingForWalls) {
            for (const poly of synced) {
                if (!poly.wallIds || !poly.wallThickness) continue;
                if (poly.wallIds.length !== poly.outer.length) continue;
                let cx = 0, cy = 0;
                for (const p of poly.outer) { cx += p[0]; cy += p[1]; }
                cx /= poly.outer.length; cy /= poly.outer.length;
                const axes = computeMiteredWallAxes(poly.outer, [cx, cy], poly.wallThickness / 2);
                for (let i = 0; i < poly.wallIds.length; i++) {
                    const wid = poly.wallIds[i];
                    if (!wid) continue;
                    updateElement(wid, {
                        axis: axes[i],
                        dirtyFlags: new Set(["Geometry", "Mesh", "Render"]),
                    } as any);
                }
            }
        }
    };

    // Update refs for dim editing callbacks
    commitDimRef.current = (value: string) => {
        if (!editingDim) return;
        const mm = parseFloat(value);
        if (isNaN(mm) || mm <= 0) { setEditingDim(null); return; }
        const wl = mm / 1000;
        const poly = room.polygons.find(p => p.id === editingDim.polyId);
        if (!poly) { setEditingDim(null); return; }
        const aabb = polygonAsAxisAlignedRect(poly);
        if (!aabb) { setEditingDim(null); return; }
        // Scale the polygon's outer ring along the requested axis around its center.
        const cx = (aabb.minX + aabb.maxX) / 2;
        const cy = (aabb.minY + aabb.maxY) / 2;
        const curW = aabb.maxX - aabb.minX;
        const curH = aabb.maxY - aabb.minY;
        const sx = editingDim.axis === "w" ? wl / curW : 1;
        const sy = editingDim.axis === "h" ? wl / curH : 1;
        const newOuter: Vec2[] = poly.outer.map((p) => [
            cx + (p[0] - cx) * sx,
            cy + (p[1] - cy) * sy,
        ]);
        const newPolys = room.polygons.map(p => p.id !== editingDim.polyId ? p : { ...p, outer: newOuter });
        updatePolysAndSync(newPolys);
        setEditingDim(null);
    };
    startDimRef.current = (polyId: string, axis: "w" | "h", mm: number) => {
        setEditingDim({ polyId, axis, value: mm.toFixed(0) });
    };

    // Apply Collinear constraint suggested during drag. Removes any conflicting
    // Parallel / Perpendicular / Angle / Collinear on the same edge pair,
    // pre-aligns edge B onto edge A's infinite line, then adds the constraint.
    applyCollinearRef.current = (polyIdA, edgeIdxA, polyIdB, edgeIdxB) => {
        if (!activeRoomId) return;
        const polyA = room.polygons.find((p) => p.id === polyIdA);
        const polyB = room.polygons.find((p) => p.id === polyIdB);
        if (!polyA || !polyB) return;

        // Remove conflicting constraints on the same edge pair
        const keyA = `${activeRoomId}:${polyIdA}:${edgeIdxA}`;
        const keyB = `${activeRoomId}:${polyIdB}:${edgeIdxB}`;
        const { constraints: curConstraints } = useAppState.getState();
        for (const cid in curConstraints) {
            const c = curConstraints[cid];
            if (c.type !== "Parallel" && c.type !== "Perpendicular"
                && c.type !== "Angle" && c.type !== "Collinear") continue;
            const keys = c.targets
                .filter((t) => t.kind === "SketchEdge")
                .map((t) => {
                    const tt = t as any;
                    return `${tt.spaceId}:${tt.polyId}:${tt.edgeIdx}`;
                });
            if (keys.includes(keyA) && keys.includes(keyB)) {
                executeCommand(new RemoveConstraintCommand(cid));
            }
        }

        // Pre-align: project both endpoints of edge B onto the infinite line
        // of edge A.
        const nA = polyA.outer.length;
        const nB = polyB.outer.length;
        const aStart = polyA.outer[edgeIdxA];
        const aEnd = polyA.outer[(edgeIdxA + 1) % nA];
        const dxa = aEnd[0] - aStart[0], dya = aEnd[1] - aStart[1];
        const lenA = Math.hypot(dxa, dya);
        if (lenA > 1e-9) {
            const ux = dxa / lenA, uy = dya / lenA;
            const project = (p: Vec2): Vec2 => {
                const t = (p[0] - aStart[0]) * ux + (p[1] - aStart[1]) * uy;
                return [aStart[0] + ux * t, aStart[1] + uy * t];
            };
            const startIdxB = edgeIdxB;
            const endIdxB = (edgeIdxB + 1) % nB;
            const newOuterB = polyB.outer.map((p, i) =>
                i === startIdxB || i === endIdxB ? project(p) : p,
            );
            const latest = useAppState.getState().elements[activeRoomId] as SpaceElement | undefined;
            if (latest) {
                const newPolys = latest.polygons.map((p) =>
                    p.id === polyIdB ? { ...p, outer: newOuterB } : p,
                );
                updateElement(activeRoomId, {
                    polygons: newPolys,
                    dirtyFlags: new Set([...latest.dirtyFlags, "Geometry", "Mesh", "Render"]),
                } as any);
            }
        }

        executeCommand(new AddConstraintCommand({
            id: generateConstraintId(),
            type: "Collinear",
            targets: [
                { kind: "SketchEdge", spaceId: activeRoomId, polyId: polyIdA, edgeIdx: edgeIdxA },
                { kind: "SketchEdge", spaceId: activeRoomId, polyId: polyIdB, edgeIdx: edgeIdxB },
            ],
        }));
    };

    // Merge the last-dragged polygon with all polygons that overlap it (across
    // any Space). Cross-Space マージ:
    //   - focus polygon を全 Space から検索
    //   - focus と AABB 交差する非 outline polygon (他 Space 含む) を集める
    //   - polygon-clipping で union を取る
    //   - 結果は **focus polygon の Space** に書く
    //   - マージで吸収された側の polygon は元 Space から削除
    //   - マージで吸収された Space に他に polygon が残っていなければ Space ごと削除
    //   - 各 polygon の wallIds に紐付く壁も削除
    mergeRef.current = (focusPolyId?: string) => {
        const seedPolyId = focusPolyId ?? lastDraggedPolyId;
        if (!seedPolyId) return;
        const liveElements = useAppState.getState().elements;

        // focus polygon の所属 Space を全 Space から検索
        let focus: RoomPolygon | undefined;
        let focusSpaceId: string | undefined;
        for (const id in liveElements) {
            const el = liveElements[id];
            if (!el || el.type !== "Space") continue;
            const sp = el as SpaceElement;
            const f = (sp.polygons ?? []).find((p) => p.id === seedPolyId);
            if (f) { focus = f; focusSpaceId = id; break; }
        }
        if (!focus || !focusSpaceId) return;

        const polyToCoords = (p: RoomPolygon): [number, number][][] => {
            const ring = p.outer.map(([x, y]) => [x, y] as [number, number]);
            if (ring.length < 3) return [];
            ring.push([ring[0][0], ring[0][1]]);
            const rings: [number, number][][] = [ring];
            for (const h of p.holes ?? []) {
                if (h.length < 3) continue;
                const hh = h.map(([x, y]) => [x, y] as [number, number]);
                hh.push([hh[0][0], hh[0][1]]);
                rings.push(hh);
            }
            return rings;
        };

        const fxs = focus.outer.map(p => p[0]);
        const fys = focus.outer.map(p => p[1]);
        const fMinX = Math.min(...fxs), fMaxX = Math.max(...fxs);
        const fMinZ = Math.min(...fys), fMaxZ = Math.max(...fys);
        const eps = 1e-6;

        // 全 Space を走査して交差 polygon を集める。
        // 形式: { polyId: spaceId } で「どの Space から削除するか」を保持。
        // **レベルガード**: focus と異なる階の部屋は merge 対象外 (= 各階は
        //   独立した平面なので、平面位置で重なっても結合してはいけない)。
        const focusSpForMerge = liveElements[focusSpaceId] as SpaceElement | undefined;
        const focusLvlForMerge = focusSpForMerge && focusSpForMerge.type === "Space"
            ? focusSpForMerge.levelId : undefined;
        const mergePolys: { poly: RoomPolygon; spaceId: string }[] = [
            { poly: focus, spaceId: focusSpaceId },
        ];
        for (const id in liveElements) {
            const el = liveElements[id];
            if (!el || el.type !== "Space") continue;
            const sp = el as SpaceElement;
            // 他階はスキップ
            if (focusLvlForMerge !== undefined && sp.levelId !== undefined
                && sp.levelId !== focusLvlForMerge) continue;
            for (const other of sp.polygons ?? []) {
                if (other.id === focus.id) continue;
                if (other.wallOutlineOf) continue; // 派生 outline はスキップ
                const oxs = other.outer.map(p => p[0]);
                const oys = other.outer.map(p => p[1]);
                const oMinX = Math.min(...oxs), oMaxX = Math.max(...oxs);
                const oMinZ = Math.min(...oys), oMaxZ = Math.max(...oys);
                if (fMinX < oMaxX - eps && fMaxX > oMinX + eps &&
                    fMinZ < oMaxZ - eps && fMaxZ > oMinZ + eps) {
                    mergePolys.push({ poly: other, spaceId: id });
                }
            }
        }
        if (mergePolys.length < 2) return;

        const inputs = mergePolys.map((m) => polyToCoords(m.poly));
        const [firstIn, ...restIn] = inputs;
        const result = polygonClipping.union(firstIn, ...restIn);

        // Remove consecutive duplicate vertices (tolerance ~1μm) — polygon-
        // clipping may emit duplicates at intersection points when merging
        // a tessellated circle against straight edges.
        const DEDUP_EPS = 1e-6;
        const dedupRing = (ring: Vec2[]): Vec2[] => {
            const out: Vec2[] = [];
            for (const p of ring) {
                const last = out[out.length - 1];
                if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) > DEDUP_EPS) {
                    out.push(p);
                }
            }
            while (out.length > 1) {
                const a = out[0];
                const b = out[out.length - 1];
                if (Math.hypot(a[0] - b[0], a[1] - b[1]) <= DEDUP_EPS) out.pop();
                else break;
            }
            return out;
        };

        // 結果 polygon のリストを生成。
        const resultPolygons: RoomPolygon[] = [];
        for (const poly of result) {
            if (poly.length === 0) continue;
            let outer = poly[0].map(([x, y]) => [x, y] as Vec2);
            if (outer.length > 1 &&
                outer[0][0] === outer[outer.length - 1][0] &&
                outer[0][1] === outer[outer.length - 1][1]) {
                outer.pop();
            }
            outer = dedupRing(outer);
            const holes: Vec2[][] = [];
            for (let i = 1; i < poly.length; i++) {
                let h = poly[i].map(([x, y]) => [x, y] as Vec2);
                if (h.length > 1 &&
                    h[0][0] === h[h.length - 1][0] &&
                    h[0][1] === h[h.length - 1][1]) {
                    h.pop();
                }
                h = dedupRing(h);
                holes.push(h);
            }
            resultPolygons.push({ id: generateId(), outer, holes });
        }

        // 吸収対象 polygon の wallIds に紐付く壁を削除。
        for (const m of mergePolys) {
            if (!m.poly.wallIds) continue;
            for (const wid of m.poly.wallIds) {
                if (wid && liveElements[wid]) removeElement(wid);
            }
        }

        // Space ごとに集約。focusSpaceId には resultPolygons を入れ、もとの
        // 吸収対象 polygon を除く。他 Space は吸収対象 polygon を除くだけ。
        // 残 polygon が空になった Space (focusSpaceId 以外) は Space ごと削除。
        const removedPolyIdsBySpace = new Map<string, Set<string>>();
        for (const m of mergePolys) {
            let s = removedPolyIdsBySpace.get(m.spaceId);
            if (!s) { s = new Set(); removedPolyIdsBySpace.set(m.spaceId, s); }
            s.add(m.poly.id);
        }

        for (const [spaceId, removedIds] of removedPolyIdsBySpace) {
            const sp = liveElements[spaceId] as SpaceElement | undefined;
            if (!sp || sp.type !== "Space") continue;
            // wallOutlineOf が removedIds を指す派生 outline も削除対象に追加。
            const allRemoved = new Set(removedIds);
            for (const p of sp.polygons ?? []) {
                if (p.wallOutlineOf && removedIds.has(p.wallOutlineOf)) {
                    allRemoved.add(p.id);
                }
            }
            const remaining = (sp.polygons ?? []).filter((p) => !allRemoved.has(p.id));
            const isFocusSpace = spaceId === focusSpaceId;
            const finalPolygons = isFocusSpace
                ? [...remaining, ...resultPolygons]
                : remaining;
            if (!isFocusSpace && finalPolygons.length === 0) {
                // 他 Space が空になったら Space ごと削除。
                removeElement(spaceId);
            } else {
                updateElement(spaceId, {
                    polygons: finalPolygons,
                    dirtyFlags: new Set([...(sp.dirtyFlags ?? []), "Geometry", "Mesh", "Render"]),
                } as any);
            }
        }
        setLastDraggedPolyId(null);
        setSelection([]);
    };

    // ─── Clip (subtract): focus polygon の形状で overlapping polygons を差し引く ───
    // focus (lastDragged) はそのまま。他の重なり部屋に対して
    // difference(other, focus) を計算し、結果で置き換える。
    clipRef.current = (focusPolyId?: string) => {
        const seedPolyId = focusPolyId ?? lastDraggedPolyId;
        if (!seedPolyId) return;
        const liveElements = useAppState.getState().elements;

        // focus polygon を探す
        let focus: RoomPolygon | undefined;
        let focusSpaceId: string | undefined;
        for (const id in liveElements) {
            const el = liveElements[id];
            if (!el || el.type !== "Space") continue;
            const sp = el as SpaceElement;
            const f = (sp.polygons ?? []).find((p) => p.id === seedPolyId);
            if (f) { focus = f; focusSpaceId = id; break; }
        }
        if (!focus || !focusSpaceId) return;

        const polyToCoords = (p: RoomPolygon): [number, number][][] => {
            const ring = p.outer.map(([x, y]) => [x, y] as [number, number]);
            if (ring.length < 3) return [];
            ring.push([ring[0][0], ring[0][1]]);
            const rings: [number, number][][] = [ring];
            for (const h of p.holes ?? []) {
                if (h.length < 3) continue;
                const hh = h.map(([x, y]) => [x, y] as [number, number]);
                hh.push([hh[0][0], hh[0][1]]);
                rings.push(hh);
            }
            return rings;
        };

        const DEDUP_EPS = 1e-6;
        const dedupRing = (ring: [number, number][]): [number, number][] => {
            const out: [number, number][] = [];
            for (const p of ring) {
                const last = out[out.length - 1];
                if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) > DEDUP_EPS) {
                    out.push(p);
                }
            }
            while (out.length > 1) {
                const a = out[0], b = out[out.length - 1];
                if (Math.hypot(a[0] - b[0], a[1] - b[1]) <= DEDUP_EPS) out.pop();
                else break;
            }
            return out;
        };

        const fxs = focus.outer.map(p => p[0]);
        const fys = focus.outer.map(p => p[1]);
        const fMinX = Math.min(...fxs), fMaxX = Math.max(...fxs);
        const fMinZ = Math.min(...fys), fMaxZ = Math.max(...fys);
        const eps = 1e-6;

        const focusSp = liveElements[focusSpaceId] as SpaceElement | undefined;
        const focusLvl = focusSp && focusSp.type === "Space" ? focusSp.levelId : undefined;
        const focusCoords = polyToCoords(focus);
        if (focusCoords.length === 0) return;

        // 全 Space を走査して AABB 交差する他 polygon に difference を適用
        const regenPolyIds: string[] = [];

        for (const id in liveElements) {
            const el = liveElements[id];
            if (!el || el.type !== "Space") continue;
            const sp = el as SpaceElement;
            if (focusLvl !== undefined && sp.levelId !== undefined
                && sp.levelId !== focusLvl) continue;

            let changed = false;
            // wallOutlineOf 派生を除いた通常 polygon のみ処理対象にする。
            // 派生 outline は後で全部削除してから regenerateAllWalls に任せる。
            const nextPolygons: RoomPolygon[] = [];

            for (const other of sp.polygons ?? []) {
                if (other.id === focus.id) { nextPolygons.push(other); continue; }
                // 派生 outline は古いまま残さず、後で再生成に任せる
                if (other.wallOutlineOf) { changed = true; continue; }

                const oxs = other.outer.map(p => p[0]);
                const oys = other.outer.map(p => p[1]);
                const oMinX = Math.min(...oxs), oMaxX = Math.max(...oxs);
                const oMinZ = Math.min(...oys), oMaxZ = Math.max(...oys);
                const overlaps = fMinX < oMaxX - eps && fMaxX > oMinX + eps
                    && fMinZ < oMaxZ - eps && fMaxZ > oMinZ + eps;
                if (!overlaps) { nextPolygons.push(other); continue; }

                // difference: other の中から focus の領域を除去
                const otherCoords = polyToCoords(other);
                if (otherCoords.length === 0) { nextPolygons.push(other); continue; }

                const diffResult = polygonClipping.difference(otherCoords, focusCoords);

                // 古い wallIds に紐付く壁エレメントを削除（再生成で置き換わる）
                if (other.wallIds) {
                    for (const wid of other.wallIds) {
                        if (wid && liveElements[wid]) removeElement(wid);
                    }
                }

                if (diffResult.length === 0) {
                    // other が focus に完全に含まれる → polygon ごと削除
                    changed = true;
                    continue;
                }

                // 差し引き結果を新 polygon として追加（複数の孤立領域になりうる）
                for (const poly of diffResult) {
                    if (poly.length === 0) continue;
                    let outer = dedupRing(poly[0].map(([x, y]) => [x, y] as [number, number]));
                    if (outer.length > 1
                        && outer[0][0] === outer[outer.length - 1][0]
                        && outer[0][1] === outer[outer.length - 1][1]) {
                        outer.pop();
                    }
                    outer = dedupRing(outer);
                    const holes: Vec2[][] = [];
                    for (let i = 1; i < poly.length; i++) {
                        let h = dedupRing(poly[i].map(([x, y]) => [x, y] as [number, number]));
                        if (h.length > 1
                            && h[0][0] === h[h.length - 1][0]
                            && h[0][1] === h[h.length - 1][1]) {
                            h.pop();
                        }
                        h = dedupRing(h);
                        holes.push(h as Vec2[]);
                    }
                    if (outer.length >= 3) {
                        const newId = generateId();
                        nextPolygons.push({ id: newId, outer: outer as Vec2[], holes });
                        regenPolyIds.push(newId);
                        changed = true;
                    }
                }
            }

            if (!changed) continue;

            if (id !== focusSpaceId && nextPolygons.filter(p => !p.wallOutlineOf).length === 0) {
                removeElement(id);
            } else {
                updateElement(id, {
                    polygons: nextPolygons,
                    dirtyFlags: new Set([...(sp.dirtyFlags ?? []), "Geometry", "Mesh", "Render"]),
                } as any);
            }
        }

        // 変形した polygon の壁を再生成する
        if (regenPolyIds.length > 0) {
            const s = useAppState.getState();
            regenerateAllWalls({
                wallThicknessMm: s.wallThicknessMm,
                circleWallAngleDeg: s.circleWallAngleDeg,
                wallReferenceMode: s.wallReferenceMode,
                seedPolyIds: regenPolyIds,
            });
        }

        setLastDraggedPolyId(null);
        setSelection([]);
    };

    // ─── Build draw lists from current state ───
    function buildDrawLists(): { lines: SketchLine[]; quads: SketchQuad[]; markers: SketchMarker[] } {
        const lines: SketchLine[] = [];
        const quads: SketchQuad[] = [];
        const markers: SketchMarker[] = [];

        const els = elementsRef.current;
        const sel = selectionRef.current;
        const rid = activeRoomIdRef.current;
        // pending 中 (rid 無し) は active room 用の描画はしないが、原点軸・他部屋の
        // pass ・ rect/poly/circle のドラフトプレビューは描きたいので空 phantom で続行。
        const real = rid ? els[rid] : undefined;
        const rm: SpaceElement = (real && real.type === "Space")
            ? (real as SpaceElement)
            : {
                id: "__pending_room__" as ElementId,
                type: "Space",
                name: "",
                visible: true,
                locked: false,
                transform: mat4.create(),
                dirtyFlags: new Set(),
                shape: null,
                boundary: [],
                polygons: [],
                entities: [],
                area: 0,
                height: 3.0,
            };

        const drag = dragStateRef.current;
        const hovPolyId = hoveredPolyIdRef.current;
        const hovPolySpaceId = hoveredPolySpaceIdRef.current;
        const hovPVtx = hoveredPolyVertexRef.current;
        const sketchSel = sketchSelectionRef.current;

        // Shared walls live on the boundary between two polygons; both
        // polygons reference the same wallId in their per-edge `wallIds`.
        // Pre-scan every Space's polygons so the wall-slab loop knows
        // upfront (a) which wallId is shared, (b) which polygon owns the
        // single render (canonical owner = lex-smallest poly id), and (c)
        // for each adjacency, whether the next/prev wall is shared.
        const wallToPolyIds = new Map<string, Set<string>>();
        for (const elId in els) {
            const e = els[elId];
            if (!e || e.type !== "Space") continue;
            const sp = e as SpaceElement;
            for (const p of sp.polygons ?? []) {
                // wallIds は edge ごとに canonical 1 本だけ。cross-poly overlap で
                // 同じ polygon edge に複数 wall が紐づくケース (split された
                // 2 本目以降) は wallsPerEdge にしか入っていないので、両方を
                // 走査して owner 判定が漏れないようにする。
                const collect = (wid: string | undefined) => {
                    if (!wid) return;
                    let s = wallToPolyIds.get(wid);
                    if (!s) { s = new Set(); wallToPolyIds.set(wid, s); }
                    s.add(p.id);
                };
                for (const wid of p.wallIds ?? []) collect(wid);
                for (const widList of p.wallsPerEdge ?? []) {
                    for (const wid of widList) collect(wid);
                }
            }
        }
        const isWallShared = (wid: string) =>
            (wallToPolyIds.get(wid)?.size ?? 0) >= 2;
        const isWallOwner = (wid: string, polyId: string) => {
            const refs = wallToPolyIds.get(wid);
            if (!refs || refs.size === 0) return false;
            if (refs.size === 1) return refs.has(polyId);
            // Deterministic owner: lex-smallest polyId in the referrer set.
            let owner = "";
            for (const id of refs) if (owner === "" || id < owner) owner = id;
            return owner === polyId;
        };

        // 他ポリゴンを id で逆引きする lookup。`vertexConnections` で
        // クロスポリゴンの incident edge を引くときに `computeWallHexagon`
        // へ渡す。
        const polygonLookup = (polyId: string): RoomPolygon | undefined => {
            for (const elId in els) {
                const e2 = els[elId];
                if (!e2 || e2.type !== "Space") continue;
                const sp = e2 as SpaceElement;
                const found = sp.polygons?.find((p) => p.id === polyId);
                if (found) return found;
            }
            return undefined;
        };

        /** 6 頂点ヘキサゴン (`computeWallHexagon`) を `earcut` で三角化し、
         *  `SketchQuad[]` (= 1 quad per triangle, p2 == p3) にして返す。
         *  3+ 接続交差点があると hex が非凸になる場合があるので earcut を使う。 */
        const buildWallSlabQuads = (poly: RoomPolygon, edgeIdx: number): SketchQuad[] => {
            const hex = computeWallHexagon(poly, edgeIdx, polygonLookup);
            if (!hex) return [];
            const flat: number[] = [];
            for (const p of hex.vertices) { flat.push(p[0], p[1]); }
            const tris = earcut(flat, undefined, 2);
            const out: SketchQuad[] = [];
            for (let i = 0; i < tris.length; i += 3) {
                const a = tris[i] * 2, b = tris[i + 1] * 2, c = tris[i + 2] * 2;
                out.push({
                    p0: [flat[a],     flat[a + 1]],
                    p1: [flat[b],     flat[b + 1]],
                    p2: [flat[c],     flat[c + 1]],
                    p3: [flat[c],     flat[c + 1]],
                    color: C_WALL_SLAB,
                });
            }
            return out;
        };

        /** wall.footprint (任意 N 頂点 CCW) を earcut で三角化して quads を返す。
         *  円弧グループ wall (= 統合フットプリント) を 1 つの曲線スラブとして
         *  描画する用途。`holes` が渡されると annulus (= 円筒壁) として
         *  inner ring を抜く。 */
        const buildFootprintSlabQuads = (
            footprint: Vec2[],
            holes?: Vec2[][],
        ): SketchQuad[] => {
            if (footprint.length < 3) return [];
            const flat: number[] = [];
            for (const p of footprint) { flat.push(p[0], p[1]); }
            const holeIndices: number[] = [];
            if (holes && holes.length > 0) {
                for (const h of holes) {
                    if (h.length < 3) continue;
                    holeIndices.push(flat.length / 2);
                    for (const p of h) { flat.push(p[0], p[1]); }
                }
            }
            const tris = earcut(
                flat,
                holeIndices.length > 0 ? holeIndices : undefined,
                2,
            );
            const out: SketchQuad[] = [];
            for (let i = 0; i < tris.length; i += 3) {
                const a = tris[i] * 2, b = tris[i + 1] * 2, c = tris[i + 2] * 2;
                out.push({
                    p0: [flat[a],     flat[a + 1]],
                    p1: [flat[b],     flat[b + 1]],
                    p2: [flat[c],     flat[c + 1]],
                    p3: [flat[c],     flat[c + 1]],
                    color: C_WALL_SLAB,
                });
            }
            return out;
        };

        // Origin symbol: short X (red) / Z (green) axes with a center dot
        // 軸線の長さは **ピクセル一定** にしたいので、camera (ortho) の zoom と
        // canvas 高さから world-per-pixel 比を計算して world 単位に変換する。
        // ORIGIN_AXIS_LEN は元々 0.3m (= 世界座標) だったが、ズームで大きさが
        // 変わってしまうため、固定 PX で表現する。
        // buildDrawLists は renderer の raf ループから呼ばれる関数だが、
        // 関数自体は早期 return 後でも null になり得る closure として定義
        // されているため、camera を再取得して null チェックする。
        const camLive = viewportRef.current?.getCamera() ?? null;
        const projY = camLive?.projectionMatrix[5] ?? 0;
        const canvasH = canvasRef.current?.clientHeight ?? 800;
        const pxToWorld = (projY > 1e-9 && canvasH > 0)
            ? 2 / (projY * canvasH)
            : 0.015;
        const axisLenWorld = ORIGIN_AXIS_LEN_PX * pxToWorld;
        lines.push({ ax: 0, az: 0, bx: axisLenWorld, bz: 0, color: C_ORIGIN_X, width: ORIGIN_STROKE_WIDTH });
        lines.push({ ax: 0, az: 0, bx: 0, bz: axisLenWorld, color: C_ORIGIN_Z, width: ORIGIN_STROKE_WIDTH });
        markers.push({
            wx: 0, wz: 0, radius: ORIGIN_DOT_RADIUS, shape: "circle",
            fill: C_WHITE, stroke: C_ORIGIN_DOT, strokeWidth: ORIGIN_STROKE_WIDTH,
        });

        // ── Passive pass: render OTHER rooms' polygons behind the active one.
        // The active-room polygon loop below only iterates `rm.polygons`, so
        // without this pass switching the active room would make every
        // previously-drawn room disappear from the 2D overlay. We draw their
        // outlines + virtual-wall bands + faint fill, but no edit handles.
        //
        // **レベルフィルタ**: 編集中レベル以外 (= 他階) の部屋は「参照線」
        // モードで描く — スケッチライン (polygon outer)・fill・仮壁帯は出さず、
        // 壁の hex フットプリント外周だけを薄グレーの線で出力する。これは
        // 上下階の壁・柱位置を合わせる作図参照を提供するための表示。
        // editingLevelId は active room の levelId、無ければ pendingRoomLevelId。
        const editingLevelId: string | null =
            (real && (real as SpaceElement).levelId) ?? pendingRoomLevelIdRef.current ?? null;
        for (const otherId in els) {
            if (otherId === rid) continue;
            const other = els[otherId];
            if (!other || other.type !== "Space") continue;
            const otherRoom = other as SpaceElement;
            if (!otherRoom.polygons) continue;

            // ── 他レベル部屋: 壁の外周だけをグレー線で出力 ─────────────
            const isOtherLevel =
                editingLevelId !== null
                && !!otherRoom.levelId
                && otherRoom.levelId !== editingLevelId;
            if (isOtherLevel) {
                for (const poly of otherRoom.polygons) {
                    if (poly.wallOutlineOf) continue;
                    if (poly.outer.length < 3) continue;
                    const passiveEdgeCount = polygonEdges(poly).length;
                    if (!poly.wallIds || poly.wallIds.length !== passiveEdgeCount) continue;
                    const renderedWidsRef = new Set<string>();
                    for (let i = 0; i < passiveEdgeCount; i++) {
                        // split された 2 本目以降を取りこぼさないため wallsPerEdge 優先。
                        const widList = poly.wallsPerEdge?.[i] ?? [poly.wallIds[i]];
                        for (const wid of widList) {
                            if (!wid) continue;
                            if (!isWallOwner(wid, poly.id)) continue;
                            if (renderedWidsRef.has(wid)) continue;
                            renderedWidsRef.add(wid);
                            const wallEl = els[wid] as WallElement | undefined;
                            // 壁の外周頂点列。footprint 優先 (= JunctionGraph fp)、
                            // 無ければ computeWallHexagon で 6 頂点 hex を計算。
                            let outline: Vec2[] | null = null;
                            if (wallEl?.footprint && wallEl.footprint.length >= 3) {
                                outline = wallEl.footprint;
                            } else if (poly.wallThickness != null
                                    || (poly.innerThickness != null && poly.outerThickness != null)) {
                                const hex = computeWallHexagon(poly, i, polygonLookup);
                                if (hex) outline = hex.vertices;
                            }
                            if (!outline) continue;
                            for (let j = 0; j < outline.length; j++) {
                                const a = outline[j];
                                const b = outline[(j + 1) % outline.length];
                                lines.push({
                                    ax: a[0], az: a[1], bx: b[0], bz: b[1],
                                    color: C_OTHER_LEVEL_REF, width: 1.0,
                                });
                            }
                        }
                    }
                }
                // 他レベル部屋は参照線のみ。下の通常 passive 描画はスキップ。
                continue;
            }

            for (const poly of otherRoom.polygons) {
                if (poly.wallOutlineOf) continue;
                if (poly.outer.length < 3) continue;

                // 別 Room (= 非アクティブ) の polygon にカーソルを乗せた時の
                // ハイライト。createdAt を考慮した cross-Space ホバー検出
                // (`hitTestPolyAcrossSpaces`) が hovPolyId / hovPolySpaceId を
                // セットするので、ここで反応させて active Room と同じ
                // ホバー色 (C_RECT_HOV / C_RECT_HOV_FILL) を出す。
                const isOtherHovered = hovPolyId === poly.id && hovPolySpaceId === otherId;

                // Confirmed walls (other rooms) — per-edge 6-vertex hexagon
                // via computeWallHexagon. Shared edges render only on the
                // canonical owner (lex-smallest polyId in wallToPolyIds).
                // wallIds は edge ごとに 1 個 → 閉じ図形なら .length === outer.length、
                // 開いたポリライン (wallPath) なら .length === edges.length (= outer.length-1)。
                // どちらでも正しく描画できるよう polygonEdges() の長さで照合する。
                // **drag 中は wall slab を描画しない** (active 側と同じ判断)。
                // 共有壁が inactive 側の canonical owner で描画される場合があるため、
                // ここでも drag 中の slab 描画を抑止しないと「離れた残骸」が残る。
                const passiveEdgeCount = polygonEdges(poly).length;
                if (!drag && poly.wallIds && poly.wallIds.length === passiveEdgeCount
                    && (poly.wallThickness != null
                        || (poly.innerThickness != null && poly.outerThickness != null))) {
                    const renderedWidsP = new Set<string>();
                    for (let i = 0; i < passiveEdgeCount; i++) {
                        // active 側と同じく split された 2 本目以降を取りこぼさない
                        // ため wallsPerEdge を優先。
                        const widList = poly.wallsPerEdge?.[i] ?? [poly.wallIds[i]];
                        for (const wid of widList) {
                            if (!wid) continue;
                            if (!isWallOwner(wid, poly.id)) continue;
                            if (renderedWidsP.has(wid)) continue;
                            renderedWidsP.add(wid);
                            const wallEl = els[wid] as WallElement | undefined;
                            if (wallEl?.footprint && wallEl.footprint.length >= 3) {
                                for (const q of buildFootprintSlabQuads(wallEl.footprint, wallEl.footprintHoles)) quads.push(q);
                            } else {
                                for (const q of buildWallSlabQuads(poly, i)) quads.push(q);
                            }
                        }
                    }
                } else if (isPolygonClosed(poly)) {
                    // 仮壁 band for other rooms too — centred on the polyline
                    // (axis-on-centre per spec §4: 区画線 ≒ 壁芯).
                    const half = VIRTUAL_WALL_THICKNESS_M / 2;
                    let cx = 0, cy = 0;
                    for (const p of poly.outer) { cx += p[0]; cy += p[1]; }
                    cx /= poly.outer.length; cy /= poly.outer.length;
                    const axis = poly.outer;
                    const n = axis.length;
                    const outerRing = computeMiteredCorners(axis, [cx, cy], half);
                    const innerRing = computeMiteredCorners(axis, [cx, cy], -half);
                    for (let i = 0; i < n; i++) {
                        const j = (i + 1) % n;
                        quads.push({
                            p0: [innerRing[i][0], innerRing[i][1]],
                            p1: [innerRing[j][0], innerRing[j][1]],
                            p2: [outerRing[j][0], outerRing[j][1]],
                            p3: [outerRing[i][0], outerRing[i][1]],
                            color: C_VIRTUAL_WALL,
                        });
                    }
                }

                // Faint interior fill (closed only)
                if (isPolygonClosed(poly)) {
                    const flat: number[] = [];
                    for (const p of poly.outer) { flat.push(p[0], p[1]); }
                    const holeIdx: number[] = [];
                    for (const h of poly.holes ?? []) {
                        holeIdx.push(flat.length / 2);
                        for (const p of h) flat.push(p[0], p[1]);
                    }
                    const tris = earcut(flat, holeIdx.length > 0 ? holeIdx : undefined, 2);
                    const inactiveFill: RGBA = isOtherHovered
                        ? C_RECT_HOV_FILL
                        : rgba(100, 116, 139, 0.05);
                    for (let i = 0; i < tris.length; i += 3) {
                        const ai = tris[i] * 2, bi = tris[i + 1] * 2, ci = tris[i + 2] * 2;
                        quads.push({
                            p0: [flat[ai], flat[ai + 1]],
                            p1: [flat[bi], flat[bi + 1]],
                            p2: [flat[ci], flat[ci + 1]],
                            p3: [flat[ci], flat[ci + 1]],
                            color: inactiveFill,
                        });
                    }
                }

                // Outline edges in muted slate so the active room visually wins.
                // Arc / Circle 由来 edge は分割線ではなく弧として滑らかに描画。
                // ホバー/選択された辺はアクティブ Room と同じハイライト色で描画
                // (= 非アクティブ Room の辺もホバー視認 / 選択視認できる)。
                const inactiveStroke: RGBA = isOtherHovered
                    ? C_RECT_HOV
                    : rgba(100, 116, 139, 0.65);
                const inactiveStrokeWidth = isOtherHovered ? 2 : 1.2;
                const polyEdgeList = polygonEdges(poly);
                const passiveEntById = new Map<string, SketchEntity>();
                for (const en of otherRoom.entities ?? []) passiveEntById.set(en.id, en);
                const hovEPassive = hoveredEdgeRef.current;
                const isPassiveEdgeHov = (ei: number): boolean =>
                    !!hovEPassive && hovEPassive.polyId === poly.id && hovEPassive.edgeIdx === ei;
                const isPassiveEdgeSel = (ei: number): boolean =>
                    sketchSel.some((s) => s.kind === "edge" && s.polyId === poly.id && s.edgeIdx === ei);
                for (let pei = 0; pei < polyEdgeList.length; pei++) {
                    const [ai, bi] = polyEdgeList[pei];
                    const a = poly.outer[ai], b = poly.outer[bi];
                    const ownerId = poly.edgeOwners?.[pei];
                    const owner = ownerId ? passiveEntById.get(ownerId) : undefined;
                    const selE = isPassiveEdgeSel(pei);
                    const hovEd = !selE && isPassiveEdgeHov(pei);
                    let col: RGBA = inactiveStroke;
                    let width = inactiveStrokeWidth;
                    if (selE) { col = C_HL_ORANGE; width = inactiveStrokeWidth + 1.5; }
                    else if (hovEd) { col = C_EDGE_HOV; width = inactiveStrokeWidth + 1; }
                    if (owner && (owner.kind === "arc" || owner.kind === "circle")) {
                        const cx = owner.center[0], cy = owner.center[1];
                        const r = owner.radius;
                        const ang0 = Math.atan2(a[1] - cy, a[0] - cx);
                        const ang1 = Math.atan2(b[1] - cy, b[0] - cx);
                        let sweep = ang1 - ang0;
                        while (sweep <= -Math.PI) sweep += Math.PI * 2;
                        while (sweep > Math.PI) sweep -= Math.PI * 2;
                        const SUB = 10;
                        let prevX = a[0], prevY = a[1];
                        for (let k = 1; k <= SUB; k++) {
                            const t = k / SUB;
                            const ang = ang0 + sweep * t;
                            const nx = cx + r * Math.cos(ang);
                            const ny = cy + r * Math.sin(ang);
                            lines.push({
                                ax: prevX, az: prevY, bx: nx, bz: ny,
                                color: col, width,
                            });
                            prevX = nx; prevY = ny;
                        }
                    } else {
                        lines.push({
                            ax: a[0], az: a[1], bx: b[0], bz: b[1],
                            color: col, width,
                        });
                    }
                }
                for (const h of poly.holes ?? []) {
                    if (h.length < 2) continue;
                    for (let i = 0; i < h.length; i++) {
                        const a = h[i];
                        const b = h[(i + 1) % h.length];
                        lines.push({
                            ax: a[0], az: a[1], bx: b[0], bz: b[1],
                            color: inactiveStroke, width: inactiveStrokeWidth,
                        });
                    }
                }
            }
        }

        // Detect overlaps (focus polygon vs others) — drives the merge button
        const overlapping = new Set<string>();
        const draggedPolyId = drag && (drag.kind === "poly" || drag.kind === "polyVertex" || drag.kind === "polyEdge") ? drag.polyId : null;
        const focusPolyId = draggedPolyId ?? lastDraggedPolyIdRef.current;
        if (focusPolyId && rm.polygons && rm.polygons.length > 1) {
            const dragged = rm.polygons.find(p => p.id === focusPolyId);
            if (dragged) {
                const dxs = dragged.outer.map(p => p[0]);
                const dys = dragged.outer.map(p => p[1]);
                const dMinX = Math.min(...dxs), dMaxX = Math.max(...dxs);
                const dMinZ = Math.min(...dys), dMaxZ = Math.max(...dys);
                const eps = 1e-6;
                for (const other of rm.polygons) {
                    if (other.id === dragged.id) continue;
                    const oxs = other.outer.map(p => p[0]);
                    const oys = other.outer.map(p => p[1]);
                    const oMinX = Math.min(...oxs), oMaxX = Math.max(...oxs);
                    const oMinZ = Math.min(...oys), oMaxZ = Math.max(...oys);
                    if (dMinX < oMaxX - eps && dMaxX > oMinX + eps &&
                        dMinZ < oMaxZ - eps && dMaxZ > oMinZ + eps) {
                        overlapping.add(other.id);
                    }
                }
                if (overlapping.size > 0) overlapping.add(dragged.id);
            }
        }

        // Polygons
        if (rm.polygons) {
            for (const poly of rm.polygons) {
                const isSel = sel.includes(`poly:${poly.id}`);
                const isHov = hovPolyId === poly.id
                    && hovPolySpaceId === rid
                    && !isSel;
                const isDrg = drag?.kind === "poly" && drag.polyId === poly.id;
                const isOverlap = overlapping.has(poly.id);
                const isCircleSketchSel = poly.shape?.type === "circle" && sketchSel.some(
                    (s) => s.kind === "circle" && s.polyId === poly.id,
                );

                const isWallOutline = !!poly.wallOutlineOf;

                let stroke: RGBA, fill: RGBA, sw: number;
                if (isOverlap) { stroke = C_OVERLAP; fill = C_OVERLAP_FILL; sw = 2.5; }
                else if (isCircleSketchSel) { stroke = C_HL_ORANGE; fill = C_HL_FILL; sw = 2.5; }
                else if (isSel) { stroke = C_RECT_SEL; fill = C_RECT_SEL_FILL; sw = 2.5; }
                else if (isHov) { stroke = C_RECT_HOV; fill = C_RECT_HOV_FILL; sw = 2; }
                else { stroke = C_RECT; fill = C_RECT_FILL; sw = 1.5; }
                // Wall-outline polygons: no fill, thinner stroke, muted colour
                if (isWallOutline) {
                    fill = [0, 0, 0, 0];
                    stroke = isSel ? C_RECT_SEL : rgba(100, 116, 139); // slate-500
                    sw = isSel ? 2 : 1.2;
                }

                const alphaMul = isDrg ? 0.7 : 1.0;
                const fillA: RGBA = [fill[0], fill[1], fill[2], fill[3] * alphaMul];
                const strokeA: RGBA = [stroke[0], stroke[1], stroke[2], stroke[3] * alphaMul];

                // Gray wall slabs — per-edge 6-vertex hexagon
                // (innerPrev / s / outerPrev / outerNext / e / innerNext)
                // computed by `computeWallHexagon`. Inner / outer thickness
                // come from `resolveWallThicknesses(poly)`. Shared walls
                // render only in the canonical owner.
                // 閉じ図形は wallIds.length === outer.length、開いたポリラインは
                // wallIds.length === edges.length。polygonEdges() で統一的に判定。
                // **drag 中は wall slab を描画しない**: drag 中は wall axis を
                // 更新しない方針なので、polygon (オレンジ枠) は移動するが wall
                // footprint は元の位置のまま固定され、視覚的に「離れた残骸」が
                // 残ってしまう。drag 中はその残骸を消し、オレンジ polygon プレ
                // ビューだけ見せる。mouseup で wallRegenerate が走り wall が
                // 新位置に再生成される。
                const isAnyDrag = !!drag;
                const activeEdgeCount = polygonEdges(poly).length;
                if (!isAnyDrag
                    && poly.wallIds && poly.wallIds.length === activeEdgeCount
                    && (poly.wallThickness != null
                        || (poly.innerThickness != null && poly.outerThickness != null))) {
                    const renderedWidsA = new Set<string>();
                    for (let i = 0; i < activeEdgeCount; i++) {
                        // 1 つの polygon edge に複数 wall が紐づく場合 (= cross-poly
                        // overlap で split されたケース) を取りこぼさないよう
                        // wallsPerEdge を優先。未設定なら wallIds[i] にフォールバック。
                        const widList = poly.wallsPerEdge?.[i] ?? [poly.wallIds[i]];
                        for (const wid of widList) {
                            if (!wid) continue;
                            if (!isWallOwner(wid, poly.id)) continue;
                            if (renderedWidsA.has(wid)) continue;
                            renderedWidsA.add(wid);
                            // wall.footprint があれば優先 (= JunctionGraph 確定形状)。
                            // wall.footprint は §7 で全 wall に書かれているので、
                            // ここに来ればほぼ常に this path を通る。
                            const wallEl = els[wid] as WallElement | undefined;
                            if (wallEl?.footprint && wallEl.footprint.length >= 3) {
                                for (const q of buildFootprintSlabQuads(wallEl.footprint, wallEl.footprintHoles)) quads.push(q);
                            } else {
                                for (const q of buildWallSlabQuads(poly, i)) quads.push(q);
                            }
                        }
                    }
                }

                // 仮壁 (provisional wall band) — drawn around the polyline
                // when no walls have been generated yet. Per spec §4 the
                // polyline acts as 壁芯 (wall centre axis), so the band
                // straddles it ±thickness/2.
                const hasConfirmedWalls = !!(poly.wallIds && poly.wallIds.some(Boolean));
                if (!isWallOutline && !hasConfirmedWalls
                    && poly.outer.length >= 3 && isPolygonClosed(poly)) {
                    const half = VIRTUAL_WALL_THICKNESS_M / 2;
                    let cx = 0, cy = 0;
                    for (const p of poly.outer) { cx += p[0]; cy += p[1]; }
                    cx /= poly.outer.length; cy /= poly.outer.length;
                    const axis = poly.outer;
                    const n = axis.length;
                    const outerRing = computeMiteredCorners(axis, [cx, cy], half);
                    const innerRing = computeMiteredCorners(axis, [cx, cy], -half);
                    for (let i = 0; i < n; i++) {
                        const j = (i + 1) % n;
                        quads.push({
                            p0: [innerRing[i][0], innerRing[i][1]],
                            p1: [innerRing[j][0], innerRing[j][1]],
                            p2: [outerRing[j][0], outerRing[j][1]],
                            p3: [outerRing[i][0], outerRing[i][1]],
                            color: C_VIRTUAL_WALL,
                        });
                    }
                }

                // Triangulated fill via earcut — skip for wall outline polygons
                // and for open boundaries (not a room yet; no interior to fill).
                if (!isWallOutline && isPolygonClosed(poly)) {
                    const flat: number[] = [];
                    for (const p of poly.outer) { flat.push(p[0], p[1]); }
                    const holeIdx: number[] = [];
                    for (const h of poly.holes ?? []) {
                        holeIdx.push(flat.length / 2);
                        for (const p of h) flat.push(p[0], p[1]);
                    }
                    const tris = earcut(flat, holeIdx.length > 0 ? holeIdx : undefined, 2);
                    for (let i = 0; i < tris.length; i += 3) {
                        const ai = tris[i] * 2, bi = tris[i + 1] * 2, ci = tris[i + 2] * 2;
                        const a: [number, number] = [flat[ai], flat[ai + 1]];
                        const b: [number, number] = [flat[bi], flat[bi + 1]];
                        const c: [number, number] = [flat[ci], flat[ci + 1]];
                        quads.push({ p0: a, p1: b, p2: c, p3: c, color: fillA });
                    }
                }

                // Sketch selection lookup helpers
                const isVertSel = (vi: number) => sketchSel.some(
                    (s) => s.kind === "point" && s.polyId === poly.id && s.vertexIdx === vi,
                );
                // owner が arc / circle の edge は「弧 1 本」として hover / select
                // を伝播する (= 同じ弧のテッセレーション辺を一括強調)。それ以外
                // (line / polyline) は **該当辺のみ** ハイライトする (= polyline
                // 由来の閉ループでも、ホバー / 選択した辺だけが色付く)。
                const isArcLikeOwner = (ownerId: string | undefined): boolean => {
                    if (!ownerId) return false;
                    const ent = (rm.entities ?? []).find((e) => e.id === ownerId);
                    return !!ent && (ent.kind === "arc" || ent.kind === "circle");
                };
                // edge i は (a) 直接選択 / (b) entity 選択 (arc/circle のみ owner 一致で伝播)
                // のどちらかでハイライト対象になる。
                const isEdgeSel = (ei: number) => {
                    const ownerId = poly.edgeOwners?.[ei];
                    return sketchSel.some((s) => {
                        if (s.kind === "edge") {
                            return s.polyId === poly.id && s.edgeIdx === ei;
                        }
                        if (s.kind === "entity" && ownerId) {
                            // entity 選択は arc/circle entity の場合のみ、その
                            // テッセレーション辺全体を一括ハイライトする。
                            // Polyline / Line entity 選択時は該当辺だけに
                            // 留めたいが、現状 polyline edge クリックは
                            // kind:"edge" 経由なのでここに到達しない。安全に
                            // arc/circle フィルタを追加する。
                            return s.entityId === ownerId && isArcLikeOwner(ownerId);
                        }
                        return false;
                    });
                };
                // 「直接 edge 選択」だけを判定する版。midpoint マーカは
                // Arc / Circle 由来のテッセレーション辺一つひとつには付けたく
                // ないので、エッジ単独選択のときだけ true を返す。
                const isEdgeDirectSel = (ei: number) => sketchSel.some(
                    (s) => s.kind === "edge" && s.polyId === poly.id && s.edgeIdx === ei,
                );
                const hovE = hoveredEdgeRef.current;
                const isEdgeHov = (ei: number) => {
                    if (!hovE) return false;
                    if (hovE.polyId === poly.id && hovE.edgeIdx === ei) return true;
                    // Arc / Circle グループのみ hover を entity 単位で伝播。
                    // Polyline は同じ entity が全辺を所有するので、伝播すると
                    // ホバー時に全辺が点灯してしまうため除外。
                    if (hovE.polyId !== poly.id) return false;
                    const ownerId = poly.edgeOwners?.[ei];
                    const hoveredOwner = poly.edgeOwners?.[hovE.edgeIdx];
                    if (!ownerId || hoveredOwner !== ownerId) return false;
                    return isArcLikeOwner(ownerId);
                };

                // For wall-outline polygons, any edge coincident with a
                // deleted-wall inner edge's line is a "cut" produced by the
                // per-edge wall delete — not an actual wall outer face. Skip
                // drawing it so the outline only shows real wall faces.
                const cutLines: { a: Vec2; b: Vec2 }[] = [];
                if (isWallOutline && poly.wallOutlineOf) {
                    const inner = rm.polygons.find((p) => p.id === poly.wallOutlineOf);
                    if (inner && inner.wallIds && inner.wallIds.length === inner.outer.length) {
                        const innerEdges = polygonEdges(inner);
                        for (let i = 0; i < innerEdges.length; i++) {
                            if (inner.wallIds[i]) continue;
                            const [iai, ibi] = innerEdges[i];
                            cutLines.push({ a: inner.outer[iai], b: inner.outer[ibi] });
                        }
                    }
                }
                const onCutLine = (a: Vec2, b: Vec2): boolean => {
                    if (cutLines.length === 0) return false;
                    const EPS = 1e-6;
                    for (const { a: la, b: lb } of cutLines) {
                        const dx = lb[0] - la[0], dy = lb[1] - la[1];
                        const len = Math.hypot(dx, dy) || 1;
                        const nx = -dy / len, ny = dx / len;
                        const d1 = Math.abs((a[0] - la[0]) * nx + (a[1] - la[1]) * ny);
                        const d2 = Math.abs((b[0] - la[0]) * nx + (b[1] - la[1]) * ny);
                        if (d1 < EPS && d2 < EPS) return true;
                    }
                    return false;
                };

                // Outer edges (explicit edge list — may be open / non-cyclic)
                // Arc / Circle entity 由来のエッジは「分割線」(= 多数の chord
                // 線分の集まり) ではなく、エンティティのパラメトリック形式
                // (= center / radius / aStart / aEnd) を使って **滑らかな弧**
                // として描画する。各 polygon edge をその chord 部分に対応する
                // 角度範囲で 10 分割し、円周上のサブ点を結ぶ細かい線分に展開
                // することで、視覚的に分割の継ぎ目を消す。
                const polyEdgeList = polygonEdges(poly);
                const n = poly.outer.length;
                const entById = new Map<string, SketchEntity>();
                for (const en of rm.entities ?? []) entById.set(en.id, en);
                for (let i = 0; i < polyEdgeList.length; i++) {
                    const [ai, bi] = polyEdgeList[i];
                    const a = poly.outer[ai];
                    const b = poly.outer[bi];
                    if (onCutLine(a, b)) continue;
                    const selE = isEdgeSel(i);
                    const hovEd = !selE && isEdgeHov(i);
                    let col: RGBA = strokeA;
                    let width = sw;
                    if (selE) { col = C_HL_ORANGE; width = sw + 1.5; }
                    else if (hovEd) { col = C_EDGE_HOV; width = sw + 1; }
                    // wallSkips: edge[i] に skip があれば、未スキップ範囲を通常
                    // ストロークで、スキップ範囲を dashed gray で描画する
                    // (= 「ここの 3D 壁は出ない」ことを 2D で可視化)。
                    const keptRanges = unskippedRanges(poly.wallSkips, i);
                    const hasSkip = !(keptRanges.length === 1
                        && keptRanges[0][0] === 0 && keptRanges[0][1] === 1);
                    const skipRanges = hasSkip ? complementRanges01(keptRanges) : [];
                    // Arc / Circle 所有 edge: 端点 a, b を arc.center 基準で
                    // 角度に変換し、その範囲を細分化して滑らかな弧として描画。
                    const ownerId = poly.edgeOwners?.[i];
                    const owner = ownerId ? entById.get(ownerId) : undefined;
                    if (owner && (owner.kind === "arc" || owner.kind === "circle")) {
                        const cx = owner.center[0];
                        const cy = owner.center[1];
                        const r = owner.kind === "arc" ? owner.radius : owner.radius;
                        const ang0 = Math.atan2(a[1] - cy, a[0] - cx);
                        const ang1 = Math.atan2(b[1] - cy, b[0] - cx);
                        // CCW 方向に短い側 (= chord セグメントが対応する arc 弧)
                        // を選ぶ。差を [0, 2π) に正規化して、π を超えたら逆向き。
                        let sweep = ang1 - ang0;
                        while (sweep <= -Math.PI) sweep += Math.PI * 2;
                        while (sweep > Math.PI) sweep -= Math.PI * 2;
                        const drawArcRange = (
                            t0: number, t1: number,
                            color: RGBA, w: number,
                            dash?: number, dashRatio?: number,
                        ) => {
                            const SUB = Math.max(2, Math.round(10 * (t1 - t0)));
                            let prevX = cx + r * Math.cos(ang0 + sweep * t0);
                            let prevY = cy + r * Math.sin(ang0 + sweep * t0);
                            for (let k = 1; k <= SUB; k++) {
                                const t = t0 + (t1 - t0) * (k / SUB);
                                const ang = ang0 + sweep * t;
                                const nx = cx + r * Math.cos(ang);
                                const ny = cy + r * Math.sin(ang);
                                lines.push({
                                    ax: prevX, az: prevY, bx: nx, bz: ny,
                                    color, width: w, dash, dashRatio,
                                });
                                prevX = nx; prevY = ny;
                            }
                        };
                        for (const [t0, t1] of keptRanges) {
                            drawArcRange(t0, t1, col, width);
                        }
                        for (const [t0, t1] of skipRanges) {
                            drawArcRange(t0, t1, C_WALL_SKIP, Math.max(1, sw - 0.5), 6, 0.5);
                        }
                    } else {
                        const drawSeg = (
                            t0: number, t1: number,
                            color: RGBA, w: number,
                            dash?: number, dashRatio?: number,
                        ) => {
                            const x0 = a[0] + (b[0] - a[0]) * t0;
                            const y0 = a[1] + (b[1] - a[1]) * t0;
                            const x1 = a[0] + (b[0] - a[0]) * t1;
                            const y1 = a[1] + (b[1] - a[1]) * t1;
                            lines.push({
                                ax: x0, az: y0, bx: x1, bz: y1,
                                color, width: w, dash, dashRatio,
                            });
                        };
                        for (const [t0, t1] of keptRanges) {
                            drawSeg(t0, t1, col, width);
                        }
                        for (const [t0, t1] of skipRanges) {
                            drawSeg(t0, t1, C_WALL_SKIP, Math.max(1, sw - 0.5), 6, 0.5);
                        }
                    }
                }
                // wallSkips の境界点 (= 切断 t0 / t1) に小さなマーカを表示。
                // 完全削除 (t0=0, t1=1) では端点が outer 頂点と重なるのでマーカ
                // 重複は許容 (= 同位置に頂点ハンドル + skip マーカが重なる)。
                if (poly.wallSkips && poly.wallSkips.length > 0) {
                    const entByIdM = entById; // alias
                    for (const skip of poly.wallSkips) {
                        const ei = skip.edgeIdx;
                        if (ei < 0 || ei >= polyEdgeList.length) continue;
                        const [ai, bi] = polyEdgeList[ei];
                        const a = poly.outer[ai];
                        const b = poly.outer[bi];
                        const ownerId = poly.edgeOwners?.[ei];
                        const owner = ownerId ? entByIdM.get(ownerId) : undefined;
                        const tPair: [number, number] = [skip.t0, skip.t1];
                        for (const t of tPair) {
                            // 0 or 1 (= 端点) は既に polygon 頂点ハンドルが
                            // 描画されているのでマーカ重複を避ける。
                            if (t <= 1e-6 || t >= 1 - 1e-6) continue;
                            const tc = Math.max(0, Math.min(1, t));
                            let wx: number, wz: number;
                            if (owner && (owner.kind === "arc" || owner.kind === "circle")) {
                                const cx = owner.center[0];
                                const cy = owner.center[1];
                                const r = owner.kind === "arc" ? owner.radius : owner.radius;
                                const ang0 = Math.atan2(a[1] - cy, a[0] - cx);
                                const ang1 = Math.atan2(b[1] - cy, b[0] - cx);
                                let sweep = ang1 - ang0;
                                while (sweep <= -Math.PI) sweep += Math.PI * 2;
                                while (sweep > Math.PI) sweep -= Math.PI * 2;
                                const ang = ang0 + sweep * tc;
                                wx = cx + r * Math.cos(ang);
                                wz = cy + r * Math.sin(ang);
                            } else {
                                wx = a[0] + (b[0] - a[0]) * tc;
                                wz = a[1] + (b[1] - a[1]) * tc;
                            }
                            markers.push({
                                wx, wz, radius: 3.5, shape: "circle",
                                fill: rgba(55, 65, 81), stroke: C_WHITE, strokeWidth: 1.2,
                            });
                        }
                    }
                }

                // Holes (outline only, no per-vertex constraint targets)
                for (const h of poly.holes ?? []) {
                    if (h.length < 2) continue;
                    for (let i = 0; i < h.length; i++) {
                        const a = h[i];
                        const b = h[(i + 1) % h.length];
                        lines.push({ ax: a[0], az: a[1], bx: b[0], bz: b[1], color: strokeA, width: sw });
                    }
                }

                // Outer ring vertex handles — hidden for parametric circles
                // and for arc-interior vertices (tessellation artifacts after
                // polygon merges with a circle).
                //
                // walled inner polygon: 白いストロークリングは付けるが、wall slab
                //   (中明度グレー) に対してコーナーが「欠けて」見えないように
                //   塗りはコーナー色 (slate-700) のまま、リングはやや細めにする。
                // wall outline polygon: ストロークリング無し (元仕様)。
                const isCircle = poly.shape?.type === "circle";
                const hasWalls = !!(poly.wallIds && poly.wallIds.some(Boolean));
                if (!isCircle) {
                    for (let i = 0; i < n; i++) {
                        if (isCurveInteriorVertex(poly, i)) continue; // 弧/円の途中点はハンドルを出さない
                        // edgeOwners ベースの判定 (= isCurveInteriorVertex) で
                        // 「弧/円の途中点」は既に除外済み。残った near-180° の
                        // 頂点は壁トリムの切断点など意図的に挿入した実頂点なので
                        // ハンドルを出す。`isArcVertex` の角度ヒューリスティックは
                        // edgeOwners が無い旧データに対してのみフォールバックで使う。
                        if (!poly.edgeOwners && isArcVertex(poly.outer, i)) continue;
                        const [wx, wz] = poly.outer[i];
                        const isCh = hovPVtx?.polyId === poly.id && hovPVtx.vertexIdx === i;
                        const selP = isVertSel(i);
                        const radius = selP ? 5.5 : (isCh ? 5 : (isSel || isHov ? 3.5 : 2.5));
                        const baseFill: RGBA = hasWalls || isWallOutline ? rgba(55, 65, 81) : stroke;
                        const fillC: RGBA = selP ? C_HL_ORANGE
                            : isCh ? C_HL_ORANGE
                            : isSel ? C_RECT_SEL
                            : baseFill;
                        // wall outline polygon は元仕様通りストロークなし。それ以外
                        // (= 通常 / walled inner) は白リングを付けて hit target が
                        // 視認できるようにする。
                        const noRing = isWallOutline;
                        markers.push({
                            wx, wz, radius, shape: "circle",
                            fill: fillC,
                            stroke: noRing ? ([0, 0, 0, 0] as RGBA) : C_WHITE,
                            strokeWidth: noRing ? 0 : (selP ? 1.8 : 1),
                        });
                    }
                }
                // Edge midpoint markers — only for **direct** edge selection.
                // Arc / Circle entity 選択時は数十個のテッセレーション辺すべてに
                // マーカが付いてしまうため除外し、代わりに別ループで center /
                // endpoint マーカを追加する (= 「弧、円で扱う」見た目)。
                for (let i = 0; i < polyEdgeList.length; i++) {
                    if (!isEdgeDirectSel(i)) continue;
                    const [ai, bi] = polyEdgeList[i];
                    const a = poly.outer[ai];
                    const b = poly.outer[bi];
                    markers.push({
                        wx: (a[0] + b[0]) / 2, wz: (a[1] + b[1]) / 2,
                        radius: 5, shape: "square",
                        fill: C_HL_ORANGE, stroke: C_WHITE, strokeWidth: 1.5,
                    });
                }
            }
        }

        // Selected arc / circle entity → 中心 + 端点マーカ。
        // tessellation 辺ごとに square を出すのではなく、エンティティのパラメ
        // トリック値 (center / radius / aStart / aEnd) を使って 1 つの「弧、
        // 円」として強調する。
        if (rm.entities && rm.entities.length > 0) {
            const selEntities = sketchSel.filter(
                (s): s is Extract<typeof s, { kind: "entity" }> => s.kind === "entity",
            );
            const selCircles = sketchSel.filter(
                (s): s is Extract<typeof s, { kind: "circle" }> => s.kind === "circle",
            );
            // entity-selected ids
            const selEntityIds = new Set(selEntities.map((s) => s.entityId));
            // 「kind: circle」で選択された polygon に対応する entity も拾う
            // (= polyIdByEntity の逆引き)。
            const map = rm.polyIdByEntity ?? {};
            for (const c of selCircles) {
                for (const eid in map) {
                    if (map[eid] === c.polyId) selEntityIds.add(eid);
                }
            }
            for (const ent of rm.entities) {
                if (!selEntityIds.has(ent.id)) continue;
                if (ent.kind === "arc") {
                    // center marker (diamond)
                    markers.push({
                        wx: ent.center[0], wz: ent.center[1],
                        radius: 4, shape: "diamond",
                        fill: C_HL_ORANGE, stroke: C_WHITE, strokeWidth: 1.4,
                    });
                    // endpoints (square)
                    const sx = ent.center[0] + ent.radius * Math.cos(ent.aStart);
                    const sz = ent.center[1] + ent.radius * Math.sin(ent.aStart);
                    const ex = ent.center[0] + ent.radius * Math.cos(ent.aEnd);
                    const ez = ent.center[1] + ent.radius * Math.sin(ent.aEnd);
                    markers.push({
                        wx: sx, wz: sz, radius: 4, shape: "square",
                        fill: C_HL_ORANGE, stroke: C_WHITE, strokeWidth: 1.2,
                    });
                    markers.push({
                        wx: ex, wz: ez, radius: 4, shape: "square",
                        fill: C_HL_ORANGE, stroke: C_WHITE, strokeWidth: 1.2,
                    });
                } else if (ent.kind === "circle") {
                    markers.push({
                        wx: ent.center[0], wz: ent.center[1],
                        radius: 4, shape: "diamond",
                        fill: C_HL_ORANGE, stroke: C_WHITE, strokeWidth: 1.4,
                    });
                }
            }
        }

        // Temp rect (while drawing)
        const mode = roomEditModeRef.current;
        const rs = rectStartRef.current;
        const mw = mouseWorldRef.current;
        if (mode === "rectangle" && rs && mw) {
            const minX = Math.min(rs[0], mw[0]);
            const maxX = Math.max(rs[0], mw[0]);
            const minZ = Math.min(rs[1], mw[1]);
            const maxZ = Math.max(rs[1], mw[1]);
            quads.push({
                p0: [minX, minZ], p1: [maxX, minZ],
                p2: [maxX, maxZ], p3: [minX, maxZ],
                color: C_TEMP_FILL,
            });
            const w = 1.5;
            const dash = 6, dashR = 0.55;
            lines.push({ ax: minX, az: minZ, bx: maxX, bz: minZ, color: C_TEMP, width: w, dash, dashRatio: dashR });
            lines.push({ ax: maxX, az: minZ, bx: maxX, bz: maxZ, color: C_TEMP, width: w, dash, dashRatio: dashR });
            lines.push({ ax: maxX, az: maxZ, bx: minX, bz: maxZ, color: C_TEMP, width: w, dash, dashRatio: dashR });
            lines.push({ ax: minX, az: maxZ, bx: minX, bz: minZ, color: C_TEMP, width: w, dash, dashRatio: dashR });
        }

        // Circle draft (while drawing)
        if (mode === "circle") {
            const cc = circleCenterRef.current;
            const cursor = mw;
            if (cc && cursor) {
                const r = Math.hypot(cursor[0] - cc[0], cursor[1] - cc[1]);
                if (r > 1e-4) {
                    const N = 96;
                    for (let i = 0; i < N; i++) {
                        const a0 = (i / N) * Math.PI * 2;
                        const a1 = ((i + 1) / N) * Math.PI * 2;
                        lines.push({
                            ax: cc[0] + Math.cos(a0) * r, az: cc[1] + Math.sin(a0) * r,
                            bx: cc[0] + Math.cos(a1) * r, bz: cc[1] + Math.sin(a1) * r,
                            color: C_TEMP, width: 1.5,
                        });
                    }
                    // Radius leg (dashed)
                    lines.push({
                        ax: cc[0], az: cc[1], bx: cursor[0], bz: cursor[1],
                        color: C_TEMP, width: 1, dash: 6, dashRatio: 0.4,
                    });
                }
                markers.push({
                    wx: cc[0], wz: cc[1], radius: 4, shape: "circle",
                    fill: C_TEMP, stroke: C_WHITE, strokeWidth: 1.2,
                });
            }
        }

        // arcEdge draft: chord (= 選択エッジ) と現在の円弧プレビューを描画。
        if (mode === "arcEdge") {
            const ch = arcEdgeChordRef.current;
            const cursor = mw;
            if (ch) {
                // chord 自体を実線で強調。
                lines.push({
                    ax: ch.p0[0], az: ch.p0[1], bx: ch.p1[0], bz: ch.p1[1],
                    color: C_TEMP, width: 2,
                });
                if (cursor) {
                    const arc = arcFromChordAndCursor(
                        ch.p0, ch.p1, [cursor[0], cursor[1]],
                    );
                    if (arc) {
                        // sweep を CCW で計算 (aStart→aEnd) して N 分割で線分化。
                        let sweep = arc.aEnd - arc.aStart;
                        while (sweep <= 0) sweep += Math.PI * 2;
                        while (sweep > Math.PI * 2) sweep -= Math.PI * 2;
                        const N = Math.max(16, Math.ceil((sweep * arc.radius) / 0.05));
                        let prev: Vec2 = [
                            arc.center[0] + arc.radius * Math.cos(arc.aStart),
                            arc.center[1] + arc.radius * Math.sin(arc.aStart),
                        ];
                        for (let i = 1; i <= N; i++) {
                            const a = arc.aStart + sweep * (i / N);
                            const next: Vec2 = [
                                arc.center[0] + arc.radius * Math.cos(a),
                                arc.center[1] + arc.radius * Math.sin(a),
                            ];
                            lines.push({
                                ax: prev[0], az: prev[1], bx: next[0], bz: next[1],
                                color: C_TEMP, width: 1.5,
                            });
                            prev = next;
                        }
                    }
                    // chord 中点 → cursor の補助線 (破線)。
                    const mx = (ch.p0[0] + ch.p1[0]) / 2;
                    const my = (ch.p0[1] + ch.p1[1]) / 2;
                    lines.push({
                        ax: mx, az: my, bx: cursor[0], bz: cursor[1],
                        color: C_TEMP, width: 1, dash: 6, dashRatio: 0.4,
                    });
                }
                // chord 端点マーカー。
                markers.push({
                    wx: ch.p0[0], wz: ch.p0[1], radius: 4, shape: "circle",
                    fill: C_TEMP, stroke: C_WHITE, strokeWidth: 1.2,
                });
                markers.push({
                    wx: ch.p1[0], wz: ch.p1[1], radius: 4, shape: "circle",
                    fill: C_TEMP, stroke: C_WHITE, strokeWidth: 1.2,
                });
            }
        }

        // Line draft (while drawing). 1 点目クリック後、カーソルまでの直線を
        // 破線でプレビュー。確定すると LineEntity として commit される。
        if (mode === "line") {
            const ls = lineStartRef.current;
            if (ls && mw) {
                lines.push({
                    ax: ls[0], az: ls[1], bx: mw[0], bz: mw[1],
                    color: C_TEMP, width: 1.5, dash: 6, dashRatio: 0.55,
                });
                markers.push({
                    wx: ls[0], wz: ls[1], radius: 4, shape: "circle",
                    fill: C_TEMP, stroke: C_WHITE, strokeWidth: 1.2,
                });
            }
        }

        // Arc draft (3 クリック制 = 弦 P0 → 弦 P1 → bulge カーソル)。
        //   step 1 → step 2: P0 → cursor の破線 (= 弦候補)。
        //   step 2 → step 3: P0—P1 の弦実線 + arcFromChordAndCursor の弧プレビュー。
        if (mode === "arc") {
            const p0 = arcChordP0Ref.current;
            const p1 = arcChordP1Ref.current;
            if (p0 && mw) {
                if (!p1) {
                    // step 1 → step 2: P0 → cursor を弦候補として破線で見せる。
                    lines.push({
                        ax: p0[0], az: p0[1], bx: mw[0], bz: mw[1],
                        color: C_TEMP, width: 1, dash: 6, dashRatio: 0.55,
                    });
                } else {
                    // step 2 → step 3: 弦確定。P0—P1 を実線、cursor 側を通る弧を実線で描く。
                    lines.push({
                        ax: p0[0], az: p0[1], bx: p1[0], bz: p1[1],
                        color: C_TEMP, width: 1.5,
                    });
                    const arc = arcFromChordAndCursor(p0, p1, [mw[0], mw[1]]);
                    if (arc) {
                        let sweep = arc.aEnd - arc.aStart;
                        while (sweep <= 0) sweep += Math.PI * 2;
                        while (sweep > Math.PI * 2) sweep -= Math.PI * 2;
                        const M = Math.max(16, Math.ceil((sweep * arc.radius) / 0.05));
                        let prev: Vec2 = [
                            arc.center[0] + arc.radius * Math.cos(arc.aStart),
                            arc.center[1] + arc.radius * Math.sin(arc.aStart),
                        ];
                        for (let i = 1; i <= M; i++) {
                            const a = arc.aStart + sweep * (i / M);
                            const next: Vec2 = [
                                arc.center[0] + arc.radius * Math.cos(a),
                                arc.center[1] + arc.radius * Math.sin(a),
                            ];
                            lines.push({
                                ax: prev[0], az: prev[1], bx: next[0], bz: next[1],
                                color: C_TEMP, width: 1.5,
                            });
                            prev = next;
                        }
                    }
                    // 弦中点 → cursor の補助線 (= bulge を視覚化)。
                    const mx = (p0[0] + p1[0]) / 2;
                    const my = (p0[1] + p1[1]) / 2;
                    lines.push({
                        ax: mx, az: my, bx: mw[0], bz: mw[1],
                        color: C_TEMP, width: 1, dash: 6, dashRatio: 0.4,
                    });
                    // 弦端点マーカ
                    markers.push({
                        wx: p1[0], wz: p1[1], radius: 4, shape: "circle",
                        fill: C_TEMP, stroke: C_WHITE, strokeWidth: 1.2,
                    });
                }
                // P0 マーカ (常に出す)
                markers.push({
                    wx: p0[0], wz: p0[1], radius: 4, shape: "circle",
                    fill: C_TEMP, stroke: C_WHITE, strokeWidth: 1.2,
                });
            }
        }

        // Trim draft の視覚フィードバック:
        //   stage 1: target が選ばれていなければ何も追加描画しない
        //            (= ユーザは円/弧をクリックして picked にする)
        //   stage 2 (target picked、trimFirstPoint 未): target をオレンジで強調 +
        //            cursor を target 上に projection した点に小さなマーカを表示
        //   stage 3 (target picked + trimFirstPoint set): 上記に加え、
        //            firstPoint マーカ + 「first → cursor の CCW 弧」をプレビュー
        //            (= 切断後に残る側を破線で見せる)
        if (mode === "trim") {
            const targetId = trimTargetEntityIdRef.current;
            const firstPt = trimFirstPointRef.current;
            const target = targetId
                ? (rm.entities ?? []).find((e) => e.id === targetId)
                : undefined;
            if (target && (target.kind === "circle" || target.kind === "arc")) {
                const cx = target.center[0];
                const cy = target.center[1];
                const r = target.radius;
                // 1) Target を C_HL_ORANGE で太線描画 (= 選択強調)。
                //    Circle は全周、Arc は aStart→aEnd の sweep のみ。
                const aStart = target.kind === "circle" ? 0 : target.aStart;
                let sweep = target.kind === "circle"
                    ? Math.PI * 2
                    : target.aEnd - target.aStart;
                while (sweep <= 0) sweep += Math.PI * 2;
                const segs = Math.max(32, Math.ceil(sweep * 32 / (Math.PI / 2)));
                let prev: Vec2 = [
                    cx + r * Math.cos(aStart),
                    cy + r * Math.sin(aStart),
                ];
                for (let i = 1; i <= segs; i++) {
                    const a = aStart + sweep * (i / segs);
                    const next: Vec2 = [
                        cx + r * Math.cos(a),
                        cy + r * Math.sin(a),
                    ];
                    lines.push({
                        ax: prev[0], az: prev[1], bx: next[0], bz: next[1],
                        color: C_HL_ORANGE, width: 2.5,
                    });
                    prev = next;
                }
                // 2) cursor を target 円周上に projection した位置 (= スナップ
                //    ヒント) を緑マーカで示す。projected = center + r * normalize(cursor - center)。
                if (mw) {
                    const dx = mw[0] - cx;
                    const dy = mw[1] - cy;
                    const len = Math.hypot(dx, dy);
                    if (len > 1e-6) {
                        const px = cx + r * dx / len;
                        const py = cy + r * dy / len;
                        markers.push({
                            wx: px, wz: py, radius: 5, shape: "circle",
                            fill: C_TEMP, stroke: C_WHITE, strokeWidth: 1.5,
                        });
                        // 3) firstPoint があれば、firstPoint → cursor projection の
                        //    CCW 弧を破線でプレビュー (= 切断後に残る側)。
                        if (firstPt) {
                            const a1 = Math.atan2(firstPt[1] - cy, firstPt[0] - cx);
                            const a2 = Math.atan2(py - cy, px - cx);
                            let prevSweep = a2 - a1;
                            while (prevSweep <= 0) prevSweep += Math.PI * 2;
                            const previewSegs = Math.max(16, Math.ceil(prevSweep * 32 / (Math.PI / 2)));
                            let pv: Vec2 = [
                                cx + r * Math.cos(a1),
                                cy + r * Math.sin(a1),
                            ];
                            for (let i = 1; i <= previewSegs; i++) {
                                const a = a1 + prevSweep * (i / previewSegs);
                                const nx: Vec2 = [
                                    cx + r * Math.cos(a),
                                    cy + r * Math.sin(a),
                                ];
                                lines.push({
                                    ax: pv[0], az: pv[1], bx: nx[0], bz: nx[1],
                                    color: C_TEMP, width: 2,
                                    dash: 8, dashRatio: 0.55,
                                });
                                pv = nx;
                            }
                        }
                    }
                }
                // 4) firstPoint マーカ (= 1 つ目の切断点)。
                if (firstPt) {
                    markers.push({
                        wx: firstPt[0], wz: firstPt[1], radius: 5, shape: "circle",
                        fill: C_HL_ORANGE, stroke: C_WHITE, strokeWidth: 1.5,
                    });
                }
            }
        }

        // wallSkip ピックモード: 対象 edge を強調 + 1 点目 / cursor 投影点を
        // マーカで表示 + (1 点目があれば) 1 点目 → cursor の区間を破線赤で
        // プレビュー。確定すると polygon.wallSkips に push されて 3D 壁が消える。
        if (mode === "wallSkip") {
            const draft = wallSkipDraftRef.current;
            // Stage 1: edge 未選択。hoveredEdge があれば対象候補としてオレンジ
            // 強調を出して「これをクリックすれば対象になる」ことを示唆。
            if (!draft) {
                const hov = hoveredEdgeRef.current;
                if (hov) {
                    const sp = elementsRef.current[activeRoomIdRef.current ?? ""] as SpaceElement | undefined;
                    const poly = sp?.polygons?.find((p) => p.id === hov.polyId);
                    if (poly) {
                        const edges = polygonEdges(poly);
                        if (hov.edgeIdx >= 0 && hov.edgeIdx < edges.length) {
                            const [ai, bi] = edges[hov.edgeIdx];
                            const a = poly.outer[ai];
                            const b = poly.outer[bi];
                            lines.push({
                                ax: a[0], az: a[1], bx: b[0], bz: b[1],
                                color: C_WALL_SKIP_PICK, width: 2.5,
                                dash: 6, dashRatio: 0.5,
                            });
                        }
                    }
                }
            }
            if (draft) {
                const sp = elementsRef.current[draft.spaceId] as SpaceElement | undefined;
                const poly = sp?.polygons?.find((p) => p.id === draft.polyId);
                if (poly) {
                    const edges = polygonEdges(poly);
                    if (draft.edgeIdx >= 0 && draft.edgeIdx < edges.length) {
                        const [eai, ebi] = edges[draft.edgeIdx];
                        const a = poly.outer[eai];
                        const b = poly.outer[ebi];
                        const dx = b[0] - a[0], dy = b[1] - a[1];
                        const len2 = dx * dx + dy * dy;
                        // edge 自体をオレンジで強調 (= 「これを編集中」)。
                        lines.push({
                            ax: a[0], az: a[1], bx: b[0], bz: b[1],
                            color: C_HL_ORANGE, width: 2.5,
                        });
                        // cursor を edge 上に projection した点 t_cur。
                        let tCur: number | null = null;
                        if (mw && len2 > 1e-12) {
                            tCur = Math.max(
                                0,
                                Math.min(1, ((mw[0] - a[0]) * dx + (mw[1] - a[1]) * dy) / len2),
                            );
                        }
                        if (tCur !== null) {
                            const px = a[0] + dx * tCur;
                            const py = a[1] + dy * tCur;
                            markers.push({
                                wx: px, wz: py, radius: 5, shape: "circle",
                                fill: C_WALL_SKIP_PICK, stroke: C_WHITE, strokeWidth: 1.5,
                            });
                        }
                        // 1 点目マーカ + プレビュー線。
                        if (draft.t0 !== null) {
                            const t0 = draft.t0;
                            const fx = a[0] + dx * t0;
                            const fy = a[1] + dy * t0;
                            markers.push({
                                wx: fx, wz: fy, radius: 5, shape: "circle",
                                fill: C_WALL_SKIP_PICK, stroke: C_WHITE, strokeWidth: 1.5,
                            });
                            if (tCur !== null && Math.abs(tCur - t0) > 1e-4) {
                                const lo = Math.min(t0, tCur);
                                const hi = Math.max(t0, tCur);
                                lines.push({
                                    ax: a[0] + dx * lo, az: a[1] + dy * lo,
                                    bx: a[0] + dx * hi, bz: a[1] + dy * hi,
                                    color: C_WALL_SKIP_PICK, width: 3,
                                    dash: 6, dashRatio: 0.5,
                                });
                            }
                        }
                    }
                }
            }
        }

        // Polyline / wallPath draft (while drawing). wallPath は閉じないので
        // close leg のヒントを描かない。
        if (mode === "polyline" || mode === "wallPath") {
            const pts = polyDraftPointsRef.current;
            const cursor = mw;

            // ── 45° ポーラーガイド線 (wallPath のみ、1点以上確定後) ──────
            if (mode === "wallPath" && pts.length > 0) {
                const last = pts[pts.length - 1];
                const POLAR_STEP = Math.PI / 4;
                const POLAR_TOL  = 10 * Math.PI / 180; // ±10°
                const GUIDE_LEN  = 200; // world meters — クリッピングされる

                // カーソルから最近接レイを判定してハイライト
                let activeIdx = -1;
                if (cursor) {
                    const dx = cursor[0] - last[0];
                    const dz = cursor[1] - last[1];
                    if (Math.hypot(dx, dz) > 0.05) {
                        const raw = Math.atan2(dz, dx);
                        const nearest = Math.round(raw / POLAR_STEP);
                        let diff = raw - nearest * POLAR_STEP;
                        while (diff >  Math.PI) diff -= Math.PI * 2;
                        while (diff < -Math.PI) diff += Math.PI * 2;
                        if (Math.abs(diff) < POLAR_TOL) {
                            activeIdx = ((nearest % 8) + 8) % 8;
                        }
                    }
                }

                for (let i = 0; i < 8; i++) {
                    const angle  = i * POLAR_STEP;
                    const isActive = i === activeIdx;
                    lines.push({
                        ax: last[0], az: last[1],
                        bx: last[0] + Math.cos(angle) * GUIDE_LEN,
                        bz: last[1] + Math.sin(angle) * GUIDE_LEN,
                        color: isActive ? C_POLAR_ACTIVE : C_POLAR_GUIDE,
                        width: isActive ? 1.0 : 0.7,
                        dash: isActive ? 5 : 8,
                        dashRatio: 0.45,
                    });
                }
            }

            // Solid committed segments
            for (let i = 0; i < pts.length - 1; i++) {
                lines.push({
                    ax: pts[i][0], az: pts[i][1],
                    bx: pts[i + 1][0], bz: pts[i + 1][1],
                    color: C_TEMP, width: 1.8,
                });
            }
            // Cursor leg (dashed) + optional close leg (dashed, dimmer) when ≥3 pts
            if (pts.length > 0 && cursor) {
                const last = pts[pts.length - 1];
                lines.push({
                    ax: last[0], az: last[1],
                    bx: cursor[0], bz: cursor[1],
                    color: C_TEMP, width: 1.5, dash: 6, dashRatio: 0.55,
                });
                if (mode === "polyline" && pts.length >= 3) {
                    const first = pts[0];
                    lines.push({
                        ax: cursor[0], az: cursor[1],
                        bx: first[0], bz: first[1],
                        color: C_TEMP, width: 1, dash: 6, dashRatio: 0.35,
                    });
                }
            }
            // Committed vertex markers
            for (let i = 0; i < pts.length; i++) {
                markers.push({
                    wx: pts[i][0], wz: pts[i][1], radius: 4, shape: "circle",
                    fill: C_TEMP, stroke: C_WHITE, strokeWidth: 1.2,
                });
            }
        }

        // Vertex highlight (diamond) — hover or active drag
        let highlight: { wx: number; wz: number } | null = hovPVtx ? { wx: hovPVtx.wx, wz: hovPVtx.wz } : null;
        if (drag && drag.kind === "polyVertex") {
            const pp = rm.polygons?.find(p => p.id === drag.polyId);
            if (pp && pp.outer[drag.vertexIdx]) {
                const [wx, wz] = pp.outer[drag.vertexIdx];
                highlight = { wx, wz };
            } else {
                highlight = null;
            }
        }
        if (highlight) {
            markers.push({
                wx: highlight.wx, wz: highlight.wz,
                radius: 8, shape: "diamond",
                fill: C_HL_FILL, stroke: C_HL_ORANGE, strokeWidth: 2,
            });
        }

        // Midpoint symbol that follows the currently dragged edge (hover uses
        // the full-edge stroke highlight instead — see edge loop above)
        const edgeDragInfo: { wx: number; wz: number } | null = (() => {
            if (!drag || drag.kind !== "polyEdge") return null;
            const pp = rm.polygons?.find(p => p.id === drag.polyId);
            if (!pp) return null;
            const n = pp.outer.length;
            const i = drag.edgeIdx;
            const j = (i + 1) % n;
            return { wx: (pp.outer[i][0] + pp.outer[j][0]) / 2, wz: (pp.outer[i][1] + pp.outer[j][1]) / 2 };
        })();
        if (edgeDragInfo) {
            markers.push({
                wx: edgeDragInfo.wx, wz: edgeDragInfo.wz,
                radius: 6, shape: "square",
                fill: C_HL_ORANGE, stroke: C_WHITE, strokeWidth: 1.5,
            });
        }

        const snapInfo = gridSnapInfoRef.current;
        if (snapInfo) {
            const [sx, sz] = snapInfo.point;
            // axis 整列のみガイド線を追加描画。マーカー本体は SNAP_MARKER_STYLES
            // の表 (../snapStyle.ts) から kind 別に色 / 形状を引く。
            if (snapInfo.kind === "axis") {
                if (snapInfo.refH) {
                    lines.push({
                        ax: snapInfo.refH[0], az: snapInfo.refH[1],
                        bx: sx, bz: sz,
                        color: C_SNAP_AXIS, width: 1,
                    });
                }
                if (snapInfo.refV) {
                    lines.push({
                        ax: snapInfo.refV[0], az: snapInfo.refV[1],
                        bx: sx, bz: sz,
                        color: C_SNAP_AXIS, width: 1,
                    });
                }
            }
            const style = SNAP_MARKER_STYLES[snapInfo.kind];
            markers.push({
                wx: sx, wz: sz,
                radius: style.radius,
                shape: style.shape,
                fill: style.fillRgba,
                stroke: style.strokeRgba,
                strokeWidth: style.strokeWidth,
            });
        }

        return { lines, quads, markers };
    }

    /**
     * `realtimeWallGen` が ON のときだけ全壁再生成を呼ぶラッパ。
     * 図形コミット後 (rect / polyline closed / circle / wallPath) や、ポリゴン
     * の頂点・辺・移動ドラッグ完了後に呼ぶ。最新 store から値を読むので、
     * ヘルパー宣言時点での realtimeWallGen の値はキャプチャしない。
     *
     * `seedPolyIds` を渡すと、その polygon の影響範囲 (AABB 交差 + 共線辺
     * 重なり、または既存共通壁を共有) だけを再構築する。無関係な部屋の壁は
     * 温存される。未指定なら全部屋を再生成 (= 「全壁生成」ボタンと同等)。
     */
    const maybeRealtimeRegenWalls = (reason: string, seedPolyIds?: string[]) => {
        const s = useAppState.getState();
        if (!s.realtimeWallGen) return;
        regenerateAllWalls({
            wallThicknessMm: s.wallThicknessMm,
            circleWallAngleDeg: s.circleWallAngleDeg,
            wallReferenceMode: s.wallReferenceMode,
            seedPolyIds,
        });
    };

    /**
     * 壁トリム (= 部分削除) の確定処理。エッジを **3 つのサブエッジ** に分割
     * した上で中央サブエッジに full-skip を貼る。サブエッジ境界の点は polygon
     * の通常頂点として材料化されるので、ドラッグ・距離拘束・グリッドスナップ
     * がすべて使える。
     *
     * 処理:
     *   1. 元 SketchEntity (line / polyline) を T0/T1 で 3 分割 (= entity の
     *      points 配列に 2 点挿入。line の場合は polyline 化)
     *   2. setSpaceEntities で同期再 derive → 新しい polygon outer を取得
     *   3. 新しい中央サブエッジ idx を特定 → wallSkips に full-skip を push
     *   4. 既存 polygon-targeting 拘束を新エッジ index に再マップ。Horizontal
     *      / Vertical は 3 サブエッジ全てに複製 (= 元の方向性を維持)
     *   5. サブエッジ間に Collinear 拘束を貼る (= 切断点が元エッジの直線上を
     *      スライドするだけになる)
     *
     * arc / circle entity 由来エッジ、もしくはチェイン照合に失敗した場合は
     * `false` を返す → 呼び出し側は仮想 wallSkip (= 2D 表示のみ) にフォール
     * バックする。
     */
    const promoteWallSkipToVertices = (params: {
        spaceId: string;
        polyId: string;
        edgeIdx: number;
        Va: Vec2;
        Vb: Vec2;
        T0: Vec2;
        T1: Vec2;
        t0: number;
        t1: number;
    }): boolean => {
        const { spaceId, polyId, edgeIdx, Va, Vb, T0, T1 } = params;
        const eps = 1e-7;
        const sameVec2 = (x: Vec2, y: Vec2) =>
            Math.abs(x[0] - y[0]) < eps && Math.abs(x[1] - y[1]) < eps;
        const sqDist = (x: Vec2, y: Vec2) =>
            (x[0] - y[0]) * (x[0] - y[0]) + (x[1] - y[1]) * (x[1] - y[1]);

        // ── ソルバ抑制 ─────────────────────────────────────────────────
        // この関数の中では entity 更新 / polygon 更新 / 拘束追加削除を多段で
        // 行う。途中で ソルバが走ると、新エッジに古い拘束 (= 旧 edgeIdx 参照)
        // が適用されて polygon が捻じれる。`setSolverDragHint` にダミーピン
        // を入れて runSketchSolver を一律で抑制し、関数末尾で clear して
        // 「全状態が一貫した最終形」で 1 回だけ solve させる。
        const SUPPRESS_PIN: import("../../application/AppState").SolverDragPin = {
            spaceId: spaceId as ElementId,
            polyId,
            vertexIdx: -1,
            x: 0, y: 0,
        };
        setSolverDragHint([SUPPRESS_PIN]);
        let okFinish = false;
        try {

        const sp = useAppState.getState().elements[spaceId] as SpaceElement | undefined;
        if (!sp) return false;
        const oldPoly = sp.polygons.find((p) => p.id === polyId);
        if (!oldPoly) return false;
        const oldOuter = oldPoly.outer.map((p) => [p[0], p[1]] as Vec2);
        const oldEdges = polygonEdges(oldPoly).map((e) => [e[0], e[1]] as [number, number]);
        const oldWallSkips: WallSkip[] = (oldPoly.wallSkips ?? []).map((s) => ({ ...s }));
        const ownerId = oldPoly.edgeOwners?.[edgeIdx];
        const owner = ownerId ? sp.entities?.find((e) => e.id === ownerId) : undefined;
        if (!owner) return false;

        // 弦上で T0 / T1 のうち Va に近い方を pNear、遠い方を pFar とする。
        const dT0Va = sqDist(T0, Va);
        const dT1Va = sqDist(T1, Va);
        const pNear: Vec2 = dT0Va < dT1Va ? T0 : T1;
        const pFar: Vec2 = dT0Va < dT1Va ? T1 : T0;

        // 元 entity を 2 点挿入で更新する。kind === "line" なら polyline 化。
        let newEntity: SketchEntity;
        if (owner.kind === "line") {
            const VaIsP0 = sameVec2(Va, owner.p0);
            // entity の点列順序 (p0 → p1) で挿入順を決める。Va が p0 なら
            // [p0, pNear, pFar, p1]、Va が p1 なら [p0, pFar, pNear, p1]。
            const newPoints: Vec2[] = VaIsP0
                ? [[owner.p0[0], owner.p0[1]], pNear, pFar, [owner.p1[0], owner.p1[1]]]
                : [[owner.p0[0], owner.p0[1]], pFar, pNear, [owner.p1[0], owner.p1[1]]];
            newEntity = {
                id: owner.id,
                kind: "polyline",
                points: newPoints,
                closed: false,
                construction: owner.construction,
            };
        } else if (owner.kind === "polyline") {
            // polyline.points 上で Va, Vb がどの sub-segment に対応するかを探す。
            const pts = owner.points;
            const n = pts.length;
            const segCount = owner.closed ? n : n - 1;
            let segIdx = -1;
            let segReversed = false;
            for (let i = 0; i < segCount; i++) {
                const j = owner.closed ? (i + 1) % n : i + 1;
                const pi = pts[i], pj = pts[j];
                if (sameVec2(pi, Va) && sameVec2(pj, Vb)) { segIdx = i; segReversed = false; break; }
                if (sameVec2(pi, Vb) && sameVec2(pj, Va)) { segIdx = i; segReversed = true; break; }
            }
            if (segIdx < 0) return false;
            const insertAt = segIdx + 1;
            // entity 順 (segIdx → segIdx+1) で並ぶ向きに合わせて挿入。reversed
            // なら entity の points[segIdx] = Vb なので pFar が先。
            const ins0 = segReversed ? pFar : pNear;
            const ins1 = segReversed ? pNear : pFar;
            const newPoints = [
                ...pts.slice(0, insertAt).map((p) => [p[0], p[1]] as Vec2),
                ins0, ins1,
                ...pts.slice(insertAt).map((p) => [p[0], p[1]] as Vec2),
            ];
            newEntity = { ...owner, points: newPoints };
        } else {
            // arc / circle: 昇格未対応 (フォールバック)。
            return false;
        }

        // ── Apply entity update via setSpaceEntities (= 同期再 derive) ────
        setSpaceEntities(spaceId, (es) => es.map((e) => (e.id === owner.id ? newEntity : e)));

        const updatedSpace = useAppState.getState().elements[spaceId] as SpaceElement | undefined;
        const newPoly = updatedSpace?.polygons?.find((p) => p.id === polyId);
        if (!newPoly) return false;
        const newEdges = polygonEdges(newPoly);

        // 新 polygon outer 上で Va, Vb, pNear, pFar の頂点 idx を世界座標で見つける。
        const idxOfWorld = (target: Vec2): number => {
            for (let i = 0; i < newPoly.outer.length; i++) {
                if (sameVec2(newPoly.outer[i], target)) return i;
            }
            return -1;
        };
        const niVa = idxOfWorld(Va);
        const niVb = idxOfWorld(Vb);
        const niPNear = idxOfWorld(pNear);
        const niPFar = idxOfWorld(pFar);
        if (niVa < 0 || niVb < 0 || niPNear < 0 || niPFar < 0) return false;

        const findEdgeByVerts = (a: number, b: number): number => {
            for (let i = 0; i < newEdges.length; i++) {
                const [ea, eb] = newEdges[i];
                if ((ea === a && eb === b) || (ea === b && eb === a)) return i;
            }
            return -1;
        };
        const subE0 = findEdgeByVerts(niVa, niPNear);
        const subEMid = findEdgeByVerts(niPNear, niPFar);
        const subE2 = findEdgeByVerts(niPFar, niVb);
        if (subE0 < 0 || subEMid < 0 || subE2 < 0) return false;

        // 旧 edgeIdx → 新 edgeIdx を世界座標で引くマップ。split 対象 (= edgeIdx)
        // はマップに含めない (= 旧 wallSkip の元エッジ参照は破棄して新 full skip
        // に置き換える)。
        const oldToNewEdge = new Map<number, number>();
        for (let oi = 0; oi < oldEdges.length; oi++) {
            if (oi === edgeIdx) continue;
            const [oai, obi] = oldEdges[oi];
            const oa = oldOuter[oai];
            const ob = oldOuter[obi];
            for (let ni = 0; ni < newEdges.length; ni++) {
                const [nai, nbi] = newEdges[ni];
                const na = newPoly.outer[nai];
                const nb = newPoly.outer[nbi];
                if ((sameVec2(oa, na) && sameVec2(ob, nb))
                    || (sameVec2(oa, nb) && sameVec2(ob, na))) {
                    oldToNewEdge.set(oi, ni);
                    break;
                }
            }
        }
        // 旧 vertexIdx → 新 vertexIdx (= 世界座標一致)。
        const oldToNewVertex = new Map<number, number>();
        for (let oi = 0; oi < oldOuter.length; oi++) {
            const ni = idxOfWorld(oldOuter[oi]);
            if (ni >= 0) oldToNewVertex.set(oi, ni);
        }

        // 旧 wallSkips を再マップ。split 対象 edge の旧 skip は破棄 (= 新しい
        // full skip に置き換わる)。
        const remappedSkips: WallSkip[] = [];
        for (const skip of oldWallSkips) {
            if (skip.edgeIdx === edgeIdx) continue;
            const ni = oldToNewEdge.get(skip.edgeIdx);
            if (ni !== undefined) remappedSkips.push({ ...skip, edgeIdx: ni });
        }
        remappedSkips.push({ edgeIdx: subEMid, t0: 0, t1: 1 });

        // ── 拘束の再マップ ─────────────────────────────────────────────
        const allConstraints = useAppState.getState().constraints;
        for (const cid in allConstraints) {
            const c = allConstraints[cid];
            // 当該 polygon を参照しないなら触らない。
            const refsThisPoly = c.targets.some((t) =>
                (t.kind === "SketchPoint" || t.kind === "SketchEdge" || t.kind === "SketchCircle")
                && t.polyId === polyId,
            );
            if (!refsThisPoly) continue;

            // ── target 列を辿り、再マップ後の targets 候補 (= 複製パターン)
            //    を replicaTargets に積み上げる。Horizontal / Vertical で split
            //    edge を参照する場合は 3 サブエッジ分に複製。
            let replicaTargets: ConstraintTarget[][] = [c.targets.map((t) => ({ ...t }))];
            let drop = false;
            for (let ti = 0; ti < c.targets.length; ti++) {
                const t = c.targets[ti];
                if (t.kind === "SketchPoint" && t.polyId === polyId) {
                    const newVi = oldToNewVertex.get(t.vertexIdx);
                    if (newVi === undefined) { drop = true; break; }
                    for (const r of replicaTargets) (r[ti] as any).vertexIdx = newVi;
                } else if (t.kind === "SketchEdge" && t.polyId === polyId) {
                    if (t.edgeIdx === edgeIdx) {
                        // split 対象。方向・配向系の拘束は **両端のサブエッジ
                        // (subE0, subE2) に複製** する (= 中央の subEMid は壁を
                        // 削除する区間なので拘束対象から外す)。両端が同じ方向
                        // 拘束を持つことで、subEMid (= 共有頂点 pNear, pFar の
                        // 端点) も自動的に元エッジの直線上に保たれる → 別途
                        // Collinear 拘束は不要。
                        const directionTypes = new Set<string>([
                            "Horizontal", "Vertical",
                            "Parallel", "Perpendicular",
                            "Collinear", "Angle", "PerpDistance",
                        ]);
                        if (directionTypes.has(c.type)) {
                            const subs = [subE0, subE2];
                            const next: ConstraintTarget[][] = [];
                            for (const r of replicaTargets) {
                                for (const sub of subs) {
                                    const cp = r.map((x) => ({ ...x }));
                                    (cp[ti] as any).edgeIdx = sub;
                                    next.push(cp);
                                }
                            }
                            replicaTargets = next;
                        } else {
                            // Length / EqualLength は分割で意味を失うので破棄。
                            drop = true;
                            break;
                        }
                    } else {
                        const newEi = oldToNewEdge.get(t.edgeIdx);
                        if (newEi === undefined) { drop = true; break; }
                        for (const r of replicaTargets) (r[ti] as any).edgeIdx = newEi;
                    }
                }
                // SketchCircle / SketchEntity / WallAxis / Grid / Origin など
                // edge / vertex に依存しない target はそのまま。
            }

            if (drop) {
                executeCommand(new RemoveConstraintCommand(cid));
            } else {
                executeCommand(new RemoveConstraintCommand(cid));
                for (const targets of replicaTargets) {
                    executeCommand(new AddConstraintCommand({
                        id: generateConstraintId(),
                        type: c.type,
                        targets,
                        value: c.value,
                    }));
                }
            }
        }

        // 旧 split edge の方向拘束 (Horizontal / Vertical / Parallel / Perpendicular)
        // が両端の subE0 / subE2 に複製されるので、両端は元エッジと同方向に
        // 保たれる。共有頂点 pNear / pFar が両端の端点でもあるため、自動的に
        // 元エッジの直線上にとどまる → 追加の Collinear 拘束は不要。

        // ── 最終 polygon (wallSkips 付け替え) ─────────────────────────
        const final = useAppState.getState().elements[spaceId] as SpaceElement | undefined;
        if (final) {
            const finalPolys = final.polygons.map((p) => {
                if (p.id !== polyId) return p;
                return { ...p, wallSkips: remappedSkips };
            });
            updateElement(spaceId as ElementId, {
                polygons: finalPolys,
                dirtyFlags: new Set([...(final.dirtyFlags ?? []), "Geometry", "Mesh", "Render"]),
            } as any);
        }
        okFinish = true;
        return true;

        } finally {
            // ソルバ抑制を解除。clear すると pending solve が 1 回だけ走り、
            // 全状態 (= entity / polygon / 拘束) が一貫した形でソルブされる。
            setSolverDragHint(null);
            void okFinish;
        }
    };

    /**
     * Decide which room a freshly drawn shape belongs to.
     *  - pending 状態 (Add Room 直後・実体無し): ここで初めて CreateSpaceCommand
     *    を実行し、Space を生成。Tree に空 Room1 が先行表示される問題を防ぐ。
     *  - active room が空: その Space に図形を入れる。
     *  - active room に既に図形あり: 新しい Space を作って切り替える
     *    (1図形=1Room の仕様)。
     */
    const pickShapeTargetRoom = (): { roomId: ElementId; room: SpaceElement } | null => {
        const live = useAppState.getState().elements;

        // pending → Space を遅延生成
        if (!activeRoomId && pendingRoomLevelId) {
            const cmd = new CreateSpaceCommand(
                pickNewRoomName(live),
                3.0,
                undefined,
                pendingRoomLevelId,
            );
            executeCommand(cmd);
            const newId = cmd.getElementId();
            // setActiveRoom は pendingRoomLevelId も同時に null へクリアする。
            setActiveRoom(newId);
            const fresh = useAppState.getState().elements[newId as string] as SpaceElement;
            return { roomId: newId, room: fresh };
        }

        if (!activeRoomId) return null;
        const active = live[activeRoomId as string] as SpaceElement | undefined;
        if (!active || active.type !== "Space") return null;
        const hasShape = (active.polygons ?? []).some(
            (p) => !p.wallOutlineOf && p.outer && p.outer.length >= 3,
        );
        if (!hasShape) return { roomId: activeRoomId, room: active };
        const cmd = new CreateSpaceCommand(
            pickNewRoomName(live),
            active.height ?? 3.0,
            undefined,
            active.levelId,
        );
        executeCommand(cmd);
        const newId = cmd.getElementId();
        setActiveRoom(newId);
        const fresh = useAppState.getState().elements[newId as string] as SpaceElement;
        return { roomId: newId, room: fresh };
    };

    /**
     * 閉ループのエンティティを active room に追加。entity 経由で polygon を
     * 自動派生させる (= 真実の単一情報源は entity 側)。返り値の polyId は
     * 自動拘束の付与などに使う。
     *
     * `realtimeWallGen` が ON のときは、polygon が派生した直後に
     * `regenerateAllWalls` を呼んで 3D 壁を即時生成する。
     */
    const commitClosedEntity = (entity: SketchEntity): {
        roomId: ElementId;
        polyId: string | null;
    } | null => {
        const target = pickShapeTargetRoom();
        if (!target) return null;
        setSpaceEntities(target.roomId, (es) => [...es, entity]);
        const fresh = useAppState.getState().elements[target.roomId as string] as SpaceElement | undefined;
        const polyId = fresh?.polyIdByEntity?.[entity.id] ?? null;
        // seed = 新規 polygon 1 個。影響範囲外の部屋の壁は触らない。
        // polyId が取れない (entity から polygon が派生しない) 場合のみ
        // フル regen にフォールバック。
        maybeRealtimeRegenWalls(
            `closed-entity ${entity.kind}`,
            polyId ? [polyId] : undefined,
        );
        // 新規 polygon を「最後に操作した polygon」として登録し、
        // 他 polygon と重なっていれば merge / clip ボタンを表示できるようにする。
        if (polyId) setLastDraggedPolyId(polyId);
        return { roomId: target.roomId, polyId };
    };

    /**
     * 開いたエンティティ (line / arc / open polyline) を active or pending room に
     * 追加。チェイン検出 (derivePolygonsFromEntities) が単独 entity を「開
     * polygon」として派生する (= edges 明示の 1 本鎖)。WallPath と同様、entity
     * 追加後すぐに `maybeRealtimeRegenWalls` をトリガして 3D 壁を生成する。
     */
    const commitOpenEntity = (entity: SketchEntity): ElementId | null => {
        const live = useAppState.getState().elements;
        let targetId: ElementId | null = activeRoomId;
        let targetRoom: SpaceElement | null = targetId
            ? (live[targetId as string] as SpaceElement | undefined) ?? null
            : null;
        if (!targetRoom && pendingRoomLevelId) {
            const cmd = new CreateSpaceCommand(
                pickNewRoomName(live), 3.0, undefined, pendingRoomLevelId,
            );
            executeCommand(cmd);
            targetId = cmd.getElementId();
            setActiveRoom(targetId);
            targetRoom = useAppState.getState().elements[targetId as string] as SpaceElement;
        }
        if (!targetId || !targetRoom) return null;
        setSpaceEntities(targetId, (es) => [...es, entity]);
        // 派生した polygon の polyId を引いて wall regen を seed する。
        // setSpaceEntities が同期的に polygons / polyIdByEntity を更新するので
        // ここで読めば最新値が取れる。polygon が派生しなかった (= entity 単独で
        // chain を成さない異常系) は seedPolyIds 省略 → 全 regen にフォールバック。
        const fresh = useAppState.getState().elements[targetId as string] as SpaceElement | undefined;
        const polyId = fresh?.polyIdByEntity?.[entity.id];
        maybeRealtimeRegenWalls(
            `open-entity ${entity.kind}`,
            polyId ? [polyId] : undefined,
        );
        return targetId;
    };

    // Finalize the polyline draft as a closed PolylineEntity (auto-derives polygon).
    const commitPolyDraft = (points: [number, number][]) => {
        if (points.length < 3) return;
        // polyline モードでも incremental 3D 壁描画 (wallPath 機構を流用) を行うため、
        // 確定時には先に live wallPath 由来の open polyline と仮壁を破棄する。
        discardLiveWallPathDraft();
        const entity: PolylineEntity = {
            id: generateId(),
            kind: "polyline",
            points: points.map((p) => [p[0], p[1]] as Vec2),
            closed: true,
        };
        commitClosedEntity(entity);
        setPolyDraftPoints([]);
        setMouseWorld(null);
        setGridSnapInfo(null);
        setRoomEditMode("select");
    };

    /**
     * 描画中の WallPath を即時に消す (canceled-before-commit 用)。
     * 既存の wall element と polygon の両方を state から落とす。
     */
    const discardLiveWallPathDraft = () => {
        const ref = wallPathDraftRef.current;
        if (!ref) return;
        const live = useAppState.getState();
        const space = live.elements[ref.roomId] as SpaceElement | undefined;
        if (space) {
            const target = space.polygons?.find((p) => p.id === ref.polyId);
            if (target) {
                for (const wid of target.wallIds ?? []) {
                    if (wid && live.elements[wid]) live.removeElement(wid);
                }
            }
            // entity を消すと derivePolygonsFromEntities が polygon を再派生
            // してくれて、対応する polygon も自動で消える。
            setSpaceEntities(ref.roomId, (es) => es.filter((e) => e.id !== ref.entityId));
        }
        wallPathDraftRef.current = null;
        wallPathDraftSnapsRef.current = [];
    };


    /**
     * 既存 polygon の指定エッジを Arc に変換する。実装方針:
     *  - 対象 polygon は **closed polyline entity** から派生したものに限る
     *    (chain 由来は entity 境界をまたぐ可能性があるので非対応)。
     *  - 元 entity を **開ポリライン (回転して edgeIdx+1 から始まる)** に
     *    置き換え + 同じ chord を持つ新規 ArcEntity を追加。両者は端点を
     *    共有するため、derive 後は閉チェイン → 同じ polygon に再構成される。
     *  - 失敗時 (chord 由来の entity が見つからない等) は false を返して何も
     *    しない。
     */
    const commitEdgeAsArc = (
        chord: ArcEdgeChord,
        cursor: Vec2,
    ): boolean => {
        const arc = arcFromChordAndCursor(chord.p0, chord.p1, cursor);
        if (!arc) {
            // eslint-disable-next-line no-console
            console.warn(`[arcEdge/commit] arcFromChordAndCursor returned null`);
            return false;
        }
        const live = useAppState.getState().elements;
        const space = live[chord.spaceId] as SpaceElement | undefined;
        if (!space || space.type !== "Space") return false;
        const map = space.polyIdByEntity ?? {};
        // 候補 entity = polyId 一致 + closed polyline。
        const ownerId = Object.keys(map).find(
            (eid) => map[eid] === chord.polyId,
        );
        if (!ownerId) return false;
        const owner = (space.entities ?? []).find((e) => e.id === ownerId);
        if (!owner || owner.kind !== "polyline" || !owner.closed) {
            // eslint-disable-next-line no-console
            console.warn(
                `[arcEdge] 対象エッジは閉ポリライン由来でないため Arc 化未対応 (entity kind=${owner?.kind})`,
            );
            return false;
        }
        const pts = owner.points;
        const n = pts.length;
        if (n < 3) return false;
        const i = chord.edgeIdx;
        if (i < 0 || i >= n) return false;
        const j = (i + 1) % n;
        // 元 entity の点列順序と outer の順序が一致している前提
        // (PolygonDerive 経路で `polyId, e.points.slice()` をそのまま渡している)。
        const polylinePoints: Vec2[] = [];
        // edgeIdx+1 から始まり、wrap して edgeIdx で終わる open polyline。
        for (let k = 0; k < n; k++) {
            const idx = (j + k) % n;
            polylinePoints.push([pts[idx][0], pts[idx][1]] as Vec2);
        }
        const newPolyline: PolylineEntity = {
            id: owner.id,
            kind: "polyline",
            points: polylinePoints,
            closed: false,
            construction: owner.construction,
        };
        const newArc: ArcEntity = {
            id: generateId(),
            kind: "arc",
            center: arc.center,
            radius: arc.radius,
            aStart: arc.aStart,
            aEnd: arc.aEnd,
        };
        // 削除する辺 (= chord.edgeIdx) を参照する拘束、および矩形時に貼られた
        // 自動拘束 (Parallel/Perpendicular/Horizontal/Vertical で edge index が
        // 鎖の繋ぎ替えで意味を失うもの) を破棄する。残ると solver が
        // **新しい弧セグメント** を「直線にしろ」と動かしてしまい、ポリゴンが
        // 歪む (= スケッチ線がおかしくなる原因)。安全側で当該 polyId を参照
        // する辺/頂点ベースの自動拘束は全部落とす。
        const allConstraints = useAppState.getState().constraints;
        for (const cid in allConstraints) {
            const c = allConstraints[cid];
            const refsThisPoly = c.targets.some((t) => {
                if (t.kind === "SketchEdge" || t.kind === "SketchPoint" || t.kind === "SketchCircle") {
                    return t.spaceId === chord.spaceId && t.polyId === chord.polyId;
                }
                return false;
            });
            if (!refsThisPoly) continue;
            // edge index が変換でズレるもの = autoRect 由来の Parallel /
            // Perpendicular / Horizontal / Vertical / Collinear。Length /
            // Coincident 等は残してもユーザーが明示的に付けた可能性が高い。
            const dropTypes = new Set<string>([
                "Parallel", "Perpendicular", "Horizontal", "Vertical", "Collinear",
            ]);
            if (!dropTypes.has(c.type)) continue;
            executeCommand(new RemoveConstraintCommand(cid));
        }
        setSpaceEntities(chord.spaceId, (es) => {
            const next = es.map((e) => (e.id === owner.id ? newPolyline : e));
            next.push(newArc);
            return next;
        });
        const after = useAppState.getState().elements[chord.spaceId] as SpaceElement | undefined;
        const newPoly = after?.polygons?.find((p) => p.id === chord.polyId);
        if (!newPoly) {
            // eslint-disable-next-line no-console
            console.warn(`[arcEdge/commit] 派生後の polygon が見つからない polyId=${chord.polyId}`);
        }
        // 派生後の polygon を seed に 3D 壁を即時再生成。
        maybeRealtimeRegenWalls(
            `arcEdge convert (poly=${chord.polyId.slice(0, 6)})`,
            [chord.polyId],
        );
        return true;
    };

    // 単独壁用ポリライン (open chain) のドラフトをコミット。
    // `edges` を明示的に [[0,1],[1,2],...] の鎖型にすることで isPolygonClosed=false
    // となり、表示は線のみ (塗り無し)、全壁生成では各エッジ→1 本の Wall として処理。
    //
    // 引数 `isFinal`:
    //   - false → 描画中の各クリックで呼ばれる incremental 更新。polygon を初回
    //              で作成し、以降のクリックで outer を拡張。3D 壁を即時表示する
    //              ために `regenerateAllWalls` を seed=このポリゴン で都度実行。
    //              ドラフト state (polyDraftPoints) は保持。
    //   - true (既定) → 確定 (Enter / 右クリック / ダブルクリック)。最後の状態
    //              で junction 処理を 1 度走らせ、ドラフト state を全部クリア
    //              して select モードへ戻す。
    //
    // pickShapeTargetRoom (= 1図形=1Room の閉図形仕様) は使わない:
    // wallPath は閉じ図形では無いので新規 Room を生成する意味が無く、
    // 必ず active room (or pending → 新規生成) に追記する。
    const commitWallPathDraft = (points: [number, number][], isFinal: boolean = true) => {
        if (points.length < 2) {
            // 確定要求だが 2 点未満 → live polygon があればキャンセル扱いで除去。
            if (isFinal) {
                discardLiveWallPathDraft();
                setPolyDraftPoints([]);
                setMouseWorld(null);
                setGridSnapInfo(null);
            }
            return;
        }
        // WallPath は **常に開いたポリライン** として確定する (= ユーザ仕様)。
        // 閉ループ判定は行わない。
        // ストアから直接読む。React closure 経由の activeRoomId は incremental
        // 連続クリックで再レンダ前だと stale になり、2 回目以降のクリックで
        // また新しい Space + WallPath polygon を作ってしまう不具合 (= 同一の
        // WallPath が複数生成される現象) があった。既存ドラフト ref の roomId
        // を最優先で使い、無ければ store の activeRoomId / pendingRoomLevelId を
        // 引く。
        const liveState = useAppState.getState();
        const liveElems = liveState.elements;
        const existingDraft = wallPathDraftRef.current;
        let targetId: ElementId | null = existingDraft?.roomId
            ?? liveState.activeRoomId
            ?? null;
        let targetRoom: SpaceElement | null = targetId
            ? (liveElems[targetId as string] as SpaceElement | undefined) ?? null
            : null;
        if (!targetRoom && liveState.pendingRoomLevelId) {
            const cmd = new CreateSpaceCommand(
                pickNewRoomName(liveElems), 3.0, undefined, liveState.pendingRoomLevelId,
            );
            executeCommand(cmd);
            targetId = cmd.getElementId();
            setActiveRoom(targetId);
            // setActiveRoom resets roomEditMode to "select"; restore wallPath mode
            // so the useEffect cleanup does not fire and delete the draft wall.
            setRoomEditMode("wallPath");
            targetRoom = useAppState.getState().elements[targetId as string] as SpaceElement;
        }
        if (!targetId || !targetRoom) return;

        const polylinePoints: Vec2[] = points.map((p) => [p[0], p[1]] as Vec2);

        // 各ドラフト点のスナップ target を joints[] に変換。スナップしなかった
        // 点 (= 通芯やフリー位置) は joint 対象外。
        const snaps = wallPathDraftSnapsRef.current;
        const joints: PolygonJoint[] = [];
        for (let i = 0; i < points.length; i++) {
            const t = snaps[i];
            if (!t) continue;
            if (t.kind === "polyVertex") {
                joints.push({
                    vertexIdx: i,
                    target: {
                        kind: "polyVertex",
                        spaceId: t.spaceId as ElementId,
                        polyId: t.polyId,
                        targetVertexIdx: t.targetVertexIdx,
                    },
                });
            } else {
                joints.push({
                    vertexIdx: i,
                    target: {
                        kind: "polyEdge",
                        spaceId: t.spaceId as ElementId,
                        polyId: t.polyId,
                        targetEdgeIdx: t.targetEdgeIdx,
                        t: t.t,
                    },
                });
            }
        }

        // 既に live entity がある (= 2 点目以降のクリック) なら entity の points
        // を更新、無ければ新規 PolylineEntity (closed: false) を追加。
        // entity 駆動 = derivePolygonsFromEntities が polygon を再派生するので、
        // 隣の setSpaceEntities (= 別 commit / solver writeback) でも消えない。
        const existing = wallPathDraftRef.current;
        let entityId: string;
        const isUpdate = existing && existing.roomId === targetId
            && (targetRoom.entities ?? []).some((e) => e.id === existing.entityId);
        if (isUpdate) {
            entityId = existing!.entityId;
            // 既存 polygon の wallIds が指す壁を **明示的に削除**。リセットせず
            // に残すと「polygon から参照されない壁」が orphan として elements に
            // 残ってしまう (= prevWallIds は polygon から拾うので、新 derive 後は
            // 拾えない)。
            const oldPoly = (targetRoom.polygons ?? [])
                .find((p) => p.id === existing!.polyId);
            for (const wid of oldPoly?.wallIds ?? []) {
                if (wid && useAppState.getState().elements[wid]) {
                    useAppState.getState().removeElement(wid);
                }
            }
            setSpaceEntities(targetId, (es) => es.map((e) => {
                if (e.id !== entityId) return e;
                if (e.kind !== "polyline") return e;
                return { ...e, points: polylinePoints, closed: false };
            }));
        } else {
            entityId = generateId();
            const newEntity: PolylineEntity = {
                id: entityId,
                kind: "polyline",
                points: polylinePoints,
                closed: false,
            };
            setSpaceEntities(targetId, (es) => [...es, newEntity]);
        }

        // setSpaceEntities が polygon を派生済み。polyId を polyIdByEntity から
        // 引いて wallPathDraftRef を更新し、joints / wallIds リセットを polygon
        // 側に書き戻す。
        const fresh = useAppState.getState().elements[targetId as string] as SpaceElement | undefined;
        const polyId = fresh?.polyIdByEntity?.[entityId];
        if (!fresh || !polyId) return;
        wallPathDraftRef.current = { polyId, roomId: targetId, entityId };

        // joints は polygon 側の付加情報 (entity からは派生できない)。derive 後
        // に polygon に書き戻す。makeRoomPolygon が prev.joints を保持するので、
        // 後続の re-derive でも joints は引き継がれる。
        // wallIds 等は regen が再構築するので前段でクリア (= 旧インデックスとの
        // 不整合回避)。
        const updatedPolys = (fresh.polygons ?? []).map((p) => {
            if (p.id !== polyId) return p;
            const { wallIds: _w, wallsPerEdge: _wp, edgeIds: _e, sharedEdgeIds: _s,
                vertexConnections: _vc, ...rest } = p;
            void _w; void _wp; void _e; void _s; void _vc;
            return { ...rest, joints };
        });
        updateElement(targetId, {
            polygons: updatedPolys,
            dirtyFlags: new Set([...(fresh.dirtyFlags ?? []), "Geometry", "Mesh", "Render"]),
        } as any);

        // 3D 壁の即時生成 + 確定時の junction 処理。incremental も final も同じ
        // パスで OK (= seedPolyIds=[polyId] で影響範囲のみ junction 解決)。
        maybeRealtimeRegenWalls(
            isFinal ? "wallPath final commit" : "wallPath incremental",
            [polyId],
        );

        if (isFinal) {
            wallPathDraftRef.current = null;
            wallPathDraftSnapsRef.current = [];
            setPolyDraftPoints([]);
            setMouseWorld(null);
            setGridSnapInfo(null);
            setRoomEditMode("select");
        }
    };

    /**
     * Circle の incremental commit (= マウス移動中の 3D 壁ライブ描画用)。
     * 既存の live entity があれば center / radius を更新、無ければ新規作成。
     * 確定 (isFinal=true) ならドラフト ref を消すだけで、live entity が
     * そのまま最終 entity になる。
     */
    const commitCircleDraftIncremental = (
        center: [number, number],
        radius: number,
        isFinal: boolean,
    ): void => {
        if (radius < 1e-6) {
            if (isFinal) discardLiveCircleDraft();
            return;
        }
        const liveState = useAppState.getState();
        const liveElems = liveState.elements;
        const existing = circleLiveDraftRef.current;
        let targetId: ElementId | null = existing?.roomId
            ?? liveState.activeRoomId
            ?? null;
        let targetRoom: SpaceElement | null = targetId
            ? (liveElems[targetId as string] as SpaceElement | undefined) ?? null
            : null;
        if (!targetRoom && liveState.pendingRoomLevelId) {
            const cmd = new CreateSpaceCommand(
                pickNewRoomName(liveElems), 3.0, undefined, liveState.pendingRoomLevelId,
            );
            executeCommand(cmd);
            targetId = cmd.getElementId();
            setActiveRoom(targetId);
            setRoomEditMode("circle");
            targetRoom = useAppState.getState().elements[targetId as string] as SpaceElement;
        }
        if (!targetId || !targetRoom) return;

        let entityId: string;
        const isUpdate = existing && existing.roomId === targetId
            && (targetRoom.entities ?? []).some((e) => e.id === existing.entityId);
        if (isUpdate) {
            entityId = existing!.entityId;
            setSpaceEntities(targetId, (es) => es.map((e) => {
                if (e.id !== entityId) return e;
                if (e.kind !== "circle") return e;
                return { ...e, center: [center[0], center[1]], radius };
            }));
        } else {
            entityId = generateId();
            const newEntity: CircleEntity = {
                id: entityId,
                kind: "circle",
                center: [center[0], center[1]],
                radius,
            };
            setSpaceEntities(targetId, (es) => [...es, newEntity]);
        }
        const fresh = useAppState.getState().elements[targetId as string] as SpaceElement | undefined;
        const polyId = fresh?.polyIdByEntity?.[entityId];
        if (!fresh || !polyId) return;
        circleLiveDraftRef.current = { polyId, roomId: targetId, entityId };

        maybeRealtimeRegenWalls(
            isFinal ? "circle final commit" : "circle incremental",
            [polyId],
        );

        if (isFinal) {
            setLastDraggedPolyId(polyId);
            circleLiveDraftRef.current = null;
            setCircleCenter(null);
            setMouseWorld(null);
            setGridSnapInfo(null);
            setRoomEditMode("select");
        }
    };

    /**
     * 描画中の Circle live entity を即時に消す (canceled-before-commit 用)。
     */
    const discardLiveCircleDraft = (): void => {
        const ref = circleLiveDraftRef.current;
        if (!ref) return;
        const live = useAppState.getState();
        const space = live.elements[ref.roomId] as SpaceElement | undefined;
        if (space) {
            const target = space.polygons?.find((p) => p.id === ref.polyId);
            if (target) {
                for (const wid of target.wallIds ?? []) {
                    if (wid && live.elements[wid]) live.removeElement(wid);
                }
            }
            setSpaceEntities(ref.roomId, (es) => es.filter((e) => e.id !== ref.entityId));
        }
        circleLiveDraftRef.current = null;
    };

    const commitCircleDraft = (center: [number, number], radius: number) => {
        commitCircleDraftIncremental(center, radius, true);
    };

    // Dispatch a native PointerEvent copy to the 3D canvas beneath this
    // overlay. Used in wall mode to forward empty-area clicks (and all
    // subsequent moves/ups in that gesture) to Viewport so the user can
    // draw walls while the overlay keeps handling sketch selection.
    const dispatchToViewport = (
        e: React.PointerEvent,
        kind: "pointerdown" | "pointermove" | "pointerup",
    ) => {
        const bg = canvasRef.current?.parentElement
            ?.querySelector("canvas:not([data-sketch-overlay])") as HTMLCanvasElement | null;
        if (!bg) return;
        bg.dispatchEvent(new PointerEvent(kind, {
            bubbles: true,
            cancelable: true,
            pointerId: e.pointerId,
            pointerType: e.pointerType,
            clientX: e.clientX,
            clientY: e.clientY,
            button: e.button,
            buttons: e.buttons,
            isPrimary: e.isPrimary,
            shiftKey: e.shiftKey,
            ctrlKey: e.ctrlKey,
            metaKey: e.metaKey,
            altKey: e.altKey,
        }));
    };

    // ─── Drag start helpers (FreeCAD 流のハンドル開始処理) ───

    /**
     * 弧 (ArcEntity) を rim / center handle 経由で **平行移動** するドラッグを
     * 開始する。chord 端点とつながる polyline / line の端点を polygon の
     * edgeOwners 経由で正確に拾い上げて、ドラッグ中に追従させる。
     */
    const startEntityArcDrag = (
        arc: ArcEntity,
        polyId: string,
        wp: [number, number],
    ) => {
        if (!activeRoomId) return;
        const poly = (room.polygons ?? []).find((p) => p.id === polyId);
        const adj: DragEntityArcState["origAdjacentPoints"] = [];
        if (poly?.edgeOwners) {
            const arcStart: [number, number] = [
                arc.center[0] + arc.radius * Math.cos(arc.aStart),
                arc.center[1] + arc.radius * Math.sin(arc.aStart),
            ];
            const arcEnd: [number, number] = [
                arc.center[0] + arc.radius * Math.cos(arc.aEnd),
                arc.center[1] + arc.radius * Math.sin(arc.aEnd),
            ];
            const polyEdgeList = polygonEdges(poly);
            const vertEdges = new Map<number, number[]>();
            for (let ei = 0; ei < polyEdgeList.length; ei++) {
                const [va, vb] = polyEdgeList[ei];
                for (const v of [va, vb]) {
                    const arr = vertEdges.get(v) ?? [];
                    arr.push(ei);
                    vertEdges.set(v, arr);
                }
            }
            const boundaryVerts: { vIdx: number; otherEdgeIdx: number }[] = [];
            for (const [vi, edges] of vertEdges) {
                if (edges.length !== 2) continue;
                const o0 = poly.edgeOwners[edges[0]];
                const o1 = poly.edgeOwners[edges[1]];
                if (o0 === arc.id && o1 && o1 !== arc.id) {
                    boundaryVerts.push({ vIdx: vi, otherEdgeIdx: edges[1] });
                } else if (o1 === arc.id && o0 && o0 !== arc.id) {
                    boundaryVerts.push({ vIdx: vi, otherEdgeIdx: edges[0] });
                }
            }
            const MATCH_TOL = 1e-2;
            for (const bv of boundaryVerts) {
                const otherOwnerId = poly.edgeOwners[bv.otherEdgeIdx];
                const en = (room.entities ?? []).find((e) => e.id === otherOwnerId);
                if (!en) continue;
                const vp = poly.outer[bv.vIdx];
                const dStart = Math.hypot(vp[0] - arcStart[0], vp[1] - arcStart[1]);
                const dEnd = Math.hypot(vp[0] - arcEnd[0], vp[1] - arcEnd[1]);
                const matchesArcStart = dStart <= dEnd;
                if (en.kind === "polyline") {
                    const np = en.points.length;
                    const checkIdxs = en.closed
                        ? Array.from({ length: np }, (_, i) => i)
                        : [0, np - 1];
                    let bestIdx = -1, bestD = MATCH_TOL;
                    for (const idx of checkIdxs) {
                        const pt = en.points[idx];
                        if (!pt) continue;
                        const d = Math.hypot(pt[0] - vp[0], pt[1] - vp[1]);
                        if (d < bestD) { bestD = d; bestIdx = idx; }
                    }
                    if (bestIdx >= 0) {
                        const orig = en.points[bestIdx];
                        adj.push({
                            entityId: en.id, kind: "polyline", idx: bestIdx,
                            orig: [orig[0], orig[1]],
                            matchesArcStart,
                        });
                    }
                } else if (en.kind === "line") {
                    let bestIdx: -1 | 0 | 1 = -1, bestD = MATCH_TOL;
                    for (const idx of [0, 1] as const) {
                        const pt = idx === 0 ? en.p0 : en.p1;
                        const d = Math.hypot(pt[0] - vp[0], pt[1] - vp[1]);
                        if (d < bestD) { bestD = d; bestIdx = idx; }
                    }
                    if (bestIdx >= 0) {
                        const orig = bestIdx === 0 ? en.p0 : en.p1;
                        adj.push({
                            entityId: en.id, kind: "line", idx: bestIdx,
                            orig: [orig[0], orig[1]],
                            matchesArcStart,
                        });
                    }
                }
            }
        }
        setSelection([`poly:${polyId}`]);
        setLastDraggedPolyId(null);
        setDragState({
            kind: "entityArc",
            spaceId: activeRoomId,
            entityId: arc.id,
            polyId,
            origCenter: [arc.center[0], arc.center[1]],
            origAdjacentPoints: adj,
            startWorld: wp,
            moved: false,
        });
    };

    /**
     * 弧の **端点ハンドル** (start / end) ドラッグを開始する。
     *  - which="start" → aStart を更新、 which="end" → aEnd を更新
     *  - radius は cursor との距離で更新 (FreeCAD 流: 端点が cursor に追従)
     *  - その端点と一致していた polyline / line endpoint は、新しい端点位置に
     *    snap して chain 接続を保つ
     *  - 反対端点 (= radius 変化に伴って世界座標が変わる) と一致する
     *    polyline / line endpoint も追従させる
     */
    const startEntityArcEndpointDrag = (
        arc: ArcEntity,
        polyId: string,
        which: "start" | "end",
        wp: [number, number],
    ) => {
        if (!activeRoomId) return;
        const poly = (room.polygons ?? []).find((p) => p.id === polyId);
        const draggedAdj: DragEntityArcEndpointState["origDraggedAdj"] = [];
        const otherAdj: DragEntityArcEndpointState["origOtherAdj"] = [];
        if (poly?.edgeOwners) {
            const arcStart: [number, number] = [
                arc.center[0] + arc.radius * Math.cos(arc.aStart),
                arc.center[1] + arc.radius * Math.sin(arc.aStart),
            ];
            const arcEnd: [number, number] = [
                arc.center[0] + arc.radius * Math.cos(arc.aEnd),
                arc.center[1] + arc.radius * Math.sin(arc.aEnd),
            ];
            const polyEdgeList = polygonEdges(poly);
            const vertEdges = new Map<number, number[]>();
            for (let ei = 0; ei < polyEdgeList.length; ei++) {
                const [va, vb] = polyEdgeList[ei];
                for (const v of [va, vb]) {
                    const arr = vertEdges.get(v) ?? [];
                    arr.push(ei);
                    vertEdges.set(v, arr);
                }
            }
            const MATCH_TOL = 1e-2;
            for (const [vi, edges] of vertEdges) {
                if (edges.length !== 2) continue;
                const o0 = poly.edgeOwners[edges[0]];
                const o1 = poly.edgeOwners[edges[1]];
                let otherOwnerId: string | undefined;
                if (o0 === arc.id && o1 && o1 !== arc.id) otherOwnerId = o1;
                else if (o1 === arc.id && o0 && o0 !== arc.id) otherOwnerId = o0;
                if (!otherOwnerId) continue;
                const en = (room.entities ?? []).find((e) => e.id === otherOwnerId);
                if (!en) continue;
                const vp = poly.outer[vi];
                const dStart = Math.hypot(vp[0] - arcStart[0], vp[1] - arcStart[1]);
                const dEnd = Math.hypot(vp[0] - arcEnd[0], vp[1] - arcEnd[1]);
                const isOnDragSide =
                    (which === "start" && dStart <= dEnd) ||
                    (which === "end" && dEnd < dStart);
                const targetList = isOnDragSide ? draggedAdj : otherAdj;
                if (en.kind === "polyline") {
                    const np = en.points.length;
                    const checkIdxs = en.closed
                        ? Array.from({ length: np }, (_, i) => i)
                        : [0, np - 1];
                    let bestIdx = -1, bestD = MATCH_TOL;
                    for (const idx of checkIdxs) {
                        const pt = en.points[idx];
                        if (!pt) continue;
                        const d = Math.hypot(pt[0] - vp[0], pt[1] - vp[1]);
                        if (d < bestD) { bestD = d; bestIdx = idx; }
                    }
                    if (bestIdx >= 0) {
                        targetList.push({ entityId: en.id, kind: "polyline", idx: bestIdx });
                    }
                } else if (en.kind === "line") {
                    let bestIdx: -1 | 0 | 1 = -1, bestD = MATCH_TOL;
                    for (const idx of [0, 1] as const) {
                        const pt = idx === 0 ? en.p0 : en.p1;
                        const d = Math.hypot(pt[0] - vp[0], pt[1] - vp[1]);
                        if (d < bestD) { bestD = d; bestIdx = idx; }
                    }
                    if (bestIdx >= 0) {
                        targetList.push({ entityId: en.id, kind: "line", idx: bestIdx });
                    }
                }
            }
        }
        setSelection([`poly:${polyId}`]);
        setLastDraggedPolyId(null);
        setDragState({
            kind: "entityArcEndpoint",
            spaceId: activeRoomId,
            entityId: arc.id,
            polyId,
            which,
            origCenter: [arc.center[0], arc.center[1]],
            origRadius: arc.radius,
            origAStart: arc.aStart,
            origAEnd: arc.aEnd,
            origDraggedAdj: draggedAdj,
            origOtherAdj: otherAdj,
            startWorld: wp,
            moved: false,
        });
    };

    // ─── Event handlers ───
    const handlePointerDown = (e: React.PointerEvent) => {
        if (e.button !== 0) return;
        try {
            e.currentTarget.setPointerCapture(e.pointerId);
        } catch {
            // ignore browsers/cases where capture is unavailable
        }
        const wp = unproject(e.clientX, e.clientY);
        if (!wp) return;
        (window as any).__viewportInteracting = true;
        // クリック / ドラッグ判定の基準点を保存。
        dragStartScreenRef.current = [e.clientX, e.clientY];

        // Wall tool + active room: overlay acts as a sketch-picker only.
        // Vertex / edge / circle hits toggle sketch selection (for the
        // constraint panel); anything else is forwarded to Viewport for
        // wall drawing.
        // **roomEditMode が "select" のときだけ** wall-tool 経路に入る。
        // Rectangle / Polyline / WallPath / Circle / Line / Arc / ArcEdge /
        // Trim / WallSkip のような「クリックで作図する」サブモードでは、
        // wall ツールがアクティブでも room edit 経路を優先する (= でないと
        // WallPath ボタンを押しても wall ツールが captureして開ポリラインが
        // 描けない)。
        if (activeTool === "wall" && activeRoomId && roomEditMode === "select") {
            const r = getCanvasRect();
            const sx = e.clientX - (r?.left ?? 0), sy = e.clientY - (r?.top ?? 0);
            const additive = e.shiftKey || e.ctrlKey || e.metaKey;

            // 外壁 outline polygon を直接ピックしても、拘束対象は中央線スケッチ
            // (= primary polygon) に向ける。outline は wallSync の派生再生成で
            // 毎回作り直されるため、outline target の拘束は wallRegenerate.ts
            // で削除されてしまう。primary に向けておけば拘束が維持される。
            const redirectToPrimary = (polyId: string): string => {
                const p = room.polygons?.find((q) => q.id === polyId);
                if (p?.wallOutlineOf) return p.wallOutlineOf;
                return polyId;
            };

            const pvtx = hitTestPolyVertex(sx, sy);
            if (pvtx) {
                toggleSketchSelection({
                    kind: "point",
                    spaceId: activeRoomId,
                    polyId: redirectToPrimary(pvtx.polyId),
                    vertexIdx: pvtx.vertexIdx,
                }, additive);
                return;
            }
            // Circle outline (parametric円の周) → 円全体を選択。Edge 検出より先に
            // チェックすることで、テッセレーションされた多数の line segment より
            // 「弧、円で扱う」方を優先する。
            const circleOut = hitTestCircleOutline(sx, sy);
            if (circleOut) {
                toggleSketchSelection({
                    kind: "circle",
                    spaceId: activeRoomId,
                    polyId: redirectToPrimary(circleOut.polyId),
                }, additive);
                return;
            }
            const edge = hitTestEdge(sx, sy);
            if (edge) {
                // Arc 由来の edge は弧全体 (= entity) を 1 つの単位として
                // 選択する。テッセレーション辺ごとに別物として扱わない。
                const ePoly = room.polygons?.find((p) => p.id === edge.polyId);
                const ownerId = ePoly?.edgeOwners?.[edge.edgeIdx];
                const ownerEnt = ownerId
                    ? (room.entities ?? []).find((en) => en.id === ownerId)
                    : undefined;
                if (ownerEnt && (ownerEnt.kind === "arc" || ownerEnt.kind === "circle")) {
                    if (ownerEnt.kind === "circle") {
                        // Circle entity (= 自己閉) は circle 選択に統一。
                        toggleSketchSelection({
                            kind: "circle",
                            spaceId: activeRoomId,
                            polyId: redirectToPrimary(edge.polyId),
                        }, additive);
                    } else {
                        toggleSketchSelection({
                            kind: "entity",
                            spaceId: activeRoomId,
                            entityId: ownerEnt.id,
                        }, additive);
                    }
                    return;
                }
                toggleSketchSelection({
                    kind: "edge",
                    spaceId: activeRoomId,
                    polyId: redirectToPrimary(edge.polyId),
                    edgeIdx: edge.edgeIdx,
                }, additive);
                return;
            }
            // 通芯 (Grid) ヒット → gridPoint / gridLine を sketch selection に追加。
            // 部屋モードで「通芯との距離拘束」を組むための選択ピックアップ。
            const gh = hitTestGrid(sx, sy);
            if (gh) {
                toggleSketchSelection(gh, additive);
                return;
            }
            // Parametric circle interior → toggle circle sketch-selection
            const ph = hitTestPoly(wp[0], wp[1]);
            if (ph) {
                const poly = room.polygons?.find((p) => p.id === ph);
                if (poly?.shape?.type === "circle") {
                    toggleSketchSelection({
                        kind: "circle",
                        spaceId: activeRoomId,
                        polyId: ph,
                    }, additive);
                    return;
                }
            }
            // Empty click (or non-sketchable hit) → forward to Viewport.
            wallPassthroughRef.current = true;
            dispatchToViewport(e, "pointerdown");
            return;
        }

        if (roomEditMode === "polyline") {
            const snapped = applyDrawSnap(wp).p;
            // Click near the first committed point (≥3 points) closes the polygon
            if (polyDraftPoints.length >= 3) {
                const first = polyDraftPoints[0];
                const closeDist = Math.hypot(snapped[0] - first[0], snapped[1] - first[1]);
                if (closeDist < 0.3) {
                    // 閉じ確定: incremental で描いていた open polyline と壁を
                    // 破棄して、改めて closed polyline (= 部屋) を作る。
                    discardLiveWallPathDraft();
                    commitPolyDraft(polyDraftPoints);
                    return;
                }
            }
            const newDraft: [number, number][] = [...polyDraftPoints, snapped];
            setPolyDraftPoints(newDraft);
            setMouseWorld(snapped);
            // ── incremental 3D 壁描画 (= wallPath と同じ機構を流用) ─────
            // 2 点目以降のクリックで wallPath の incremental commit を呼んで、
            // open polyline entity + 3D 壁をリアルタイムに生成する。閉じ
            // クリックで closed polyline に切り替わる。
            wallPathDraftSnapsRef.current = [
                ...wallPathDraftSnapsRef.current,
                undefined,
            ];
            if (newDraft.length >= 2) {
                commitWallPathDraft(newDraft, false);
            }
            return;
        }

        // wallPath: 単独壁用の開いたポリライン。Enter / 右クリック / ダブル
        // クリックで確定 (≥2 点)。**閉ループ判定は行わない** — ユーザ仕様で
        // WallPath は常に開いたポリラインとして確定する (= Room を勝手に
        // 作らない)。
        // applyWallPathSnap で既存壁の頂点・辺 (= スケッチ線) にスナップ。
        // 2 点目以降のクリックでは isFinal=false で incremental commit を呼んで
        // 3D 壁をリアルタイムに生成・拡張する。
        // スナップ確定情報 (= target) を `wallPathDraftSnapsRef` に積み、
        // commit 時に polygon の `joints[]` として保存する。
        if (roomEditMode === "wallPath") {
            const snap = applyWallPathSnap(wp);
            const snapped = snap.p;
            const newDraft: [number, number][] = [...polyDraftPoints, snapped];
            setPolyDraftPoints(newDraft);
            setMouseWorld(snapped);
            wallPathDraftSnapsRef.current = [
                ...wallPathDraftSnapsRef.current,
                snap.target,
            ];
            if (newDraft.length >= 2) {
                commitWallPathDraft(newDraft, false);
            }
            return;
        }

        if (roomEditMode === "circle") {
            const snapped = applyDrawSnap(wp).p;
            if (!circleCenter) {
                setCircleCenter(snapped);
                setMouseWorld(snapped);
            } else {
                const r = Math.hypot(snapped[0] - circleCenter[0], snapped[1] - circleCenter[1]);
                // incremental commit が live 円を作っているので、isFinal=true で
                // ref をクリアして最終 entity として確定する (新規生成しない)。
                commitCircleDraftIncremental(circleCenter, r, true);
            }
            return;
        }

        if (roomEditMode === "rectangle") {
            dragStateRef.current = null;
            setDragState(null);
            useAppState.setState({ solverDragHint: [] });
            const snapped = applyDrawSnap(wp).p;
            if (!rectStart) {
                setRectStart(snapped);
                setMouseWorld(snapped);
            }
            else {
                // Create a 4-vertex polygon (canonical [BL, BR, TR, TL]) and
                // attach the auto-rect constraint set so that subsequent edits
                // keep it axis-aligned.
                const minX = Math.min(rectStart[0], snapped[0]);
                const maxX = Math.max(rectStart[0], snapped[0]);
                const minY = Math.min(rectStart[1], snapped[1]);
                const maxY = Math.max(rectStart[1], snapped[1]);
                if (maxX - minX > 1e-6 && maxY - minY > 1e-6) {
                    // Suppress solves while the entity and its orientation
                    // constraints are created. The rectangle is already committed
                    // with valid coordinates; solving unconstrained orientation
                    // constraints at creation time can move it to another free
                    // solution. Future edits still solve normally.
                    const SUPPRESS_PIN: import("../../application/AppState").SolverDragPin = {
                        spaceId: (activeRoomId ?? pendingRoomLevelId ?? "__rect_commit__") as ElementId,
                        polyId: "__rect_commit__",
                        vertexIdx: -1,
                        x: 0,
                        y: 0,
                    };
                    setSolverDragHint([SUPPRESS_PIN]);
                    try {
                        const entity: PolylineEntity = {
                            id: generateId(),
                            kind: "polyline",
                            points: [
                                [minX, minY],
                                [maxX, minY],
                                [maxX, maxY],
                                [minX, maxY],
                            ],
                            closed: true,
                        };
                        if (ROOM_SHAPE_DEBUG) {
                            // eslint-disable-next-line no-console
                            console.log(
                                `[room-debug] rectangle commit rectStart=${fmtDbgPt(rectStart)} `
                                + `snapped=${fmtDbgPt(snapped)} entity=${entity.id.slice(0, 6)} `
                                + `points=${fmtDbgRing(entity.points)}`,
                            );
	                        }
	                        const result = commitClosedEntity(entity);
	                        if (result?.polyId) {
	                            setActiveRoom(result.roomId);
	                            activeRoomIdRef.current = result.roomId;
	                            lastRectangleCommitAtRef.current = Date.now();
	                            for (const c of autoRectConstraints(result.roomId, result.polyId)) {
	                                executeCommand(new AddConstraintCommand(c, { solve: false }));
	                            }
	                            if (ROOM_SHAPE_DEBUG) {
                                const fresh = useAppState.getState().elements[result.roomId as string] as SpaceElement | undefined;
                                const poly = fresh?.polygons?.find((p) => p.id === result.polyId);
                                // eslint-disable-next-line no-console
                                console.log(
	                                    `[room-debug] rectangle committed room=${(result.roomId as string).slice(0, 6)} `
	                                    + `poly=${result.polyId.slice(0, 6)} `
	                                    + `polyOuter=${poly ? `${poly.outer.length}v${fmtDbgRing(poly.outer)}` : "<missing>"} `
	                                    + `constraints=Horizontal,Horizontal,Vertical,Vertical`,
	                                );
                            }
                        }
                    } finally {
                        useAppState.setState({ solverDragHint: [] });
                    }
                }
                dragStateRef.current = null;
	                setDragState(null);
	                useAppState.setState({ solverDragHint: [] });
	                suppressSelectDragUntilPointerUpRef.current = true;
	                setRectStart(null); setMouseWorld(null); setGridSnapInfo(null);
	            }
            return;
        }

        // Single line entity: 2 clicks. The entity is "open" — no polygon is
        // derived; downstream consumers (snapping / wall pipeline) read the
        // entity directly.
        if (roomEditMode === "line") {
            const snapped = applyDrawSnap(wp).p;
            if (!lineStart) { setLineStart(snapped); setMouseWorld(snapped); return; }
            const len = Math.hypot(snapped[0] - lineStart[0], snapped[1] - lineStart[1]);
            if (len > 1e-6) {
                const entity: LineEntity = {
                    id: generateId(), kind: "line",
                    p0: [lineStart[0], lineStart[1]],
                    p1: [snapped[0], snapped[1]],
                };
                commitOpenEntity(entity);
            }
            setLineStart(null); setMouseWorld(null); setGridSnapInfo(null);
            setRoomEditMode("select");
            return;
        }

        // Arc entity: 3 クリック (弦 P0 → 弦 P1 → bulge カーソル)。
        // 1 点目・2 点目で弦の両端 (= 弧の両端点) を確定。3 点目はカーソルが
        // 弦のどちら側にあるかで「カーソル側を通る弧」を構築する
        // (= `arcFromChordAndCursor` ヘルパが中心 / 半径 / aStart / aEnd を導出)。
        // 既存の arcEdge モード (= 既存エッジを chord として円弧化) と同じ式。
        if (roomEditMode === "arc") {
            const snapped = applyDrawSnap(wp).p;
            if (!arcChordP0) {
                setArcChordP0(snapped); setMouseWorld(snapped); return;
            }
            if (!arcChordP1) {
                const chord = Math.hypot(snapped[0] - arcChordP0[0], snapped[1] - arcChordP0[1]);
                if (chord < 1e-6) return; // ignore degenerate (重複クリック)
                setArcChordP1(snapped);
                setMouseWorld(snapped);
                return;
            }
            // 3 点目: カーソルで bulge を決める。
            const arc = arcFromChordAndCursor(arcChordP0, arcChordP1, snapped);
            if (arc) {
                const entity: ArcEntity = {
                    id: generateId(), kind: "arc",
                    center: [arc.center[0], arc.center[1]],
                    radius: arc.radius,
                    aStart: arc.aStart,
                    aEnd: arc.aEnd,
                };
                commitOpenEntity(entity);
            }
            setArcChordP0(null); setArcChordP1(null); setMouseWorld(null); setGridSnapInfo(null);
            setRoomEditMode("select");
            return;
        }

        // arcEdge mode: 選択エッジを chord として固定し、クリック位置の bulge で
        // 円弧化。chord は context menu で確定済み。
        if (roomEditMode === "arcEdge") {
            const snapped = applyDrawSnap(wp).p;
            if (arcEdgeChord) {
                const ok = commitEdgeAsArc(arcEdgeChord, [snapped[0], snapped[1]]);
                if (!ok) {
                    // eslint-disable-next-line no-console
                    console.warn("[arcEdge] commit 失敗 (chord 由来の entity 不一致)");
                }
            }
            setArcEdgeChord(null);
            setMouseWorld(null);
            setGridSnapInfo(null);
            setRoomEditMode("select");
            return;
        }

        // Trim mode: 3-stage pick.
        //  1. click on a circle/arc to pick the target
        //  2. click a first cut point on it
        //  3. click a second cut point — the segment between (CCW) becomes
        //     the kept arc (= circle is replaced by an ArcEntity).
        if (roomEditMode === "trim") {
            const snapped = applyDrawSnap(wp).p;
            if (!activeRoomId) return;
            const space = elements[activeRoomId] as SpaceElement | undefined;
            if (!space) return;
            const tol = 0.15; // m, generous pick tolerance for trim
            if (!trimTargetEntityId) {
                // Find a circle/arc under the click.
                let bestId: string | null = null;
                let bestDist = tol;
                for (const ent of space.entities ?? []) {
                    if (ent.kind !== "circle" && ent.kind !== "arc") continue;
                    const hit = pickEntity(ent, snapped, tol);
                    if (hit && hit.distance < bestDist) {
                        bestDist = hit.distance;
                        bestId = ent.id;
                    }
                }
                if (bestId) {
                    setTrimTargetEntityId(bestId);
                    setTrimFirstPoint(null);
                }
                return;
            }
            // Already picked a target.
            const target = (space.entities ?? []).find((e) => e.id === trimTargetEntityId);
            if (!target || (target.kind !== "circle" && target.kind !== "arc")) {
                setTrimTargetEntityId(null); setTrimFirstPoint(null);
                return;
            }
            if (!trimFirstPoint) {
                setTrimFirstPoint(snapped);
                return;
            }
            // Both cut points selected — convert circle to arc (CCW kept side).
            const cx = target.center[0], cy = target.center[1];
            const a1 = Math.atan2(trimFirstPoint[1] - cy, trimFirstPoint[0] - cx);
            const a2 = Math.atan2(snapped[1] - cy, snapped[0] - cx);
            if (target.kind === "circle") {
                const newArc = trimCircleToArc(target, a1, a2);
                setSpaceEntities(activeRoomId, (es) =>
                    es.map((e) => (e.id === target.id ? newArc : e)),
                );
            } else {
                // Already an arc — clamp to [a1, a2] within current sweep.
                const s = wrap2pi(a1 - target.aStart);
                if (s > 0 && s < arcSweep(target)) {
                    setSpaceEntities(activeRoomId, (es) => es.map((e) => {
                        if (e.id !== target.id || e.kind !== "arc") return e;
                        return { ...e, aStart: a1, aEnd: a2 } as ArcEntity;
                    }));
                }
            }
            setTrimTargetEntityId(null); setTrimFirstPoint(null);
            setMouseWorld(null); setGridSnapInfo(null);
            setRoomEditMode("select");
            return;
        }

        // wallSkip mode (Trim と同じ 3 段ピック):
        //   stage 1 (draft なし): エッジをクリックして対象を決定
        //   stage 2 (draft.t0 === null): 1 つ目の切断点をクリック (= t0 確定)
        //   stage 3 (draft.t0 あり): 2 つ目をクリック → polygon.wallSkips に push
        // 右クリックは段階的キャンセル (handleContextMenu 側で実装)。
        if (roomEditMode === "wallSkip") {
            // ─ Stage 1: エッジ未選択。スクリーン位置でエッジをヒットテスト。
            if (!wallSkipDraft) {
                if (!activeRoomId) return;
                const r = getCanvasRect();
                const sx = e.clientX - (r?.left ?? 0);
                const sy = e.clientY - (r?.top ?? 0);
                const edge = hitTestEdge(sx, sy);
                if (edge) {
                    setWallSkipDraft({
                        spaceId: activeRoomId,
                        polyId: edge.polyId,
                        edgeIdx: edge.edgeIdx,
                        t0: null,
                    });
                }
                return;
            }
            // ─ Stage 2 / 3: t0 → t1。
            const draft = wallSkipDraft;
            const sp = elements[draft.spaceId] as SpaceElement | undefined;
            const poly = sp?.polygons?.find((p) => p.id === draft.polyId);
            if (!poly) { setWallSkipDraft(null); return; }
            const edges = polygonEdges(poly);
            if (draft.edgeIdx < 0 || draft.edgeIdx >= edges.length) {
                setWallSkipDraft(null); return;
            }
            const [ai, bi] = edges[draft.edgeIdx];
            const a = poly.outer[ai];
            const b = poly.outer[bi];
            const dx = b[0] - a[0], dy = b[1] - a[1];
            const len2 = dx * dx + dy * dy;
            if (len2 < 1e-12) { setWallSkipDraft(null); return; }
            const t = Math.max(
                0,
                Math.min(1, ((wp[0] - a[0]) * dx + (wp[1] - a[1]) * dy) / len2),
            );
            if (draft.t0 === null) {
                setWallSkipDraft({ ...draft, t0: t });
                return;
            }
            const t0 = Math.min(draft.t0, t);
            const t1 = Math.max(draft.t0, t);
            if (t1 - t0 < 1e-4) {
                // 同一点クリック扱い: 再度 t0 から。
                setWallSkipDraft({ ...draft, t0: null });
                return;
            }
            // T0, T1 を world 座標で確定 (= 新しい polygon 頂点になる位置)。
            const T0w: Vec2 = [a[0] + dx * t0, a[1] + dy * t0];
            const T1w: Vec2 = [a[0] + dx * t1, a[1] + dy * t1];

            const promoted = promoteWallSkipToVertices({
                spaceId: draft.spaceId,
                polyId: draft.polyId,
                edgeIdx: draft.edgeIdx,
                Va: [a[0], a[1]],
                Vb: [b[0], b[1]],
                T0: T0w,
                T1: T1w,
                t0,
                t1,
            });

            if (!promoted) {
                // arc / circle / chain match 失敗: 仮想 wallSkip にフォールバック。
                const latest = useAppState.getState().elements[draft.spaceId] as SpaceElement | undefined;
                if (latest) {
                    const newPolys = latest.polygons.map((p) => {
                        if (p.id !== draft.polyId) return p;
                        const cur = p.wallSkips ?? [];
                        return {
                            ...p,
                            wallSkips: [...cur, { edgeIdx: draft.edgeIdx, t0, t1 }],
                        };
                    });
                    updateElement(draft.spaceId as ElementId, {
                        polygons: newPolys,
                        dirtyFlags: new Set([...(latest.dirtyFlags ?? []), "Geometry", "Mesh", "Render"]),
                    } as any);
                }
            }

            const s = useAppState.getState();
            regenerateAllWalls({
                wallThicknessMm: s.wallThicknessMm,
                circleWallAngleDeg: s.circleWallAngleDeg,
                wallReferenceMode: s.wallReferenceMode,
                seedPolyIds: [draft.polyId],
            });

            // 連続編集を許す: draft をリセットしてエッジ pick から再開。mode は維持。
            setWallSkipDraft(null);
            setMouseWorld(null); setGridSnapInfo(null);
            return;
        }

        if (roomEditMode === "select") {
            const liveActiveRoomId = useAppState.getState().activeRoomId;
            if (liveActiveRoomId && activeRoomId && liveActiveRoomId !== activeRoomId) {
                dragStateRef.current = null;
                setDragState(null);
                useAppState.setState({ solverDragHint: [] });
                if (ROOM_SHAPE_DEBUG) {
                    // eslint-disable-next-line no-console
                    console.log(
                        `[room-debug] select drag suppressed stale activeRoom closure `
                        + `closure=${(activeRoomId as string).slice(0, 6)} live=${(liveActiveRoomId as string).slice(0, 6)}`,
                    );
                }
                return;
            }
            if (Date.now() - lastRectangleCommitAtRef.current < 500) {
                dragStateRef.current = null;
                setDragState(null);
                useAppState.setState({ solverDragHint: [] });
                if (ROOM_SHAPE_DEBUG) {
                    // eslint-disable-next-line no-console
                    console.log("[room-debug] select drag suppressed just after rectangle commit");
                }
                return;
            }
            if (suppressSelectDragUntilPointerUpRef.current) {
                setDragState(null);
                useAppState.setState({ solverDragHint: [] });
                if (ROOM_SHAPE_DEBUG) {
                    // eslint-disable-next-line no-console
                    console.log("[room-debug] select drag suppressed until pointerup");
                }
                dragStateRef.current = null;
                return;
            }
            const r = getCanvasRect();
            const sx = e.clientX - (r?.left ?? 0), sy = e.clientY - (r?.top ?? 0);

            // FreeCAD 流の弧/円ハンドル (中心 / 弧端点) ヒットテスト。
            // 選択中の弧/円エンティティに対してのみ表示している diamond /
            // square マーカに対応する。Vertex / Edge より優先する。
            if (activeRoomId) {
                const handle = hitTestEntityHandle(sx, sy);
                if (handle) {
                    const ent = (room.entities ?? []).find((x) => x.id === handle.entityId);
                    if (handle.kind === "arcCenter" && ent && ent.kind === "arc") {
                        // 中心ハンドル = 弧全体を平行移動 (= 既存 entityArc と同じ
                        // データ構造を再利用)。隣接 polyline / line の追従ロジックも
                        // 同じ仕組みで動くよう、`origAdjacentPoints` を構築する。
                        startEntityArcDrag(ent, handle.polyId, wp);
                        return;
                    }
                    if (handle.kind === "arcEndpoint" && ent && ent.kind === "arc") {
                        startEntityArcEndpointDrag(ent, handle.polyId, handle.which, wp);
                        return;
                    }
                    if (handle.kind === "circleCenter" && ent && ent.kind === "circle") {
                        setSelection([`poly:${handle.polyId}`]);
                        setLastDraggedPolyId(null);
                        setDragState({
                            kind: "entityCircleCenter",
                            spaceId: activeRoomId,
                            entityId: ent.id,
                            polyId: handle.polyId,
                            origCenter: [ent.center[0], ent.center[1]],
                            startWorld: wp,
                            moved: false,
                        });
                        return;
                    }
                }
            }

            // Vertex (cross-space): 非アクティブ Room の頂点も直接拾える。
            // 当たった polygon が別 Space ならアクティブを切り替えて同ジェスチャで
            // ドラッグ開始。entity / polyIdByEntity も対象 Room から引く。
            const pvtxX = hitTestPolyVertexAcrossSpaces(sx, sy);
            if (pvtxX) {
                const targetRoomId = pvtxX.spaceId as ElementId;
                const targetRoom = elements[targetRoomId] as SpaceElement | undefined;
                const poly = targetRoom?.polygons?.find(p => p.id === pvtxX.polyId);
                if (targetRoom && poly) {
                    if (targetRoomId !== activeRoomId) {
                        setActiveRoom(targetRoomId);
                        activeRoomIdRef.current = targetRoomId;
                    }
                    setSelection([]);
                    setLastDraggedPolyId(null);
                    let dragEntityId: string | null = null;
                    let dragEntityPointIdx = -1;
                    const polyIdByEntityVtx = targetRoom.polyIdByEntity ?? {};
                    for (const eid in polyIdByEntityVtx) {
                        if (polyIdByEntityVtx[eid] === pvtxX.polyId) { dragEntityId = eid; break; }
                    }
                    if (dragEntityId) {
                        const ent = (targetRoom.entities ?? []).find((e) => e.id === dragEntityId);
                        if (ent && ent.kind === "polyline") {
                            const targetPt = poly.outer[pvtxX.vertexIdx];
                            for (let i = 0; i < ent.points.length; i++) {
                                const ep = ent.points[i];
                                if (Math.hypot(ep[0] - targetPt[0], ep[1] - targetPt[1]) < 1e-3) {
                                    dragEntityPointIdx = i;
                                    break;
                                }
                            }
                        }
                    }
                    if (ROOM_SHAPE_DEBUG) {
                        // eslint-disable-next-line no-console
                        console.log(
                            `[room-debug] drag start kind=polyVertex room=${(targetRoomId as string).slice(0, 6)} `
                            + `poly=${pvtxX.polyId.slice(0, 6)} v=${pvtxX.vertexIdx} `
                            + `entity=${dragEntityId?.slice(0, 6) ?? "<none>"} entityPoint=${dragEntityPointIdx}`,
                        );
                    }
                    const linkedPolys = collectLinkedPolysForTranslate(
                        pvtxX.polyId, targetRoomId as string,
                        elements, constraints,
                    );
                    const newDragState: DragPolyVertexState = {
                        kind: "polyVertex",
                        polyId: pvtxX.polyId,
                        vertexIdx: pvtxX.vertexIdx,
                        origOuter: poly.outer.map(p => [p[0], p[1]] as Vec2),
                        origHoles: (poly.holes ?? []).map(h => h.map(p => [p[0], p[1]] as Vec2)),
                        wallThickness: poly.wallThickness,
                        moved: false,
                        entityId: dragEntityPointIdx >= 0 ? dragEntityId : null,
                        entityPointIdx: dragEntityPointIdx >= 0 ? dragEntityPointIdx : undefined,
                        linkedPolys,
                    };
                    setDragState(newDragState);
                    dragStateRef.current = newDragState;
                    return;
                }
            }

            // 円ポリゴンの周 → 円を選択 + radius ドラッグ開始 (FreeCAD 流:
            // rim ドラッグ = 半径変更)。ドラッグせずに離せば選択トグルのまま。
            if (activeRoomId) {
                const circleOut = hitTestCircleOutline(sx, sy);
                if (circleOut) {
                    const additive = e.shiftKey || e.ctrlKey || e.metaKey;
                    toggleSketchSelection({
                        kind: "circle",
                        spaceId: activeRoomId,
                        polyId: circleOut.polyId,
                    }, additive);
                    // 対応 entity を引いて、circle entity ならドラッグ準備。
                    const map = room.polyIdByEntity ?? {};
                    let circleEntId: string | null = null;
                    for (const eid in map) {
                        if (map[eid] === circleOut.polyId) { circleEntId = eid; break; }
                    }
                    const ent = circleEntId
                        ? (room.entities ?? []).find((x) => x.id === circleEntId)
                        : undefined;
                    if (ent && ent.kind === "circle") {
                        setDragState({
                            kind: "entityCircleRadius",
                            spaceId: activeRoomId,
                            entityId: ent.id,
                            polyId: circleOut.polyId,
                            center: [ent.center[0], ent.center[1]],
                            moved: false,
                        });
                    }
                    return;
                }
            }

            // Edge (cross-space): 非アクティブ Room の辺も直接拾える。
            const edgeX = hitTestEdgeAcrossSpaces(sx, sy);
            if (edgeX) {
                const targetRoomId = edgeX.spaceId as ElementId;
                const targetRoom = elements[targetRoomId] as SpaceElement | undefined;
                const poly = targetRoom?.polygons?.find(p => p.id === edgeX.polyId);
                if (targetRoom && poly) {
                    if (targetRoomId !== activeRoomId) {
                        setActiveRoom(targetRoomId);
                        activeRoomIdRef.current = targetRoomId;
                    }
                    // Arc 由来 edge は弧全体を平行移動する entityArc ドラッグへ。
                    const ownerId = poly.edgeOwners?.[edgeX.edgeIdx];
                    const ownerEnt = ownerId
                        ? (targetRoom.entities ?? []).find((en) => en.id === ownerId)
                        : undefined;
                    if (ownerEnt && ownerEnt.kind === "arc") {
                        startEntityArcDrag(ownerEnt, edgeX.polyId, wp);
                        return;
                    }
                    const polyEdgeList = polygonEdges(poly);
                    const [va, vb] = polyEdgeList[edgeX.edgeIdx];
                    const ex = poly.outer[vb][0] - poly.outer[va][0];
                    const ez = poly.outer[vb][1] - poly.outer[va][1];
                    const len = Math.hypot(ex, ez) || 1;
                    const normal: [number, number] = [-ez / len, ex / len];
                    setSelection([]);
                    setLastDraggedPolyId(null);
                    // line+arc D 形状判定 (ターゲット Room の entity を使う)
                    let origEntitiesForTranslate:
                        | { entityId: string; snapshot: SketchEntity }[]
                        | undefined;
                    if (ownerEnt && (ownerEnt.kind === "line" || ownerEnt.kind === "polyline")) {
                        const polyEntities = collectPolyEntitiesSnapshot(targetRoom, edgeX.polyId);
                        if (polyEntities.length === 2) {
                            const hasArc = polyEntities.some((p) => p.snapshot.kind === "arc");
                            const hasLineish = polyEntities.some(
                                (p) => p.snapshot.kind === "line" || p.snapshot.kind === "polyline",
                            );
                            if (hasArc && hasLineish) {
                                origEntitiesForTranslate = polyEntities;
                            }
                        }
                    }
                    let edgeDragEntityId: string | null = null;
                    let edgeDragEntityPointA = -1;
                    let edgeDragEntityPointB = -1;
                    const polyIdByEntityE = targetRoom.polyIdByEntity ?? {};
                    for (const eid in polyIdByEntityE) {
                        if (polyIdByEntityE[eid] === edgeX.polyId) { edgeDragEntityId = eid; break; }
                    }
                    if (edgeDragEntityId) {
                        const ent = (targetRoom.entities ?? []).find((e) => e.id === edgeDragEntityId);
                        if (ent && ent.kind === "polyline") {
                            const ptA = poly.outer[va];
                            const ptB = poly.outer[vb];
                            for (let i = 0; i < ent.points.length; i++) {
                                const ep = ent.points[i];
                                if (edgeDragEntityPointA < 0
                                    && Math.hypot(ep[0] - ptA[0], ep[1] - ptA[1]) < 1e-3) {
                                    edgeDragEntityPointA = i;
                                }
                                if (edgeDragEntityPointB < 0
                                    && Math.hypot(ep[0] - ptB[0], ep[1] - ptB[1]) < 1e-3) {
                                    edgeDragEntityPointB = i;
                                }
                            }
                        }
                    }
                    const linkedPolys = collectLinkedPolysForTranslate(
                        edgeX.polyId, targetRoomId as string,
                        elements, constraints,
                    );
                    // SUPPRESS_PIN: 最初の setSpaceEntities で solver が走らないように。
                    setSolverDragHint([{
                        spaceId: targetRoomId,
                        polyId: edgeX.polyId,
                        vertexIdx: -1,
                        x: 0, y: 0,
                    }]);
                    const newDragState: DragPolyEdgeState = {
                        kind: "polyEdge",
                        polyId: edgeX.polyId,
                        edgeIdx: edgeX.edgeIdx,
                        origOuter: poly.outer.map(p => [p[0], p[1]] as Vec2),
                        origHoles: (poly.holes ?? []).map(h => h.map(p => [p[0], p[1]] as Vec2)),
                        normal,
                        wallThickness: poly.wallThickness,
                        startWorld: wp,
                        moved: false,
                        origEntitiesForTranslate,
                        entityId: (edgeDragEntityPointA >= 0 && edgeDragEntityPointB >= 0)
                            ? edgeDragEntityId : null,
                        entityPointIdxA: edgeDragEntityPointA >= 0 ? edgeDragEntityPointA : undefined,
                        entityPointIdxB: edgeDragEntityPointB >= 0 ? edgeDragEntityPointB : undefined,
                        linkedPolys,
                    };
                    setDragState(newDragState);
                    dragStateRef.current = newDragState;
                    return;
                }
            }

            // 通芯 (Grid) ヒット → gridPoint / gridLine を sketch selection に
            // 追加。部屋モードで「点-通芯の垂直距離」「点-通芯端点の距離」など
            // 通芯参照拘束を組めるようにする。Edge / Vertex ヒットには優先しない
            // ので、polygon 上のクリックは従来通り polygon を選ぶ。
            {
                const gh = hitTestGrid(sx, sy);
                if (gh) {
                    const additive = e.shiftKey || e.ctrlKey || e.metaKey;
                    toggleSketchSelection(gh, additive);
                    return;
                }
            }

            // Wall pick
            const [cx, cz] = wp;
            let closestD = Infinity, closestId: string | null = null;
            for (const id in elements) {
                const el = elements[id];
                if (el.type === "Wall") {
                    const w = el as WallElement;
                    const [ax, , az] = w.axis[0], [bx, , bz] = w.axis[1];
                    const dx = bx - ax, dz = bz - az, lsq = dx * dx + dz * dz;
                    let t = lsq > 0 ? ((cx - ax) * dx + (cz - az) * dz) / lsq : 0;
                    t = Math.max(0, Math.min(1, t));
                    const d = Math.hypot(cx - (ax + t * dx), cz - (az + t * dz));
                    if (d < 0.5 && d < closestD) { closestD = d; closestId = id; }
                }
            }
            if (closestId) { setSelection([closestId]); return; }

            // Polygon interior
            const ph = hitTestPoly(cx, cz);
            // 「後から追加した矩形を優先」のレイヤ原則を満たすため、active 側に
            // ヒットしていても、より新しい (createdAt が大きい) Room の polygon が
            // この点で重なっているなら active commit を見送り、下の cross-Room
            // 切替パスに処理を委ねる。これがないと一度 active になった古い Room の
            // polygon が常に勝ってしまい、上に乗っている新しい Room を選択できない。
            let newerRoomOverlapsHere = false;
            if (ph) {
                const activeSpaceForPick = activeRoomId
                    ? (elements[activeRoomId] as SpaceElement | undefined)
                    : undefined;
                const activeCreatedAtForPick = activeSpaceForPick?.createdAt ?? -Infinity;
                const editingLvlForPick: ElementId | null =
                    (activeSpaceForPick?.levelId as ElementId | undefined)
                    ?? (pendingRoomLevelId as ElementId | null | undefined)
                    ?? null;
                for (const oid in elements) {
                    if (oid === activeRoomId) continue;
                    const oel = elements[oid];
                    if (!oel || oel.type !== "Space") continue;
                    const ospace = oel as SpaceElement;
                    if (!ospace.polygons) continue;
                    if (editingLvlForPick !== null
                        && ospace.levelId
                        && ospace.levelId !== editingLvlForPick) continue;
                    if ((ospace.createdAt ?? -Infinity) <= activeCreatedAtForPick) continue;
                    let hit = false;
                    for (let i = ospace.polygons.length - 1; i >= 0; i--) {
                        const op = ospace.polygons[i];
                        if (op.wallOutlineOf) continue;
                        if (!isPolygonClosed(op)) continue;
                        if (pointInRoomPolygon(cx, cz, op.outer, op.holes ?? [])) {
                            hit = true;
                            break;
                        }
                    }
                    if (hit) { newerRoomOverlapsHere = true; break; }
                }
            }
            if (ph && !newerRoomOverlapsHere && room.polygons) {
                const poly = room.polygons.find(p => p.id === ph)!;
                const additive = e.shiftKey || e.ctrlKey || e.metaKey;
                const polyToken = `poly:${ph}`;
                if (additive) {
                    const exists = selection.includes(polyToken);
                    if (exists) {
                        setSelection(selection.filter((s) => s !== polyToken));
                    } else {
                        // Keep any existing poly selections, drop non-poly entries
                        const kept = selection.filter((s) => s.startsWith("poly:"));
                        setSelection([...kept, polyToken]);
                    }
                } else {
                    setSelection([polyToken]);
                }
                setLastDraggedPolyId(null);
                const origWallAxes: { id: string; a: Vec3; b: Vec3 }[] = [];
                if (poly.wallIds) {
                    for (const wid of poly.wallIds) {
                        if (!wid) continue;
                        const wEl = elements[wid] as WallElement | undefined;
                        if (wEl && wEl.type === "Wall") {
                            origWallAxes.push({
                                id: wid,
                                a: [wEl.axis[0][0], wEl.axis[0][1], wEl.axis[0][2]],
                                b: [wEl.axis[1][0], wEl.axis[1][1], wEl.axis[1][2]],
                            });
                        }
                    }
                }
                // Capture concentric partners (if this is a parametric circle)
                const origConcentric: DragPolyState["origConcentric"] = [];
                if (poly.shape?.type === "circle" && room.polygons) {
                    const group = new Set<string>([ph]);
                    let grew = true;
                    while (grew) {
                        grew = false;
                        for (const cid in constraints) {
                            const cc = constraints[cid];
                            if (cc.type !== "ConcentricCircle") continue;
                            const ids = cc.targets
                                .filter((t) => t.kind === "SketchCircle")
                                .map((t) => (t as any).polyId as string);
                            if (ids.some((id) => group.has(id))) {
                                for (const id of ids) {
                                    if (!group.has(id)) { group.add(id); grew = true; }
                                }
                            }
                        }
                    }
                    for (const p of room.polygons) {
                        if (p.id === ph || !group.has(p.id) || p.shape?.type !== "circle") continue;
                        origConcentric.push({
                            polyId: p.id,
                            outer: p.outer.map((pt) => [pt[0], pt[1]] as Vec2),
                            holes: (p.holes ?? []).map((h) => h.map((pt) => [pt[0], pt[1]] as Vec2)),
                            shapeCenter: [p.shape.center[0], p.shape.center[1]],
                            shapeRadius: p.shape.radius,
                        });
                    }
                }

                // Capture wall-outline partners for this polygon
                const origOutlines: DragPolyState["origOutlines"] = [];
                if (room.polygons) {
                    for (const op of room.polygons) {
                        if (op.wallOutlineOf !== ph) continue;
                        origOutlines.push({
                            polyId: op.id,
                            outer: op.outer.map((pt) => [pt[0], pt[1]] as Vec2),
                            holes: (op.holes ?? []).map((h) => h.map((pt) => [pt[0], pt[1]] as Vec2)),
                        });
                    }
                }

                // Capture entities backing this polygon (= polyIdByEntity reverse).
                // 各 entity の **値を deep copy** してスナップショットを作る。
                // ドラッグ中は origEntities を真実とし、毎フレーム total delta で
                // 平行移動した結果を setSpaceEntities に書く。re-derive で polygon
                // outer は自動更新される。
                const origEntities = collectPolyEntitiesSnapshot(room, ph);
                // cross-poly 拘束 (Collinear/Parallel/Perpendicular/Length) で
                // 連結された別 polygon を BFS で集める。連結 polygon は同じ delta
                // で一緒に平行移動する (= 向き・距離系の拘束を保つ)。
                const linkedPolys = collectLinkedPolysForTranslate(
                    ph as string, activeRoomId as string,
                    elements, constraints,
                );
                if (ROOM_SHAPE_DEBUG) {
                    // eslint-disable-next-line no-console
                    console.log(
                        `[room-debug] drag start kind=poly room=${(activeRoomId as string).slice(0, 6)} `
                        + `poly=${ph.slice(0, 6)} at=(${wp[0].toFixed(3)},${wp[1].toFixed(3)}) `
                        + `entityCount=${origEntities.length} linkedPolys=${linkedPolys.length}`,
                    );
                }
                // drag 開始時点でソルバ抑制ピンを立てておく。これがないと最初の
                // pointermove で setSpaceEntities が走った瞬間に solverDragHint が
                // まだ空 → ソルバが起動してしまい、translate 後の entity を
                // 古い位置へ「戻す」writeback が発火する (= mouseup 直後の bounce-back
                // の原因)。本物の頂点ピンは pointermove で上書きする。
                setSolverDragHint([{
                    spaceId: activeRoomId as ElementId,
                    polyId: ph,
                    vertexIdx: -1,
                    x: 0, y: 0,
                }]);
                const newPolyDragState: DragPolyState = {
                    kind: "poly",
                    polyId: ph,
                    spaceId: activeRoomId as string,
                    startWorld: wp,
                    origOuter: poly.outer.map(p => [p[0], p[1]] as Vec2),
                    origHoles: (poly.holes ?? []).map(h => h.map(p => [p[0], p[1]] as Vec2)),
                    origShapeCenter: poly.shape?.type === "circle"
                        ? [poly.shape.center[0], poly.shape.center[1]]
                        : undefined,
                    origShapeRadius: poly.shape?.type === "circle" ? poly.shape.radius : undefined,
                    origWallAxes,
                    origConcentric,
                    origOutlines,
                    origEntities,
                    linkedPolys,
                    moved: false,
                };
                setDragState(newPolyDragState);
                // re-render を待たずに pointermove から読めるよう ref も即座に更新。
                dragStateRef.current = newPolyDragState;
                return;
            }

            // Inactive-room interior pick: clicking inside a polygon that
            // belongs to a non-active Space switches focus to that room AND
            // starts an interior drag in the same gesture, so previously-
            // drawn rooms stay editable. Vertex/edge handles are still only
            // rendered for the active room — to vertex-edit an inactive
            // room, click its interior first to activate it.
            //
            // **レベルガード**: 編集中レベル以外の部屋 (= 灰色の参照線として
            // 描画している他階の部屋) はクリックで誤って active 化されない
            // ようにフィルタする。クリックは無視 (= 通過) して、別の処理 /
            // 何もしないに流れる。
            {
                const editingLvlForClick: ElementId | null =
                    (activeRoomId
                        ? ((elements[activeRoomId] as SpaceElement | undefined)?.levelId as ElementId | undefined)
                        : (pendingRoomLevelId as ElementId | null | undefined))
                    ?? null;
                // 重なっている Room が複数ある場合は `createdAt` が最大 (= 後から
                // 追加した Room) を優先する。これにより矩形を重ねた際に「上に
                // 乗せた方の Room を選択できない」状態を防ぐ。
                let hitOtherRoomId: ElementId | null = null;
                let hitOtherPoly: RoomPolygon | null = null;
                let hitOtherCreatedAt = -Infinity;
                for (const oid in elements) {
                    if (oid === activeRoomId) continue;
                    const oel = elements[oid];
                    if (!oel || oel.type !== "Space") continue;
                    const ospace = oel as SpaceElement;
                    if (!ospace.polygons) continue;
                    // 他階の部屋 (= 編集中レベルと違う) はスキップ。
                    if (editingLvlForClick !== null
                        && ospace.levelId
                        && ospace.levelId !== editingLvlForClick) continue;
                    let candidatePoly: RoomPolygon | null = null;
                    for (let i = ospace.polygons.length - 1; i >= 0; i--) {
                        const op = ospace.polygons[i];
                        if (op.wallOutlineOf) continue;
                        if (!isPolygonClosed(op)) continue;
                        if (pointInRoomPolygon(cx, cz, op.outer, op.holes ?? [])) {
                            candidatePoly = op;
                            break;
                        }
                    }
                    if (!candidatePoly) continue;
                    const c = ospace.createdAt ?? -Infinity;
                    if (c >= hitOtherCreatedAt) {
                        hitOtherCreatedAt = c;
                        hitOtherRoomId = oid;
                        hitOtherPoly = candidatePoly;
                    }
                }
                if (hitOtherRoomId && hitOtherPoly) {
                    // 別 Room の領域をクリックした場合: **同ジェスチャでアクティブ
                    // 切替 + ドラッグ開始**。以前は state 遷移途中の pointermove が
                    // 古い closure を参照する懸念から 2 ステップ (= 切替して指を
                    // 離す → 再度掴む) にしていたが、polyTranslate の本体は
                    // `dragState` (= snapshot) のみで完結する設計なので、
                    // setActiveRoom の re-render を待たずに 1 ジェスチャでドラッグ
                    // できる。snapshot に `spaceId / polyId / origOuter /
                    // origEntities` を確定済みで保存するので、closure が古くても
                    // pointermove ハンドラが必要な情報を読める。
                    const targetRoomId = hitOtherRoomId;
                    const targetPoly = hitOtherPoly;
                    const targetRoom = elements[targetRoomId] as SpaceElement;
                    setActiveRoom(targetRoomId);
                    activeRoomIdRef.current = targetRoomId;
                    setSelection([`poly:${targetPoly.id}`]);
                    setLastDraggedPolyId(null);
                    // ── drag snapshot 構築 (active 側と同じデータ構造) ──
                    const origWallAxes: { id: string; a: Vec3; b: Vec3 }[] = [];
                    if (targetPoly.wallIds) {
                        for (const wid of targetPoly.wallIds) {
                            if (!wid) continue;
                            const wEl = elements[wid] as WallElement | undefined;
                            if (wEl && wEl.type === "Wall") {
                                origWallAxes.push({
                                    id: wid,
                                    a: [wEl.axis[0][0], wEl.axis[0][1], wEl.axis[0][2]],
                                    b: [wEl.axis[1][0], wEl.axis[1][1], wEl.axis[1][2]],
                                });
                            }
                        }
                    }
                    const origConcentric: DragPolyState["origConcentric"] = [];
                    if (targetPoly.shape?.type === "circle" && targetRoom.polygons) {
                        const group = new Set<string>([targetPoly.id]);
                        let grew = true;
                        while (grew) {
                            grew = false;
                            for (const cid in constraints) {
                                const cc = constraints[cid];
                                if (cc.type !== "ConcentricCircle") continue;
                                const ids = cc.targets
                                    .filter((t) => t.kind === "SketchCircle")
                                    .map((t) => (t as any).polyId as string);
                                if (ids.some((id) => group.has(id))) {
                                    for (const id of ids) {
                                        if (!group.has(id)) { group.add(id); grew = true; }
                                    }
                                }
                            }
                        }
                        for (const p of targetRoom.polygons) {
                            if (p.id === targetPoly.id || !group.has(p.id) || p.shape?.type !== "circle") continue;
                            origConcentric.push({
                                polyId: p.id,
                                outer: p.outer.map((pt) => [pt[0], pt[1]] as Vec2),
                                holes: (p.holes ?? []).map((h) => h.map((pt) => [pt[0], pt[1]] as Vec2)),
                                shapeCenter: [p.shape.center[0], p.shape.center[1]],
                                shapeRadius: p.shape.radius,
                            });
                        }
                    }
                    const origOutlines: DragPolyState["origOutlines"] = [];
                    if (targetRoom.polygons) {
                        for (const op of targetRoom.polygons) {
                            if (op.wallOutlineOf !== targetPoly.id) continue;
                            origOutlines.push({
                                polyId: op.id,
                                outer: op.outer.map((pt) => [pt[0], pt[1]] as Vec2),
                                holes: (op.holes ?? []).map((h) => h.map((pt) => [pt[0], pt[1]] as Vec2)),
                            });
                        }
                    }
                    const origEntities = collectPolyEntitiesSnapshot(targetRoom, targetPoly.id);
                    const linkedPolys = collectLinkedPolysForTranslate(
                        targetPoly.id, targetRoomId as string,
                        elements, constraints,
                    );
                    // ソルバ抑制ピン (= 最初の setSpaceEntities で solver が走らない
                    // ようにする)。本物のピンは pointermove で上書き。
                    setSolverDragHint([{
                        spaceId: targetRoomId,
                        polyId: targetPoly.id,
                        vertexIdx: -1,
                        x: 0, y: 0,
                    }]);
                    const newDragState: DragPolyState = {
                        kind: "poly",
                        polyId: targetPoly.id,
                        spaceId: targetRoomId as string,
                        startWorld: wp,
                        origOuter: targetPoly.outer.map(p => [p[0], p[1]] as Vec2),
                        origHoles: (targetPoly.holes ?? []).map(h => h.map(p => [p[0], p[1]] as Vec2)),
                        origShapeCenter: targetPoly.shape?.type === "circle"
                            ? [targetPoly.shape.center[0], targetPoly.shape.center[1]]
                            : undefined,
                        origShapeRadius: targetPoly.shape?.type === "circle" ? targetPoly.shape.radius : undefined,
                        origWallAxes,
                        origConcentric,
                        origOutlines,
                        origEntities,
                        linkedPolys,
                        moved: false,
                    };
                    setDragState(newDragState);
                    // re-render を待たずに pointermove から読めるよう ref も即座に更新。
                    dragStateRef.current = newDragState;
                    return;
                }
            }

            // Empty click — preserve selection when Shift/Ctrl is held
            if (!(e.shiftKey || e.ctrlKey || e.metaKey)) setSelection([]);
            setLastDraggedPolyId(null);
        }
    };

    const handlePointerMove = (e: React.PointerEvent) => {
        // Wall-mode pass-through: while the gesture started as an empty-area
        // click, forward all moves to Viewport so the wall preview tracks
        // the cursor. Also forward when no gesture is active so the snap
        // indicator updates live.
        if (activeTool === "wall" && activeRoomId) {
            if (wallPassthroughRef.current || !dragState) {
                dispatchToViewport(e, "pointermove");
            }
            if (wallPassthroughRef.current) return;
        }

        const wp = unproject(e.clientX, e.clientY);
        if ((roomEditMode === "polyline" || roomEditMode === "wallPath") && wp) {
            // wallPath は壁スケッチ線スナップ込み、polyline は既存形状スナップ。
            const s = roomEditMode === "wallPath"
                ? applyWallPathSnap(wp)
                : applyDrawSnap(wp);
            setGridSnapInfo(s.info);
            setMouseWorld(s.p);
            return;
        }
        if (roomEditMode === "circle" && wp) {
            const s = applyDrawSnap(wp);
            setGridSnapInfo(s.info);
            setMouseWorld(s.p);
            // center 確定後はマウス移動に追従して live 円 + 3D 壁を更新する。
            if (circleCenter) {
                const r = Math.hypot(s.p[0] - circleCenter[0], s.p[1] - circleCenter[1]);
                if (r > 1e-3) {
                    commitCircleDraftIncremental(circleCenter, r, false);
                }
            }
            return;
        }
        if (roomEditMode === "arcEdge" && wp) {
            const s = applyDrawSnap(wp);
            setGridSnapInfo(s.info);
            setMouseWorld(s.p);
            return;
        }
        if (roomEditMode === "rectangle" && wp) {
            const s = applyDrawSnap(wp);
            setGridSnapInfo(s.info);
            if (rectStart) setMouseWorld(s.p);
            return;
        }
        // Line (= 単一直線, 2点) と Arc (= 3点指定の弧) でも snap プレビューを
        // 出す。click 時は applyDrawSnap が走るので結果としてはスナップしている
        // が、移動中に snap target が見えないとユーザは「スナップしていない」
        // と感じる。同じ applyDrawSnap でカーソル位置を補正しつつ
        // gridSnapInfo を立てて視覚フィードバックを出す。
        if ((roomEditMode === "line" || roomEditMode === "arc") && wp) {
            const s = applyDrawSnap(wp);
            setGridSnapInfo(s.info);
            setMouseWorld(s.p);
            return;
        }
        // Trim モードのカーソル追従。target 円/弧上に projection した位置を
        // mouseWorld に反映し、buildDrawLists の trim プレビューを駆動する。
        if (roomEditMode === "trim" && wp) {
            const s = applyDrawSnap(wp);
            setGridSnapInfo(s.info);
            setMouseWorld(s.p);
            return;
        }
        const liveDragState = dragStateRef.current;
        if (liveDragState && wp) {
            const dragState = liveDragState;
            if ((e.buttons & 1) === 0) {
                dragStateRef.current = null;
                setDragState(null);
                useAppState.setState({ solverDragHint: [] });
                if (ROOM_SHAPE_DEBUG) {
                    // eslint-disable-next-line no-console
                    console.log("[room-debug] stale drag cleared on pointermove without primary button");
                }
                return;
            }
            if (suppressSelectDragUntilPointerUpRef.current) {
                dragStateRef.current = null;
                setDragState(null);
                useAppState.setState({ solverDragHint: [] });
                if (ROOM_SHAPE_DEBUG) {
                    // eslint-disable-next-line no-console
                    console.log("[room-debug] drag move suppressed after rectangle commit");
                }
                return;
            }
            // ドラッグは実体 polygon が必要 → pending 中はそもそも到達しないが
            // TS narrow のためにガード。
            if (!activeRoomId) return;
            // クリック / ドラッグ判定: pointerdown 位置から DRAG_THRESHOLD_PX 未満
            // しか動いていなければまだ「クリック」とみなして translate 系を走らせ
            // ない。これでわずかなマウスジッタで Shift+クリック選択が捨てられる
            // のを防ぐ。閾値を超えた瞬間に moved=true にして以降は通常ドラッグ。
            if (!dragState.moved) {
                const start = dragStartScreenRef.current;
                if (start) {
                    const dxPx = e.clientX - start[0];
                    const dyPx = e.clientY - start[1];
                    if (Math.hypot(dxPx, dyPx) < DRAG_THRESHOLD_PX) return;
                }
                setDragState({ ...dragState, moved: true });
            }
            if (dragState.kind === "entityArc") {
                const d = dragState;
                const s = applyGridSnap(wp);
                setGridSnapInfo(s.info);
                // ── 弧が他の entity (line / polyline) と chord で連結している
                //    場合は **chord を固定して半径だけ変える** モード (FreeCAD の
                //    arc rim drag と同じ)。chord は origAdjacentPoints の orig
                //    位置 (= drag 開始時の line 端点) を使うので drag 中は不動。
                //    cursor 位置を通る新しい弧を `arcFromChordAndCursor` で計算し、
                //    弧 entity の center / radius / aStart / aEnd を更新する。
                //    隣接 line / polyline は更新しない (chord 固定なので)。
                if (d.origAdjacentPoints.length >= 2) {
                    const adjStart = d.origAdjacentPoints.find((a) => a.matchesArcStart);
                    const adjEnd = d.origAdjacentPoints.find((a) => !a.matchesArcStart);
                    if (adjStart && adjEnd) {
                        const arcParams = arcFromChordAndCursor(
                            adjStart.orig as Vec2,
                            adjEnd.orig as Vec2,
                            s.p,
                        );
                        if (arcParams) {
                            setSpaceEntities(d.spaceId as ElementId, (entities) =>
                                entities.map((e) => {
                                    if (e.id === d.entityId && e.kind === "arc") {
                                        return {
                                            ...e,
                                            center: arcParams.center,
                                            radius: arcParams.radius,
                                            aStart: arcParams.aStart,
                                            aEnd: arcParams.aEnd,
                                        };
                                    }
                                    return e;
                                }),
                            );
                        }
                        return;
                    }
                }
                // ── chord 連結が無い (= 独立した弧 entity) の場合は従来通り
                //    平行移動。隣接 polyline / line の端点も新 chord 端点に
                //    スナップさせて chain 接続を維持する。
                const dx = s.p[0] - d.startWorld[0];
                const dz = s.p[1] - d.startWorld[1];
                setSpaceEntities(d.spaceId as ElementId, (entities) => {
                    const arcEnt = entities.find(
                        (e) => e.id === d.entityId && e.kind === "arc",
                    ) as ArcEntity | undefined;
                    if (!arcEnt) return entities;
                    const newCenter: Vec2 = [d.origCenter[0] + dx, d.origCenter[1] + dz];
                    const newStart: Vec2 = [
                        newCenter[0] + arcEnt.radius * Math.cos(arcEnt.aStart),
                        newCenter[1] + arcEnt.radius * Math.sin(arcEnt.aStart),
                    ];
                    const newEnd: Vec2 = [
                        newCenter[0] + arcEnt.radius * Math.cos(arcEnt.aEnd),
                        newCenter[1] + arcEnt.radius * Math.sin(arcEnt.aEnd),
                    ];
                    return entities.map((e) => {
                        if (e.id === d.entityId && e.kind === "arc") {
                            return { ...e, center: newCenter };
                        }
                        const adj = d.origAdjacentPoints.filter((a) => a.entityId === e.id);
                        if (adj.length === 0) return e;
                        if (e.kind === "polyline") {
                            const newPoints = e.points.map((pt, idx) => {
                                const m = adj.find((a) => a.idx === idx);
                                if (!m) return pt;
                                return (m.matchesArcStart ? newStart : newEnd) as Vec2;
                            });
                            return { ...e, points: newPoints };
                        }
                        if (e.kind === "line") {
                            const m0 = adj.find((a) => a.idx === 0);
                            const m1 = adj.find((a) => a.idx === 1);
                            return {
                                ...e,
                                ...(m0 ? { p0: (m0.matchesArcStart ? newStart : newEnd) as Vec2 } : {}),
                                ...(m1 ? { p1: (m1.matchesArcStart ? newStart : newEnd) as Vec2 } : {}),
                            };
                        }
                        return e;
                    });
                });
                return;
            }
            if (dragState.kind === "entityArcEndpoint") {
                // 弧の端点 (start / end) を cursor に追従させる FreeCAD 流。
                //   - radius = |cursor - center|
                //   - aStart / aEnd = atan2(cursor - center)
                // 反対端点も radius 変化で世界座標が動くので、connected polyline /
                // line endpoint をそちらにも追従させる。
                const d = dragState;
                const s = applyGridSnap(wp);
                setGridSnapInfo(s.info);
                // **重要**: 現時点の arc 状態 (= 直前の solver 通過後) を使う。
                // d.origCenter (= drag 開始時) を使うと、solver の strategy A
                // 再計算で center が動いた後に polyline endpoint との整合が
                // 取れなくなり、ドラッグ中に「arc 端点が rect 角から離れる」
                // 不具合が出る。
                const liveSpace = useAppState.getState().elements[d.spaceId] as SpaceElement | undefined;
                const liveArc = liveSpace?.entities?.find((e) => e.id === d.entityId);
                if (!liveArc || liveArc.kind !== "arc") return;
                const cx = liveArc.center[0], cy = liveArc.center[1];
                const tx = s.p[0], ty = s.p[1];
                const newRadius = Math.max(1e-4, Math.hypot(tx - cx, ty - cy));
                const newAngle = Math.atan2(ty - cy, tx - cx);
                let newAStart = liveArc.aStart;
                let newAEnd = liveArc.aEnd;
                if (d.which === "start") newAStart = newAngle;
                else newAEnd = newAngle;
                const newDraggedPt: Vec2 = [tx, ty];
                const otherAngle = d.which === "start" ? newAEnd : newAStart;
                const newOtherPt: Vec2 = [
                    cx + newRadius * Math.cos(otherAngle),
                    cy + newRadius * Math.sin(otherAngle),
                ];
                setSpaceEntities(d.spaceId as ElementId, (entities) =>
                    entities.map((e) => {
                        if (e.id === d.entityId && e.kind === "arc") {
                            return { ...e, radius: newRadius, aStart: newAStart, aEnd: newAEnd };
                        }
                        const draggedAdj = d.origDraggedAdj.filter((a) => a.entityId === e.id);
                        const otherAdj = d.origOtherAdj.filter((a) => a.entityId === e.id);
                        if (draggedAdj.length === 0 && otherAdj.length === 0) return e;
                        if (e.kind === "polyline") {
                            const newPoints = e.points.map((pt, idx) => {
                                if (draggedAdj.find((a) => a.idx === idx)) return newDraggedPt;
                                if (otherAdj.find((a) => a.idx === idx)) return newOtherPt;
                                return pt;
                            });
                            return { ...e, points: newPoints };
                        }
                        if (e.kind === "line") {
                            const setIdx0 = draggedAdj.find((a) => a.idx === 0)
                                ? newDraggedPt
                                : otherAdj.find((a) => a.idx === 0)
                                    ? newOtherPt
                                    : null;
                            const setIdx1 = draggedAdj.find((a) => a.idx === 1)
                                ? newDraggedPt
                                : otherAdj.find((a) => a.idx === 1)
                                    ? newOtherPt
                                    : null;
                            return {
                                ...e,
                                ...(setIdx0 ? { p0: setIdx0 } : {}),
                                ...(setIdx1 ? { p1: setIdx1 } : {}),
                            };
                        }
                        return e;
                    }),
                );
                return;
            }
            if (dragState.kind === "entityCircleCenter") {
                // 円中心ハンドル → 円全体を平行移動 (entity.center を更新)。
                const d = dragState;
                const s = applyGridSnap(wp);
                setGridSnapInfo(s.info);
                const dx = s.p[0] - d.startWorld[0];
                const dz = s.p[1] - d.startWorld[1];
                setSpaceEntities(d.spaceId as ElementId, (entities) =>
                    entities.map((e) => {
                        if (e.id === d.entityId && e.kind === "circle") {
                            return {
                                ...e,
                                center: [d.origCenter[0] + dx, d.origCenter[1] + dz] as Vec2,
                            };
                        }
                        return e;
                    }),
                );
                return;
            }
            if (dragState.kind === "entityCircleRadius") {
                // 円の周ドラッグ → 半径変更 (FreeCAD 流の rim drag)。
                const d = dragState;
                const s = applyGridSnap(wp);
                setGridSnapInfo(s.info);
                const newR = Math.max(1e-4, Math.hypot(s.p[0] - d.center[0], s.p[1] - d.center[1]));
                setSpaceEntities(d.spaceId as ElementId, (entities) =>
                    entities.map((e) => {
                        if (e.id === d.entityId && e.kind === "circle") {
                            return { ...e, radius: newR };
                        }
                        return e;
                    }),
                );
                return;
            }
            if (dragState.kind === "polyVertex") {
                const currentPoly = room.polygons.find((p) => p.id === dragState.polyId);
                // 頂点ドラッグでは他の部屋の頂点・辺・通芯交点・軸整列にスナップ
                // する (= applyWallPathSnap)。自分自身の他頂点に吸着して動けなく
                // なるのを避けるため、自 polygon は excludePolyId で除外する。
                // 閉じたポリゴン (= 部屋) も開いたポリライン (= WallPath) も
                // 同じ振る舞い。
                const s = applyWallPathSnap(wp, { excludePolyId: dragState.polyId });
                setGridSnapInfo(s.info);
                const sp = s.p;

                // Resolve the "effective outline" being dragged:
                //   (a) direct — dragState is on a wall-outline polygon, or
                //   (b) indirect — the dragged vertex is Coincident with a
                //       wall-outline vertex, so the drag is redirected to
                //       that outline (and thus to its inner).
                // Only single-hop Coincident links are followed.
                let effOutline: RoomPolygon | undefined;
                let effOutlineVertexIdx = dragState.vertexIdx;
                if (currentPoly?.wallOutlineOf) {
                    effOutline = currentPoly;
                } else if (currentPoly) {
                    for (const cid in constraints) {
                        const cc = constraints[cid];
                        if (cc.type !== "Coincident" || cc.targets.length < 2) continue;
                        const t1 = cc.targets[0], t2 = cc.targets[1];
                        if (t1.kind !== "SketchPoint" || t2.kind !== "SketchPoint") continue;
                        const matches = (t: typeof t1) =>
                            t.polyId === dragState.polyId && t.vertexIdx === dragState.vertexIdx;
                        const otherT = matches(t1) ? t2 : matches(t2) ? t1 : null;
                        if (!otherT) continue;
                        const cand = room.polygons.find((p) => p.id === otherT.polyId);
                        if (!cand?.wallOutlineOf) continue;
                        effOutline = cand;
                        effOutlineVertexIdx = otherT.vertexIdx;
                        break;
                    }
                }
                const effInnerId = effOutline?.wallOutlineOf;
                const effInner = effInnerId
                    ? room.polygons.find((p) => p.id === effInnerId)
                    : undefined;

                // Outer-drag path: reverse-map the cursor through negative
                // mitering to derive a new inner ring, then update the INNER
                // polygon. The inner update flows through updatePolysAndSync
                // which re-derives the outline + walls so the outer vertex
                // lands at (≈) the cursor. For the indirect (Coincident)
                // case, the dragged vertex is also synced to the cursor
                // in the same frame to avoid async-solver visual lag — the
                // Coincident still holds (rect.v = outline.v = cursor).
                // Works for arbitrary polygon vertex counts.
                if (effOutline && effInner && effInner.wallThickness != null
                    && effInner.outer.length === effOutline.outer.length
                    && effOutline.outer.length >= 3
                ) {
                    const baseOutline = effOutline.outer;
                    const newOutline: Vec2[] = baseOutline.map((pt, i) =>
                        i === effOutlineVertexIdx ? [sp[0], sp[1]] as Vec2 : [pt[0], pt[1]] as Vec2,
                    );
                    let cx = 0, cy = 0;
                    for (const v of newOutline) { cx += v[0]; cy += v[1]; }
                    cx /= newOutline.length; cy /= newOutline.length;
                    const newInnerOuter = computeMiteredCorners(
                        newOutline, [cx, cy], -effInner.wallThickness,
                    );
                    setSolverDragHint({
                        spaceId: activeRoomId,
                        polyId: effInner.id,
                        vertexIdx: effOutlineVertexIdx,
                        x: newInnerOuter[effOutlineVertexIdx][0],
                        y: newInnerOuter[effOutlineVertexIdx][1],
                    });
                    // ── entity-driven outline drag ───────────────────────────
                    // outline は inner からの派生なので、inner 側の entity を更新する。
                    // newInnerOuter は newOutline の各点を負方向ミタリングしたもので、
                    // inner.outer と 1:1 対応する (= 同じ頂点数)。inner の entity が
                    // 閉 polyline なら entity.points 1:1 で更新。entity 不在ならフォール
                    // バックで polygon 直書き。
                    const polyIdByEntityOL = room.polyIdByEntity ?? {};
                    let innerEntityId: string | null = null;
                    for (const eid in polyIdByEntityOL) {
                        if (polyIdByEntityOL[eid] === effInner.id) { innerEntityId = eid; break; }
                    }
                    const innerEnt = innerEntityId
                        ? (room.entities ?? []).find((e) => e.id === innerEntityId)
                        : undefined;
                    if (innerEnt && innerEnt.kind === "polyline"
                        && innerEnt.points.length === newInnerOuter.length) {
                        // entity を更新して polygon を derive 経由で更新。
                        setSpaceEntities(activeRoomId, (entities) =>
                            entities.map((e) => {
                                if (e.id !== innerEntityId) return e;
                                if (e.kind !== "polyline") return e;
                                return {
                                    ...e,
                                    points: newInnerOuter.map((p) => [p[0], p[1]] as Vec2),
                                };
                            }),
                        );
                        return;
                    }
                    // フォールバック: entity 不在 / 頂点数不一致 (= split あり) なら旧 polygon 直書き。
                    const redirected = effOutline.id !== dragState.polyId;
                    const newPolys = room.polygons.map((p) => {
                        if (p.id === effInner.id) return { ...p, outer: newInnerOuter };
                        if (redirected && p.id === dragState.polyId) {
                            const upd = p.outer.map((pt, i) =>
                                i === dragState.vertexIdx ? [sp[0], sp[1]] as Vec2 : [pt[0], pt[1]] as Vec2,
                            );
                            return { ...p, outer: upd };
                        }
                        return p;
                    });
                    updatePolysAndSync(newPolys);
                    return;
                }

                // ── Inner-drag entity-driven path ────────────────────────────
                // 設計原則 (= ユーザ指示): entity が真値、polygon は entity からの
                // 一方通行 derive。drag handler は entity の points を直接動かす。
                // polygon は setSpaceEntities → derivePolygonsFromEntities で自動更新。
                // entityId / entityPointIdx は drag 開始時点で確定済 (dragState 内)。
                const dragEntityId = dragState.entityId;
                const entityPointIdx = dragState.entityPointIdx ?? -1;
                const dragEnt = dragEntityId
                    ? (room.entities ?? []).find((e) => e.id === dragEntityId)
                    : undefined;
                // eslint-disable-next-line no-console
                console.log(
                    `[drag-move] polyVertex poly=${dragState.polyId.slice(0,6)} v=${dragState.vertexIdx} `
                    + `entId=${dragEntityId?.slice(0,6) ?? "<none>"} entIdx=${entityPointIdx} `
                    + `entKind=${dragEnt?.kind ?? "<none>"} cursor=(${sp[0].toFixed(3)},${sp[1].toFixed(3)})`,
                );
                // entity が無い (= legacy polygon、または split 頂点掴み) ならフォールバックで polygon 直書き。
                if (!dragEnt || dragEnt.kind !== "polyline" || entityPointIdx < 0) {
                    setSolverDragHint({
                        spaceId: activeRoomId,
                        polyId: dragState.polyId,
                        vertexIdx: dragState.vertexIdx,
                        x: sp[0],
                        y: sp[1],
                    });
                    const baseOuter = currentPoly?.outer ?? dragState.origOuter;
                    const newOuter: Vec2[] = baseOuter.map((pt, i) =>
                        i === dragState.vertexIdx ? [sp[0], sp[1]] as Vec2 : [pt[0], pt[1]] as Vec2,
                    );
                    propagateSimpleConstraints(newOuter, dragState.polyId, dragState.vertexIdx, constraints);
                    const newPolys = room.polygons.map(p => {
                        if (p.id !== dragState.polyId) return p;
                        return { ...p, outer: newOuter, holes: currentPoly?.holes ?? dragState.origHoles };
                    });
                    updatePolysAndSync(newPolys);
                    return;
                }
                // 新しい entity points を構築 (= 該当点だけ cursor へ動かす)。
                const newPoints: Vec2[] = dragEnt.points.map((p, i) =>
                    i === entityPointIdx ? [sp[0], sp[1]] as Vec2 : [p[0], p[1]] as Vec2,
                );
                // H/V/Coincident の simple propagation を entity.points 上で実行
                // (= 派生 polygon は entity と 1:1 対応するので indices が一致する)。
                propagateSimpleConstraints(newPoints, dragState.polyId, entityPointIdx, constraints);
                setSolverDragHint({
                    spaceId: activeRoomId,
                    polyId: dragState.polyId,
                    vertexIdx: entityPointIdx,
                    x: newPoints[entityPointIdx][0],
                    y: newPoints[entityPointIdx][1],
                });
                // Cross-poly Coincident propagation:
                // propagateSimpleConstraints が H/V cascade で動かした全頂点に対して
                // cross-poly Coincident を伝播する。直接ドラッグした頂点だけだと、
                // 「BR drag → V cascade で TR が動く → TR の Coincident で Room2 を動かす」
                // という連鎖が抜け、Room2 だけ取り残されて solver が enforce で形状を
                // 崩す原因になっていた。
                interface CrossPolyMove { newPos: [number, number]; vertexIdx: number; }
                const crossPolyMoves = new Map<string, CrossPolyMove[]>();
                // 動いた頂点 set を origPoints との比較で算出。
                const movedEntityIdxs = new Set<number>();
                for (let i = 0; i < newPoints.length; i++) {
                    const orig = dragEnt.points[i];
                    const np = newPoints[i];
                    if (Math.hypot(np[0] - orig[0], np[1] - orig[1]) > 1e-6) {
                        movedEntityIdxs.add(i);
                    }
                }
                for (const cid in constraints) {
                    const c = constraints[cid];
                    if (c.type !== "Coincident" || c.targets.length < 2) continue;
                    const t1 = c.targets[0], t2 = c.targets[1];
                    if (t1.kind !== "SketchPoint" || t2.kind !== "SketchPoint") continue;
                    let here: typeof t1 | null = null, partner: typeof t2 | null = null;
                    if (t1.polyId === dragState.polyId && t2.polyId !== dragState.polyId) {
                        here = t1; partner = t2;
                    } else if (t2.polyId === dragState.polyId && t1.polyId !== dragState.polyId) {
                        here = t2; partner = t1;
                    }
                    if (!here || !partner) continue;
                    if (!movedEntityIdxs.has(here.vertexIdx)) continue;
                    const list = crossPolyMoves.get(partner.polyId) ?? [];
                    list.push({
                        newPos: [newPoints[here.vertexIdx][0], newPoints[here.vertexIdx][1]],
                        vertexIdx: partner.vertexIdx,
                    });
                    crossPolyMoves.set(partner.polyId, list);
                }
                // 自分の entity を更新 → polygon が derive で更新される。
                setSpaceEntities(activeRoomId, (entities) =>
                    entities.map((e) => {
                        if (e.id !== dragEntityId) return e;
                        if (e.kind !== "polyline") return e;
                        return { ...e, points: newPoints };
                    }),
                );
                // Cross-poly 相手の entity も更新。
                if (crossPolyMoves.size > 0) {
                    const liveAll = useAppState.getState().elements;
                    for (const [partnerPolyId, moves] of crossPolyMoves) {
                        for (const eid in liveAll) {
                            const el = liveAll[eid];
                            if (!el || el.type !== "Space") continue;
                            const psp = el as SpaceElement;
                            if (!psp.polygons?.some((p) => p.id === partnerPolyId)) continue;
                            const partnerPolyIdByEntity = psp.polyIdByEntity ?? {};
                            let partnerEntityId: string | null = null;
                            for (const peid in partnerPolyIdByEntity) {
                                if (partnerPolyIdByEntity[peid] === partnerPolyId) {
                                    partnerEntityId = peid; break;
                                }
                            }
                            if (!partnerEntityId) break;
                            const partnerEnt = (psp.entities ?? []).find((e) => e.id === partnerEntityId);
                            if (!partnerEnt || partnerEnt.kind !== "polyline") break;
                            const updatedPartnerPoints: Vec2[] = partnerEnt.points.map((pt, i) => {
                                const m = moves.find((mv) => mv.vertexIdx === i);
                                return m ? [m.newPos[0], m.newPos[1]] as Vec2 : [pt[0], pt[1]] as Vec2;
                            });
                            for (const m of moves) {
                                propagateSimpleConstraints(updatedPartnerPoints, partnerPolyId, m.vertexIdx, constraints);
                            }
                            const pid = partnerEntityId;
                            setSpaceEntities(eid as ElementId, (entities) =>
                                entities.map((e) => {
                                    if (e.id !== pid) return e;
                                    if (e.kind !== "polyline") return e;
                                    return { ...e, points: updatedPartnerPoints };
                                }),
                            );
                            break;
                        }
                    }
                }
                // ── linkedPolys (Collinear/Parallel/Perp/Length) 同期 ────────────
                // propagateSimpleConstraints の cascade で「ある polygon edge の
                // 両端点が drag 開始時から **累計** で同じ delta で動いた」場合、
                // その edge は剛体平行移動したことになる。連結 polygon も同じ
                // 累計 delta で rigid 平行移動して collinear 関係を保つ。
                // 単純な単一頂点ドラッグ (= cascade なし) では「両端点同 delta」の
                // edge が見つからないので何もしない (= 連結 polygon は静止)。
                const linkedPolysV = dragState.linkedPolys ?? [];
                // eslint-disable-next-line no-console
                console.log(
                    `[vtx-drag] linkedPolys=${linkedPolysV.length} `
                    + `details=${linkedPolysV.map((l) => `${l.polyId.slice(0,6)}(ents=${l.origEntities.length})`).join(",")}`,
                );
                if (linkedPolysV.length > 0) {
                    const dragPolyForEdge = useAppState.getState()
                        .elements[activeRoomId as string] as SpaceElement | undefined;
                    const dragPolyObj = dragPolyForEdge?.polygons?.find((p) => p.id === dragState.polyId);
                    if (dragPolyObj) {
                        const polyEdgeListV = polygonEdges(dragPolyObj);
                        // 累計 delta = newPoints[k] - dragState.origOuter[k]
                        // Collinear / Parallel は **edge に垂直な方向の translate** が
                        // 一致していれば「edge 全体が平行移動した」とみなせる
                        // (= edge に沿う方向の delta は collinear を破らないので無視)。
                        // この perp-only 判定にすると、矩形の頂点ドラッグで一方の
                        // 端点が edge 沿いに動いた場合 (= もう片方は H/V cascade で
                        // perp 方向だけ動く) でも edge の perp 平行移動を検出できる。
                        let bestEdgeDelta: [number, number] | null = null;
                        const edgeDeltas: string[] = [];
                        for (let ei = 0; ei < polyEdgeListV.length; ei++) {
                            const [ai, bi] = polyEdgeListV[ei];
                            if (ai >= newPoints.length || bi >= newPoints.length) continue;
                            if (ai >= dragState.origOuter.length || bi >= dragState.origOuter.length) continue;
                            const oA = dragState.origOuter[ai];
                            const oB = dragState.origOuter[bi];
                            const nA = newPoints[ai];
                            const nB = newPoints[bi];
                            const adx = nA[0] - oA[0], ady = nA[1] - oA[1];
                            const bdx = nB[0] - oB[0], bdy = nB[1] - oB[1];
                            // edge 方向 (orig 基準) と perp 方向。
                            const edx = oB[0] - oA[0], edy = oB[1] - oA[1];
                            const elen = Math.hypot(edx, edy);
                            if (elen < 1e-9) continue;
                            const ux = edx / elen, uy = edy / elen;
                            const nx = -uy, ny = ux; // 90° CCW perp
                            // 各端点の perp 成分
                            const aPerp = adx * nx + ady * ny;
                            const bPerp = bdx * nx + bdy * ny;
                            edgeDeltas.push(
                                `e${ei}(${ai},${bi}):a=(${adx.toFixed(3)},${ady.toFixed(3)})/perp=${aPerp.toFixed(3)} `
                                + `b=(${bdx.toFixed(3)},${bdy.toFixed(3)})/perp=${bPerp.toFixed(3)}`,
                            );
                            if (Math.abs(aPerp - bPerp) > 1e-6) continue;
                            if (Math.abs(aPerp) < 1e-9) continue;
                            // この edge に cross-poly 拘束があるかチェック。
                            let hasCross = false;
                            for (const cid in constraints) {
                                const c = constraints[cid];
                                if (c.type !== "Collinear" && c.type !== "Parallel"
                                    && c.type !== "Perpendicular" && c.type !== "Length") continue;
                                if (!Array.isArray(c.targets)) continue;
                                const onEdge = c.targets.some((t: any) =>
                                    t.kind === "SketchEdge"
                                    && t.polyId === dragState.polyId
                                    && t.edgeIdx === ei,
                                );
                                if (!onEdge) continue;
                                const otherSide = c.targets.some((t: any) =>
                                    (t.kind === "SketchEdge" || t.kind === "SketchPoint")
                                    && t.polyId !== dragState.polyId,
                                );
                                if (otherSide) { hasCross = true; break; }
                            }
                            if (hasCross) {
                                // perp 方向のみで translate (edge に沿う方向の delta は無視)。
                                bestEdgeDelta = [aPerp * nx, aPerp * ny];
                                break;
                            }
                        }
                        // eslint-disable-next-line no-console
                        console.log(
                            `[vtx-drag] edges=[${edgeDeltas.join(" | ")}] `
                            + `bestEdgeDelta=${bestEdgeDelta ? `(${bestEdgeDelta[0].toFixed(3)},${bestEdgeDelta[1].toFixed(3)})` : "null"}`,
                        );
                        if (bestEdgeDelta) {
                            const [tdx, tdy] = bestEdgeDelta;
                            const linkedBySpaceV = new Map<string, typeof linkedPolysV>();
                            for (const lp of linkedPolysV) {
                                let arr = linkedBySpaceV.get(lp.spaceId);
                                if (!arr) { arr = []; linkedBySpaceV.set(lp.spaceId, arr); }
                                arr.push(lp);
                            }
                            for (const [spaceId, lps] of linkedBySpaceV) {
                                const lpsWithEntity = lps.filter((lp) => lp.origEntities.length > 0);
                                const lpsLegacy = lps.filter((lp) => lp.origEntities.length === 0);
                                if (lpsWithEntity.length > 0) {
                                    setSpaceEntities(spaceId as ElementId, (entities) =>
                                        entities.map((e) => {
                                            for (const lp of lpsWithEntity) {
                                                const orig = lp.origEntities.find((o) => o.entityId === e.id);
                                                if (orig) return translateEntity(orig.snapshot, tdx, tdy);
                                            }
                                            return e;
                                        }),
                                    );
                                }
                                if (lpsLegacy.length > 0) {
                                    const sp = useAppState.getState().elements[spaceId] as SpaceElement | undefined;
                                    if (sp) {
                                        const newPolys = sp.polygons.map((p) => {
                                            const lp = lpsLegacy.find((x) => x.polyId === p.id);
                                            if (!lp) return p;
                                            return {
                                                ...p,
                                                outer: lp.origOuter.map((pt) => [pt[0] + tdx, pt[1] + tdy] as Vec2),
                                                holes: lp.origHoles.map((h) => h.map((pt) => [pt[0] + tdx, pt[1] + tdy] as Vec2)),
                                            };
                                        });
                                        updateElement(spaceId as ElementId, {
                                            polygons: newPolys,
                                            dirtyFlags: new Set([...(sp.dirtyFlags ?? []), "Geometry", "Mesh", "Render"]),
                                        } as any);
                                    }
                                }
                            }
                        }
                    }
                }
                return;
            } else if (dragState.kind === "poly") {
                const dpoly = dragState;
                if (!dpoly.moved && ROOM_SHAPE_DEBUG) {
                    // eslint-disable-next-line no-console
                    console.log(
                        `[room-debug] drag move kind=poly room=${dpoly.spaceId.slice(0, 6)} `
                        + `poly=${dpoly.polyId.slice(0, 6)} `
                        + `start=(${dpoly.startWorld[0].toFixed(3)},${dpoly.startWorld[1].toFixed(3)}) `
                        + `cursor=(${wp[0].toFixed(3)},${wp[1].toFixed(3)})`,
                    );
                }
                // 拘束優先ロック (Coincident のみ): 別 polygon と頂点が一致して
                // いる場合、全体移動は相手 polygon の一辺を引っ張って形状を歪める
                // ので抑制。Coincident 解放には先に拘束を削除する必要がある。
                // ※ Collinear / Parallel / Perpendicular / Length などの「向き・
                // 距離の拘束」は、自 polygon と **連結 polygon** を **同じ delta で
                // 一緒に平行移動** すれば拘束が保たれるので、ブロックせず後段で
                // linkedPolys として一緒に動かす。
                for (const cid in constraints) {
                    const c = constraints[cid];
                    if (c.type !== "Coincident" || c.targets.length < 2) continue;
                    const t1 = c.targets[0], t2 = c.targets[1];
                    if (t1.kind !== "SketchPoint" || t2.kind !== "SketchPoint") continue;
                    if ((t1.polyId === dpoly.polyId && t2.polyId !== dpoly.polyId)
                        || (t2.polyId === dpoly.polyId && t1.polyId !== dpoly.polyId)) {
                        setGridSnapInfo(null);
                        return;
                    }
                }
                let dx = wp[0] - dpoly.startWorld[0], dz = wp[1] - dpoly.startWorld[1];
                // BVH snap: for each translated vertex, query origin + grid
                // intersection snap targets. Adopt the closest hit across all
                // vertices and shift the delta so that vertex lands exactly
                // on the snap point.
                const bvh = snapBVHRef.current;
                const useResStep = designModeRef.current === "jpResidentialGrid";
                const resStep = RESIDENTIAL_GRID_SECONDARY_M;
                const snapTol = DEFAULT_GRID_SNAP_TOLERANCE;
                // 全体移動の頂点スナップ。各 origOuter 頂点 + delta 位置について
                // (a) grid 交点 / 原点 (b) 他形状の頂点 (c) 他形状の辺 投影 (d) 住居系
                // grid step を試し、最も近い吸着先を採用する。snap 種別 (kind) も
                // 保持して、polyVertex / polyEdge ドラッグと同じシンボルを表示する。
                let bestCorr: {
                    dx: number; dz: number;
                    target: [number, number];
                    dist: number;
                    kind: SnapKind;
                } | null = null;
                for (const pt of dpoly.origOuter) {
                    const tx = pt[0] + dx, tz = pt[1] + dz;
                    // (a) Grid intersections / origin
                    const hit = bvh.nearestWithin(tx, tz, snapTol);
                    if (hit) {
                        const d = Math.hypot(tx - hit.x, tz - hit.z);
                        if (!bestCorr || d < bestCorr.dist) {
                            bestCorr = { dx: hit.x - pt[0], dz: hit.z - pt[1], target: [hit.x, hit.z], dist: d, kind: "obj" };
                        }
                    }
                    // (b) Other room polygon vertices
                    for (const elId in elementsRef.current) {
                        const el = elementsRef.current[elId];
                        if (!el || el.type !== "Space") continue;
                        for (const p of (el as SpaceElement).polygons ?? []) {
                            if (p.id === dpoly.polyId) continue;
                            if (p.wallOutlineOf) continue;
                            for (const vp of p.outer) {
                                const d = Math.hypot(tx - vp[0], tz - vp[1]);
                                if (d <= snapTol && (!bestCorr || d < bestCorr.dist)) {
                                    bestCorr = { dx: vp[0] - pt[0], dz: vp[1] - pt[1], target: [vp[0], vp[1]], dist: d, kind: "vertex" };
                                }
                            }
                        }
                    }
                    // (c) Other room polygon edges (perpendicular projection)。
                    // 頂点が他形状の辺の上に乗ったらその辺へ吸着する。
                    for (const elId in elementsRef.current) {
                        const el = elementsRef.current[elId];
                        if (!el || el.type !== "Space") continue;
                        for (const p of (el as SpaceElement).polygons ?? []) {
                            if (p.id === dpoly.polyId) continue;
                            if (p.wallOutlineOf) continue;
                            const edges = polygonEdges(p);
                            for (const [ai, bi] of edges) {
                                const a = p.outer[ai];
                                const b = p.outer[bi];
                                const edx = b[0] - a[0], edy = b[1] - a[1];
                                const lenSq = edx * edx + edy * edy;
                                if (lenSq < 1e-12) continue;
                                let t = ((tx - a[0]) * edx + (tz - a[1]) * edy) / lenSq;
                                t = Math.max(0, Math.min(1, t));
                                const px = a[0] + edx * t;
                                const py = a[1] + edy * t;
                                const d = Math.hypot(tx - px, tz - py);
                                if (d <= snapTol && (!bestCorr || d < bestCorr.dist)) {
                                    bestCorr = { dx: px - pt[0], dz: py - pt[1], target: [px, py], dist: d, kind: "edge" };
                                }
                            }
                        }
                    }
                    // (d) Residential grid step
                    if (useResStep) {
                        const sx = Math.round(tx / resStep) * resStep;
                        const sz = Math.round(tz / resStep) * resStep;
                        const d = Math.hypot(tx - sx, tz - sz);
                        if (d <= snapTol && (!bestCorr || d < bestCorr.dist)) {
                            bestCorr = { dx: sx - pt[0], dz: sz - pt[1], target: [sx, sz], dist: d, kind: "obj" };
                        }
                    }
                }
                if (bestCorr) {
                    dx = bestCorr.dx;
                    dz = bestCorr.dz;
                    setGridSnapInfo({ point: bestCorr.target, kind: bestCorr.kind });
                } else {
                    setGridSnapInfo(null);
                }
                // Pre-index concentric partners (snapshot captured at drag
                // start). We translate from the original snapshot by the total
                // delta each frame — never incrementally — to avoid drift.
                const partnerById = new Map(dpoly.origConcentric.map((p) => [p.polyId, p]));
                // Index Coincident constraints that link the dragged polygon
                // to a DIFFERENT polygon. These need to propagate live so the
                // partner polygon's vertex follows the dragged corner (and its
                // internal H/V/Parallel constraints reshape it accordingly).
                interface CoincidentLink {
                    dragVertexIdx: number;   // vertex index on the dragged polygon
                    otherPolyId: string;     // partner polygon id
                    otherVertexIdx: number;  // vertex index on partner
                }
                const coincidentLinks: CoincidentLink[] = [];
                for (const cid in constraints) {
                    const c = constraints[cid];
                    if (c.type !== "Coincident" || c.targets.length < 2) continue;
                    const t1 = c.targets[0], t2 = c.targets[1];
                    if (t1.kind !== "SketchPoint" || t2.kind !== "SketchPoint") continue;
                    if (t1.polyId === dpoly.polyId && t2.polyId !== dpoly.polyId) {
                        coincidentLinks.push({
                            dragVertexIdx: t1.vertexIdx,
                            otherPolyId: t2.polyId,
                            otherVertexIdx: t2.vertexIdx,
                        });
                    } else if (t2.polyId === dpoly.polyId && t1.polyId !== dpoly.polyId) {
                        coincidentLinks.push({
                            dragVertexIdx: t2.vertexIdx,
                            otherPolyId: t1.polyId,
                            otherVertexIdx: t1.vertexIdx,
                        });
                    }
                }
                // ── Entity-driven path: 真実の単一情報源 (= entity) を直接
                //    動かす。setSpaceEntities が re-derive を走らせるので polygon
                //    outer は entity から自動派生される。「polygon を先に動かして
                //    entity を逆引き同期」していた旧 updatePolysAndSync 経路は、
                //    arc / circle のパラメトリック表現と相性が悪く、line+arc
                //    チェインが drag 中に切れる原因だった。
                //
                //    entity を持たない polygon (= origEntities が空; legacy /
                //    outline polygon 等) はフォールバックで従来の polygon 直接
                //    更新に落とす。
                const dragSpaceId = dpoly.spaceId as ElementId;
                const useEntityPath = dpoly.origEntities.length > 0;
                // **設計原則 (= ユーザ指示)**: entity は真値、polygon は entity からの
                // 一方通行 derive。drag handler は entity の points を直接動かすのみ。
                // polygon は setSpaceEntities → derivePolygonsFromEntities で自動更新。
                // 以前は polygon を直接書き戻していたが、それは entity と polygon の
                // 不整合を生み、再 derive で polygon が縮む等の現象を起こしていた。
                // ここでは polygon 直書きをやめ、entity だけ更新する。
                if (useEntityPath) {
                    // pins は **dragSpace の entity を更新後の状態** で立てる。
                    // 更新後の polygon は entity-derived なので、entity 各点の
                    // (orig + delta) 位置が polygon の vertex 位置と一致する。
                    // pins の vertexIdx は entity-derived polygon の頂点インデックスを
                    // そのまま使う (= 通常 0..entityPoints.length-1)。
                    const pins: import("../../application/AppState").SolverDragPin[] = [];
                    // entity を translate して setSpaceEntities で書く。
                    setSpaceEntities(dragSpaceId, (entities) =>
                        entities.map((e) => {
                            const orig = dpoly.origEntities.find((o) => o.entityId === e.id);
                            if (!orig) return e;
                            return translateEntity(orig.snapshot, dx, dz);
                        }),
                    );
                    // cross-poly 拘束で連結された別 polygon も同じ delta で translate。
                    // Space ごとにまとめて setSpaceEntities を呼ぶ。
                    const linkedBySpace = new Map<string, typeof dpoly.linkedPolys>();
                    for (const lp of dpoly.linkedPolys ?? []) {
                        let arr = linkedBySpace.get(lp.spaceId);
                        if (!arr) { arr = []; linkedBySpace.set(lp.spaceId, arr); }
                        arr.push(lp);
                    }
                    // eslint-disable-next-line no-console
                    console.log(
                        `[poly-drag] linkedPolys=${dpoly.linkedPolys?.length ?? 0} `
                        + `spaces=${linkedBySpace.size} dx=${dx.toFixed(3)} dz=${dz.toFixed(3)} `
                        + `details=${(dpoly.linkedPolys ?? []).map((l) => `${l.polyId.slice(0,6)}(ents=${l.origEntities.length})`).join(",")}`,
                    );
                    for (const [spaceId, lps] of linkedBySpace) {
                        // entity を持つ linked polygon は entity を translate (= polygon
                        // は entity から再 derive されて自動追従)。entity 不在 (= legacy
                        // polygon) の場合は polygon.outer / holes を直接 translate して
                        // 同じ画面同期を実現する。
                        const lpsWithEntity = lps.filter((lp) => lp.origEntities.length > 0);
                        const lpsLegacy = lps.filter((lp) => lp.origEntities.length === 0);
                        if (lpsWithEntity.length > 0) {
                            setSpaceEntities(spaceId as ElementId, (entities) =>
                                entities.map((e) => {
                                    for (const lp of lpsWithEntity) {
                                        const orig = lp.origEntities.find((o) => o.entityId === e.id);
                                        if (orig) return translateEntity(orig.snapshot, dx, dz);
                                    }
                                    return e;
                                }),
                            );
                        }
                        if (lpsLegacy.length > 0) {
                            const sp = useAppState.getState().elements[spaceId] as SpaceElement | undefined;
                            if (sp) {
                                const newPolys = sp.polygons.map((p) => {
                                    const lp = lpsLegacy.find((x) => x.polyId === p.id);
                                    if (!lp) return p;
                                    return {
                                        ...p,
                                        outer: lp.origOuter.map((pt) => [pt[0] + dx, pt[1] + dz] as Vec2),
                                        holes: lp.origHoles.map((h) => h.map((pt) => [pt[0] + dx, pt[1] + dz] as Vec2)),
                                    };
                                });
                                updateElement(spaceId as ElementId, {
                                    polygons: newPolys,
                                    dirtyFlags: new Set([...(sp.dirtyFlags ?? []), "Geometry", "Mesh", "Render"]),
                                } as any);
                            }
                        }
                    }
                    // 連結 polygon の頂点も pin に積む (= solver が再度動かさない
                    // ように固定)。
                    for (const lp of dpoly.linkedPolys ?? []) {
                        const liveSp = useAppState.getState().elements[lp.spaceId] as SpaceElement | undefined;
                        const lvPoly = liveSp?.polygons?.find((p) => p.id === lp.polyId);
                        if (!lvPoly) continue;
                        for (let i = 0; i < lvPoly.outer.length; i++) {
                            const pt = lvPoly.outer[i];
                            pins.push({
                                spaceId: lp.spaceId as ElementId,
                                polyId: lp.polyId,
                                vertexIdx: i,
                                x: pt[0],
                                y: pt[1],
                            });
                        }
                    }
                    // entity 更新後の polygon を読み、各頂点を pin。
                    const liveSpaceAfter = useAppState.getState().elements[dragSpaceId] as SpaceElement | undefined;
                    const livePoly = liveSpaceAfter?.polygons?.find((p) => p.id === dpoly.polyId);
                    if (livePoly) {
                        for (let i = 0; i < livePoly.outer.length; i++) {
                            const pt = livePoly.outer[i];
                            pins.push({
                                spaceId: dragSpaceId,
                                polyId: dpoly.polyId,
                                vertexIdx: i,
                                x: pt[0],
                                y: pt[1],
                            });
                        }
                    }
                    setSolverDragHint(pins);
                    // 同心円 partner / outline / coincident-link 先の polygon は
                    // **別 polygon** で entity 経路で動かない。これらは個別に直書き
                    // で追従させる (= 既存挙動を維持)。entity 駆動への置換は別途。
                    const partnerUpdates: RoomPolygon[] = [];
                    for (const partner of dpoly.origConcentric) {
                        const p = room.polygons.find((q) => q.id === partner.polyId);
                        if (!p) continue;
                        partnerUpdates.push({
                            ...p,
                            outer: partner.outer.map((pt) => [pt[0] + dx, pt[1] + dz] as Vec2),
                            holes: partner.holes.map((h) => h.map((pt) => [pt[0] + dx, pt[1] + dz] as Vec2)),
                            shape: {
                                type: "circle" as const,
                                center: [partner.shapeCenter[0] + dx, partner.shapeCenter[1] + dz] as Vec2,
                                radius: partner.shapeRadius,
                            },
                        });
                    }
                    for (const outlineSnap of dpoly.origOutlines) {
                        const p = room.polygons.find((q) => q.id === outlineSnap.polyId);
                        if (!p) continue;
                        partnerUpdates.push({
                            ...p,
                            outer: outlineSnap.outer.map((pt) => [pt[0] + dx, pt[1] + dz] as Vec2),
                            holes: outlineSnap.holes.map((h) => h.map((pt) => [pt[0] + dx, pt[1] + dz] as Vec2)),
                        });
                    }
                    // Cross-poly Coincident link 先も同じく直書き。
                    if (coincidentLinks.length > 0) {
                        const liveAfter = useAppState.getState().elements[dragSpaceId] as SpaceElement | undefined;
                        const draggedOuter = liveAfter?.polygons?.find((p) => p.id === dpoly.polyId)?.outer;
                        if (draggedOuter) {
                            const linkedPolyIds = new Set(coincidentLinks.map((l) => l.otherPolyId));
                            for (const pid of linkedPolyIds) {
                                const p = room.polygons.find((q) => q.id === pid);
                                if (!p) continue;
                                const newOuter: Vec2[] = p.outer.map((pt) => [pt[0], pt[1]] as Vec2);
                                const linksHere = coincidentLinks.filter((l) => l.otherPolyId === pid);
                                for (const link of linksHere) {
                                    const srcPt = draggedOuter[link.dragVertexIdx];
                                    if (!srcPt) continue;
                                    if (link.otherVertexIdx < 0 || link.otherVertexIdx >= newOuter.length) continue;
                                    newOuter[link.otherVertexIdx] = [srcPt[0], srcPt[1]];
                                }
                                for (const link of linksHere) {
                                    propagateSimpleConstraints(newOuter, p.id, link.otherVertexIdx, constraints);
                                }
                                partnerUpdates.push({ ...p, outer: newOuter });
                            }
                        }
                    }
                    if (partnerUpdates.length > 0) {
                        const idSet = new Set(partnerUpdates.map((p) => p.id));
                        const liveSpacePost = useAppState.getState().elements[dragSpaceId] as SpaceElement | undefined;
                        const basePolys = liveSpacePost?.polygons ?? [];
                        const merged = basePolys.map((p) =>
                            idSet.has(p.id) ? partnerUpdates.find((q) => q.id === p.id)! : p,
                        );
                        updateElement(dragSpaceId, {
                            polygons: merged,
                            dirtyFlags: new Set([...(room.dirtyFlags ?? []), "Geometry", "Mesh", "Render"]),
                        } as any);
                    }
                } else {
                    // ── Legacy フォールバック (entity 無しの polygon) ─────────
                    // 旧データなど entity 不在の polygon を direct write で動かす。
                    const pins: import("../../application/AppState").SolverDragPin[] =
                        dpoly.origOuter.map((pt, i) => ({
                            spaceId: dragSpaceId,
                            polyId: dpoly.polyId,
                            vertexIdx: i,
                            x: pt[0] + dx,
                            y: pt[1] + dz,
                        }));
                    setSolverDragHint(pins);
                    const newPolys = room.polygons.map(p => {
                        if (p.id === dpoly.polyId) {
                            const next: RoomPolygon = {
                                ...p,
                                outer: dpoly.origOuter.map(pt => [pt[0] + dx, pt[1] + dz] as Vec2),
                                holes: dpoly.origHoles.map(h => h.map(pt => [pt[0] + dx, pt[1] + dz] as Vec2)),
                            };
                            if (p.shape?.type === "circle" && dpoly.origShapeCenter && dpoly.origShapeRadius !== undefined) {
                                next.shape = {
                                    type: "circle",
                                    center: [dpoly.origShapeCenter[0] + dx, dpoly.origShapeCenter[1] + dz],
                                    radius: dpoly.origShapeRadius,
                                };
                            }
                            return next;
                        }
                        return p;
                    });
                    updatePolysAndSync(newPolys);
                }
                // drag 中は wall slab を描画していないので、毎フレームの
                // wall axis 更新は完全に skip する (state 更新コスト削減)。
                // mouseup の `maybeRealtimeRegenWalls` → wallRegenerate が wall を
                // 新位置に正しく再生成するので最終結果は変わらない。
            } else if (dragState.kind === "polyEdge") {
                const d = dragState; // polyEdge
                // エッジドラッグでも他の部屋の頂点・辺・通芯交点・軸整列に
                // スナップする。自 polygon は自分の辺と被るので除外。
                const s = applyWallPathSnap(wp, { excludePolyId: d.polyId });
                setGridSnapInfo(s.info);
                const sp = s.p;
                const dx = sp[0] - d.startWorld[0], dz = sp[1] - d.startWorld[1];
                const perp = dx * d.normal[0] + dz * d.normal[1];
                const dragPoly = room.polygons.find((p) => p.id === d.polyId);
                if (!dragPoly) return;
                const edgeList = polygonEdges(dragPoly);
                const edgePair = edgeList[d.edgeIdx];
                if (!edgePair) return;
                const [i, j] = edgePair;
                // Target absolute positions for the dragged edge's endpoints,
                // derived from the drag-start snapshot + perp delta.
                const targetI: Vec2 = [
                    d.origOuter[i][0] + d.normal[0] * perp,
                    d.origOuter[i][1] + d.normal[1] * perp,
                ];
                const targetJ: Vec2 = [
                    d.origOuter[j][0] + d.normal[0] * perp,
                    d.origOuter[j][1] + d.normal[1] * perp,
                ];
                // FreeCAD `MoveParameters` 風の **2 ピン** を solver に渡す:
                // ドラッグ辺の両端点をそれぞれ perp 移動先に固定。残りの
                // 頂点は solver が H/V/Distance を満たすよう reflow する。
                // updatePolysAndSync 側で propagateSimpleConstraints も走る
                // ので、軽量な拘束 (= H/V/Coincident) は同フレームで解決し、
                // それ以外 (= 距離拘束など) を solver が後追いで解く。
                const edgePins: import("../../application/AppState").SolverDragPin[] = [];
                if (activeRoomId) {
                    edgePins.push(
                        { spaceId: activeRoomId, polyId: d.polyId, vertexIdx: i,
                          x: targetI[0], y: targetI[1] },
                        { spaceId: activeRoomId, polyId: d.polyId, vertexIdx: j,
                          x: targetJ[0], y: targetJ[1] },
                    );
                }
                // cross-poly 拘束 (Collinear / Parallel / Perpendicular / Length) で
                // 連結された別 polygon を同じ (normal * perp) で rigid 平行移動。
                // これでドラッグ中も collinear 関係を維持し、相手矩形の底辺が
                // 同期して動く (= FreeCAD と同じ振る舞い)。
                const linkPolysE = d.linkedPolys ?? [];
                if (linkPolysE.length > 0) {
                    const tdx = d.normal[0] * perp;
                    const tdy = d.normal[1] * perp;
                    const linkedBySpaceE = new Map<string, typeof linkPolysE>();
                    for (const lp of linkPolysE) {
                        let arr = linkedBySpaceE.get(lp.spaceId);
                        if (!arr) { arr = []; linkedBySpaceE.set(lp.spaceId, arr); }
                        arr.push(lp);
                    }
                    for (const [spaceId, lps] of linkedBySpaceE) {
                        const lpsWithEntity = lps.filter((lp) => lp.origEntities.length > 0);
                        const lpsLegacy = lps.filter((lp) => lp.origEntities.length === 0);
                        if (lpsWithEntity.length > 0) {
                            setSpaceEntities(spaceId as ElementId, (entities) =>
                                entities.map((e) => {
                                    for (const lp of lpsWithEntity) {
                                        const orig = lp.origEntities.find((o) => o.entityId === e.id);
                                        if (orig) return translateEntity(orig.snapshot, tdx, tdy);
                                    }
                                    return e;
                                }),
                            );
                        }
                        if (lpsLegacy.length > 0) {
                            const sp = useAppState.getState().elements[spaceId] as SpaceElement | undefined;
                            if (sp) {
                                const newPolys = sp.polygons.map((p) => {
                                    const lp = lpsLegacy.find((x) => x.polyId === p.id);
                                    if (!lp) return p;
                                    return {
                                        ...p,
                                        outer: lp.origOuter.map((pt) => [pt[0] + tdx, pt[1] + tdy] as Vec2),
                                        holes: lp.origHoles.map((h) => h.map((pt) => [pt[0] + tdx, pt[1] + tdy] as Vec2)),
                                    };
                                });
                                updateElement(spaceId as ElementId, {
                                    polygons: newPolys,
                                    dirtyFlags: new Set([...(sp.dirtyFlags ?? []), "Geometry", "Mesh", "Render"]),
                                } as any);
                            }
                        }
                        // 連結 polygon の頂点も pin に積む。
                        for (const lp of lps) {
                            const liveSp = useAppState.getState().elements[lp.spaceId] as SpaceElement | undefined;
                            const lvPoly = liveSp?.polygons?.find((p) => p.id === lp.polyId);
                            if (!lvPoly) continue;
                            for (let k = 0; k < lvPoly.outer.length; k++) {
                                const pt = lvPoly.outer[k];
                                edgePins.push({
                                    spaceId: lp.spaceId as ElementId,
                                    polyId: lp.polyId,
                                    vertexIdx: k,
                                    x: pt[0],
                                    y: pt[1],
                                });
                            }
                        }
                    }
                }
                if (edgePins.length > 0) {
                    setSolverDragHint(edgePins);
                }
                // Outer-edge drag: reverse-map through negative mitering to
                // the inner, same pattern as the outer-vertex case.
                const innerId = dragPoly.wallOutlineOf;
                const innerPoly = innerId
                    ? room.polygons.find((p) => p.id === innerId)
                    : undefined;
                if (innerPoly && innerPoly.wallThickness != null
                    && innerPoly.outer.length === dragPoly.outer.length
                    && dragPoly.outer.length >= 3
                ) {
                    const newOutline: Vec2[] = dragPoly.outer.map((pt, idx) => {
                        if (idx === i) return targetI;
                        if (idx === j) return targetJ;
                        return [pt[0], pt[1]] as Vec2;
                    });
                    let cx = 0, cy = 0;
                    for (const v of newOutline) { cx += v[0]; cy += v[1]; }
                    cx /= newOutline.length; cy /= newOutline.length;
                    const newInnerOuter = computeMiteredCorners(
                        newOutline, [cx, cy], -innerPoly.wallThickness,
                    );
                    // entity-driven outline edge drag (= inner の entity を更新)。
                    const polyIdByEntityOE = room.polyIdByEntity ?? {};
                    let innerEntityIdE: string | null = null;
                    for (const eid in polyIdByEntityOE) {
                        if (polyIdByEntityOE[eid] === innerPoly.id) { innerEntityIdE = eid; break; }
                    }
                    const innerEntE = innerEntityIdE
                        ? (room.entities ?? []).find((e) => e.id === innerEntityIdE)
                        : undefined;
                    if (innerEntE && innerEntE.kind === "polyline"
                        && innerEntE.points.length === newInnerOuter.length && activeRoomId) {
                        setSpaceEntities(activeRoomId, (entities) =>
                            entities.map((e) => {
                                if (e.id !== innerEntityIdE) return e;
                                if (e.kind !== "polyline") return e;
                                return {
                                    ...e,
                                    points: newInnerOuter.map((p) => [p[0], p[1]] as Vec2),
                                };
                            }),
                        );
                        return;
                    }
                    // フォールバック: entity 不在 / 頂点数不一致なら polygon 直書き。
                    const newPolys = room.polygons.map(p => {
                        if (p.id !== innerPoly.id) return p;
                        return { ...p, outer: newInnerOuter };
                    });
                    updatePolysAndSync(newPolys);
                    return;
                }

                // ── line+arc D 形状の entity-translate パス ────────────────
                // 直線辺の perp ドラッグでは線と弧を **同じ delta で平行移動** すれば
                // chain 接続が保たれる (= setSpaceEntities 側で polygon が再派生
                // される)。updatePolysAndSync の delta 検知（case A）は polygon outer
                // と entity の整合に依存するため、そこに依存せず entity を直接
                // 翻訳する経路を選ぶ。これで「直線が消える」現象を確実に回避。
                if (d.origEntitiesForTranslate && activeRoomId) {
                    // D 形状の直線辺ドラッグは **自由 2D 平行移動** 扱い (= 全体が
                    // カーソルに追従)。perp 制限は矩形などの単一辺ドラッグ用なので
                    // 「線+弧」が一体の図形では perp 制限を外して直感的な操作にする。
                    const tdx = sp[0] - d.startWorld[0];
                    const tdy = sp[1] - d.startWorld[1];
                    setSpaceEntities(activeRoomId, (entities) =>
                        entities.map((e) => {
                            const orig = d.origEntitiesForTranslate!.find((o) => o.entityId === e.id);
                            if (!orig) return e;
                            return translateEntity(orig.snapshot, tdx, tdy);
                        }),
                    );
                    return;
                }
                // ── polyEdge entity-driven path ─────────────────────────────
                // 辺の両端点を perp 方向に動かす。entity 駆動なので、対応する
                // entity polyline の points を直接更新し polygon は derive で更新。
                // entityId / entityPointIdxA/B は drag 開始時点で確定済 (dragState 内)。
                const edgeEntityId = d.entityId;
                const epIdxI = d.entityPointIdxA ?? -1;
                const epIdxJ = d.entityPointIdxB ?? -1;
                const edgeEnt = edgeEntityId
                    ? (room.entities ?? []).find((e) => e.id === edgeEntityId)
                    : undefined;
                if (!edgeEnt || edgeEnt.kind !== "polyline" || epIdxI < 0 || epIdxJ < 0) {
                    // legacy フォールバック (entity 不在 or split 端点)
                    const currentPolyL = room.polygons.find((p) => p.id === d.polyId);
                    const baseOuterL = currentPolyL?.outer ?? d.origOuter;
                    const newOuterL: Vec2[] = baseOuterL.map((pt, idx) => {
                        if (idx === i) return targetI;
                        if (idx === j) return targetJ;
                        return [pt[0], pt[1]] as Vec2;
                    });
                    const newPolysL = room.polygons.map(p => {
                        if (p.id !== d.polyId) return p;
                        return { ...p, outer: newOuterL, holes: currentPolyL?.holes ?? d.origHoles };
                    });
                    updatePolysAndSync(newPolysL);
                    return;
                }
                const newPointsEdge: Vec2[] = edgeEnt.points.map((p, k) => {
                    if (k === epIdxI) return [targetI[0], targetI[1]] as Vec2;
                    if (k === epIdxJ) return [targetJ[0], targetJ[1]] as Vec2;
                    return [p[0], p[1]] as Vec2;
                });
                setSpaceEntities(activeRoomId, (entities) =>
                    entities.map((e) => {
                        if (e.id !== edgeEntityId) return e;
                        if (e.kind !== "polyline") return e;
                        return { ...e, points: newPointsEdge };
                    }),
                );
            }
            return;
        }
        // wallSkip mode の stage 1 (= edge 未ピック) でも hoveredEdge を更新して、
        // ピック対象候補を 2D オーバーレイで強調できるようにする。
        const wallSkipPicking = roomEditMode === "wallSkip" && !wallSkipDraft;
        if ((roomEditMode === "select" || activeTool === "wall" || wallSkipPicking) && wp) {
            if (gridSnapInfo) setGridSnapInfo(null);
            const r = getCanvasRect();
            const sx = e.clientX - (r?.left ?? 0), sy = e.clientY - (r?.top ?? 0);
            // cross-space ヒット: アクティブ Room 以外の頂点・辺でもホバー反応。
            // pointerdown と同じ走査を使うことで「ホバー → クリック」の対象を
            // 一致させる (= ホバーで光った辺を確実に掴める)。
            const pvtxX = hitTestPolyVertexAcrossSpaces(sx, sy);
            const pvtx: HoveredPolyVertex | null = pvtxX
                ? { polyId: pvtxX.polyId, vertexIdx: pvtxX.vertexIdx, wx: pvtxX.wx, wz: pvtxX.wz }
                : null;
            setHoveredPolyVertex(pvtx);
            const edgeX = pvtx ? null : hitTestEdgeAcrossSpaces(sx, sy);
            const edge: HoveredEdge | null = edgeX
                ? { polyId: edgeX.polyId, edgeIdx: edgeX.edgeIdx, midWx: edgeX.midWx, midWz: edgeX.midWz }
                : null;
            setHoveredEdge(edge);
            // 通芯ホバー — vertex / edge より低優先 (= polygon を優先) でカーソル
            // フィードバック (pointer) を出すために拾う。
            const gh = (pvtx || edge) ? null : hitTestGrid(sx, sy);
            setHoveredGrid(gh);
            // Suppress polygon-interior hover in wall mode — the interior
            // is a pass-through target for wall drawing, not a drag handle.
            // 別 Room (重なりで上に乗っている) もホバー検出対象に含めるため
            // `hitTestPolyAcrossSpaces` を使う。これにより、別 Room の polygon を
            // 指してもハイライトが正しく追従する (= クリックで切替できる対象が
            // 視覚的にわかる)。
            const polyHover = (pvtx || edge || gh || activeTool === "wall")
                ? null
                : hitTestPolyAcrossSpaces(wp[0], wp[1]);
            setHoveredPolyId(polyHover?.polyId ?? null);
            setHoveredPolySpaceId(polyHover?.spaceId ?? null);
        }
    };

	    const handlePointerUp = (e?: React.PointerEvent) => {
	        // Wall-mode pass-through: forward the up event so Viewport can
	        // commit a wall (CreateWallCommand runs on the 2nd click there).
	        if (activeTool === "wall" && activeRoomId && wallPassthroughRef.current) {
	            if (e) dispatchToViewport(e, "pointerup");
	            wallPassthroughRef.current = false;
	            (window as any).__viewportInteracting = false;
	            return;
	        }
	        if (suppressSelectDragUntilPointerUpRef.current) {
	            suppressSelectDragUntilPointerUpRef.current = false;
	            dragStateRef.current = null;
	            setDragState(null);
	            useAppState.setState({ solverDragHint: [] });
	            setGridSnapInfo(null);
	            if (e) {
	                try {
	                    e.currentTarget.releasePointerCapture(e.pointerId);
	                } catch {
	                    // ignore browsers/cases where capture was not held
	                }
	            }
	            (window as any).__viewportInteracting = false;
	            if (ROOM_SHAPE_DEBUG) {
	                // eslint-disable-next-line no-console
	                console.log("[room-debug] pointerup suppressed after rectangle commit");
	            }
	            return;
	        }

	        // Clear any drag hint so subsequent solves don't keep pinning the vertex
	        setSolverDragHint(null);
        if (dragState?.moved) {
            setSelection([]);
            const polyDragKinds = [
                "poly", "polyVertex", "polyEdge", "entityArc",
                "entityArcEndpoint", "entityCircleCenter", "entityCircleRadius",
            ] as const;
            if ((polyDragKinds as readonly string[]).includes(dragState.kind)) {
                const ds = dragState as Extract<DragState, { polyId: string }>;
                setLastDraggedPolyId(ds.polyId);
                // 矩形 A と矩形 B が今のドラッグで接続されたケースを既存ロジック
                // (regenerateAllWalls = 全壁生成) で吸収する。共線重なりが発生
                // していなければ何もリビルドしないので、ただの単独移動でも安全。
                // seed = ドラッグした polygon。全体移動 (poly drag) で連結 polygon
                // も同じ delta で動かした場合、それらの壁も新位置で再生成する
                // 必要があるので linkedPolys も seed に含める。
                const seeds: string[] = [ds.polyId];
                if (dragState.kind === "poly") {
                    const dpolyState = dragState as DragPolyState;
                    for (const lp of dpolyState.linkedPolys ?? []) {
                        if (!seeds.includes(lp.polyId)) seeds.push(lp.polyId);
                    }
                } else if (dragState.kind === "polyEdge") {
                    const dedgeState = dragState as DragPolyEdgeState;
                    for (const lp of dedgeState.linkedPolys ?? []) {
                        if (!seeds.includes(lp.polyId)) seeds.push(lp.polyId);
                    }
                } else if (dragState.kind === "polyVertex") {
                    const dvtxState = dragState as DragPolyVertexState;
                    for (const lp of dvtxState.linkedPolys ?? []) {
                        if (!seeds.includes(lp.polyId)) seeds.push(lp.polyId);
                    }
                }
                maybeRealtimeRegenWalls(
                    `drag ${dragState.kind} → mouseup`,
                    seeds,
                );
            }
        } else if (dragState && (activeRoomId || activeRoomIdRef.current)) {
            // Click without drag → toggle sketch selection (vertex / edge)
            const additive = !!(e && (e.shiftKey || e.ctrlKey || e.metaKey));
            // pointerdown でアクティブ Room を切り替えた直後 (= cross-space で
            // 非アクティブ Room のエッジを掴んだ) は React closure の activeRoomId
            // がまだ古い値のまま。`activeRoomIdRef` は同期的に更新済みなので
            // そちら経由で「実際にアクティブな Room の id」を取る。これがないと
            // toggleSketchSelection の spaceId が古い Room を指して、選択が無効
            // (= ConstraintPanel に出ない・拘束対象として認識されない) になる。
            const effectiveRoomId = activeRoomIdRef.current ?? activeRoomId;
            if (effectiveRoomId) {
                const liveElements = useAppState.getState().elements;
                const liveRoom = liveElements[effectiveRoomId] as SpaceElement | undefined;
                const redirectToPrimary = (polyId: string): string => {
                    const p = liveRoom?.polygons?.find((q) => q.id === polyId);
                    if (p?.wallOutlineOf) return p.wallOutlineOf;
                    return polyId;
                };
                if (dragState.kind === "polyVertex") {
                    toggleSketchSelection({
                        kind: "point",
                        spaceId: effectiveRoomId,
                        polyId: redirectToPrimary(dragState.polyId),
                        vertexIdx: dragState.vertexIdx,
                    }, additive);
                } else if (dragState.kind === "polyEdge") {
                    const pp = liveRoom?.polygons?.find((p) => p.id === dragState.polyId);
                    const ownerId = pp?.edgeOwners?.[dragState.edgeIdx];
                    const ownerEnt = ownerId
                        ? (liveRoom?.entities ?? []).find((en) => en.id === ownerId)
                        : undefined;
                    if (ownerEnt && ownerEnt.kind === "arc") {
                        toggleSketchSelection({
                            kind: "entity",
                            spaceId: effectiveRoomId,
                            entityId: ownerEnt.id,
                        }, additive);
                    } else {
                        toggleSketchSelection({
                            kind: "edge",
                            spaceId: effectiveRoomId,
                            polyId: redirectToPrimary(dragState.polyId),
                            edgeIdx: dragState.edgeIdx,
                        }, additive);
                    }
                } else if (dragState.kind === "entityArc") {
                    // entityArc ドラッグ開始したが移動せずに離した = 弧全体を選択トグル。
                    toggleSketchSelection({
                        kind: "entity",
                        spaceId: effectiveRoomId,
                        entityId: dragState.entityId,
                    }, additive);
                } else if (dragState.kind === "poly") {
                    const pp = liveRoom?.polygons?.find((p) => p.id === dragState.polyId);
                    if (pp?.shape?.type === "circle") {
                        toggleSketchSelection({
                            kind: "circle",
                            spaceId: effectiveRoomId,
                            polyId: dragState.polyId,
                        }, additive);
                    } else if (!additive) {
                        clearSketchSelection();
                    }
                }
            }
        }
        dragStateRef.current = null;
        setDragState(null);
        suppressSelectDragUntilPointerUpRef.current = false;
        setGridSnapInfo(null);
        if (e) {
            try {
                e.currentTarget.releasePointerCapture(e.pointerId);
            } catch {
                // ignore browsers/cases where capture was not held
            }
        }
        (window as any).__viewportInteracting = false;
    };

    const edgeDragCursor = dragState && dragState.kind === "polyEdge";
    const isHandleDrag = dragState && (
        dragState.kind === "entityArcEndpoint"
        || dragState.kind === "entityCircleCenter"
        || dragState.kind === "entityCircleRadius"
    );
    const canvasCursor = dragState
        ? (dragState.kind === "polyVertex" ? "crosshair"
            : isHandleDrag ? "crosshair"
            : edgeDragCursor ? "grabbing" : "move")
        : hoveredPolyVertex ? "crosshair"
        : hoveredEdge ? "pointer"
        : hoveredGrid ? "pointer"
        : activeTool === "wall" ? "crosshair"
        : roomEditMode === "rectangle" || roomEditMode === "polyline" || roomEditMode === "circle" || roomEditMode === "wallPath" || roomEditMode === "line" || roomEditMode === "arc" || roomEditMode === "arcEdge" || roomEditMode === "trim" || roomEditMode === "wallSkip" ? "crosshair"
        : hoveredPolyId ? "move" : "default";

    const handleDoubleClick = (e: React.MouseEvent) => {
        if (roomEditMode === "polyline" && polyDraftPoints.length >= 3) {
            e.preventDefault();
            commitPolyDraft(polyDraftPoints);
        } else if (roomEditMode === "wallPath" && polyDraftPoints.length >= 2) {
            e.preventDefault();
            // WallPath は常に開いたポリラインで確定 (= ユーザ仕様)。
            commitWallPathDraft(polyDraftPoints);
        }
    };

    const handleContextMenu = (e: React.MouseEvent) => {
        // Forward right-click to Viewport so wall drawing can cancel.
        if (activeTool === "wall" && activeRoomId) {
            e.preventDefault();
            const bg = canvasRef.current?.parentElement
                ?.querySelector("canvas:not([data-sketch-overlay])") as HTMLCanvasElement | null;
            if (bg) {
                bg.dispatchEvent(new MouseEvent("contextmenu", {
                    bubbles: true,
                    cancelable: true,
                    clientX: e.clientX,
                    clientY: e.clientY,
                    button: 2,
                }));
            }
            wallPassthroughRef.current = false;
            return;
        }
        if (roomEditMode === "polyline") {
            e.preventDefault();
            // incremental 3D 壁 (open polyline live) も破棄。
            discardLiveWallPathDraft();
            setPolyDraftPoints([]);
            setMouseWorld(null);
            setGridSnapInfo(null);
        } else if (roomEditMode === "wallPath") {
            // 右クリック: 1 点以下ならキャンセル、2 点以上なら開いたポリライン
            // として確定 (= ユーザ仕様で WallPath は閉じない)。
            e.preventDefault();
            if (polyDraftPoints.length >= 2) {
                commitWallPathDraft(polyDraftPoints, true);
            } else {
                // 1 点ドラフト時は live polygon は未生成 (≥2 点目で初めて作る)
                // ので念のため discard して draft state クリア。
                discardLiveWallPathDraft();
                setPolyDraftPoints([]);
                setMouseWorld(null);
                setGridSnapInfo(null);
            }
        } else if (roomEditMode === "circle") {
            e.preventDefault();
            // 右クリックキャンセル: live 円 + 3D 壁を破棄する。
            discardLiveCircleDraft();
            setCircleCenter(null);
            setMouseWorld(null);
            setGridSnapInfo(null);
        } else if (roomEditMode === "arcEdge") {
            // arcEdge ドラフト中の右クリックはキャンセル。
            e.preventDefault();
            setArcEdgeChord(null);
            setMouseWorld(null);
            setGridSnapInfo(null);
            setRoomEditMode("select");
        } else if (roomEditMode === "trim") {
            // Trim ドラフト中の右クリック: 段階的にキャンセル
            //   firstPoint あり → firstPoint 解除
            //   target あり → target 解除
            //   それ以外 → mode 終了
            e.preventDefault();
            if (trimFirstPoint) {
                setTrimFirstPoint(null);
            } else if (trimTargetEntityId) {
                setTrimTargetEntityId(null);
            } else {
                setRoomEditMode("select");
            }
            setMouseWorld(null);
            setGridSnapInfo(null);
        } else if (roomEditMode === "wallSkip") {
            // wallSkip ドラフト中の右クリック: 段階的にキャンセル。
            //   stage 3 (t0 あり) → t0 解除 (= 同じ edge で t0 から再ピック)
            //   stage 2 (draft あり、t0 なし) → edge 解除 (= 別 edge を選び直す)
            //   stage 1 (draft なし) → mode 終了
            e.preventDefault();
            if (wallSkipDraft?.t0 != null) {
                setWallSkipDraft({ ...wallSkipDraft, t0: null });
            } else if (wallSkipDraft) {
                setWallSkipDraft(null);
            } else {
                setRoomEditMode("select");
            }
            setMouseWorld(null);
            setGridSnapInfo(null);
        } else if (roomEditMode === "select") {
            // 選択エッジが 1 つだけならコンテキストメニューを表示。
            const edges = sketchSelection.filter(
                (s): s is Extract<typeof s, { kind: "edge" }> => s.kind === "edge",
            );
            const others = sketchSelection.filter((s) => s.kind !== "edge");
            if (edges.length === 1 && others.length === 0) {
                e.preventDefault();
                setEdgeContextMenu({
                    x: e.clientX, y: e.clientY,
                    spaceId: edges[0].spaceId,
                    polyId: edges[0].polyId,
                    edgeIdx: edges[0].edgeIdx,
                });
            }
        }
    };

    // Keep the ref up-to-date so the Enter key handler (registered above the
    // early return) can call the latest commit closure.
    commitPolyDraftRef.current = commitPolyDraft;
    commitWallPathDraftRef.current = commitWallPathDraft;
    discardLiveWallPathDraftRef.current = discardLiveWallPathDraft;
    discardLiveCircleDraftRef.current = discardLiveCircleDraft;

    return (<>
        <canvas ref={canvasRef} data-sketch-overlay
            className="absolute inset-0 w-full h-full"
            style={{ pointerEvents: inRoomMode ? "auto" : "none", zIndex: 10, cursor: canvasCursor }}
            onPointerDown={handlePointerDown} onPointerMove={handlePointerMove} onPointerUp={(e) => handlePointerUp(e)}
            onDoubleClick={handleDoubleClick} onContextMenu={handleContextMenu} />
        <div ref={dimLayerRef} className="absolute inset-0" style={{ zIndex: 11, pointerEvents: "none" }} />
        {edgeContextMenu && (() => {
            const menu = edgeContextMenu;
            const close = () => setEdgeContextMenu(null);
            const sp = elements[menu.spaceId] as SpaceElement | undefined;
            const polyForMenu = sp?.polygons?.find((p) => p.id === menu.polyId);
            const skipsForEdge = (polyForMenu?.wallSkips ?? []).filter((s) => s.edgeIdx === menu.edgeIdx);
            const hasSkipForEdge = skipsForEdge.length > 0;

            const startArcEdge = () => {
                if (!polyForMenu) { close(); return; }
                const n = polyForMenu.outer.length;
                if (menu.edgeIdx < 0 || menu.edgeIdx >= n) { close(); return; }
                const a = polyForMenu.outer[menu.edgeIdx];
                const b = polyForMenu.outer[(menu.edgeIdx + 1) % n];
                setArcEdgeChord({
                    spaceId: menu.spaceId,
                    polyId: menu.polyId,
                    edgeIdx: menu.edgeIdx,
                    p0: [a[0], a[1]] as Vec2,
                    p1: [b[0], b[1]] as Vec2,
                });
                setRoomEditMode("arcEdge");
                clearSketchSelection();
                close();
            };

            // wallSkips を mutate して polygon を更新 → 壁を再生成。明示的なユーザ
            // アクションなので realtime フラグに関わらず regen を発火させる
            // (= 壁が消えた / 戻った視覚フィードバックを即座に得られる)。
            const writeSkips = (next: (skips: WallSkip[]) => WallSkip[]) => {
                const latest = useAppState.getState().elements[menu.spaceId] as SpaceElement | undefined;
                if (!latest) return;
                const newPolys = latest.polygons.map((p) => {
                    if (p.id !== menu.polyId) return p;
                    return { ...p, wallSkips: next(p.wallSkips ?? []) };
                });
                updateElement(menu.spaceId as ElementId, {
                    polygons: newPolys,
                    dirtyFlags: new Set([...(latest.dirtyFlags ?? []), "Geometry", "Mesh", "Render"]),
                } as any);
                const s = useAppState.getState();
                regenerateAllWalls({
                    wallThicknessMm: s.wallThicknessMm,
                    circleWallAngleDeg: s.circleWallAngleDeg,
                    wallReferenceMode: s.wallReferenceMode,
                    seedPolyIds: [menu.polyId],
                });
            };

            const fullSkip = () => {
                writeSkips((skips) => [
                    ...skips.filter((s) => s.edgeIdx !== menu.edgeIdx),
                    { edgeIdx: menu.edgeIdx, t0: 0, t1: 1 },
                ]);
                clearSketchSelection();
                close();
            };

            const startPartialSkip = () => {
                if (!polyForMenu) { close(); return; }
                const n = polyForMenu.outer.length;
                if (menu.edgeIdx < 0 || menu.edgeIdx >= n) { close(); return; }
                setWallSkipDraft({
                    spaceId: menu.spaceId,
                    polyId: menu.polyId,
                    edgeIdx: menu.edgeIdx,
                    t0: null,
                });
                setRoomEditMode("wallSkip");
                clearSketchSelection();
                close();
            };

            const restoreSkip = () => {
                writeSkips((skips) => skips.filter((s) => s.edgeIdx !== menu.edgeIdx));
                clearSketchSelection();
                close();
            };

            return (
                <>
                    <div className="fixed inset-0 z-40"
                        onClick={close} onContextMenu={(e) => { e.preventDefault(); close(); }} />
                    <div className="fixed z-50 bg-zinc-800 border border-zinc-600 rounded shadow-lg py-1 min-w-[160px]"
                        style={{ left: menu.x, top: menu.y }}>
                        <button
                            className="w-full text-left px-3 py-1.5 text-xs hover:bg-zinc-700"
                            onClick={startArcEdge}
                        >
                            Arc に変換
                        </button>
                        <div className="border-t border-zinc-700 my-1" />
                        <button
                            className="w-full text-left px-3 py-1.5 text-xs hover:bg-zinc-700"
                            onClick={fullSkip}
                        >
                            壁を削除
                        </button>
                        <button
                            className="w-full text-left px-3 py-1.5 text-xs hover:bg-zinc-700"
                            onClick={startPartialSkip}
                        >
                            壁を部分削除…
                        </button>
                        {hasSkipForEdge && (
                            <button
                                className="w-full text-left px-3 py-1.5 text-xs hover:bg-zinc-700 text-emerald-300"
                                onClick={restoreSkip}
                            >
                                壁を復元
                            </button>
                        )}
                    </div>
                </>
            );
        })()}
    </>);
}
