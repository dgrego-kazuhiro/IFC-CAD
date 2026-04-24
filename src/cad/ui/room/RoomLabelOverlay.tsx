"use client";

import React, { useEffect, useRef } from "react";
import { mat4, vec4 } from "gl-matrix";
import { useAppState, AppState } from "../../application/AppState";
import { Camera } from "../../renderer/camera/Camera";
import { Vec3 } from "../../geometry/math/Vec3";
import { SpaceElement, RoomPolygon } from "../../model/elements/SpaceElement";

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

// Pick the polygon we anchor the room label to. Skip outline polygons (those
// are derived geometry that sits outside the inner shape); take the first
// non-outline closed polygon with >= 3 vertices.
function anchorPolygon(space: SpaceElement): RoomPolygon | null {
    if (!space.polygons) return null;
    for (const p of space.polygons) {
        if (p.wallOutlineOf) continue;
        if (!p.outer || p.outer.length < 3) continue;
        return p;
    }
    return null;
}

function centroidXZ(poly: RoomPolygon): [number, number] {
    let cx = 0, cy = 0;
    for (const v of poly.outer) { cx += v[0]; cy += v[1]; }
    cx /= poly.outer.length; cy /= poly.outer.length;
    return [cx, cy];
}

interface LabelEntry {
    id: string;
    name: string;
    world: Vec3;
}

export default function RoomLabelOverlay({ getCamera, getCanvas }: Props) {
    const elements = useAppState((s: AppState) => s.elements);
    const svgRef = useRef<SVGSVGElement>(null);
    const handlesRef = useRef<Map<string, SVGGElement>>(new Map());

    const labels: LabelEntry[] = React.useMemo(() => {
        const out: LabelEntry[] = [];
        for (const id in elements) {
            const el = elements[id] as SpaceElement;
            if (!el || el.type !== "Space") continue;
            const name = (el.name ?? "").trim();
            if (!name) continue;
            const poly = anchorPolygon(el);
            if (!poly) continue;
            const [cx, cy] = centroidXZ(poly);
            out.push({ id, name, world: [cx, 0, cy] });
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
                    const el = handlesRef.current.get(l.id);
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

    const setHandle = (id: string) => (el: SVGGElement | null) => {
        if (el) handlesRef.current.set(id, el);
        else handlesRef.current.delete(id);
    };

    return (
        <svg
            ref={svgRef}
            className="absolute inset-0 w-full h-full pointer-events-none"
            style={{ zIndex: 14 }}
        >
            {labels.map((l) => (
                <g key={l.id} ref={setHandle(l.id)}>
                    <text
                        textAnchor="middle"
                        dominantBaseline="central"
                        fontSize={13}
                        fontWeight={600}
                        fill="#1f2937"
                        stroke="rgba(255,255,255,0.85)"
                        strokeWidth={3}
                        paintOrder="stroke"
                        fontFamily="ui-sans-serif, system-ui, sans-serif"
                    >
                        {l.name}
                    </text>
                </g>
            ))}
        </svg>
    );
}
