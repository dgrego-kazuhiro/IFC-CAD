"use client";

import React from "react";
import { MousePointer2, Plus, X } from "lucide-react";
import { useAppState, AppState } from "../../application/AppState";

/**
 * Floating toolbar shown while the wall tool is active. Lets the user toggle
 * between "追加" (wall drawing) and "選択" (sketch-line picking for
 * constraints), plus a "終了" button to exit wall mode. Rendered from
 * CadShell alongside the other per-mode panels.
 */
export default function WallEditPanel() {
    const activeTool = useAppState((s: AppState) => s.activeTool);
    const wallSubMode = useAppState((s: AppState) => s.wallSubMode);
    const setWallSubMode = useAppState((s: AppState) => s.setWallSubMode);
    const setActiveTool = useAppState((s: AppState) => s.setActiveTool);

    if (activeTool !== "wall") return null;

    const btnClass = (active: boolean) =>
        `px-3 py-2 rounded text-xs font-medium flex items-center gap-1.5 transition-colors ${
            active
                ? "bg-blue-600 text-white shadow-md"
                : "bg-zinc-700 text-zinc-200 hover:bg-zinc-600"
        }`;

    return (
        <div className="absolute bottom-6 left-1/2 -translate-x-1/2 z-30 flex items-center gap-2 bg-zinc-800/95 backdrop-blur border border-zinc-600 rounded-lg px-3 py-2 shadow-xl">
            <span className="text-[10px] text-zinc-400 uppercase font-bold mr-1">Wall</span>
            <button
                className={btnClass(wallSubMode === "add")}
                onClick={() => setWallSubMode("add")}
                title="壁を追加(2点クリックで作成)"
            >
                <Plus size={14} />
                追加
            </button>
            <button
                className={btnClass(wallSubMode === "select")}
                onClick={() => setWallSubMode("select")}
                title="作図線を選択(部屋のポリゴンエッジ/頂点をクリックで拘束対象に)"
            >
                <MousePointer2 size={14} />
                選択
            </button>
            <div className="w-px h-6 bg-zinc-600 mx-1" />
            <button
                className="px-3 py-2 rounded text-xs font-medium flex items-center gap-1.5 bg-zinc-700 text-zinc-200 hover:bg-rose-600 hover:text-white transition-colors"
                onClick={() => setActiveTool("select")}
                title="壁モードを終了 (Esc でも可)"
            >
                <X size={14} />
                終了
            </button>
        </div>
    );
}
