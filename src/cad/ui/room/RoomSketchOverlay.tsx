"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { mat4, vec4 } from "gl-matrix";
import { useAppState, AppState, RESIDENTIAL_GRID_SECONDARY_M } from "../../application/AppState";
import { SpaceElement, RoomPolygon, PolygonJoint, polygonEdges, isPolygonClosed } from "../../model/elements/SpaceElement";
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
import { Constraint } from "../../model/constraint/Constraint";
import { snapToGrids, snapAxisAlign, DEFAULT_GRID_SNAP_TOLERANCE } from "../../model/grid/GridSnap";
import { GridLine, gridVertices } from "../../model/grid/GridLine";
import { SnapBVH } from "../../model/grid/SnapBVH";
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
    }>;
    startWorld: [number, number];
    moved: boolean;
}
type DragState = DragPolyState | DragPolyVertexState | DragPolyEdgeState | DragEntityArcState;
interface HoveredPolyVertex { polyId: string; vertexIdx: number; wx: number; wz: number; }
interface HoveredEdge { polyId: string; edgeIdx: number; midWx: number; midWz: number; }
interface EditingDim { polyId: string; axis: "w" | "h"; value: string; }

const VERTEX_SCREEN_RADIUS = 10;

type RGBA = [number, number, number, number];
const rgba = (r: number, g: number, b: number, a = 1): RGBA => [r / 255, g / 255, b / 255, a];

const C_RECT          = rgba(59, 130, 246);
const C_RECT_FILL     = rgba(59, 130, 246, 0.06);
const C_RECT_HOV      = rgba(96, 165, 250);
const C_RECT_HOV_FILL = rgba(96, 165, 250, 0.12);
const C_RECT_SEL      = rgba(249, 115, 22);
const C_RECT_SEL_FILL = rgba(249, 115, 22, 0.10);
const C_TEMP          = rgba(34, 197, 94);
const C_TEMP_FILL     = rgba(34, 197, 94, 0.08);
const C_WHITE         = rgba(255, 255, 255);
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
const C_SNAP_OBJ      = rgba(25, 204, 102);
const C_SNAP_AXIS     = rgba(51, 191, 242);
const C_EDGE_HOV      = rgba(251, 146, 60);
const C_ORIGIN_X      = rgba(239, 68, 68);
const C_ORIGIN_Z      = rgba(34, 197, 94);
const C_ORIGIN_DOT    = rgba(80, 80, 80);
const ORIGIN_AXIS_LEN = 0.3;

// ── Auto-constraints applied to a freshly-drawn rectangle ────────────────────
function autoRectConstraints(spaceId: string, polyId: string): Constraint[] {
    // Edge order in a rect-shape polygon (BL→BR=0, BR→TR=1, TR→TL=2, TL→BL=3)
    return [
        // 2 pairs of parallel edges
        {
            id: generateConstraintId(),
            type: "Parallel",
            targets: [
                { kind: "SketchEdge", spaceId, polyId, edgeIdx: 0 },
                { kind: "SketchEdge", spaceId, polyId, edgeIdx: 2 },
            ],
        },
        {
            id: generateConstraintId(),
            type: "Parallel",
            targets: [
                { kind: "SketchEdge", spaceId, polyId, edgeIdx: 1 },
                { kind: "SketchEdge", spaceId, polyId, edgeIdx: 3 },
            ],
        },
        // Right angle between adjacent edges → forces parallelogram → rectangle
        {
            id: generateConstraintId(),
            type: "Perpendicular",
            targets: [
                { kind: "SketchEdge", spaceId, polyId, edgeIdx: 0 },
                { kind: "SketchEdge", spaceId, polyId, edgeIdx: 1 },
            ],
        },
        // Lock orientation to axis-aligned
        {
            id: generateConstraintId(),
            type: "Horizontal",
            targets: [
                { kind: "SketchEdge", spaceId, polyId, edgeIdx: 0 },
            ],
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
     * 3D 壁を即時表示する。各追加クリックでは同じ polyId を持ったまま outer を
     * 拡張するため、ここで roomId と polyId を保持。確定 (Enter / 右クリック /
     * ダブルクリック) または mode 切替でクリア。
     */
    const wallPathDraftRef = useRef<{ polyId: string; roomId: ElementId } | null>(null);
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
    // Single-line draft (mode = "line"): first click sets start, second commits.
    const [lineStart, setLineStart] = useState<[number, number] | null>(null);
    // 3-click arc draft (mode = "arc"): center → start point → end point.
    const [arcCenter, setArcCenter] = useState<[number, number] | null>(null);
    const [arcStartPoint, setArcStartPoint] = useState<[number, number] | null>(null);
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
        kind: "obj" | "axis";
        refH?: [number, number];
        refV?: [number, number];
    } | null>(null);
    const [hoveredPolyId, setHoveredPolyId] = useState<string | null>(null);
    const [hoveredPolyVertex, setHoveredPolyVertex] = useState<HoveredPolyVertex | null>(null);
    const [hoveredEdge, setHoveredEdge] = useState<HoveredEdge | null>(null);
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

    // Refs mirroring state so the render loop reads latest values
    const roomEditModeRef = useRef(roomEditMode); roomEditModeRef.current = roomEditMode;
    const elementsRef = useRef(elements); elementsRef.current = elements;
    const selectionRef = useRef(selection); selectionRef.current = selection;
    const activeRoomIdRef = useRef(activeRoomId); activeRoomIdRef.current = activeRoomId;
    const rectStartRef = useRef(rectStart); rectStartRef.current = rectStart;
    const mouseWorldRef = useRef(mouseWorld); mouseWorldRef.current = mouseWorld;
    const polyDraftPointsRef = useRef(polyDraftPoints); polyDraftPointsRef.current = polyDraftPoints;
    const circleCenterRef = useRef(circleCenter); circleCenterRef.current = circleCenter;
    const arcEdgeChordRef = useRef(arcEdgeChord); arcEdgeChordRef.current = arcEdgeChord;
    // Populated by the body below — lets the Enter-key effect (declared before
    // the early return) call the latest closure.
    const commitPolyDraftRef = useRef<(pts: [number, number][]) => void>(() => {});
    const commitWallPathDraftRef = useRef<(pts: [number, number][]) => void>(() => {});
    const hoveredPolyIdRef = useRef(hoveredPolyId); hoveredPolyIdRef.current = hoveredPolyId;
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
    const mergeRef = useRef(() => {});
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
            const isHov = hoveredPolyId === poly.id && !isSel;
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

        // Merge icon (shown at top-right of last-dragged poly when overlapping)
        if (lastDraggedPolyId && room.polygons) {
            const focus = room.polygons.find(p => p.id === lastDraggedPolyId);
            if (focus) {
                const xs = focus.outer.map(p => p[0]);
                const ys = focus.outer.map(p => p[1]);
                const fMinX = Math.min(...xs), fMaxX = Math.max(...xs);
                const fMinZ = Math.min(...ys), fMaxZ = Math.max(...ys);
                const eps = 1e-6;
                let hasOverlap = false;
                for (const other of room.polygons) {
                    if (other.id === focus.id) continue;
                    const oxs = other.outer.map(p => p[0]);
                    const oys = other.outer.map(p => p[1]);
                    const oMinX = Math.min(...oxs), oMaxX = Math.max(...oxs);
                    const oMinZ = Math.min(...oys), oMaxZ = Math.max(...oys);
                    if (fMinX < oMaxX - eps && fMaxX > oMinX + eps &&
                        fMinZ < oMaxZ - eps && fMaxZ > oMinZ + eps) {
                        hasOverlap = true;
                        break;
                    }
                }
                if (hasOverlap) {
                    const [mx1, my1] = proj(fMinX, fMinZ);
                    const [mx2, my2] = proj(fMaxX, fMaxZ);
                    const rightX = Math.max(mx1, mx2);
                    const topY = Math.min(my1, my2);
                    const btn = document.createElement("button");
                    btn.type = "button";
                    btn.title = "重なる部屋を結合";
                    btn.textContent = "⛶";
                    btn.style.cssText = `position:absolute;left:${rightX + 6}px;top:${topY - 14}px;width:24px;height:24px;border-radius:12px;border:1.5px solid #ec4899;background:#fff;color:#ec4899;font-size:14px;font-weight:700;cursor:pointer;display:flex;align-items:center;justify-content:center;box-shadow:0 2px 6px rgba(236,72,153,0.35);pointer-events:auto;user-select:none;padding:0;line-height:1;`;
                    btn.addEventListener("mousedown", (ev) => {
                        ev.stopPropagation();
                        ev.preventDefault();
                        mergeRef.current();
                    });
                    layer.appendChild(btn);
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
                setPolyDraftPoints([]);
                setMouseWorld(null);
                setGridSnapInfo(null);
            }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [roomEditMode, polyDraftPoints]);

    // Reset drafts when leaving polyline / wallPath / circle / line / arc / trim mode
    useEffect(() => {
        if (roomEditMode !== "polyline" && roomEditMode !== "wallPath" && polyDraftPoints.length > 0) {
            setPolyDraftPoints([]);
            // wallPath モード離脱時に live polygon (= incremental 壁付き) が
            // 残っていればクリーンアップ。確定済みなら ref は null なので no-op。
            if (wallPathDraftRef.current) {
                const ref = wallPathDraftRef.current;
                const live = useAppState.getState();
                const space = live.elements[ref.roomId] as SpaceElement | undefined;
                if (space) {
                    const target = space.polygons?.find((p) => p.id === ref.polyId);
                    if (target) {
                        for (const wid of target.wallIds ?? []) {
                            if (wid && live.elements[wid]) live.removeElement(wid);
                        }
                        live.updateElement(ref.roomId, {
                            polygons: space.polygons.filter((p) => p.id !== ref.polyId),
                            dirtyFlags: new Set([...(space.dirtyFlags ?? []), "Geometry", "Mesh", "Render"]),
                        } as any);
                    }
                }
                wallPathDraftRef.current = null;
                wallPathDraftSnapsRef.current = [];
            }
        }
        if (roomEditMode !== "circle" && circleCenter) {
            setCircleCenter(null);
        }
        if (roomEditMode !== "line" && lineStart) setLineStart(null);
        if (roomEditMode !== "arc" && (arcCenter || arcStartPoint)) {
            setArcCenter(null); setArcStartPoint(null);
        }
        if (roomEditMode !== "arcEdge" && arcEdgeChord) {
            setArcEdgeChord(null);
            setMouseWorld(null);
        }
        if (roomEditMode !== "trim" && (trimTargetEntityId || trimFirstPoint)) {
            setTrimTargetEntityId(null); setTrimFirstPoint(null);
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
    const applyWallPathSnap = (xy: [number, number]): {
        p: [number, number];
        info: typeof gridSnapInfo;
        target?: WallPathSnapTarget;
    } => {
        const tol = DEFAULT_GRID_SNAP_TOLERANCE;
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
                info: { point: bestV.p, kind: "obj" },
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
                info: { point: bestE.p, kind: "obj" },
                target: {
                    kind: "polyEdge",
                    spaceId: bestE.spaceId,
                    polyId: bestE.polyId,
                    targetEdgeIdx: bestE.edgeIdx,
                    t: bestE.t,
                },
            };
        }
        // 4. Fallback: grid axis 整列 or 何も無し。
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
    const hitTestPolyVertex = (sx: number, sy: number): HoveredPolyVertex | null => {
        if (!room.polygons) return null;
        let best: HoveredPolyVertex | null = null, bestD = VERTEX_SCREEN_RADIUS;
        for (const p of room.polygons) {
            if (p.shape?.type === "circle") continue; // no vertex picking on circles
            for (let i = 0; i < p.outer.length; i++) {
                if (isArcVertex(p.outer, i)) continue; // hide arc-interior handles
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

    /** Update polygons on the room AND sync linked walls + wall-outline polys.
     *  Outline polygons are always re-derived from their inner so dragging
     *  the outer outline cannot break the thickness-offset invariant; inner
     *  drags also propagate through this path. Works for any vertex count. */
    const updatePolysAndSync = (newPolys: RoomPolygon[]) => {
        // pending 中 (実体 Space 無し) は polygons 編集が発生しない。安全側で無視。
        if (!activeRoomId) return;
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
        updateElement(activeRoomId, {
            polygons: synced,
            dirtyFlags: new Set([...room.dirtyFlags, "Geometry", "Mesh", "Render"]),
        } as any);
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

    // Merge the last-dragged polygon with all polygons that overlap it
    mergeRef.current = () => {
        if (!activeRoomId) return;
        if (!lastDraggedPolyId || !room.polygons) return;
        const focus = room.polygons.find(p => p.id === lastDraggedPolyId);
        if (!focus) return;

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
        const mergeSet = new Set<string>([focus.id]);
        for (const other of room.polygons) {
            if (other.id === focus.id) continue;
            const oxs = other.outer.map(p => p[0]);
            const oys = other.outer.map(p => p[1]);
            const oMinX = Math.min(...oxs), oMaxX = Math.max(...oxs);
            const oMinZ = Math.min(...oys), oMaxZ = Math.max(...oys);
            if (fMinX < oMaxX - eps && fMaxX > oMinX + eps &&
                fMinZ < oMaxZ - eps && fMaxZ > oMinZ + eps) {
                mergeSet.add(other.id);
            }
        }
        if (mergeSet.size < 2) return;

        const inputs = room.polygons
            .filter(p => mergeSet.has(p.id))
            .map(p => polyToCoords(p));
        const [first, ...rest] = inputs;
        const result = polygonClipping.union(first, ...rest);

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
            // Also collapse a near-duplicate wrap-around (last ≈ first)
            while (out.length > 1) {
                const a = out[0];
                const b = out[out.length - 1];
                if (Math.hypot(a[0] - b[0], a[1] - b[1]) <= DEDUP_EPS) out.pop();
                else break;
            }
            return out;
        };

        const newPolygons: RoomPolygon[] = room.polygons.filter(p => !mergeSet.has(p.id));
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
            newPolygons.push({ id: generateId(), outer, holes });
        }

        // Delete any walls that belonged to the merged polygons
        for (const p of room.polygons) {
            if (!mergeSet.has(p.id) || !p.wallIds) continue;
            for (const wid of p.wallIds) {
                if (wid && elements[wid]) removeElement(wid);
            }
        }

        updateElement(activeRoomId, {
            polygons: newPolygons,
            dirtyFlags: new Set([...room.dirtyFlags, "Geometry", "Mesh", "Render"]),
        } as any);
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
                for (const wid of p.wallIds ?? []) {
                    if (!wid) continue;
                    let s = wallToPolyIds.get(wid);
                    if (!s) { s = new Set(); wallToPolyIds.set(wid, s); }
                    s.add(p.id);
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
        lines.push({ ax: 0, az: 0, bx: ORIGIN_AXIS_LEN, bz: 0, color: C_ORIGIN_X, width: 1.5 });
        lines.push({ ax: 0, az: 0, bx: 0, bz: ORIGIN_AXIS_LEN, color: C_ORIGIN_Z, width: 1.5 });
        markers.push({
            wx: 0, wz: 0, radius: 4, shape: "circle",
            fill: C_WHITE, stroke: C_ORIGIN_DOT, strokeWidth: 1.5,
        });

        // ── Passive pass: render OTHER rooms' polygons behind the active one.
        // The active-room polygon loop below only iterates `rm.polygons`, so
        // without this pass switching the active room would make every
        // previously-drawn room disappear from the 2D overlay. We draw their
        // outlines + virtual-wall bands + faint fill, but no edit handles.
        for (const otherId in els) {
            if (otherId === rid) continue;
            const other = els[otherId];
            if (!other || other.type !== "Space") continue;
            const otherRoom = other as SpaceElement;
            if (!otherRoom.polygons) continue;
            for (const poly of otherRoom.polygons) {
                if (poly.wallOutlineOf) continue;
                if (poly.outer.length < 3) continue;

                // Confirmed walls (other rooms) — per-edge 6-vertex hexagon
                // via computeWallHexagon. Shared edges render only on the
                // canonical owner (lex-smallest polyId in wallToPolyIds).
                // wallIds は edge ごとに 1 個 → 閉じ図形なら .length === outer.length、
                // 開いたポリライン (wallPath) なら .length === edges.length (= outer.length-1)。
                // どちらでも正しく描画できるよう polygonEdges() の長さで照合する。
                const passiveEdgeCount = polygonEdges(poly).length;
                if (poly.wallIds && poly.wallIds.length === passiveEdgeCount
                    && (poly.wallThickness != null
                        || (poly.innerThickness != null && poly.outerThickness != null))) {
                    const renderedWidsP = new Set<string>();
                    for (let i = 0; i < passiveEdgeCount; i++) {
                        const wid = poly.wallIds[i];
                        if (!wid) continue;
                        if (!isWallOwner(wid, poly.id)) continue;
                        if (renderedWidsP.has(wid)) continue;
                        renderedWidsP.add(wid);
                        // 統合 footprint があればそちらを優先 (= 弧グループ wall)。
                        const wallEl = els[wid] as WallElement | undefined;
                        if (wallEl?.footprint && wallEl.footprint.length >= 3) {
                            for (const q of buildFootprintSlabQuads(wallEl.footprint, wallEl.footprintHoles)) quads.push(q);
                        } else {
                            for (const q of buildWallSlabQuads(poly, i)) quads.push(q);
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
                    const inactiveFill: RGBA = rgba(100, 116, 139, 0.05);
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
                const inactiveStroke: RGBA = rgba(100, 116, 139, 0.65);
                const polyEdgeList = polygonEdges(poly);
                for (const [ai, bi] of polyEdgeList) {
                    const a = poly.outer[ai], b = poly.outer[bi];
                    lines.push({
                        ax: a[0], az: a[1], bx: b[0], bz: b[1],
                        color: inactiveStroke, width: 1.2,
                    });
                }
                for (const h of poly.holes ?? []) {
                    if (h.length < 2) continue;
                    for (let i = 0; i < h.length; i++) {
                        const a = h[i];
                        const b = h[(i + 1) % h.length];
                        lines.push({
                            ax: a[0], az: a[1], bx: b[0], bz: b[1],
                            color: inactiveStroke, width: 1.2,
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
                const isHov = hovPolyId === poly.id && !isSel;
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
                const activeEdgeCount = polygonEdges(poly).length;
                if (poly.wallIds && poly.wallIds.length === activeEdgeCount
                    && (poly.wallThickness != null
                        || (poly.innerThickness != null && poly.outerThickness != null))) {
                    const renderedWidsA = new Set<string>();
                    for (let i = 0; i < activeEdgeCount; i++) {
                        const wid = poly.wallIds[i];
                        if (!wid) continue;
                        if (!isWallOwner(wid, poly.id)) continue;
                        if (renderedWidsA.has(wid)) continue;
                        renderedWidsA.add(wid);
                        // 統合 footprint があればそちらを優先 (= 弧グループ wall)。
                        const wallEl = els[wid] as WallElement | undefined;
                        if (wallEl?.footprint && wallEl.footprint.length >= 3) {
                            for (const q of buildFootprintSlabQuads(wallEl.footprint, wallEl.footprintHoles)) quads.push(q);
                        } else {
                            for (const q of buildWallSlabQuads(poly, i)) quads.push(q);
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
                // edge i は (a) 直接選択 / (b) entity 選択の owner が一致
                // のどちらかでハイライト対象になる。Arc 全体選択 (= entity)
                // は同 owner の全テッセレーション辺を一括強調する。
                const isEdgeSel = (ei: number) => {
                    const ownerId = poly.edgeOwners?.[ei];
                    return sketchSel.some((s) => {
                        if (s.kind === "edge") {
                            return s.polyId === poly.id && s.edgeIdx === ei;
                        }
                        if (s.kind === "entity" && ownerId) {
                            return s.entityId === ownerId;
                        }
                        return false;
                    });
                };
                const hovE = hoveredEdgeRef.current;
                const isEdgeHov = (ei: number) => {
                    if (!hovE) return false;
                    if (hovE.polyId === poly.id && hovE.edgeIdx === ei) return true;
                    // Arc グループは hover も entity 単位でハイライト。
                    const ownerId = poly.edgeOwners?.[ei];
                    if (!ownerId) return false;
                    if (hovE.polyId !== poly.id) return false;
                    const hoveredOwner = poly.edgeOwners?.[hovE.edgeIdx];
                    return hoveredOwner === ownerId;
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
                const polyEdgeList = polygonEdges(poly);
                const n = poly.outer.length;
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
                    lines.push({ ax: a[0], az: a[1], bx: b[0], bz: b[1], color: col, width });
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
                // polygon merges with a circle). For walled inner / wall
                // outline polygons we NEVER render the white stroke ring
                // (it reads as "chipped" corners against the gray wall).
                // Hover / selection feedback relies on colour + size change.
                const isCircle = poly.shape?.type === "circle";
                const hasWalls = !!(poly.wallIds && poly.wallIds.some(Boolean));
                const onWallBackground = hasWalls || isWallOutline;
                if (!isCircle) {
                    for (let i = 0; i < n; i++) {
                        if (isArcVertex(poly.outer, i)) continue;
                        const [wx, wz] = poly.outer[i];
                        const isCh = hovPVtx?.polyId === poly.id && hovPVtx.vertexIdx === i;
                        const selP = isVertSel(i);
                        const radius = selP ? 5.5 : (isCh ? 5 : (isSel || isHov ? 3.5 : 2.5));
                        // Fill: orange for sel/hover, polygon's stroke colour otherwise.
                        // On walled/outline polygons the fall-through fill is slate —
                        // make it a bit darker so it reads clearly on gray wall.
                        const baseFill: RGBA = onWallBackground ? rgba(55, 65, 81) : stroke;
                        const fillC: RGBA = selP ? C_HL_ORANGE
                            : isCh ? C_HL_ORANGE
                            : isSel ? C_RECT_SEL
                            : baseFill;
                        markers.push({
                            wx, wz, radius, shape: "circle",
                            fill: fillC,
                            stroke: onWallBackground ? ([0, 0, 0, 0] as RGBA) : C_WHITE,
                            strokeWidth: onWallBackground ? 0 : (selP ? 1.8 : 1),
                        });
                    }
                }
                // Edge midpoint markers for selected edges
                for (let i = 0; i < polyEdgeList.length; i++) {
                    if (!isEdgeSel(i)) continue;
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

        // Polyline / wallPath draft (while drawing). wallPath は閉じないので
        // close leg のヒントを描かない。
        if (mode === "polyline" || mode === "wallPath") {
            const pts = polyDraftPointsRef.current;
            const cursor = mw;
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

        // Grid snap indicator (cross marker + axis-alignment guide lines)
        const snapInfo = gridSnapInfoRef.current;
        if (snapInfo) {
            const [sx, sz] = snapInfo.point;
            if (snapInfo.kind === "obj") {
                markers.push({
                    wx: sx, wz: sz, radius: 6, shape: "square",
                    fill: C_SNAP_OBJ, stroke: C_WHITE, strokeWidth: 1.5,
                });
            } else {
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
                markers.push({
                    wx: sx, wz: sz, radius: 5, shape: "circle",
                    fill: C_SNAP_AXIS, stroke: C_WHITE, strokeWidth: 1.5,
                });
            }
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
        // eslint-disable-next-line no-console
        console.log(
            `[realtime-walls] regen triggered: ${reason}` +
            (seedPolyIds && seedPolyIds.length
                ? ` seeds=[${seedPolyIds.map((p) => p.slice(0, 6)).join(",")}]`
                : ""),
        );
        regenerateAllWalls({
            wallThicknessMm: s.wallThicknessMm,
            circleWallAngleDeg: s.circleWallAngleDeg,
            seedPolyIds,
        });
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
        return { roomId: target.roomId, polyId };
    };

    /**
     * 開いたエンティティ (line / arc / open polyline) を active or pending room に
     * 追加。閉ループにならないので polygon は派生しない。
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
        return targetId;
    };

    // Finalize the polyline draft as a closed PolylineEntity (auto-derives polygon).
    const commitPolyDraft = (points: [number, number][]) => {
        if (points.length < 3) return;
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
                live.updateElement(ref.roomId, {
                    polygons: space.polygons.filter((p) => p.id !== ref.polyId),
                    dirtyFlags: new Set([...(space.dirtyFlags ?? []), "Geometry", "Mesh", "Render"]),
                } as any);
            }
        }
        wallPathDraftRef.current = null;
        wallPathDraftSnapsRef.current = [];
    };

    /**
     * Mode 2 (shared-edge) で、最初と最後の WallPath 点が同じ既存ポリゴンに
     * スナップしているとき、**そのポリゴンの外周を CW (= 逆 CCW) でたどる**
     * 中間頂点列を返す。これを WallPath 点列の末尾に連結すると、新 Room の
     * outer は「WallPath で外側を回って → 元部屋の外周で内側に戻る」CCW
     * 多角形になる。
     *
     *  - 最後の点 B を **global t** 表示 (vertex 0=t0, vertex 1=t1, edge i 上の
     *    比率 r なら t=i+r) して、B → A への CW 経路 (= t 降順) を辿る。
     *  - 中間頂点 = (t_A, t_B) または (-∞, t_B) ∪ (t_A, n) に厳密に含まれる
     *    整数 t に対応する元頂点。
     *  - A・B が同じ辺なら中間ゼロ → outer は WallPath 点列のみで、暗黙の
     *    閉じ辺が元部屋の壁と共線 (= 共有エッジ判定対象)。
     */
    type WallPathSnapTargetSafeForTrace =
        | { kind: "polyVertex"; spaceId: string; polyId: string; targetVertexIdx: number }
        | { kind: "polyEdge"; spaceId: string; polyId: string; targetEdgeIdx: number; t: number };

    /**
     * 元部屋の外周を `direction` 方向にたどる中間頂点列。
     *  - "cw": 始点 B → 終点 A への CW (= 逆 CCW = t 降順)。
     *  - "ccw": B → A への CCW (= t 昇順)。
     *
     * 各点を **global t** 表示 (vertex i = t i, edge i 上の比率 r なら t=i+r)。
     */
    const computeOuterTraceIntermediate = (
        sourcePoly: RoomPolygon,
        firstSnap: WallPathSnapTargetSafeForTrace,
        lastSnap: WallPathSnapTargetSafeForTrace,
        direction: "cw" | "ccw",
    ): Vec2[] => {
        const n = sourcePoly.outer.length;
        if (n < 3) return [];
        const tOf = (s: WallPathSnapTargetSafeForTrace): number =>
            s.kind === "polyVertex"
                ? s.targetVertexIdx
                : s.targetEdgeIdx + Math.max(0, Math.min(1, s.t));
        const tA = tOf(firstSnap);
        const tB = tOf(lastSnap);
        const eps = 1e-6;
        if (Math.abs(tA - tB) < eps) return [];
        const indices: number[] = [];
        if (direction === "cw") {
            // 降順 (= reverse CCW)
            if (tA + eps < tB) {
                for (let i = Math.floor(tB - eps); i >= Math.ceil(tA + eps); i--) {
                    indices.push(((i % n) + n) % n);
                }
            } else {
                for (let i = Math.floor(tB - eps); i >= 0; i--) {
                    indices.push(((i % n) + n) % n);
                }
                for (let i = n - 1; i >= Math.ceil(tA + eps); i--) {
                    indices.push(((i % n) + n) % n);
                }
            }
        } else {
            // 昇順 (= forward CCW)
            if (tB + eps < tA) {
                for (let i = Math.ceil(tB + eps); i <= Math.floor(tA - eps); i++) {
                    indices.push(((i % n) + n) % n);
                }
            } else {
                for (let i = Math.ceil(tB + eps); i <= n - 1; i++) {
                    indices.push(((i % n) + n) % n);
                }
                for (let i = 0; i <= Math.floor(tA - eps); i++) {
                    indices.push(((i % n) + n) % n);
                }
            }
        }
        return indices.map((idx) =>
            [sourcePoly.outer[idx][0], sourcePoly.outer[idx][1]] as Vec2,
        );
    };

    /** 多角形の符号付き面積 (CCW=正, CW=負)。Shoelace 公式。 */
    const signedPolyArea = (verts: Vec2[]): number => {
        let a = 0;
        for (let i = 0; i < verts.length; i++) {
            const j = (i + 1) % verts.length;
            a += verts[i][0] * verts[j][1] - verts[j][0] * verts[i][1];
        }
        return a / 2;
    };

    /**
     * Mode 3 (cross-polygon) で、WallPath の最初/最後が **異なる polygon** の壁に
     * スナップしている場合の閉じ方。複数 Room の壁が共有されているとき、
     * 単一 polygon の outer をたどるだけでは囲い切れないので、関係する全 Room
     * polygon の **union 外周** をたどる。
     *
     * アルゴリズム:
     *  1. 全 Space の closed polygon を集めて `polygonClipping.union` で合成。
     *  2. 結果の各 outer ring について、最初の WallPath 点 A と最後の WallPath
     *     点 B が共にリング上にあるものを探す (≤1mm 距離許容)。
     *  3. 見つかったリングで A と B の **global t** (= 整数頂点 + edge 上の比) を
     *     計算。
     *  4. B → A を **forward (t 昇順)** と **backward (t 降順)** の 2 通りで
     *     辿り、それぞれ中間頂点列を取得 (端点 A, B は WallPath 側で持つので
     *     除外する)。
     *  5. WallPath 点列に各中間列を連結して 2 つの候補多角形を構築。
     *  6. 面積が小さい方を採用、CCW 正規化して返す。
     *
     * 失敗 (= 該当リングが無い) なら null。呼び出し側は WallPath だけで
     * 閉じる fallback を使う。
     */
    const computeUnionClosure = (
        points: [number, number][],
        elements: Record<string, any>,
    ): Vec2[] | null => {
        if (points.length < 2) return null;
        const A: Vec2 = [points[0][0], points[0][1]];
        const B: Vec2 = [points[points.length - 1][0], points[points.length - 1][1]];
        const wpVerts: Vec2[] = points.map((p) => [p[0], p[1]] as Vec2);

        // 1. 全 Space の closed polygon を収集して union 入力に整形。
        type Coords = [number, number][][];
        const inputs: Coords[] = [];
        for (const eid in elements) {
            const el = elements[eid];
            if (!el || el.type !== "Space") continue;
            const sp = el as SpaceElement;
            for (const p of sp.polygons ?? []) {
                if (!isPolygonClosed(p)) continue;
                if (!p.outer || p.outer.length < 3) continue;
                const ring = p.outer.map(([x, y]) => [x, y] as [number, number]);
                ring.push([ring[0][0], ring[0][1]]);
                const rings: Coords = [ring];
                for (const h of p.holes ?? []) {
                    if (h.length < 3) continue;
                    const hh = h.map(([x, y]) => [x, y] as [number, number]);
                    hh.push([hh[0][0], hh[0][1]]);
                    rings.push(hh);
                }
                inputs.push(rings);
            }
        }
        if (inputs.length === 0) return null;
        const [first, ...rest] = inputs;
        let unioned: ReturnType<typeof polygonClipping.union>;
        try {
            unioned = polygonClipping.union(first as any, ...(rest as any[]));
        } catch {
            return null;
        }
        if (!unioned || unioned.length === 0) return null;

        // 2. 各 outer ring 上で A・B を探す。最も両者が乗っているリングを採用。
        const TOL = 1e-3; // 1 mm
        type RingHit = { ring: Vec2[]; tA: number; tB: number };
        let best: RingHit | null = null;
        let bestErr = Infinity;
        for (const polygon of unioned) {
            if (!polygon || polygon.length === 0) continue;
            const rawRing = polygon[0]; // outer ring (first/last point duplicated)
            if (!rawRing || rawRing.length < 4) continue;
            // 末尾の重複点を取り除いた純粋な頂点列。
            const ring: Vec2[] = [];
            for (let i = 0; i < rawRing.length - 1; i++) {
                ring.push([rawRing[i][0], rawRing[i][1]] as Vec2);
            }
            const n = ring.length;
            if (n < 3) continue;
            // A, B 各点の global t と segment 距離を求める。
            const tOf = (pt: Vec2): { t: number; err: number } => {
                let bestT = 0, bestD2 = Infinity;
                for (let i = 0; i < n; i++) {
                    const a = ring[i], b = ring[(i + 1) % n];
                    const dx = b[0] - a[0], dy = b[1] - a[1];
                    const segLen2 = dx * dx + dy * dy;
                    if (segLen2 < 1e-18) continue;
                    let r = ((pt[0] - a[0]) * dx + (pt[1] - a[1]) * dy) / segLen2;
                    r = Math.max(0, Math.min(1, r));
                    const px = a[0] + dx * r, py = a[1] + dy * r;
                    const d2 = (pt[0] - px) ** 2 + (pt[1] - py) ** 2;
                    if (d2 < bestD2) {
                        bestD2 = d2;
                        bestT = i + r;
                    }
                }
                return { t: bestT, err: Math.sqrt(bestD2) };
            };
            const ha = tOf(A);
            const hb = tOf(B);
            if (ha.err > TOL || hb.err > TOL) continue;
            const totalErr = ha.err + hb.err;
            if (totalErr < bestErr) {
                bestErr = totalErr;
                best = { ring, tA: ha.t, tB: hb.t };
            }
        }
        if (!best) return null;

        // 3. ring 上で B → A の中間頂点を 2 方向で取得。
        const ring = best.ring;
        const n = ring.length;
        const eps = 1e-6;
        const collectIndices = (direction: "forward" | "backward"): number[] => {
            const tA = best!.tA, tB = best!.tB;
            const indices: number[] = [];
            if (Math.abs(tA - tB) < eps) return indices;
            if (direction === "forward") {
                // t 昇順 (= 通常の ring 順)。B → A。
                if (tA + eps > tB) {
                    for (let i = Math.ceil(tB + eps); i <= Math.floor(tA - eps); i++) {
                        indices.push(((i % n) + n) % n);
                    }
                } else {
                    for (let i = Math.ceil(tB + eps); i <= n - 1; i++) {
                        indices.push(((i % n) + n) % n);
                    }
                    for (let i = 0; i <= Math.floor(tA - eps); i++) {
                        indices.push(((i % n) + n) % n);
                    }
                }
            } else {
                // t 降順。B → A。
                if (tA + eps < tB) {
                    for (let i = Math.floor(tB - eps); i >= Math.ceil(tA + eps); i--) {
                        indices.push(((i % n) + n) % n);
                    }
                } else {
                    for (let i = Math.floor(tB - eps); i >= 0; i--) {
                        indices.push(((i % n) + n) % n);
                    }
                    for (let i = n - 1; i >= Math.ceil(tA + eps); i--) {
                        indices.push(((i % n) + n) % n);
                    }
                }
            }
            return indices;
        };
        const interFwd = collectIndices("forward").map((i) =>
            [ring[i][0], ring[i][1]] as Vec2,
        );
        const interBwd = collectIndices("backward").map((i) =>
            [ring[i][0], ring[i][1]] as Vec2,
        );

        // 4. 候補を構築 → 面積最小を採用 → CCW 正規化。
        const candFwd = [...wpVerts, ...interFwd];
        const candBwd = [...wpVerts, ...interBwd];
        const aFwd = Math.abs(signedPolyArea(candFwd));
        const aBwd = Math.abs(signedPolyArea(candBwd));
        let chosen = aFwd <= aBwd ? candFwd : candBwd;
        if (chosen.length < 3) return null;
        if (signedPolyArea(chosen) < 0) {
            chosen = [...chosen].reverse();
        }
        // eslint-disable-next-line no-console
        console.log(
            `[wallPath/closed] cross-polygon mode: areaFwd=${aFwd.toFixed(3)} ` +
            `areaBwd=${aBwd.toFixed(3)} → picked ${aFwd <= aBwd ? "forward" : "backward"} ` +
            `(${chosen.length} verts, ringSize=${n})`,
        );
        return chosen;
    };

    /**
     * WallPath が閉じた図形を成した場合に、単独壁ではなく **新しい Room**
     * として確定する。closure の種別 (= `detectWallPathClosure` の戻り値) に
     * 応じて outer を組み立て:
     *  - "loopback": WallPath 点列だけ (= 自己閉)。
     *  - "shared-edge": WallPath 点列 + 元部屋の外周中間頂点 (= 元の壁の
     *    スケッチ線をそのまま使う)。これにより新 Room の閉じ辺は元部屋の
     *    壁と完全に重なり、cluster sub-derivation が共有エッジとして自然に
     *    検出 → 新規に壁を勝手に追加せず、既存壁を共用する形になる。
     *  - "cross-polygon": WallPath が **2 つ以上の異なる Room polygon** の壁に
     *    跨ってスナップしているケース。全 Room の union 外周をたどり、最も
     *    面積が小さくなる方向で閉じる。隣接 Room の共有壁を再利用する。
     */
    const commitWallPathAsClosedRoom = (points: [number, number][]) => {
        // mode 判別 (commit 直前に再評価)。snaps をスナップショットに退避。
        const closureMode = detectWallPathClosure(points);
        const snapsCopy = wallPathDraftSnapsRef.current.slice();
        // live polygon と壁を片付けてから entity-driven の閉ポリゴン経路へ移譲。
        discardLiveWallPathDraft();
        wallPathDraftSnapsRef.current = [];
        setPolyDraftPoints([]);
        setMouseWorld(null);
        setGridSnapInfo(null);
        if (points.length < 3) {
            setRoomEditMode("select");
            return;
        }
        const wpVerts: Vec2[] = points.map((p) => [p[0], p[1]] as Vec2);
        let outer: Vec2[] = wpVerts;
        if (closureMode === "shared-edge") {
            const fst = snapsCopy[0];
            const lst = snapsCopy[points.length - 1];
            if (fst && lst && fst.polyId === lst.polyId) {
                // 元部屋を polyId で逆引き。
                const live = useAppState.getState().elements;
                let sourcePoly: RoomPolygon | null = null;
                for (const eid in live) {
                    const el = live[eid];
                    if (!el || el.type !== "Space") continue;
                    const sp = el as SpaceElement;
                    const f = sp.polygons?.find((p) => p.id === fst.polyId);
                    if (f) { sourcePoly = f; break; }
                }
                if (sourcePoly) {
                    // CW (逆 CCW) と CCW (順 CCW) の 2 通りで閉じ、面積が
                    // 小さい方を採用する。これで「元部屋の壁を共有して
                    // 切り出される最小面領域」が常に選ばれる (= ユーザー
                    // 仕様)。
                    const interCW = computeOuterTraceIntermediate(
                        sourcePoly, fst, lst, "cw");
                    const interCCW = computeOuterTraceIntermediate(
                        sourcePoly, fst, lst, "ccw");
                    const candCW = [...wpVerts, ...interCW];
                    const candCCW = [...wpVerts, ...interCCW];
                    const aCW = Math.abs(signedPolyArea(candCW));
                    const aCCW = Math.abs(signedPolyArea(candCCW));
                    let chosen = aCW <= aCCW ? candCW : candCCW;
                    // CCW (= 正の符号付き面積) に正規化。
                    if (signedPolyArea(chosen) < 0) {
                        chosen = [...chosen].reverse();
                    }
                    outer = chosen;
                    // eslint-disable-next-line no-console
                    console.log(
                        `[wallPath/closed] shared-edge mode: areaCW=${aCW.toFixed(3)} ` +
                        `areaCCW=${aCCW.toFixed(3)} → picked ${aCW <= aCCW ? "CW" : "CCW"} ` +
                        `(${chosen.length} verts)`,
                    );
                }
            }
        } else if (closureMode === "cross-polygon") {
            const live = useAppState.getState().elements;
            const closed = computeUnionClosure(points, live);
            if (closed) {
                outer = closed;
            }
        }
        const entity: PolylineEntity = {
            id: generateId(),
            kind: "polyline",
            points: outer,
            closed: true,
        };
        commitClosedEntity(entity);
        setRoomEditMode("select");
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
        const fmt = (v: Vec2) => `(${v[0].toFixed(4)}, ${v[1].toFixed(4)})`;
        // eslint-disable-next-line no-console
        console.log(
            `[arcEdge/commit] chord p0=${fmt(chord.p0)} p1=${fmt(chord.p1)} ` +
            `cursor=${fmt(cursor)} edgeIdx=${chord.edgeIdx} polyId=${chord.polyId.slice(0, 6)}`,
        );
        const arc = arcFromChordAndCursor(chord.p0, chord.p1, cursor);
        if (!arc) {
            // eslint-disable-next-line no-console
            console.warn(`[arcEdge/commit] arcFromChordAndCursor returned null`);
            return false;
        }
        // eslint-disable-next-line no-console
        console.log(
            `[arcEdge/commit] arc center=${fmt(arc.center)} r=${arc.radius.toFixed(4)} ` +
            `aStart=${(arc.aStart * 180 / Math.PI).toFixed(2)}° aEnd=${(arc.aEnd * 180 / Math.PI).toFixed(2)}° ` +
            `sweep=${(((arc.aEnd - arc.aStart + Math.PI * 4) % (Math.PI * 2)) * 180 / Math.PI).toFixed(2)}°`,
        );
        // 端点を recompute して chord と一致するか検証 (FP 誤差のサニティチェック)。
        const recompP0: Vec2 = [
            arc.center[0] + arc.radius * Math.cos(arc.aStart),
            arc.center[1] + arc.radius * Math.sin(arc.aStart),
        ];
        const recompP1: Vec2 = [
            arc.center[0] + arc.radius * Math.cos(arc.aEnd),
            arc.center[1] + arc.radius * Math.sin(arc.aEnd),
        ];
        // eslint-disable-next-line no-console
        console.log(
            `[arcEdge/commit] recompute(aStart)=${fmt(recompP0)} (Δ from chord: ` +
            `${(Math.hypot(recompP0[0]-chord.p0[0], recompP0[1]-chord.p0[1])).toExponential(2)} m) ` +
            `recompute(aEnd)=${fmt(recompP1)} (Δ: ` +
            `${(Math.hypot(recompP1[0]-chord.p1[0], recompP1[1]-chord.p1[1])).toExponential(2)} m)`,
        );
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
        // owner.points と chord.p0/p1 のずれをチェック (drag 等で乖離しているかも)。
        const ownerP0 = pts[i], ownerP1 = pts[j];
        // eslint-disable-next-line no-console
        console.log(
            `[arcEdge/commit] owner entity id=${owner.id.slice(0, 6)} n=${n} ` +
            `pts[i=${i}]=${fmt([ownerP0[0], ownerP0[1]])} ` +
            `pts[j=${j}]=${fmt([ownerP1[0], ownerP1[1]])} ` +
            `Δp0=${Math.hypot(ownerP0[0]-chord.p0[0], ownerP0[1]-chord.p0[1]).toExponential(2)} ` +
            `Δp1=${Math.hypot(ownerP1[0]-chord.p1[0], ownerP1[1]-chord.p1[1]).toExponential(2)}`,
        );
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
        // eslint-disable-next-line no-console
        console.log(
            `[arcEdge/commit] 新 polyline (open) endpoints: ` +
            `[0]=${fmt(polylinePoints[0])} [last]=${fmt(polylinePoints[polylinePoints.length-1])}`,
        );
        // 削除する辺 (= chord.edgeIdx) を参照する拘束、および矩形時に貼られた
        // 自動拘束 (Parallel/Perpendicular/Horizontal/Vertical で edge index が
        // 鎖の繋ぎ替えで意味を失うもの) を破棄する。残ると solver が
        // **新しい弧セグメント** を「直線にしろ」と動かしてしまい、ポリゴンが
        // 歪む (= スケッチ線がおかしくなる原因)。安全側で当該 polyId を参照
        // する辺/頂点ベースの自動拘束は全部落とす。
        const allConstraints = useAppState.getState().constraints;
        const removed: string[] = [];
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
            removed.push(`${c.type}#${cid.slice(0, 6)}`);
        }
        if (removed.length > 0) {
            // eslint-disable-next-line no-console
            console.log(`[arcEdge/commit] dropped ${removed.length} stale constraints: ${removed.join(", ")}`);
        }
        setSpaceEntities(chord.spaceId, (es) => {
            const next = es.map((e) => (e.id === owner.id ? newPolyline : e));
            next.push(newArc);
            return next;
        });
        // 派生後の polygon outer をダンプ。chord 端点付近に重複頂点や微小エッジが
        // 残っていないかをチェックする。
        const after = useAppState.getState().elements[chord.spaceId] as SpaceElement | undefined;
        const newPoly = after?.polygons?.find((p) => p.id === chord.polyId);
        if (newPoly) {
            const N = newPoly.outer.length;
            // 端点 chord.p0 / chord.p1 にもっとも近い outer 頂点を探す。
            const findClosest = (target: Vec2) => {
                let best = -1, bestD = Infinity;
                for (let k = 0; k < N; k++) {
                    const d = Math.hypot(
                        newPoly.outer[k][0] - target[0],
                        newPoly.outer[k][1] - target[1],
                    );
                    if (d < bestD) { bestD = d; best = k; }
                }
                return { idx: best, dist: bestD };
            };
            const cp0 = findClosest(chord.p0);
            const cp1 = findClosest(chord.p1);
            // eslint-disable-next-line no-console
            console.log(
                `[arcEdge/commit] 派生後 polygon: outer.length=${N} ` +
                `chord.p0 → outer[${cp0.idx}] (Δ=${cp0.dist.toExponential(2)}) ` +
                `chord.p1 → outer[${cp1.idx}] (Δ=${cp1.dist.toExponential(2)})`,
            );
            // chord 端点付近 (±3) の頂点と隣接エッジ長をダンプ。
            const dumpAround = (label: string, hit: { idx: number; dist: number }) => {
                const lines: string[] = [];
                for (let off = -3; off <= 3; off++) {
                    const k = ((hit.idx + off) % N + N) % N;
                    const v = newPoly.outer[k];
                    const next = newPoly.outer[((k + 1) % N + N) % N];
                    const segLen = Math.hypot(next[0] - v[0], next[1] - v[1]);
                    lines.push(
                        `  outer[${k}]=${fmt([v[0], v[1]])} → next len=${segLen.toExponential(2)}`,
                    );
                }
                // eslint-disable-next-line no-console
                console.log(`[arcEdge/commit] ${label} 周辺:\n${lines.join("\n")}`);
            };
            dumpAround(`chord.p0 (idx=${cp0.idx})`, cp0);
            dumpAround(`chord.p1 (idx=${cp1.idx})`, cp1);
        } else {
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
        // 確定 (Enter / 右クリック / ダブルクリック) かつ閉じた図形を成す
        // (= 自己ループ or 既存 polygon との共有エッジで閉じる) なら、開いた
        // 壁ではなく Room として確定する。Enter キー経由等で UI 側の closure
        // チェックを通らないケースのフォールバック。
        if (isFinal && detectWallPathClosure(points) !== null) {
            commitWallPathAsClosedRoom(points);
            return;
        }
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
            targetRoom = useAppState.getState().elements[targetId as string] as SpaceElement;
        }
        if (!targetId || !targetRoom) return;

        const edges: [number, number][] = [];
        for (let i = 0; i < points.length - 1; i++) edges.push([i, i + 1]);
        const outer = points.map((p) => [p[0], p[1]] as Vec2);

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

        // 既に live polygon がある (= 2 点目以降のクリック) なら更新、無ければ新規作成。
        const existing = wallPathDraftRef.current;
        let polyId: string;
        let updatedPolygons: RoomPolygon[];
        if (existing && existing.roomId === targetId
            && (targetRoom.polygons ?? []).some((p) => p.id === existing.polyId)) {
            polyId = existing.polyId;
            // 既存 polygon の wallIds が指す壁を **明示的に削除** する。これを
            // しないと、wallIds をクリアした時点で「polygon から参照されない壁」
            // が elements に残ってしまい (orphan)、次回の regen §6 でも消えない
            // (= prevWallIds は w.poly.wallIds から拾うが、今リセットしているので空)。
            const oldPoly = (targetRoom.polygons ?? []).find((p) => p.id === polyId);
            for (const wid of oldPoly?.wallIds ?? []) {
                if (wid && useAppState.getState().elements[wid]) {
                    useAppState.getState().removeElement(wid);
                }
            }
            updatedPolygons = (targetRoom.polygons ?? []).map((p) => {
                if (p.id !== polyId) return p;
                // outer / edges を新ドラフトで上書き。wallIds 系は regen が
                // 再構築するので消しておく (= 古いインデックスとの不整合回避)。
                const { wallIds: _w, wallsPerEdge: _wp, edgeIds: _e, sharedEdgeIds: _s,
                    vertexConnections: _vc, ...rest } = p;
                void _w; void _wp; void _e; void _s; void _vc;
                return { ...rest, outer, edges, joints };
            });
        } else {
            polyId = generateId();
            const newPoly: RoomPolygon = {
                id: polyId,
                outer,
                holes: [],
                edges,
                joints,
            };
            updatedPolygons = [...(targetRoom.polygons ?? []), newPoly];
            wallPathDraftRef.current = { polyId, roomId: targetId };
        }

        updateElement(targetId, {
            polygons: updatedPolygons,
            dirtyFlags: new Set([...(targetRoom.dirtyFlags ?? []), "Geometry", "Mesh", "Render"]),
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

    const commitCircleDraft = (center: [number, number], radius: number) => {
        if (radius < 1e-6) return;
        const entity: CircleEntity = {
            id: generateId(),
            kind: "circle",
            center: [center[0], center[1]],
            radius,
        };
        commitClosedEntity(entity);
        setRoomEditMode("select");
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

    // ─── Event handlers ───
    const handlePointerDown = (e: React.PointerEvent) => {
        if (e.button !== 0) return;
        const wp = unproject(e.clientX, e.clientY);
        if (!wp) return;
        (window as any).__viewportInteracting = true;

        // Wall tool + active room: overlay acts as a sketch-picker only.
        // Vertex / edge / circle hits toggle sketch selection (for the
        // constraint panel); anything else is forwarded to Viewport for
        // wall drawing.
        if (activeTool === "wall" && activeRoomId) {
            const r = getCanvasRect();
            const sx = e.clientX - (r?.left ?? 0), sy = e.clientY - (r?.top ?? 0);
            const additive = e.shiftKey || e.ctrlKey || e.metaKey;

            const pvtx = hitTestPolyVertex(sx, sy);
            if (pvtx) {
                toggleSketchSelection({
                    kind: "point",
                    spaceId: activeRoomId,
                    polyId: pvtx.polyId,
                    vertexIdx: pvtx.vertexIdx,
                }, additive);
                return;
            }
            const edge = hitTestEdge(sx, sy);
            if (edge) {
                toggleSketchSelection({
                    kind: "edge",
                    spaceId: activeRoomId,
                    polyId: edge.polyId,
                    edgeIdx: edge.edgeIdx,
                }, additive);
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
            const snapped = applyGridSnap(wp).p;
            // Click near the first committed point (≥3 points) closes the polygon
            if (polyDraftPoints.length >= 3) {
                const first = polyDraftPoints[0];
                const closeDist = Math.hypot(snapped[0] - first[0], snapped[1] - first[1]);
                if (closeDist < 0.3) {
                    commitPolyDraft(polyDraftPoints);
                    return;
                }
            }
            setPolyDraftPoints([...polyDraftPoints, snapped]);
            setMouseWorld(snapped);
            return;
        }

        // wallPath: 単独壁用の開いたポリライン。Enter / 右クリック / ダブル
        // クリックで確定 (≥2 点)。最初の点付近をクリックしてループを閉じた
        // 場合は、開いた壁ではなく **閉じた Room** として確定する (= polyline
        // モードと同じ closure 検出)。
        // applyWallPathSnap で既存壁の頂点・辺 (= スケッチ線) にスナップ。
        // 2 点目以降のクリックでは isFinal=false で incremental commit を呼んで
        // 3D 壁をリアルタイムに生成・拡張する。
        // スナップ確定情報 (= target) を `wallPathDraftSnapsRef` に積み、
        // commit 時に polygon の `joints[]` として保存する。
        if (roomEditMode === "wallPath") {
            const snap = applyWallPathSnap(wp);
            const snapped = snap.p;
            // ─ closure 検出: 既存 ≥3 点 + 最初の点付近クリックで閉ループ確定。
            if (polyDraftPoints.length >= 3) {
                const first = polyDraftPoints[0];
                const closeDist = Math.hypot(
                    snapped[0] - first[0], snapped[1] - first[1],
                );
                if (closeDist < 0.3) {
                    commitWallPathAsClosedRoom(polyDraftPoints);
                    return;
                }
            }
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
            const snapped = applyGridSnap(wp).p;
            if (!circleCenter) {
                setCircleCenter(snapped);
                setMouseWorld(snapped);
            } else {
                const r = Math.hypot(snapped[0] - circleCenter[0], snapped[1] - circleCenter[1]);
                if (r > 1e-3) commitCircleDraft(circleCenter, r);
                setCircleCenter(null);
                setMouseWorld(null);
                setGridSnapInfo(null);
            }
            return;
        }

        if (roomEditMode === "rectangle") {
            console.log("きたよ")
            const snapped = applyGridSnap(wp).p;
            if (!rectStart) { setRectStart(snapped); setMouseWorld(snapped); }
            else {
                // Create a 4-vertex polygon (canonical [BL, BR, TR, TL]) and
                // attach the auto-rect constraint set so that subsequent edits
                // keep it axis-aligned.
                const minX = Math.min(rectStart[0], snapped[0]);
                const maxX = Math.max(rectStart[0], snapped[0]);
                const minY = Math.min(rectStart[1], snapped[1]);
                const maxY = Math.max(rectStart[1], snapped[1]);
                if (maxX - minX > 1e-6 && maxY - minY > 1e-6) {
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
                    const result = commitClosedEntity(entity);
                    if (result?.polyId) {
                        for (const c of autoRectConstraints(result.roomId, result.polyId)) {
                            executeCommand(new AddConstraintCommand(c));
                        }
                    }
                }
                setRectStart(null); setMouseWorld(null); setGridSnapInfo(null); setRoomEditMode("select");
            }
            return;
        }

        // Single line entity: 2 clicks. The entity is "open" — no polygon is
        // derived; downstream consumers (snapping / wall pipeline) read the
        // entity directly.
        if (roomEditMode === "line") {
            const snapped = applyGridSnap(wp).p;
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

        // Arc entity: 3 clicks (center → start point → end point).
        // First click: center. Second: a point on the arc (sets radius and
        // start angle). Third: end angle (radius is fixed by the start click;
        // end snaps onto the radius circle for a clean arc).
        if (roomEditMode === "arc") {
            const snapped = applyGridSnap(wp).p;
            if (!arcCenter) { setArcCenter(snapped); setMouseWorld(snapped); return; }
            if (!arcStartPoint) {
                const r = Math.hypot(snapped[0] - arcCenter[0], snapped[1] - arcCenter[1]);
                if (r < 1e-6) return; // ignore degenerate
                setArcStartPoint(snapped);
                setMouseWorld(snapped);
                return;
            }
            const r = Math.hypot(arcStartPoint[0] - arcCenter[0], arcStartPoint[1] - arcCenter[1]);
            const aStart = Math.atan2(arcStartPoint[1] - arcCenter[1], arcStartPoint[0] - arcCenter[0]);
            const aEnd = Math.atan2(snapped[1] - arcCenter[1], snapped[0] - arcCenter[0]);
            // sweep ≈ 0 → degenerate (use ε); ≈ 2π → full circle (commit as Circle)
            const sweep = wrap2pi(aEnd - aStart);
            if (sweep < 1e-6) {
                // commit as full circle instead
                const entity: CircleEntity = {
                    id: generateId(), kind: "circle",
                    center: [arcCenter[0], arcCenter[1]], radius: r,
                };
                commitClosedEntity(entity);
            } else {
                const entity: ArcEntity = {
                    id: generateId(), kind: "arc",
                    center: [arcCenter[0], arcCenter[1]], radius: r,
                    aStart, aEnd,
                };
                commitOpenEntity(entity);
            }
            setArcCenter(null); setArcStartPoint(null); setMouseWorld(null); setGridSnapInfo(null);
            setRoomEditMode("select");
            return;
        }

        // arcEdge mode: 選択エッジを chord として固定し、クリック位置の bulge で
        // 円弧化。chord は context menu で確定済み。
        if (roomEditMode === "arcEdge") {
            const snapped = applyGridSnap(wp).p;
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
            const snapped = applyGridSnap(wp).p;
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

        if (roomEditMode === "select") {
            const r = getCanvasRect();
            const sx = e.clientX - (r?.left ?? 0), sy = e.clientY - (r?.top ?? 0);

            // Vertex
            const pvtx = hitTestPolyVertex(sx, sy);
            if (pvtx && room.polygons) {
                const poly = room.polygons.find(p => p.id === pvtx.polyId)!;
                setSelection([`poly:${pvtx.polyId}`]);
                setLastDraggedPolyId(null);
                setDragState({
                    kind: "polyVertex",
                    polyId: pvtx.polyId,
                    vertexIdx: pvtx.vertexIdx,
                    origOuter: poly.outer.map(p => [p[0], p[1]] as Vec2),
                    origHoles: (poly.holes ?? []).map(h => h.map(p => [p[0], p[1]] as Vec2)),
                    wallThickness: poly.wallThickness,
                    moved: false,
                });
                return;
            }

            // Edge
            const edge = hitTestEdge(sx, sy);
            if (edge && room.polygons) {
                const poly = room.polygons.find(p => p.id === edge.polyId)!;
                // Arc 由来 edge は弧全体を平行移動する entityArc ドラッグへ。
                // owner entity を解決して、その chord 端点と一致する近傍 polyline /
                // line 端点も追従できるようキャッシュしておく。
                const ownerId = poly.edgeOwners?.[edge.edgeIdx];
                const ownerEnt = ownerId
                    ? (room.entities ?? []).find((en) => en.id === ownerId)
                    : undefined;
                if (ownerEnt && ownerEnt.kind === "arc" && activeRoomId) {
                    const arc = ownerEnt;
                    const p0: [number, number] = [
                        arc.center[0] + arc.radius * Math.cos(arc.aStart),
                        arc.center[1] + arc.radius * Math.sin(arc.aStart),
                    ];
                    const p1: [number, number] = [
                        arc.center[0] + arc.radius * Math.cos(arc.aEnd),
                        arc.center[1] + arc.radius * Math.sin(arc.aEnd),
                    ];
                    const SNAP_EPS = 1e-3;
                    const samePt = (a: [number, number], b: [number, number]) =>
                        Math.hypot(a[0] - b[0], a[1] - b[1]) < SNAP_EPS;
                    const adj: DragEntityArcState["origAdjacentPoints"] = [];
                    for (const en of room.entities ?? []) {
                        if (en.id === arc.id) continue;
                        if (en.kind === "polyline") {
                            const n = en.points.length;
                            const checkIdxs = en.closed
                                ? Array.from({ length: n }, (_, i) => i)
                                : [0, n - 1];
                            for (const idx of checkIdxs) {
                                const pt = en.points[idx];
                                if (!pt) continue;
                                if (samePt(pt, p0) || samePt(pt, p1)) {
                                    adj.push({
                                        entityId: en.id, kind: "polyline", idx,
                                        orig: [pt[0], pt[1]],
                                    });
                                }
                            }
                        } else if (en.kind === "line") {
                            for (const idx of [0, 1] as const) {
                                const pt = idx === 0 ? en.p0 : en.p1;
                                if (samePt(pt, p0) || samePt(pt, p1)) {
                                    adj.push({
                                        entityId: en.id, kind: "line", idx,
                                        orig: [pt[0], pt[1]],
                                    });
                                }
                            }
                        }
                    }
                    setSelection([`poly:${edge.polyId}`]);
                    setLastDraggedPolyId(null);
                    setDragState({
                        kind: "entityArc",
                        spaceId: activeRoomId,
                        entityId: arc.id,
                        polyId: edge.polyId,
                        origCenter: [arc.center[0], arc.center[1]],
                        origAdjacentPoints: adj,
                        startWorld: wp,
                        moved: false,
                    });
                    return;
                }
                const polyEdgeList = polygonEdges(poly);
                const [va, vb] = polyEdgeList[edge.edgeIdx];
                const ex = poly.outer[vb][0] - poly.outer[va][0];
                const ez = poly.outer[vb][1] - poly.outer[va][1];
                const len = Math.hypot(ex, ez) || 1;
                // Unit perpendicular (CCW rotate 90°)
                const normal: [number, number] = [-ez / len, ex / len];
                setSelection([`poly:${edge.polyId}`]);
                setLastDraggedPolyId(null);
                setDragState({
                    kind: "polyEdge",
                    polyId: edge.polyId,
                    edgeIdx: edge.edgeIdx,
                    origOuter: poly.outer.map(p => [p[0], p[1]] as Vec2),
                    origHoles: (poly.holes ?? []).map(h => h.map(p => [p[0], p[1]] as Vec2)),
                    normal,
                    wallThickness: poly.wallThickness,
                    startWorld: wp,
                    moved: false,
                });
                return;
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
            if (ph && room.polygons) {
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

                setDragState({
                    kind: "poly",
                    polyId: ph,
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
                    moved: false,
                });
                return;
            }

            // Inactive-room interior pick: clicking inside a polygon that
            // belongs to a non-active Space switches focus to that room AND
            // starts an interior drag in the same gesture, so previously-
            // drawn rooms stay editable. Vertex/edge handles are still only
            // rendered for the active room — to vertex-edit an inactive
            // room, click its interior first to activate it.
            {
                let hitOtherRoomId: ElementId | null = null;
                let hitOtherPoly: RoomPolygon | null = null;
                for (const oid in elements) {
                    if (oid === activeRoomId) continue;
                    const oel = elements[oid];
                    if (!oel || oel.type !== "Space") continue;
                    const ospace = oel as SpaceElement;
                    if (!ospace.polygons) continue;
                    for (let i = ospace.polygons.length - 1; i >= 0; i--) {
                        const op = ospace.polygons[i];
                        if (op.wallOutlineOf) continue;
                        if (!isPolygonClosed(op)) continue;
                        if (pointInRoomPolygon(cx, cz, op.outer, op.holes ?? [])) {
                            hitOtherRoomId = oid;
                            hitOtherPoly = op;
                            break;
                        }
                    }
                    if (hitOtherRoomId) break;
                }
                if (hitOtherRoomId && hitOtherPoly) {
                    // Snapshot any walls owned by this polygon so the drag
                    // translates them in lockstep (same as the active path).
                    const otherWallAxes: { id: string; a: Vec3; b: Vec3 }[] = [];
                    if (hitOtherPoly.wallIds) {
                        for (const wid of hitOtherPoly.wallIds) {
                            if (!wid) continue;
                            const wEl = elements[wid] as WallElement | undefined;
                            if (wEl && wEl.type === "Wall") {
                                otherWallAxes.push({
                                    id: wid,
                                    a: [wEl.axis[0][0], wEl.axis[0][1], wEl.axis[0][2]],
                                    b: [wEl.axis[1][0], wEl.axis[1][1], wEl.axis[1][2]],
                                });
                            }
                        }
                    }
                    setActiveRoom(hitOtherRoomId);
                    // Sync the ref synchronously so that the pointer-move
                    // handler — which may fire before React commits the new
                    // active room — already reads the right room id.
                    activeRoomIdRef.current = hitOtherRoomId;
                    setSelection([`poly:${hitOtherPoly.id}`]);
                    setLastDraggedPolyId(null);
                    setDragState({
                        kind: "poly",
                        polyId: hitOtherPoly.id,
                        startWorld: wp,
                        origOuter: hitOtherPoly.outer.map(p => [p[0], p[1]] as Vec2),
                        origHoles: (hitOtherPoly.holes ?? []).map(h => h.map(p => [p[0], p[1]] as Vec2)),
                        origShapeCenter: hitOtherPoly.shape?.type === "circle"
                            ? [hitOtherPoly.shape.center[0], hitOtherPoly.shape.center[1]]
                            : undefined,
                        origShapeRadius: hitOtherPoly.shape?.type === "circle"
                            ? hitOtherPoly.shape.radius : undefined,
                        origWallAxes: otherWallAxes,
                        origConcentric: [],
                        origOutlines: [],
                        moved: false,
                    });
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
            // wallPath は壁スケッチ線スナップ込み、polyline は通芯系のみ。
            const s = roomEditMode === "wallPath"
                ? applyWallPathSnap(wp)
                : applyGridSnap(wp);
            setGridSnapInfo(s.info);
            setMouseWorld(s.p);
            return;
        }
        if (roomEditMode === "circle" && wp) {
            const s = applyGridSnap(wp);
            setGridSnapInfo(s.info);
            setMouseWorld(s.p);
            return;
        }
        if (roomEditMode === "arcEdge" && wp) {
            const s = applyGridSnap(wp);
            setGridSnapInfo(s.info);
            setMouseWorld(s.p);
            return;
        }
        if (roomEditMode === "rectangle" && wp) {
            const s = applyGridSnap(wp);
            setGridSnapInfo(s.info);
            if (rectStart) setMouseWorld(s.p);
            return;
        }
        if (dragState && wp) {
            // ドラッグは実体 polygon が必要 → pending 中はそもそも到達しないが
            // TS narrow のためにガード。
            if (!activeRoomId) return;
            if (!dragState.moved) setDragState({ ...dragState, moved: true });
            if (dragState.kind === "entityArc") {
                // 弧全体を平行移動: arc.center + 隣接 polyline / line 端点を
                // ドラッグ delta だけ並行移動する。
                const d = dragState;
                const s = applyGridSnap(wp);
                setGridSnapInfo(s.info);
                const dx = s.p[0] - d.startWorld[0];
                const dz = s.p[1] - d.startWorld[1];
                setSpaceEntities(d.spaceId as ElementId, (entities) => entities.map((e) => {
                    if (e.id === d.entityId && e.kind === "arc") {
                        return {
                            ...e,
                            center: [d.origCenter[0] + dx, d.origCenter[1] + dz],
                        };
                    }
                    const adj = d.origAdjacentPoints.filter((a) => a.entityId === e.id);
                    if (adj.length === 0) return e;
                    if (e.kind === "polyline") {
                        const newPoints = e.points.map((pt, idx) => {
                            const m = adj.find((a) => a.idx === idx);
                            if (!m) return pt;
                            return [m.orig[0] + dx, m.orig[1] + dz] as Vec2;
                        });
                        return { ...e, points: newPoints };
                    }
                    if (e.kind === "line") {
                        const m0 = adj.find((a) => a.idx === 0);
                        const m1 = adj.find((a) => a.idx === 1);
                        return {
                            ...e,
                            ...(m0 ? { p0: [m0.orig[0] + dx, m0.orig[1] + dz] as Vec2 } : {}),
                            ...(m1 ? { p1: [m1.orig[0] + dx, m1.orig[1] + dz] as Vec2 } : {}),
                        };
                    }
                    return e;
                }));
                return;
            }
            if (dragState.kind === "polyVertex") {
                const s = applyGridSnap(wp);
                setGridSnapInfo(s.info);
                const sp = s.p;
                const currentPoly = room.polygons.find((p) => p.id === dragState.polyId);

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

                // Inner-drag path.
                // Hint the solver to pin this vertex at the cursor so other
                // vertices reflow around it instead of stretching arbitrarily.
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
                // Locally propagate simple Horizontal / Vertical / Coincident
                // constraints so the other endpoint of a constrained edge moves
                // in the same frame as the dragged vertex. The async solver
                // will confirm (and extend for more complex constraints).
                propagateSimpleConstraints(
                    newOuter,
                    dragState.polyId,
                    dragState.vertexIdx,
                    constraints,
                );
                const newPolys = room.polygons.map(p => {
                    if (p.id !== dragState.polyId) return p;
                    return {
                        ...p,
                        outer: newOuter,
                        holes: currentPoly?.holes ?? dragState.origHoles,
                    };
                });
                updatePolysAndSync(newPolys);
            } else if (dragState.kind === "poly") {
                const dpoly = dragState;
                let dx = wp[0] - dpoly.startWorld[0], dz = wp[1] - dpoly.startWorld[1];
                // BVH snap: for each translated vertex, query origin + grid
                // intersection snap targets. Adopt the closest hit across all
                // vertices and shift the delta so that vertex lands exactly
                // on the snap point.
                const bvh = snapBVHRef.current;
                const useResStep = designModeRef.current === "jpResidentialGrid";
                const resStep = RESIDENTIAL_GRID_SECONDARY_M;
                let bestCorr: { dx: number; dz: number; target: [number, number]; dist: number } | null = null;
                for (const pt of dpoly.origOuter) {
                    const tx = pt[0] + dx, tz = pt[1] + dz;
                    const hit = bvh.nearestWithin(tx, tz, DEFAULT_GRID_SNAP_TOLERANCE);
                    if (hit) {
                        const d = Math.hypot(tx - hit.x, tz - hit.z);
                        if (!bestCorr || d < bestCorr.dist) {
                            bestCorr = { dx: hit.x - pt[0], dz: hit.z - pt[1], target: [hit.x, hit.z], dist: d };
                        }
                    }
                    if (useResStep) {
                        const sx = Math.round(tx / resStep) * resStep;
                        const sz = Math.round(tz / resStep) * resStep;
                        const d = Math.hypot(tx - sx, tz - sz);
                        if (d <= DEFAULT_GRID_SNAP_TOLERANCE && (!bestCorr || d < bestCorr.dist)) {
                            bestCorr = { dx: sx - pt[0], dz: sz - pt[1], target: [sx, sz], dist: d };
                        }
                    }
                }
                if (bestCorr) {
                    dx = bestCorr.dx;
                    dz = bestCorr.dz;
                    setGridSnapInfo({ point: bestCorr.target, kind: "obj" });
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
                const newPolys = room.polygons.map(p => {
                    if (p.id === dpoly.polyId) {
                        const next: RoomPolygon = {
                            ...p,
                            outer: dpoly.origOuter.map(pt => [pt[0] + dx, pt[1] + dz] as Vec2),
                            holes: dpoly.origHoles.map(h => h.map(pt => [pt[0] + dx, pt[1] + dz] as Vec2)),
                        };
                        // Translate parametric shape from its drag-start snapshot
                        // (NOT p.shape which has already been updated by prior
                        // frames — that would compound and drift).
                        if (p.shape?.type === "circle" && dpoly.origShapeCenter && dpoly.origShapeRadius !== undefined) {
                            next.shape = {
                                type: "circle",
                                center: [dpoly.origShapeCenter[0] + dx, dpoly.origShapeCenter[1] + dz],
                                radius: dpoly.origShapeRadius,
                            };
                        }
                        return next;
                    }
                    const partner = partnerById.get(p.id);
                    if (partner) {
                        return {
                            ...p,
                            outer: partner.outer.map((pt) => [pt[0] + dx, pt[1] + dz] as Vec2),
                            holes: partner.holes.map((h) => h.map((pt) => [pt[0] + dx, pt[1] + dz] as Vec2)),
                            shape: {
                                type: "circle" as const,
                                center: [partner.shapeCenter[0] + dx, partner.shapeCenter[1] + dz] as Vec2,
                                radius: partner.shapeRadius,
                            },
                        };
                    }
                    const outlineSnap = dpoly.origOutlines.find((o) => o.polyId === p.id);
                    if (outlineSnap) {
                        return {
                            ...p,
                            outer: outlineSnap.outer.map((pt) => [pt[0] + dx, pt[1] + dz] as Vec2),
                            holes: outlineSnap.holes.map((h) => h.map((pt) => [pt[0] + dx, pt[1] + dz] as Vec2)),
                        };
                    }
                    return p;
                });
                // Cross-polygon Coincident propagation: move each partner
                // polygon's coincident vertex to the dragged polygon's new
                // position, then propagate through that polygon's H/V/etc.
                let reshapedPolys = newPolys;
                if (coincidentLinks.length > 0) {
                    const draggedOuter = reshapedPolys.find((p) => p.id === dpoly.polyId)?.outer;
                    if (draggedOuter) {
                        reshapedPolys = reshapedPolys.map((p) => {
                            const linksHere = coincidentLinks.filter((l) => l.otherPolyId === p.id);
                            if (linksHere.length === 0) return p;
                            const newOuter: Vec2[] = p.outer.map((pt) => [pt[0], pt[1]] as Vec2);
                            // Pin the partner's coincident vertices to the dragged
                            // polygon's current corresponding positions, then run
                            // local propagation from each pinned vertex.
                            for (const link of linksHere) {
                                const srcPt = draggedOuter[link.dragVertexIdx];
                                if (!srcPt) continue;
                                if (link.otherVertexIdx < 0 || link.otherVertexIdx >= newOuter.length) continue;
                                newOuter[link.otherVertexIdx] = [srcPt[0], srcPt[1]];
                            }
                            for (const link of linksHere) {
                                propagateSimpleConstraints(
                                    newOuter,
                                    p.id,
                                    link.otherVertexIdx,
                                    constraints,
                                );
                            }
                            return { ...p, outer: newOuter };
                        });
                    }
                }
                updateElement(activeRoomId, {
                    polygons: reshapedPolys,
                    dirtyFlags: new Set([...room.dirtyFlags, "Geometry", "Mesh", "Render"]),
                } as any);
                // Update the original walls translated by (dx, dz) directly
                // (computeMiteredWallAxes would re-derive but we already have axes).
                for (const w of dpoly.origWallAxes) {
                    const newAxis: [Vec3, Vec3] = [
                        [w.a[0] + dx, w.a[1], w.a[2] + dz],
                        [w.b[0] + dx, w.b[1], w.b[2] + dz],
                    ];
                    updateElement(w.id, {
                        axis: newAxis,
                        dirtyFlags: new Set(["Geometry", "Mesh", "Render"]),
                    } as any);
                }
            } else if (dragState.kind === "polyEdge") {
                const d = dragState; // polyEdge
                const s = applyGridSnap(wp);
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
                    const newPolys = room.polygons.map(p => {
                        if (p.id !== innerPoly.id) return p;
                        return { ...p, outer: newInnerOuter };
                    });
                    updatePolysAndSync(newPolys);
                    return;
                }

                // Use current state for the other vertices so solver adjustments
                // from previous frames aren't overwritten (avoids shaking).
                const currentPoly = room.polygons.find((p) => p.id === d.polyId);
                const baseOuter = currentPoly?.outer ?? d.origOuter;
                const newOuter: Vec2[] = baseOuter.map((pt, idx) => {
                    if (idx === i) return targetI;
                    if (idx === j) return targetJ;
                    return [pt[0], pt[1]] as Vec2;
                });
                const newPolys = room.polygons.map(p => {
                    if (p.id !== d.polyId) return p;
                    return { ...p, outer: newOuter, holes: currentPoly?.holes ?? d.origHoles };
                });
                updatePolysAndSync(newPolys);
            }
            return;
        }
        if ((roomEditMode === "select" || activeTool === "wall") && wp) {
            if (gridSnapInfo) setGridSnapInfo(null);
            const r = getCanvasRect();
            const sx = e.clientX - (r?.left ?? 0), sy = e.clientY - (r?.top ?? 0);
            const pvtx = hitTestPolyVertex(sx, sy);
            setHoveredPolyVertex(pvtx);
            const edge = pvtx ? null : hitTestEdge(sx, sy);
            setHoveredEdge(edge);
            // Suppress polygon-interior hover in wall mode — the interior
            // is a pass-through target for wall drawing, not a drag handle.
            setHoveredPolyId(pvtx || edge || activeTool === "wall"
                ? null
                : hitTestPoly(wp[0], wp[1]));
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

        // Clear any drag hint so subsequent solves don't keep pinning the vertex
        setSolverDragHint(null);
        if (dragState?.moved) {
            setSelection([]);
            if (dragState.kind === "poly" || dragState.kind === "polyVertex" || dragState.kind === "polyEdge" || dragState.kind === "entityArc") {
                setLastDraggedPolyId(dragState.polyId);
                // 矩形 A と矩形 B が今のドラッグで接続されたケースを既存ロジック
                // (regenerateAllWalls = 全壁生成) で吸収する。共線重なりが発生
                // していなければ何もリビルドしないので、ただの単独移動でも安全。
                // seed = ドラッグした polygon。影響範囲外の部屋の壁は触らない。
                maybeRealtimeRegenWalls(
                    `drag ${dragState.kind} → mouseup`,
                    [dragState.polyId],
                );
            }
        } else if (dragState && activeRoomId) {
            // Click without drag → toggle sketch selection (vertex / edge)
            const additive = !!(e && (e.shiftKey || e.ctrlKey || e.metaKey));
            if (dragState.kind === "polyVertex") {
                toggleSketchSelection({
                    kind: "point",
                    spaceId: activeRoomId,
                    polyId: dragState.polyId,
                    vertexIdx: dragState.vertexIdx,
                }, additive);
            } else if (dragState.kind === "polyEdge") {
                // Arc 由来 edge は弧全体 (= entity 単位) を選択する。同じ弧の
                // テッセレーション辺はすべて 1 つの ArcEntity に紐付くので、
                // ユーザーが任意の辺をクリックしただけで「弧 1 本」を選択
                // できるようにする。
                const pp = room.polygons?.find((p) => p.id === dragState.polyId);
                const ownerId = pp?.edgeOwners?.[dragState.edgeIdx];
                const ownerEnt = ownerId
                    ? (room.entities ?? []).find((en) => en.id === ownerId)
                    : undefined;
                if (ownerEnt && ownerEnt.kind === "arc") {
                    toggleSketchSelection({
                        kind: "entity",
                        spaceId: activeRoomId,
                        entityId: ownerEnt.id,
                    }, additive);
                } else {
                    toggleSketchSelection({
                        kind: "edge",
                        spaceId: activeRoomId,
                        polyId: dragState.polyId,
                        edgeIdx: dragState.edgeIdx,
                    }, additive);
                }
            } else if (dragState.kind === "entityArc") {
                // entityArc ドラッグ開始したが移動せずに離した = 弧全体を
                // 選択トグル。
                toggleSketchSelection({
                    kind: "entity",
                    spaceId: activeRoomId,
                    entityId: dragState.entityId,
                }, additive);
            } else if (dragState.kind === "poly") {
                const pp = room.polygons?.find((p) => p.id === dragState.polyId);
                if (pp?.shape?.type === "circle") {
                    // Click inside a parametric circle → toggle circle sketch-selection.
                    toggleSketchSelection({
                        kind: "circle",
                        spaceId: activeRoomId,
                        polyId: dragState.polyId,
                    }, additive);
                } else if (!additive) {
                    clearSketchSelection();
                }
            }
        }
        setDragState(null);
        setGridSnapInfo(null);
        (window as any).__viewportInteracting = false;
    };

    const edgeDragCursor = dragState && dragState.kind === "polyEdge";
    const canvasCursor = dragState
        ? (dragState.kind === "polyVertex" ? "crosshair"
            : edgeDragCursor ? "grabbing" : "move")
        : hoveredPolyVertex ? "crosshair"
        : hoveredEdge ? "pointer"
        : activeTool === "wall" ? "crosshair"
        : roomEditMode === "rectangle" || roomEditMode === "polyline" || roomEditMode === "circle" || roomEditMode === "wallPath" || roomEditMode === "line" || roomEditMode === "arc" || roomEditMode === "arcEdge" || roomEditMode === "trim" ? "crosshair"
        : hoveredPolyId ? "move" : "default";

    /**
     * WallPath ドラフトが閉じた図形を成しているか判定。
     *  - "loopback": 最後の点が最初の点付近 (= 自分で閉じた)。
     *  - "shared-edge": 最初と最後の点が **同じ polygon** の頂点 / 辺に
     *      スナップ済み。両者の間を polygon 外周に沿って結ぶことで閉じる。
     *  - "cross-polygon": 最初と最後の点が **別の polygon** にスナップ済み。
     *      隣接する複数部屋の壁を共有して 1 つの閉図形を成すケース。複数
     *      部屋の **union 外周** に沿って結ぶ。
     *  - null: 閉じていない (= 開いたまま単独壁として確定すべき)。
     */
    const detectWallPathClosure = (
        points: [number, number][],
    ): "loopback" | "shared-edge" | "cross-polygon" | null => {
        if (points.length < 3) return null;
        const f = points[0];
        const l = points[points.length - 1];
        if (Math.hypot(l[0] - f[0], l[1] - f[1]) < 0.3) return "loopback";
        const snaps = wallPathDraftSnapsRef.current;
        if (snaps.length === points.length) {
            const fst = snaps[0];
            const lst = snaps[points.length - 1];
            if (fst && lst) {
                if (fst.polyId === lst.polyId) return "shared-edge";
                return "cross-polygon";
            }
        }
        return null;
    };

    const handleDoubleClick = (e: React.MouseEvent) => {
        if (roomEditMode === "polyline" && polyDraftPoints.length >= 3) {
            e.preventDefault();
            commitPolyDraft(polyDraftPoints);
        } else if (roomEditMode === "wallPath" && polyDraftPoints.length >= 2) {
            e.preventDefault();
            // 閉じた形なら Room として確定、それ以外は単独壁として確定。
            if (detectWallPathClosure(polyDraftPoints) !== null) {
                commitWallPathAsClosedRoom(polyDraftPoints);
            } else {
                commitWallPathDraft(polyDraftPoints);
            }
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
            setPolyDraftPoints([]);
            setMouseWorld(null);
            setGridSnapInfo(null);
        } else if (roomEditMode === "wallPath") {
            // 右クリック: 1 点以下ならキャンセル、2 点以上なら確定。
            // 閉ループ (= 最後の点が最初の点付近) なら Room として確定。
            e.preventDefault();
            if (polyDraftPoints.length >= 2) {
                if (detectWallPathClosure(polyDraftPoints) !== null) {
                    commitWallPathAsClosedRoom(polyDraftPoints);
                } else {
                    commitWallPathDraft(polyDraftPoints, true);
                }
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
            const startArcEdge = () => {
                const sp = elements[menu.spaceId] as SpaceElement | undefined;
                const poly = sp?.polygons?.find((p) => p.id === menu.polyId);
                if (!poly) { close(); return; }
                const n = poly.outer.length;
                if (menu.edgeIdx < 0 || menu.edgeIdx >= n) { close(); return; }
                const a = poly.outer[menu.edgeIdx];
                const b = poly.outer[(menu.edgeIdx + 1) % n];
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
                    </div>
                </>
            );
        })()}
    </>);
}
