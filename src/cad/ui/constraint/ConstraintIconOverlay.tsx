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

/** Forward direction of a Length constraint's first edge-like target in XZ. */
function directionFor(c: Constraint, elements: Record<string, any>): { ux: number; uz: number } | null {
    for (const t of c.targets) {
        if (t.kind === "SketchEdge") {
            const p = findPoly(elements, t.spaceId as string, t.polyId);
            if (!p) return null;
            const n = p.outer.length;
            if (t.edgeIdx < 0 || t.edgeIdx >= n) return null;
            const a = p.outer[t.edgeIdx];
            const b = p.outer[(t.edgeIdx + 1) % n];
            const dx = b[0] - a[0], dz = b[1] - a[1];
            const len = Math.hypot(dx, dz) || 1;
            return { ux: dx / len, uz: dz / len };
        }
        if (t.kind === "WallAxis") {
            const w = elements[t.wallId as string] as WallElement | undefined;
            if (!w || w.type !== "Wall") return null;
            const dx = w.axis[1][0] - w.axis[0][0];
            const dz = w.axis[1][2] - w.axis[0][2];
            const len = Math.hypot(dx, dz) || 1;
            return { ux: dx / len, uz: dz / len };
        }
    }
    return null;
}

interface Placement {
    c: Constraint;
    world: Vec3;
    /** Pre-computed label for Length constraints (in mm), null otherwise. */
    lengthLabel: string | null;
}

export default function ConstraintIconOverlay({ getCamera, getCanvas }: Props) {
    const constraints = useAppState((s: AppState) => s.constraints);
    const elements = useAppState((s: AppState) => s.elements);
    const executeCommand = useAppState((s: AppState) => s.executeCommand);
    const selectedConstraintId = useAppState((s: AppState) => s.selectedConstraintId);
    const setSelectedConstraintId = useAppState((s: AppState) => s.setSelectedConstraintId);
    const svgRef = useRef<SVGSVGElement>(null);
    const handlesRef = useRef<Map<string, SVGGElement>>(new Map());

    const placements: Placement[] = React.useMemo(() => {
        const out: Placement[] = [];
        for (const id in constraints) {
            const c = constraints[id];
            const world = placementFor(c, elements);
            if (!world) continue;
            let lengthLabel: string | null = null;
            if (c.type === "Length") {
                // Prefer the constraint's target value (the user's intent)
                // but fall back to the measured length so the label still
                // shows useful info if value is missing.
                const measured = measuredLengthFor(c, elements);
                const v = c.value ?? measured;
                if (v != null && Number.isFinite(v)) {
                    lengthLabel = `${Math.round(v * 1000)}mm`;
                }
            }
            out.push({ c, world, lengthLabel });
        }
        return out;
    }, [constraints, elements]);

    useEffect(() => {
        let raf = 0;
        const tick = () => {
            const cam = getCamera();
            const canvas = getCanvas();
            const svg = svgRef.current;
            if (cam && canvas && svg) {
                const w = canvas.clientWidth;
                const h = canvas.clientHeight;
                const groups = new Map<string, number>();
                for (const p of placements) {
                    const el = handlesRef.current.get(p.c.id);
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
                }
            }
            raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(raf);
    }, [placements, getCamera, getCanvas]);

    if (placements.length === 0) return null;

    const setHandle = (id: string) => (el: SVGGElement | null) => {
        if (el) handlesRef.current.set(id, el);
        else handlesRef.current.delete(id);
    };

    return (
        <svg
            ref={svgRef}
            className="absolute inset-0 w-full h-full"
            style={{ zIndex: 16, pointerEvents: "none" }}
        >
            {placements.map(({ c, lengthLabel }) => {
                const g = GLYPHS[c.type] ?? { glyph: "?", color: "#ffffff", tip: c.type };
                const tip = g.tip + (c.value !== undefined ? ` ${c.value.toFixed(2)}m` : "");
                const isSelected = selectedConstraintId === c.id;
                return (
                    <g
                        key={c.id}
                        ref={setHandle(c.id)}
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
                        {lengthLabel && (
                            <g transform="translate(14, -2)">
                                {/* subtle white pill behind the text so it
                                    stays readable over walls / grids */}
                                <rect
                                    x={-1}
                                    y={-9}
                                    width={lengthLabel.length * 6.8 + 6}
                                    height={16}
                                    rx={3}
                                    fill="rgba(255,255,255,0.9)"
                                    stroke="#fbbf24"
                                    strokeWidth={0.8}
                                />
                                <text
                                    x={2}
                                    y={0}
                                    dominantBaseline="central"
                                    fontSize={11}
                                    fontWeight={600}
                                    fill="#92400e"
                                    fontFamily="ui-sans-serif, system-ui, sans-serif"
                                >{lengthLabel}</text>
                            </g>
                        )}
                    </g>
                );
            })}
        </svg>
    );
}
