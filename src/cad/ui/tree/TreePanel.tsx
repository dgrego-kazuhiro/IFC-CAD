"use client";

import React, { useMemo } from "react";
import { useAppState, AppState } from "../../application/AppState";
import { buildTree, useTreeStore } from "../../state/tree/TreeStore";
import TreeNodeComponent from "./TreeNodeComponent";

export default function TreePanel() {
    const elements = useAppState((s: AppState) => s.elements);
    const levels = useAppState((s: AppState) => s.levels);
    const activeLevelId = useAppState((s: AppState) => s.activeLevelId);
    const setSelection = useAppState((s: AppState) => s.setSelection);
    const addLevel = useAppState((s: AppState) => s.addLevel);
    const removeLevel = useAppState((s: AppState) => s.removeLevel);
    const setActiveLevel = useAppState((s: AppState) => s.setActiveLevel);
    const setActiveRoom = useAppState((s: AppState) => s.setActiveRoom);
    const setPendingRoomLevel = useAppState((s: AppState) => s.setPendingRoomLevel);
    const grids = useAppState((s: AppState) => s.grids);
    const setSelectedGridIds = useAppState((s: AppState) => s.setSelectedGridIds);

    const tree = useMemo(
        () => buildTree(levels, elements, activeLevelId, grids),
        [levels, elements, activeLevelId, grids],
    );

    const handleSelectElement = (elementId: string) => {
        setSelection([elementId]);
        setSelectedGridIds([]);
        // If selecting a Space element, enter room edit mode
        const el = elements[elementId];
        if (el && el.type === "Space") {
            setActiveRoom(elementId);
        }
    };

    const handleSelectGrid = (gridId: string) => {
        setSelectedGridIds([gridId]);
        setSelection([]);
    };

    const handleLevelAction = (action: string, levelId: string) => {
        if (action === "activate") {
            setActiveLevel(activeLevelId === levelId ? null : levelId);
        } else if (action === "delete") {
            removeLevel(levelId);
        }
    };

    const handleAddRoom = (levelId: string) => {
        // 部屋モードに入るが、実体の Space は最初の図形 (Rectangle / Polyline /
        // Circle) を確定するまで作らない。空の "Room1" がツリーに先に出る挙動を
        // 防ぐための pending 状態。実体生成は RoomSketchOverlay の commit 時。
        setActiveLevel(levelId);
        setActiveRoom(null);
        setPendingRoomLevel(levelId);
        setSelection([]);
    };

    const handleAddLevel = () => {
        // 既存レベルの最大標高 + 3000mm を新レベルの標高にする (= 直下階の
        // 上に階高 3m で積み上げ)。既存レベルが無ければ 0m から開始。
        const maxElevation = levels.length > 0
            ? Math.max(...levels.map((l) => l.elevation))
            : -3.0;
        const newElevation = maxElevation + 3.0;
        const name = `Level ${levels.length + 1}`;
        addLevel(name, newElevation);
    };

    return (
        <div className="flex flex-col h-full">
            <div className="flex items-center justify-between px-2 pt-2 pb-1 shrink-0">
                <h2 className="text-xs text-zinc-400 font-bold uppercase">Project Tree</h2>
            </div>

            {activeLevelId && (
                <div className="mx-2 mb-1 px-2 py-1 bg-blue-600/20 border border-blue-500/30 rounded text-xs text-blue-300">
                    Active: {levels.find((l) => l.id === activeLevelId)?.name ?? "—"}
                </div>
            )}

            <div className="flex-1 overflow-y-auto px-1 pb-2">
                <TreeNodeComponent
                    node={tree}
                    depth={0}
                    onSelectElement={handleSelectElement}
                    onSelectGrid={handleSelectGrid}
                    onLevelAction={handleLevelAction}
                    onAddRoom={handleAddRoom}
                    onAddLevel={handleAddLevel}
                    activeLevelId={activeLevelId}
                />
            </div>
        </div>
    );
}
