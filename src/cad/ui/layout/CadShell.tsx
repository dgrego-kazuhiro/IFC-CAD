"use client";

import React, { useRef } from "react";
import Viewport, { ViewportHandle } from "./Viewport";
import TreePanel from "../tree/TreePanel";
import RoomEditPanel from "../room/RoomEditPanel";
import RoomSketchOverlay from "../room/RoomSketchOverlay";
import RoomPropertyPanel from "../room/RoomPropertyPanel";
import WallEditPanel from "../wall/WallEditPanel";
import GridPropertyPanel from "../grid/GridPropertyPanel";
import { useAppState, AppState } from "../../application/AppState";
import { SpaceElement } from "../../model/elements/SpaceElement";
import { RemoveConstraintCommand } from "../../commands/create/AddConstraintCommand";
import { CreateSpaceCommand } from "../../commands/create/CreateSpaceCommand";
import { pickNewRoomName } from "../room/roomNaming";
import { saveScene, loadScene, clearScene, hasSavedScene } from "../../application/Persistence";

export default function CadShell() {
    const activeTool = useAppState((state: AppState) => state.activeTool);
    const setActiveTool = useAppState((state: AppState) => state.setActiveTool);
    const elements = useAppState((state: AppState) => state.elements);
    const activeLevelId = useAppState((state: AppState) => state.activeLevelId);
    const activeRoomId = useAppState((state: AppState) => state.activeRoomId);
    const setActiveRoom = useAppState((state: AppState) => state.setActiveRoom);
    const selectedGridIds = useAppState((state: AppState) => state.selectedGridIds);
    const selection = useAppState((state: AppState) => state.selection);
    const removeElement = useAppState((state: AppState) => state.removeElement);
    const setSelection = useAppState((state: AppState) => state.setSelection);
    const selectedConstraintId = useAppState((state: AppState) => state.selectedConstraintId);
    const setSelectedConstraintId = useAppState((state: AppState) => state.setSelectedConstraintId);
    const executeCommand = useAppState((state: AppState) => state.executeCommand);

    const viewportRef = useRef<ViewportHandle>(null);

    React.useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            // Skip when user is typing in an input / editable field
            const t = e.target as HTMLElement | null;
            if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) {
                return;
            }

            if (e.key === "Escape") {
                if (selectedConstraintId) {
                    setSelectedConstraintId(null);
                } else if (activeRoomId) {
                    setActiveRoom(null);
                } else {
                    setActiveTool("select");
                }
                return;
            }

            if (e.key === "Delete" || e.key === "Backspace") {
                // Constraint takes priority when one is selected
                if (selectedConstraintId) {
                    executeCommand(new RemoveConstraintCommand(selectedConstraintId));
                    e.preventDefault();
                    return;
                }
                // Delete selected Space (room) elements — also clean up their walls
                const { elements } = useAppState.getState();
                const toDelete = selection.filter((id) => {
                    const el = elements[id];
                    return el && el.type === "Space";
                });
                if (toDelete.length > 0) {
                    for (const id of toDelete) {
                        const room = elements[id] as SpaceElement;
                        // Remove walls linked to polygons
                        const wallIds = new Set<string>();
                        for (const p of room.polygons ?? []) {
                            for (const wid of p.wallIds ?? []) if (wid) wallIds.add(wid);
                        }
                        for (const wid of wallIds) removeElement(wid);
                        if (activeRoomId === id) setActiveRoom(null);
                        removeElement(id);
                    }
                    setSelection([]);
                    e.preventDefault();
                    return;
                }
            }
        };
        window.addEventListener("keydown", handleKeyDown);
        return () => window.removeEventListener("keydown", handleKeyDown);
    }, [
        setActiveTool, activeRoomId, setActiveRoom, selection, removeElement,
        setSelection, selectedConstraintId, setSelectedConstraintId, executeCommand,
    ]);

    const handleAddRoom = () => {
        if (!activeLevelId) return;
        const cmd = new CreateSpaceCommand(pickNewRoomName(elements), 3.0, undefined, activeLevelId);
        executeCommand(cmd);
        const newRoomId = cmd.getElementId();
        setActiveRoom(newRoomId);
        setSelection([newRoomId]);
    };

    return (
        <div className="w-full h-full flex flex-col bg-zinc-900 text-zinc-100 font-sans">
            <div className="h-12 border-b border-zinc-800 flex items-center gap-4 px-4 shrink-0">
                <h1 className="font-semibold text-sm">IFC-CAD Prototype</h1>
                <div className="flex gap-2 text-sm">
                    <button
                        className="px-3 py-1 rounded border bg-zinc-800 border-transparent hover:bg-zinc-700"
                        onClick={() => saveScene()}
                        title="現在のシーンを localStorage に保存"
                    >Save</button>
                    <button
                        className="px-3 py-1 rounded border bg-zinc-800 border-transparent hover:bg-zinc-700"
                        onClick={() => {
                            if (!hasSavedScene()) return;
                            loadScene();
                        }}
                        title="localStorage から読み込み"
                    >Load</button>
                    <button
                        className="px-3 py-1 rounded border bg-zinc-800 border-transparent hover:bg-zinc-700 text-rose-300"
                        onClick={() => {
                            if (confirm("シーンと保存データをクリアしますか？")) clearScene();
                        }}
                        title="保存データを削除し、シーンも初期化"
                    >Clear</button>
                </div>
                <div className="ml-auto flex gap-2 text-sm">
                    <button
                        className={`px-3 py-1 rounded border ${activeTool === "select" ? "bg-zinc-700 border-zinc-500" : "bg-zinc-800 border-transparent hover:bg-zinc-700"}`}
                        onClick={() => setActiveTool("select")}
                    >Select</button>
                    <button
                        className={`px-3 py-1 rounded border ${activeTool === "wall" ? "bg-zinc-700 border-zinc-500" : !activeLevelId ? "bg-zinc-800 border-transparent text-zinc-600 cursor-not-allowed" : "bg-zinc-800 border-transparent hover:bg-zinc-700"}`}
                        onClick={() => {
                            if (!activeLevelId) return;
                            activeTool === "wall" ? setActiveTool("select") : setActiveTool("wall");
                        }}
                        title={!activeLevelId ? "Select a level first (double-click or right-click a level in the tree)" : "Wall tool"}
                    >Wall</button>
                    <button
                        className={`px-3 py-1 rounded border ${activeTool === "column" ? "bg-zinc-700 border-zinc-500" : !activeLevelId ? "bg-zinc-800 border-transparent text-zinc-600 cursor-not-allowed" : "bg-zinc-800 border-transparent hover:bg-zinc-700"}`}
                        onClick={() => {
                            if (!activeLevelId) return;
                            setActiveTool(activeTool === "column" ? "select" : "column");
                        }}
                        title={!activeLevelId ? "Select a level first" : "柱作成ツール (点配置)"}
                    >Column</button>
                    <button
                        className={`px-3 py-1 rounded border ${activeTool === "beam" ? "bg-zinc-700 border-zinc-500" : !activeLevelId ? "bg-zinc-800 border-transparent text-zinc-600 cursor-not-allowed" : "bg-zinc-800 border-transparent hover:bg-zinc-700"}`}
                        onClick={() => {
                            if (!activeLevelId) return;
                            setActiveTool(activeTool === "beam" ? "select" : "beam");
                        }}
                        title={!activeLevelId ? "Select a level first" : "梁作成ツール (2点指定)"}
                    >Beam</button>
                    <button
                        className={`px-3 py-1 rounded border ${!!activeRoomId ? "bg-zinc-700 border-zinc-500" : !activeLevelId ? "bg-zinc-800 border-transparent text-zinc-600 cursor-not-allowed" : "bg-zinc-800 border-transparent hover:bg-zinc-700"}`}
                        onClick={() => {
                            if (!activeLevelId) return;
                            if (activeRoomId) setActiveRoom(null);
                            else handleAddRoom();
                        }}
                        title={!activeLevelId ? "Select a level first" : "部屋作成ツール (新規 Space を作成して編集モードへ)"}
                    >Room</button>
                    <button
                        className={`px-3 py-1 rounded border ${activeTool === "slab" ? "bg-zinc-700 border-zinc-500" : !activeLevelId ? "bg-zinc-800 border-transparent text-zinc-600 cursor-not-allowed" : "bg-zinc-800 border-transparent hover:bg-zinc-700"}`}
                        onClick={() => {
                            if (!activeLevelId) return;
                            setActiveTool(activeTool === "slab" ? "select" : "slab");
                        }}
                        title={!activeLevelId ? "Select a level first" : "床作成ツール (Spaceをクリックで床生成)"}
                    >Slab</button>
                    <button
                        className={`px-3 py-1 rounded border ${activeTool === "gridline" ? "bg-zinc-700 border-zinc-500" : "bg-zinc-800 border-transparent hover:bg-zinc-700"}`}
                        onClick={() => setActiveTool(activeTool === "gridline" ? "select" : "gridline")}
                        title="通芯 (グリッドライン) ツール"
                    >Grid</button>
                    <button
                        className={`px-3 py-1 rounded border ${activeTool === "door" ? "bg-zinc-700 border-zinc-500" : "bg-zinc-800 border-transparent hover:bg-zinc-700"}`}
                        onClick={() => setActiveTool(activeTool === "door" ? "select" : "door")}
                        title="ドア配置ツール (壁にホバーしてクリックで配置)"
                    >Door</button>
                    <button
                        className={`px-3 py-1 rounded border ${activeTool === "window" ? "bg-zinc-700 border-zinc-500" : "bg-zinc-800 border-transparent hover:bg-zinc-700"}`}
                        onClick={() => setActiveTool(activeTool === "window" ? "select" : "window")}
                        title="窓配置ツール (壁にホバーしてクリックで配置)"
                    >Window</button>
                </div>
            </div>
            <div className="flex-1 flex min-h-0">
                <div className="w-64 border-r border-zinc-800 shrink-0 overflow-y-auto">
                    <TreePanel />
                </div>
                <div className="flex-1 relative min-w-0">
                    <Viewport ref={viewportRef} />
                    <RoomSketchOverlay viewportRef={viewportRef} />
                    <RoomEditPanel />
                    <WallEditPanel />
                </div>
                <div className="w-72 border-l border-zinc-800 p-4 shrink-0 overflow-y-auto">
                    <h2 className="text-xs text-zinc-400 font-bold uppercase mb-2">Properties</h2>
                    {selectedGridIds.length > 0 ? (
                        <GridPropertyPanel />
                    ) : (() => {
                        // Show RoomPropertyPanel for either the actively-edited
                        // room OR a singly-selected Space. This way the user
                        // sees properties as soon as they pick a room, without
                        // having to enter Room edit mode first.
                        const targetId = activeRoomId
                            ?? selection.find((id) => elements[id]?.type === "Space")
                            ?? null;
                        return targetId && elements[targetId]
                            ? <RoomPropertyPanel activeRoomId={targetId} />
                            : <div className="text-sm">No selection</div>;
                    })()}
                </div>
            </div>
            <div className="h-8 border-t border-zinc-800 flex items-center px-4 text-xs text-zinc-500 shrink-0">
                <span>Ready</span>
            </div>
        </div>
    );
}
