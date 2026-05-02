"use client";

import React, { useEffect, useRef } from "react";
import { mat4, vec4 } from "gl-matrix";
import { useAppState, AppState } from "../../application/AppState";
import { Camera } from "../../renderer/camera/Camera";
import { Vec3 } from "../../geometry/math/Vec3";
import { Constraint } from "../../model/constraint/Constraint";
import { SpaceElement, RoomPolygon } from "../../model/elements/SpaceElement";
import { WallElement } from "../../model/elements/WallElement";
import { Vec2 } from "../../geometry/math/Vec2";
import { RemoveConstraintCommand } from "../../commands/create/AddConstraintCommand";

interface Props {
    getCamera: () => Camera | null;
    getCanvas: () => HTMLCanvasElement | null;
}

function project(world: Vec3, camera: Camera, width: number, height: number): { x: number; y: number; visible: boolean } {
    const viewProj = mat4.create();
    mat4.multiply(viewProj, camera.projectionMatrix, camera.viewMatrix);
    const v = vec4.fromValues(world[0], world[1], world[2], 1);
    vec4.transformMat4(v, v, viewProj);
    if (v[3] === 0) return { x: 0, y: 0, visible: false };
    const x = (v[0] / v[3] + 1) * 0.5 * width;
    const y = (1 - (v[1] / v[3] + 1) * 0.5) * height;
    return { x, y, visible: v[3] > 0 };
}

const GLYPHS: Record<string, { glyph: string; color: string; tip: string }> = {
    Horizontal:    { glyph: "─", color: "#60a5fa", tip: "水平" },
    Vertical:      { glyph: "│", color: "#60a5fa", tip: "垂直" },
    Parallel:      { glyph: "∥", color: "#a78bfa", tip: "平行" },
    Perpendicular: { glyph: "⊥", color: "#a78bfa", tip: "直交" },
    Coincident:    { glyph: "●", color: "#f97316", tip: "点一致" },
    PointOnGrid:   { glyph: "⊕", color: "#ef4444", tip: "通芯上" },
    PointOnColumn: { glyph: "⊙", color: "#10b981", tip: "柱中心" },
    Length:        { glyph: "↔", color: "#fbbf24", tip: "長さ寸法" },
};

function findPoly(elements: Record<string, any>, spaceId: string, polyId: string): RoomPolygon | null {
    const sp = elements[spaceId] as SpaceElement | undefined;
    if (!sp || sp.type !== "Space") return null;
    return sp.polygons?.find((p) => p.id === polyId) ?? null;
}

function vec2ToVec3(v: Vec2): Vec3 {
    return [v[0], 0, v[1]];
}

// Pick the best world-space anchor point for a constraint.
// Prefer an edge midpoint over a vertex — otherwise icons land directly on
// vertex handles and block vertex picking in the viewport.
function placementFor(c: Constraint, elements: Record<string, any>): Vec3 | null {
    for (const t of c.targets) {
        if (t.kind !== "SketchEdge") continue;
        const p = findPoly(elements, t.spaceId as string, t.polyId);
        if (!p) continue;
        const n = p.outer.length;
        if (t.edgeIdx < 0 || t.edgeIdx >= n) continue;
        const a = p.outer[t.edgeIdx];
        const b = p.outer[(t.edgeIdx + 1) % n];
        return [(a[0] + b[0]) / 2, 0, (a[1] + b[1]) / 2];
    }
    // Wall axis: place at the axis midpoint so the icon sits on the line.
    for (const t of c.targets) {
        if (t.kind !== "WallAxis") continue;
        const w = elements[t.wallId as string] as WallElement | undefined;
        if (!w || w.type !== "Wall") continue;
        return [(w.axis[0][0] + w.axis[1][0]) / 2, 0, (w.axis[0][2] + w.axis[1][2]) / 2];
    }
    for (const t of c.targets) {
        if (t.kind !== "SketchPoint") continue;
        const p = findPoly(elements, t.spaceId as string, t.polyId);
        if (!p) continue;
        if (t.vertexIdx < 0 || t.vertexIdx >= p.outer.length) continue;
        return vec2ToVec3(p.outer[t.vertexIdx]);
    }
    // Wall axis endpoint — last resort for Coincident at a wall end, etc.
    for (const t of c.targets) {
        if (t.kind !== "WallAxisPoint") continue;
        const w = elements[t.wallId as string] as WallElement | undefined;
        if (!w || w.type !== "Wall") continue;
        const p = w.axis[t.endIdx];
        return [p[0], 0, p[2]];
    }
    return null;
}

interface LengthAnchor {
    a: Vec3;
    b: Vec3;
    /** Reference point inside the polygon (XZ centroid) so the dimension can
     * be offset to the *outside*. Null for wall axes (no inside notion). */
    centroid: Vec3 | null;
}

function lengthAnchorFor(c: Constraint, elements: Record<string, any>): LengthAnchor | null {
    for (const t of c.targets) {
        if (t.kind === "SketchEdge") {
            const p = findPoly(elements, t.spaceId as string, t.polyId);
            if (!p) return null;
            const n = p.outer.length;
            if (t.edgeIdx < 0 || t.edgeIdx >= n) return null;
            const a = p.outer[t.edgeIdx];
            const b = p.outer[(t.edgeIdx + 1) % n];
            let sx = 0, sz = 0;
            for (const v of p.outer) { sx += v[0]; sz += v[1]; }
            sx /= p.outer.length; sz /= p.outer.length;
            return { a: [a[0], 0, a[1]], b: [b[0], 0, b[1]], centroid: [sx, 0, sz] };
        }
        if (t.kind === "WallAxis") {
            const w = elements[t.wallId as string] as WallElement | undefined;
            if (!w || w.type !== "Wall") return null;
            return {
                a: [w.axis[0][0], 0, w.axis[0][2]],
                b: [w.axis[1][0], 0, w.axis[1][2]],
                centroid: null,
            };
        }
    }
    return null;
}

/**
 * For a Length constraint, compute the length of its first edge-like target
 * (polygon edge or wall axis). Returns null if no such target exists.
 * The solver keeps this equal to `c.value` at steady state; showing the
 * *measured* length gives the user immediate feedback in either state.
 */
function measuredLengthFor(c: Constraint, elements: Record<string, any>): number | null {
    for (const t of c.targets) {
        if (t.kind === "SketchEdge") {
            const p = findPoly(elements, t.spaceId as string, t.polyId);
            if (!p) return null;
            const n = p.outer.length;
            if (t.edgeIdx < 0 || t.edgeIdx >= n) return null;
            const a = p.outer[t.edgeIdx];
            const b = p.outer[(t.edgeIdx + 1) % n];
            return Math.hypot(b[0] - a[0], b[1] - a[1]);
        }
        if (t.kind === "WallAxis") {
            const w = elements[t.wallId as string] as WallElement | undefined;
            if (!w || w.type !== "Wall") return null;
            return Math.hypot(w.axis[1][0] - w.axis[0][0], w.axis[1][2] - w.axis[0][2]);
        }
    }
    return null;
}

interface IconPlacement {
    kind: "icon";
    c: Constraint;
    world: Vec3;
}

interface DimPlacement {
    kind: "dim";
    c: Constraint;
    a: Vec3;
    b: Vec3;
    centroid: Vec3 | null;
    label: string;
}

type Placement = IconPlacement | DimPlacement;

// CAD-style dimension visual constants (screen-space, pixels)
const DIM_OFFSET_PX = 38;     // dim line distance from the edge
const EXT_GAP_RATIO = 0.06;   // small gap so ext lines don't touch the edge
const EXT_OVERSHOOT = 1.18;   // ext lines extend slightly past the dim line
const ARROW_LEN = 9;
const ARROW_WIDTH = 6;
const DIM_COLOR = "#334155";  // slate-700, dark enough to read on light bg
const DIM_COLOR_SELECTED = "#fbbf24";

/**
 * True when the constraint touches the active room — either via a
 * polygon-vertex/edge target with matching spaceId, or via a wall whose
 * `polyRef` resolves back to the active room. Constraints that don't touch
 * the active room are hidden in Room mode (the overlay is not shown at all
 * outside Room mode, gated at the Viewport level).
 */
function touchesRoom(c: Constraint, elements: Record<string, any>, roomId: string): boolean {
    for (const t of c.targets) {
        if (t.kind === "SketchPoint" || t.kind === "SketchEdge" || t.kind === "SketchCircle") {
            if (t.spaceId === roomId) return true;
        } else if (t.kind === "WallAxis" || t.kind === "WallAxisPoint") {
            const w = elements[t.wallId as string] as WallElement | undefined;
            if (w && w.type === "Wall" && w.polyRef?.spaceId === roomId) return true;
        }
    }
    return false;
}

export default function ConstraintIconOverlay({ getCamera, getCanvas }: Props) {
    const constraints = useAppState((s: AppState) => s.constraints);
    const elements = useAppState((s: AppState) => s.elements);
    const activeRoomId = useAppState((s: AppState) => s.activeRoomId);
    const executeCommand = useAppState((s: AppState) => s.executeCommand);
    const selectedConstraintId = useAppState((s: AppState) => s.selectedConstraintId);
    const setSelectedConstraintId = useAppState((s: AppState) => s.setSelectedConstraintId);
    const svgRef = useRef<SVGSVGElement>(null);
    const iconRefs = useRef<Map<string, SVGGElement>>(new Map());
    const dimRefs = useRef<Map<string, SVGGElement>>(new Map());

    const placements: Placement[] = React.useMemo(() => {
        const out: Placement[] = [];
        if (!activeRoomId) return out;
        for (const id in constraints) {
            const c = constraints[id];
            if (!touchesRoom(c, elements, activeRoomId)) continue;
            if (c.type === "Length") {
                const anchor = lengthAnchorFor(c, elements);
                if (anchor) {
                    const measured = measuredLengthFor(c, elements);
                    const v = c.value ?? measured;
                    const label = (v != null && Number.isFinite(v))
                        ? `${Math.round(v * 1000)}`
                        : "";
                    out.push({ kind: "dim", c, a: anchor.a, b: anchor.b, centroid: anchor.centroid, label });
                    continue;
                }
            }
            const world = placementFor(c, elements);
            if (!world) continue;
            out.push({ kind: "icon", c, world });
        }
        return out;
    }, [constraints, elements, activeRoomId]);

    useEffect(() => {
        let raf = 0;
        const setChild = (parent: SVGGElement, role: string, attrs: Record<string, string>) => {
            const child = parent.querySelector(`[data-role="${role}"]`);
            if (!child) return;
            for (const k in attrs) child.setAttribute(k, attrs[k]);
        };
        const tick = () => {
            const cam = getCamera();
            const canvas = getCanvas();
            if (cam && canvas) {
                const w = canvas.clientWidth;
                const h = canvas.clientHeight;
                const groups = new Map<string, number>();
                for (const p of placements) {
                    if (p.kind === "icon") {
                        const el = iconRefs.current.get(p.c.id);
                        if (!el) continue;
                        const proj = project(p.world, cam, w, h);
                        if (!proj.visible) {
                            el.setAttribute("display", "none");
                            continue;
                        }
                        el.removeAttribute("display");
                        const key = `${Math.round(proj.x / 8)},${Math.round(proj.y / 8)}`;
                        const n = groups.get(key) ?? 0;
                        groups.set(key, n + 1);
                        const ox = n * 18;
                        el.setAttribute("transform", `translate(${(proj.x + ox).toFixed(1)},${proj.y.toFixed(1)})`);
                        continue;
                    }
                    const el = dimRefs.current.get(p.c.id);
                    if (!el) continue;
                    const pa = project(p.a, cam, w, h);
                    const pb = project(p.b, cam, w, h);
                    if (!pa.visible || !pb.visible) {
                        el.setAttribute("display", "none");
                        continue;
                    }
                    const dx = pb.x - pa.x;
                    const dy = pb.y - pa.y;
                    const len = Math.hypot(dx, dy);
                    if (len < 1) {
                        el.setAttribute("display", "none");
                        continue;
                    }
                    el.removeAttribute("display");
                    const ux = dx / len, uy = dy / len;
                    // Perpendicular candidate (90° CCW in screen space).
                    let nx = -uy, ny = ux;
                    if (p.centroid) {
                        const pc = project(p.centroid, cam, w, h);
                        const mx = (pa.x + pb.x) / 2, my = (pa.y + pb.y) / 2;
                        // If centroid is on the +n side, offset to -n (outside).
                        const dot = (pc.x - mx) * nx + (pc.y - my) * ny;
                        if (dot > 0) { nx = -nx; ny = -ny; }
                    }
                    const off = DIM_OFFSET_PX;
                    const dax = pa.x + nx * off, day = pa.y + ny * off;
                    const dbx = pb.x + nx * off, dby = pb.y + ny * off;
                    const eaSx = pa.x + nx * (off * EXT_GAP_RATIO);
                    const eaSy = pa.y + ny * (off * EXT_GAP_RATIO);
                    const eaEx = pa.x + nx * (off * EXT_OVERSHOOT);
                    const eaEy = pa.y + ny * (off * EXT_OVERSHOOT);
                    const ebSx = pb.x + nx * (off * EXT_GAP_RATIO);
                    const ebSy = pb.y + ny * (off * EXT_GAP_RATIO);
                    const ebEx = pb.x + nx * (off * EXT_OVERSHOOT);
                    const ebEy = pb.y + ny * (off * EXT_OVERSHOOT);
                    // Arrow A: tip at dim-line endpoint a, base ARROW_LEN along +u.
                    const baseAx = dax + ux * ARROW_LEN, baseAy = day + uy * ARROW_LEN;
                    const a1x = baseAx + nx * (ARROW_WIDTH / 2);
                    const a1y = baseAy + ny * (ARROW_WIDTH / 2);
                    const a2x = baseAx - nx * (ARROW_WIDTH / 2);
                    const a2y = baseAy - ny * (ARROW_WIDTH / 2);
                    // Arrow B: tip at dim-line endpoint b, base ARROW_LEN along -u.
                    const baseBx = dbx - ux * ARROW_LEN, baseBy = dby - uy * ARROW_LEN;
                    const b1x = baseBx + nx * (ARROW_WIDTH / 2);
                    const b1y = baseBy + ny * (ARROW_WIDTH / 2);
                    const b2x = baseBx - nx * (ARROW_WIDTH / 2);
                    const b2y = baseBy - ny * (ARROW_WIDTH / 2);
                    let deg = Math.atan2(uy, ux) * 180 / Math.PI;
                    // Keep text readable (left-to-right) — flip if upside-down.
                    if (deg > 90 || deg < -90) deg += 180;
                    const mxd = (dax + dbx) / 2, myd = (day + dby) / 2;

                    setChild(el, "ext-a", { x1: eaSx.toFixed(1), y1: eaSy.toFixed(1), x2: eaEx.toFixed(1), y2: eaEy.toFixed(1) });
                    setChild(el, "ext-b", { x1: ebSx.toFixed(1), y1: ebSy.toFixed(1), x2: ebEx.toFixed(1), y2: ebEy.toFixed(1) });
                    setChild(el, "dim-line", { x1: dax.toFixed(1), y1: day.toFixed(1), x2: dbx.toFixed(1), y2: dby.toFixed(1) });
                    setChild(el, "arrow-a", { points: `${dax.toFixed(1)},${day.toFixed(1)} ${a1x.toFixed(1)},${a1y.toFixed(1)} ${a2x.toFixed(1)},${a2y.toFixed(1)}` });
                    setChild(el, "arrow-b", { points: `${dbx.toFixed(1)},${dby.toFixed(1)} ${b1x.toFixed(1)},${b1y.toFixed(1)} ${b2x.toFixed(1)},${b2y.toFixed(1)}` });
                    setChild(el, "label-group", { transform: `translate(${mxd.toFixed(1)},${myd.toFixed(1)}) rotate(${deg.toFixed(1)})` });
                }
            }
            raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(raf);
    }, [placements, getCamera, getCanvas]);

    if (placements.length === 0) return null;

    const setIconRef = (id: string) => (el: SVGGElement | null) => {
        if (el) iconRefs.current.set(id, el);
        else iconRefs.current.delete(id);
    };
    const setDimRef = (id: string) => (el: SVGGElement | null) => {
        if (el) dimRefs.current.set(id, el);
        else dimRefs.current.delete(id);
    };

    return (
        <svg
            ref={svgRef}
            className="absolute inset-0 w-full h-full"
            style={{ zIndex: 16, pointerEvents: "none" }}
        >
            {placements.map((p) => {
                if (p.kind === "icon") {
                    const c = p.c;
                    const g = GLYPHS[c.type] ?? { glyph: "?", color: "#ffffff", tip: c.type };
                    const tip = g.tip + (c.value !== undefined ? ` ${c.value.toFixed(2)}m` : "");
                    const isSelected = selectedConstraintId === c.id;
                    return (
                        <g
                            key={c.id}
                            ref={setIconRef(c.id)}
                            style={{ pointerEvents: "auto", cursor: "pointer" }}
                            onClick={(e) => {
                                e.stopPropagation();
                                setSelectedConstraintId(isSelected ? null : c.id);
                            }}
                            onContextMenu={(e) => {
                                e.preventDefault();
                                executeCommand(new RemoveConstraintCommand(c.id));
                            }}
                        >
                            <title>{tip}（クリックで選択 / Delete で削除 / 右クリックで即削除）</title>
                            {isSelected && (
                                <circle r={13} fill="none" stroke="#fbbf24" strokeWidth={2} />
                            )}
                            <circle
                                r={9}
                                fill={g.color}
                                stroke={isSelected ? "#fbbf24" : "#ffffff"}
                                strokeWidth={isSelected ? 2 : 1.2}
                            />
                            <text
                                textAnchor="middle"
                                dominantBaseline="central"
                                fontSize={11}
                                fontWeight={700}
                                fill="#ffffff"
                                fontFamily="ui-sans-serif, system-ui, sans-serif"
                            >{g.glyph}</text>
                        </g>
                    );
                }
                const c = p.c;
                const isSelected = selectedConstraintId === c.id;
                const stroke = isSelected ? DIM_COLOR_SELECTED : DIM_COLOR;
                const tip = "長さ寸法" + (c.value !== undefined ? ` ${c.value.toFixed(2)}m` : "");
                const labelW = Math.max(22, p.label.length * 8 + 10);
                const onSelect = (e: React.MouseEvent) => {
                    e.stopPropagation();
                    setSelectedConstraintId(isSelected ? null : c.id);
                };
                const onDelete = (e: React.MouseEvent) => {
                    e.preventDefault();
                    executeCommand(new RemoveConstraintCommand(c.id));
                };
                return (
                    <g key={c.id} ref={setDimRef(c.id)}>
                        <title>{tip}（クリックで選択 / Delete で削除 / 右クリックで即削除）</title>
                        <line data-role="ext-a" x1={0} y1={0} x2={0} y2={0}
                            stroke={stroke} strokeWidth={1} strokeLinecap="round" />
                        <line data-role="ext-b" x1={0} y1={0} x2={0} y2={0}
                            stroke={stroke} strokeWidth={1} strokeLinecap="round" />
                        <line data-role="dim-line" x1={0} y1={0} x2={0} y2={0}
                            stroke={stroke}
                            strokeWidth={isSelected ? 1.6 : 1.2}
                            strokeLinecap="round"
                            style={{ pointerEvents: "stroke", cursor: "pointer" }}
                            onClick={onSelect}
                            onContextMenu={onDelete}
                        />
                        <polygon data-role="arrow-a" points="0,0 0,0 0,0" fill={stroke} stroke="none" />
                        <polygon data-role="arrow-b" points="0,0 0,0 0,0" fill={stroke} stroke="none" />
                        <g data-role="label-group">
                            <rect
                                x={-labelW / 2}
                                y={-17}
                                width={labelW}
                                height={14}
                                rx={2}
                                fill="rgba(255,255,255,0.92)"
                                stroke={stroke}
                                strokeWidth={isSelected ? 1 : 0.6}
                                style={{ pointerEvents: "auto", cursor: "pointer" }}
                                onClick={onSelect}
                                onContextMenu={onDelete}
                            />
                            <text
                                x={0}
                                y={-10}
                                textAnchor="middle"
                                dominantBaseline="central"
                                fontSize={11}
                                fontWeight={600}
                                fill={isSelected ? "#92400e" : "#0f172a"}
                                fontFamily="ui-sans-serif, system-ui, sans-serif"
                                style={{ pointerEvents: "none", userSelect: "none" }}
                            >{p.label}</text>
                        </g>
                    </g>
                );
            })}
        </svg>
    );
}
