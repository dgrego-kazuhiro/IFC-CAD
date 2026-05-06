"use client";

import React, { useEffect, useRef } from "react";
import { mat4, vec4 } from "gl-matrix";
import { useAppState, AppState } from "../../application/AppState";
import { Camera } from "../../renderer/camera/Camera";
import { Vec3 } from "../../geometry/math/Vec3";
import { SpaceElement, RoomPolygon, isPolygonClosed } from "../../model/elements/SpaceElement";
import { computeRoomMetrics } from "./roomMetrics";

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

// All non-outline closed polygons of a Space. Each gets its own label —
// rooms with multiple drawn rectangles end up with one label per polygon
// so the user can tell which polygon belongs to which room and see the
// per-polygon area, instead of only the first polygon being labeled.
function labelPolygons(space: SpaceElement): RoomPolygon[] {
    if (!space.polygons) return [];
    const out: RoomPolygon[] = [];
    for (const p of space.polygons) {
        if (p.wallOutlineOf) continue;
        if (!p.outer || p.outer.length < 3) continue;
        // 開いたポリライン (= wallPath ツールで描いた単独壁) は部屋では
        // 無いのでラベル / 畳数を出さない。
        if (!isPolygonClosed(p)) continue;
        out.push(p);
    }
    return out;
}

function centroidXZ(poly: RoomPolygon): [number, number] {
    let cx = 0, cy = 0;
    for (const v of poly.outer) { cx += v[0]; cy += v[1]; }
    cx /= poly.outer.length; cy /= poly.outer.length;
    return [cx, cy];
}

interface LabelEntry {
    /** Unique key per (space, polygon) pair so multiple polygons in the same
     *  space get distinct DOM nodes. */
    key: string;
    name: string;
    sub: string | null; // e.g. "6畳"
    world: Vec3;
}

export default function RoomLabelOverlay({ getCamera, getCanvas }: Props) {
    const elements = useAppState((s: AppState) => s.elements);
    const svgRef = useRef<SVGSVGElement>(null);
    const handlesRef = useRef<Map<string, SVGGElement>>(new Map());
    // Ref-callback cache so each label id gets the SAME function across
    // renders. Inline-recreated callbacks would trigger a null/cleanup pass
    // every render, briefly emptying handlesRef and causing the RAF tick
    // to skip newly-added labels for one frame.
    const refCallbackCacheRef = useRef<Map<string, (el: SVGGElement | null) => void>>(new Map());

    const labels: LabelEntry[] = React.useMemo(() => {
        const out: LabelEntry[] = [];
        for (const id in elements) {
            const el = elements[id] as SpaceElement;
            if (!el || el.type !== "Space") continue;
            const name = (el.name ?? "").trim();
            if (!name) continue;
            for (const poly of labelPolygons(el)) {
                const [cx, cy] = centroidXZ(poly);
                const thickness = poly.wallThickness ?? 0.105;
                const m = computeRoomMetrics(poly, thickness);
                const sub = m.tatami > 0 ? `${m.tatami}畳` : null;
                out.push({ key: `${id}:${poly.id}`, name, sub, world: [cx, 0, cy] });
            }
        }
        return out;
    }, [elements]);

    useEffect(() => {
        let raf = 0;
        const tick = () => {
            const cam = getCamera();
            const canvas = getCanvas();
            const svg = svgRef.current;
            if (cam && canvas && svg) {
                const w = canvas.clientWidth;
                const h = canvas.clientHeight;
                for (const l of labels) {
                    const el = handlesRef.current.get(l.key);
                    if (!el) continue;
                    const p = project(l.world, cam, w, h);
                    if (!p.visible) {
                        el.setAttribute("display", "none");
                        continue;
                    }
                    el.removeAttribute("display");
                    el.setAttribute("transform", `translate(${p.x.toFixed(1)},${p.y.toFixed(1)})`);
                }
            }
            raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(raf);
    }, [labels, getCamera, getCanvas]);

    if (labels.length === 0) return null;

    const setHandle = (id: string) => {
        const cached = refCallbackCacheRef.current.get(id);
        if (cached) return cached;
        const cb = (el: SVGGElement | null) => {
            if (el) handlesRef.current.set(id, el);
            else handlesRef.current.delete(id);
        };
        refCallbackCacheRef.current.set(id, cb);
        return cb;
    };

    return (
        <svg
            ref={svgRef}
            className="absolute inset-0 w-full h-full pointer-events-none"
            style={{ zIndex: 14 }}
        >
            {labels.map((l) => (
                <g key={l.key} ref={setHandle(l.key)}>
                    <text
                        textAnchor="middle"
                        dominantBaseline="central"
                        y={l.sub ? -8 : 0}
                        fontSize={14}
                        fontWeight={700}
                        fill="#1f2937"
                        stroke="rgba(255,255,255,0.85)"
                        strokeWidth={3}
                        paintOrder="stroke"
                        fontFamily="ui-sans-serif, system-ui, sans-serif"
                    >
                        {l.name}
                    </text>
                    {l.sub && (
                        <text
                            textAnchor="middle"
                            dominantBaseline="central"
                            y={9}
                            fontSize={12}
                            fontWeight={500}
                            fill="#52525b"
                            stroke="rgba(255,255,255,0.85)"
                            strokeWidth={3}
                            paintOrder="stroke"
                            fontFamily="ui-sans-serif, system-ui, sans-serif"
                        >
                            {l.sub}
                        </text>
                    )}
                </g>
            ))}
        </svg>
    );
}
