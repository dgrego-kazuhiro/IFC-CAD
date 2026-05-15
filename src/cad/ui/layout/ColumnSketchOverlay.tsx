"use client";

import React, { useEffect, useRef } from "react";
import { mat4, vec4 } from "gl-matrix";
import { useAppState, AppState, SketchSelectionItem } from "../../application/AppState";
import { Camera } from "../../renderer/camera/Camera";
import { ColumnElement } from "../../model/elements/ColumnElement";
import { columnFootprint2D } from "../../mesh/builders/ColumnMeshBuilder";

interface Props {
    getCamera: () => Camera | null;
    getCanvas: () => HTMLCanvasElement | null;
    hoverItem: SketchSelectionItem | null;
}

function projectWorld(
    wx: number, wy: number, wz: number,
    camera: Camera, w: number, h: number,
): { x: number; y: number; visible: boolean } {
    const vp = mat4.create();
    mat4.multiply(vp, camera.projectionMatrix, camera.viewMatrix);
    const v = vec4.fromValues(wx, wy, wz, 1);
    vec4.transformMat4(v, v, vp);
    if (v[3] === 0) return { x: 0, y: 0, visible: false };
    return {
        x: (v[0] / v[3] + 1) * 0.5 * w,
        y: (1 - (v[1] / v[3] + 1) * 0.5) * h,
        visible: v[3] > 0,
    };
}

/**
 * 柱 (Rectangle/Arbitrary) のフットプリント頂点・エッジをオーバーレイ表示。
 * - 常時: 頂点ドット + 薄い輪郭線
 * - ホバー: 頂点 or 辺を強調 (オレンジ)
 * - 選択済み: オレンジ (柱中心選択は全体オレンジ)
 * Column モード時のみ描画。
 */
export default function ColumnSketchOverlay({ getCamera, getCanvas, hoverItem }: Props) {
    const elements = useAppState((s: AppState) => s.elements);
    const sketchSelection = useAppState((s: AppState) => s.sketchSelection);
    const activeTool = useAppState((s: AppState) => s.activeTool);

    const elementsRef = useRef(elements);
    elementsRef.current = elements;
    const sketchSelRef = useRef(sketchSelection);
    sketchSelRef.current = sketchSelection;
    const hoverRef = useRef<SketchSelectionItem | null>(hoverItem);
    hoverRef.current = hoverItem;
    const activeToolRef = useRef(activeTool);
    activeToolRef.current = activeTool;

    const canvasRef = useRef<HTMLCanvasElement>(null);

    useEffect(() => {
        let raf = 0;
        const draw = () => {
            const cam = getCamera();
            const mainCanvas = getCanvas();
            const myCanvas = canvasRef.current;

            if (!cam || !mainCanvas || !myCanvas) {
                raf = requestAnimationFrame(draw);
                return;
            }

            const w = mainCanvas.clientWidth;
            const h = mainCanvas.clientHeight;
            if (myCanvas.width !== w) myCanvas.width = w;
            if (myCanvas.height !== h) myCanvas.height = h;

            const ctx = myCanvas.getContext("2d");
            if (!ctx) { raf = requestAnimationFrame(draw); return; }
            ctx.clearRect(0, 0, w, h);

            if (activeToolRef.current !== "column") {
                raf = requestAnimationFrame(draw);
                return;
            }

            const elems = elementsRef.current;
            const sel = sketchSelRef.current;
            const hover = hoverRef.current;

            const proj = (x: number, y: number, z: number) =>
                projectWorld(x, y, z, cam, w, h);

            for (const id in elems) {
                const el = elems[id];
                if (!el || el.type !== "Column") continue;
                const col = el as ColumnElement;
                if (!col.basePoint || col.profile.kind === "Circle") continue;
                const fp = columnFootprint2D(col);
                const n = fp.length;
                if (n < 3) continue;
                const gy = col.basePoint[1];

                // Screen positions of footprint vertices
                const pts = fp.map(v => proj(v[0], gy, v[1]));

                // 柱中心が選択されている場合は全体をオレンジで表示
                const isColCenterSel = sel.some(s => s.kind === "column" && s.columnId === id);

                // --- Footprint edges ---
                for (let i = 0; i < n; i++) {
                    const a = pts[i];
                    const b = pts[(i + 1) % n];
                    if (!a.visible || !b.visible) continue;

                    const isHov = hover?.kind === "columnEdge"
                        && (hover as any).columnId === id && (hover as any).edgeIdx === i;
                    const isSel = isColCenterSel || sel.some(s =>
                        s.kind === "columnEdge" && s.columnId === id && s.edgeIdx === i);

                    ctx.beginPath();
                    ctx.moveTo(a.x, a.y);
                    ctx.lineTo(b.x, b.y);
                    ctx.strokeStyle = isSel ? "#f97316" : isHov ? "#fb923c" : "rgba(59,130,246,0.45)";
                    ctx.lineWidth = isHov || isSel ? 2.5 : 1.5;
                    ctx.stroke();
                }

                // --- Vertex dots (drawn last = on top) ---
                for (let i = 0; i < n; i++) {
                    const pv = pts[i];
                    if (!pv.visible) continue;

                    const isHov = hover?.kind === "columnVertex"
                        && (hover as any).columnId === id && (hover as any).vertexIdx === i;
                    const isSel = isColCenterSel || sel.some(s =>
                        s.kind === "columnVertex" && s.columnId === id && s.vertexIdx === i);

                    const r = isSel ? 5.5 : isHov ? 5 : 3.5;
                    ctx.beginPath();
                    ctx.arc(pv.x, pv.y, r, 0, Math.PI * 2);
                    ctx.fillStyle = isSel ? "#f97316" : isHov ? "#60a5fa" : "rgb(55,65,81)";
                    ctx.strokeStyle = "white";
                    ctx.lineWidth = isSel ? 1.8 : 1.2;
                    ctx.fill();
                    ctx.stroke();
                }
            }

            raf = requestAnimationFrame(draw);
        };
        raf = requestAnimationFrame(draw);
        return () => cancelAnimationFrame(raf);
    }, [getCamera, getCanvas]);

    return (
        <canvas
            ref={canvasRef}
            className="absolute inset-0 pointer-events-none"
            style={{ zIndex: 17 }}
        />
    );
}
