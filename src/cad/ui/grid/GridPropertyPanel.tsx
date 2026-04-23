"use client";

import React, { useState, useEffect } from "react";
import { useAppState, AppState } from "../../application/AppState";
import { gridSegments } from "../../model/grid/GridLine";

export default function GridPropertyPanel() {
    const grids = useAppState((s: AppState) => s.grids);
    const selectedGridIds = useAppState((s: AppState) => s.selectedGridIds);
    const renameGrid = useAppState((s: AppState) => s.renameGrid);
    const updateGrid = useAppState((s: AppState) => s.updateGrid);
    const removeGrid = useAppState((s: AppState) => s.removeGrid);
    const setSelectedGridIds = useAppState((s: AppState) => s.setSelectedGridIds);

    const removeGrids = useAppState((s: AppState) => s.removeGrids);
    const clearGrids = useAppState((s: AppState) => s.clearGrids);
    const grid = grids.find((g) => g.id === selectedGridIds[0]);

    const [nameInput, setNameInput] = useState("");
    const [warning, setWarning] = useState<string | null>(null);

    useEffect(() => {
        setNameInput(grid?.name ?? "");
        setWarning(null);
    }, [grid?.id, grid?.name]);

    if (!grid) return null;

    if (selectedGridIds.length > 1) {
        return (
            <div className="space-y-3 text-xs">
                <div className="text-zinc-300 font-medium">通芯: {selectedGridIds.length} 本選択中</div>
                <div className="text-zinc-500 text-[10px]">
                    {grids
                        .filter((g) => selectedGridIds.includes(g.id))
                        .map((g) => g.name)
                        .join(", ")}
                </div>
                <button
                    className="w-full px-2 py-1 bg-red-700/60 hover:bg-red-600/60 rounded text-zinc-100"
                    onClick={() => {
                        removeGrids(selectedGridIds);
                        setSelectedGridIds([]);
                    }}
                >
                    選択した通芯を削除
                </button>
                <button
                    className="w-full px-2 py-1 bg-zinc-700 hover:bg-zinc-600 rounded text-zinc-300"
                    onClick={() => setSelectedGridIds([])}
                >
                    選択解除
                </button>
            </div>
        );
    }

    const length = gridSegments(grid.curve).reduce(
        (sum, s) => sum + Math.hypot(s.b[0] - s.a[0], s.b[2] - s.a[2]),
        0,
    );

    const commitName = () => {
        const r = renameGrid(grid.id, nameInput);
        setWarning(r.warning ?? null);
    };

    return (
        <div className="space-y-3 text-xs">
            <div className="text-zinc-300 font-medium">通芯: {grid.name}</div>
            <div className="text-zinc-500">Type: GridLine ({grid.kind})</div>

            <div>
                <label className="block text-zinc-400 mb-1">名前</label>
                <input
                    className="w-full bg-zinc-900 border border-zinc-600 rounded px-2 py-1 text-zinc-100 outline-none focus:border-blue-500"
                    value={nameInput}
                    onChange={(e) => setNameInput(e.target.value)}
                    onBlur={commitName}
                    onKeyDown={(e) => {
                        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                    }}
                />
                {warning && (
                    <div className="text-amber-400 text-[10px] mt-1">⚠ {warning}</div>
                )}
            </div>

            <div>
                <label className="block text-zinc-400 mb-1">系列</label>
                <div className="flex gap-1">
                    <button
                        className={`flex-1 px-2 py-1 rounded border ${grid.kind === "Primary" ? "bg-red-600/40 border-red-500 text-zinc-100" : "bg-zinc-800 border-zinc-700 text-zinc-400 hover:bg-zinc-700"}`}
                        onClick={() => updateGrid(grid.id, { kind: "Primary" })}
                    >
                        Primary
                    </button>
                    <button
                        className={`flex-1 px-2 py-1 rounded border ${grid.kind === "Auxiliary" ? "bg-orange-600/40 border-orange-500 text-zinc-100" : "bg-zinc-800 border-zinc-700 text-zinc-400 hover:bg-zinc-700"}`}
                        onClick={() => updateGrid(grid.id, { kind: "Auxiliary" })}
                    >
                        Auxiliary
                    </button>
                </div>
            </div>

            <div className="flex items-center justify-between">
                <span className="text-zinc-400">表示</span>
                <button
                    className={`px-2 py-0.5 rounded text-[10px] ${grid.visible ? "bg-zinc-700 text-zinc-200" : "bg-zinc-800 text-zinc-500"}`}
                    onClick={() => updateGrid(grid.id, { visible: !grid.visible })}
                >
                    {grid.visible ? "ON" : "OFF"}
                </button>
            </div>

            <div className="flex items-center justify-between">
                <span className="text-zinc-400">ロック</span>
                <button
                    className={`px-2 py-0.5 rounded text-[10px] ${grid.locked ? "bg-amber-600/40 text-amber-200" : "bg-zinc-800 text-zinc-500"}`}
                    onClick={() => updateGrid(grid.id, { locked: !grid.locked })}
                >
                    {grid.locked ? "LOCKED" : "UNLOCKED"}
                </button>
            </div>

            <div className="flex items-center justify-between">
                <span className="text-zinc-400">Bubble Start</span>
                <button
                    className={`px-2 py-0.5 rounded text-[10px] ${grid.bubbleStart !== false ? "bg-zinc-700 text-zinc-200" : "bg-zinc-800 text-zinc-500"}`}
                    onClick={() => updateGrid(grid.id, { bubbleStart: grid.bubbleStart === false })}
                >
                    {grid.bubbleStart !== false ? "ON" : "OFF"}
                </button>
            </div>

            <div className="flex items-center justify-between">
                <span className="text-zinc-400">Bubble End</span>
                <button
                    className={`px-2 py-0.5 rounded text-[10px] ${grid.bubbleEnd !== false ? "bg-zinc-700 text-zinc-200" : "bg-zinc-800 text-zinc-500"}`}
                    onClick={() => updateGrid(grid.id, { bubbleEnd: grid.bubbleEnd === false })}
                >
                    {grid.bubbleEnd !== false ? "ON" : "OFF"}
                </button>
            </div>

            <div className="text-zinc-500">長さ: {length.toFixed(2)} m</div>

            <button
                className="w-full mt-2 px-2 py-1 bg-red-700/60 hover:bg-red-600/60 rounded text-zinc-100"
                onClick={() => {
                    removeGrid(grid.id);
                    setSelectedGridIds([]);
                }}
            >
                通芯を削除
            </button>
            <button
                className="w-full px-2 py-1 bg-zinc-800 border border-red-800/50 hover:bg-red-900/40 rounded text-rose-300"
                onClick={() => {
                    if (confirm(`全 ${grids.length} 本の通芯を削除しますか？`)) clearGrids();
                }}
            >
                全 Grid を削除
            </button>
        </div>
    );
}
