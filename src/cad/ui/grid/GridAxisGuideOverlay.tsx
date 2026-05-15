"use client";

import React, { useEffect, useRef } from "react";
import { mat4, vec4 } from "gl-matrix";
import { Camera } from "../../renderer/camera/Camera";
import { Vec3 } from "../../geometry/math/Vec3";
import { AxisAlignSnapResult } from "../../model/grid/GridSnap";
import {
    SNAP_GUIDE_COLOR, SNAP_GUIDE_WIDTH, SNAP_GUIDE_DASH,
    SNAP_GUIDE_TEXT_HALO, SNAP_LABEL_FONT_SIZE, SNAP_LABEL_FONT_WEIGHT,
    SNAP_LABEL_FONT_FAMILY, SNAP_LABEL_HALO_WIDTH,
} from "../snapStyle";

interface Props {
    getCamera: () => Camera | null;
    getCanvas: () => HTMLCanvasElement | null;
    /** AxisAlignSnapResult — gridline 作図中の軸整列スナップ。null なら非表示。 */
    axisSnap: AxisAlignSnapResult | null;
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

/** mm 単位で距離をフォーマット (10mm 未満は浮動小数まで)。 */
function fmtDistance(meters: number): string {
    const mm = meters * 1000;
    if (mm >= 1000) return `${(mm / 1000).toFixed(2)} m`;
    if (mm >= 10) return `${mm.toFixed(0)} mm`;
    return `${mm.toFixed(1)} mm`;
}

/**
 * 通芯作図中の軸整列ガイド (cyan の点線) と距離ラベルを SVG で描画。
 * 世界空間メッシュではなく screen-space SVG を使うことで、線幅 1px ・点線
 * パターン・距離テキストが camera 距離に依存しない一定見た目になる。
 */
export default function GridAxisGuideOverlay({ getCamera, getCanvas, axisSnap }: Props) {
    const svgRef = useRef<SVGSVGElement>(null);
    const guideHRef = useRef<SVGLineElement>(null);
    const guideVRef = useRef<SVGLineElement>(null);
    const labelHRef = useRef<SVGGElement>(null);
    const labelVRef = useRef<SVGGElement>(null);

    useEffect(() => {
        if (!axisSnap) return;
        let raf = 0;
        const tick = () => {
            const cam = getCamera();
            const canvas = getCanvas();
            const svg = svgRef.current;
            if (cam && canvas && svg) {
                const w = canvas.clientWidth;
                const h = canvas.clientHeight;
                const sp = axisSnap.point;
                const cursor = project(sp, cam, w, h);

                const guideH = guideHRef.current;
                const labelH = labelHRef.current;
                if (guideH && labelH) {
                    if (axisSnap.refPointH && cursor.visible) {
                        const r = axisSnap.refPointH;
                        const refScreen = project(r, cam, w, h);
                        if (refScreen.visible) {
                            guideH.setAttribute("x1", refScreen.x.toFixed(1));
                            guideH.setAttribute("y1", refScreen.y.toFixed(1));
                            guideH.setAttribute("x2", cursor.x.toFixed(1));
                            guideH.setAttribute("y2", refScreen.y.toFixed(1));
                            guideH.removeAttribute("display");
                            // 距離 (X 方向) を H ガイド中点上に表示。
                            const distM = Math.abs(sp[0] - r[0]);
                            const mx = (refScreen.x + cursor.x) / 2;
                            const my = refScreen.y;
                            labelH.setAttribute(
                                "transform",
                                `translate(${mx.toFixed(1)},${(my - 6).toFixed(1)})`,
                            );
                            const t = labelH.querySelector("text");
                            if (t) t.textContent = fmtDistance(distM);
                            labelH.removeAttribute("display");
                        } else {
                            guideH.setAttribute("display", "none");
                            labelH.setAttribute("display", "none");
                        }
                    } else {
                        guideH.setAttribute("display", "none");
                        labelH.setAttribute("display", "none");
                    }
                }

                const guideV = guideVRef.current;
                const labelV = labelVRef.current;
                if (guideV && labelV) {
                    if (axisSnap.refPointV && cursor.visible) {
                        const r = axisSnap.refPointV;
                        const refScreen = project(r, cam, w, h);
                        if (refScreen.visible) {
                            guideV.setAttribute("x1", refScreen.x.toFixed(1));
                            guideV.setAttribute("y1", refScreen.y.toFixed(1));
                            guideV.setAttribute("x2", refScreen.x.toFixed(1));
                            guideV.setAttribute("y2", cursor.y.toFixed(1));
                            guideV.removeAttribute("display");
                            // 距離 (Z 方向) を V ガイド中点に表示。
                            const distM = Math.abs(sp[2] - r[2]);
                            const mx = refScreen.x;
                            const my = (refScreen.y + cursor.y) / 2;
                            labelV.setAttribute(
                                "transform",
                                `translate(${(mx + 6).toFixed(1)},${my.toFixed(1)})`,
                            );
                            const t = labelV.querySelector("text");
                            if (t) t.textContent = fmtDistance(distM);
                            labelV.removeAttribute("display");
                        } else {
                            guideV.setAttribute("display", "none");
                            labelV.setAttribute("display", "none");
                        }
                    } else {
                        guideV.setAttribute("display", "none");
                        labelV.setAttribute("display", "none");
                    }
                }
            }
            raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(raf);
    }, [axisSnap, getCamera, getCanvas]);

    if (!axisSnap) return null;

    return (
        <svg
            ref={svgRef}
            className="absolute inset-0 w-full h-full pointer-events-none"
            style={{ zIndex: 12 }}
        >
            <line
                ref={guideHRef}
                stroke={SNAP_GUIDE_COLOR}
                strokeWidth={SNAP_GUIDE_WIDTH}
                strokeDasharray={SNAP_GUIDE_DASH}
            />
            <line
                ref={guideVRef}
                stroke={SNAP_GUIDE_COLOR}
                strokeWidth={SNAP_GUIDE_WIDTH}
                strokeDasharray={SNAP_GUIDE_DASH}
            />
            <g ref={labelHRef}>
                <text
                    textAnchor="middle"
                    dominantBaseline="alphabetic"
                    fontSize={SNAP_LABEL_FONT_SIZE}
                    fontWeight={SNAP_LABEL_FONT_WEIGHT}
                    fill={SNAP_GUIDE_COLOR}
                    stroke={SNAP_GUIDE_TEXT_HALO}
                    strokeWidth={SNAP_LABEL_HALO_WIDTH}
                    paintOrder="stroke"
                    fontFamily={SNAP_LABEL_FONT_FAMILY}
                />
            </g>
            <g ref={labelVRef}>
                <text
                    textAnchor="start"
                    dominantBaseline="central"
                    fontSize={SNAP_LABEL_FONT_SIZE}
                    fontWeight={SNAP_LABEL_FONT_WEIGHT}
                    fill={SNAP_GUIDE_COLOR}
                    stroke={SNAP_GUIDE_TEXT_HALO}
                    strokeWidth={SNAP_LABEL_HALO_WIDTH}
                    paintOrder="stroke"
                    fontFamily={SNAP_LABEL_FONT_FAMILY}
                />
            </g>
        </svg>
    );
}
