"use client";

import React, { useEffect, useRef } from "react";
import { mat4, vec4 } from "gl-matrix";
import { useAppState, AppState } from "../../application/AppState";
import { Camera } from "../../renderer/camera/Camera";
import { Vec3 } from "../../geometry/math/Vec3";
import { gridFirstVertex, gridLastVertex } from "../../model/grid/GridLine";

interface Props {
    getCamera: () => Camera | null;
    getCanvas: () => HTMLCanvasElement | null;
}

// Project a world point onto the canvas in CSS pixels.
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

export default function GridBubbleOverlay({ getCamera, getCanvas }: Props) {
    const grids = useAppState((s: AppState) => s.grids);
    const selectedGridIds = useAppState((s: AppState) => s.selectedGridIds);
    const activeRoomId = useAppState((s: AppState) => s.activeRoomId);
    const svgRef = useRef<SVGSVGElement>(null);
    // key: `${gridId}:start` or `${gridId}:end` → SVGGElement
    const handlesRef = useRef<Map<string, SVGGElement>>(new Map());

    // Bubbles render in both 2D and 3D, but suppressed during room editing (per spec §9)
    const enabled = activeRoomId === null;

    // Per-frame projection update — direct DOM writes, no React re-renders
    useEffect(() => {
        if (!enabled) return;
        let raf = 0;
        const tick = () => {
            const cam = getCamera();
            const canvas = getCanvas();
            const svg = svgRef.current;
            if (cam && canvas && svg) {
                const w = canvas.clientWidth;
                const h = canvas.clientHeight;
                for (const g of grids) {
                    if (!g.visible) continue;
                    const first = gridFirstVertex(g.curve);
                    const last = gridLastVertex(g.curve);
                    if (!first || !last) continue;
                    if (g.bubbleStart !== false) {
                        const el = handlesRef.current.get(`${g.id}:start`);
                        if (el) {
                            const p = project(first, cam, w, h);
                            if (p.visible) {
                                el.removeAttribute("display");
                                el.setAttribute("transform", `translate(${p.x.toFixed(1)},${p.y.toFixed(1)})`);
                            } else {
                                el.setAttribute("display", "none");
                            }
                        }
                    }
                    if (g.bubbleEnd !== false) {
                        const el = handlesRef.current.get(`${g.id}:end`);
                        if (el) {
                            const p = project(last, cam, w, h);
                            if (p.visible) {
                                el.removeAttribute("display");
                                el.setAttribute("transform", `translate(${p.x.toFixed(1)},${p.y.toFixed(1)})`);
                            } else {
                                el.setAttribute("display", "none");
                            }
                        }
                    }
                }
            }
            raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(raf);
    }, [grids, enabled, getCamera, getCanvas]);

    if (!enabled || grids.length === 0) return null;

    const setHandle = (key: string) => (el: SVGGElement | null) => {
        if (el) handlesRef.current.set(key, el);
        else handlesRef.current.delete(key);
    };

    return (
        <svg
            ref={svgRef}
            className="absolute inset-0 w-full h-full pointer-events-none"
            style={{ zIndex: 15 }}
        >
            {grids.map((g) => {
                if (!g.visible) return null;
                if (!gridFirstVertex(g.curve)) return null;
                const isSelected = selectedGridIds.includes(g.id);
                // Primary はピンク (= Tailwind pink-500 系)、Auxiliary は薄ピンク。
                const fill = g.kind === "Auxiliary" ? "#f472b6" : "#ec4899";
                // 統一した選択色 (= orange-500、Tailwind orange-500)。
                const stroke = isSelected ? "#f97316" : "#ffffff";
                const r = 12;
                return (
                    <g key={g.id}>
                        {g.bubbleStart !== false && (
                            <g ref={setHandle(`${g.id}:start`)}>
                                <circle r={r} fill={fill} stroke={stroke} strokeWidth={isSelected ? 2 : 1.2} />
                                <text textAnchor="middle" dominantBaseline="central" fontSize={11} fontWeight={700} fill="#ffffff" fontFamily="ui-sans-serif, system-ui, sans-serif">
                                    {g.name}
                                </text>
                            </g>
                        )}
                        {g.bubbleEnd !== false && (
                            <g ref={setHandle(`${g.id}:end`)}>
                                <circle r={r} fill={fill} stroke={stroke} strokeWidth={isSelected ? 2 : 1.2} />
                                <text textAnchor="middle" dominantBaseline="central" fontSize={11} fontWeight={700} fill="#ffffff" fontFamily="ui-sans-serif, system-ui, sans-serif">
                                    {g.name}
                                </text>
                            </g>
                        )}
                    </g>
                );
            })}
        </svg>
    );
}
