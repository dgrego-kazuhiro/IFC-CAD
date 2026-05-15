"use client";

import React, { useEffect, useRef } from "react";
import { mat4, vec4 } from "gl-matrix";
import { Camera } from "../../renderer/camera/Camera";
import { Vec3 } from "../../geometry/math/Vec3";
import { SNAP_OBJ_COLOR, SNAP_STROKE_COLOR, SNAP_STROKE_WIDTH, SNAP_MARKER_HALF } from "../snapStyle";

interface Props {
    getCamera: () => Camera | null;
    getCanvas: () => HTMLCanvasElement | null;
    /** 表示したい snap 対象点 (world)。`null` の場合シンボル非表示。 */
    point: Vec3 | null;
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
 * 全ツール (column / beam / room / slab / gridline 等) で共通の snap シンボル。
 * 16px 緑塗り四角 + 白枠 (= RoomSketchOverlay の obj-snap と同系色)。
 * ズーム / カメラ距離に依らず常に 16px 表示する (= CSS pixel 単位 SVG)。
 */
export default function SnapSymbolOverlay({ getCamera, getCanvas, point }: Props) {
    const pointRef = useRef<Vec3 | null>(point);
    pointRef.current = point;
    const groupRef = useRef<SVGGElement>(null);

    useEffect(() => {
        let raf = 0;
        const tick = () => {
            const cam = getCamera();
            const canvas = getCanvas();
            const g = groupRef.current;
            const pt = pointRef.current;
            if (cam && canvas && g) {
                if (pt) {
                    const p = project(pt, cam, canvas.clientWidth, canvas.clientHeight);
                    if (p.visible) {
                        g.removeAttribute("display");
                        g.setAttribute("transform", `translate(${p.x.toFixed(1)},${p.y.toFixed(1)})`);
                    } else {
                        g.setAttribute("display", "none");
                    }
                } else {
                    g.setAttribute("display", "none");
                }
            }
            raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(raf);
    }, [getCamera, getCanvas]);

    return (
        <svg
            className="absolute inset-0 w-full h-full pointer-events-none"
            style={{ zIndex: 18 }}
        >
            <g ref={groupRef} display="none">
                <rect
                    x={-SNAP_MARKER_HALF} y={-SNAP_MARKER_HALF}
                    width={SNAP_MARKER_HALF * 2} height={SNAP_MARKER_HALF * 2}
                    fill={SNAP_OBJ_COLOR}
                    stroke={SNAP_STROKE_COLOR}
                    strokeWidth={SNAP_STROKE_WIDTH}
                />
            </g>
        </svg>
    );
}
