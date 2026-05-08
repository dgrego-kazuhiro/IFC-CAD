"use client";

import React, { useState } from "react";
import {
    ChevronRight,
    ChevronDown,
    Eye,
    EyeOff,
    Building2,
    MapPin,
    Layers,
    Grid3X3,
    Box,
    Landmark,
    Compass,
    DoorOpen,
    Square,
    Columns3,
    Crosshair,
    Trash2,
    Home,
} from "lucide-react";
import { TreeNode, TreeNodeType, useTreeStore } from "../../state/tree/TreeStore";
import { ElementId } from "../../model/base/ElementId";

const NODE_ICONS: Record<TreeNodeType, React.FC<{ size?: number; className?: string }>> = {
    Project: Landmark,
    Site: MapPin,
    Building: Building2,
    Level: Layers,
    Category: Box,
    Element: Square,
    Grid: Grid3X3,
    GridLine: Grid3X3,
    Reference: Compass,
    Space: DoorOpen,
};

const CATEGORY_ICONS: Record<string, React.FC<{ size?: number; className?: string }>> = {
    Walls: Square,
    Columns: Columns3,
    Slabs: Layers,
    Doors: DoorOpen,
    Windows: Square,
    Spaces: DoorOpen,
};

interface TreeNodeProps {
    node: TreeNode;
    depth: number;
    onSelectElement?: (elementId: string) => void;
    onSelectGrid?: (gridId: string) => void;
    onLevelAction?: (action: string, levelId: string) => void;
    onAddRoom?: (levelId: string) => void;
    /** "Levels" コンテナノード (id="levels") の右クリックで階追加。 */
    onAddLevel?: () => void;
    activeLevelId?: ElementId | null;
}

export default function TreeNodeComponent({
    node,
    depth,
    onSelectElement,
    onSelectGrid,
    onLevelAction,
    onAddRoom,
    onAddLevel,
    activeLevelId,
}: TreeNodeProps) {
    const { selectedIds, expandedIds, hiddenIds, toggleSelected, toggleExpanded, toggleVisible } =
        useTreeStore();

    const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);

    const isExpanded = expandedIds.has(node.id);
    const isSelected = selectedIds.includes(node.id);
    const isHidden = hiddenIds.has(node.id);
    const hasChildren = node.children.length > 0;
    const isActiveLevel = node.type === "Level" && node.levelId === activeLevelId;

    const IconComponent =
        node.type === "Category"
            ? CATEGORY_ICONS[node.name] || Box
            : NODE_ICONS[node.type] || Box;

    const handleClick = (e: React.MouseEvent) => {
        e.stopPropagation();
        toggleSelected(node.id, e.ctrlKey || e.metaKey);
        if (node.elementId && onSelectElement) {
            onSelectElement(node.elementId);
        }
        if (node.gridId && onSelectGrid) {
            onSelectGrid(node.gridId);
        }
    };

    const handleDoubleClick = (e: React.MouseEvent) => {
        e.stopPropagation();
        if (node.type === "Level" && node.levelId && onLevelAction) {
            onLevelAction("activate", node.levelId);
        }
    };

    const handleExpandToggle = (e: React.MouseEvent) => {
        e.stopPropagation();
        toggleExpanded(node.id);
    };

    const handleVisibilityToggle = (e: React.MouseEvent) => {
        e.stopPropagation();
        toggleVisible(node.id);
    };

    const handleContextMenu = (e: React.MouseEvent) => {
        // Level ノード or "Levels" コンテナで context menu を出す。
        if ((node.type === "Level" && node.levelId)
            || (node.type === "Category" && node.id === "levels")) {
            e.preventDefault();
            e.stopPropagation();
            setContextMenu({ x: e.clientX, y: e.clientY });
        }
    };

    const closeContextMenu = () => setContextMenu(null);

    return (
        <div>
            <div
                className={`
                    flex items-center h-7 cursor-pointer select-none group
                    hover:bg-zinc-700/50 rounded-sm
                    ${isSelected ? "bg-blue-600/30 hover:bg-blue-600/40" : ""}
                    ${isActiveLevel ? "ring-1 ring-blue-500/50" : ""}
                    ${isHidden ? "opacity-40" : ""}
                `}
                style={{ paddingLeft: `${depth * 16 + 4}px` }}
                onClick={handleClick}
                onDoubleClick={handleDoubleClick}
                onContextMenu={handleContextMenu}
            >
                {/* Expand/collapse */}
                <span
                    className="w-4 h-4 flex items-center justify-center shrink-0"
                    onClick={handleExpandToggle}
                >
                    {hasChildren ? (
                        isExpanded ? (
                            <ChevronDown size={14} className="text-zinc-400" />
                        ) : (
                            <ChevronRight size={14} className="text-zinc-400" />
                        )
                    ) : null}
                </span>

                {/* Icon */}
                <IconComponent
                    size={14}
                    className={`shrink-0 ml-0.5 mr-1.5 ${isActiveLevel ? "text-blue-400" : "text-zinc-400"}`}
                />

                {/* Name */}
                <span className={`text-xs truncate flex-1 ${isActiveLevel ? "text-blue-300 font-semibold" : ""}`}>
                    {node.name}
                </span>

                {/* Visibility toggle */}
                {node.type === "Element" || node.type === "Category" || node.type === "Level" || node.type === "GridLine" ? (
                    <button
                        className="w-5 h-5 flex items-center justify-center opacity-0 group-hover:opacity-100 shrink-0"
                        onClick={handleVisibilityToggle}
                        title={isHidden ? "Show" : "Hide"}
                    >
                        {isHidden ? (
                            <EyeOff size={12} className="text-zinc-500" />
                        ) : (
                            <Eye size={12} className="text-zinc-400" />
                        )}
                    </button>
                ) : (
                    <span className="w-5 shrink-0" />
                )}
            </div>

            {/* Level context menu */}
            {contextMenu && node.levelId && (
                <>
                    <div className="fixed inset-0 z-40" onClick={closeContextMenu} />
                    <div
                        className="fixed z-50 bg-zinc-800 border border-zinc-600 rounded shadow-lg py-1 min-w-[140px]"
                        style={{ left: contextMenu.x, top: contextMenu.y }}
                    >
                        <button
                            className="w-full text-left px-3 py-1.5 text-xs hover:bg-zinc-700 flex items-center gap-2"
                            onClick={() => {
                                onLevelAction?.("activate", node.levelId!);
                                closeContextMenu();
                            }}
                        >
                            <Crosshair size={12} />
                            {isActiveLevel ? "Deactivate" : "Set Active"}
                        </button>
                        <button
                            className="w-full text-left px-3 py-1.5 text-xs hover:bg-zinc-700 flex items-center gap-2"
                            onClick={() => {
                                onAddRoom?.(node.levelId!);
                                closeContextMenu();
                            }}
                        >
                            <Home size={12} />
                            Add Room
                        </button>
                        <div className="border-t border-zinc-700 my-0.5" />
                        <button
                            className="w-full text-left px-3 py-1.5 text-xs hover:bg-zinc-700 flex items-center gap-2 text-red-400"
                            onClick={() => {
                                onLevelAction?.("delete", node.levelId!);
                                closeContextMenu();
                            }}
                        >
                            <Trash2 size={12} />
                            Delete
                        </button>
                    </div>
                </>
            )}

            {/* Levels container context menu */}
            {contextMenu && node.type === "Category" && node.id === "levels" && (
                <>
                    <div className="fixed inset-0 z-40" onClick={closeContextMenu} />
                    <div
                        className="fixed z-50 bg-zinc-800 border border-zinc-600 rounded shadow-lg py-1 min-w-[140px]"
                        style={{ left: contextMenu.x, top: contextMenu.y }}
                    >
                        <button
                            className="w-full text-left px-3 py-1.5 text-xs hover:bg-zinc-700 flex items-center gap-2"
                            onClick={() => {
                                onAddLevel?.();
                                closeContextMenu();
                            }}
                        >
                            <Layers size={12} />
                            Add Level
                        </button>
                    </div>
                </>
            )}

            {/* Children */}
            {hasChildren && isExpanded && (
                <div>
                    {node.children.map((child) => (
                        <TreeNodeComponent
                            key={child.id}
                            node={child}
                            depth={depth + 1}
                            onSelectElement={onSelectElement}
                            onSelectGrid={onSelectGrid}
                            onLevelAction={onLevelAction}
                            onAddRoom={onAddRoom}
                            onAddLevel={onAddLevel}
                            activeLevelId={activeLevelId}
                        />
                    ))}
                </div>
            )}
        </div>
    );
}
