"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { mat4, vec4 } from "gl-matrix";
import { useAppState, AppState } from "../../application/AppState";
import { SpaceElement, RoomPolygon, polygonEdges, isPolygonClosed } from "../../model/elements/SpaceElement";
import { WallElement } from "../../model/elements/WallElement";
import { Camera } from "../../renderer/camera/Camera";
import { ViewportHandle } from "../layout/Viewport";
import { generateId } from "../../utils/ids";
import { computeMiteredCorners, computeMiteredWallAxes } from "./wallSync";
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
import { Constraint } from "../../model/constraint/Constraint";
import { snapToGrids, snapAxisAlign, DEFAULT_GRID_SNAP_TOLERANCE } from "../../model/grid/GridSnap";
import { GridLine, gridVertices } from "../../model/grid/GridLine";
import { SnapBVH } from "../../model/grid/SnapBVH";

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
type DragState = DragPolyState | DragPolyVertexState | DragPolyEdgeState;
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
    const activeTool = useAppState((s: AppState) => s.activeTool);
    const roomEditMode = useAppState((s: AppState) => s.roomEditMode);
    const grids = useAppState((s: AppState) => s.grids);
    const setRoomEditMode = useAppState((s: AppState) => s.setRoomEditMode);
    const elements = useAppState((s: AppState) => s.elements);
    const selection = useAppState((s: AppState) => s.selection);
    const setSelection = useAppState((s: AppState) => s.setSelection);
    const updateElement = useAppState((s: AppState) => s.updateElement);
    const removeElement = useAppState((s: AppState) => s.removeElement);
    const sketchSelection = useAppState((s: AppState) => s.sketchSelection);
    const constraints = useAppState((s: AppState) => s.constraints);
    const toggleSketchSelection = useAppState((s: AppState) => s.toggleSketchSelection);
    const clearSketchSelection = useAppState((s: AppState) => s.clearSketchSelection);
    const setSolverDragHint = useAppState((s: AppState) => s.setSolverDragHint);
    const executeCommand = useAppState((s: AppState) => s.executeCommand);

    const [rectStart, setRectStart] = useState<[number, number] | null>(null);
    const [mouseWorld, setMouseWorld] = useState<[number, number] | null>(null);
    // Polyline draft: one [x,z] pair per committed click. Last leg to cursor is shown dashed.
    const [polyDraftPoints, setPolyDraftPoints] = useState<[number, number][]>([]);
    // Circle draft: center set on 1st click, radius committed on 2nd click
    const [circleCenter, setCircleCenter] = useState<[number, number] | null>(null);
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
    // Populated by the body below — lets the Enter-key effect (declared before
    // the early return) call the latest closure.
    const commitPolyDraftRef = useRef<(pts: [number, number][]) => void>(() => {});
    const hoveredPolyIdRef = useRef(hoveredPolyId); hoveredPolyIdRef.current = hoveredPolyId;
    const hoveredPolyVertexRef = useRef(hoveredPolyVertex); hoveredPolyVertexRef.current = hoveredPolyVertex;
    const hoveredEdgeRef = useRef(hoveredEdge); hoveredEdgeRef.current = hoveredEdge;
    const dragStateRef = useRef(dragState); dragStateRef.current = dragState;
    const lastDraggedPolyIdRef = useRef(lastDraggedPolyId); lastDraggedPolyIdRef.current = lastDraggedPolyId;
    const sketchSelectionRef = useRef(sketchSelection); sketchSelectionRef.current = sketchSelection;
    const gridsRef = useRef<GridLine[]>(grids); gridsRef.current = grids;
    const gridSnapInfoRef = useRef(gridSnapInfo); gridSnapInfoRef.current = gridSnapInfo;
    const snapBVH = useMemo(() => SnapBVH.fromGrids(grids), [grids]);
    const snapBVHRef = useRef(snapBVH); snapBVHRef.current = snapBVH;

    // ── Init WebGPU renderer ──
    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas || !activeRoomId) return;

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
    }, [activeRoomId]);

    // ── Trigger React re-renders (for HTML dim labels which depend on camera) ──
    useEffect(() => {
        if (!activeRoomId || editingDim) return;
        let running = true;
        const loop = () => { if (!running) return; setTick(t => t + 1); requestAnimationFrame(loop); };
        requestAnimationFrame(loop);
        return () => { running = false; };
    }, [activeRoomId, editingDim]);

    // ── Re-dispatch wheel / RMB / MMB to the 3D canvas behind ──
    useEffect(() => {
        const cvs = canvasRef.current;
        if (!cvs || !activeRoomId) return;
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
    }, [activeRoomId]);

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
    useEffect(() => {
        if (roomEditMode !== "polyline") return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Enter" && polyDraftPoints.length >= 3) {
                e.preventDefault();
                commitPolyDraftRef.current(polyDraftPoints);
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

    // Reset drafts when leaving polyline / circle mode
    useEffect(() => {
        if (roomEditMode !== "polyline" && polyDraftPoints.length > 0) {
            setPolyDraftPoints([]);
        }
        if (roomEditMode !== "circle" && circleCenter) {
            setCircleCenter(null);
        }
    }, [roomEditMode]);

    // ─── Conditional early return (after all hooks) ───

    const camera = viewportRef.current?.getCamera() ?? null;
    if (!activeRoomId || !camera) return null;
    const room = elements[activeRoomId] as SpaceElement | undefined;
    if (!room || room.type !== "Space") return null;

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
        if (!rid) return { lines, quads, markers };
        const r = els[rid];
        if (!r || r.type !== "Space") return { lines, quads, markers };
        const rm = r as SpaceElement;

        const drag = dragStateRef.current;
        const hovPolyId = hoveredPolyIdRef.current;
        const hovPVtx = hoveredPolyVertexRef.current;
        const sketchSel = sketchSelectionRef.current;

        // Origin symbol: short X (red) / Z (green) axes with a center dot
        lines.push({ ax: 0, az: 0, bx: ORIGIN_AXIS_LEN, bz: 0, color: C_ORIGIN_X, width: 1.5 });
        lines.push({ ax: 0, az: 0, bx: 0, bz: ORIGIN_AXIS_LEN, color: C_ORIGIN_Z, width: 1.5 });
        markers.push({
            wx: 0, wz: 0, radius: 4, shape: "circle",
            fill: C_WHITE, stroke: C_ORIGIN_DOT, strokeWidth: 1.5,
        });

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

                // Gray wall slabs + explicit outer outline stroke (if walls
                // exist for this polygon's outer ring). Outline is DERIVED
                // geometry — drawn here directly from inner + wallThickness,
                // NOT stored as a separate RoomPolygon.
                if (poly.wallIds && poly.wallIds.length === poly.outer.length && poly.wallThickness) {
                    const T = poly.wallThickness;
                    let cx = 0, cy = 0;
                    for (const p of poly.outer) { cx += p[0]; cy += p[1]; }
                    cx /= poly.outer.length; cy /= poly.outer.length;
                    const inner = poly.outer;
                    const n = inner.length;
                    const outer = computeMiteredCorners(inner, [cx, cy], T);
                    // Per-wall outward normal scaled by T — used for square
                    // caps at ends where the neighbouring wall is absent (so
                    // the remaining wall doesn't render a mitred triangle tip
                    // poking into empty space).
                    const capOffset: [number, number][] = [];
                    for (let i = 0; i < n; i++) {
                        const j = (i + 1) % n;
                        const dx = inner[j][0] - inner[i][0];
                        const dy = inner[j][1] - inner[i][1];
                        const len = Math.hypot(dx, dy) || 1;
                        let nx = -dy / len * T, ny = dx / len * T;
                        const mx = (inner[i][0] + inner[j][0]) / 2;
                        const my = (inner[i][1] + inner[j][1]) / 2;
                        if (nx * (cx - mx) + ny * (cy - my) > 0) { nx = -nx; ny = -ny; }
                        capOffset.push([nx, ny]);
                    }
                    for (let i = 0; i < n; i++) {
                        if (!poly.wallIds[i]) continue;
                        const j = (i + 1) % n;
                        const prev = (i - 1 + n) % n;
                        const hasPrev = !!poly.wallIds[prev];
                        const hasNext = !!poly.wallIds[j];
                        const p3: [number, number] = hasPrev
                            ? [outer[i][0], outer[i][1]]
                            : [inner[i][0] + capOffset[i][0], inner[i][1] + capOffset[i][1]];
                        const p2: [number, number] = hasNext
                            ? [outer[j][0], outer[j][1]]
                            : [inner[j][0] + capOffset[i][0], inner[j][1] + capOffset[i][1]];
                        quads.push({
                            p0: [inner[i][0], inner[i][1]],
                            p1: [inner[j][0], inner[j][1]],
                            p2,
                            p3,
                            color: C_WALL_SLAB,
                        });
                    }
                    // Outer outline lines + corner markers are drawn by the
                    // separate wall-outline polygon (wallOutlineOf === poly.id)
                    // in the general polygon rendering loop — that's where
                    // they're selectable as sketch targets too.
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
                const isEdgeSel = (ei: number) => sketchSel.some(
                    (s) => s.kind === "edge" && s.polyId === poly.id && s.edgeIdx === ei,
                );
                const hovE = hoveredEdgeRef.current;
                const isEdgeHov = (ei: number) =>
                    !!hovE && hovE.polyId === poly.id && hovE.edgeIdx === ei;

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
                    const N = 48;
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

        // Polyline draft (while drawing)
        if (mode === "polyline") {
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
                if (pts.length >= 3) {
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

    // Finalize the polyline draft into a new RoomPolygon (no auto constraints).
    const commitPolyDraft = (points: [number, number][]) => {
        if (points.length < 3) return;
        const newId = generateId();
        const newPoly: RoomPolygon = {
            id: newId,
            outer: points.map((p) => [p[0], p[1]] as Vec2),
            holes: [],
        };
        updateElement(activeRoomId, {
            polygons: [...room.polygons, newPoly],
            dirtyFlags: new Set([...room.dirtyFlags, "Geometry", "Mesh", "Render"]),
        } as any);
        setPolyDraftPoints([]);
        setMouseWorld(null);
        setGridSnapInfo(null);
        setRoomEditMode("select");
    };

    // Display tessellation density for circles. Walls use a coarser angle
    // set via RoomEditPanel at generation time.
    const CIRCLE_DISPLAY_SEGMENTS = 128;
    const commitCircleDraft = (center: [number, number], radius: number) => {
        const pts: Vec2[] = [];
        for (let i = 0; i < CIRCLE_DISPLAY_SEGMENTS; i++) {
            const a = (i / CIRCLE_DISPLAY_SEGMENTS) * Math.PI * 2;
            pts.push([center[0] + Math.cos(a) * radius, center[1] + Math.sin(a) * radius]);
        }
        const newPoly: RoomPolygon = {
            id: generateId(),
            outer: pts,
            holes: [],
            shape: { type: "circle", center: [center[0], center[1]], radius },
        };
        updateElement(activeRoomId, {
            polygons: [...room.polygons, newPoly],
            dirtyFlags: new Set([...room.dirtyFlags, "Geometry", "Mesh", "Render"]),
        } as any);
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
                    const newId = generateId();
                    const newPoly: RoomPolygon = {
                        id: newId,
                        outer: [
                            [minX, minY],
                            [maxX, minY],
                            [maxX, maxY],
                            [minX, maxY],
                        ],
                        holes: [],
                    };
                    updateElement(activeRoomId, {
                        polygons: [...room.polygons, newPoly],
                        dirtyFlags: new Set([...room.dirtyFlags, "Geometry", "Mesh", "Render"]),
                    } as any);
                    for (const c of autoRectConstraints(activeRoomId, newId)) {
                        executeCommand(new AddConstraintCommand(c));
                    }
                }
                setRectStart(null); setMouseWorld(null); setGridSnapInfo(null); setRoomEditMode("select");
            }
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
        if (roomEditMode === "polyline" && wp) {
            const s = applyGridSnap(wp);
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
        if (roomEditMode === "rectangle" && wp) {
            const s = applyGridSnap(wp);
            setGridSnapInfo(s.info);
            if (rectStart) setMouseWorld(s.p);
            return;
        }
        if (dragState && wp) {
            if (!dragState.moved) setDragState({ ...dragState, moved: true });
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
                let bestCorr: { dx: number; dz: number; target: [number, number]; dist: number } | null = null;
                for (const pt of dpoly.origOuter) {
                    const tx = pt[0] + dx, tz = pt[1] + dz;
                    const hit = bvh.nearestWithin(tx, tz, DEFAULT_GRID_SNAP_TOLERANCE);
                    if (!hit) continue;
                    const d = Math.hypot(tx - hit.x, tz - hit.z);
                    if (!bestCorr || d < bestCorr.dist) {
                        bestCorr = {
                            dx: hit.x - pt[0],
                            dz: hit.z - pt[1],
                            target: [hit.x, hit.z],
                            dist: d,
                        };
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
            } else {
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
            if (dragState.kind === "poly" || dragState.kind === "polyVertex" || dragState.kind === "polyEdge") {
                setLastDraggedPolyId(dragState.polyId);
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
                toggleSketchSelection({
                    kind: "edge",
                    spaceId: activeRoomId,
                    polyId: dragState.polyId,
                    edgeIdx: dragState.edgeIdx,
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
        : roomEditMode === "rectangle" || roomEditMode === "polyline" || roomEditMode === "circle" ? "crosshair"
        : hoveredPolyId ? "move" : "default";

    const handleDoubleClick = (e: React.MouseEvent) => {
        if (roomEditMode === "polyline" && polyDraftPoints.length >= 3) {
            e.preventDefault();
            commitPolyDraft(polyDraftPoints);
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
        } else if (roomEditMode === "circle") {
            e.preventDefault();
            setCircleCenter(null);
            setMouseWorld(null);
            setGridSnapInfo(null);
        }
    };

    // Keep the ref up-to-date so the Enter key handler (registered above the
    // early return) can call the latest commit closure.
    commitPolyDraftRef.current = commitPolyDraft;

    return (<>
        <canvas ref={canvasRef} data-sketch-overlay
            className="absolute inset-0 w-full h-full"
            style={{ pointerEvents: activeRoomId ? "auto" : "none", zIndex: 10, cursor: canvasCursor }}
            onPointerDown={handlePointerDown} onPointerMove={handlePointerMove} onPointerUp={(e) => handlePointerUp(e)}
            onDoubleClick={handleDoubleClick} onContextMenu={handleContextMenu} />
        <div ref={dimLayerRef} className="absolute inset-0" style={{ zIndex: 11, pointerEvents: "none" }} />
    </>);
}
