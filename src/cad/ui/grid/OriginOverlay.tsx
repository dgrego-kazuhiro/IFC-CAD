"use client";

import React, { useEffect, useRef } from "react";
import { mat4, vec4 } from "gl-matrix";
import { useAppState, AppState } from "../../application/AppState";
import { Camera } from "../../renderer/camera/Camera";
import { Vec3 } from "../../geometry/math/Vec3";
import {
    ORIGIN_X_COLOR, ORIGIN_Z_COLOR, ORIGIN_DOT_FILL, ORIGIN_DOT_STROKE,
    ORIGIN_AXIS_LEN_PX, ORIGIN_DOT_RADIUS, ORIGIN_STROKE_WIDTH,
} from "../snapStyle";

interface Props {
    getCamera: () => Camera | null;
    getCanvas: () => HTMLCanvasElement | null;
}

function project(world: Vec3, camera: Camera, width: number, height: number):
    { x: number; y: number; visible: boolean } {
    const viewProj = mat4.create();
    mat4.multiply(viewProj, camera.projectionMatrix, camera.viewMatrix);
    const v = vec4.fromValues(world[0], world[1], world[2], 1);
    vec4.transformMat4(v, v, viewProj);
    if (v[3] === 0) return { x: 0, y: 0, visible: false };
    const x = (v[0] / v[3] + 1) * 0.5 * width;
    const y = (1 - (v[1] / v[3] + 1) * 0.5) * height;
    return { x, y, visible: v[3] > 0 };
}

/**
 * 原点シンボル (= 短い X/Z 軸 + 白丸) を 2D オーバーレイとして表示。
 *
 * Room モードでは `RoomSketchOverlay` の WebGPU buildDrawLists が原点を
 * 描画しているのでここでは出さない (= Room モード時は disabled)。
 * それ以外の 2D モード (= 通芯モード / 柱・梁モード等) では Room 用の
 * オーバーレイが mount されないので、この SVG オーバーレイで原点を出す。
 */
export default function OriginOverlay({ getCamera, getCanvas }: Props) {
    const activeRoomId = useAppState((s: AppState) => s.activeRoomId);
    const pendingRoomLevelId = useAppState((s: AppState) => s.pendingRoomLevelId);
    const viewMode = useAppState((s: AppState) => s.viewMode);
    const svgRef = useRef<SVGSVGElement>(null);
    const groupRef = useRef<SVGGElement>(null);

    // Room モード中は RoomSketchOverlay 側が描画 (重複を避ける)。
    // 3D ビューでも原点シンボルは 2D 平面上で意味が薄いので非表示。
    const inRoomMode = !!activeRoomId || !!pendingRoomLevelId;
    const enabled = !inRoomMode && viewMode === "2D";

    useEffect(() => {
        if (!enabled) return;
        let raf = 0;
        const tick = () => {
            const cam = getCamera();
            const canvas = getCanvas();
            const g = groupRef.current;
            if (cam && canvas && g) {
                const w = canvas.clientWidth;
                const h = canvas.clientHeight;
                const o = project([0, 0, 0], cam, w, h);
                if (o.visible) {
                    g.removeAttribute("display");
                    g.setAttribute("transform", `translate(${o.x.toFixed(1)},${o.y.toFixed(1)})`);
                } else {
                    g.setAttribute("display", "none");
                }
                // X 軸方向 (= world +X) と Z 軸方向 (= world +Z) を画面座標で
                // 取り、軸線の向きを camera 回転に追従させる。
                const xEnd = project([1, 0, 0], cam, w, h);
                const zEnd = project([0, 0, 1], cam, w, h);
                const xLine = g.querySelector<SVGLineElement>("line.origin-x");
                const zLine = g.querySelector<SVGLineElement>("line.origin-z");
                if (o.visible && xLine) {
                    const dx = xEnd.x - o.x;
                    const dy = xEnd.y - o.y;
                    const len = Math.hypot(dx, dy);
                    if (len > 1e-3) {
                        const ux = (dx / len) * ORIGIN_AXIS_LEN_PX;
                        const uy = (dy / len) * ORIGIN_AXIS_LEN_PX;
                        xLine.setAttribute("x2", ux.toFixed(1));
                        xLine.setAttribute("y2", uy.toFixed(1));
                    }
                }
                if (o.visible && zLine) {
                    const dx = zEnd.x - o.x;
                    const dy = zEnd.y - o.y;
                    const len = Math.hypot(dx, dy);
                    if (len > 1e-3) {
                        const ux = (dx / len) * ORIGIN_AXIS_LEN_PX;
                        const uy = (dy / len) * ORIGIN_AXIS_LEN_PX;
                        zLine.setAttribute("x2", ux.toFixed(1));
                        zLine.setAttribute("y2", uy.toFixed(1));
                    }
                }
            }
            raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(raf);
    }, [enabled, getCamera, getCanvas]);

    if (!enabled) return null;

    return (
        <svg
            ref={svgRef}
            className="absolute inset-0 w-full h-full pointer-events-none"
            // GridBubbleOverlay (= 17) より少し下、軸ガイド (= GridAxisGuideOverlay)
            // と同程度の z 順。
            style={{ zIndex: 14 }}
        >
            <g ref={groupRef}>
                {/* X 軸 (= world +X、赤) */}
                <line className="origin-x" x1={0} y1={0} x2={ORIGIN_AXIS_LEN_PX} y2={0}
                    stroke={ORIGIN_X_COLOR} strokeWidth={ORIGIN_STROKE_WIDTH} strokeLinecap="round" />
                {/* Z 軸 (= world +Z、緑) */}
                <line className="origin-z" x1={0} y1={0} x2={0} y2={ORIGIN_AXIS_LEN_PX}
                    stroke={ORIGIN_Z_COLOR} strokeWidth={ORIGIN_STROKE_WIDTH} strokeLinecap="round" />
                {/* 中心ドット */}
                <circle r={ORIGIN_DOT_RADIUS} fill={ORIGIN_DOT_FILL} stroke={ORIGIN_DOT_STROKE} strokeWidth={ORIGIN_STROKE_WIDTH} />
            </g>
        </svg>
    );
}
