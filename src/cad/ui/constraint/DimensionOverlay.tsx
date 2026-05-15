"use client";

import React, { useEffect, useRef } from "react";
import { mat4, vec4 } from "gl-matrix";
import { useAppState, AppState } from "../../application/AppState";
import { Camera } from "../../renderer/camera/Camera";
import { ColumnElement } from "../../model/elements/ColumnElement";
import { columnFootprint2D } from "../../mesh/builders/ColumnMeshBuilder";
import { gridVertices } from "../../model/grid/GridLine";
import type { ConstraintTarget } from "../../model/constraint/Constraint";
import type { GridLine } from "../../model/grid/GridLine";
import {
    COLOR_POSITION, COLOR_DIMENSION, COLOR_DIM_TEXT, COLOR_LABEL_BG,
    DIM_LINE_WIDTH, DIM_ARROW_PX, DIM_OFFSET_PX, DIM_EXT_EXTRA_PX,
    DIM_RIGHTANGLE_PX, DIM_FONT,
} from "./constraintStyle";

interface Props {
    getCamera: () => Camera | null;
    getCanvas: () => HTMLCanvasElement | null;
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

function drawArrowhead(
    ctx: CanvasRenderingContext2D,
    tipX: number, tipY: number,
    dirX: number, dirY: number, // 矢頭が向く方向 (正規化済)
    size: number,
) {
    const angle = 0.35; // ラジアン
    const ax = -dirX * size * Math.cos(angle) + dirY * size * Math.sin(angle);
    const ay = -dirY * size * Math.cos(angle) - dirX * size * Math.sin(angle);
    const bx = -dirX * size * Math.cos(angle) - dirY * size * Math.sin(angle);
    const by = -dirY * size * Math.cos(angle) + dirX * size * Math.sin(angle);
    ctx.beginPath();
    ctx.moveTo(tipX, tipY);
    ctx.lineTo(tipX + ax, tipY + ay);
    ctx.moveTo(tipX, tipY);
    ctx.lineTo(tipX + bx, tipY + by);
    ctx.stroke();
}

/**
 * HorizDistance / VertDistance 拘束の寸法線 (矢印 + 値) を描画するオーバーレイ。
 * Column モード時のみ表示。
 */
// XZ 平面上の点座標を返す (各ターゲット種別を共通化)
function resolvePointXZ(
    t: ConstraintTarget,
    elements: Record<string, any>,
    grids: GridLine[],
): [number, number] | null {
    if (t.kind === "ColumnVertex") {
        const col = elements[(t as any).columnId] as ColumnElement | undefined;
        if (!col?.basePoint) return null;
        const fp = columnFootprint2D(col);
        const v = fp[(t as any).vertexIdx];
        return v ? [v[0], v[1]] : null;
    }
    if (t.kind === "Column") {
        const col = elements[(t as any).columnId] as ColumnElement | undefined;
        if (!col?.basePoint) return null;
        return [col.basePoint[0], col.basePoint[2]];
    }
    if (t.kind === "SketchPoint") {
        const sp = elements[(t as any).spaceId] as any;
        const poly = (sp?.polygons ?? []).find((p: any) => p.id === (t as any).polyId);
        const v = poly?.outer?.[(t as any).vertexIdx];
        return v ? [v[0], v[1]] : null;
    }
    if (t.kind === "WallAxisPoint") {
        const w = elements[(t as any).wallId] as any;
        const a = w?.axis?.[(t as any).endIdx];
        return a ? [a[0], a[2]] : null;
    }
    if (t.kind === "GridPoint") {
        const g = grids.find((gg) => gg.id === (t as any).gridId);
        if (!g) return null;
        const verts = gridVertices(g.curve);
        const v = verts[(t as any).vertexIdx];
        return v ? [v[0], v[2]] : null;
    }
    if (t.kind === "Origin") return [0, 0];
    return null;
}

export default function DimensionOverlay({ getCamera, getCanvas }: Props) {
    const elements = useAppState((s: AppState) => s.elements);
    const constraints = useAppState((s: AppState) => s.constraints);
    const grids = useAppState((s: AppState) => s.grids);
    const activeTool = useAppState((s: AppState) => s.activeTool);

    const elementsRef = useRef(elements);
    elementsRef.current = elements;
    const constraintsRef = useRef(constraints);
    constraintsRef.current = constraints;
    const gridsRef = useRef(grids);
    gridsRef.current = grids;
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
            const cons = constraintsRef.current;

            const proj = (x: number, y: number, z: number) =>
                projectWorld(x, y, z, cam, w, h);

            for (const id in cons) {
                const c = cons[id];
                if (c.type !== "HorizDistance" && c.type !== "VertDistance") continue;
                if (c.value == null) continue;

                // Column ターゲットのみ対応
                const colTargets = c.targets.filter((t) => t.kind === "Column");
                if (colTargets.length < 2) continue;
                const col0 = elems[(colTargets[0] as any).columnId as string] as ColumnElement | undefined;
                const col1 = elems[(colTargets[1] as any).columnId as string] as ColumnElement | undefined;
                if (!col0?.basePoint || !col1?.basePoint) continue;

                const p0 = proj(col0.basePoint[0], 0, col0.basePoint[2]);
                const p1 = proj(col1.basePoint[0], 0, col1.basePoint[2]);
                if (!p0.visible || !p1.visible) continue;

                const isHoriz = c.type === "HorizDistance";
                const label = `${Math.round(Math.abs(c.value) * 1000)} mm`;

                ctx.save();
                ctx.strokeStyle = COLOR_POSITION;
                ctx.lineWidth = DIM_LINE_WIDTH;

                if (isHoriz) {
                    // 寸法線: p0/p1 の上方 (小さい screen-Y 側) に水平に引く
                    const dimY = Math.min(p0.y, p1.y) - DIM_OFFSET_PX;
                    const xLeft  = Math.min(p0.x, p1.x);
                    const xRight = Math.max(p0.x, p1.x);

                    // 延長線 (各柱中心 → 寸法線)
                    ctx.beginPath();
                    ctx.moveTo(p0.x, p0.y);
                    ctx.lineTo(p0.x, dimY - DIM_EXT_EXTRA_PX);
                    ctx.stroke();
                    ctx.beginPath();
                    ctx.moveTo(p1.x, p1.y);
                    ctx.lineTo(p1.x, dimY - DIM_EXT_EXTRA_PX);
                    ctx.stroke();

                    // 寸法線本体
                    ctx.beginPath();
                    ctx.moveTo(xLeft, dimY);
                    ctx.lineTo(xRight, dimY);
                    ctx.stroke();

                    // 矢頭
                    drawArrowhead(ctx, xLeft,  dimY, -1, 0, DIM_ARROW_PX);
                    drawArrowhead(ctx, xRight, dimY,  1, 0, DIM_ARROW_PX);

                    // テキスト
                    const mx = (xLeft + xRight) / 2;
                    ctx.font = DIM_FONT;
                    ctx.textAlign = "center";
                    ctx.textBaseline = "bottom";
                    // 背景白帯
                    const tw = ctx.measureText(label).width;
                    ctx.fillStyle = COLOR_LABEL_BG;
                    ctx.fillRect(mx - tw / 2 - 3, dimY - 14, tw + 6, 13);
                    ctx.fillStyle = COLOR_DIM_TEXT;
                    ctx.fillText(label, mx, dimY - 2);

                } else {
                    // VertDistance: 寸法線を左方 (小さい screen-X 側) に縦に引く
                    const dimX = Math.min(p0.x, p1.x) - DIM_OFFSET_PX;
                    const yTop    = Math.min(p0.y, p1.y);
                    const yBottom = Math.max(p0.y, p1.y);

                    // 延長線
                    ctx.beginPath();
                    ctx.moveTo(p0.x, p0.y);
                    ctx.lineTo(dimX - DIM_EXT_EXTRA_PX, p0.y);
                    ctx.stroke();
                    ctx.beginPath();
                    ctx.moveTo(p1.x, p1.y);
                    ctx.lineTo(dimX - DIM_EXT_EXTRA_PX, p1.y);
                    ctx.stroke();

                    // 寸法線本体
                    ctx.beginPath();
                    ctx.moveTo(dimX, yTop);
                    ctx.lineTo(dimX, yBottom);
                    ctx.stroke();

                    // 矢頭
                    drawArrowhead(ctx, dimX, yTop,    0, -1, DIM_ARROW_PX);
                    drawArrowhead(ctx, dimX, yBottom, 0,  1, DIM_ARROW_PX);

                    // テキスト (90度回転)
                    const my = (yTop + yBottom) / 2;
                    ctx.font = DIM_FONT;
                    const tw = ctx.measureText(label).width;
                    ctx.save();
                    ctx.translate(dimX - 4, my);
                    ctx.rotate(-Math.PI / 2);
                    ctx.textAlign = "center";
                    ctx.textBaseline = "bottom";
                    ctx.fillStyle = COLOR_LABEL_BG;
                    ctx.fillRect(-tw / 2 - 3, -13, tw + 6, 13);
                    ctx.fillStyle = COLOR_DIM_TEXT;
                    ctx.fillText(label, 0, -2);
                    ctx.restore();
                }

                ctx.restore();
            }

            // ── PerpDistance (ColumnEdge + 点) の寸法線 ────────────────────
            const gridsSnap = gridsRef.current;
            const pointKinds = new Set([
                "SketchPoint", "WallAxisPoint", "Column", "ColumnVertex", "GridPoint", "Origin",
            ]);
            for (const id in cons) {
                const c = cons[id];
                if (c.type !== "PerpDistance") continue;
                if (c.value == null) continue;

                const edgeTgt = c.targets.find((t) => t.kind === "ColumnEdge");
                if (!edgeTgt || edgeTgt.kind !== "ColumnEdge") continue;

                const ptTgt = c.targets.find((t) => pointKinds.has(t.kind));
                if (!ptTgt) continue;

                // 柱辺の端点
                const col = elems[(edgeTgt as any).columnId] as ColumnElement | undefined;
                if (!col?.basePoint) continue;
                const fp = columnFootprint2D(col);
                const n = fp.length;
                const ai = (edgeTgt as any).edgeIdx as number;
                if (ai < 0 || ai >= n) continue;
                const aW = fp[ai];
                const bW = fp[(ai + 1) % n];

                // 点のワールド XZ
                const pXZ = resolvePointXZ(ptTgt, elems, gridsSnap);
                if (!pXZ) continue;

                // 垂線の足を計算
                const dx = bW[0] - aW[0], dz = bW[1] - aW[1];
                const edgeLen = Math.hypot(dx, dz);
                if (edgeLen < 1e-9) continue;
                const ux = dx / edgeLen, uz = dz / edgeLen;
                const t2 = (pXZ[0] - aW[0]) * ux + (pXZ[1] - aW[1]) * uz;
                const fx = aW[0] + t2 * ux;
                const fz = aW[1] + t2 * uz;

                // スクリーン投影
                const pS = proj(pXZ[0], 0, pXZ[1]);
                const fS = proj(fx, 0, fz);
                if (!pS.visible || !fS.visible) continue;

                const dsx = fS.x - pS.x, dsy = fS.y - pS.y;
                const screenDist = Math.hypot(dsx, dsy);
                if (screenDist < 2) continue;

                ctx.save();
                ctx.strokeStyle = COLOR_DIMENSION;
                ctx.lineWidth = DIM_LINE_WIDTH;

                // 寸法線本体 (点 → 足)
                const ndx = dsx / screenDist, ndy = dsy / screenDist;
                ctx.beginPath();
                ctx.moveTo(pS.x, pS.y);
                ctx.lineTo(fS.x, fS.y);
                ctx.stroke();

                // 矢頭
                drawArrowhead(ctx, pS.x, pS.y, -ndx, -ndy, DIM_ARROW_PX);
                drawArrowhead(ctx, fS.x, fS.y,  ndx,  ndy, DIM_ARROW_PX);

                // 直角記号 (辺の方向に沿って小さな L 字)
                const aS = proj(aW[0], 0, aW[1]);
                const bS = proj(bW[0], 0, bW[1]);
                const edSX = bS.x - aS.x, edSY = bS.y - aS.y;
                const edSLen = Math.hypot(edSX, edSY);
                if (edSLen > 1e-3) {
                    const ex = edSX / edSLen, ey = edSY / edSLen;
                    const px2 = -ndx, py2 = -ndy;
                    ctx.beginPath();
                    ctx.moveTo(fS.x + ex * DIM_RIGHTANGLE_PX, fS.y + ey * DIM_RIGHTANGLE_PX);
                    ctx.lineTo(fS.x + ex * DIM_RIGHTANGLE_PX + px2 * DIM_RIGHTANGLE_PX, fS.y + ey * DIM_RIGHTANGLE_PX + py2 * DIM_RIGHTANGLE_PX);
                    ctx.lineTo(fS.x + px2 * DIM_RIGHTANGLE_PX, fS.y + py2 * DIM_RIGHTANGLE_PX);
                    ctx.stroke();
                }

                // ラベル (寸法線の中点)
                const label = `${Math.round(Math.abs(c.value) * 1000)} mm`;
                const mx = (pS.x + fS.x) / 2;
                const my = (pS.y + fS.y) / 2;
                ctx.font = DIM_FONT;
                const tw = ctx.measureText(label).width;
                const ox = -ndy * 12, oy = ndx * 12;
                ctx.fillStyle = COLOR_LABEL_BG;
                ctx.fillRect(mx + ox - tw / 2 - 3, my + oy - 13, tw + 6, 13);
                ctx.fillStyle = COLOR_DIM_TEXT;
                ctx.textAlign = "center";
                ctx.textBaseline = "bottom";
                ctx.fillText(label, mx + ox, my + oy - 1);

                ctx.restore();
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
            style={{ zIndex: 18 }}
        />
    );
}
