"use client";

import React, { useEffect, useRef } from "react";
import { mat4, vec4 } from "gl-matrix";
import {
    useAppState,
    AppState,
    RESIDENTIAL_GRID_PRIMARY_M,
    RESIDENTIAL_GRID_SECONDARY_M,
} from "../../application/AppState";
import { Camera } from "../../renderer/camera/Camera";

interface Props {
    getCamera: () => Camera | null;
    getCanvas: () => HTMLCanvasElement | null;
}

interface Pt2 { x: number; y: number; visible: boolean; }

function projectXZ(wx: number, wz: number, viewProj: mat4, w: number, h: number): Pt2 {
    const v = vec4.fromValues(wx, 0, wz, 1);
    vec4.transformMat4(v, v, viewProj);
    if (v[3] === 0) return { x: 0, y: 0, visible: false };
    const x = (v[0] / v[3] + 1) * 0.5 * w;
    const y = (1 - (v[1] / v[3] + 1) * 0.5) * h;
    return { x, y, visible: v[3] > 0 };
}

/** World-space half-extent (metres) drawn around the origin. The lines
 *  outside the canvas are clipped by the SVG viewBox automatically — we
 *  just keep the count manageable. ±25m → 50m × 50m at 455mm = 110 lines. */
const HALF_EXTENT_M = 25;

/**
 * Renders the 910mm primary + 455mm secondary residential grid as a screen-
 * space SVG overlay. Active only when designMode === "jpResidentialGrid".
 * Lines are projected per-frame so the grid stays correct under any camera.
 */
export default function ResidentialGridOverlay({ getCamera, getCanvas }: Props) {
    const designMode = useAppState((s: AppState) => s.designMode);
    const svgRef = useRef<SVGSVGElement>(null);
    const groupRef = useRef<SVGGElement>(null);

    const enabled = designMode === "jpResidentialGrid";

    useEffect(() => {
        if (!enabled) return;
        let raf = 0;
        const tick = () => {
            const cam = getCamera();
            const canvas = getCanvas();
            const grp = groupRef.current;
            if (cam && canvas && grp) {
                const w = canvas.clientWidth;
                const h = canvas.clientHeight;
                const viewProj = mat4.create();
                mat4.multiply(viewProj, cam.projectionMatrix, cam.viewMatrix);

                // Re-issue all lines each frame. SVG handles ~600 lines fine.
                // Build one big <path> with M/L pairs to keep DOM cheap.
                const dPrimary: string[] = [];
                const dSecondary: string[] = [];

                const stepP = RESIDENTIAL_GRID_PRIMARY_M;
                const stepS = RESIDENTIAL_GRID_SECONDARY_M;
                const minM = -HALF_EXTENT_M;
                const maxM = HALF_EXTENT_M;

                // Verticals (constant X, span Z)
                for (let i = Math.ceil(minM / stepS); i * stepS <= maxM; i++) {
                    const x = i * stepS;
                    const a = projectXZ(x, minM, viewProj, w, h);
                    const b = projectXZ(x, maxM, viewProj, w, h);
                    if (!a.visible || !b.visible) continue;
                    const isPrimary = Math.abs((x / stepP) - Math.round(x / stepP)) < 1e-6;
                    (isPrimary ? dPrimary : dSecondary).push(
                        `M${a.x.toFixed(1)} ${a.y.toFixed(1)}L${b.x.toFixed(1)} ${b.y.toFixed(1)}`,
                    );
                }
                // Horizontals (constant Z, span X)
                for (let i = Math.ceil(minM / stepS); i * stepS <= maxM; i++) {
                    const z = i * stepS;
                    const a = projectXZ(minM, z, viewProj, w, h);
                    const b = projectXZ(maxM, z, viewProj, w, h);
                    if (!a.visible || !b.visible) continue;
                    const isPrimary = Math.abs((z / stepP) - Math.round(z / stepP)) < 1e-6;
                    (isPrimary ? dPrimary : dSecondary).push(
                        `M${a.x.toFixed(1)} ${a.y.toFixed(1)}L${b.x.toFixed(1)} ${b.y.toFixed(1)}`,
                    );
                }

                const primary = grp.querySelector<SVGPathElement>("[data-grid='primary']");
                const secondary = grp.querySelector<SVGPathElement>("[data-grid='secondary']");
                if (primary) primary.setAttribute("d", dPrimary.join(""));
                if (secondary) secondary.setAttribute("d", dSecondary.join(""));
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
            style={{ zIndex: 5 }}
        >
            <g ref={groupRef}>
                {/* 455mm secondary — drawn first so 910mm sits on top */}
                <path data-grid="secondary" stroke="rgba(99,102,241,0.18)" strokeWidth={0.5} fill="none" />
                <path data-grid="primary" stroke="rgba(79,70,229,0.45)" strokeWidth={0.8} fill="none" />
            </g>
        </svg>
    );
}
