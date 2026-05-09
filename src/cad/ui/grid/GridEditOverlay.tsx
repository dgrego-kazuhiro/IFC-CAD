"use client";

import React, { useEffect, useRef, useState } from "react";
import { mat4, vec4 } from "gl-matrix";
import { useAppState, AppState } from "../../application/AppState";
import { Camera } from "../../renderer/camera/Camera";
import { Vec3 } from "../../geometry/math/Vec3";
import { gridVertices } from "../../model/grid/GridLine";

interface Props {
    getCamera: () => Camera | null;
    getCanvas: () => HTMLCanvasElement | null;
}

interface Projected { x: number; y: number; visible: boolean; }

function project(world: Vec3, camera: Camera, width: number, height: number): Projected {
    const viewProj = mat4.create();
    mat4.multiply(viewProj, camera.projectionMatrix, camera.viewMatrix);
    const v = vec4.fromValues(world[0], world[1], world[2], 1);
    vec4.transformMat4(v, v, viewProj);
    if (v[3] === 0) return { x: 0, y: 0, visible: false };
    const x = (v[0] / v[3] + 1) * 0.5 * width;
    const y = (1 - (v[1] / v[3] + 1) * 0.5) * height;
    return { x, y, visible: v[3] > 0 };
}

function screenToGround(
    clientX: number, clientY: number,
    canvas: HTMLCanvasElement,
    camera: Camera,
): Vec3 | null {
    const rect = canvas.getBoundingClientRect();
    const nx = ((clientX - rect.left) / rect.width) * 2 - 1;
    const ny = -(((clientY - rect.top) / rect.height) * 2 - 1);
    const inv = mat4.create();
    const vp = mat4.create();
    mat4.multiply(vp, camera.projectionMatrix, camera.viewMatrix);
    mat4.invert(inv, vp);
    const near = vec4.fromValues(nx, ny, 0, 1);
    const far = vec4.fromValues(nx, ny, 1, 1);
    vec4.transformMat4(near, near, inv);
    vec4.transformMat4(far, far, inv);
    vec4.scale(near, near, 1 / near[3]);
    vec4.scale(far, far, 1 / far[3]);
    const dy = far[1] - near[1];
    if (Math.abs(dy) < 1e-6) return null;
    const t = -near[1] / dy;
    const out: Vec3 = [
        near[0] + (far[0] - near[0]) * t,
        0,
        near[2] + (far[2] - near[2]) * t,
    ];
    return out;
}

interface DragState {
    gridId: string;
    vertexIndex: number;
    originalPosition: Vec3;
    moved: boolean;
}

export default function GridEditOverlay({ getCamera, getCanvas }: Props) {
    const grids = useAppState((s: AppState) => s.grids);
    const selectedGridIds = useAppState((s: AppState) => s.selectedGridIds);
    const activeRoomId = useAppState((s: AppState) => s.activeRoomId);
    const activeTool = useAppState((s: AppState) => s.activeTool);
    const gridlineDrafting = useAppState((s: AppState) => s.gridlineDrafting);
    const moveGridVertex = useAppState((s: AppState) => s.moveGridVertex);
    const removeGridVertex = useAppState((s: AppState) => s.removeGridVertex);

    const [dragState, setDragState] = useState<DragState | null>(null);
    const [, setTick] = useState(0);

    // 通芯モード (= 編集サブモード = gridlineDrafting OFF) では選択無しでも
    // **全 grid** にハンドルを出して、クリックして即ドラッグ可能にする。
    // select モード時は選択された grid のみ (従来挙動)。
    const inGridlineEditMode = activeTool === "gridline" && !gridlineDrafting;
    const enabled = activeRoomId === null
        && (
            (inGridlineEditMode && grids.length > 0)
            || (selectedGridIds.length > 0 && (activeTool === "select" || activeTool === "gridline"))
        );

    // Follow the camera every frame
    useEffect(() => {
        if (!enabled) return;
        let raf = 0;
        const loop = () => { setTick(t => (t + 1) % 1000000); raf = requestAnimationFrame(loop); };
        raf = requestAnimationFrame(loop);
        return () => cancelAnimationFrame(raf);
    }, [enabled]);

    // Drag handlers — bind at the window level so releases outside the SVG land.
    useEffect(() => {
        if (!dragState) return;
        const onMove = (e: PointerEvent) => {
            const cam = getCamera();
            const canvas = getCanvas();
            if (!cam || !canvas) return;
            const pt = screenToGround(e.clientX, e.clientY, canvas, cam);
            if (!pt) return;
            if (!dragState.moved) setDragState({ ...dragState, moved: true });
            moveGridVertex(dragState.gridId, dragState.vertexIndex, pt);
        };
        const onUp = () => setDragState(null);
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
        (window as any).__viewportInteracting = true;
        return () => {
            window.removeEventListener("pointermove", onMove);
            window.removeEventListener("pointerup", onUp);
            (window as any).__viewportInteracting = false;
        };
    }, [dragState, getCamera, getCanvas, moveGridVertex]);

    if (!enabled) return null;

    const cam = getCamera();
    const canvas = getCanvas();
    if (!cam || !canvas) return null;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;

    return (
        <svg
            className="absolute inset-0 w-full h-full"
            style={{ zIndex: 16, pointerEvents: "none" }}
        >
            {grids.map((g) => {
                if (!g.visible) return null;
                // 通芯編集モードでは全 grid にハンドルを出す。
                // select モード時は選択中の grid のみ。
                const showHandles = inGridlineEditMode || selectedGridIds.includes(g.id);
                if (!showHandles) return null;
                const verts = gridVertices(g.curve);
                if (verts.length < 2) return null;

                return (
                    <g key={g.id}>
                        {/* Vertex handles (drag to move, right-click to delete) */}
                        {verts.map((v, i) => {
                            const p = project(v, cam, w, h);
                            if (!p.visible) return null;
                            const isDragging = dragState?.gridId === g.id && dragState.vertexIndex === i;
                            const r = isDragging ? 9 : 7;
                            const canDelete = verts.length > 2;
                            return (
                                <g
                                    key={`v-${i}`}
                                    transform={`translate(${p.x.toFixed(1)},${p.y.toFixed(1)})`}
                                    style={{ pointerEvents: "auto", cursor: "grab" }}
                                    onPointerDown={(e) => {
                                        if (e.button !== 0) return;
                                        e.stopPropagation();
                                        e.preventDefault();
                                        (e.target as Element).setPointerCapture?.(e.pointerId);
                                        setDragState({
                                            gridId: g.id,
                                            vertexIndex: i,
                                            originalPosition: v,
                                            moved: false,
                                        });
                                    }}
                                    onContextMenu={(e) => {
                                        e.preventDefault();
                                        e.stopPropagation();
                                        if (canDelete) removeGridVertex(g.id, i);
                                    }}
                                >
                                    <circle r={r} fill="#f97316" stroke="#1f2937" strokeWidth={1.5} />
                                    <title>
                                        {canDelete
                                            ? "ドラッグで移動 / 右クリックで削除"
                                            : "ドラッグで移動 (最少 2 頂点のため削除不可)"}
                                    </title>
                                </g>
                            );
                        })}
                    </g>
                );
            })}
        </svg>
    );
}
