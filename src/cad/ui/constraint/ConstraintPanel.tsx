"use client";

import React, { useState } from "react";
import { useAppState, AppState, SketchSelectionItem, sketchSelectionKey } from "../../application/AppState";
import { Constraint, ConstraintTarget, ConstraintType } from "../../model/constraint/Constraint";
import { SpaceElement, RoomPolygon } from "../../model/elements/SpaceElement";
import { Vec2 } from "../../geometry/math/Vec2";
import { AddConstraintCommand, RemoveConstraintCommand, generateConstraintId } from "../../commands/create/AddConstraintCommand";

// Tessellation density used when re-generating a circle's outer ring from
// its parametric (center, radius) — must match RoomSketchOverlay's value.
const CIRCLE_TESS = 128;
function tessellateCircle(center: Vec2, radius: number): Vec2[] {
    const pts: Vec2[] = [];
    for (let i = 0; i < CIRCLE_TESS; i++) {
        const a = (i / CIRCLE_TESS) * Math.PI * 2;
        pts.push([center[0] + Math.cos(a) * radius, center[1] + Math.sin(a) * radius]);
    }
    return pts;
}

// 拘束パネル。選択状態は AppState.sketchSelection を参照する。
// ユーザはビューポート上で頂点 / エッジをクリックして選択し、選択の構成
// に応じて適用可能な拘束条件のみをこのパネルに表示する。

const selKey = sketchSelectionKey;

// 各ポリゴンの頂点 / エッジに対し、ポリゴン順 + ローカルインデックス順で
// 通し番号を振る。例: 1 番目のポリゴン (4 頂点) → エッジ 1..4, 頂点 1..4。
// 2 番目のポリゴン (5 頂点) → エッジ 5..9, 頂点 5..9。
function buildLabelMap(polys: RoomPolygon[]): Map<string, string> {
    const m = new Map<string, string>();
    let edgeAcc = 0, vertAcc = 0, circleAcc = 0;
    for (const p of polys) {
        if (p.shape?.type === "circle") {
            circleAcc += 1;
            m.set(`c:${p.id}`, `円 ${circleAcc}`);
            continue;
        }
        const n = p.outer.length;
        for (let e = 0; e < n; e++) m.set(`e:${p.id}:${e}`, `エッジ ${edgeAcc + e + 1}`);
        for (let v = 0; v < n; v++) m.set(`p:${p.id}:${v}`, `頂点 ${vertAcc + v + 1}`);
        edgeAcc += n;
        vertAcc += n;
    }
    return m;
}

function itemLabel(item: SketchSelectionItem, labelMap: Map<string, string>): string {
    let k: string;
    if (item.kind === "edge") k = `e:${item.polyId}:${item.edgeIdx}`;
    else if (item.kind === "point") k = `p:${item.polyId}:${item.vertexIdx}`;
    else if (item.kind === "circle") k = `c:${item.polyId}`;
    else if (item.kind === "wallAxis") k = `w:${item.wallId}`;
    else k = `wp:${item.wallId}:${item.endIdx}`;
    return labelMap.get(k) ?? k;
}

export default function ConstraintPanel() {
    const activeRoomId = useAppState((s: AppState) => s.activeRoomId);
    const elements = useAppState((s: AppState) => s.elements);
    const grids = useAppState((s: AppState) => s.grids);
    const constraints = useAppState((s: AppState) => s.constraints);
    const executeCommand = useAppState((s: AppState) => s.executeCommand);
    const updateElement = useAppState((s: AppState) => s.updateElement);
    const selection = useAppState((s: AppState) => s.sketchSelection);
    const toggleSketchSelection = useAppState((s: AppState) => s.toggleSketchSelection);
    const clearSketchSelection = useAppState((s: AppState) => s.clearSketchSelection);

    const [gridIdForOnGrid, setGridIdForOnGrid] = useState<string>("");
    const [lengthValue, setLengthValue] = useState<string>("");
    const [angleValue, setAngleValue] = useState<string>("");
    const [radiusValue, setRadiusValue] = useState<string>("");
    const [diameterValue, setDiameterValue] = useState<string>("");
    const [perpDistValue, setPerpDistValue] = useState<string>("");

    const room = activeRoomId ? (elements[activeRoomId as string] as SpaceElement | undefined) : undefined;
    const polys: RoomPolygon[] = room?.polygons ?? [];
    const labelMap = React.useMemo(() => buildLabelMap(polys), [polys]);

    const edgeSel = selection.filter((s): s is Extract<SketchSelectionItem, { kind: "edge" }> => s.kind === "edge");
    const pointSel = selection.filter((s): s is Extract<SketchSelectionItem, { kind: "point" }> => s.kind === "point");
    const circleSel = selection.filter((s): s is Extract<SketchSelectionItem, { kind: "circle" }> => s.kind === "circle");
    const wallAxisSel = selection.filter((s): s is Extract<SketchSelectionItem, { kind: "wallAxis" }> => s.kind === "wallAxis");
    const wallPointSel = selection.filter((s): s is Extract<SketchSelectionItem, { kind: "wallPoint" }> => s.kind === "wallPoint");

    // Unified "edge-like" selection view so edge-type constraints (Horizontal,
    // Length, Parallel, etc.) accept both room polygon edges and standalone
    // wall axes in the same action. Position-preserving union: edges first,
    // then wall axes, matching user pick order is good-enough for pair-wise
    // constraints where order matters (Parallel / Perpendicular pick the
    // first two).
    const edgeLikeSel: SketchSelectionItem[] = [...edgeSel, ...wallAxisSel];
    const toEdgeTarget = (s: SketchSelectionItem): ConstraintTarget | null => {
        if (s.kind === "edge") {
            return { kind: "SketchEdge", spaceId: s.spaceId, polyId: s.polyId, edgeIdx: s.edgeIdx };
        }
        if (s.kind === "wallAxis") {
            return { kind: "WallAxis", wallId: s.wallId };
        }
        return null;
    };

    // Unified "point-like" view — polygon vertices + wall axis endpoints.
    // Used by Coincident / PerpDistance / PointOnGrid so wall endpoints are
    // first-class constraint targets.
    const pointLikeSel: SketchSelectionItem[] = [...pointSel, ...wallPointSel];
    const toPointTarget = (s: SketchSelectionItem): ConstraintTarget | null => {
        if (s.kind === "point") {
            return { kind: "SketchPoint", spaceId: s.spaceId, polyId: s.polyId, vertexIdx: s.vertexIdx };
        }
        if (s.kind === "wallPoint") {
            return { kind: "WallAxisPoint", wallId: s.wallId, endIdx: s.endIdx };
        }
        return null;
    };

    const add = (c: Constraint) => {
        executeCommand(new AddConstraintCommand(c));
    };
    const mkC = (type: ConstraintType, targets: ConstraintTarget[], value?: number): Constraint => ({
        id: generateConstraintId(), type, targets, value,
    });

    // ── Constraint actions ──
    const addHorizontal = () => {
        for (const s of edgeLikeSel) {
            const t = toEdgeTarget(s);
            if (t) add(mkC("Horizontal", [t]));
        }
    };
    const addVertical = () => {
        for (const s of edgeLikeSel) {
            const t = toEdgeTarget(s);
            if (t) add(mkC("Vertical", [t]));
        }
    };
    const addLength = () => {
        const v = parseFloat(lengthValue);
        if (!Number.isFinite(v) || v <= 0) return;
        for (const s of edgeLikeSel) {
            const t = toEdgeTarget(s);
            if (t) add(mkC("Length", [t], v));
        }
    };
    const addParallel = () => {
        if (edgeLikeSel.length < 2) return;
        const t0 = toEdgeTarget(edgeLikeSel[0]);
        const t1 = toEdgeTarget(edgeLikeSel[1]);
        if (!t0 || !t1) return;
        add(mkC("Parallel", [t0, t1]));
    };
    const addPerpendicular = () => {
        if (edgeLikeSel.length < 2) return;
        const t0 = toEdgeTarget(edgeLikeSel[0]);
        const t1 = toEdgeTarget(edgeLikeSel[1]);
        if (!t0 || !t1) return;
        add(mkC("Perpendicular", [t0, t1]));
    };
    const addPerpDistance = () => {
        if (pointLikeSel.length !== 1 || edgeLikeSel.length !== 1) return;
        const v = parseFloat(perpDistValue);
        if (!Number.isFinite(v) || v < 0) return;
        const et = toEdgeTarget(edgeLikeSel[0]);
        const pt = toPointTarget(pointLikeSel[0]);
        if (!et || !pt) return;
        add(mkC("PerpDistance", [pt, et], v));
    };
    const addEqualLength = () => {
        if (edgeLikeSel.length < 2) return;
        // Pre-align is polygon-only: resize each subsequent polygon edge to
        // match the first selection's length. Wall axes skip pre-alignment —
        // the solver handles them without seeding.
        const first = edgeLikeSel[0];
        let targetLen = 0;
        if (first.kind === "edge") {
            const spaceFirst = elements[first.spaceId as string] as SpaceElement | undefined;
            const polyFirst = spaceFirst?.polygons?.find((p) => p.id === first.polyId);
            if (polyFirst && polyFirst.shape?.type !== "circle") {
                const nF = polyFirst.outer.length;
                const aF = polyFirst.outer[first.edgeIdx];
                const bF = polyFirst.outer[(first.edgeIdx + 1) % nF];
                targetLen = Math.hypot(bF[0] - aF[0], bF[1] - aF[1]);
            }
        } else if (first.kind === "wallAxis") {
            const w = elements[first.wallId as string] as any;
            if (w && w.type === "Wall") {
                targetLen = Math.hypot(w.axis[1][0] - w.axis[0][0], w.axis[1][2] - w.axis[0][2]);
            }
        }
        if (targetLen > 1e-9) {
            for (let k = 1; k < edgeLikeSel.length; k++) {
                const e = edgeLikeSel[k];
                if (e.kind !== "edge") continue;
                const space = elements[e.spaceId as string] as SpaceElement | undefined;
                const poly = space?.polygons?.find((p) => p.id === e.polyId);
                if (!poly || poly.shape?.type === "circle") continue;
                const n = poly.outer.length;
                const sIdx = e.edgeIdx;
                const eIdx = (e.edgeIdx + 1) % n;
                const s = poly.outer[sIdx];
                const end = poly.outer[eIdx];
                const dx = end[0] - s[0], dy = end[1] - s[1];
                const len = Math.hypot(dx, dy);
                if (len < 1e-9) continue;
                const ux = dx / len, uy = dy / len;
                const newEnd: Vec2 = [s[0] + ux * targetLen, s[1] + uy * targetLen];
                const newOuter = poly.outer.map((p, i) => (i === eIdx ? newEnd : p));
                patchPoly(e.spaceId as string, e.polyId, { outer: newOuter });
            }
        }
        const targets = edgeLikeSel.map(toEdgeTarget).filter((t): t is ConstraintTarget => t !== null);
        if (targets.length >= 2) add(mkC("EqualLength", targets));
    };
    const addCollinear = () => {
        if (edgeLikeSel.length < 2) return;
        const a = edgeLikeSel[0], b = edgeLikeSel[1];
        const tA = toEdgeTarget(a);
        const tB = toEdgeTarget(b);
        if (!tA || !tB) return;

        // Pre-alignment: project B's endpoints onto A's infinite line. Only
        // applies to polygon-edge B — wall-axis B endpoints are moved by the
        // solver instead.
        const polyAInfo: { aStart: Vec2; aEnd: Vec2 } | null = (() => {
            if (a.kind === "edge") {
                const space = elements[a.spaceId as string] as SpaceElement | undefined;
                const poly = space?.polygons?.find((p) => p.id === a.polyId);
                if (!poly || poly.shape?.type === "circle") return null;
                const nA = poly.outer.length;
                return { aStart: poly.outer[a.edgeIdx], aEnd: poly.outer[(a.edgeIdx + 1) % nA] };
            }
            if (a.kind === "wallAxis") {
                const w = elements[a.wallId as string] as any;
                if (!w || w.type !== "Wall") return null;
                return {
                    aStart: [w.axis[0][0], w.axis[0][2]] as Vec2,
                    aEnd: [w.axis[1][0], w.axis[1][2]] as Vec2,
                };
            }
            return null;
        })();
        if (polyAInfo && b.kind === "edge") {
            const spaceB = elements[b.spaceId as string] as SpaceElement | undefined;
            const polyB = spaceB?.polygons?.find((p) => p.id === b.polyId);
            if (polyB && polyB.shape?.type !== "circle") {
                const nB = polyB.outer.length;
                const dxa = polyAInfo.aEnd[0] - polyAInfo.aStart[0];
                const dya = polyAInfo.aEnd[1] - polyAInfo.aStart[1];
                const lenA = Math.hypot(dxa, dya);
                if (lenA > 1e-9) {
                    const ux = dxa / lenA, uy = dya / lenA;
                    const project = (p: Vec2): Vec2 => {
                        const t = (p[0] - polyAInfo.aStart[0]) * ux + (p[1] - polyAInfo.aStart[1]) * uy;
                        return [polyAInfo.aStart[0] + ux * t, polyAInfo.aStart[1] + uy * t];
                    };
                    const bStartIdx = b.edgeIdx;
                    const bEndIdx = (b.edgeIdx + 1) % nB;
                    const newOuter = polyB.outer.map((p, i) => {
                        if (i === bStartIdx || i === bEndIdx) return project(p);
                        return p;
                    });
                    patchPoly(b.spaceId as string, b.polyId, { outer: newOuter });
                }
            }
        }

        add(mkC("Collinear", [tA, tB]));
    };
    const addAngle = () => {
        if (edgeLikeSel.length < 2) return;
        const deg = parseFloat(angleValue);
        if (!Number.isFinite(deg)) return;
        const rad = (deg * Math.PI) / 180;

        const a = edgeLikeSel[0], b = edgeLikeSel[1];
        const tA = toEdgeTarget(a);
        const tB = toEdgeTarget(b);
        if (!tA || !tB) return;

        // Pre-align is skipped when wall axes are involved — let the solver
        // rotate axis endpoints freely. The rigid-polygon-rotate path below
        // only applies when both selections are polygon edges.
        if (a.kind === "edge" && b.kind === "edge") {
            const spaceA = elements[a.spaceId as string] as SpaceElement | undefined;
            const polyA = spaceA?.polygons?.find((p) => p.id === a.polyId);
            const spaceB = elements[b.spaceId as string] as SpaceElement | undefined;
            const polyB = spaceB?.polygons?.find((p) => p.id === b.polyId);
            if (polyA && polyB
                && polyA.shape?.type !== "circle" && polyB.shape?.type !== "circle") {
                const nA = polyA.outer.length;
                const aStart = polyA.outer[a.edgeIdx];
                const aEnd = polyA.outer[(a.edgeIdx + 1) % nA];
                const nB = polyB.outer.length;
                const bStart = polyB.outer[b.edgeIdx];
                const bEnd = polyB.outer[(b.edgeIdx + 1) % nB];
                const dxa = aEnd[0] - aStart[0], dya = aEnd[1] - aStart[1];
                const dxb = bEnd[0] - bStart[0], dyb = bEnd[1] - bStart[1];
                const lenA = Math.hypot(dxa, dya);
                const lenB = Math.hypot(dxb, dyb);
                if (lenA > 1e-9 && lenB > 1e-9) {
                    const angleA = Math.atan2(dya, dxa);
                    const targetB = angleA + rad;
                    const samePolygon = a.spaceId === b.spaceId && a.polyId === b.polyId;
                    if (samePolygon) {
                        const bEndIdx = (b.edgeIdx + 1) % nB;
                        const newBEnd: Vec2 = [
                            bStart[0] + Math.cos(targetB) * lenB,
                            bStart[1] + Math.sin(targetB) * lenB,
                        ];
                        const newOuter = polyB.outer.map((p, i) => (i === bEndIdx ? newBEnd : p));
                        patchPoly(b.spaceId as string, b.polyId, { outer: newOuter });
                    } else {
                        const angleBCurrent = Math.atan2(dyb, dxb);
                        const rotation = targetB - angleBCurrent;
                        let cx = 0, cy = 0;
                        for (const p of polyB.outer) { cx += p[0]; cy += p[1]; }
                        cx /= polyB.outer.length;
                        cy /= polyB.outer.length;
                        const cosR = Math.cos(rotation), sinR = Math.sin(rotation);
                        const newOuter: Vec2[] = polyB.outer.map((p) => {
                            const dx = p[0] - cx, dy = p[1] - cy;
                            return [cx + dx * cosR - dy * sinR, cy + dx * sinR + dy * cosR];
                        });
                        patchPoly(b.spaceId as string, b.polyId, { outer: newOuter });
                    }
                }
            }
        }

        add(mkC("Angle", [tA, tB], rad));
    };
    const addCoincident = () => {
        if (pointLikeSel.length < 2) return;
        const a = pointLikeSel[0], b = pointLikeSel[1];
        const tA = toPointTarget(a);
        const tB = toPointTarget(b);
        if (!tA || !tB) return;

        // Pre-align B → A so the constraint starts satisfied. Only applied
        // when both endpoints are polygon vertices (the existing well-tested
        // path); wall-axis endpoints skip pre-align and let the solver pull.
        if (a.kind === "point" && b.kind === "point") {
            const spaceA = elements[a.spaceId as string] as SpaceElement | undefined;
            const polyA = spaceA?.polygons?.find((p) => p.id === a.polyId);
            const spaceB = elements[b.spaceId as string] as SpaceElement | undefined;
            const polyB = spaceB?.polygons?.find((p) => p.id === b.polyId);
            if (polyA && polyB && polyA.shape?.type !== "circle" && polyB.shape?.type !== "circle"
                && a.vertexIdx >= 0 && a.vertexIdx < polyA.outer.length
                && b.vertexIdx >= 0 && b.vertexIdx < polyB.outer.length) {
                const target = polyA.outer[a.vertexIdx];
                if (a.spaceId === b.spaceId && a.polyId === b.polyId) {
                    const newOuter = polyB.outer.map((p, i) =>
                        i === b.vertexIdx ? [target[0], target[1]] as Vec2 : p,
                    );
                    patchPoly(b.spaceId as string, b.polyId, { outer: newOuter });
                } else {
                    const src = polyB.outer[b.vertexIdx];
                    const dx = target[0] - src[0];
                    const dy = target[1] - src[1];
                    if (Math.hypot(dx, dy) > 1e-9) {
                        const newOuter = polyB.outer.map((p) => [p[0] + dx, p[1] + dy] as Vec2);
                        patchPoly(b.spaceId as string, b.polyId, { outer: newOuter });
                    }
                }
            }
        }

        add(mkC("Coincident", [tA, tB]));
    };
    const addPointOnGrid = () => {
        if (pointLikeSel.length === 0 || !gridIdForOnGrid) return;
        for (const s of pointLikeSel) {
            const pt = toPointTarget(s);
            if (!pt) continue;
            add(mkC("PointOnGrid", [pt, { kind: "Grid", gridId: gridIdForOnGrid }]));
        }
    };
    // Pre-align a polygon so the constraint starts in a satisfied state.
    // Without this, the solver often drifts geometry far from initial positions
    // because all parameters are equally free. Patching the *second* selected
    // element at commit time gives the expected "move B to match A" UX.
    const patchPoly = (spaceId: string, polyId: string, patch: Partial<RoomPolygon>) => {
        const space = elements[spaceId as string] as SpaceElement | undefined;
        if (!space) return;
        const newPolys = space.polygons.map((p) =>
            p.id === polyId ? { ...p, ...patch } : p,
        );
        updateElement(spaceId as any, {
            polygons: newPolys,
            dirtyFlags: new Set([...space.dirtyFlags, "Geometry", "Mesh", "Render"]),
        } as any);
    };

    const getCirclePoly = (spaceId: string, polyId: string): RoomPolygon | null => {
        const space = elements[spaceId as string] as SpaceElement | undefined;
        const poly = space?.polygons?.find((p) => p.id === polyId);
        return poly?.shape?.type === "circle" ? poly : null;
    };

    const addCircleRadius = () => {
        const v = parseFloat(radiusValue);
        if (!Number.isFinite(v) || v <= 0) return;
        for (const c of circleSel) {
            add(mkC("CircleRadius", [{ kind: "SketchCircle", spaceId: c.spaceId, polyId: c.polyId }], v));
        }
    };
    const addCircleDiameter = () => {
        const v = parseFloat(diameterValue);
        if (!Number.isFinite(v) || v <= 0) return;
        for (const c of circleSel) {
            add(mkC("CircleDiameter", [{ kind: "SketchCircle", spaceId: c.spaceId, polyId: c.polyId }], v));
        }
    };
    const addPointOnCircle = () => {
        if (pointSel.length === 0 || circleSel.length !== 1) return;
        const c = circleSel[0];
        const circlePoly = getCirclePoly(c.spaceId as string, c.polyId);
        if (!circlePoly || circlePoly.shape?.type !== "circle") return;
        // Pre-align each point to the nearest point on the circumference.
        const { center, radius } = circlePoly.shape;
        for (const p of pointSel) {
            const space = elements[p.spaceId as string] as SpaceElement | undefined;
            const poly = space?.polygons?.find((pp) => pp.id === p.polyId);
            if (!space || !poly || poly.shape?.type === "circle") continue;
            const vx = poly.outer[p.vertexIdx];
            if (!vx) continue;
            const dx = vx[0] - center[0], dy = vx[1] - center[1];
            const d = Math.hypot(dx, dy);
            // If the vertex is at the center, project along +x by default.
            const ux = d < 1e-9 ? 1 : dx / d;
            const uy = d < 1e-9 ? 0 : dy / d;
            const newPt: Vec2 = [center[0] + ux * radius, center[1] + uy * radius];
            const newOuter = poly.outer.map((q, i) => (i === p.vertexIdx ? newPt : q));
            patchPoly(p.spaceId as string, p.polyId, { outer: newOuter });
        }
        for (const p of pointSel) {
            add(mkC("PointOnCircle", [
                { kind: "SketchPoint", spaceId: p.spaceId, polyId: p.polyId, vertexIdx: p.vertexIdx },
                { kind: "SketchCircle", spaceId: c.spaceId, polyId: c.polyId },
            ]));
        }
    };
    const addTangent = () => {
        if (circleSel.length === 2) {
            // Pre-align: shift B so centers are at distance (rA + rB) along the
            // current A→B direction (external tangency). If already coincident,
            // any direction works — pick +x.
            const a = getCirclePoly(circleSel[0].spaceId as string, circleSel[0].polyId);
            const b = getCirclePoly(circleSel[1].spaceId as string, circleSel[1].polyId);
            if (a?.shape?.type === "circle" && b?.shape?.type === "circle") {
                const ca = a.shape.center, cb = b.shape.center;
                const dx = cb[0] - ca[0], dy = cb[1] - ca[1];
                const d = Math.hypot(dx, dy);
                const need = a.shape.radius + b.shape.radius;
                const ux = d < 1e-9 ? 1 : dx / d;
                const uy = d < 1e-9 ? 0 : dy / d;
                const newCenter: Vec2 = [ca[0] + ux * need, ca[1] + uy * need];
                patchPoly(circleSel[1].spaceId as string, circleSel[1].polyId, {
                    outer: tessellateCircle(newCenter, b.shape.radius),
                    shape: { type: "circle", center: newCenter, radius: b.shape.radius },
                });
            }
            add(mkC("Tangent", [
                { kind: "SketchCircle", spaceId: circleSel[0].spaceId, polyId: circleSel[0].polyId },
                { kind: "SketchCircle", spaceId: circleSel[1].spaceId, polyId: circleSel[1].polyId },
            ]));
        } else if (circleSel.length === 1 && edgeSel.length === 1) {
            // Pre-align: translate the circle so the foot of perpendicular from
            // its center onto the edge's infinite line is at distance = radius.
            const c = circleSel[0];
            const e = edgeSel[0];
            const circlePoly = getCirclePoly(c.spaceId as string, c.polyId);
            const space = elements[e.spaceId as string] as SpaceElement | undefined;
            const edgePoly = space?.polygons?.find((p) => p.id === e.polyId);
            if (circlePoly?.shape?.type === "circle" && edgePoly) {
                const n = edgePoly.outer.length;
                const pa = edgePoly.outer[e.edgeIdx];
                const pb = edgePoly.outer[(e.edgeIdx + 1) % n];
                const ex = pb[0] - pa[0], ey = pb[1] - pa[1];
                const el = Math.hypot(ex, ey) || 1;
                const nx = -ey / el, ny = ex / el; // unit normal
                const { center, radius } = circlePoly.shape;
                // Signed perpendicular distance from edge line to circle center
                const sd = (center[0] - pa[0]) * nx + (center[1] - pa[1]) * ny;
                const side = sd >= 0 ? 1 : -1;
                const correction = side * radius - sd;
                const newCenter: Vec2 = [center[0] + nx * correction, center[1] + ny * correction];
                patchPoly(c.spaceId as string, c.polyId, {
                    outer: tessellateCircle(newCenter, radius),
                    shape: { type: "circle", center: newCenter, radius },
                });
            }
            add(mkC("Tangent", [
                { kind: "SketchEdge", spaceId: edgeSel[0].spaceId, polyId: edgeSel[0].polyId, edgeIdx: edgeSel[0].edgeIdx },
                { kind: "SketchCircle", spaceId: circleSel[0].spaceId, polyId: circleSel[0].polyId },
            ]));
        }
    };
    const addConcentric = () => {
        if (circleSel.length < 2) return;
        // Pre-align: shift circle B so its center equals circle A's center.
        const a = getCirclePoly(circleSel[0].spaceId as string, circleSel[0].polyId);
        const b = getCirclePoly(circleSel[1].spaceId as string, circleSel[1].polyId);
        if (a?.shape?.type === "circle" && b?.shape?.type === "circle") {
            const newCenter: Vec2 = [a.shape.center[0], a.shape.center[1]];
            patchPoly(circleSel[1].spaceId as string, circleSel[1].polyId, {
                outer: tessellateCircle(newCenter, b.shape.radius),
                shape: { type: "circle", center: newCenter, radius: b.shape.radius },
            });
        }
        add(mkC("ConcentricCircle", [
            { kind: "SketchCircle", spaceId: circleSel[0].spaceId, polyId: circleSel[0].polyId },
            { kind: "SketchCircle", spaceId: circleSel[1].spaceId, polyId: circleSel[1].polyId },
        ]));
    };
    const addEqualRadius = () => {
        if (circleSel.length < 2) return;
        // Pre-align: set circle B's radius to circle A's radius.
        const a = getCirclePoly(circleSel[0].spaceId as string, circleSel[0].polyId);
        const b = getCirclePoly(circleSel[1].spaceId as string, circleSel[1].polyId);
        if (a?.shape?.type === "circle" && b?.shape?.type === "circle") {
            const newR = a.shape.radius;
            patchPoly(circleSel[1].spaceId as string, circleSel[1].polyId, {
                outer: tessellateCircle(b.shape.center, newR),
                shape: { type: "circle", center: b.shape.center, radius: newR },
            });
        }
        add(mkC("EqualRadius", [
            { kind: "SketchCircle", spaceId: circleSel[0].spaceId, polyId: circleSel[0].polyId },
            { kind: "SketchCircle", spaceId: circleSel[1].spaceId, polyId: circleSel[1].polyId },
        ]));
    };

    // Constraints that reference any currently selected sketch entity
    // (polygon edge / polygon vertex / circle / wall axis / wall endpoint).
    const relatedConstraints: Constraint[] = React.useMemo(() => {
        const out: Constraint[] = [];
        const seen = new Set<string>();
        const edgeKeys = new Set(edgeSel.map((s) => `${s.spaceId}:${s.polyId}:${s.edgeIdx}`));
        const pointKeys = new Set(pointSel.map((s) => `${s.spaceId}:${s.polyId}:${s.vertexIdx}`));
        const circleKeys = new Set(circleSel.map((s) => `${s.spaceId}:${s.polyId}`));
        const wallAxisKeys = new Set(wallAxisSel.map((s) => s.wallId as string));
        const wallPointKeys = new Set(wallPointSel.map((s) => `${s.wallId}:${s.endIdx}`));
        for (const cid in constraints) {
            const c = constraints[cid];
            for (const t of c.targets) {
                if (t.kind === "SketchEdge" && edgeKeys.has(`${t.spaceId}:${t.polyId}:${t.edgeIdx}`)) {
                    if (!seen.has(c.id)) { seen.add(c.id); out.push(c); }
                }
                if (t.kind === "SketchPoint" && pointKeys.has(`${t.spaceId}:${t.polyId}:${t.vertexIdx}`)) {
                    if (!seen.has(c.id)) { seen.add(c.id); out.push(c); }
                }
                if (t.kind === "SketchCircle" && circleKeys.has(`${t.spaceId}:${t.polyId}`)) {
                    if (!seen.has(c.id)) { seen.add(c.id); out.push(c); }
                }
                if (t.kind === "WallAxis" && wallAxisKeys.has(t.wallId as string)) {
                    if (!seen.has(c.id)) { seen.add(c.id); out.push(c); }
                }
                if (t.kind === "WallAxisPoint" && wallPointKeys.has(`${t.wallId}:${t.endIdx}`)) {
                    if (!seen.has(c.id)) { seen.add(c.id); out.push(c); }
                }
            }
        }
        return out;
    }, [constraints, edgeSel, pointSel, circleSel, wallAxisSel, wallPointSel]);

    const removeC = (cid: string) => {
        executeCommand(new RemoveConstraintCommand(cid));
    };

    // Panel is active when any sketch entity is selectable — room polygons,
    // wall axes, or both. Previously this required `room` (room-edit mode),
    // which blocked wall-mode constraint work entirely.
    if (!room && wallAxisSel.length === 0 && selection.length === 0) {
        return (
            <div className="space-y-1 text-xs">
                <div className="text-zinc-300 font-medium">拘束</div>
                <div className="text-[10px] text-zinc-500">
                    作図線 (ポリゴンエッジ / 壁軸) をクリックで選択してください。
                </div>
            </div>
        );
    }

    const btn = "text-[10px] py-1 px-2 rounded border bg-zinc-800 border-zinc-700 hover:bg-zinc-700 text-zinc-200";
    const btnWide = `w-full ${btn}`;

    // Applicable constraint flags — edge-like counts (polygon edges + wall
    // axes) drive edge-type constraints so both kinds participate equally.
    const nEdges = edgeLikeSel.length;
    const nPoints = pointLikeSel.length;
    const nCircles = circleSel.length;
    const onlyEdges = nEdges > 0 && nPoints === 0 && nCircles === 0;
    const onlyPoints = nPoints > 0 && nEdges === 0 && nCircles === 0;
    const onlyCircles = nCircles > 0 && nEdges === 0 && nPoints === 0;
    const canHV = onlyEdges && nEdges >= 1;
    const canLength = onlyEdges && nEdges >= 1;
    const canParallel = onlyEdges && nEdges >= 2;
    const canPerpendicular = onlyEdges && nEdges >= 2;
    const canAngle = onlyEdges && nEdges === 2;
    const canCollinear = onlyEdges && nEdges === 2;
    const canEqualLength = onlyEdges && nEdges >= 2;
    const canPerpDistance = nPoints === 1 && nEdges === 1 && nCircles === 0;
    const canCoincident = onlyPoints && nPoints >= 2;
    const canPointOnGrid = onlyPoints && nPoints >= 1 && grids.length > 0;
    const canCircleRadius = onlyCircles && nCircles >= 1;
    const canCircleDiameter = onlyCircles && nCircles >= 1;
    const canConcentric = onlyCircles && nCircles >= 2;
    const canEqualRadius = onlyCircles && nCircles >= 2;
    const canTangent = (nCircles === 2 && nEdges === 0 && nPoints === 0)
        || (nCircles === 1 && nEdges === 1 && nPoints === 0);
    const canPointOnCircle = nCircles === 1 && nPoints >= 1 && nEdges === 0;

    const anyApplicable =
        canHV || canLength || canParallel || canPerpendicular || canAngle || canCollinear || canEqualLength || canCoincident || canPointOnGrid ||
        canPerpDistance ||
        canCircleRadius || canCircleDiameter || canConcentric || canEqualRadius || canTangent || canPointOnCircle;

    return (
        <div className="space-y-2 text-xs max-h-[60vh] overflow-y-auto">
            <div className="flex items-center justify-between">
                <div className="text-zinc-300 font-medium">拘束（作図線）</div>
                <div className="text-[10px] text-zinc-500">選択: {selection.length}</div>
            </div>

            {/* ── Selected entities ── */}
            <div className="space-y-1 p-2 bg-zinc-950 rounded border border-zinc-800">
                <div className="text-[10px] text-zinc-500 uppercase">選択中のエンティティ</div>
                {selection.length === 0 ? (
                    <div className="text-[10px] text-zinc-500">
                        ビューポート上で頂点 / エッジをクリック（Ctrl / Shift で複数選択）。
                    </div>
                ) : (
                    <div className="flex flex-wrap gap-1">
                        {selection.map((s) => {
                            const label = itemLabel(s, labelMap);
                            const color = s.kind === "edge"
                                ? "bg-blue-600 border-blue-400 text-white"
                                : "bg-emerald-600 border-emerald-400 text-white";
                            return (
                                <button
                                    key={selKey(s)}
                                    className={`text-[10px] px-1.5 py-0.5 rounded border ${color} flex items-center gap-1`}
                                    title="クリックで選択解除"
                                    onClick={() => toggleSketchSelection(s, true)}
                                >
                                    <span>{label}</span>
                                    <span className="opacity-70">×</span>
                                </button>
                            );
                        })}
                    </div>
                )}
                {selection.length > 0 && (
                    <button className={`${btn} w-full mt-1`} onClick={() => clearSketchSelection()}>選択クリア</button>
                )}
            </div>

            {/* ── Applicable constraints ── */}
            {selection.length > 0 && (
                <div className="space-y-1">
                    <div className="text-[10px] text-zinc-500 uppercase">適用可能な拘束</div>
                    {!anyApplicable && (
                        <div className="text-[10px] text-zinc-500">
                            この組み合わせに適用可能な拘束はありません。
                        </div>
                    )}
                    {canHV && (
                        <div className="grid grid-cols-2 gap-1">
                            <button className={btn} onClick={addHorizontal}>水平 ─</button>
                            <button className={btn} onClick={addVertical}>垂直 │</button>
                        </div>
                    )}
                    {canLength && (
                        <div className="flex items-center gap-1">
                            <input
                                className="flex-1 min-w-0 text-[10px] px-1 py-1 bg-zinc-900 border border-zinc-700 rounded text-zinc-200"
                                type="number"
                                step="0.1"
                                placeholder="長さ m"
                                value={lengthValue}
                                onChange={(e) => setLengthValue(e.target.value)}
                            />
                            <button
                                className={btn + " disabled:opacity-30 disabled:cursor-not-allowed"}
                                disabled={!lengthValue}
                                onClick={addLength}
                            >長さ ↔</button>
                        </div>
                    )}
                    {(canParallel || canPerpendicular) && (
                        <div className="grid grid-cols-2 gap-1">
                            {canParallel && <button className={btn} onClick={addParallel}>平行 ∥</button>}
                            {canPerpendicular && <button className={btn} onClick={addPerpendicular}>直交 ⊥</button>}
                        </div>
                    )}
                    {canCollinear && (
                        <button className={btnWide} onClick={addCollinear} title="2 辺を同一直線上に">
                            同一軸 ━
                        </button>
                    )}
                    {canEqualLength && (
                        <button className={btnWide} onClick={addEqualLength} title="選択した辺を同じ長さに (最初の辺の長さを基準)">
                            等長 ═
                        </button>
                    )}
                    {canPerpDistance && (
                        <div className="flex items-center gap-1">
                            <input
                                className="flex-1 min-w-0 text-[10px] px-1 py-1 bg-zinc-900 border border-zinc-700 rounded text-zinc-200"
                                type="number" step="0.01" placeholder="距離 m"
                                value={perpDistValue}
                                onChange={(e) => setPerpDistValue(e.target.value)}
                            />
                            <button
                                className={btn + " disabled:opacity-30 disabled:cursor-not-allowed"}
                                disabled={!perpDistValue}
                                onClick={addPerpDistance}
                                title="点から辺までの垂直距離を固定"
                            >垂直距離 ┴</button>
                        </div>
                    )}
                    {canAngle && (
                        <div className="flex items-center gap-1">
                            <input
                                className="flex-1 min-w-0 text-[10px] px-1 py-1 bg-zinc-900 border border-zinc-700 rounded text-zinc-200"
                                type="number" step="1" placeholder="角度 °"
                                value={angleValue}
                                onChange={(e) => setAngleValue(e.target.value)}
                            />
                            <button
                                className={btn + " disabled:opacity-30 disabled:cursor-not-allowed"}
                                disabled={!angleValue}
                                onClick={addAngle}
                                title="2 辺のなす角度を指定 (度)"
                            >角度 ∠</button>
                        </div>
                    )}
                    {canCoincident && (
                        <button className={btnWide} onClick={addCoincident}>点一致 ●</button>
                    )}
                    {canPointOnGrid && (
                        <div className="flex items-center gap-1">
                            <select
                                className="flex-1 min-w-0 text-[10px] px-1 py-1 bg-zinc-900 border border-zinc-700 rounded text-zinc-200"
                                value={gridIdForOnGrid}
                                onChange={(e) => setGridIdForOnGrid(e.target.value)}
                            >
                                <option value="">通芯...</option>
                                {grids.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                            </select>
                            <button
                                className={btn + " disabled:opacity-30 disabled:cursor-not-allowed"}
                                disabled={!gridIdForOnGrid}
                                onClick={addPointOnGrid}
                            >通芯上</button>
                        </div>
                    )}
                    {canCircleRadius && (
                        <div className="flex items-center gap-1">
                            <input
                                className="flex-1 min-w-0 text-[10px] px-1 py-1 bg-zinc-900 border border-zinc-700 rounded text-zinc-200"
                                type="number" step="0.1" placeholder="半径 m"
                                value={radiusValue}
                                onChange={(e) => setRadiusValue(e.target.value)}
                            />
                            <button
                                className={btn + " disabled:opacity-30 disabled:cursor-not-allowed"}
                                disabled={!radiusValue}
                                onClick={addCircleRadius}
                            >半径 R</button>
                        </div>
                    )}
                    {canCircleDiameter && (
                        <div className="flex items-center gap-1">
                            <input
                                className="flex-1 min-w-0 text-[10px] px-1 py-1 bg-zinc-900 border border-zinc-700 rounded text-zinc-200"
                                type="number" step="0.1" placeholder="直径 m"
                                value={diameterValue}
                                onChange={(e) => setDiameterValue(e.target.value)}
                            />
                            <button
                                className={btn + " disabled:opacity-30 disabled:cursor-not-allowed"}
                                disabled={!diameterValue}
                                onClick={addCircleDiameter}
                            >直径 ⌀</button>
                        </div>
                    )}
                    {canTangent && (
                        <button className={btnWide} onClick={addTangent}>接線 ⊙</button>
                    )}
                    {canPointOnCircle && (
                        <button className={btnWide} onClick={addPointOnCircle}>点を円上 ○</button>
                    )}
                    {(canConcentric || canEqualRadius) && (
                        <div className="grid grid-cols-2 gap-1">
                            {canConcentric && <button className={btn} onClick={addConcentric}>同心 ⊚</button>}
                            {canEqualRadius && <button className={btn} onClick={addEqualRadius}>等半径 =R</button>}
                        </div>
                    )}
                </div>
            )}

            {/* ── Existing constraints on selection ── */}
            {relatedConstraints.length > 0 && (
                <div className="pt-2 border-t border-zinc-700 space-y-1">
                    <div className="text-[10px] text-zinc-500 uppercase">付与済み（選択対象）</div>
                    {relatedConstraints.map((c) => (
                        <div key={c.id} className="flex items-center justify-between text-[10px] bg-zinc-800 rounded px-2 py-1">
                            <span className="text-zinc-300">
                                {c.type}
                                {c.value !== undefined && c.type === "Angle" && ` (${((c.value * 180) / Math.PI).toFixed(1)}°)`}
                                {c.value !== undefined && c.type === "CircleRadius" && ` (R=${c.value.toFixed(2)} m)`}
                                {c.value !== undefined && c.type === "CircleDiameter" && ` (⌀=${c.value.toFixed(2)} m)`}
                                {c.value !== undefined && c.type === "Length" && ` (${c.value.toFixed(2)} m)`}
                            </span>
                            <button className="text-red-400 hover:text-red-300" onClick={() => removeC(c.id)}>×</button>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}
