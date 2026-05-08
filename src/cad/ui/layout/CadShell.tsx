"use client";

import React, { useRef } from "react";
import Viewport, { ViewportHandle } from "./Viewport";
import TreePanel from "../tree/TreePanel";
import RoomEditPanel from "../room/RoomEditPanel";
import RoomSketchOverlay from "../room/RoomSketchOverlay";
import RoomPropertyPanel from "../room/RoomPropertyPanel";
import WallEditPanel from "../wall/WallEditPanel";
import GridPropertyPanel from "../grid/GridPropertyPanel";
import SlabPropertyPanel from "../slab/SlabPropertyPanel";
import ConstraintPanel from "../constraint/ConstraintPanel";
import ElementTypePanel from "../catalog/ElementTypePanel";
import EdgeWallTypePanel from "../catalog/EdgeWallTypePanel";
import { useAppState, AppState } from "../../application/AppState";
import { SpaceElement } from "../../model/elements/SpaceElement";
import { RemoveConstraintCommand } from "../../commands/create/AddConstraintCommand";
import { saveScene, loadScene, clearScene, hasSavedScene } from "../../application/Persistence";
import { downloadIfc } from "../../io/ifc/IfcExporter";
import { triggerWallRegenIfEnabled } from "../room/wallRegenerate";

export default function CadShell() {
    const activeTool = useAppState((state: AppState) => state.activeTool);
    const setActiveTool = useAppState((state: AppState) => state.setActiveTool);
    const elements = useAppState((state: AppState) => state.elements);
    const activeLevelId = useAppState((state: AppState) => state.activeLevelId);
    const activeRoomId = useAppState((state: AppState) => state.activeRoomId);
    const pendingRoomLevelId = useAppState((state: AppState) => state.pendingRoomLevelId);
    const setActiveRoom = useAppState((state: AppState) => state.setActiveRoom);
    const setPendingRoomLevel = useAppState((state: AppState) => state.setPendingRoomLevel);
    const selectedGridIds = useAppState((state: AppState) => state.selectedGridIds);
    const selection = useAppState((state: AppState) => state.selection);
    const sketchSelection = useAppState((state: AppState) => state.sketchSelection);
    const removeElement = useAppState((state: AppState) => state.removeElement);
    const setSelection = useAppState((state: AppState) => state.setSelection);
    const selectedConstraintId = useAppState((state: AppState) => state.selectedConstraintId);
    const setSelectedConstraintId = useAppState((state: AppState) => state.setSelectedConstraintId);
    const executeCommand = useAppState((state: AppState) => state.executeCommand);
    const undo = useAppState((state: AppState) => state.undo);
    const redo = useAppState((state: AppState) => state.redo);

    const viewportRef = useRef<ViewportHandle>(null);

    React.useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            // Skip when user is typing in an input / editable field
            const t = e.target as HTMLElement | null;
            if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) {
                return;
            }

            // Undo / Redo (Ctrl+Z / Cmd+Z, Ctrl+Shift+Z / Cmd+Shift+Z, Ctrl+Y)
            const mod = e.ctrlKey || e.metaKey;
            if (mod && !e.altKey) {
                if (e.key === "z" || e.key === "Z") {
                    e.preventDefault();
                    if (e.shiftKey) redo();
                    else undo();
                    return;
                }
                if (e.key === "y" || e.key === "Y") {
                    e.preventDefault();
                    redo();
                    return;
                }
            }

            if (e.key === "Escape") {
                if (selectedConstraintId) {
                    setSelectedConstraintId(null);
                } else if (activeRoomId) {
                    setActiveRoom(null);
                } else if (pendingRoomLevelId) {
                    // 図形を一つも描かずに部屋モードを抜けるケース。
                    // pending 状態を解除するだけでよい。
                    setPendingRoomLevel(null);
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
                const { elements } = useAppState.getState();
                // Delete selected Space (room) elements — also clean up their walls
                const spacesToDelete = selection.filter((id) => {
                    const el = elements[id];
                    return el && el.type === "Space";
                });
                if (spacesToDelete.length > 0) {
                    for (const id of spacesToDelete) {
                        const room = elements[id] as SpaceElement;
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
                // Delete other element kinds (Column / Beam / Wall / Slab / Door / Window)。
                // 柱・梁・壁の削除は壁の最終フットプリントに影響するので realtime
                // 壁再生成をトリガする。
                const otherToDelete = selection.filter((id) => {
                    const el = elements[id];
                    if (!el) return false;
                    return el.type === "Column" || el.type === "Beam"
                        || el.type === "Wall" || el.type === "Slab"
                        || el.type === "Door" || el.type === "Window";
                });
                if (otherToDelete.length > 0) {
                    let anyAffectsWalls = false;
                    for (const id of otherToDelete) {
                        const el = elements[id];
                        if (el && (el.type === "Column" || el.type === "Wall")) {
                            anyAffectsWalls = true;
                        }
                        removeElement(id);
                    }
                    setSelection([]);
                    if (anyAffectsWalls) {
                        triggerWallRegenIfEnabled("delete-element");
                    }
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
        pendingRoomLevelId, setPendingRoomLevel, undo, redo,
    ]);

    const handleAddRoom = () => {
        if (!activeLevelId) return;
        // 部屋モードに入るが、Space 実体は最初の図形確定まで作らない。
        // ツリーに空 Room1 が先行表示される問題を防ぐ。
        setActiveRoom(null);
        setPendingRoomLevel(activeLevelId);
        setSelection([]);
    };

    // 部屋モード判定 (実体ある Room を編集中、または最初の図形を待っている pending)。
    const inRoomMode = !!activeRoomId || !!pendingRoomLevelId;

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
                    <button
                        className="px-3 py-1 rounded border bg-zinc-800 border-transparent hover:bg-zinc-700 text-emerald-300"
                        onClick={() => {
                            try {
                                downloadIfc(useAppState.getState());
                            } catch (e) {
                                console.error("[IFC export] failed:", e);
                                alert("IFC エクスポートに失敗しました。コンソールを確認してください。");
                            }
                        }}
                        title="現在のシーンを IFC2X3 ファイル (.ifc) として書き出し"
                    >Export IFC</button>
                </div>
                <div className="ml-auto flex gap-2 text-sm">
                    <button
                        className={`px-3 py-1 rounded border ${activeTool === "select" ? "bg-zinc-700 border-zinc-500" : "bg-zinc-800 border-transparent hover:bg-zinc-700"}`}
                        onClick={() => setActiveTool("select")}
                    >Select</button>
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
                        className={`px-3 py-1 rounded border ${inRoomMode ? "bg-zinc-700 border-zinc-500" : !activeLevelId ? "bg-zinc-800 border-transparent text-zinc-600 cursor-not-allowed" : "bg-zinc-800 border-transparent hover:bg-zinc-700"}`}
                        onClick={() => {
                            if (!activeLevelId) return;
                            if (activeRoomId) {
                                setActiveRoom(null);
                            } else if (pendingRoomLevelId) {
                                setPendingRoomLevel(null);
                            } else {
                                handleAddRoom();
                            }
                        }}
                        title={!activeLevelId ? "Select a level first" : "部屋作成ツール (図形を描いた時点で新規 Space を生成)"}
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
                    {/* Type 切替パネル — 単独選択された Wall/Column/Beam/Slab に対して
                        Type 変更ドロップダウンを出す。形状は Type+overrides から再投影。 */}
                    <ElementTypePanel />
                    {/* 部屋モードでエッジを 1 本選んだ時の per-edge 壁 Type 変更。
                        sketchSelection 経由で edge → wall element をルックアップして
                        ChangeElementTypeCommand を流す。 */}
                    <EdgeWallTypePanel />
                    {selectedGridIds.length > 0 ? (
                        <GridPropertyPanel />
                    ) : (() => {
                        // Slab を 1 つだけ選択している時は SlabPropertyPanel。
                        const slabId = selection.length === 1
                            && elements[selection[0]]?.type === "Slab"
                            ? selection[0] : null;
                        if (slabId) {
                            return <SlabPropertyPanel key={slabId} slabId={slabId as any} />;
                        }
                        // Show RoomPropertyPanel for either the actively-edited
                        // room OR a singly-selected Space. This way the user
                        // sees properties as soon as they pick a room, without
                        // having to enter Room edit mode first.
                        const targetId = activeRoomId
                            ?? selection.find((id) => elements[id]?.type === "Space")
                            ?? null;
                        if (targetId && elements[targetId]) {
                            // key forces a fresh component instance per room so
                            // the draft useState reseeds from the new room and
                            // the user never sees stale name/usage values.
                            return <RoomPropertyPanel key={targetId} activeRoomId={targetId} />;
                        }
                        // 部屋選択も無いが sketchSelection (= 柱中心 / 通芯端点 /
                        // 原点 / 壁端点 等) が積まれている時は ConstraintPanel
                        // を出して 2 点距離拘束等を行えるようにする。
                        if (sketchSelection.length > 0) {
                            return <ConstraintPanel />;
                        }
                        return <div className="text-sm">No selection</div>;
                    })()}
                </div>
            </div>
            <div className="h-8 border-t border-zinc-800 flex items-center px-4 text-xs text-zinc-500 shrink-0">
                <span>Ready</span>
            </div>
        </div>
    );
}
