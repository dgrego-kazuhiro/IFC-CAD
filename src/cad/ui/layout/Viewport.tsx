"use client";

import React, { useEffect, useRef, useState, useImperativeHandle, forwardRef } from "react";
import { GPUDeviceManager } from "../../renderer/core/GPUDeviceManager";
import { RenderScene, RenderObject } from "../../renderer/core/RenderScene";
import { PerspectiveCamera } from "../../renderer/camera/PerspectiveCamera";
import { Renderer } from "../../renderer/core/Renderer";
import { CameraController } from "../../renderer/camera/CameraController";
import { MeshBuilder } from "../../mesh/MeshBuilder";
import { mat4, vec3, vec4 } from "gl-matrix";
import { useAppState, AppState, SketchSelectionItem, RESIDENTIAL_GRID_SECONDARY_M } from "../../application/AppState";
import { CreateWallCommand } from "../../commands/create/CreateWallCommand";
import { CreateDoorCommand } from "../../commands/create/CreateDoorCommand";
import { CreateWindowCommand } from "../../commands/create/CreateWindowCommand";
import { CreateSlabCommand, collectSpaceProfiles } from "../../commands/create/CreateSlabCommand";
import { CreateBeamCommand } from "../../commands/create/CreateBeamCommand";
import { CreateColumnCommand } from "../../commands/create/CreateColumnCommand";
import { UpdateColumnBasePointCommand } from "../../commands/modify/UpdateColumnBasePointCommand";
import { UpdateBeamAxisCommand } from "../../commands/modify/UpdateBeamAxisCommand";
import { runSketchSolver } from "../../constraint/SketchSolver";
import { AddConstraintCommand, generateConstraintId } from "../../commands/create/AddConstraintCommand";
import { ConstraintTarget } from "../../model/constraint/Constraint";
import { unifiedSnap, SnapSource, SnapInfo } from "../../snapping/UnifiedSnap";
import { BeamElement } from "../../model/elements/BeamElement";
import { ColumnElement } from "../../model/elements/ColumnElement";
import { BeamMeshBuilder } from "../../mesh/builders/BeamMeshBuilder";
import { ColumnMeshBuilder, columnFootprint2D } from "../../mesh/builders/ColumnMeshBuilder";
import {
    buildJunctionGraph,
    resolveJunctions,
    applyCaps,
    virtualEdgeFootprint,
    type ColumnFootprint,
} from "../../topology/junctions/JunctionGraph";
import { ensureCCW } from "../../geometry/wall/EdgeGeometry";
import type { RoomPolygon } from "../../model/elements/SpaceElement";
import { Profile } from "../../model/profiles/Profile";
import ConstraintPanel from "../constraint/ConstraintPanel";
import ConstraintIconOverlay from "../constraint/ConstraintIconOverlay";
import RoomLabelOverlay from "../room/RoomLabelOverlay";
import TypePickerChip from "../catalog/TypePickerChip";
import ElementTypePanel from "../catalog/ElementTypePanel";
import ResidentialGridOverlay from "../grid/ResidentialGridOverlay";
import DesignModeToggle from "./DesignModeToggle";
import { GcsBackend } from "../../constraint/GcsBackend";
import { WallElement } from "../../model/elements/WallElement";
import { OpeningElement } from "../../model/elements/OpeningElement";
import { DoorElement } from "../../model/elements/DoorElement";
import { WindowElement } from "../../model/elements/WindowElement";
import { SpaceElement, polygonEdges, isPolygonClosed } from "../../model/elements/SpaceElement";
import { SlabElement } from "../../model/elements/SlabElement";
import { WallGeometryBuilder } from "../../geometry/builders/WallGeometryBuilder";
import { WallMeshBuilder, WallOpeningInfo } from "../../mesh/builders/WallMeshBuilder";
import { DoorMeshBuilder } from "../../mesh/builders/DoorMeshBuilder";
import { WindowMeshBuilder } from "../../mesh/builders/WindowMeshBuilder";
import { SlabMeshBuilder } from "../../mesh/builders/SlabMeshBuilder";
import earcut from "earcut";
import { MeshData } from "../../mesh/MeshData";
import { LineMeshBuilder } from "../../mesh/builders/LineMeshBuilder";
import { Camera } from "../../renderer/camera/Camera";
import { OrthographicCamera } from "../../renderer/camera/OrthographicCamera";
import { Vec3 } from "../../geometry/math/Vec3";
import { Vec2 } from "../../geometry/math/Vec2";
import { rayIntersectsAABB } from "../../geometry/math/Raycast";
import { WallJoinResolver, WallJoinResult } from "../../topology/joins/WallJoinResolver";
import { snapToGrids, pickGrid, snapAngle, snapAxisAlign, GridSnapResult, AxisAlignSnapResult } from "../../model/grid/GridSnap";
import GridBubbleOverlay from "../grid/GridBubbleOverlay";
import GridEditOverlay from "../grid/GridEditOverlay";
import { gridVertices } from "../../model/grid/GridLine";
import { triggerWallRegenIfEnabled } from "../room/wallRegenerate";

export interface ViewportHandle {
    getCamera(): Camera | null;
    getCanvas(): HTMLCanvasElement | null;
}

export function getRay(
    clientX: number, clientY: number,
    canvas: HTMLCanvasElement,
    camera: Camera
): { origin: Vec3, dir: Vec3 } {
    const rect = canvas.getBoundingClientRect();
    const x = ((clientX - rect.left) / rect.width) * 2 - 1;
    const y = -((clientY - rect.top) / rect.height) * 2 + 1;

    const viewProj = mat4.create();
    mat4.multiply(viewProj, camera.projectionMatrix, camera.viewMatrix);
    const invViewProj = mat4.create();
    mat4.invert(invViewProj, viewProj);

    const near = vec4.fromValues(x, y, 0, 1);
    const far = vec4.fromValues(x, y, 1, 1);

    vec4.transformMat4(near, near, invViewProj);
    vec4.transformMat4(far, far, invViewProj);

    vec4.scale(near, near, 1 / near[3]);
    vec4.scale(far, far, 1 / far[3]);

    const rayOrigin: Vec3 = [near[0], near[1], near[2]];
    const rayEnd: Vec3 = [far[0], far[1], far[2]];
    const rayDir: Vec3 = [0, 0, 0];
    vec3.subtract(rayDir, rayEnd, rayOrigin);
    vec3.normalize(rayDir, rayDir);

    return { origin: rayOrigin, dir: rayDir };
}

// Project a world point onto a wall axis, returning the parameter t (0..1).
function projectOnWallAxis(point: Vec3, w: WallElement): number {
    const a = w.axis[0];
    const b = w.axis[1];
    const dx = b[0] - a[0];
    const dz = b[2] - a[2];
    const len2 = dx * dx + dz * dz;
    if (len2 < 1e-9) return 0;
    const t = ((point[0] - a[0]) * dx + (point[2] - a[2]) * dz) / len2;
    return Math.max(0, Math.min(1, t));
}

// Pick the wall under the cursor by raycasting against wall scene objects
// (works in both perspective 3D and orthographic 2D). Falls back to a
// ground-plane proximity test if the ray misses every wall AABB (useful in
// 2D mode where the wall scene object is a flat line strip).
function pickWallByRay(
    rayOrigin: Vec3,
    rayDir: Vec3,
    groundPoint: Vec3 | null,
    elements: Record<string, any>,
    sceneObjects: { id: string; mesh: { bounds: { min: Vec3; max: Vec3 } } }[],
): { wallId: string; position: number } | null {
    const debug = (globalThis as any).__pickDebug === true;
    // 1. Ray vs wall AABB — works in 3D
    let bestHit: { wallId: string; dist: number } | null = null;
    let wallObjCount = 0;
    for (const obj of sceneObjects) {
        const sid = obj.id.toString();
        if (sid.startsWith("handle-") || sid.startsWith("grid-") || sid === "preview-fill" || sid === "temp-wall-sketch") continue;
        const el = elements[sid];
        if (!el || el.type !== "Wall") continue;
        wallObjCount++;
        const dist = rayIntersectsAABB(rayOrigin, rayDir, obj.mesh.bounds);
        if (debug) {
            // eslint-disable-next-line no-console
            console.log(
                `  wall=${sid.slice(0,6)} bounds=[(${obj.mesh.bounds.min.map(v=>v.toFixed(2)).join(",")})-` +
                `(${obj.mesh.bounds.max.map(v=>v.toFixed(2)).join(",")})] ` +
                `dist=${dist === null ? "miss" : dist.toFixed(3)}`,
            );
        }
        if (dist !== null && (!bestHit || dist < bestHit.dist)) {
            bestHit = { wallId: sid, dist };
        }
    }
    if (debug) {
        // eslint-disable-next-line no-console
        console.log(
            `[pickWall] sceneObjs=${sceneObjects.length} wallObjs=${wallObjCount} ` +
            `bestHit=${bestHit ? bestHit.wallId.slice(0,6) : "null"} ground=${groundPoint ? `(${groundPoint[0].toFixed(2)},${groundPoint[2].toFixed(2)})` : "null"}`,
        );
    }
    if (bestHit) {
        const w = elements[bestHit.wallId] as WallElement;
        const hitX = rayOrigin[0] + rayDir[0] * bestHit.dist;
        const hitZ = rayOrigin[2] + rayDir[2] * bestHit.dist;
        return { wallId: bestHit.wallId, position: projectOnWallAxis([hitX, 0, hitZ], w) };
    }

    // 2. Fallback: nearest wall axis to the ground intersection (2D mode)
    if (!groundPoint) return null;
    const tolerance = 0.6;
    let best: { wallId: string; position: number; dist: number } | null = null;
    let wallElCount = 0;
    for (const id in elements) {
        const el = elements[id];
        if (!el || el.type !== "Wall") continue;
        wallElCount++;
        const w = el as WallElement;
        const a = w.axis[0];
        const b = w.axis[1];
        const dx = b[0] - a[0];
        const dz = b[2] - a[2];
        const len2 = dx * dx + dz * dz;
        if (len2 < 1e-9) continue;
        const t = ((groundPoint[0] - a[0]) * dx + (groundPoint[2] - a[2]) * dz) / len2;
        const tc = Math.max(0, Math.min(1, t));
        const projX = a[0] + dx * tc;
        const projZ = a[2] + dz * tc;
        const margin = (w.thickness ?? 0.2) / 2 + tolerance;
        const dist = Math.hypot(groundPoint[0] - projX, groundPoint[2] - projZ);
        if (dist <= margin && (!best || dist < best.dist)) {
            best = { wallId: id, position: tc, dist };
        }
    }
    if (debug) {
        // eslint-disable-next-line no-console
        console.log(
            `[pickWall fallback] wallEls=${wallElCount} best=${best ? `${best.wallId.slice(0,6)} t=${best.position.toFixed(3)} d=${best.dist.toFixed(3)}` : "null"}`,
        );
    }
    return best ? { wallId: best.wallId, position: best.position } : null;
}

// Build a flat triangulated mesh for a polygon at a given Y. Used for
// highlighting Space shapes in slab mode.
function buildSpaceFillMesh(
    outer: [number, number][],
    holes: [number, number][][],
    y: number,
): MeshData | null {
    if (outer.length < 3) return null;
    const flat: number[] = [];
    for (const p of outer) flat.push(p[0], p[1]);
    const holeIdx: number[] = [];
    for (const h of holes) {
        holeIdx.push(flat.length / 2);
        for (const p of h) flat.push(p[0], p[1]);
    }
    const tris = earcut(flat, holeIdx.length > 0 ? holeIdx : undefined, 2);
    if (tris.length === 0) return null;
    const positions: number[] = [];
    const normals: number[] = [];
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < flat.length; i += 2) {
        const x = flat[i], z = flat[i + 1];
        positions.push(x, y, z);
        normals.push(0, 1, 0);
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
    // In our right-handed world (Y up), a ring that is CCW in the XZ plane
    // (as 2D [x, z] → treated as 2D [x, y]) appears CW when viewed from +Y
    // looking down. WebGPU culls back-facing (CW from camera) triangles, so
    // we must flip the triangle winding whenever the input ring is CCW in XZ.
    let area2 = 0;
    for (let i = 0; i < outer.length; i++) {
        const a = outer[i];
        const b = outer[(i + 1) % outer.length];
        area2 += a[0] * b[1] - b[0] * a[1];
    }
    const indices: number[] = [];
    if (area2 > 0) {
        // CCW in XZ = CW from +Y view → flip to make it front-facing
        for (let i = 0; i < tris.length; i += 3) {
            indices.push(tris[i], tris[i + 2], tris[i + 1]);
        }
    } else {
        for (let i = 0; i < tris.length; i++) indices.push(tris[i]);
    }
    return {
        positions: new Float32Array(positions),
        normals: new Float32Array(normals),
        indices: new Uint32Array(indices),
        edgeIndices: new Uint32Array(),
        bounds: { min: [minX, y, minZ], max: [maxX, y, maxZ] },
    };
}

// Beam snap (spec §7): column center > beam endpoint > grid intersection >
// grid line > free point. Accepts raw ground intersection + current grids.
function snapForBeam(
    raw: Vec3,
    elements: Record<string, any>,
    grids: { id: string; visible: boolean; curve: any }[],
    tolerance: number = 0.5,
    residentialStep?: number,
): { point: Vec3; kind: "Column" | "BeamEndpoint" | "WallEndpoint" | "WallAxis" | "GridIntersection" | "Grid" | "ResidentialGrid" | null } {
    // 1. Column corner / center (角を中心より優先 — 角がより精密な配置目標)
    let bestCorner: { dist: number; point: Vec3 } | null = null;
    let bestCenter: { dist: number; point: Vec3 } | null = null;
    for (const id in elements) {
        const el = elements[id];
        if (!el || el.type !== "Column") continue;
        const col = el as ColumnElement;
        if (!col.basePoint) continue;
        // 中心
        const cx = col.basePoint[0];
        const cz = col.basePoint[2];
        const dCenter = Math.hypot(raw[0] - cx, raw[2] - cz);
        if (dCenter <= tolerance && (!bestCenter || dCenter < bestCenter.dist)) {
            bestCenter = { dist: dCenter, point: [cx, raw[1], cz] };
        }
        // 角頂点 (柱フットプリント)
        const fp = columnFootprint2D(col);
        for (const p of fp) {
            const d = Math.hypot(raw[0] - p[0], raw[2] - p[1]);
            if (d <= tolerance && (!bestCorner || d < bestCorner.dist)) {
                bestCorner = { dist: d, point: [p[0], raw[1], p[1]] };
            }
        }
    }
    if (bestCorner) return { point: bestCorner.point, kind: "Column" };
    if (bestCenter) return { point: bestCenter.point, kind: "Column" };

    // 2. Beam endpoint
    let bestEp: { dist: number; point: Vec3 } | null = null;
    for (const id in elements) {
        const el = elements[id];
        if (!el || el.type !== "Beam") continue;
        const beam = el as BeamElement;
        for (const p of beam.axis) {
            const d = Math.hypot(raw[0] - p[0], raw[2] - p[2]);
            if (d <= tolerance && (!bestEp || d < bestEp.dist)) {
                bestEp = { dist: d, point: [p[0], raw[1], p[2]] };
            }
        }
    }
    if (bestEp) return { point: bestEp.point, kind: "BeamEndpoint" };

    // 3. Wall endpoint (= wall.axis[0] / axis[1])。Column / Beam を壁の取付き
    //    点に正確に置けるよう、端点を最優先帯で吸着させる。
    let bestWE: { dist: number; point: Vec3 } | null = null;
    for (const id in elements) {
        const el = elements[id];
        if (!el || el.type !== "Wall") continue;
        const wall = el;
        const axis = wall.axis;
        if (!axis) continue;
        for (let i = 0; i < 2; i++) {
            const p = axis[i];
            const d = Math.hypot(raw[0] - p[0], raw[2] - p[2]);
            if (d <= tolerance && (!bestWE || d < bestWE.dist)) {
                bestWE = { dist: d, point: [p[0], raw[1], p[2]] };
            }
        }
    }
    if (bestWE) return { point: bestWE.point, kind: "WallEndpoint" };

    // 4. Wall axis (中心線への垂直投影)。線分内に落ちない場合は対象外。
    let bestWA: { dist: number; point: Vec3 } | null = null;
    for (const id in elements) {
        const el = elements[id];
        if (!el || el.type !== "Wall") continue;
        const wall = el;
        const axis = wall.axis;
        if (!axis) continue;
        const a = axis[0], b = axis[1];
        const dx = b[0] - a[0], dz = b[2] - a[2];
        const len2 = dx * dx + dz * dz;
        if (len2 < 1e-12) continue;
        let t = ((raw[0] - a[0]) * dx + (raw[2] - a[2]) * dz) / len2;
        t = Math.max(0, Math.min(1, t));
        const px = a[0] + dx * t;
        const pz = a[2] + dz * t;
        const d = Math.hypot(raw[0] - px, raw[2] - pz);
        if (d <= tolerance && (!bestWA || d < bestWA.dist)) {
            bestWA = { dist: d, point: [px, raw[1], pz] };
        }
    }
    if (bestWA) return { point: bestWA.point, kind: "WallAxis" };

    // 5. Grid intersection + 6. Grid line — reuse snapToGrids
    const gsnap = snapToGrids(raw, grids as any, tolerance);
    if (gsnap) {
        return {
            point: [gsnap.point[0], raw[1], gsnap.point[2]],
            kind: gsnap.kind === "Intersection" ? "GridIntersection" : "Grid",
        };
    }

    // 5. Residential background grid (910 / 455mm step) — only when active.
    //    Same handling as RoomSketchOverlay: snap when within tolerance of
    //    the nearest secondary-step intersection (covers primary too).
    if (residentialStep && residentialStep > 0) {
        const sx = Math.round(raw[0] / residentialStep) * residentialStep;
        const sz = Math.round(raw[2] / residentialStep) * residentialStep;
        if (Math.hypot(raw[0] - sx, raw[2] - sz) <= tolerance) {
            return { point: [sx, raw[1], sz], kind: "ResidentialGrid" };
        }
    }
    return { point: raw, kind: null };
}

// Wall-draw snap (shared with Room-mode drafting via unifiedSnap).
// Priority matches UnifiedSnap's cascade: Column → BeamEndpoint → WallEndpoint
// → RoomVertex → RoomEdge → GridIntersection → Grid → WallAxis → Axis → free.
//
// Source is re-exported from UnifiedSnap so existing consumers keep working.
export type WallSnapSource = SnapSource;

// Point-in-polygon test for a 2D polygon (XZ plane, Vec2 = [x, z]).
function pointInPolygon(p: [number, number], ring: [number, number][]): boolean {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const xi = ring[i][0], zi = ring[i][1];
        const xj = ring[j][0], zj = ring[j][1];
        const intersect =
            (zi > p[1]) !== (zj > p[1]) &&
            p[0] < ((xj - xi) * (p[1] - zi)) / (zj - zi + 1e-12) + xi;
        if (intersect) inside = !inside;
    }
    return inside;
}

// Find the Space whose unioned profile contains a given 2D point (XZ).
function pickSpaceAt(point: [number, number], elements: Record<string, any>): string | null {
    for (const id in elements) {
        const el = elements[id];
        if (!el || el.type !== "Space") continue;
        const profiles = collectSpaceProfiles(el as SpaceElement);
        for (const p of profiles) {
            if (pointInPolygon(point, p.outer as unknown as [number, number][])) {
                let inHole = false;
                for (const h of p.holes) {
                    if (pointInPolygon(point, h as unknown as [number, number][])) { inHole = true; break; }
                }
                if (!inHole) return id;
            }
        }
    }
    return null;
}

function getGroundIntersection(
    clientX: number, clientY: number,
    canvas: HTMLCanvasElement,
    camera: Camera
): Vec3 | null {
    const { origin, dir } = getRay(clientX, clientY, canvas, camera);

    if (Math.abs(dir[1]) < 0.0001) return null;

    const t = -origin[1] / dir[1];
    if (t < 0) return null;

    const intersection: Vec3 = [0, 0, 0];
    vec3.scaleAndAdd(intersection, origin, dir, t);
    return intersection;
}

const Viewport = forwardRef<ViewportHandle>(function Viewport(_props, ref) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const sceneRef = useRef<RenderScene>(null!);
    const cameraRef = useRef<Camera>(null!);
    const perspCamRef = useRef<PerspectiveCamera>(null!);
    const orthoCamRef = useRef<OrthographicCamera>(null!);
    const rendererRef = useRef<Renderer>(null!);
    const controllerRef = useRef<CameraController>(null!);

    // Orthographic zoom surfaced as state so grid thickness can be rebuilt
    // to stay pixel-constant. Updated from the render loop with a small
    // threshold to avoid rebuilding every frame.
    const [orthoZoom, setOrthoZoom] = useState<number>(10);

    const activeTool = useAppState((state: AppState) => state.activeTool);
    const executeCommand = useAppState((state: AppState) => state.executeCommand);
    const elements = useAppState((state: AppState) => state.elements);
    const selection = useAppState((state: AppState) => state.selection);
    const setSelection = useAppState((state: AppState) => state.setSelection);
    const updateElement = useAppState((state: AppState) => state.updateElement);
    const activeLevelId = useAppState((state: AppState) => state.activeLevelId);
    const levels = useAppState((state: AppState) => state.levels);
    const activeRoomId = useAppState((state: AppState) => state.activeRoomId);
    const pendingRoomLevelId = useAppState((state: AppState) => state.pendingRoomLevelId);
    const grids = useAppState((state: AppState) => state.grids);
    const designMode = useAppState((state: AppState) => state.designMode);
    const gridlineDrafting = useAppState((state: AppState) => state.gridlineDrafting);
    const setGridlineDrafting = useAppState((state: AppState) => state.setGridlineDrafting);
    const gridDraftMode = useAppState((state: AppState) => state.gridDraftMode);
    const setGridDraftMode = useAppState((state: AppState) => state.setGridDraftMode);
    const addGrid = useAppState((state: AppState) => state.addGrid);
    const addGridPolyline = useAppState((state: AppState) => state.addGridPolyline);
    const offsetLastGrid = useAppState((state: AppState) => state.offsetLastGrid);
    const createGridArray = useAppState((state: AppState) => state.createGridArray);
    const selectedGridIds = useAppState((state: AppState) => state.selectedGridIds);
    const constraints = useAppState((state: AppState) => state.constraints);
    const setSelectedGridIds = useAppState((state: AppState) => state.setSelectedGridIds);
    const removeGrids = useAppState((state: AppState) => state.removeGrids);
    const setActiveTool = useAppState((state: AppState) => state.setActiveTool);
    const sketchSelection = useAppState((state: AppState) => state.sketchSelection);
    const toggleSketchSelection = useAppState((state: AppState) => state.toggleSketchSelection);
    const clearSketchSelection = useAppState((state: AppState) => state.clearSketchSelection);
    const wallSubMode = useAppState((state: AppState) => state.wallSubMode);
    const beamSubMode = useAppState((state: AppState) => state.beamSubMode);
    const setBeamSubMode = useAppState((state: AppState) => state.setBeamSubMode);
    const columnSubMode = useAppState((state: AppState) => state.columnSubMode);
    const setColumnSubMode = useAppState((state: AppState) => state.setColumnSubMode);

    const [wallStart, setWallStart] = useState<Vec3 | null>(null);
    const [wallEnd, setWallEnd] = useState<Vec3 | null>(null);
    // Identity of what `wallStart` was snapped onto. Used to auto-add a
    // Coincident constraint between the new wall's start endpoint and the
    // snapped-to entity (previous wall end / room vertex) so polyline-style
    // chains stay connected under the solver.
    const [wallStartSource, setWallStartSource] = useState<WallSnapSource | null>(null);
    const [wallSnap, setWallSnap] = useState<SnapInfo | null>(null);
    // Sketch-pick hover preview for wall-mode "select" sub-mode. Drives
    // cursor feedback (crosshair on vertex, pointer on edge/axis) just like
    // room-mode select does.
    const [wallSketchHoverKind, setWallSketchHoverKind] = useState<"point" | "edge" | null>(null);
    const [dragState, setDragState] = useState<{ affected: { id: string, index: 0 | 1 }[], startPt: Vec3 } | null>(null);
    // 配置済み Column を select モードで掴んでドラッグ移動する状態。
    // pointerup で UpdateColumnBasePointCommand を発行して undo/redo 対応。
    const [columnDragState, setColumnDragState] = useState<{
        columnId: string;
        startPt: Vec3;
        origBasePoint: Vec3;
        finalPoint: Vec3;
        moved: boolean;
    } | null>(null);
    // 配置済み Beam を beam-edit モードで掴んで:
    //   handle === "axis" → 端点ドラッグ (= 形状変更)
    //   handle === "body" → 平行移動 (= 両端点を delta だけ移動)
    // pointerup で UpdateBeamAxisCommand を 1 回だけ発行。
    const [beamDragState, setBeamDragState] = useState<{
        beamId: string;
        handle: "start" | "end" | "body";
        startPt: Vec3;
        origAxis: [Vec3, Vec3];
        finalAxis: [Vec3, Vec3];
        moved: boolean;
    } | null>(null);
    // Grid drafting: single segment (2 points) per spec §6.1
    const [gridStart, setGridStart] = useState<Vec3 | null>(null);
    const [gridHover, setGridHover] = useState<Vec3 | null>(null);
    // Accumulator for polyline draft: one point per click, finalized on
    // Enter / double-click / first-point close-click.
    const [gridDraftPoints, setGridDraftPoints] = useState<Vec3[]>([]);
    const [gridSnap, setGridSnap] = useState<GridSnapResult | null>(null);
    const [gridAngleSnap, setGridAngleSnap] = useState<number | null>(null);
    const [gridAxisSnap, setGridAxisSnap] = useState<AxisAlignSnapResult | null>(null);
    const [gridKind, setGridKind] = useState<"Primary" | "Auxiliary">("Primary");
    const [showArrayPanel, setShowArrayPanel] = useState(false);
    const [arrayPitch, setArrayPitch] = useState("3");
    const [arrayCount, setArrayCount] = useState("3");
    const [offsetInput, setOffsetInput] = useState("3");

    // Door / window placement preview
    const [openingHover, setOpeningHover] = useState<{
        wallId: string;
        position: number; // 0..1 along the wall axis
    } | null>(null);
    // Per-tool defaults (spec §6 step 0: BB pre-determined)
    const doorDefaults = { width: 0.9, height: 2.1, sillHeight: 0 };
    const windowDefaults = { width: 1.2, height: 1.2, sillHeight: 0.9 };

    // Slab tool selection — multi-select of Spaces in 2D view
    const [slabSelectedSpaces, setSlabSelectedSpaces] = useState<string[]>([]);
    const [slabThicknessInput, setSlabThicknessInput] = useState("0.2");
    const [slabLevelId, setSlabLevelId] = useState<string | undefined>(undefined);
    const [slabElevationOffsetInput, setSlabElevationOffsetInput] = useState("0");
    // Slab manual sketch mode (spec §3.1) — click a polyline and close it
    const [slabSketching, setSlabSketching] = useState(false);
    const [slabSketchPoints, setSlabSketchPoints] = useState<Vec3[]>([]);
    const [slabSketchHover, setSlabSketchHover] = useState<Vec3 | null>(null);
    const [slabSnap, setSlabSnap] = useState<{ kind: "Column" | "BeamEndpoint" | "WallEndpoint" | "WallAxis" | "GridIntersection" | "Grid" | "ResidentialGrid" | null }>({ kind: null });
    // Beam tool (spec §5) — 2-point sketch, chain mode
    const [beamStart, setBeamStart] = useState<Vec3 | null>(null);
    const [beamHover, setBeamHover] = useState<Vec3 | null>(null);
    const [beamChainMode, setBeamChainMode] = useState(true);
    const [beamWidthInput, setBeamWidthInput] = useState("0.3");
    const [beamDepthInput, setBeamDepthInput] = useState("0.6");
    const [beamTopOffsetInput, setBeamTopOffsetInput] = useState("0");
    const [beamLevelId, setBeamLevelId] = useState<string | undefined>(undefined);
    const [beamZJust, setBeamZJust] = useState<"Top" | "Center" | "Bottom">("Top");
    const [beamSnap, setBeamSnap] = useState<{ kind: "Column" | "Grid" | "GridIntersection" | "BeamEndpoint" | "WallEndpoint" | "WallAxis" | "ResidentialGrid" | null }>({ kind: null });
    // Column tool (spec §5)
    const [columnHover, setColumnHover] = useState<Vec3 | null>(null);
    const [columnSnap, setColumnSnap] = useState<{ kind: string | null }>({ kind: null });
    const [columnProfileKind, setColumnProfileKind] = useState<"Rectangle" | "Circle">("Rectangle");
    const [columnWidthInput, setColumnWidthInput] = useState("0.4");
    const [columnDepthInput, setColumnDepthInput] = useState("0.4");
    const [columnRadiusInput, setColumnRadiusInput] = useState("0.25");
    const [columnRotationInput, setColumnRotationInput] = useState("0");
    const [columnBaseLevelId, setColumnBaseLevelId] = useState<string | undefined>(undefined);
    const [columnTopLevelId, setColumnTopLevelId] = useState<string | undefined>(undefined);
    const [columnBaseOffsetInput, setColumnBaseOffsetInput] = useState("0");
    const [columnTopOffsetInput, setColumnTopOffsetInput] = useState("0");
    const [columnChainMode, setColumnChainMode] = useState(true);

    // Expose camera/canvas to parent
    useImperativeHandle(ref, () => ({
        getCamera: () => cameraRef.current,
        getCanvas: () => canvasRef.current,
    }));

    // Preload planegcs WASM so the first constraint solve isn't delayed.
    useEffect(() => {
        GcsBackend.ensureInitialized().catch((e) => {
            // eslint-disable-next-line no-console
            console.warn("[GcsBackend] preload failed:", e);
        });
    }, []);

    // ── Type → 入力欄の同期 ─────────────────────────────────────
    //
    // ユーザがツールバーで ColumnType / BeamType / SlabType を切り替えたら、
    // 寸法入力欄を Type デフォルト寸法へ追従させる。これをやらないと入力欄が
    // 古い数値のままで、Create 時に override として上書きされ「Type 名と
    // 寸法が食い違う」現象になる。同期後にユーザが入力欄を編集すれば、
    // その編集値が override として優先される。
    const activeColumnTypeId = useAppState((s: AppState) => s.activeTypeIdByCategory.Column);
    const activeBeamTypeId = useAppState((s: AppState) => s.activeTypeIdByCategory.Beam);
    const activeSlabTypeId = useAppState((s: AppState) => s.activeTypeIdByCategory.Slab);
    const typesMap = useAppState((s: AppState) => s.types);

    useEffect(() => {
        if (!activeColumnTypeId) return;
        const t = typesMap[activeColumnTypeId];
        if (!t || t.kind !== "ColumnType") return;
        if (t.profile.kind === "Rectangle") {
            setColumnProfileKind("Rectangle");
            setColumnWidthInput(String(t.profile.width));
            setColumnDepthInput(String(t.profile.depth));
        } else if (t.profile.kind === "Circle") {
            setColumnProfileKind("Circle");
            setColumnRadiusInput(String(t.profile.radius));
        }
    }, [activeColumnTypeId, typesMap]);

    useEffect(() => {
        if (!activeBeamTypeId) return;
        const t = typesMap[activeBeamTypeId];
        if (!t || t.kind !== "BeamType") return;
        if (t.profile.kind === "Rectangle") {
            setBeamWidthInput(String(t.profile.width));
            setBeamDepthInput(String(t.profile.depth));
        }
    }, [activeBeamTypeId, typesMap]);

    useEffect(() => {
        if (!activeSlabTypeId) return;
        const t = typesMap[activeSlabTypeId];
        if (!t || t.kind !== "SlabType") return;
        setSlabThicknessInput(String(t.thickness));
    }, [activeSlabTypeId, typesMap]);

    useEffect(() => {
        if (!canvasRef.current) return;

        const gpu = new GPUDeviceManager();
        const scene = new RenderScene();
        sceneRef.current = scene;

        const persp = new PerspectiveCamera();
        vec3.set(persp.position as any, 10, 10, 10);
        vec3.set(persp.target as any, 0, 0, 0);
        persp.update();
        perspCamRef.current = persp;

        const ortho = new OrthographicCamera(10);
        vec3.set(ortho.position as any, 0, 20, 0);
        vec3.set(ortho.target as any, 0, 0, 0);
        vec3.set(ortho.up as any, 0, 0, -1);
        ortho.update();
        orthoCamRef.current = ortho;

        cameraRef.current = persp;

        const renderer = new Renderer(gpu, scene, persp);
        rendererRef.current = renderer;
        const controller = new CameraController(persp, canvasRef.current);
        controllerRef.current = controller;

        let frameId = 0;
        let initialized = false;

        const init = async () => {
            const success = await renderer.init(canvasRef.current!);
            if (!success) {
                console.error("Failed to initialize WebGPU renderer");
                return;
            }
            initialized = true;

            let lastReportedZoom = orthoCamRef.current.zoom;
            const renderLoop = () => {
                renderer.render();
                const z = orthoCamRef.current?.zoom;
                if (z && Math.abs(z - lastReportedZoom) / lastReportedZoom > 0.02) {
                    lastReportedZoom = z;
                    setOrthoZoom(z);
                }
                frameId = requestAnimationFrame(renderLoop);
            };
            renderLoop();
        };

        init();

        const handleResize = () => {
            if (!canvasRef.current) return;
            const width = canvasRef.current.clientWidth;
            const height = canvasRef.current.clientHeight;
            canvasRef.current.width = width;
            canvasRef.current.height = height;

            perspCamRef.current.aspect = width / height;
            perspCamRef.current.update();

            orthoCamRef.current.aspect = width / height;
            orthoCamRef.current.update();

            if (initialized) {
                rendererRef.current.resize(width, height);
            }
        };

        window.addEventListener("resize", handleResize);
        handleResize();

        return () => {
            window.removeEventListener("resize", handleResize);
            if (controllerRef.current) controllerRef.current.detachEvents();
            cancelAnimationFrame(frameId);
        };
    }, []);

    // ビュー切替はユーザの 2D/3D トグル (= viewMode) が主。Room mode は
    // 作図中心なので強制的に 2D へ寄せる (3D で sketch overlay を出すと
    // 視差で snap が極めて使いにくい)。
    const viewMode = useAppState((s) => s.viewMode);
    const useOrtho =
        viewMode === "2D" ||
        activeRoomId !== null ||
        pendingRoomLevelId !== null;

    // Entering wall "select" sub-mode aborts any in-flight wall drawing —
    // the user has signalled they want to pick, not place.
    useEffect(() => {
        if (activeTool === "wall" && wallSubMode === "select") {
            setWallStart(null);
            setWallEnd(null);
            setWallSnap(null);
            setWallStartSource(null);
        }
        if (activeTool !== "wall") {
            setWallStartSource(null);
        }
        if (activeTool !== "wall" || wallSubMode !== "select") {
            setWallSketchHoverKind(null);
        }
    }, [activeTool, wallSubMode]);

    // Reset draft when leaving gridline tool
    useEffect(() => {
        if (activeTool !== "gridline") {
            setGridStart(null);
            setGridHover(null);
            setGridSnap(null);
            setGridAngleSnap(null);
            setGridAxisSnap(null);
            setGridlineDrafting(false);
            setGridDraftPoints([]);
            setShowArrayPanel(false);
            setSelectedGridIds([]);
        }
        if (activeTool !== "door" && activeTool !== "window") {
            setOpeningHover(null);
        }
        if (activeTool !== "slab") {
            setSlabSelectedSpaces([]);
            setSlabSketching(false);
            setSlabSketchPoints([]);
            setSlabSketchHover(null);
            setSlabSnap({ kind: null });
        } else {
            // 床ツールに入った時、基準レベルを activeLevel で初期化。
            if (!slabLevelId && activeLevelId) setSlabLevelId(activeLevelId as string);
        }
        if (activeTool !== "beam") {
            setBeamStart(null);
            setBeamHover(null);
            setBeamSnap({ kind: null });
        } else {
            // 梁ツールに入った時、基本レベルを activeLevel で初期化。
            if (!beamLevelId && activeLevelId) setBeamLevelId(activeLevelId as string);
        }
        if (activeTool !== "column") {
            setColumnHover(null);
            setColumnSnap({ kind: null });
        } else {
            // Initialize base/top levels when entering the tool (spec §5)
            if (!columnBaseLevelId && activeLevelId) setColumnBaseLevelId(activeLevelId as string);
            if (!columnTopLevelId && activeLevelId) {
                const sorted = [...levels].sort((a, b) => a.elevation - b.elevation);
                const idx = sorted.findIndex((l) => l.id === activeLevelId);
                const next = idx >= 0 && idx + 1 < sorted.length ? sorted[idx + 1] : sorted[idx];
                setColumnTopLevelId(next?.id as string);
                // If there is no higher level available, default the top offset
                // to a 3 m column height so the preview is visible immediately.
                if (!(idx >= 0 && idx + 1 < sorted.length)) {
                    setColumnTopOffsetInput("3");
                }
            }
        }
    }, [activeTool, setGridlineDrafting, setSelectedGridIds]);

    const commitSlabSketch = React.useCallback(() => {
        if (slabSketchPoints.length < 3) {
            setSlabSketchPoints([]);
            setSlabSketchHover(null);
            setSlabSketching(false);
            return;
        }
        const thickness = parseFloat(slabThicknessInput);
        const t = Number.isFinite(thickness) && thickness > 0 ? thickness : 0.2;
        const elev = parseFloat(slabElevationOffsetInput);
        const e = Number.isFinite(elev) ? elev : 0;
        const boundary = slabSketchPoints.map<[number, number]>((p) => [p[0], p[2]]);
        // Type 体系: アクティブな SlabType を使用、ユーザ入力 thickness は
        // override として上書き (= Type デフォルト寸法と独立に厚みを変えられる)。
        const slabTypeId = useAppState.getState().activeTypeIdByCategory.Slab;
        if (!slabTypeId) {
            console.warn("[slab] no active SlabType — skipping creation");
            return;
        }
        executeCommand(new CreateSlabCommand(
            boundary, slabTypeId as any, e, [],
            (slabLevelId ?? activeLevelId ?? undefined) as any,
            undefined,
            { thickness: t },
        ));
        setSlabSketchPoints([]);
        setSlabSketchHover(null);
        setSlabSketching(false);
    }, [slabSketchPoints, slabThicknessInput, slabElevationOffsetInput, slabLevelId, executeCommand, activeLevelId]);

    // Enter key commits the slab sketch polyline
    useEffect(() => {
        if (activeTool !== "slab" || !slabSketching) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Enter") {
                e.preventDefault();
                commitSlabSketch();
            }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [activeTool, slabSketching, commitSlabSketch]);

    // Delete key: remove selected grids while in gridline tool
    useEffect(() => {
        if (activeTool !== "gridline") return;
        const onKey = (e: KeyboardEvent) => {
            if ((e.key === "Delete" || e.key === "Backspace") && selectedGridIds.length > 0 && !gridlineDrafting) {
                e.preventDefault();
                removeGrids(selectedGridIds);
            }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [activeTool, selectedGridIds, gridlineDrafting, removeGrids]);

    const exitGridDrafting = React.useCallback(() => {
        setGridStart(null);
        setGridHover(null);
        setGridSnap(null);
        setGridAngleSnap(null);
        setGridAxisSnap(null);
        setGridDraftPoints([]);
        setGridlineDrafting(false);
    }, [setGridlineDrafting]);

    // Enter finalizes the polyline draft (if any) or exits line drafting.
    // Esc still bubbles up to CadShell / useEffect cleanup.
    useEffect(() => {
        if (activeTool !== "gridline") return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Enter") {
                e.preventDefault();
                if (gridDraftMode === "polyline" && gridDraftPoints.length >= 2) {
                    addGridPolyline(gridDraftPoints, gridKind);
                    setGridDraftPoints([]);
                    setGridHover(null);
                    setGridSnap(null);
                    setGridAxisSnap(null);
                    setGridAngleSnap(null);
                } else {
                    exitGridDrafting();
                }
            }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [activeTool, exitGridDrafting, gridDraftMode, gridDraftPoints, addGridPolyline, gridKind]);

    useEffect(() => {
        if (!cameraRef.current || !rendererRef.current || !controllerRef.current) return;

        if (useOrtho) {
            cameraRef.current = orthoCamRef.current;
            const pt = perspCamRef.current.target;
            const ortho = orthoCamRef.current;
            vec3.set(ortho.target as any, pt[0], 0, pt[2]);
            vec3.set(ortho.position as any, pt[0], 20, pt[2]);
            vec3.set(ortho.up as any, 0, 0, -1);
            ortho.update();
        } else {
            cameraRef.current = perspCamRef.current;
            // Restore perspective camera: look at ortho target (Y=0) from above-right
            const tx = orthoCamRef.current.target[0];
            const tz = orthoCamRef.current.target[2];
            const persp = perspCamRef.current;
            vec3.set(persp.target as any, tx, 0, tz);
            vec3.set(persp.position as any, tx + 10, 10, tz + 10);
            vec3.set(persp.up as any, 0, 1, 0);
            persp.update();
            setWallStart(null);
            setWallEnd(null);
            setWallSnap(null);
        }

        rendererRef.current.setCamera(cameraRef.current);
        controllerRef.current.setCamera(cameraRef.current);

    }, [useOrtho]);

    // Sync elements to scene — 3D only (2D is handled by SVG overlay)
    useEffect(() => {
        const scene = sceneRef.current;
        if (!scene) return;

        for (const o of scene.getObjects()) {
            scene.removeObject(o.id);
        }

        const inRoomMode = activeRoomId !== null || pendingRoomLevelId !== null;

        // Collect all walls for join resolution
        const allWalls: WallElement[] = [];
        for (const id in elements) {
            if (elements[id].type === "Wall") {
                allWalls.push(elements[id] as WallElement);
            }
        }

        // Resolve wall-wall joins (also applied in 2D wall-tool mode so
        // corner mitres line up the footprint quads drawn on the ground).
        let joinMap = new Map<string, WallJoinResult[]>();
        if (!inRoomMode && allWalls.length > 1) {
            try {
                joinMap = WallJoinResolver.resolve(allWalls);
            } catch (e) {
                console.warn("WallJoinResolver failed:", e);
            }
        }

        // 単体壁 (= 部屋から派生していない壁) の交差処理。各壁を
        // 退化 2 頂点ポリゴンに包み、部屋壁と全く同じ JunctionGraph
        // パイプライン (buildJunctionGraph → resolveJunctions → applyCaps)
        // を通して、L / T / X 接合を統一的に解決する。
        const standaloneFootprints = new Map<string, Vec2[]>();
        if (!inRoomMode) {
            const standaloneWalls = allWalls.filter((w) => !w.polyRef);
            if (standaloneWalls.length > 0) {
                const synthPolys: RoomPolygon[] = standaloneWalls.map((w) => ({
                    id: `synth-${w.id}`,
                    outer: [
                        [w.axis[0][0], w.axis[0][2]] as Vec2,
                        [w.axis[1][0], w.axis[1][2]] as Vec2,
                    ],
                    // 明示的に 1 エッジのみ。これで JunctionGraph は forward
                    // 方向の仮想エッジ 1 本しか生成せず、L 字交差点では
                    // 2 incident になり cross-poly miter が効く。
                    edges: [[0, 1]],
                    holes: [],
                    wallThickness: w.thickness,
                    wallReference: "Center",
                    innerThickness: w.thickness / 2,
                    outerThickness: w.thickness / 2,
                }));
                try {
                    const jgraph = buildJunctionGraph(synthPolys);
                    resolveJunctions(jgraph, synthPolys);
                    applyCaps(jgraph, synthPolys);
                    for (let i = 0; i < standaloneWalls.length; i++) {
                        const poly = synthPolys[i];
                        const veIds = jgraph.edgeToVes.get(`${poly.id}:0`);
                        if (!veIds || veIds.length === 0) continue;
                        const ve = jgraph.virtualEdges.get(veIds[0]);
                        if (!ve) continue;
                        const fp = virtualEdgeFootprint(ve);
                        if (fp) {
                            standaloneFootprints.set(
                                standaloneWalls[i].id as string,
                                fp,
                            );
                        }
                    }
                } catch (e) {
                    console.warn("Standalone wall JunctionGraph failed:", e);
                }
            }
        }

        // Helper: collect WallOpeningInfo for a given wall, including any in-flight preview
        const collectOpenings = (w: WallElement): WallOpeningInfo[] => {
            const result: WallOpeningInfo[] = [];
            const axisLen = Math.hypot(w.axis[1][0] - w.axis[0][0], w.axis[1][2] - w.axis[0][2]);
            if (axisLen < 1e-6) return result;
            for (const oid of w.openings ?? []) {
                const op = elements[oid] as OpeningElement | undefined;
                if (!op || op.type !== "Opening") continue;
                const halfT = op.width / 2 / axisLen;
                result.push({
                    startT: op.position - halfT,
                    endT: op.position + halfT,
                    sillHeight: op.sillHeight,
                    height: op.height,
                });
            }
            // Add hover preview if it's on this wall
            if (openingHover && openingHover.wallId === (w.id as string)) {
                const def = activeTool === "door" ? doorDefaults : windowDefaults;
                const halfT = def.width / 2 / axisLen;
                result.push({
                    startT: openingHover.position - halfT,
                    endT: openingHover.position + halfT,
                    sillHeight: def.sillHeight,
                    height: def.height,
                });
            }
            return result;
        };

        // Level lookup for elevation → Y translate. Walls store only a
        // levelId (not the absolute elevation) so at render time we resolve
        // it here; keeps creation code unit-free.
        const levelElevationFor = (levelId: string | undefined): number => {
            if (!levelId) return 0;
            const lvl = levels.find((l) => (l.id as string) === (levelId as string));
            return lvl?.elevation ?? 0;
        };
        const wallYTransform = (el: WallElement): mat4 => {
            const m = mat4.create();
            const elev = levelElevationFor(el.baseLevelId as string | undefined);
            if (elev !== 0) mat4.translate(m, m, [0, elev, 0]);
            return m;
        };

        // 同一レベルに置かれた柱の 2D フットプリントをレベル ID 単位で
        // 集約。`WallGeometryBuilder.build` に渡し、壁矩形を Clipper diff で
        // 切り抜く (= 柱を優先)。レベル ID なしの柱は空文字列キーで束ね、
        // 同じくレベル ID なしの壁にだけ作用させる。
        const columnsByLevel = new Map<string, ColumnFootprint[]>();
        for (const cid in elements) {
            const ce = elements[cid];
            if (!ce || ce.type !== "Column") continue;
            const col = ce as ColumnElement;
            const fp = columnFootprint2D(col);
            if (fp.length < 3) continue;
            const key = (col.baseLevelId as string | undefined) ?? "";
            let arr = columnsByLevel.get(key);
            if (!arr) { arr = []; columnsByLevel.set(key, arr); }
            arr.push({ id: col.id as string, points: ensureCCW(fp) });
        }
        const columnsForWall = (w: WallElement): ColumnFootprint[] | undefined => {
            const key = (w.baseLevelId as string | undefined) ?? "";
            return columnsByLevel.get(key);
        };

        for (const id in elements) {
            const el = elements[id] as WallElement;
            if (el.type === "Wall") {
                // In room mode, walls are rendered by SVG overlay
                if (inRoomMode) continue;

                if (activeTool === "wall") {
                    // 2D plan view: render the wall as a flat rectangle using
                    // the mitered footprint corners so adjacent walls meet
                    // without a gap at the join. 柱クリップは 3D path のみ。
                    const joins = joinMap.get(el.id as string);
                    const [c0, c1, c2, c3] = WallGeometryBuilder.build(el, joins).footprint;
                    const Y = 0.02;
                    const positions = new Float32Array([
                        c0[0], Y, c0[2],
                        c1[0], Y, c1[2],
                        c2[0], Y, c2[2],
                        c3[0], Y, c3[2],
                    ]);
                    const normals = new Float32Array([
                        0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0,
                    ]);
                    const indices = new Uint32Array([0, 1, 2, 0, 2, 3]);
                    const xs = [c0[0], c1[0], c2[0], c3[0]];
                    const zs = [c0[2], c1[2], c2[2], c3[2]];
                    const meshData: MeshData = {
                        positions, normals, indices,
                        bounds: {
                            min: [Math.min(...xs), 0, Math.min(...zs)],
                            max: [Math.max(...xs), 0, Math.max(...zs)],
                        },
                        topology: "triangle-list",
                    };
                    const isSelected = selection.includes(el.id as string);
                    // Match RoomSketchOverlay's C_WALL_SLAB so walls look
                    // identical in wall-tool and room-edit modes.
                    scene.addObject({
                        id: el.id,
                        mesh: meshData,
                        transform: wallYTransform(el),
                        visible: true,
                        color: isSelected ? [1.0, 0.4, 0.0, 1.0] : [140 / 255, 140 / 255, 145 / 255, 0.85],
                    });
                } else {
                    // 3D Geometry: hex footprint when wall has polyRef AND
                    // no openings (hex prism with openings は未対応)。それ
                    // 以外は従来の 4 隅 rect path + WallJoinResolver。
                    const wallOpenings = collectOpenings(el);
                    if ((window as any).__wallOpeningsDebug) {
                        // eslint-disable-next-line no-console
                        console.log(
                            `[wallMesh] ${(el.id as string).slice(0, 6)} ` +
                            `openings=${wallOpenings.length} ` +
                            `el.openings=[${(el.openings ?? []).map((id) => (id as string).slice(0, 6)).join(",")}] ` +
                            `fpLen=${el.footprint?.length ?? "none"}`,
                        );
                    }
                    const usesHex = !!el.polyRef && wallOpenings.length === 0;
                    let parentPolygon: SpaceElement["polygons"][number] | undefined;
                    if (usesHex && el.polyRef) {
                        const sp = elements[el.polyRef.spaceId] as SpaceElement | undefined;
                        if (sp && sp.type === "Space") {
                            parentPolygon = sp.polygons?.find((p) => p.id === el.polyRef!.polyId);
                        }
                    }
                    // 3+ 接続交差で他ポリゴンの incident edge を引く lookup。
                    const polygonLookup = (polyId: string) => {
                        for (const eid in elements) {
                            const ee = elements[eid];
                            if (!ee || ee.type !== "Space") continue;
                            const sp = ee as SpaceElement;
                            const found = sp.polygons?.find((p) => p.id === polyId);
                            if (found) return found;
                        }
                        return undefined;
                    };
                    // joinMap は hex 経路では使わない (hex 自体がコーナー解決済み)。
                    const joins = usesHex && parentPolygon ? undefined : joinMap.get(el.id as string);
                    // 単体壁向けに合成したフットプリント (= 部屋壁と同じ
                    // JunctionGraph 経路で解決された 4 隅) があれば
                    // wall.footprint を一時的に上書きして WallGeometryBuilder に渡す。
                    // openings を持つ壁は legacy rect path を保つため適用しない。
                    const synthFp = standaloneFootprints.get(el.id as string);
                    const elForBuild = (synthFp && wallOpenings.length === 0)
                        ? { ...el, footprint: synthFp }
                        : el;
                    // wallOpenings は hover preview を含むので、wall.openings
                    // ではなくこちらの長さを WallGeometryBuilder に渡す。
                    // これで preview 段階でも legacy rect path に分岐し、
                    // opening 切り欠きが描画される。
                    const geomData = WallGeometryBuilder.build(
                        elForBuild, joins, parentPolygon, polygonLookup,
                        wallOpenings.length,
                        columnsForWall(el),
                    );
                    const hasStartJoin = joins?.some((j: WallJoinResult) => j.at === "Start");
                    const hasEndJoin = joins?.some((j: WallJoinResult) => j.at === "End");
                    const meshData = WallMeshBuilder.build(geomData, {
                        joinedStart: hasStartJoin,
                        joinedEnd:   hasEndJoin,
                    }, wallOpenings);
                    const isSelected = selection.includes(el.id as string);
                    const wallElev = levelElevationFor(el.baseLevelId as string | undefined);

                    // 親ポリゴンが circle (= 円筒壁) なら、フラグメントシェーダで
                    // 位置由来の放射方向を法線として使うヒントを渡す。これで
                    // 24-segment ポリゴンプリズムでも本物の円筒として滑らかに
                    // 陰影が乗り、chord facet (多角形ファセット) や対角補間
                    // アーティファクトが視覚的に完全に消える。
                    let cylinderCenter: [number, number, number] | undefined;
                    if (parentPolygon?.shape?.type === "circle") {
                        const wallElev2 = levelElevationFor(el.baseLevelId as string | undefined);
                        cylinderCenter = [
                            parentPolygon.shape.center[0],
                            wallElev2,
                            parentPolygon.shape.center[1],
                        ];
                    }
                    scene.addObject({
                        id: el.id,
                        mesh: meshData,
                        transform: wallYTransform(el),
                        visible: true,
                        color: isSelected ? [1.0, 0.4, 0.0, 1.0] : [0.88, 0.88, 0.9, 1.0],
                        //color: isSelected ? [1.0, 0.4, 0.0, 1.0] : [0.88, 0.88, 0.9, 1.0],
                        //color: isSelected ? [1.0, 0.4, 0.0, 1.0] : [0.45, 0.45, 0.5, 1.0],
                        cylinderCenter,
                    });

                }
            }
        }

        // Wall / select tool: render every Space's polygons using the same
        // look as room-edit mode (subtle interior fill + thin outline edges).
        // Lets the user read the room layout while drawing walls / picking
        // sketch lines. In select mode, the edges double as selectable "作図
        // 線" that drive cross-room constraints.
        if ((activeTool === "wall" || activeTool === "select") && !inRoomMode) {
            const REF_LINE_PX = 1.2;
            const canvasH = canvasRef.current?.clientHeight ?? 800;
            const pxToWorld = useOrtho ? (2 * orthoZoom / canvasH) : 0.015;
            const refThickness = useOrtho ? REF_LINE_PX * pxToWorld : 0.02;
            // Mirror RoomSketchOverlay's C_RECT / C_RECT_FILL for parity.
            const innerStroke: [number, number, number, number] = [59 / 255, 130 / 255, 246 / 255, 0.9];
            const innerFill: [number, number, number, number] = [59 / 255, 130 / 255, 246 / 255, 0.06];
            const outlineStroke: [number, number, number, number] = [100 / 255, 116 / 255, 139 / 255, 0.9];
            const selColor: [number, number, number, number] = [249 / 255, 115 / 255, 22 / 255, 1.0];
            const selEdgeIdx = new Set<string>();
            const selVertIdx = new Set<string>();
            const selWallAxis = new Set<string>();
            const selWallPoint = new Set<string>(); // key: `${wallId}:${endIdx}`
            for (const s of sketchSelection) {
                if (s.kind === "edge") selEdgeIdx.add(`${s.spaceId}:${s.polyId}:${s.edgeIdx}`);
                else if (s.kind === "point") selVertIdx.add(`${s.spaceId}:${s.polyId}:${s.vertexIdx}`);
                else if (s.kind === "wallAxis") selWallAxis.add(s.wallId as string);
                else if (s.kind === "wallPoint") selWallPoint.add(`${s.wallId}:${s.endIdx}`);
            }
            // Sketch edges and vertex markers render in the overlay pass —
            // no depth test/write, alpha-blended over the rest of the scene
            // — so they stay visible regardless of wall height or render
            // order. Y values here only determine bounds for culling.
            for (const id in elements) {
                const el = elements[id];
                if (!el || el.type !== "Space") continue;
                const space = el as SpaceElement;
                for (const poly of space.polygons ?? []) {
                    const isOutline = !!poly.wallOutlineOf;
                    // Interior fill (skip outline polygons — they're drawn by
                    // their inner's slab rendering above + edge strokes here).
                    // Y-layering for top-down ortho view (Y up = toward cam):
                    //   fill   Y=0.005 (below walls and edges)
                    //   walls  Y=0.02
                    //   edges  Y=0.03 (always on top, even over wall slabs)
                    if (!isOutline && isPolygonClosed(poly)) {
                        const fillMesh = buildSpaceFillMesh(
                            poly.outer,
                            poly.holes ?? [],
                            0.005,
                        );
                        if (fillMesh) {
                            scene.addObject({
                                id: `room-ref-fill-${id}-${poly.id}`,
                                mesh: fillMesh,
                                transform: mat4.create(),
                                visible: true,
                                color: innerFill,
                            });
                        }
                    }
                    const strokeColor = isOutline ? outlineStroke : innerStroke;
                    const edges = polygonEdges(poly);
                    for (let i = 0; i < edges.length; i++) {
                        const [ai, bi] = edges[i];
                        const a = poly.outer[ai];
                        const b = poly.outer[bi];
                        const isEdgeSel = selEdgeIdx.has(`${id}:${poly.id}:${i}`);
                        scene.addObject({
                            id: `room-ref-${id}-${poly.id}-${i}`,
                            mesh: LineMeshBuilder.build(
                                [[a[0], 0, a[1]], [b[0], 0, b[1]]],
                                {
                                    thickness: isEdgeSel ? refThickness * 2.5 : refThickness,
                                    jointSize: 0,
                                },
                            ),
                            transform: mat4.create(),
                            visible: true,
                            color: isEdgeSel ? selColor : strokeColor,
                            overlay: true,
                        });
                    }
                    // Selected vertex markers — small filled squares. Render
                    // in the overlay pass so they're never occluded.
                    if (poly.shape?.type !== "circle") {
                        const markerHalf = 4 * pxToWorld;
                        for (let i = 0; i < poly.outer.length; i++) {
                            if (!selVertIdx.has(`${id}:${poly.id}:${i}`)) continue;
                            const [vx, vz] = poly.outer[i];
                            const positions = new Float32Array([
                                vx - markerHalf, 0.02, vz - markerHalf,
                                vx + markerHalf, 0.02, vz - markerHalf,
                                vx + markerHalf, 0.02, vz + markerHalf,
                                vx - markerHalf, 0.02, vz + markerHalf,
                            ]);
                            const normals = new Float32Array([0,1,0, 0,1,0, 0,1,0, 0,1,0]);
                            const indices = new Uint32Array([0, 1, 2, 0, 2, 3]);
                            scene.addObject({
                                id: `room-ref-vsel-${id}-${poly.id}-${i}`,
                                mesh: {
                                    positions, normals, indices,
                                    bounds: {
                                        min: [vx - markerHalf, 0.02, vz - markerHalf],
                                        max: [vx + markerHalf, 0.02, vz + markerHalf],
                                    },
                                    topology: "triangle-list",
                                },
                                transform: mat4.create(),
                                visible: true,
                                color: selColor,
                                overlay: true,
                            });
                        }
                    }
                }
            }

            // Standalone walls (drawn in wall mode, not attached to a room
            // polygon) get a sketch line rendered along their centerline so
            // the axis is visible as a "作図線" inside the wall slab. Walls
            // generated from a room polygon already expose their inner edge
            // as the room sketch line — don't draw a duplicate centerline
            // for those.
            const roomLinkedWallIds = new Set<string>();
            for (const id in elements) {
                const el = elements[id];
                if (!el || el.type !== "Space") continue;
                for (const poly of (el as SpaceElement).polygons ?? []) {
                    for (const wid of poly.wallIds ?? []) {
                        if (wid) roomLinkedWallIds.add(wid);
                    }
                }
            }
            for (const id in elements) {
                const el = elements[id];
                if (!el || el.type !== "Wall") continue;
                if (roomLinkedWallIds.has(id)) continue;
                const w = el as WallElement;
                const isSel = selWallAxis.has(id);
                scene.addObject({
                    id: `wall-axis-${id}`,
                    mesh: LineMeshBuilder.build(
                        [[w.axis[0][0], 0, w.axis[0][2]], [w.axis[1][0], 0, w.axis[1][2]]],
                        {
                            thickness: isSel ? refThickness * 2.5 : refThickness,
                            jointSize: 0,
                        },
                    ),
                    transform: mat4.create(),
                    visible: true,
                    color: isSel ? selColor : innerStroke,
                    overlay: true,
                });
                // Selected wall-endpoint markers (orange filled square) so
                // the user gets the same visual feedback as a polygon vertex.
                const markerHalf = 4 * pxToWorld;
                for (let i = 0; i < 2; i++) {
                    if (!selWallPoint.has(`${id}:${i}`)) continue;
                    const [vx, , vz] = w.axis[i];
                    const positions = new Float32Array([
                        vx - markerHalf, 0, vz - markerHalf,
                        vx + markerHalf, 0, vz - markerHalf,
                        vx + markerHalf, 0, vz + markerHalf,
                        vx - markerHalf, 0, vz + markerHalf,
                    ]);
                    const normals = new Float32Array([0,1,0, 0,1,0, 0,1,0, 0,1,0]);
                    const indices = new Uint32Array([0, 1, 2, 0, 2, 3]);
                    scene.addObject({
                        id: `wall-point-sel-${id}-${i}`,
                        mesh: {
                            positions, normals, indices,
                            bounds: {
                                min: [vx - markerHalf, 0, vz - markerHalf],
                                max: [vx + markerHalf, 0, vz + markerHalf],
                            },
                            topology: "triangle-list",
                        },
                        transform: mat4.create(),
                        visible: true,
                        color: selColor,
                        overlay: true,
                    });
                }
            }
        }

        // Slab manual sketch preview (per spec §3.1) — solid polyline for
        // committed points + dashed line from last point to cursor.
        if (activeTool === "slab" && slabSketching && slabSketchPoints.length > 0) {
            const slabSketchColor: [number, number, number, number] = [0.95, 0.55, 0.1, 1.0];
            if (slabSketchPoints.length >= 2) {
                scene.addObject({
                    id: "slab-sketch-solid",
                    mesh: LineMeshBuilder.build(slabSketchPoints),
                    transform: mat4.create(),
                    visible: true,
                    color: slabSketchColor,
                });
            } else {
                // Single point marker
                const p = slabSketchPoints[0];
                scene.addObject({
                    id: "slab-sketch-start",
                    mesh: LineMeshBuilder.build([[p[0] - 0.1, 0, p[2]], [p[0] + 0.1, 0, p[2]]]),
                    transform: mat4.create(),
                    visible: true,
                    color: slabSketchColor,
                });
            }
            if (slabSketchHover) {
                const last = slabSketchPoints[slabSketchPoints.length - 1];
                const dx = slabSketchHover[0] - last[0];
                const dz = slabSketchHover[2] - last[2];
                const len = Math.hypot(dx, dz);
                if (len > 1e-6) {
                    const dashLen = 0.3;
                    const gapLen = 0.2;
                    const stride = dashLen + gapLen;
                    const ux = dx / len;
                    const uz = dz / len;
                    let t = 0;
                    let dashIdx = 0;
                    while (t < len) {
                        const tEnd = Math.min(t + dashLen, len);
                        const a: Vec3 = [last[0] + ux * t, 0, last[2] + uz * t];
                        const b: Vec3 = [last[0] + ux * tEnd, 0, last[2] + uz * tEnd];
                        scene.addObject({
                            id: `slab-sketch-dash-${dashIdx}`,
                            mesh: LineMeshBuilder.build([a, b]),
                            transform: mat4.create(),
                            visible: true,
                            color: slabSketchColor,
                        });
                        t += stride;
                        dashIdx++;
                    }
                    // Also draw a closing dashed line back to the first point as a hint
                    if (slabSketchPoints.length >= 3) {
                        const first = slabSketchPoints[0];
                        const cdx = first[0] - slabSketchHover[0];
                        const cdz = first[2] - slabSketchHover[2];
                        const clen = Math.hypot(cdx, cdz);
                        if (clen > 1e-6) {
                            const cux = cdx / clen;
                            const cuz = cdz / clen;
                            let ct = 0;
                            let cIdx = 0;
                            while (ct < clen) {
                                const ctEnd = Math.min(ct + dashLen, clen);
                                const a: Vec3 = [slabSketchHover[0] + cux * ct, 0, slabSketchHover[2] + cuz * ct];
                                const b: Vec3 = [slabSketchHover[0] + cux * ctEnd, 0, slabSketchHover[2] + cuz * ctEnd];
                                scene.addObject({
                                    id: `slab-sketch-close-${cIdx}`,
                                    mesh: LineMeshBuilder.build([a, b]),
                                    transform: mat4.create(),
                                    visible: true,
                                    color: [0.95, 0.8, 0.3, 0.7],
                                });
                                ct += stride;
                                cIdx++;
                            }
                        }
                    }
                }
            }
        }

        // Slab tool: render every Space as a flat filled highlight so users
        // can see and pick room shapes in the 2D view.
        if (activeTool === "slab" && !inRoomMode) {
            for (const id in elements) {
                const el = elements[id];
                if (!el || el.type !== "Space") continue;
                const space = el as SpaceElement;
                const profiles = collectSpaceProfiles(space);
                if (profiles.length === 0) continue;
                const isSelected = slabSelectedSpaces.includes(id);
                profiles.forEach((profile, pi) => {
                    const mesh = buildSpaceFillMesh(
                        profile.outer as unknown as [number, number][],
                        profile.holes as unknown as [number, number][][],
                        0.02,
                    );
                    if (!mesh) return;
                    scene.addObject({
                        id: `space-fill-${id}-${pi}`,
                        mesh,
                        transform: mat4.create(),
                        visible: true,
                        color: isSelected ? [0.25, 0.75, 1.0, 0.85] : [0.5, 0.8, 1.0, 0.55],
                    });
                });
            }
        }

        // Columns — render as solid extruded profiles (spec §3).
        // 部屋モード中も既存柱は描画する (壁との接合関係を見ながらスケッチ
        // できるように)。柱の作成プレビューは別 if で gated。
        // sketchSelection に column kind があればハイライト (= 拘束選択用)。
        const sketchSelectedColumnIds = new Set<string>();
        const sketchSelectedGridLineIds = new Set<string>();
        for (const s of sketchSelection) {
            if (s.kind === "column") sketchSelectedColumnIds.add(s.columnId as string);
            else if (s.kind === "gridLine") sketchSelectedGridLineIds.add(s.gridId);
        }
        for (const id in elements) {
            const el = elements[id];
            if (!el || el.type !== "Column") continue;
            const col = el as ColumnElement;
            if (!col.visible) continue;
            if (!col.basePoint) continue;
            const baseLvl = col.baseLevelId ? levels.find((l) => l.id === col.baseLevelId) : undefined;
            const topLvl = col.topLevelId ? levels.find((l) => l.id === col.topLevelId) : undefined;
            const baseElev = (baseLvl?.elevation ?? 0) + col.baseOffset;
            let topElev = (topLvl?.elevation ?? (baseLvl?.elevation ?? 0) + 3) + col.topOffset;
            // Safety fallback: if base/top levels coincide and offsets add
            // up to zero height, default the column to 3 m tall.
            if (topElev - baseElev < 1e-6) topElev = baseElev + 3.0;
            const isSel = selection.includes(col.id as string);
            const isSketchSel = sketchSelectedColumnIds.has(col.id as string);
            scene.addObject({
                id: col.id,
                mesh: ColumnMeshBuilder.buildFromElement(col, baseElev, topElev),
                transform: mat4.create(),
                visible: true,
                color: isSel
                    ? [1.0, 0.4, 0.0, 1.0]              // selection: orange
                    : isSketchSel
                    ? [0.1, 0.85, 0.35, 1.0]            // sketchSelection: emerald
                    : [0.85, 0.85, 0.88, 1.0],
            });
        }

        // Column tool preview (ghost at cursor)。編集サブモードでは
        // 「配置プレビュー」は出さない (= 既存柱を移動するモードなので、
        // カーソル下に新柱の形状が出ると邪魔)。
        if (activeTool === "column" && columnHover && !inRoomMode && columnSubMode !== "edit") {
            const profile: Profile = columnProfileKind === "Circle"
                ? { kind: "Circle", radius: Math.max(0.05, parseFloat(columnRadiusInput) || 0.25) }
                : { kind: "Rectangle", width: Math.max(0.05, parseFloat(columnWidthInput) || 0.4), depth: Math.max(0.05, parseFloat(columnDepthInput) || 0.4) };
            const rotationRad = ((parseFloat(columnRotationInput) || 0) * Math.PI) / 180;
            const bLvl = (columnBaseLevelId ?? activeLevelId) ? levels.find((l) => l.id === (columnBaseLevelId ?? activeLevelId)) : undefined;
            const tLvl = (columnTopLevelId ?? columnBaseLevelId ?? activeLevelId) ? levels.find((l) => l.id === (columnTopLevelId ?? columnBaseLevelId ?? activeLevelId)) : undefined;
            const baseElev = (bLvl?.elevation ?? 0) + (parseFloat(columnBaseOffsetInput) || 0);
            let topElev = (tLvl?.elevation ?? (bLvl?.elevation ?? 0) + 3) + (parseFloat(columnTopOffsetInput) || 0);
            if (topElev - baseElev < 1e-6) topElev = baseElev + 3.0;
            if (topElev - baseElev > 1e-6) {
                scene.addObject({
                    id: "column-preview-ghost",
                    mesh: ColumnMeshBuilder.build({
                        basePoint: columnHover,
                        profile,
                        baseY: baseElev,
                        topY: topElev,
                        rotation: rotationRad,
                    }),
                    transform: mat4.create(),
                    visible: true,
                    color: [0.55, 0.85, 1.0, 0.6],
                });
            }
        }
        // Column snap marker
        if (activeTool === "column" && columnHover && columnSnap.kind && !inRoomMode) {
            const sp = columnHover;
            const s = 0.25;
            scene.addObject({
                id: "column-snap-h",
                mesh: LineMeshBuilder.build([[sp[0] - s, 0, sp[2]], [sp[0] + s, 0, sp[2]]]),
                transform: mat4.create(),
                visible: true,
                color: [0.1, 0.85, 0.35, 1.0],
                overlay: true,
            });
            scene.addObject({
                id: "column-snap-v",
                mesh: LineMeshBuilder.build([[sp[0], 0, sp[2] - s], [sp[0], 0, sp[2] + s]]),
                transform: mat4.create(),
                visible: true,
                color: [0.1, 0.85, 0.35, 1.0],
                overlay: true,
            });
        }

        // Beams — render as solid extruded boxes.
        // 部屋モード中も既存梁は描画する。プレビューは別 if で gated。
        // 梁の Y 範囲 (= [yBottom, yTop]) と Y 範囲が重なる全ての柱を集めるヘルパ。
        // 柱は base/top 2 レベル間を貫くので、梁レベル単純一致では取りこぼす。
        const columnsOverlappingBeam = (beam: BeamElement): Vec2[][] => {
            const beamLvl = beam.levelId ? levels.find((l) => l.id === beam.levelId) : undefined;
            const topY = (beamLvl?.elevation ?? 0) + beam.topOffset;
            const halfD = beam.profile.kind === "Rectangle" ? beam.profile.depth / 2
                        : beam.profile.kind === "Circle"    ? beam.profile.radius    : 0.3;
            // zJustification: Top → 梁本体は [topY-2*halfD, topY], Center → [topY-halfD, topY+halfD], Bottom → [topY, topY+2*halfD]
            let yBeamBottom: number, yBeamTop: number;
            if (beam.zJustification === "Top") { yBeamBottom = topY - halfD * 2; yBeamTop = topY; }
            else if (beam.zJustification === "Bottom") { yBeamBottom = topY; yBeamTop = topY + halfD * 2; }
            else { yBeamBottom = topY - halfD; yBeamTop = topY + halfD; }
            const fps: Vec2[][] = [];
            for (const cid in elements) {
                const ce = elements[cid];
                if (!ce || ce.type !== "Column") continue;
                const col = ce as ColumnElement;
                const baseLvl = col.baseLevelId ? levels.find((l) => l.id === col.baseLevelId) : undefined;
                const colTopLvl = col.topLevelId ? levels.find((l) => l.id === col.topLevelId) : undefined;
                const colYBase = (baseLvl?.elevation ?? 0) + col.baseOffset;
                let colYTop = (colTopLvl?.elevation ?? (baseLvl?.elevation ?? 0) + 3) + col.topOffset;
                if (colYTop - colYBase < 1e-6) colYTop = colYBase + 3.0;
                // 梁 Y 範囲と柱 Y 範囲が重なるか (= 立体的に交差するか)。
                if (colYTop < yBeamBottom - 1e-6 || colYBase > yBeamTop + 1e-6) continue;
                const fp = columnFootprint2D(col);
                if (fp.length >= 3) fps.push(ensureCCW(fp));
            }
            return fps;
        };

        for (const id in elements) {
            const el = elements[id];
            if (!el || el.type !== "Beam") continue;
            const beam = el as BeamElement;
            if (!beam.visible) continue;
            const lvl = beam.levelId ? levels.find((l) => l.id === beam.levelId) : undefined;
            const elevation = (lvl?.elevation ?? 0) + beam.topOffset;
            // 立体的に重なる柱フットプリントを Clipper diff で梁から引く。
            const beamColFps = columnsOverlappingBeam(beam);
            scene.addObject({
                id: beam.id,
                mesh: BeamMeshBuilder.buildFromElement(beam, elevation, beamColFps.length > 0 ? beamColFps : undefined),
                transform: mat4.create(),
                visible: true,
                color: selection.includes(beam.id as string) ? [1.0, 0.4, 0.0, 1.0] : [0.83, 0.83, 0.86, 1.0],
            });
        }

        // Beam preview (draft from beamStart to hover) + snap indicator
        if (activeTool === "beam" && beamStart && beamHover && !inRoomMode) {
            // Solid preview line on the ground plane
            scene.addObject({
                id: "beam-preview-line",
                mesh: LineMeshBuilder.build([beamStart, beamHover]),
                transform: mat4.create(),
                visible: true,
                color: [0.1, 0.4, 0.9, 1.0],
            });
            // Ghost 3D beam using current profile + level
            const effectiveBeamLevelId = beamLevelId ?? (activeLevelId as string | undefined);
            const lvl = effectiveBeamLevelId ? levels.find((l) => l.id === effectiveBeamLevelId) : undefined;
            const elevation = (lvl?.elevation ?? 0) + (parseFloat(beamTopOffsetInput) || 0);
            const w = Math.max(0.05, parseFloat(beamWidthInput) || 0.3);
            const d = Math.max(0.05, parseFloat(beamDepthInput) || 0.6);
            if (Math.hypot(beamHover[0] - beamStart[0], beamHover[2] - beamStart[2]) > 1e-3) {
                const previewLevelKey = (effectiveBeamLevelId as string | undefined) ?? "";
                const previewColFps = columnsByLevel.get(previewLevelKey)?.map((c) => c.points);
                scene.addObject({
                    id: "beam-preview-ghost",
                    mesh: BeamMeshBuilder.build({
                        axis: [beamStart, beamHover],
                        profile: { kind: "Rectangle", width: w, depth: d },
                        topY: elevation,
                        zJustification: beamZJust,
                        rotation: 0,
                        columnFootprints: previewColFps,
                    }),
                    transform: mat4.create(),
                    visible: true,
                    color: [0.55, 0.75, 1.0, 0.55],
                });
            }
        }
        // Snap marker at cursor in beam tool (常に最前面)
        if (activeTool === "beam" && beamHover && beamSnap.kind && !inRoomMode) {
            const sp = beamHover;
            const s = 0.25;
            scene.addObject({
                id: "beam-snap-h",
                mesh: LineMeshBuilder.build([[sp[0] - s, 0, sp[2]], [sp[0] + s, 0, sp[2]]]),
                transform: mat4.create(),
                visible: true,
                color: [0.1, 0.85, 0.35, 1.0],
                overlay: true,
            });
            scene.addObject({
                id: "beam-snap-v",
                mesh: LineMeshBuilder.build([[sp[0], 0, sp[2] - s], [sp[0], 0, sp[2] + s]]),
                transform: mat4.create(),
                visible: true,
                color: [0.1, 0.85, 0.35, 1.0],
                overlay: true,
            });
        }

        // Snap marker at cursor in slab sketch tool (= 柱・壁端点・壁軸・通芯
        // にスナップしている時に十字マーカーを表示)。`overlay: true` で他の
        // ジオメトリ (柱・梁・壁) の手前に確実に出す。
        if (activeTool === "slab" && slabSketching && slabSketchHover && slabSnap.kind) {
            const sp = slabSketchHover;
            const s = 0.25;
            scene.addObject({
                id: "slab-snap-h",
                mesh: LineMeshBuilder.build([[sp[0] - s, 0, sp[2]], [sp[0] + s, 0, sp[2]]]),
                transform: mat4.create(),
                visible: true,
                color: [0.1, 0.85, 0.35, 1.0],
                overlay: true,
            });
            scene.addObject({
                id: "slab-snap-v",
                mesh: LineMeshBuilder.build([[sp[0], 0, sp[2] - s], [sp[0], 0, sp[2] + s]]),
                transform: mat4.create(),
                visible: true,
                color: [0.1, 0.85, 0.35, 1.0],
                overlay: true,
            });
        }

        // Slabs — render as solid extruded polygons (per spec §7).
        // 2D wall plan view (activeTool === "wall") は壁を Y=0.02 のフラット
        // 矩形でレンダーするため slab と Z-fighting する。それ以外 (部屋モード
        // 含む) では既存 slab を描画する。
        if (activeTool !== "wall") {
            for (const id in elements) {
                const el = elements[id];
                if (!el || el.type !== "Slab") continue;
                const slab = el as SlabElement;
                if (!slab.visible) continue;
                if (!slab.boundary || slab.boundary.length < 3) continue;
                const isSelected = selection.includes(slab.id as string);
                // Slab メッシュは slab.elevation を yBase として使うが、level
                // は反映していないので、ここで level elevation を transform で
                // 加算する。これで「Level 2 を基準に offset 0」 → Y=3m に slab
                // が乗る。
                const slabLvlElev = slab.levelId
                    ? (levels.find((l) => l.id === slab.levelId)?.elevation ?? 0)
                    : 0;
                const slabXform = mat4.create();
                if (slabLvlElev !== 0) mat4.translate(slabXform, slabXform, [0, slabLvlElev, 0]);
                scene.addObject({
                    id: slab.id,
                    mesh: SlabMeshBuilder.build(slab),
                    transform: slabXform,
                    visible: true,
                    color: isSelected ? [1.0, 0.4, 0.0, 1.0] : [0.9, 0.9, 0.92, 1.0],
                    // 裏側 (= 床下から見上げ) からも slab が柱・壁を occlude
                    // するように両面描画。
                    noCull: true,
                });
            }
        }

        // Doors and Windows — render after walls so they sit inside the cut openings.
        // 部屋モード中も既存ドア/窓は描画する (wall plan view のみ非表示)。
        if (activeTool !== "wall") {
            for (const id in elements) {
                const el = elements[id];
                if (!el || (el.type !== "Door" && el.type !== "Window")) continue;
                const fill = el as DoorElement | WindowElement;
                if (!fill.visible) continue;
                const opening = elements[fill.openingId] as OpeningElement | undefined;
                if (!opening || opening.type !== "Opening") continue;
                const wall = elements[opening.hostWallId] as WallElement | undefined;
                if (!wall || wall.type !== "Wall") continue;
                const a = wall.axis[0];
                const b = wall.axis[1];
                const dx = b[0] - a[0];
                const dz = b[2] - a[2];
                const len = Math.hypot(dx, dz);
                if (len < 1e-6) continue;
                const ax: Vec3 = [dx / len, 0, dz / len];
                const nx: Vec3 = [-ax[2], 0, ax[0]];
                const center: Vec3 = [
                    a[0] + ax[0] * (opening.position * len),
                    a[1] + opening.sillHeight,
                    a[2] + ax[2] * (opening.position * len),
                ];
                const isSelected = selection.includes(fill.id as string);
                // Lift openings by the host wall's level elevation so they
                // stay inside the wall slab after we translate walls vertically.
                const wallElev = levelElevationFor(wall.baseLevelId as string | undefined);
                const openingTransform = mat4.create();
                if (wallElev !== 0) mat4.translate(openingTransform, openingTransform, [0, wallElev, 0]);
                if (fill.type === "Door") {
                    const mesh = DoorMeshBuilder.build({
                        center,
                        axisDir: ax,
                        normalDir: nx,
                        width: fill.width * 0.96,
                        height: fill.height,
                        thickness: 0.05,
                    });
                    scene.addObject({
                        id: fill.id,
                        mesh,
                        transform: openingTransform,
                        visible: true,
                        color: isSelected ? [1.0, 0.4, 0.0, 1.0] : [0.55, 0.35, 0.18, 1.0],
                        noCull: true,
                    });
                } else {
                    const mesh = WindowMeshBuilder.build({
                        center,
                        axisDir: ax,
                        normalDir: nx,
                        width: fill.width * 0.96,
                        height: fill.height,
                        thickness: 0.04,
                    });
                    scene.addObject({
                        id: fill.id,
                        mesh,
                        transform: openingTransform,
                        visible: true,
                        color: isSelected ? [1.0, 0.4, 0.0, 1.0] : [0.6, 0.78, 0.92, 0.85],
                        noCull: true,
                    });
                }
            }
        }

        // Door / window placement preview (ghost fill in the hover opening)
        if (!inRoomMode && (activeTool === "door" || activeTool === "window") && openingHover) {
            const wall = elements[openingHover.wallId] as WallElement | undefined;
            if (wall && wall.type === "Wall") {
                const a = wall.axis[0];
                const b = wall.axis[1];
                const dx = b[0] - a[0];
                const dz = b[2] - a[2];
                const len = Math.hypot(dx, dz);
                if (len > 1e-6) {
                    const ax: Vec3 = [dx / len, 0, dz / len];
                    const nx: Vec3 = [-ax[2], 0, ax[0]];
                    const def = activeTool === "door" ? doorDefaults : windowDefaults;
                    const center: Vec3 = [
                        a[0] + ax[0] * (openingHover.position * len),
                        a[1] + def.sillHeight,
                        a[2] + ax[2] * (openingHover.position * len),
                    ];
                    const builder = activeTool === "door" ? DoorMeshBuilder : WindowMeshBuilder;
                    const mesh = builder.build({
                        center,
                        axisDir: ax,
                        normalDir: nx,
                        width: def.width * 0.96,
                        height: def.height,
                        thickness: 0.05,
                    });
                    const previewWallElev = levelElevationFor(wall.baseLevelId as string | undefined);
                    const previewTransform = mat4.create();
                    if (previewWallElev !== 0) mat4.translate(previewTransform, previewTransform, [0, previewWallElev, 0]);
                    scene.addObject({
                        id: "preview-fill",
                        mesh,
                        transform: previewTransform,
                        visible: true,
                        color: activeTool === "door" ? [0.9, 0.55, 0.2, 0.7] : [0.55, 0.85, 1.0, 0.7],
                        noCull: true,
                    });
                }
            }
        }

        // Temp wall sketch line (wall tool only, not room mode). Rendered
        // as a thin screen-pixel line while the user is placing the second
        // point — matches Room-mode sketch feel. The wall itself is only
        // drawn once the second click commits CreateWallCommand.
        if (activeTool === "wall" && wallStart && wallEnd && !inRoomMode) {
            const SKETCH_LINE_PX = 1.5;
            const canvasHeight = canvasRef.current?.clientHeight ?? 800;
            const sketchThickness = useOrtho
                ? SKETCH_LINE_PX * (2 * orthoZoom / canvasHeight)
                : 0.02;
            const dx = wallEnd[0] - wallStart[0];
            const dz = wallEnd[2] - wallStart[2];
            if (Math.hypot(dx, dz) > 1e-6) {
                scene.addObject({
                    id: "temp-wall-sketch",
                    mesh: LineMeshBuilder.build([wallStart, wallEnd], {
                        thickness: sketchThickness,
                        jointSize: 0,
                    }),
                    transform: mat4.create(),
                    visible: true,
                    color: [0.2, 0.2, 0.2, 1.0],
                });
            }
            // Small marker at the first (committed) point so the user can
            // see where the sketch anchor is while moving the cursor.
            const markerSize = useOrtho
                ? 6 * (2 * orthoZoom / canvasHeight)
                : 0.08;
            const m = markerSize / 2;
            scene.addObject({
                id: "temp-wall-sketch-start",
                mesh: LineMeshBuilder.build(
                    [[wallStart[0] - m, 0, wallStart[2]], [wallStart[0] + m, 0, wallStart[2]]],
                    { thickness: sketchThickness, jointSize: 0 },
                ),
                transform: mat4.create(),
                visible: true,
                color: [0.2, 0.2, 0.2, 1.0],
            });
            scene.addObject({
                id: "temp-wall-sketch-start-v",
                mesh: LineMeshBuilder.build(
                    [[wallStart[0], 0, wallStart[2] - m], [wallStart[0], 0, wallStart[2] + m]],
                    { thickness: sketchThickness, jointSize: 0 },
                ),
                transform: mat4.create(),
                visible: true,
                color: [0.2, 0.2, 0.2, 1.0],
            });
        }

        // Snap indicator for the wall tool — rendered in the overlay pass so
        // it's never occluded by walls / sketch lines drawn at the same Y.
        // Visual mirrors RoomSketchOverlay:
        //   • Any concrete snap (grid intersection, wall endpoint, room
        //     vertex / edge, wall axis…): green filled square ("obj" marker)
        //   • Axis alignment through a reference point: cyan circle + ref
        //     guide lines from the reference points to the cursor
        if (activeTool === "wall" && wallSnap && !inRoomMode) {
            const canvasHeight = canvasRef.current?.clientHeight ?? 800;
            const pxW = useOrtho ? (2 * orthoZoom / canvasHeight) : 0.015;
            const sp = wallSnap.point;
            const isAxis = wallSnap.kind === "Axis";

            // Mirror room mode's C_SNAP_OBJ / C_SNAP_AXIS palette.
            const objFill: [number, number, number, number] = [25 / 255, 204 / 255, 102 / 255, 1.0];
            const axisFill: [number, number, number, number] = [51 / 255, 191 / 255, 242 / 255, 1.0];
            const white: [number, number, number, number] = [1, 1, 1, 1];

            const makeSquareMesh = (cx: number, cz: number, half: number): MeshData => {
                const Y = 0;
                const positions = new Float32Array([
                    cx - half, Y, cz - half,
                    cx + half, Y, cz - half,
                    cx + half, Y, cz + half,
                    cx - half, Y, cz + half,
                ]);
                const normals = new Float32Array([0,1,0, 0,1,0, 0,1,0, 0,1,0]);
                const indices = new Uint32Array([0, 1, 2, 0, 2, 3]);
                return {
                    positions, normals, indices,
                    bounds: { min: [cx - half, Y, cz - half], max: [cx + half, Y, cz + half] },
                    topology: "triangle-list",
                };
            };
            const makeCircleMesh = (cx: number, cz: number, r: number, seg = 20): MeshData => {
                const Y = 0;
                const positions: number[] = [cx, Y, cz];
                const normals: number[] = [0, 1, 0];
                const indices: number[] = [];
                for (let i = 0; i < seg; i++) {
                    const a = (i / seg) * Math.PI * 2;
                    positions.push(cx + Math.cos(a) * r, Y, cz + Math.sin(a) * r);
                    normals.push(0, 1, 0);
                    indices.push(0, 1 + i, 1 + ((i + 1) % seg));
                }
                return {
                    positions: new Float32Array(positions),
                    normals: new Float32Array(normals),
                    indices: new Uint32Array(indices),
                    bounds: { min: [cx - r, Y, cz - r], max: [cx + r, Y, cz + r] },
                    topology: "triangle-list",
                };
            };

            const fill = isAxis ? axisFill : objFill;
            const stroke = white;
            const outerR = 7 * pxW; // slightly larger white stroke ring
            const innerR = 5.5 * pxW;

            // White stroke ring underneath (square for obj, circle for axis).
            scene.addObject({
                id: "wall-snap-marker-stroke",
                mesh: isAxis
                    ? makeCircleMesh(sp[0], sp[2], outerR)
                    : makeSquareMesh(sp[0], sp[2], outerR),
                transform: mat4.create(),
                visible: true,
                color: stroke,
                overlay: true,
            });
            // Filled marker on top.
            scene.addObject({
                id: "wall-snap-marker-fill",
                mesh: isAxis
                    ? makeCircleMesh(sp[0], sp[2], innerR)
                    : makeSquareMesh(sp[0], sp[2], innerR),
                transform: mat4.create(),
                visible: true,
                color: fill,
                overlay: true,
            });

            // Axis-alignment guide lines from the reference points to the
            // cursor — matches room-mode draft feedback.
            if (isAxis) {
                const refH = wallSnap.axisRefH;
                const refV = wallSnap.axisRefV;
                const guideThickness = 1.2 * pxW;
                const pushGuide = (id: string, ref: Vec3) => {
                    scene.addObject({
                        id,
                        mesh: LineMeshBuilder.build(
                            [[ref[0], 0, ref[2]], [sp[0], 0, sp[2]]],
                            { thickness: guideThickness, jointSize: 0 },
                        ),
                        transform: mat4.create(),
                        visible: true,
                        color: axisFill,
                        overlay: true,
                    });
                };
                if (refH) pushGuide("wall-snap-axis-h-ref", refH);
                if (refV) pushGuide("wall-snap-axis-v-ref", refV);
            }
        }

        // 通芯 — render in both 2D and 3D, including room-edit mode
        {
            const primaryColor: [number, number, number, number] = useOrtho ? [0.85, 0.2, 0.2, 1.0] : [0.85, 0.3, 0.3, 0.85];
            const auxColor: [number, number, number, number] = useOrtho ? [0.85, 0.55, 0.2, 1.0] : [0.85, 0.6, 0.3, 0.85];
            const selectedColor: [number, number, number, number] = [0.98, 0.78, 0.08, 1.0];
            // Screen-constant thickness in ortho: world thickness = px * (2*zoom / canvasHeight).
            // Perspective keeps a fixed world thickness.
            const GRID_LINE_PX = 1.5;
            const canvasHeight = canvasRef.current?.clientHeight ?? 800;
            const gridThickness = useOrtho
                ? GRID_LINE_PX * (2 * orthoZoom / canvasHeight)
                : 0.1;
            const sketchSelGridSet = new Set<string>();
            for (const s of sketchSelection) {
                if (s.kind === "gridLine") sketchSelGridSet.add(s.gridId);
            }
            for (const g of grids) {
                if (!g.visible) continue;
                const verts = gridVertices(g.curve);
                if (verts.length < 2) continue;
                const isSelected = !inRoomMode && selectedGridIds.includes(g.id);
                const isSketchSel = sketchSelGridSet.has(g.id);
                scene.addObject({
                    id: `grid-${g.id}`,
                    mesh: LineMeshBuilder.build(verts, { thickness: gridThickness, jointSize: 0 }),
                    transform: mat4.create(),
                    visible: true,
                    color: isSelected
                        ? selectedColor
                        : isSketchSel
                        ? [0.1, 0.85, 0.35, 1.0]            // emerald = sketchSelection ハイライト
                        : g.kind === "Auxiliary" ? auxColor : primaryColor,
                    // 通芯は地面と平行な薄い帯。視点が下方からでも見えるよう
                    // 両面描画する。
                    noCull: true,
                });
            }
        }

        // Snap indicator + draft preview — only in 2D drafting mode
        if (useOrtho && !inRoomMode) {
            if (activeTool === "gridline" && gridlineDrafting && gridSnap) {
                const sp = gridSnap.point;
                const s = 0.25;
                const cross: Vec3[] = [
                    [sp[0] - s, 0, sp[2]], [sp[0] + s, 0, sp[2]],
                ];
                scene.addObject({
                    id: "grid-snap-marker-h",
                    mesh: LineMeshBuilder.build(cross),
                    transform: mat4.create(),
                    visible: true,
                    color: [0.1, 0.8, 0.4, 1.0],
                    overlay: true,
                });
                scene.addObject({
                    id: "grid-snap-marker-v",
                    mesh: LineMeshBuilder.build([[sp[0], 0, sp[2] - s], [sp[0], 0, sp[2] + s]]),
                    transform: mat4.create(),
                    visible: true,
                    color: [0.1, 0.8, 0.4, 1.0],
                    overlay: true,
                });
            }

            // Axis-alignment guide lines from reference endpoints to the cursor
            if (activeTool === "gridline" && gridlineDrafting && gridAxisSnap) {
                const guideColor: [number, number, number, number] = [0.2, 0.75, 0.95, 0.9];
                const sp = gridAxisSnap.point;
                if (gridAxisSnap.refPointH) {
                    const r = gridAxisSnap.refPointH;
                    scene.addObject({
                        id: "grid-axis-guide-h",
                        mesh: LineMeshBuilder.build([[r[0], 0, r[2]], [sp[0], 0, r[2]]]),
                        transform: mat4.create(),
                        visible: true,
                        color: guideColor,
                    });
                }
                if (gridAxisSnap.refPointV) {
                    const r = gridAxisSnap.refPointV;
                    scene.addObject({
                        id: "grid-axis-guide-v",
                        mesh: LineMeshBuilder.build([[r[0], 0, r[2]], [r[0], 0, sp[2]]]),
                        transform: mat4.create(),
                        visible: true,
                        color: guideColor,
                    });
                }
                const s = 0.2;
                scene.addObject({
                    id: "grid-axis-marker-h",
                    mesh: LineMeshBuilder.build([[sp[0] - s, 0, sp[2]], [sp[0] + s, 0, sp[2]]]),
                    transform: mat4.create(),
                    visible: true,
                    color: guideColor,
                });
                scene.addObject({
                    id: "grid-axis-marker-v",
                    mesh: LineMeshBuilder.build([[sp[0], 0, sp[2] - s], [sp[0], 0, sp[2] + s]]),
                    transform: mat4.create(),
                    visible: true,
                    color: guideColor,
                });
            }

            // Active draft previews
            if (activeTool === "gridline" && gridlineDrafting) {
                let dashIdx = 0;
                const drawDashed = (from: Vec3, to: Vec3) => {
                    const dx = to[0] - from[0];
                    const dz = to[2] - from[2];
                    const len = Math.hypot(dx, dz);
                    if (len < 1e-6) return;
                    const dashLen = 0.3;
                    const gapLen = 0.2;
                    const stride = dashLen + gapLen;
                    const ux = dx / len;
                    const uz = dz / len;
                    let t = 0;
                    while (t < len) {
                        const tEnd = Math.min(t + dashLen, len);
                        const a: Vec3 = [from[0] + ux * t, 0, from[2] + uz * t];
                        const b: Vec3 = [from[0] + ux * tEnd, 0, from[2] + uz * tEnd];
                        scene.addObject({
                            id: `grid-dash-${dashIdx}`,
                            mesh: LineMeshBuilder.build([a, b]),
                            transform: mat4.create(),
                            visible: true,
                            color: [0.85, 0.2, 0.2, 1.0],
                        });
                        t += stride;
                        dashIdx++;
                    }
                };
                const drawSolid = (from: Vec3, to: Vec3) => {
                    scene.addObject({
                        id: `grid-draft-solid-${dashIdx++}`,
                        mesh: LineMeshBuilder.build([from, to]),
                        transform: mat4.create(),
                        visible: true,
                        color: [0.85, 0.2, 0.2, 0.9],
                    });
                };
                if (gridDraftMode === "polyline") {
                    // Solid segments for committed points, dashed preview for cursor leg
                    for (let i = 0; i < gridDraftPoints.length - 1; i++) {
                        drawSolid(gridDraftPoints[i], gridDraftPoints[i + 1]);
                    }
                    const last = gridDraftPoints[gridDraftPoints.length - 1];
                    if (last && gridHover) drawDashed(last, gridHover);
                } else if (gridStart && gridHover) {
                    drawDashed(gridStart, gridHover);
                }
            }
        }
    }, [elements, selection, activeTool, wallStart, wallEnd, wallSnap, activeRoomId, pendingRoomLevelId, grids, gridStart, gridHover, gridlineDrafting, gridDraftMode, gridDraftPoints, useOrtho, orthoZoom, selectedGridIds, gridSnap, gridAxisSnap, openingHover, slabSelectedSpaces, slabSketching, slabSketchPoints, slabSketchHover, slabSnap, beamStart, beamHover, beamSnap, beamWidthInput, beamDepthInput, beamTopOffsetInput, beamZJust, beamLevelId, beamSubMode, beamDragState, levels, columnHover, columnSnap, columnProfileKind, columnWidthInput, columnDepthInput, columnRadiusInput, columnRotationInput, columnBaseLevelId, columnTopLevelId, columnBaseOffsetInput, columnTopOffsetInput, columnSubMode, columnDragState, sketchSelection, wallSubMode]);

    // Pick the nearest sketch item (polygon vertex/edge) to a world-space
    // ground point. Shared by select + wall modes. Priority: vertex > edge.
    // Returns null if nothing is within the pixel-based tolerance.
    const pickSketchItemAt = (raw: Vec3): SketchSelectionItem | null => {
        const canvasH = canvasRef.current?.clientHeight ?? 800;
        const pxToWorld = useOrtho ? (2 * orthoZoom / canvasH) : 0.015;
        const VERT_TOL = 8 * pxToWorld;
        const EDGE_TOL = 6 * pxToWorld;
        let hit: SketchSelectionItem | null = null;
        let bestD = Infinity;
        // Vertex pass — polygon corners AND standalone wall endpoints compete
        // on equal footing so whichever is closer wins. Edges / axes are only
        // considered on the next pass.
        for (const id in elements) {
            const el = elements[id];
            if (!el || el.type !== "Space") continue;
            const space = el as SpaceElement;
            for (const poly of space.polygons ?? []) {
                if (poly.shape?.type === "circle") continue;
                for (let i = 0; i < poly.outer.length; i++) {
                    const [vx, vz] = poly.outer[i];
                    const d = Math.hypot(raw[0] - vx, raw[2] - vz);
                    if (d < VERT_TOL && d < bestD) {
                        bestD = d;
                        hit = { kind: "point", spaceId: id, polyId: poly.id, vertexIdx: i };
                    }
                }
            }
        }
        // Standalone wall endpoints — only count walls NOT linked to a room
        // polygon (room walls share the polygon vertex which is already
        // above). This avoids picking both and ambiguous double-select.
        const roomLinkedWallIds = new Set<string>();
        for (const id in elements) {
            const el = elements[id];
            if (!el || el.type !== "Space") continue;
            for (const poly of (el as SpaceElement).polygons ?? []) {
                for (const wid of poly.wallIds ?? []) if (wid) roomLinkedWallIds.add(wid);
            }
        }
        for (const id in elements) {
            const el = elements[id];
            if (!el || el.type !== "Wall") continue;
            if (roomLinkedWallIds.has(id)) continue;
            const w = el as WallElement;
            for (let i = 0; i < 2; i++) {
                const p = w.axis[i];
                const d = Math.hypot(raw[0] - p[0], raw[2] - p[2]);
                if (d < VERT_TOL && d < bestD) {
                    bestD = d;
                    hit = { kind: "wallPoint", wallId: id, endIdx: i as 0 | 1 };
                }
            }
        }
        // Column 中心 — Length / Coincident 等の点拘束で柱の basePoint を
        // 第一級ターゲットとして選べる。
        for (const id in elements) {
            const el = elements[id];
            if (!el || el.type !== "Column") continue;
            const col = el as ColumnElement;
            if (!col.basePoint) continue;
            const d = Math.hypot(raw[0] - col.basePoint[0], raw[2] - col.basePoint[2]);
            if (d < VERT_TOL && d < bestD) {
                bestD = d;
                hit = { kind: "column", columnId: id as any };
            }
        }
        // Grid 端点 (Line / Polyline の各頂点)。
        for (const g of grids) {
            if (!g.visible) continue;
            const verts = gridVertices(g.curve);
            for (let i = 0; i < verts.length; i++) {
                const v = verts[i];
                const d = Math.hypot(raw[0] - v[0], raw[2] - v[2]);
                if (d < VERT_TOL && d < bestD) {
                    bestD = d;
                    hit = { kind: "gridPoint", gridId: g.id, vertexIdx: i };
                }
            }
        }
        // 原点 (0, 0, 0) — 視認用。
        {
            const d = Math.hypot(raw[0], raw[2]);
            if (d < VERT_TOL && d < bestD) {
                bestD = d;
                hit = { kind: "origin" };
            }
        }
        if (hit) return hit;
        // 通芯線 (= grid 全体) のエッジヒット。柱-通芯垂直距離拘束に使う。
        for (const g of grids) {
            if (!g.visible) continue;
            const verts = gridVertices(g.curve);
            for (let i = 0; i < verts.length - 1; i++) {
                const a = verts[i];
                const b = verts[i + 1];
                const dx = b[0] - a[0], dz = b[2] - a[2];
                const lenSq = dx * dx + dz * dz;
                if (lenSq < 1e-12) continue;
                const t = Math.max(0, Math.min(1, ((raw[0] - a[0]) * dx + (raw[2] - a[2]) * dz) / lenSq));
                const qx = a[0] + dx * t, qz = a[2] + dz * t;
                const d = Math.hypot(raw[0] - qx, raw[2] - qz);
                if (d < EDGE_TOL && d < bestD) {
                    bestD = d;
                    hit = { kind: "gridLine", gridId: g.id };
                }
            }
        }
        // Edge pass — polygon outer edges (room-mode walls use these as their
        // inner face, so this picks up "作図線" on room-mode walls too).
        for (const id in elements) {
            const el = elements[id];
            if (!el || el.type !== "Space") continue;
            const space = el as SpaceElement;
            for (const poly of space.polygons ?? []) {
                if (poly.shape?.type === "circle") continue;
                const edges = polygonEdges(poly);
                for (let i = 0; i < edges.length; i++) {
                    const [ai, bi] = edges[i];
                    const a = poly.outer[ai], b = poly.outer[bi];
                    const dx = b[0] - a[0], dz = b[1] - a[1];
                    const lenSq = dx * dx + dz * dz;
                    if (lenSq < 1e-12) continue;
                    const t = Math.max(0, Math.min(1, ((raw[0] - a[0]) * dx + (raw[2] - a[1]) * dz) / lenSq));
                    const qx = a[0] + dx * t, qz = a[1] + dz * t;
                    const d = Math.hypot(raw[0] - qx, raw[2] - qz);
                    if (d < EDGE_TOL && d < bestD) {
                        bestD = d;
                        hit = { kind: "edge", spaceId: id, polyId: poly.id, edgeIdx: i };
                    }
                }
            }
        }
        if (hit) return hit;
        // Standalone wall axes — walls drawn in wall mode that aren't tied
        // to a room polygon. Their axis line is the visible "作図線" so it
        // needs to be pickable too. Room-linked walls are excluded (their
        // polygon edges are already picked above).
        const linkedWallIds = new Set<string>();
        for (const id in elements) {
            const el = elements[id];
            if (!el || el.type !== "Space") continue;
            for (const poly of (el as SpaceElement).polygons ?? []) {
                for (const wid of poly.wallIds ?? []) if (wid) linkedWallIds.add(wid);
            }
        }
        for (const id in elements) {
            const el = elements[id];
            if (!el || el.type !== "Wall") continue;
            if (linkedWallIds.has(id)) continue;
            const w = el as WallElement;
            const a = w.axis[0], b = w.axis[1];
            const dx = b[0] - a[0], dz = b[2] - a[2];
            const lenSq = dx * dx + dz * dz;
            if (lenSq < 1e-12) continue;
            const t = Math.max(0, Math.min(1, ((raw[0] - a[0]) * dx + (raw[2] - a[2]) * dz) / lenSq));
            const qx = a[0] + dx * t, qz = a[2] + dz * t;
            const d = Math.hypot(raw[0] - qx, raw[2] - qz);
            if (d < EDGE_TOL && d < bestD) {
                bestD = d;
                hit = { kind: "wallAxis", wallId: id };
            }
        }
        return hit;
    };

    const handlePointerDown = (e: React.PointerEvent) => {
        if (e.button !== 0) return;

        // In room mode, SVG overlay handles all interaction — except when
        // the wall tool is active: the overlay re-dispatches empty-area
        // clicks here so the user can draw walls while still picking room
        // geometry for constraints. pending (Space 未生成) でも overlay 側で
        // 図形ドラフトを処理させたいので同様に early return。
        if ((activeRoomId || pendingRoomLevelId) && activeTool !== "wall") return;

        if (activeTool === "select") {
            const pt = getGroundIntersection(e.clientX, e.clientY, canvasRef.current!, cameraRef.current);

            // Sketch pick first — polygon edges / vertices act as "作図線"
            // across rooms so constraints can be applied in plain select
            // mode (no need to enter a specific room first).
            if (pt) {
                const hit = pickSketchItemAt(pt);
                const additive = e.shiftKey || e.ctrlKey || e.metaKey;
                if (hit) {
                    toggleSketchSelection(hit, additive);
                    // フラグは設定しない: スケッチ選択クリックは drag state を
                    // 起動しないので、ユーザがそのまま左ドラッグしたらカメラ
                    // 回転に流したい。
                    return;
                }
            }

            if (pt) {
                if (selection.length > 0) {
                    const selId = selection[0];
                    const el = elements[selId] as WallElement;
                    if (el && el.type === "Wall") {
                        const d0 = Math.hypot(pt[0] - el.axis[0][0], pt[2] - el.axis[0][2]);
                        const d1 = Math.hypot(pt[0] - el.axis[1][0], pt[2] - el.axis[1][2]);
                        let dragNode: Vec3 | null = null;
                        if (d0 < 0.6) dragNode = el.axis[0];
                        else if (d1 < 0.6) dragNode = el.axis[1];

                        if (dragNode) {
                            const affected: { id: string, index: 0 | 1 }[] = [];
                            for (const k in elements) {
                                const rel = elements[k] as WallElement;
                                if (rel.type === "Wall") {
                                    if (Math.hypot(rel.axis[0][0] - dragNode[0], rel.axis[0][2] - dragNode[2]) < 0.01) {
                                        affected.push({ id: k, index: 0 });
                                    }
                                    if (Math.hypot(rel.axis[1][0] - dragNode[0], rel.axis[1][2] - dragNode[2]) < 0.01) {
                                        affected.push({ id: k, index: 1 });
                                    }
                                }
                            }
                            setDragState({ affected, startPt: dragNode });
                            (window as any).__viewportInteracting = true;
                            return;
                        }
                    }
                }

                // Column を select モードで掴んでドラッグ開始。footprint 多角形
                // 内に pt が入っていれば対象。複数柱が重なっていれば最も近い
                // 中心を選ぶ。
                let bestCol: { id: string; dist: number } | null = null;
                for (const cid in elements) {
                    const ce = elements[cid];
                    if (!ce || ce.type !== "Column") continue;
                    const col = ce as ColumnElement;
                    if (!col.basePoint) continue;
                    const fp = columnFootprint2D(col);
                    if (fp.length < 3) continue;
                    const ring2: [number, number][] = fp.map((p) => [p[0], p[1]]);
                    if (!pointInPolygon([pt[0], pt[2]], ring2)) continue;
                    const d = Math.hypot(pt[0] - col.basePoint[0], pt[2] - col.basePoint[2]);
                    if (!bestCol || d < bestCol.dist) bestCol = { id: cid, dist: d };
                }
                if (bestCol) {
                    const col = elements[bestCol.id] as ColumnElement;
                    setSelection([bestCol.id]);
                    setColumnDragState({
                        columnId: bestCol.id,
                        startPt: pt,
                        origBasePoint: [col.basePoint[0], col.basePoint[1], col.basePoint[2]],
                        finalPoint: [col.basePoint[0], col.basePoint[1], col.basePoint[2]],
                        moved: false,
                    });
                    (window as any).__viewportInteracting = true;
                    return;
                }
            }

            // Raycast selection。obj.transform が単位行列でない (= slab のように
            // level elevation 分 Y 平行移動している) ケースは mesh.bounds が
            // ローカル座標、ray が world 座標で食い違うため、transform を適用
            // した world bounds で判定する。一般 transform (回転 / スケール) は
            // 8 頂点を変換して再 AABB するが、現状の使用例は平行移動のみなので
            // それで十分。
            const transformAabb = (
                bounds: { min: Vec3; max: Vec3 },
                m: mat4,
            ): { min: Vec3; max: Vec3 } => {
                const corners: Vec3[] = [
                    [bounds.min[0], bounds.min[1], bounds.min[2]],
                    [bounds.max[0], bounds.min[1], bounds.min[2]],
                    [bounds.min[0], bounds.max[1], bounds.min[2]],
                    [bounds.max[0], bounds.max[1], bounds.min[2]],
                    [bounds.min[0], bounds.min[1], bounds.max[2]],
                    [bounds.max[0], bounds.min[1], bounds.max[2]],
                    [bounds.min[0], bounds.max[1], bounds.max[2]],
                    [bounds.max[0], bounds.max[1], bounds.max[2]],
                ];
                let mnX = Infinity, mnY = Infinity, mnZ = Infinity;
                let mxX = -Infinity, mxY = -Infinity, mxZ = -Infinity;
                const v = vec4.create();
                for (const c of corners) {
                    vec4.set(v, c[0], c[1], c[2], 1);
                    vec4.transformMat4(v, v, m);
                    if (v[0] < mnX) mnX = v[0]; if (v[0] > mxX) mxX = v[0];
                    if (v[1] < mnY) mnY = v[1]; if (v[1] > mxY) mxY = v[1];
                    if (v[2] < mnZ) mnZ = v[2]; if (v[2] > mxZ) mxZ = v[2];
                }
                return { min: [mnX, mnY, mnZ], max: [mxX, mxY, mxZ] };
            };
            const ray = getRay(e.clientX, e.clientY, canvasRef.current!, cameraRef.current);
            let closestDist = Infinity;
            let closestId: string | null = null;
            for (const obj of sceneRef.current.getObjects()) {
                if (obj.id.toString().startsWith("handle-")) continue;

                const worldBounds = transformAabb(obj.mesh.bounds, obj.transform as mat4);
                const dist = rayIntersectsAABB(ray.origin, ray.dir, worldBounds);
                if (dist !== null && dist < closestDist) {
                    closestDist = dist;
                    closestId = obj.id.toString();
                }
            }

            if (closestId) {
                setSelection([closestId]);
                // 選択した element の ID と種別をコンソール出力 (= デバッグ確認用)。
                const sel = elements[closestId];
                // eslint-disable-next-line no-console
                console.log(
                    `[select] id=${closestId} type=${sel?.type ?? "?"}` +
                    (sel?.type === "Wall"
                        ? ` axis=(${(sel as WallElement).axis[0][0].toFixed(2)},${(sel as WallElement).axis[0][2].toFixed(2)})→` +
                          `(${(sel as WallElement).axis[1][0].toFixed(2)},${(sel as WallElement).axis[1][2].toFixed(2)})` +
                          ` cat=${(sel as WallElement).wallCategory ?? "-"}`
                        : ""),
                );
                // Clear sketch selection when picking an element to avoid
                // stale sketch highlights from previous clicks.
                if (sketchSelection.length > 0) clearSketchSelection();
                // フラグは設定しない: 単なる element 選択は drag を消費しない
                // (= 続けて左ドラッグしたらカメラ回転に流す)。drag state を
                // 設定したケース (wall axis 端点 / column body) ではすでに
                // フラグを立てているのでそのまま消費される。
            } else {
                setSelection([]);
                if (sketchSelection.length > 0 && !(e.shiftKey || e.ctrlKey || e.metaKey)) {
                    clearSketchSelection();
                }
            }
            return;
        }

        if (activeTool === "wall") {
            (window as any).__viewportInteracting = true;
            const raw = getGroundIntersection(e.clientX, e.clientY, canvasRef.current!, cameraRef.current);
            if (!raw) return;

            // Select sub-mode: plain click picks "作図線" (room polygon
            // edge/vertex) for constraint targeting. Mirrors room-mode select
            // semantics; clears selection when clicking empty space.
            if (wallSubMode === "select") {
                const hit = pickSketchItemAt(raw);
                const additive = e.shiftKey || e.ctrlKey || e.metaKey;
                if (hit) {
                    toggleSketchSelection(hit, additive);
                } else if (!additive && sketchSelection.length > 0) {
                    clearSketchSelection();
                }
                return;
            }

            // Add sub-mode: modifier-held click still picks sketch items so
            // the user can grab a constraint target mid-drawing. Plain clicks
            // fall through to wall drawing with snapForWall staying centered
            // on nearby sketch lines.
            if (!wallStart && (e.shiftKey || e.ctrlKey || e.metaKey)) {
                const hit = pickSketchItemAt(raw);
                if (hit) {
                    toggleSketchSelection(hit, true);
                    return;
                }
            }

            const snap = unifiedSnap(raw, elements, grids);
            const pt = snap.point;
            const snapSource = snap.source ?? null;
            setWallSnap(snap.kind ? snap : null);

            if (!wallStart) {
                setWallStart(pt);
                setWallEnd(pt);
                setWallStartSource(snapSource);
            } else {
                const wallTypeId = useAppState.getState().activeTypeIdByCategory.Wall;
                if (!wallTypeId) {
                    console.warn("[wall] no active WallType — skipping creation");
                    return;
                }
                const cmd = new CreateWallCommand([wallStart, pt], wallTypeId as any, 3.0, undefined, activeLevelId ?? undefined);
                executeCommand(cmd);
                const newWallId = cmd.getElementId() as string;

                // Lock the new wall's start endpoint onto whatever the user
                // snapped to at click 1 — without this, polyline chains visibly
                // break apart the moment a constraint is applied.
                if (wallStartSource) {
                    const startTarget: ConstraintTarget = wallStartSource.kind === "wall"
                        ? { kind: "WallAxisPoint", wallId: wallStartSource.wallId, endIdx: wallStartSource.endIdx }
                        : {
                            kind: "SketchPoint",
                            spaceId: wallStartSource.spaceId,
                            polyId: wallStartSource.polyId,
                            vertexIdx: wallStartSource.vertexIdx,
                        };
                    executeCommand(new AddConstraintCommand({
                        id: generateConstraintId(),
                        type: "Coincident",
                        targets: [
                            { kind: "WallAxisPoint", wallId: newWallId, endIdx: 0 },
                            startTarget,
                        ],
                    }));
                }
                // Same treatment for the end endpoint — end of this wall acts
                // as the start of the next in a polyline chain, so this is
                // also what the next segment should reconnect to.
                if (snapSource) {
                    const endTarget: ConstraintTarget = snapSource.kind === "wall"
                        ? { kind: "WallAxisPoint", wallId: snapSource.wallId, endIdx: snapSource.endIdx }
                        : {
                            kind: "SketchPoint",
                            spaceId: snapSource.spaceId,
                            polyId: snapSource.polyId,
                            vertexIdx: snapSource.vertexIdx,
                        };
                    executeCommand(new AddConstraintCommand({
                        id: generateConstraintId(),
                        type: "Coincident",
                        targets: [
                            { kind: "WallAxisPoint", wallId: newWallId, endIdx: 1 },
                            endTarget,
                        ],
                    }));
                }

                setWallStart(pt);
                setWallEnd(pt);
                // Next click's start is the end of the wall we just made,
                // unless the user snapped to something else — in which case
                // that entity takes priority (keeps chain consistent).
                setWallStartSource(snapSource ?? {
                    kind: "wall",
                    wallId: newWallId,
                    endIdx: 1,
                });
            }
        }

        if (activeTool === "column") {
            (window as any).__viewportInteracting = true;
            const raw = getGroundIntersection(e.clientX, e.clientY, canvasRef.current!, cameraRef.current);
            if (!raw) return;

            // 編集サブモード:
            //   - プレーンクリック → 既存柱の footprint ヒット → ドラッグ開始
            //   - Shift/Ctrl クリック → sketchSelection に積む (= 拘束付与用)
            //     対象は柱中心 / 通芯端点 / 原点 / 部屋頂点 / 壁端点 など
            if (columnSubMode === "edit") {
                const additive = e.shiftKey || e.ctrlKey || e.metaKey;
                if (additive) {
                    const hit = pickSketchItemAt(raw);
                    if (hit) {
                        toggleSketchSelection(hit, true);
                        return;
                    }
                    return;
                }
                let bestCol: { id: string; dist: number } | null = null;
                for (const cid in elements) {
                    const ce = elements[cid];
                    if (!ce || ce.type !== "Column") continue;
                    const col = ce as ColumnElement;
                    if (!col.basePoint) continue;
                    const fp = columnFootprint2D(col);
                    if (fp.length < 3) continue;
                    const ring2: [number, number][] = fp.map((p) => [p[0], p[1]]);
                    if (!pointInPolygon([raw[0], raw[2]], ring2)) continue;
                    const d = Math.hypot(raw[0] - col.basePoint[0], raw[2] - col.basePoint[2]);
                    if (!bestCol || d < bestCol.dist) bestCol = { id: cid, dist: d };
                }
                if (bestCol) {
                    const col = elements[bestCol.id] as ColumnElement;
                    setSelection([bestCol.id]);
                    setColumnDragState({
                        columnId: bestCol.id,
                        startPt: raw,
                        origBasePoint: [col.basePoint[0], col.basePoint[1], col.basePoint[2]],
                        finalPoint: [col.basePoint[0], col.basePoint[1], col.basePoint[2]],
                        moved: false,
                    });
                }
                return;
            }

            const snap = snapForBeam(raw, elements, grids as any, 0.5, designMode === "jpResidentialGrid" ? RESIDENTIAL_GRID_SECONDARY_M : undefined);
            const pt = snap.point;
            // Type 体系: アクティブな ColumnType を使用。ユーザがツールバーで
            // 寸法を上書き入力していたら override として渡す。
            const colTypeId = useAppState.getState().activeTypeIdByCategory.Column;
            if (!colTypeId) {
                console.warn("[column] no active ColumnType — skipping creation");
                return;
            }
            const profileOverride: Profile = columnProfileKind === "Circle"
                ? { kind: "Circle", radius: Math.max(0.05, parseFloat(columnRadiusInput) || 0.25) }
                : { kind: "Rectangle", width: Math.max(0.05, parseFloat(columnWidthInput) || 0.4), depth: Math.max(0.05, parseFloat(columnDepthInput) || 0.4) };
            const rotation = ((parseFloat(columnRotationInput) || 0) * Math.PI) / 180;
            const baseOffset = parseFloat(columnBaseOffsetInput) || 0;
            const topOffset = parseFloat(columnTopOffsetInput) || 0;
            executeCommand(new CreateColumnCommand(
                pt,
                colTypeId as any,
                (columnBaseLevelId ?? activeLevelId) as any,
                (columnTopLevelId ?? columnBaseLevelId ?? activeLevelId) as any,
                baseOffset,
                topOffset,
                rotation,
                "Structural",
                { profile: profileOverride },
            ));
            // 柱の追加で壁の最終フットプリント (= 柱との polygon-clipping) が
            // 変わるので、realtime 壁再生成をトリガする。
            triggerWallRegenIfEnabled("column-create");
            if (!columnChainMode) {
                setActiveTool("select");
            }
            return;
        }

        if (activeTool === "beam") {
            (window as any).__viewportInteracting = true;
            const raw = getGroundIntersection(e.clientX, e.clientY, canvasRef.current!, cameraRef.current);
            if (!raw) return;

            // 編集サブモード: 既存梁の端点 / body をヒットしたらドラッグ開始。
            if (beamSubMode === "edit") {
                const ENDPOINT_R = 0.4; // 端点ヒット半径 (m)
                const AXIS_R = 0.4;     // 軸線ヒット距離 (m)
                let pickedEnd: { id: string; handle: "start" | "end"; dist: number } | null = null;
                let pickedBody: { id: string; dist: number } | null = null;
                for (const id in elements) {
                    const el = elements[id];
                    if (!el || el.type !== "Beam") continue;
                    const beam = el as BeamElement;
                    if (!beam.visible) continue;
                    const a = beam.axis[0], b = beam.axis[1];
                    const dA = Math.hypot(raw[0] - a[0], raw[2] - a[2]);
                    const dB = Math.hypot(raw[0] - b[0], raw[2] - b[2]);
                    if (dA <= ENDPOINT_R && (!pickedEnd || dA < pickedEnd.dist)) {
                        pickedEnd = { id, handle: "start", dist: dA };
                    }
                    if (dB <= ENDPOINT_R && (!pickedEnd || dB < pickedEnd.dist)) {
                        pickedEnd = { id, handle: "end", dist: dB };
                    }
                    // 軸線への垂直距離 (= body ヒット)
                    const dx = b[0] - a[0], dz = b[2] - a[2];
                    const len2 = dx * dx + dz * dz;
                    if (len2 < 1e-9) continue;
                    let t = ((raw[0] - a[0]) * dx + (raw[2] - a[2]) * dz) / len2;
                    t = Math.max(0, Math.min(1, t));
                    const px = a[0] + dx * t, pz = a[2] + dz * t;
                    const dPerp = Math.hypot(raw[0] - px, raw[2] - pz);
                    if (dPerp <= AXIS_R && (!pickedBody || dPerp < pickedBody.dist)) {
                        pickedBody = { id, dist: dPerp };
                    }
                }
                // 端点ヒットを優先 (= 形状変更が直感的)、無ければ body 平行移動。
                const picked = pickedEnd
                    ?? (pickedBody ? { id: pickedBody.id, handle: "body" as const, dist: pickedBody.dist } : null);
                if (picked) {
                    const beam = elements[picked.id] as BeamElement;
                    setSelection([picked.id]);
                    const orig: [Vec3, Vec3] = [
                        [beam.axis[0][0], beam.axis[0][1], beam.axis[0][2]],
                        [beam.axis[1][0], beam.axis[1][1], beam.axis[1][2]],
                    ];
                    setBeamDragState({
                        beamId: picked.id,
                        handle: picked.handle,
                        startPt: raw,
                        origAxis: orig,
                        finalAxis: orig,
                        moved: false,
                    });
                    return;
                }
                return;
            }

            const snap = snapForBeam(raw, elements, grids as any, 0.5, designMode === "jpResidentialGrid" ? RESIDENTIAL_GRID_SECONDARY_M : undefined);
            const pt = snap.point;
            if (!beamStart) {
                setBeamStart(pt);
                setBeamHover(pt);
            } else {
                // Validate (spec §18)
                const len = Math.hypot(pt[0] - beamStart[0], pt[2] - beamStart[2]);
                if (len < 1e-3) return;
                const beamTypeId = useAppState.getState().activeTypeIdByCategory.Beam;
                if (!beamTypeId) {
                    console.warn("[beam] no active BeamType — skipping creation");
                    return;
                }
                const width = Math.max(0.05, parseFloat(beamWidthInput) || 0.3);
                const depth = Math.max(0.05, parseFloat(beamDepthInput) || 0.6);
                const topOffset = parseFloat(beamTopOffsetInput) || 0;
                executeCommand(new CreateBeamCommand(
                    [beamStart, pt],
                    beamTypeId as any,
                    topOffset,
                    beamZJust,
                    0,
                    (beamLevelId ?? activeLevelId) as any,
                    "Structural",
                    { profile: { kind: "Rectangle", width, depth } },
                ));
                if (beamChainMode) {
                    // Chain: end of this beam becomes start of next (spec §17)
                    setBeamStart(pt);
                    setBeamHover(pt);
                } else {
                    setBeamStart(null);
                    setBeamHover(null);
                }
            }
            return;
        }

        if (activeTool === "gridline" && gridlineDrafting) {
            (window as any).__viewportInteracting = true;
            const raw = getGroundIntersection(e.clientX, e.clientY, canvasRef.current!, cameraRef.current);
            if (!raw) return;
            // Priority (spec §10 + drafting aids):
            //   structural object snap (柱中心/壁端点/壁軸/通芯交点) > axis alignment > angle snap > free
            const lastDraftPt = gridDraftMode === "polyline" && gridDraftPoints.length > 0
                ? gridDraftPoints[gridDraftPoints.length - 1]
                : gridStart;
            const refPoints: Vec3[] = [];
            for (const g of grids) {
                if (!g.visible) continue;
                for (const v of gridVertices(g.curve)) refPoints.push(v);
            }
            if (lastDraftPt) refPoints.push(lastDraftPt);
            // 柱・壁端点・壁軸・通芯交点 を網羅する snapForBeam を優先。
            const structSnap = snapForBeam(raw, elements, grids as any, 0.5,
                designMode === "jpResidentialGrid" ? RESIDENTIAL_GRID_SECONDARY_M : undefined);
            const objSnap = snapToGrids(raw, grids);
            let pt: Vec3;
            if (structSnap.kind) {
                pt = structSnap.point;
            } else if (objSnap) {
                pt = objSnap.point;
            } else {
                const axisSnap = snapAxisAlign(raw, refPoints);
                if (axisSnap) {
                    pt = axisSnap.point;
                } else if (lastDraftPt) {
                    const a = snapAngle(lastDraftPt, raw, 45);
                    pt = a ? a.point : raw;
                } else {
                    pt = raw;
                }
            }
            if (gridDraftMode === "polyline") {
                // Click near the first point (and already have ≥3 points)
                // closes / finalizes the polyline.
                if (gridDraftPoints.length >= 3) {
                    const first = gridDraftPoints[0];
                    const closeDist = Math.hypot(pt[0] - first[0], pt[2] - first[2]);
                    if (closeDist < 0.3) {
                        addGridPolyline(gridDraftPoints, gridKind);
                        setGridDraftPoints([]);
                        setGridHover(null);
                        setGridSnap(null);
                        setGridAxisSnap(null);
                        setGridAngleSnap(null);
                        return;
                    }
                }
                setGridDraftPoints([...gridDraftPoints, pt]);
                setGridHover(pt);
                return;
            }
            // Line mode: §6.1 2-point creation
            if (!gridStart) {
                setGridStart(pt);
                setGridHover(pt);
            } else {
                addGrid(gridStart, pt, gridKind);
                setGridStart(null);
                setGridHover(null);
                setGridSnap(null);
                setGridAxisSnap(null);
                setGridAngleSnap(null);
            }
            return;
        }

        if (activeTool === "door" || activeTool === "window") {
            (window as any).__viewportInteracting = true;
            const ray = getRay(e.clientX, e.clientY, canvasRef.current!, cameraRef.current);
            const ground = getGroundIntersection(e.clientX, e.clientY, canvasRef.current!, cameraRef.current);
            const hit = pickWallByRay(ray.origin, ray.dir, ground, elements, sceneRef.current.getObjects());
            if (!hit) return;
            const def = activeTool === "door" ? doorDefaults : windowDefaults;
            const hostWall = elements[hit.wallId] as WallElement | undefined;
            // eslint-disable-next-line no-console
            console.log(
                `[create ${activeTool}] hit=${(hit.wallId as string).slice(0, 6)} ` +
                `pos=${hit.position.toFixed(3)} ` +
                `existingOpenings=${(hostWall?.openings ?? []).length} ` +
                `wallAxis=[(${hostWall?.axis[0][0].toFixed(2)},${hostWall?.axis[0][2].toFixed(2)})→` +
                `(${hostWall?.axis[1][0].toFixed(2)},${hostWall?.axis[1][2].toFixed(2)})] ` +
                `wallFp=${hostWall?.footprint
                    ? hostWall.footprint.map((p) => `(${p[0].toFixed(2)},${p[1].toFixed(2)})`).join(",")
                    : "NONE"}`,
            );
            if (activeTool === "door") {
                executeCommand(new CreateDoorCommand(hit.wallId, hit.position, def.width, def.height));
            } else {
                executeCommand(new CreateWindowCommand(hit.wallId, hit.position, def.width, def.height, def.sillHeight));
            }
            return;
        }

        if (activeTool === "slab" && slabSketching) {
            (window as any).__viewportInteracting = true;
            const raw = getGroundIntersection(e.clientX, e.clientY, canvasRef.current!, cameraRef.current);
            if (!raw) return;
            // Snap to columns / wall endpoints / wall axis / grid (snapForBeam を共用)。
            const snap = snapForBeam(raw, elements, grids as any, 0.5,
                designMode === "jpResidentialGrid" ? RESIDENTIAL_GRID_SECONDARY_M : undefined);
            const pt = snap.point;
            setSlabSnap({ kind: snap.kind });
            // Close the polyline by clicking near the first point (≥3 points in)
            if (slabSketchPoints.length >= 3) {
                const first = slabSketchPoints[0];
                if (Math.hypot(pt[0] - first[0], pt[2] - first[2]) < 0.3) {
                    commitSlabSketch();
                    return;
                }
            }
            setSlabSketchPoints((prev) => [...prev, pt]);
            setSlabSketchHover(pt);
            return;
        }

        if (activeTool === "slab") {
            (window as any).__viewportInteracting = true;
            const pt = getGroundIntersection(e.clientX, e.clientY, canvasRef.current!, cameraRef.current);
            if (!pt) return;
            const hit = pickSpaceAt([pt[0], pt[2]], elements);
            const additive = e.ctrlKey || e.metaKey || e.shiftKey;
            if (hit) {
                if (additive) {
                    setSlabSelectedSpaces((prev) =>
                        prev.includes(hit) ? prev.filter((x) => x !== hit) : [...prev, hit],
                    );
                } else {
                    setSlabSelectedSpaces([hit]);
                }
            } else if (!additive) {
                setSlabSelectedSpaces([]);
            }
            return;
        }

        // Gridline tool, select sub-mode (not drafting): click to pick a grid
        if (activeTool === "gridline" && !gridlineDrafting) {
            (window as any).__viewportInteracting = true;
            const raw = getGroundIntersection(e.clientX, e.clientY, canvasRef.current!, cameraRef.current);
            if (!raw) return;
            const picked = pickGrid(raw, grids);
            const additive = e.ctrlKey || e.metaKey || e.shiftKey;
            if (picked) {
                if (additive) {
                    if (selectedGridIds.includes(picked)) {
                        setSelectedGridIds(selectedGridIds.filter((id) => id !== picked));
                    } else {
                        setSelectedGridIds([...selectedGridIds, picked]);
                    }
                } else {
                    setSelectedGridIds([picked]);
                }
            } else if (!additive) {
                setSelectedGridIds([]);
            }
        }
    };

    const handleDoubleClick = (e: React.MouseEvent) => {
        if (activeTool === "gridline" && gridlineDrafting) {
            e.preventDefault();
            if (gridDraftMode === "polyline" && gridDraftPoints.length >= 2) {
                addGridPolyline(gridDraftPoints, gridKind);
                setGridDraftPoints([]);
                setGridHover(null);
                setGridSnap(null);
                setGridAxisSnap(null);
                setGridAngleSnap(null);
            } else {
                exitGridDrafting();
            }
            return;
        }
        if (activeTool === "slab" && slabSketching) {
            e.preventDefault();
            commitSlabSketch();
            return;
        }
    };

    const handlePointerMove = (e: React.PointerEvent) => {
        if (activeTool === "wall" && wallSubMode === "add") {
            const raw = getGroundIntersection(e.clientX, e.clientY, canvasRef.current!, cameraRef.current);
            if (raw) {
                const snap = unifiedSnap(raw, elements, grids);
                setWallSnap(snap.kind ? snap : null);
                if (wallStart) setWallEnd(snap.point);
            }
        }
        if (activeTool === "wall" && wallSubMode === "select") {
            const raw = getGroundIntersection(e.clientX, e.clientY, canvasRef.current!, cameraRef.current);
            if (raw) {
                const hit = pickSketchItemAt(raw);
                const nextKind: "point" | "edge" | null =
                    hit?.kind === "point" ? "point"
                    : hit?.kind === "edge" || hit?.kind === "wallAxis" ? "edge"
                    : null;
                if (nextKind !== wallSketchHoverKind) setWallSketchHoverKind(nextKind);
            } else if (wallSketchHoverKind !== null) {
                setWallSketchHoverKind(null);
            }
        }

        if (activeTool === "gridline" && gridlineDrafting) {
            const raw = getGroundIntersection(e.clientX, e.clientY, canvasRef.current!, cameraRef.current);
            if (raw) {
                const lastDraftPt = gridDraftMode === "polyline" && gridDraftPoints.length > 0
                    ? gridDraftPoints[gridDraftPoints.length - 1]
                    : gridStart;
                const refPoints: Vec3[] = [];
                for (const g of grids) {
                    if (!g.visible) continue;
                    for (const v of gridVertices(g.curve)) refPoints.push(v);
                }
                if (lastDraftPt) refPoints.push(lastDraftPt);
                // 構造体スナップ (柱・壁端点・壁軸) を最優先、次に通芯スナップ。
                const structSnap = snapForBeam(raw, elements, grids as any, 0.5,
                    designMode === "jpResidentialGrid" ? RESIDENTIAL_GRID_SECONDARY_M : undefined);
                const objSnap = snapToGrids(raw, grids);
                let axisSnap: AxisAlignSnapResult | null = null;
                let angleDeg: number | null = null;
                let pt: Vec3;
                let snapForMarker: GridSnapResult | null = objSnap;
                if (structSnap.kind) {
                    pt = structSnap.point;
                    // gridSnap state はマーカー表示用にも使われる。Endpoint
                    // 種別の合成オブジェクトを置く。
                    snapForMarker = { point: structSnap.point, kind: "Endpoint", gridIds: [] };
                } else if (objSnap) {
                    pt = objSnap.point;
                } else {
                    axisSnap = snapAxisAlign(raw, refPoints);
                    if (axisSnap) {
                        pt = axisSnap.point;
                    } else if (lastDraftPt) {
                        const a = snapAngle(lastDraftPt, raw, 45);
                        if (a) {
                            angleDeg = a.angleDeg;
                            pt = a.point;
                        } else {
                            pt = raw;
                        }
                    } else {
                        pt = raw;
                    }
                }
                setGridSnap(snapForMarker);
                setGridAxisSnap(axisSnap);
                setGridAngleSnap(angleDeg);
                if (lastDraftPt) setGridHover(pt);
            }
        }

        if (activeTool === "slab" && slabSketching) {
            const raw = getGroundIntersection(e.clientX, e.clientY, canvasRef.current!, cameraRef.current);
            if (raw) {
                const snap = snapForBeam(raw, elements, grids as any, 0.5,
                    designMode === "jpResidentialGrid" ? RESIDENTIAL_GRID_SECONDARY_M : undefined);
                setSlabSnap({ kind: snap.kind });
                // hover はスナップマーカーの位置にも使うので、最初の点が無くても更新する。
                setSlabSketchHover(snap.point);
            }
        }

        if (activeTool === "beam") {
            // ドラッグ中はドラッグハンドラ側で snap state を管理。
            if (beamDragState) {
                // skip — handled by beam drag block above
            } else if (beamSubMode === "edit") {
                // 編集サブモードでドラッグしていない時はスナップしない。
                if (beamSnap.kind) setBeamSnap({ kind: null });
                if (beamHover) setBeamHover(null);
            } else {
                const raw = getGroundIntersection(e.clientX, e.clientY, canvasRef.current!, cameraRef.current);
                if (raw) {
                    const snap = snapForBeam(raw, elements, grids as any, 0.5, designMode === "jpResidentialGrid" ? RESIDENTIAL_GRID_SECONDARY_M : undefined);
                    setBeamSnap({ kind: snap.kind });
                    setBeamHover(snap.point);
                }
            }
        }

        if (activeTool === "column") {
            // ドラッグ中はドラッグハンドラ側で snap state を管理 (= 二重計算
            // 回避 / 自身を含めて毎フレーム吸着して marker が出続ける問題を防ぐ)。
            if (columnDragState) {
                // skip — already handled by drag block above
            } else if (columnSubMode === "edit") {
                // 編集サブモードでドラッグしていない時はスナップしない
                // (= マーカーを出さない / 既存柱の上を撫でただけで吸着挙動が
                //   走ると邪魔)。
                if (columnSnap.kind) setColumnSnap({ kind: null });
                if (columnHover) setColumnHover(null);
            } else {
                const raw = getGroundIntersection(e.clientX, e.clientY, canvasRef.current!, cameraRef.current);
                if (raw) {
                    const snap = snapForBeam(raw, elements, grids as any, 0.5, designMode === "jpResidentialGrid" ? RESIDENTIAL_GRID_SECONDARY_M : undefined);
                    setColumnSnap({ kind: snap.kind });
                    setColumnHover(snap.point);
                }
            }
        }

        if (activeTool === "door" || activeTool === "window") {
            const ray = getRay(e.clientX, e.clientY, canvasRef.current!, cameraRef.current);
            const ground = getGroundIntersection(e.clientX, e.clientY, canvasRef.current!, cameraRef.current);
            const hit = pickWallByRay(ray.origin, ray.dir, ground, elements, sceneRef.current.getObjects());
            if (hit) {
                if (!openingHover || openingHover.wallId !== hit.wallId || Math.abs(openingHover.position - hit.position) > 0.001) {
                    setOpeningHover(hit);
                }
            } else if (openingHover) {
                setOpeningHover(null);
            }
        }

        if (dragState) {
            const pt = getGroundIntersection(e.clientX, e.clientY, canvasRef.current!, cameraRef.current);
            if (!pt) return;
            dragState.affected.forEach(item => {
                const el = elements[item.id] as WallElement;
                if (!el) return;
                const newAxis = [...el.axis] as [Vec3, Vec3];
                newAxis[item.index] = pt;
                updateElement(item.id, { axis: newAxis, dirtyFlags: new Set([...el.dirtyFlags, "Geometry", "Mesh", "Render"]) } as any);
            });
        }

        // Beam 編集モードのドラッグ: handle に応じて端点 or 平行移動。
        if (beamDragState) {
            const raw = getGroundIntersection(e.clientX, e.clientY, canvasRef.current!, cameraRef.current);
            if (!raw) return;
            // ドラッグ中の梁は snap 対象から除外 (= 自身の最新端点に吸着して
            // 震えるのを防ぐ)。
            const elementsExSelf = { ...elements };
            delete elementsExSelf[beamDragState.beamId];
            const snap = snapForBeam(raw, elementsExSelf, grids as any, 0.5,
                designMode === "jpResidentialGrid" ? RESIDENTIAL_GRID_SECONDARY_M : undefined);
            const target = snap.kind ? snap.point : raw;
            let nextAxis: [Vec3, Vec3];
            if (beamDragState.handle === "body") {
                const dx = target[0] - beamDragState.startPt[0];
                const dz = target[2] - beamDragState.startPt[2];
                nextAxis = [
                    [beamDragState.origAxis[0][0] + dx, beamDragState.origAxis[0][1], beamDragState.origAxis[0][2] + dz],
                    [beamDragState.origAxis[1][0] + dx, beamDragState.origAxis[1][1], beamDragState.origAxis[1][2] + dz],
                ];
            } else if (beamDragState.handle === "start") {
                nextAxis = [
                    [target[0], beamDragState.origAxis[0][1], target[2]],
                    [...beamDragState.origAxis[1]] as Vec3,
                ];
            } else {
                nextAxis = [
                    [...beamDragState.origAxis[0]] as Vec3,
                    [target[0], beamDragState.origAxis[1][1], target[2]],
                ];
            }
            const moved =
                Math.hypot(nextAxis[0][0] - beamDragState.origAxis[0][0],
                           nextAxis[0][2] - beamDragState.origAxis[0][2]) > 1e-6 ||
                Math.hypot(nextAxis[1][0] - beamDragState.origAxis[1][0],
                           nextAxis[1][2] - beamDragState.origAxis[1][2]) > 1e-6;
            const beam = elements[beamDragState.beamId] as BeamElement | undefined;
            if (beam) {
                updateElement(beamDragState.beamId, {
                    axis: nextAxis,
                    dirtyFlags: new Set([...(beam.dirtyFlags ?? []), "Geometry", "Mesh", "Render"]),
                } as any);
            }
            // marker は snap が当たっている時だけ表示 (= "ずっと出続ける" 防止)。
            setBeamSnap({ kind: snap.kind });
            setBeamHover(snap.kind ? snap.point : null);
            setBeamDragState({ ...beamDragState, finalAxis: nextAxis, moved });
        }

        // Column ドラッグ: 柱中心 / 壁端点 / 壁軸 / 通芯 にスナップしながら
        // basePoint を live で更新。pointerup で UpdateColumnBasePointCommand を
        // 1 回だけ発行して undo/redo を 1 ステップに集約する (= dirty な中間
        // 状態を history に積まない)。
        if (columnDragState) {
            const raw = getGroundIntersection(e.clientX, e.clientY, canvasRef.current!, cameraRef.current);
            if (!raw) return;
            const dx = raw[0] - columnDragState.startPt[0];
            const dz = raw[2] - columnDragState.startPt[2];
            // ターゲット位置 = orig + delta、その位置を中心に snapForBeam で吸着。
            const target: Vec3 = [
                columnDragState.origBasePoint[0] + dx,
                columnDragState.origBasePoint[1],
                columnDragState.origBasePoint[2] + dz,
            ];
            // ドラッグ中の柱は snap 対象から除外 (= 自身の最新位置に吸着して
            // 震えるのを防ぐ)。shallow copy で削除。
            const elementsExSelf = { ...elements };
            delete elementsExSelf[columnDragState.columnId];
            const snap = snapForBeam(target, elementsExSelf, grids as any, 0.5,
                designMode === "jpResidentialGrid" ? RESIDENTIAL_GRID_SECONDARY_M : undefined);
            const finalPt: Vec3 = snap.kind ? snap.point : target;
            // スナップマーカー (緑十字) の表示を制御。snap が当たった時だけ
            // 表示。snap が無ければ marker を消す (= "ずっと出続ける" 防止)。
            setColumnSnap({ kind: snap.kind });
            setColumnHover(snap.kind ? snap.point : null);
            const moved = Math.hypot(
                finalPt[0] - columnDragState.origBasePoint[0],
                finalPt[2] - columnDragState.origBasePoint[2],
            ) > 1e-6;
            // live 更新: basePoint を直接書き換え (履歴に積まない)。
            const col = elements[columnDragState.columnId] as ColumnElement | undefined;
            if (col && col.type === "Column") {
                updateElement(columnDragState.columnId, {
                    basePoint: finalPt,
                    dirtyFlags: new Set([...(col.dirtyFlags ?? []), "Geometry", "Mesh", "Render"]),
                } as any);
            }
            setColumnDragState({ ...columnDragState, finalPoint: finalPt, moved });
        }
    };

    const handlePointerUp = () => {
        setDragState(null);
        // Beam edit drag finalize.
        if (beamDragState && beamDragState.moved) {
            const beam = useAppState.getState().elements[beamDragState.beamId] as BeamElement | undefined;
            if (beam && beam.type === "Beam") {
                useAppState.getState().updateElement(beamDragState.beamId, {
                    axis: beamDragState.origAxis,
                } as any);
                executeCommand(new UpdateBeamAxisCommand(
                    beamDragState.beamId as any,
                    beamDragState.finalAxis,
                ));
                runSketchSolver();
            }
        }
        setBeamDragState(null);
        // Column drag finalize: undo/redo 用に Command を発行 (= ドラッグ全体で
        // 1 ステップ)。orig→final が動いていなければ何もしない。
        if (columnDragState && columnDragState.moved) {
            // live 更新で basePoint は既に finalPoint に。一度 orig に戻して
            // Command.execute で oldBasePoint を正しくスナップさせる。
            const col = useAppState.getState().elements[columnDragState.columnId] as ColumnElement | undefined;
            if (col && col.type === "Column") {
                useAppState.getState().updateElement(columnDragState.columnId, {
                    basePoint: columnDragState.origBasePoint,
                } as any);
                executeCommand(new UpdateColumnBasePointCommand(
                    columnDragState.columnId as any,
                    columnDragState.finalPoint,
                ));
                // ドラッグ後に拘束を再適用 — 距離拘束等を満たす位置へ補正。
                runSketchSolver();
                // Column 移動で壁の柱クリップが変わるので壁を再生成。
                triggerWallRegenIfEnabled("column-move");
            }
        }
        setColumnDragState(null);
        (window as any).__viewportInteracting = false;
    };

    const handleContextMenu = (e: React.MouseEvent) => {
        e.preventDefault();
        setWallStart(null);
        setWallEnd(null);
        setWallSnap(null);
        if (activeTool === "beam") {
            setBeamStart(null);
            setBeamHover(null);
        }
        if (activeTool === "gridline" && gridlineDrafting) {
            // Cancel in-progress polyline / segment without exiting the tool
            setGridDraftPoints([]);
            setGridStart(null);
            setGridHover(null);
            setGridSnap(null);
            setGridAxisSnap(null);
            setGridAngleSnap(null);
        }
    };

    return (
        <div className="w-full h-full bg-white relative select-none">
            <canvas
                ref={canvasRef}
                className={`w-full h-full block ${
                    activeTool === "select" ? "cursor-default"
                    : activeTool === "wall" && wallSubMode === "select"
                        ? (wallSketchHoverKind === "point" ? "cursor-crosshair"
                            : wallSketchHoverKind === "edge" ? "cursor-pointer"
                            : "cursor-default")
                    : activeTool === "gridline" && !gridlineDrafting ? "cursor-pointer"
                    : "cursor-crosshair"
                }`}
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp}
                onDoubleClick={handleDoubleClick}
                onContextMenu={handleContextMenu}
            />
            <GridBubbleOverlay
                getCamera={() => cameraRef.current}
                getCanvas={() => canvasRef.current}
            />
            <GridEditOverlay
                getCamera={() => cameraRef.current}
                getCanvas={() => canvasRef.current}
            />
            {activeRoomId && (
                <ConstraintIconOverlay
                    getCamera={() => cameraRef.current}
                    getCanvas={() => canvasRef.current}
                />
            )}
            <RoomLabelOverlay
                getCamera={() => cameraRef.current}
                getCanvas={() => canvasRef.current}
            />
            <ResidentialGridOverlay
                getCamera={() => cameraRef.current}
                getCanvas={() => canvasRef.current}
            />
            <DesignModeToggle />
            <div className="absolute top-4 left-4 text-xs text-zinc-600 bg-white/80 border border-zinc-200 px-2 py-1 rounded shadow-sm pointer-events-none" style={{ zIndex: 20 }}>
                Navigation: Orbit (LMB), Pan (RMB/MMB), Zoom (Scroll)
                {activeTool === "wall" && " | Wall mode: Click to place points. Right-click to cancel/finish."}
                {wallStart && " | Placing wall..."}
                {(activeRoomId || pendingRoomLevelId) && " | Room edit mode (Esc to exit)"}
                {activeTool === "column" && " | 柱作成(2D): クリックで配置 / 通芯交点・既存柱にスナップ (Esc で終了)"}
                {activeTool === "beam" && !beamStart && " | 梁作成(2D): 始点をクリック / 柱中心・通芯にスナップ"}
                {activeTool === "beam" && beamStart && " | 梁作成: 2点目をクリック / 右クリックでキャンセル / 連続配置中"}
                {activeTool === "slab" && !slabSketching && " | 床作成(2D/部屋選択): 部屋をクリックで選択 → 右上「Spaceから作成」 (Esc で終了)"}
                {activeTool === "slab" && slabSketching && " | 床作成(手動スケッチ): クリックで点追加 / 最初の点付近クリック・Enter・ダブルクリックで閉じて作成"}
                {activeTool === "door" && " | ドア配置: 壁にホバー → クリックで配置 (Esc で終了)"}
                {activeTool === "window" && " | 窓配置: 壁にホバー → クリックで配置 (Esc で終了)"}
                {activeTool === "gridline" && !gridlineDrafting && " | 通芯モード(選択): クリックで選択 / Ctrl+クリックで追加選択 / Deleteで削除"}
                {activeTool === "gridline" && gridlineDrafting && gridDraftMode === "line" && !gridStart && " | 通芯作成 (Line): 1点目をクリック"}
                {activeTool === "gridline" && gridlineDrafting && gridDraftMode === "line" && gridStart && " | 通芯作成 (Line): 2点目をクリックで確定"}
                {activeTool === "gridline" && gridlineDrafting && gridDraftMode === "polyline" && gridDraftPoints.length === 0 && " | 通芯作成 (Polyline): 1点目をクリック"}
                {activeTool === "gridline" && gridlineDrafting && gridDraftMode === "polyline" && gridDraftPoints.length > 0 && ` | 通芯作成 (Polyline): ${gridDraftPoints.length}点目 / Enter・ダブルクリックで確定 / 右クリックでキャンセル`}
            </div>
            {/* Floating constraint panel: visible in select mode, room edit
                mode, and wall mode (so constraints can be applied to the
                current sketch selection while drawing walls). */}
            {(activeTool === "select" || activeTool === "wall" || activeRoomId) && (
                <div className="absolute bottom-4 right-4 w-64" style={{ zIndex: 25 }}>
                    <div className="bg-zinc-900/95 border border-zinc-700 rounded shadow-lg p-2 text-zinc-100">
                        <ConstraintPanel />
                    </div>
                </div>
            )}
            {activeTool === "column" && (
                <div className="absolute top-4 right-4 w-60" style={{ zIndex: 20 }}>
                    <div className="bg-white/95 border border-zinc-300 rounded shadow-sm p-2 space-y-2 text-zinc-700">
                        <div className="flex items-center justify-between">
                            <div className="text-[10px] font-semibold text-zinc-500 uppercase">柱{columnSubMode === "edit" ? "編集" : "作成"}</div>
                            <button
                                className="text-[10px] px-2 py-0.5 rounded border bg-zinc-200 border-zinc-300 hover:bg-zinc-300 text-zinc-700"
                                onClick={() => setActiveTool("select")}
                                title="ツールを終了 (Esc)"
                            >終了</button>
                        </div>
                        {/* サブモード切替: 配置 / 編集 */}
                        <div className="flex gap-1">
                            <button
                                className={`flex-1 text-[10px] py-1 rounded border ${columnSubMode === "add" ? "bg-blue-600 text-white border-blue-500" : "bg-zinc-100 border-zinc-300 hover:bg-zinc-200"}`}
                                onClick={() => setColumnSubMode("add")}
                            >配置</button>
                            <button
                                className={`flex-1 text-[10px] py-1 rounded border ${columnSubMode === "edit" ? "bg-blue-600 text-white border-blue-500" : "bg-zinc-100 border-zinc-300 hover:bg-zinc-200"}`}
                                onClick={() => setColumnSubMode("edit")}
                            >編集</button>
                        </div>
                        <div className="text-[10px] text-zinc-500">
                            {columnSubMode === "edit"
                                ? "既存の柱をドラッグして移動 (柱中心 / 壁端点 / 壁軸 / 通芯にスナップ)"
                                : "クリックで配置 / 通芯交点・既存柱にスナップ"}
                        </div>
                        {/* Type picker — 配置時に使う ColumnType を選ぶ。Profile 等の入力欄は
                            この Type に対する override として渡される。 */}
                        {columnSubMode === "add" && <TypePickerChip categoryId="Column" />}
                        <div>
                            <div className="text-[10px] text-zinc-500 mb-0.5">Profile (override)</div>
                            <div className="flex gap-1">
                                {(["Rectangle", "Circle"] as const).map((k) => (
                                    <button
                                        key={k}
                                        className={`flex-1 text-[10px] py-1 rounded border ${columnProfileKind === k ? "bg-blue-600 text-white border-blue-500" : "bg-zinc-100 border-zinc-300 hover:bg-zinc-200"}`}
                                        onClick={() => setColumnProfileKind(k)}
                                    >{k}</button>
                                ))}
                            </div>
                        </div>
                        {columnProfileKind === "Rectangle" ? (
                            <>
                                <div className="flex items-center gap-1">
                                    <span className="text-[10px] text-zinc-500 w-10">幅</span>
                                    <input className="flex-1 min-w-0 text-[10px] px-1 py-0.5 bg-white border border-zinc-300 rounded" type="number" step="0.05" value={columnWidthInput} onChange={(e) => setColumnWidthInput(e.target.value)} />
                                    <span className="text-[10px] text-zinc-500">m</span>
                                </div>
                                <div className="flex items-center gap-1">
                                    <span className="text-[10px] text-zinc-500 w-10">せい</span>
                                    <input className="flex-1 min-w-0 text-[10px] px-1 py-0.5 bg-white border border-zinc-300 rounded" type="number" step="0.05" value={columnDepthInput} onChange={(e) => setColumnDepthInput(e.target.value)} />
                                    <span className="text-[10px] text-zinc-500">m</span>
                                </div>
                            </>
                        ) : (
                            <div className="flex items-center gap-1">
                                <span className="text-[10px] text-zinc-500 w-10">半径</span>
                                <input className="flex-1 min-w-0 text-[10px] px-1 py-0.5 bg-white border border-zinc-300 rounded" type="number" step="0.05" value={columnRadiusInput} onChange={(e) => setColumnRadiusInput(e.target.value)} />
                                <span className="text-[10px] text-zinc-500">m</span>
                            </div>
                        )}
                        <div className="flex items-center gap-1">
                            <span className="text-[10px] text-zinc-500 w-10">回転</span>
                            <input className="flex-1 min-w-0 text-[10px] px-1 py-0.5 bg-white border border-zinc-300 rounded" type="number" step="15" value={columnRotationInput} onChange={(e) => setColumnRotationInput(e.target.value)} />
                            <span className="text-[10px] text-zinc-500">°</span>
                        </div>
                        <div>
                            <div className="text-[10px] text-zinc-500 mb-0.5">Base Level</div>
                            <select
                                className="w-full text-[10px] px-1 py-0.5 bg-white border border-zinc-300 rounded"
                                value={columnBaseLevelId ?? ""}
                                onChange={(e) => setColumnBaseLevelId(e.target.value || undefined)}
                            >
                                <option value="">(none)</option>
                                {levels.map((l) => (
                                    <option key={l.id as string} value={l.id as string}>{l.name} ({(l.elevation * 1000).toFixed(0)}mm)</option>
                                ))}
                            </select>
                        </div>
                        <div>
                            <div className="text-[10px] text-zinc-500 mb-0.5">Top Level</div>
                            <select
                                className="w-full text-[10px] px-1 py-0.5 bg-white border border-zinc-300 rounded"
                                value={columnTopLevelId ?? ""}
                                onChange={(e) => setColumnTopLevelId(e.target.value || undefined)}
                            >
                                <option value="">(none)</option>
                                {levels.map((l) => (
                                    <option key={l.id as string} value={l.id as string}>{l.name} ({(l.elevation * 1000).toFixed(0)}mm)</option>
                                ))}
                            </select>
                        </div>
                        <div className="flex items-center gap-1">
                            <span className="text-[10px] text-zinc-500 w-10">BaseOS</span>
                            <input className="flex-1 min-w-0 text-[10px] px-1 py-0.5 bg-white border border-zinc-300 rounded" type="number" step="0.05" value={columnBaseOffsetInput} onChange={(e) => setColumnBaseOffsetInput(e.target.value)} />
                            <span className="text-[10px] text-zinc-500">m</span>
                        </div>
                        <div className="flex items-center gap-1">
                            <span className="text-[10px] text-zinc-500 w-10">TopOS</span>
                            <input className="flex-1 min-w-0 text-[10px] px-1 py-0.5 bg-white border border-zinc-300 rounded" type="number" step="0.05" value={columnTopOffsetInput} onChange={(e) => setColumnTopOffsetInput(e.target.value)} />
                            <span className="text-[10px] text-zinc-500">m</span>
                        </div>
                        <label className="flex items-center gap-1 text-[10px] text-zinc-600">
                            <input type="checkbox" checked={columnChainMode} onChange={(e) => setColumnChainMode(e.target.checked)} />
                            連続配置 (chain mode)
                        </label>
                        {columnSnap.kind && (
                            <div className="text-[10px] text-emerald-600 font-medium">SNAP: {columnSnap.kind}</div>
                        )}
                    </div>
                </div>
            )}
            {activeTool === "beam" && (
                <div className="absolute top-4 right-4 w-56" style={{ zIndex: 20 }}>
                    <div className="bg-white/95 border border-zinc-300 rounded shadow-sm p-2 space-y-2 text-zinc-700">
                        <div className="flex items-center justify-between">
                            <div className="text-[10px] font-semibold text-zinc-500 uppercase">梁{beamSubMode === "edit" ? "編集" : "作成"}</div>
                            <button
                                className="text-[10px] px-2 py-0.5 rounded border bg-zinc-200 border-zinc-300 hover:bg-zinc-300 text-zinc-700"
                                onClick={() => setActiveTool("select")}
                                title="ツールを終了 (Esc)"
                            >終了</button>
                        </div>
                        {/* サブモード切替: 配置 / 編集 */}
                        <div className="flex gap-1">
                            <button
                                className={`flex-1 text-[10px] py-1 rounded border ${beamSubMode === "add" ? "bg-blue-600 text-white border-blue-500" : "bg-zinc-100 border-zinc-300 hover:bg-zinc-200"}`}
                                onClick={() => {
                                    setBeamSubMode("add");
                                    setBeamStart(null);
                                    setBeamHover(null);
                                }}
                            >配置</button>
                            <button
                                className={`flex-1 text-[10px] py-1 rounded border ${beamSubMode === "edit" ? "bg-blue-600 text-white border-blue-500" : "bg-zinc-100 border-zinc-300 hover:bg-zinc-200"}`}
                                onClick={() => {
                                    setBeamSubMode("edit");
                                    setBeamStart(null);
                                    setBeamHover(null);
                                }}
                            >編集</button>
                        </div>
                        <div className="text-[10px] text-zinc-500">
                            {beamSubMode === "edit"
                                ? "梁の端点 / 中央をドラッグ (端点 = 形状変更, 中央 = 平行移動)"
                                : (beamStart ? "2点目をクリック (右クリックでキャンセル)" : "始点をクリック")}
                        </div>
                        {beamSubMode === "add" && <TypePickerChip categoryId="Beam" />}
                        <div className="text-[10px] text-zinc-500 font-semibold">Profile (override / Rectangle)</div>
                        <div className="flex items-center gap-1">
                            <span className="text-[10px] text-zinc-500 w-10">幅</span>
                            <input
                                className="flex-1 min-w-0 text-[10px] px-1 py-0.5 bg-white border border-zinc-300 rounded"
                                type="number"
                                step="0.05"
                                value={beamWidthInput}
                                onChange={(e) => setBeamWidthInput(e.target.value)}
                            />
                            <span className="text-[10px] text-zinc-500">m</span>
                        </div>
                        <div className="flex items-center gap-1">
                            <span className="text-[10px] text-zinc-500 w-10">せい</span>
                            <input
                                className="flex-1 min-w-0 text-[10px] px-1 py-0.5 bg-white border border-zinc-300 rounded"
                                type="number"
                                step="0.05"
                                value={beamDepthInput}
                                onChange={(e) => setBeamDepthInput(e.target.value)}
                            />
                            <span className="text-[10px] text-zinc-500">m</span>
                        </div>
                        <div className="flex items-center gap-1">
                            <span className="text-[10px] text-zinc-500 w-10">上端OS</span>
                            <input
                                className="flex-1 min-w-0 text-[10px] px-1 py-0.5 bg-white border border-zinc-300 rounded"
                                type="number"
                                step="0.05"
                                value={beamTopOffsetInput}
                                onChange={(e) => setBeamTopOffsetInput(e.target.value)}
                            />
                            <span className="text-[10px] text-zinc-500">m</span>
                        </div>
                        <div>
                            <div className="text-[10px] text-zinc-500 mb-0.5">Base Level</div>
                            <select
                                className="w-full text-[10px] px-1 py-0.5 bg-white border border-zinc-300 rounded"
                                value={beamLevelId ?? ""}
                                onChange={(e) => setBeamLevelId(e.target.value || undefined)}
                            >
                                <option value="">(none)</option>
                                {levels.map((l) => (
                                    <option key={l.id as string} value={l.id as string}>{l.name} ({(l.elevation * 1000).toFixed(0)}mm)</option>
                                ))}
                            </select>
                        </div>
                        <div>
                            <div className="text-[10px] text-zinc-500 mb-0.5">Z Justification</div>
                            <div className="flex gap-1">
                                {(["Top", "Center", "Bottom"] as const).map((z) => (
                                    <button
                                        key={z}
                                        className={`flex-1 text-[10px] py-1 rounded border ${beamZJust === z ? "bg-blue-600 text-white border-blue-500" : "bg-zinc-100 border-zinc-300 hover:bg-zinc-200"}`}
                                        onClick={() => setBeamZJust(z)}
                                    >{z}</button>
                                ))}
                            </div>
                        </div>
                        <label className="flex items-center gap-1 text-[10px] text-zinc-600">
                            <input
                                type="checkbox"
                                checked={beamChainMode}
                                onChange={(e) => setBeamChainMode(e.target.checked)}
                            />
                            連続配置 (chain mode)
                        </label>
                        {beamSnap.kind && (
                            <div className="text-[10px] text-emerald-600 font-medium">SNAP: {beamSnap.kind}</div>
                        )}
                    </div>
                </div>
            )}
            {activeTool === "slab" && (
                <div className="absolute top-4 right-4 w-56" style={{ zIndex: 20 }}>
                    <div className="bg-white/95 border border-zinc-300 rounded shadow-sm p-2 space-y-2 text-zinc-700">
                        <div className="flex items-center justify-between">
                            <div className="text-[10px] font-semibold text-zinc-500 uppercase">床作成</div>
                            <button
                                className="text-[10px] px-2 py-0.5 rounded border bg-zinc-200 border-zinc-300 hover:bg-zinc-300 text-zinc-700"
                                onClick={() => setActiveTool("select")}
                                title="ツールを終了 (Esc)"
                            >ツール終了</button>
                        </div>
                        <div className="text-[10px] text-zinc-500">
                            モード: <span className="font-semibold text-zinc-700">{slabSketching ? "手動スケッチ" : "部屋選択"}</span>
                        </div>
                        <TypePickerChip categoryId="Slab" />
                        <div className="flex items-center gap-1">
                            <span className="text-[10px] text-zinc-500 w-10">厚さ(OR)</span>
                            <input
                                className="flex-1 min-w-0 text-[10px] px-1 py-0.5 bg-white border border-zinc-300 rounded"
                                type="number"
                                step="0.01"
                                value={slabThicknessInput}
                                onChange={(e) => setSlabThicknessInput(e.target.value)}
                            />
                            <span className="text-[10px] text-zinc-500">m</span>
                        </div>
                        <div>
                            <div className="text-[10px] text-zinc-500 mb-0.5">Base Level</div>
                            <select
                                className="w-full text-[10px] px-1 py-0.5 bg-white border border-zinc-300 rounded"
                                value={slabLevelId ?? ""}
                                onChange={(e) => setSlabLevelId(e.target.value || undefined)}
                            >
                                <option value="">(none)</option>
                                {levels.map((l) => (
                                    <option key={l.id as string} value={l.id as string}>{l.name} ({(l.elevation * 1000).toFixed(0)}mm)</option>
                                ))}
                            </select>
                        </div>
                        <div className="flex items-center gap-1">
                            <span className="text-[10px] text-zinc-500 w-10">高さOS</span>
                            <input
                                className="flex-1 min-w-0 text-[10px] px-1 py-0.5 bg-white border border-zinc-300 rounded"
                                type="number"
                                step="0.05"
                                value={slabElevationOffsetInput}
                                onChange={(e) => setSlabElevationOffsetInput(e.target.value)}
                            />
                            <span className="text-[10px] text-zinc-500">m</span>
                        </div>
                        {!slabSketching ? (
                            <>
                                <div className="text-[10px] text-zinc-500">
                                    部屋をクリックで選択 / Ctrl+クリックで追加選択
                                </div>
                                <div className="text-[10px] text-zinc-500">選択中: {slabSelectedSpaces.length} 部屋</div>
                                <button
                                    className="w-full px-3 py-1 text-xs rounded border bg-blue-600 border-blue-500 text-white hover:bg-blue-500 disabled:opacity-40 disabled:bg-zinc-300 disabled:border-zinc-300 disabled:text-zinc-500"
                                    disabled={slabSelectedSpaces.length === 0}
                                    onClick={() => {
                                        const thickness = parseFloat(slabThicknessInput);
                                        const t = Number.isFinite(thickness) && thickness > 0 ? thickness : 0.2;
                                        const elev = parseFloat(slabElevationOffsetInput);
                                        const e = Number.isFinite(elev) ? elev : 0;
                                        const slabTypeId = useAppState.getState().activeTypeIdByCategory.Slab;
                                        if (!slabTypeId) {
                                            console.warn("[slab] no active SlabType");
                                            return;
                                        }
                                        let created = 0;
                                        let skipped = 0;
                                        for (const sid of slabSelectedSpaces) {
                                            const cmd = CreateSlabCommand.fromSpace(sid as any, slabTypeId as any);
                                            if (!cmd) { skipped++; continue; }
                                            // UI 入力で level / elevation / 厚みを上書き。
                                            cmd.elevation = e;
                                            cmd.overrides = { thickness: t };
                                            if (slabLevelId) cmd.levelId = slabLevelId as any;
                                            executeCommand(cmd);
                                            created++;
                                        }
                                        if (skipped > 0) {
                                            console.warn(`${skipped} 部屋は閉じたポリラインではないためスキップしました`);
                                        }
                                        if (created > 0) setSlabSelectedSpaces([]);
                                    }}
                                    title="選択した部屋の壁内側輪郭から床を生成"
                                >Spaceから作成</button>
                                <button
                                    className="w-full px-3 py-1 text-xs rounded border bg-zinc-100 border-zinc-300 hover:bg-zinc-200"
                                    onClick={() => {
                                        setSlabSelectedSpaces([]);
                                        setSlabSketchPoints([]);
                                        setSlabSketchHover(null);
                                        setSlabSketching(true);
                                    }}
                                    title="ポリラインを描いて床を手動作成"
                                >手動スケッチ</button>
                            </>
                        ) : (
                            <>
                                <div className="text-[10px] text-zinc-500">
                                    クリックで点追加 / 最初の点付近をクリック・Enter・ダブルクリックで閉じる
                                </div>
                                <div className="text-[10px] text-zinc-500">点数: {slabSketchPoints.length}</div>
                                <button
                                    className="w-full px-3 py-1 text-xs rounded border bg-blue-600 border-blue-500 text-white hover:bg-blue-500 disabled:opacity-40 disabled:bg-zinc-300 disabled:border-zinc-300 disabled:text-zinc-500"
                                    disabled={slabSketchPoints.length < 3}
                                    onClick={commitSlabSketch}
                                    title="閉じたポリラインから床を作成 (点3以上)"
                                >閉じて作成</button>
                                <button
                                    className="w-full px-3 py-1 text-xs rounded border bg-zinc-100 border-zinc-300 hover:bg-zinc-200"
                                    onClick={() => {
                                        setSlabSketchPoints([]);
                                        setSlabSketchHover(null);
                                        setSlabSketching(false);
                                    }}
                                >キャンセル</button>
                            </>
                        )}
                    </div>
                </div>
            )}
            {activeTool === "wall" && wallSubMode === "add" && !activeRoomId && !pendingRoomLevelId && (
                <div className="absolute top-4 right-4 w-56" style={{ zIndex: 20 }}>
                    <div className="bg-white/95 border border-zinc-300 rounded shadow-sm p-2 space-y-2 text-zinc-700">
                        <div className="flex items-center justify-between">
                            <div className="text-[10px] font-semibold text-zinc-500 uppercase">壁作成</div>
                            <button
                                className="text-[10px] px-2 py-0.5 rounded border bg-zinc-200 border-zinc-300 hover:bg-zinc-300 text-zinc-700"
                                onClick={() => setActiveTool("select")}
                                title="ツールを終了 (Esc)"
                            >終了</button>
                        </div>
                        {/* 壁 Type ピッカー — 配置時に使う WallType を選ぶ。 */}
                        <TypePickerChip categoryId="Wall" />
                        <div className="text-[10px] text-zinc-500">
                            {wallStart
                                ? "2点目をクリック (右クリックでキャンセル)"
                                : "始点をクリック / 通芯にスナップ"}
                        </div>
                    </div>
                </div>
            )}
            {(activeTool === "door" || activeTool === "window") && (
                <div className="absolute top-4 right-4 w-48" style={{ zIndex: 20 }}>
                    <div className="bg-white/95 border border-zinc-300 rounded shadow-sm p-2 space-y-2 text-zinc-700">
                        <div className="flex items-center justify-between">
                            <div className="text-[10px] font-semibold text-zinc-500 uppercase">
                                {activeTool === "door" ? "ドア配置" : "窓配置"}
                            </div>
                            <button
                                className="text-[10px] px-2 py-0.5 rounded border bg-zinc-200 border-zinc-300 hover:bg-zinc-300 text-zinc-700"
                                onClick={() => setActiveTool("select")}
                                title="ツールを終了 (Esc)"
                            >終了</button>
                        </div>
                        <div className="text-[10px] text-zinc-500">
                            {activeTool === "door"
                                ? `W ${doorDefaults.width}m × H ${doorDefaults.height}m`
                                : `W ${windowDefaults.width}m × H ${windowDefaults.height}m / SH ${windowDefaults.sillHeight}m`}
                        </div>
                        <div className="text-[10px] text-zinc-500">
                            壁にホバーしてクリックで配置
                        </div>
                    </div>
                </div>
            )}
            {activeTool === "gridline" && (
                <div className="absolute top-4 right-4 flex flex-col gap-2 w-48" style={{ zIndex: 20 }}>
                    <div className="bg-white/95 border border-zinc-300 rounded shadow-sm p-2 space-y-2 text-zinc-700">
                        <div className="flex items-center justify-between">
                            <div className="text-[10px] font-semibold text-zinc-500 uppercase">通芯ツール</div>
                            <button
                                className="text-[10px] px-2 py-0.5 rounded border bg-zinc-200 border-zinc-300 hover:bg-zinc-300 text-zinc-700"
                                onClick={() => setActiveTool("select")}
                                title="通芯ツールを終了 (Esc)"
                            >ツール終了</button>
                        </div>
                        <div className="text-[10px] text-zinc-500">
                            モード: <span className="font-semibold text-zinc-700">{gridlineDrafting ? "描画" : "選択"}</span>
                        </div>
                        <div>
                            <div className="text-[10px] text-zinc-500 mb-1">形状</div>
                            <div className="flex gap-1">
                                <button
                                    className={`flex-1 text-[10px] py-1 rounded border ${gridDraftMode === "line" ? "bg-zinc-700 text-white border-zinc-600" : "bg-zinc-100 border-zinc-300 hover:bg-zinc-200"}`}
                                    onClick={() => {
                                        setGridDraftMode("line");
                                        setGridDraftPoints([]);
                                    }}
                                    title="2点を指定して直線を作成"
                                >Line</button>
                                <button
                                    className={`flex-1 text-[10px] py-1 rounded border ${gridDraftMode === "polyline" ? "bg-zinc-700 text-white border-zinc-600" : "bg-zinc-100 border-zinc-300 hover:bg-zinc-200"}`}
                                    onClick={() => {
                                        setGridDraftMode("polyline");
                                        setGridStart(null);
                                    }}
                                    title="3点以上のポリラインを作成 (Enter/ダブルクリックで確定)"
                                >Polyline</button>
                            </div>
                        </div>
                        <button
                            className={`w-full px-3 py-1 text-xs rounded border ${gridlineDrafting ? "bg-red-600 border-red-400 text-white" : "bg-zinc-100 border-zinc-300 hover:bg-zinc-200"}`}
                            onClick={() => {
                                if (gridlineDrafting) {
                                    exitGridDrafting();
                                } else {
                                    setGridStart(null);
                                    setGridHover(null);
                                    setGridSnap(null);
                                    setGridAngleSnap(null);
                                    setGridAxisSnap(null);
                                    setGridDraftPoints([]);
                                    setSelectedGridIds([]);
                                    setGridlineDrafting(true);
                                }
                            }}
                        >
                            {gridlineDrafting ? "描画終了" : "追加"}
                        </button>
                        {!gridlineDrafting && (
                            <div className="space-y-1">
                                <div className="text-[10px] text-zinc-500">選択中: {selectedGridIds.length}</div>
                                <div className="flex gap-1">
                                    <button
                                        className="flex-1 text-[10px] py-1 rounded border bg-zinc-100 border-zinc-300 hover:bg-zinc-200 disabled:opacity-40"
                                        disabled={selectedGridIds.length === 0}
                                        onClick={() => setSelectedGridIds([])}
                                    >選択解除</button>
                                    <button
                                        className="flex-1 text-[10px] py-1 rounded border bg-red-600 border-red-500 text-white hover:bg-red-500 disabled:opacity-40 disabled:bg-zinc-300 disabled:border-zinc-300 disabled:text-zinc-500"
                                        disabled={selectedGridIds.length === 0}
                                        onClick={() => removeGrids(selectedGridIds)}
                                        title="選択した通芯を削除 (Delete)"
                                    >削除</button>
                                </div>
                            </div>
                        )}
                        <div>
                            <div className="text-[10px] text-zinc-500 mb-1">系列</div>
                            <div className="flex gap-1">
                                <button
                                    className={`flex-1 text-[10px] py-1 rounded border ${gridKind === "Primary" ? "bg-red-600 text-white border-red-500" : "bg-zinc-100 border-zinc-300 hover:bg-zinc-200"}`}
                                    onClick={() => setGridKind("Primary")}
                                >Primary</button>
                                <button
                                    className={`flex-1 text-[10px] py-1 rounded border ${gridKind === "Auxiliary" ? "bg-orange-500 text-white border-orange-400" : "bg-zinc-100 border-zinc-300 hover:bg-zinc-200"}`}
                                    onClick={() => setGridKind("Auxiliary")}
                                >Aux</button>
                            </div>
                        </div>
                        <div>
                            <div className="text-[10px] text-zinc-500 mb-1">連続作成 (オフセット)</div>
                            <div className="flex gap-1">
                                <input
                                    className="flex-1 min-w-0 text-[10px] px-1 py-1 bg-white border border-zinc-300 rounded"
                                    type="number"
                                    step="0.1"
                                    value={offsetInput}
                                    onChange={(e) => setOffsetInput(e.target.value)}
                                />
                                <button
                                    className="text-[10px] px-2 py-1 rounded border bg-zinc-100 border-zinc-300 hover:bg-zinc-200 disabled:opacity-40"
                                    disabled={grids.length === 0}
                                    onClick={() => {
                                        const d = parseFloat(offsetInput);
                                        if (Number.isFinite(d) && d !== 0) offsetLastGrid(d, gridKind);
                                    }}
                                    title="直前の通芯と平行に1本作成"
                                >+1</button>
                            </div>
                        </div>
                        <div>
                            <button
                                className="w-full text-[10px] py-1 rounded border bg-zinc-100 border-zinc-300 hover:bg-zinc-200"
                                onClick={() => setShowArrayPanel(!showArrayPanel)}
                            >
                                {showArrayPanel ? "配列作成 ▴" : "配列作成 ▾"}
                            </button>
                            {showArrayPanel && (
                                <div className="mt-1 p-1.5 bg-zinc-50 border border-zinc-200 rounded space-y-1">
                                    <div className="flex items-center gap-1">
                                        <span className="text-[10px] text-zinc-500 w-10">ピッチ</span>
                                        <input
                                            className="flex-1 min-w-0 text-[10px] px-1 py-0.5 bg-white border border-zinc-300 rounded"
                                            type="number"
                                            step="0.1"
                                            value={arrayPitch}
                                            onChange={(e) => setArrayPitch(e.target.value)}
                                        />
                                    </div>
                                    <div className="flex items-center gap-1">
                                        <span className="text-[10px] text-zinc-500 w-10">本数</span>
                                        <input
                                            className="flex-1 min-w-0 text-[10px] px-1 py-0.5 bg-white border border-zinc-300 rounded"
                                            type="number"
                                            step="1"
                                            value={arrayCount}
                                            onChange={(e) => setArrayCount(e.target.value)}
                                        />
                                    </div>
                                    <button
                                        className="w-full text-[10px] py-1 rounded bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-40"
                                        disabled={grids.length === 0}
                                        onClick={() => {
                                            const last = grids[grids.length - 1];
                                            if (!last || last.curve.type !== "Line") return;
                                            const pitch = parseFloat(arrayPitch);
                                            const count = parseInt(arrayCount, 10);
                                            if (!Number.isFinite(pitch) || !Number.isFinite(count) || count < 1) return;
                                            createGridArray(last.curve.start, last.curve.end, pitch, count, gridKind);
                                        }}
                                        title="直前の通芯を基準に配列生成"
                                    >生成</button>
                                </div>
                            )}
                        </div>
                        <div className="text-[10px] text-zinc-500">通芯数: {grids.length}</div>
                        {gridSnap && (
                            <div className="text-[10px] text-emerald-600 font-medium">SNAP: {gridSnap.kind}</div>
                        )}
                        {!gridSnap && gridAxisSnap && (
                            <div className="text-[10px] text-sky-600 font-medium">
                                SNAP: {gridAxisSnap.axis === "both" ? "H+V" : gridAxisSnap.axis === "horizontal" ? "Horizontal" : "Vertical"}
                            </div>
                        )}
                        {!gridSnap && !gridAxisSnap && gridAngleSnap !== null && (
                            <div className="text-[10px] text-emerald-600 font-medium">SNAP: {gridAngleSnap}°</div>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
});

export default Viewport;
