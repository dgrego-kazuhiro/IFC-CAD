import { create } from 'zustand';
import { mat4 } from 'gl-matrix';
import { BaseElement } from '../model/base/BaseElement';
import { ElementId } from '../model/base/ElementId';
import { Command } from '../commands/base/Command';
import { generateId } from '../utils/ids';
import { Vec3 } from '../geometry/math/Vec3';
import {
    GridLine,
    GridNamingState,
    DEFAULT_GRID_NAMING,
    pickNextGridName,
    gridVertices,
    curveFromVertices,
} from '../model/grid/GridLine';
import { Constraint } from '../model/constraint/Constraint';

// スケッチ内の頂点 / 辺の選択。ConstraintPanel が参照する。
//   - edge / point / circle : 部屋ポリゴンに紐づく sketch 要素
//   - wallAxis : 壁モードで単独作成した壁の中心線。WallElement.axis を一本の
//     作図線として扱い、Horizontal / Vertical / Parallel / Length 等の拘束の
//     ターゲットにする。
//   - wallPoint : 壁軸の端点。Coincident / PerpDistance / PointOnGrid など点
//     ターゲット拘束の対象になる。endIdx=0 は axis[0]、1 は axis[1]。
export type SketchSelectionItem =
    | { kind: "edge"; spaceId: ElementId; polyId: string; edgeIdx: number }
    | { kind: "point"; spaceId: ElementId; polyId: string; vertexIdx: number }
    | { kind: "circle"; spaceId: ElementId; polyId: string }
    | { kind: "wallAxis"; wallId: ElementId }
    | { kind: "wallPoint"; wallId: ElementId; endIdx: 0 | 1 };

export function sketchSelectionKey(s: SketchSelectionItem): string {
    if (s.kind === "edge") return `e:${s.spaceId}:${s.polyId}:${s.edgeIdx}`;
    if (s.kind === "point") return `p:${s.spaceId}:${s.polyId}:${s.vertexIdx}`;
    if (s.kind === "circle") return `c:${s.spaceId}:${s.polyId}`;
    if (s.kind === "wallAxis") return `w:${s.wallId}`;
    return `wp:${s.wallId}:${s.endIdx}`;
}

/** 拘束ソルバへのドラッグヒント。SketchSolver がこの頂点を fixed として push する。 */
export interface SolverDragHint {
    spaceId: ElementId;
    polyId: string;
    vertexIdx: number;
    x: number;
    y: number;
}

export interface LevelData {
    id: ElementId;
    name: string;
    elevation: number;
}

export type RoomEditMode = "select" | "rectangle" | "polyline" | "circle";

/** Wall-tool sub-mode: "add" draws new walls, "select" picks sketch lines. */
export type WallSubMode = "add" | "select";

/** Top-level design mode (per docs/specification/new.md §8). */
export type DesignMode = "freeZoning" | "jpResidentialGrid";

/** Primary / secondary residential grid spacing, in metres. */
export const RESIDENTIAL_GRID_PRIMARY_M = 0.910;
export const RESIDENTIAL_GRID_SECONDARY_M = 0.455;

export interface AppState {
    elements: Record<ElementId, BaseElement>;
    selection: ElementId[];
    activeTool: string;
    levels: LevelData[];
    activeLevelId: ElementId | null;

    // Room editing
    activeRoomId: ElementId | null;
    roomEditMode: RoomEditMode;

    // Wall tool sub-mode (add / select)
    wallSubMode: WallSubMode;

    /**
     * Top-level design mode (per docs/specification/new.md §8).
     *  - freeZoning:        no background grid, room blocks edited freely.
     *  - jpResidentialGrid: 910mm primary + 455mm secondary grid is rendered
     *                       and mouse / vertex motion snaps to it.
     */
    designMode: DesignMode;

    // 通芯 (Grid) — building-level reference elements (per spec §4)
    grids: GridLine[];
    gridNaming: GridNamingState;
    gridlineDrafting: boolean;
    /** ライン (2点) / ポリライン (3点以上) 作成モード切替 */
    gridDraftMode: "line" | "polyline";
    selectedGridIds: string[];

    // 2D 幾何拘束 (docs/specification/2d_constraint_system_spec.md)
    constraints: Record<string, Constraint>;
    sketchSelection: SketchSelectionItem[];
    selectedConstraintId: string | null;
    /**
     * 拘束ソルバへのドラッグヒント。指定された頂点を fixed として push し、
     * その位置を中心に他の頂点が動くようにする (SolidWorks 風挙動)。
     * pointerMove で更新し、pointerUp で null クリアする。
     */
    solverDragHint: SolverDragHint | null;

    // Actions
    addElement: (element: BaseElement) => void;
    updateElement: (id: ElementId, partial: Partial<BaseElement>) => void;
    removeElement: (id: ElementId) => void;
    setSelection: (ids: ElementId[]) => void;
    setActiveTool: (tool: string) => void;

    // Room editing actions
    setActiveRoom: (id: ElementId | null) => void;
    setRoomEditMode: (mode: RoomEditMode) => void;

    // Wall tool sub-mode action
    setWallSubMode: (mode: WallSubMode) => void;

    // Design mode action
    setDesignMode: (mode: DesignMode) => void;

    // 通芯 actions
    addGrid: (start: Vec3, end: Vec3, kind?: "Primary" | "Auxiliary") => string;
    /** 3点以上のポリラインとして通芯を作成 (2点の場合は Line と同等)。 */
    addGridPolyline: (points: Vec3[], kind?: "Primary" | "Auxiliary") => string | null;
    updateGrid: (id: string, partial: Partial<GridLine>) => void;
    renameGrid: (id: string, name: string) => { ok: boolean; warning?: string };
    removeGrid: (id: string) => void;
    removeGrids: (ids: string[]) => void;
    clearGrids: () => void;
    // Polyline vertex edits: move / insert / delete. Line auto-converts to
    // Polyline when it gains a 3rd vertex; Polyline collapses back to Line
    // at exactly 2 vertices.
    moveGridVertex: (id: string, index: number, position: Vec3) => void;
    insertGridVertex: (id: string, afterIndex: number, position: Vec3) => void;
    removeGridVertex: (id: string, index: number) => void;
    setGridlineDrafting: (drafting: boolean) => void;
    setGridDraftMode: (mode: "line" | "polyline") => void;

    // 拘束アクション
    addConstraint: (c: Constraint) => void;
    removeConstraint: (id: string) => void;
    updateConstraint: (id: string, partial: Partial<Constraint>) => void;
    setSketchSelection: (items: SketchSelectionItem[]) => void;
    toggleSketchSelection: (item: SketchSelectionItem, additive: boolean) => void;
    clearSketchSelection: () => void;
    setSelectedConstraintId: (id: string | null) => void;
    setSolverDragHint: (hint: SolverDragHint | null) => void;
    setSelectedGridIds: (ids: string[]) => void;
    // §6.2 連続作成: clone the most recent grid offset perpendicular to its direction
    offsetLastGrid: (distance: number, kind?: "Primary" | "Auxiliary") => void;
    // §6.3 配列作成: create N grids from a base offset by pitch in a direction
    createGridArray: (
        start: Vec3,
        end: Vec3,
        pitch: number,
        count: number,
        kind?: "Primary" | "Auxiliary",
    ) => void;

    // Level actions
    addLevel: (name: string, elevation: number) => void;
    removeLevel: (id: ElementId) => void;
    setActiveLevel: (id: ElementId | null) => void;

    // Commands
    executeCommand: (command: Command) => void;
}

export const useAppState = create<AppState>((set, get) => ({
    elements: {},
    selection: [],
    activeTool: "select",
    levels: [
        { id: "level-default-1", name: "Level 1", elevation: 0 },
    ],
    activeLevelId: null,
    activeRoomId: null,
    roomEditMode: "select",
    wallSubMode: "add",
    designMode: "freeZoning",
    grids: [],
    gridNaming: DEFAULT_GRID_NAMING,
    gridlineDrafting: false,
    gridDraftMode: "line",
    selectedGridIds: [],
    constraints: {},
    sketchSelection: [],
    selectedConstraintId: null,
    solverDragHint: null,

    addElement: (element) => set((state) => ({
        elements: { ...state.elements, [element.id]: element }
    })),
    updateElement: (id, partial) => {
        set((state) => {
            const el = state.elements[id];
            if (!el) return state;
            return {
                elements: {
                    ...state.elements,
                    [id]: { ...el, ...partial }
                }
            };
        });
        // Realtime constraint resolution: if a Space's rectangles changed
        // (user drag / edit), kick off the async sketch solver. It self-
        // serializes and writes back to rect.start/end via updateElement again,
        // but reentrance is guarded so this won't loop.
        const partialAny = partial as any;
        if (partialAny.polygons !== undefined) {
            // Lazy require to avoid a top-level cycle between AppState and
            // the solver module (solver imports useAppState).
            const mod = require('../constraint/SketchSolver') as typeof import('../constraint/SketchSolver');
            mod.runSketchSolver();
        }
    },
    removeElement: (id) => set((state) => {
        const { [id]: removed, ...rest } = state.elements;
        return { elements: rest };
    }),
    setSelection: (ids) => set({ selection: ids }),
    setActiveTool: (tool) => set({ activeTool: tool }),
    setActiveRoom: (id) => set({ activeRoomId: id, roomEditMode: "select" }),
    setRoomEditMode: (mode) => set({ roomEditMode: mode }),
    setWallSubMode: (mode) => set((state) => ({
        wallSubMode: mode,
        // Switching sub-modes clears any in-flight sketch selection so the
        // user starts fresh when they toggle.
        sketchSelection: mode === state.wallSubMode ? state.sketchSelection : [],
    })),

    setDesignMode: (mode) => set({ designMode: mode }),

    addGrid: (start, end, kind = "Primary") => {
        const id = generateId();
        set((state) => {
            const { name, nextNaming } = pickNextGridName(state.gridNaming, start, end);
            const grid: GridLine = {
                id,
                name,
                curve: { type: "Line", start, end },
                kind,
                visible: true,
                locked: false,
                bubbleStart: true,
                bubbleEnd: true,
            };
            return { grids: [...state.grids, grid], gridNaming: nextNaming };
        });
        return id;
    },
    addGridPolyline: (points, kind = "Primary") => {
        if (points.length < 2) return null;
        const curve = curveFromVertices(points);
        if (!curve) return null;
        const id = generateId();
        set((state) => {
            // Naming series uses the first/last chord direction for axis detection
            const first = points[0];
            const last = points[points.length - 1];
            const { name, nextNaming } = pickNextGridName(state.gridNaming, first, last);
            const grid: GridLine = {
                id,
                name,
                curve,
                kind,
                visible: true,
                locked: false,
                bubbleStart: true,
                bubbleEnd: true,
            };
            return { grids: [...state.grids, grid], gridNaming: nextNaming };
        });
        return id;
    },
    updateGrid: (id, partial) => set((state) => ({
        grids: state.grids.map((g) => (g.id === id ? { ...g, ...partial } : g)),
    })),
    renameGrid: (id, name) => {
        const trimmed = name.trim();
        if (!trimmed) return { ok: false, warning: "名前を空にできません" };
        const state = get();
        const dup = state.grids.some((g) => g.id !== id && g.name === trimmed);
        set({
            grids: state.grids.map((g) => (g.id === id ? { ...g, name: trimmed } : g)),
        });
        // §7.4 — duplicate names allowed but warned
        return dup ? { ok: true, warning: `通芯名 "${trimmed}" は既に使用されています` } : { ok: true };
    },
    removeGrid: (id) => set((state) => ({
        grids: state.grids.filter((g) => g.id !== id),
        selectedGridIds: state.selectedGridIds.filter((sid) => sid !== id),
    })),
    removeGrids: (ids) => set((state) => {
        const idSet = new Set(ids);
        return {
            grids: state.grids.filter((g) => !idSet.has(g.id)),
            selectedGridIds: state.selectedGridIds.filter((sid) => !idSet.has(sid)),
        };
    }),
    clearGrids: () => set({ grids: [], selectedGridIds: [], gridNaming: DEFAULT_GRID_NAMING }),
    moveGridVertex: (id, index, position) => set((state) => ({
        grids: state.grids.map((g) => {
            if (g.id !== id) return g;
            const v = gridVertices(g.curve);
            if (index < 0 || index >= v.length) return g;
            const next = v.slice();
            next[index] = position;
            const curve = curveFromVertices(next);
            return curve ? { ...g, curve } : g;
        }),
    })),
    insertGridVertex: (id, afterIndex, position) => set((state) => ({
        grids: state.grids.map((g) => {
            if (g.id !== id) return g;
            const v = gridVertices(g.curve);
            if (afterIndex < 0 || afterIndex >= v.length - 1) return g;
            const next = [...v.slice(0, afterIndex + 1), position, ...v.slice(afterIndex + 1)];
            const curve = curveFromVertices(next);
            return curve ? { ...g, curve } : g;
        }),
    })),
    removeGridVertex: (id, index) => set((state) => ({
        grids: state.grids.map((g) => {
            if (g.id !== id) return g;
            const v = gridVertices(g.curve);
            if (v.length <= 2) return g; // would leave < 2 vertices
            if (index < 0 || index >= v.length) return g;
            const next = v.slice(0, index).concat(v.slice(index + 1));
            const curve = curveFromVertices(next);
            return curve ? { ...g, curve } : g;
        }),
    })),
    setGridlineDrafting: (drafting) => set({ gridlineDrafting: drafting }),
    setGridDraftMode: (mode) => set({ gridDraftMode: mode }),

    addConstraint: (c) => {
        set((state) => ({ constraints: { ...state.constraints, [c.id]: c } }));
        const mod = require('../constraint/SketchSolver') as typeof import('../constraint/SketchSolver');
        mod.runSketchSolver();
    },
    removeConstraint: (id) => {
        set((state) => {
            const { [id]: _removed, ...rest } = state.constraints;
            return {
                constraints: rest,
                selectedConstraintId: state.selectedConstraintId === id ? null : state.selectedConstraintId,
            };
        });
        const mod = require('../constraint/SketchSolver') as typeof import('../constraint/SketchSolver');
        mod.runSketchSolver();
    },
    updateConstraint: (id, partial) => {
        set((state) => {
            const cur = state.constraints[id];
            if (!cur) return state;
            return { constraints: { ...state.constraints, [id]: { ...cur, ...partial } } };
        });
        const mod = require('../constraint/SketchSolver') as typeof import('../constraint/SketchSolver');
        mod.runSketchSolver();
    },
    setSelectedGridIds: (ids) => set({ selectedGridIds: ids }),

    setSketchSelection: (items) => set({ sketchSelection: items }),
    toggleSketchSelection: (item, additive) => set((state) => {
        const key = sketchSelectionKey(item);
        const existing = state.sketchSelection.find((s) => sketchSelectionKey(s) === key);
        if (additive) {
            if (existing) return { sketchSelection: state.sketchSelection.filter((s) => sketchSelectionKey(s) !== key) };
            return { sketchSelection: [...state.sketchSelection, item] };
        }
        if (existing && state.sketchSelection.length === 1) return { sketchSelection: [] };
        return { sketchSelection: [item] };
    }),
    clearSketchSelection: () => set({ sketchSelection: [] }),
    setSelectedConstraintId: (id) => set({ selectedConstraintId: id }),
    setSolverDragHint: (hint) => {
        set({ solverDragHint: hint });
        // When the drag hint is cleared (pointer release), re-run the solver
        // without the pin so constraints like PointOnCircle / Tangent can
        // finally be enforced (during drag the pinned vertex would conflict).
        if (hint === null) {
            const mod = require('../constraint/SketchSolver') as typeof import('../constraint/SketchSolver');
            mod.runSketchSolver();
        }
    },
    offsetLastGrid: (distance, kind = "Primary") => {
        const state = get();
        // Find the most recently added grid (last in array)
        const last = state.grids[state.grids.length - 1];
        if (!last || last.curve.type !== "Line") return;
        const { start, end } = last.curve;
        const dx = end[0] - start[0];
        const dz = end[2] - start[2];
        const len = Math.hypot(dx, dz);
        if (len < 1e-6) return;
        // Perpendicular unit vector in XZ plane
        const nx = -dz / len;
        const nz = dx / len;
        const newStart: Vec3 = [start[0] + nx * distance, start[1], start[2] + nz * distance];
        const newEnd: Vec3 = [end[0] + nx * distance, end[1], end[2] + nz * distance];
        // Use addGrid via store action (sets new naming)
        get().addGrid(newStart, newEnd, kind);
    },
    createGridArray: (start, end, pitch, count, kind = "Primary") => {
        if (count < 1) return;
        const dx = end[0] - start[0];
        const dz = end[2] - start[2];
        const len = Math.hypot(dx, dz);
        if (len < 1e-6) return;
        const nx = -dz / len;
        const nz = dx / len;
        for (let i = 0; i < count; i++) {
            const offset = i * pitch;
            const s: Vec3 = [start[0] + nx * offset, start[1], start[2] + nz * offset];
            const e: Vec3 = [end[0] + nx * offset, end[1], end[2] + nz * offset];
            get().addGrid(s, e, kind);
        }
    },

    addLevel: (name, elevation) => set((state) => ({
        levels: [...state.levels, { id: generateId(), name, elevation }]
            .sort((a, b) => a.elevation - b.elevation),
    })),
    removeLevel: (id) => set((state) => {
        if (state.levels.length <= 1) return state; // keep at least 1
        const next = state.levels.filter((l) => l.id !== id);
        return {
            levels: next,
            activeLevelId: state.activeLevelId === id ? null : state.activeLevelId,
        };
    }),
    setActiveLevel: (id) => set({ activeLevelId: id }),

    executeCommand: (command) => {
        const result = command.execute();
        if (result.success) {
            // Add to history (to evaluate in the future)
        } else {
            console.warn("Command failed:", result.message);
        }
    }
}));
