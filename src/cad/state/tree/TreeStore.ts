import { create } from "zustand";
import { BaseElement } from "../../model/base/BaseElement";
import { ElementId } from "../../model/base/ElementId";
import { LevelData } from "../../application/AppState";
import { WallElement } from "../../model/elements/WallElement";
import { ColumnElement } from "../../model/elements/ColumnElement";
import { SpaceElement } from "../../model/elements/SpaceElement";
import { GridLine } from "../../model/grid/GridLine";

// --- Node types ---

export type TreeNodeType =
    | "Project"
    | "Site"
    | "Building"
    | "Level"
    | "Category"
    | "Element"
    | "Grid"
    | "GridLine"
    | "Reference"
    | "Space";

export interface TreeNode {
    id: string;
    type: TreeNodeType;
    name: string;
    children: TreeNode[];
    parentId?: string;
    visible: boolean;
    locked: boolean;
    selectable: boolean;
    elementId?: ElementId;
    levelId?: ElementId;
    gridId?: string;
}

// --- Category mapping ---

const ELEMENT_CATEGORIES: Record<string, string> = {
    Wall: "Walls",
    Column: "Columns",
    Beam: "Beams",
    Slab: "Slabs",
    Door: "Doors",
    Window: "Windows",
    Space: "Spaces",
};

const CATEGORY_ORDER = ["Walls", "Columns", "Beams", "Slabs", "Doors", "Windows", "Spaces"];

// --- Tree state ---

export interface TreeState {
    selectedIds: string[];
    expandedIds: Set<string>;
    hiddenIds: Set<string>;

    setSelectedIds: (ids: string[]) => void;
    toggleSelected: (id: string, multi: boolean) => void;
    toggleExpanded: (id: string) => void;
    toggleVisible: (nodeId: string) => void;
    expandAll: () => void;
    collapseAll: () => void;
}

export const useTreeStore = create<TreeState>((set) => ({
    selectedIds: [],
    expandedIds: new Set(["project", "site", "building", "levels"]),
    hiddenIds: new Set(),

    setSelectedIds: (ids) => set({ selectedIds: ids }),

    toggleSelected: (id, multi) =>
        set((state) => {
            if (multi) {
                const next = state.selectedIds.includes(id)
                    ? state.selectedIds.filter((s) => s !== id)
                    : [...state.selectedIds, id];
                return { selectedIds: next };
            }
            return { selectedIds: [id] };
        }),

    toggleExpanded: (id) =>
        set((state) => {
            const next = new Set(state.expandedIds);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return { expandedIds: next };
        }),

    toggleVisible: (nodeId) =>
        set((state) => {
            const next = new Set(state.hiddenIds);
            if (next.has(nodeId)) next.delete(nodeId);
            else next.add(nodeId);
            return { hiddenIds: next };
        }),

    expandAll: () =>
        set({ expandedIds: new Set(["project", "site", "building", "levels", "grids", "reference"]) }),

    collapseAll: () =>
        set({ expandedIds: new Set() }),
}));

// --- Resolve level id for an element ---

function getLevelId(el: BaseElement): ElementId | undefined {
    if (el.type === "Wall") return (el as WallElement).baseLevelId;
    if (el.type === "Column") return (el as ColumnElement).baseLevelId;
    if (el.type === "Space") return (el as SpaceElement).levelId;
    return undefined;
}

// --- Build tree from levels + elements ---

export function buildTree(
    levels: LevelData[],
    elements: Record<ElementId, BaseElement>,
    activeLevelId: ElementId | null,
    grids: GridLine[] = [],
): TreeNode {
    // Group elements by levelId → category
    const byLevel: Record<string, Record<string, BaseElement[]>> = {};
    for (const lvl of levels) {
        byLevel[lvl.id] = {};
    }

    for (const el of Object.values(elements)) {
        if (el.type === "Level") continue;
        const cat = ELEMENT_CATEGORIES[el.type];
        if (!cat) continue;

        const lvlId = getLevelId(el);
        // Assign to matching level, or first level as fallback
        const targetLvl = lvlId && byLevel[lvlId] ? lvlId : levels[0]?.id;
        if (!targetLvl) continue;
        if (!byLevel[targetLvl]) byLevel[targetLvl] = {};
        if (!byLevel[targetLvl][cat]) byLevel[targetLvl][cat] = [];
        byLevel[targetLvl][cat].push(el);
    }

    // Build level nodes (sorted by elevation)
    const sortedLevels = [...levels].sort((a, b) => a.elevation - b.elevation);

    const levelNodes: TreeNode[] = sortedLevels.map((lvl) => {
        const cats = byLevel[lvl.id] || {};
        const categoryNodes: TreeNode[] = CATEGORY_ORDER
            .filter((cat) => cats[cat] && cats[cat].length > 0)
            .map((cat) => ({
                id: `cat-${lvl.id}-${cat.toLowerCase()}`,
                type: "Category" as TreeNodeType,
                name: cat,
                visible: true,
                locked: false,
                selectable: false,
                children: cats[cat].map((el) => ({
                    id: `el-${el.id}`,
                    type: "Element" as TreeNodeType,
                    name: el.name || `${el.type}-${el.id.slice(0, 6)}`,
                    visible: el.visible,
                    locked: el.locked,
                    selectable: true,
                    elementId: el.id,
                    children: [],
                })),
            }));

        const isActive = lvl.id === activeLevelId;
        return {
            id: `level-${lvl.id}`,
            type: "Level" as TreeNodeType,
            name: `${lvl.name} (${(lvl.elevation * 1000).toFixed(0)}mm)${isActive ? " *" : ""}`,
            visible: true,
            locked: false,
            selectable: true,
            levelId: lvl.id,
            children: categoryNodes,
        };
    });

    // Levels container
    const levelsNode: TreeNode = {
        id: "levels",
        type: "Category",
        name: "Levels",
        visible: true,
        locked: false,
        selectable: false,
        children: levelNodes,
    };

    // Grids (Building-level reference per spec §4 / §11)
    const sortedGrids = [...grids].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    const primaryGrids = sortedGrids.filter((g) => g.kind === "Primary");
    const auxGrids = sortedGrids.filter((g) => g.kind === "Auxiliary");
    const gridChildren: TreeNode[] = primaryGrids.map((g) => ({
        id: `grid-${g.id}`,
        type: "GridLine" as TreeNodeType,
        name: g.name,
        visible: g.visible,
        locked: g.locked,
        selectable: true,
        gridId: g.id,
        children: [],
    }));
    if (auxGrids.length > 0) {
        gridChildren.push({
            id: "grids-aux",
            type: "Category",
            name: "Auxiliary",
            visible: true,
            locked: false,
            selectable: false,
            children: auxGrids.map((g) => ({
                id: `grid-${g.id}`,
                type: "GridLine" as TreeNodeType,
                name: g.name,
                visible: g.visible,
                locked: g.locked,
                selectable: true,
                gridId: g.id,
                children: [],
            })),
        });
    }
    const gridsNode: TreeNode = {
        id: "grids",
        type: "Grid",
        name: `Grids${grids.length > 0 ? ` (${grids.length})` : ""}`,
        visible: true,
        locked: false,
        selectable: false,
        children: gridChildren,
    };

    // Reference (empty for now)
    const referenceNode: TreeNode = {
        id: "reference",
        type: "Reference",
        name: "Reference",
        visible: true,
        locked: false,
        selectable: false,
        children: [],
    };

    return {
        id: "project",
        type: "Project",
        name: "Project",
        visible: true,
        locked: false,
        selectable: false,
        children: [
            {
                id: "site",
                type: "Site",
                name: "Site",
                visible: true,
                locked: false,
                selectable: false,
                children: [
                    {
                        id: "building",
                        type: "Building",
                        name: "Building",
                        visible: true,
                        locked: false,
                        selectable: false,
                        children: [levelsNode, gridsNode, referenceNode],
                    },
                ],
            },
        ],
    };
}
