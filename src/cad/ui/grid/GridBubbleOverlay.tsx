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
    const activeTool = useAppState((s: AppState) => s.activeTool);
    const gridlineDrafting = useAppState((s: AppState) => s.gridlineDrafting);
    const svgRef = useRef<SVGSVGElement>(null);
    // key: `${gridId}:start` or `${gridId}:end` → SVGGElement
    const handlesRef = useRef<Map<string, SVGGElement>>(new Map());

    // Bubbles render in both 2D and 3D, but suppressed during room editing (per spec §9)
    const enabled = activeRoomId === null;
    // 通芯編集モード (= activeTool="gridline" かつ drafting OFF) では各 grid 端点に
    // オレンジの頂点ハンドル (= GridEditOverlay) が出る。バブルが頂点と完全に同じ
    // 位置にあると、ハンドルがバブルを覆ってラベル文字が読めなくなるので、
    // 編集中はバブルをグリッド方向の外側へずらして両方見えるようにする。
    const inGridlineEditMode = activeTool === "gridline" && !gridlineDrafting;
    const BUBBLE_EDIT_OFFSET_PX = 26; // ハンドル半径 (= 7..9) + バブル半径 (= 12) 分

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
                    // 編集モード時のオフセット方向 = grid 方向ベクトル (画面 px) を
                    // 単位化したもの。start バブルは last → first 方向 (= 線の外側)、
                    // end バブルは first → last 方向 (= 線の反対側の外側)。
                    let offX = 0, offY = 0;
                    if (inGridlineEditMode) {
                        const pf = project(first, cam, w, h);
                        const pl = project(last, cam, w, h);
                        const dx = pl.x - pf.x;
                        const dy = pl.y - pf.y;
                        const len = Math.hypot(dx, dy);
                        if (len > 1e-3) {
                            offX = (dx / len) * BUBBLE_EDIT_OFFSET_PX;
                            offY = (dy / len) * BUBBLE_EDIT_OFFSET_PX;
                        }
                    }
                    if (g.bubbleStart !== false) {
                        const el = handlesRef.current.get(`${g.id}:start`);
                        if (el) {
                            const p = project(first, cam, w, h);
                            if (p.visible) {
                                el.removeAttribute("display");
                                // start 側は last → first 方向 = (-offX, -offY)
                                const x = p.x - offX;
                                const y = p.y - offY;
                                el.setAttribute("transform", `translate(${x.toFixed(1)},${y.toFixed(1)})`);
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
                                // end 側は first → last 方向 = (+offX, +offY)
                                const x = p.x + offX;
                                const y = p.y + offY;
                                el.setAttribute("transform", `translate(${x.toFixed(1)},${y.toFixed(1)})`);
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
    }, [grids, enabled, inGridlineEditMode, getCamera, getCanvas]);

    if (!enabled || grids.length === 0) return null;

    const setHandle = (key: string) => (el: SVGGElement | null) => {
        if (el) handlesRef.current.set(key, el);
        else handlesRef.current.delete(key);
    };

    return (
        <svg
            ref={svgRef}
            className="absolute inset-0 w-full h-full pointer-events-none"
            // GridEditOverlay (= zIndex 16) のオレンジ頂点ハンドルより上に出して
            // ラベルが必ず読めるようにする。バブル自体は pointerEvents:none なので
            // ハンドルのクリック判定は (オフセット後の) 元の頂点位置に届く。
            style={{ zIndex: 17 }}
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
