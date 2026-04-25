"use client";

import React, { useMemo, useState } from "react";
import { Plus } from "lucide-react";
import { useAppState, AppState } from "../../application/AppState";
import { buildTree, useTreeStore } from "../../state/tree/TreeStore";
import TreeNodeComponent from "./TreeNodeComponent";
import { CreateSpaceCommand } from "../../commands/create/CreateSpaceCommand";
import { pickNewRoomName } from "../room/roomNaming";

export default function TreePanel() {
    const elements = useAppState((s: AppState) => s.elements);
    const levels = useAppState((s: AppState) => s.levels);
    const activeLevelId = useAppState((s: AppState) => s.activeLevelId);
    const setSelection = useAppState((s: AppState) => s.setSelection);
    const addLevel = useAppState((s: AppState) => s.addLevel);
    const removeLevel = useAppState((s: AppState) => s.removeLevel);
    const setActiveLevel = useAppState((s: AppState) => s.setActiveLevel);
    const executeCommand = useAppState((s: AppState) => s.executeCommand);
    const setActiveRoom = useAppState((s: AppState) => s.setActiveRoom);
    const grids = useAppState((s: AppState) => s.grids);
    const setSelectedGridIds = useAppState((s: AppState) => s.setSelectedGridIds);

    const [showAddLevel, setShowAddLevel] = useState(false);
    const [newLevelName, setNewLevelName] = useState("");
    const [newLevelElevation, setNewLevelElevation] = useState("");

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
        const liveElements = useAppState.getState().elements;
        const cmd = new CreateSpaceCommand(
            pickNewRoomName(liveElements),
            3.0,
            undefined,
            levelId,
        );
        executeCommand(cmd);
        const newRoomId = cmd.getElementId();
        setActiveLevel(levelId);
        setActiveRoom(newRoomId);
        setSelection([newRoomId]);
    };

    const handleAddLevel = () => {
        const name = newLevelName.trim() || `Level ${levels.length + 1}`;
        // User enters the elevation in millimeters (per placeholder) but the
        // rest of the scene uses meters for Y — convert here so higher-level
        // code can stay unit-consistent with walls, beams, slabs, etc.
        const elevationMm = parseFloat(newLevelElevation) || 0;
        addLevel(name, elevationMm / 1000);
        setNewLevelName("");
        setNewLevelElevation("");
        setShowAddLevel(false);
    };

    return (
        <div className="flex flex-col h-full">
            <div className="flex items-center justify-between px-2 pt-2 pb-1 shrink-0">
                <h2 className="text-xs text-zinc-400 font-bold uppercase">Project Tree</h2>
                <button
                    className="w-5 h-5 flex items-center justify-center rounded hover:bg-zinc-700 text-zinc-400 hover:text-zinc-200"
                    onClick={() => setShowAddLevel(!showAddLevel)}
                    title="Add Level"
                >
                    <Plus size={14} />
                </button>
            </div>

            {showAddLevel && (
                <div className="mx-2 mb-2 p-2 bg-zinc-800 rounded border border-zinc-700 space-y-1.5">
                    <input
                        className="w-full bg-zinc-900 border border-zinc-600 rounded px-2 py-1 text-xs text-zinc-100 placeholder-zinc-500 outline-none focus:border-blue-500"
                        placeholder="Level name"
                        value={newLevelName}
                        onChange={(e) => setNewLevelName(e.target.value)}
                        onKeyDown={(e) => e.key === "Enter" && handleAddLevel()}
                        autoFocus
                    />
                    <input
                        className="w-full bg-zinc-900 border border-zinc-600 rounded px-2 py-1 text-xs text-zinc-100 placeholder-zinc-500 outline-none focus:border-blue-500"
                        placeholder="Elevation (mm)"
                        type="number"
                        value={newLevelElevation}
                        onChange={(e) => setNewLevelElevation(e.target.value)}
                        onKeyDown={(e) => e.key === "Enter" && handleAddLevel()}
                    />
                    <div className="flex gap-1">
                        <button
                            className="flex-1 bg-blue-600 hover:bg-blue-500 text-white text-xs py-1 rounded"
                            onClick={handleAddLevel}
                        >
                            Add
                        </button>
                        <button
                            className="flex-1 bg-zinc-700 hover:bg-zinc-600 text-zinc-300 text-xs py-1 rounded"
                            onClick={() => setShowAddLevel(false)}
                        >
                            Cancel
                        </button>
                    </div>
                </div>
            )}

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
                    activeLevelId={activeLevelId}
                />
            </div>
        </div>
    );
}
