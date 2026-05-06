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
import type { SketchEntity, SketchEntityId } from '../model/sketch/SketchEntity';
import type { SpaceElement } from '../model/elements/SpaceElement';
import { derivePolygonsFromEntities } from '../model/sketch/PolygonDerive';

// スケッチ内の頂点 / 辺の選択。ConstraintPanel が参照する。
//   - edge / point / circle : 部屋ポリゴンに紐づく sketch 要素 (polygon 経路)
//   - entityVertex / entityEdge / entity : SketchEntity 経路 (line / arc /
//     open polyline 等、polygon 化されないエンティティ向け)
//   - wallAxis : 壁モードで単独作成した壁の中心線。
//   - wallPoint : 壁軸の端点。endIdx=0 は axis[0]、1 は axis[1]。
export type SketchSelectionItem =
    | { kind: "edge"; spaceId: ElementId; polyId: string; edgeIdx: number }
    | { kind: "point"; spaceId: ElementId; polyId: string; vertexIdx: number }
    | { kind: "circle"; spaceId: ElementId; polyId: string }
    | { kind: "entityVertex"; spaceId: ElementId; entityId: SketchEntityId; vertex:
        | { type: "endpoint"; pointIdx: number }
        | { type: "center" } }
    | { kind: "entityEdge"; spaceId: ElementId; entityId: SketchEntityId; edgeIdx?: number }
    | { kind: "entity"; spaceId: ElementId; entityId: SketchEntityId }
    | { kind: "wallAxis"; wallId: ElementId }
    | { kind: "wallPoint"; wallId: ElementId; endIdx: 0 | 1 };

export function sketchSelectionKey(s: SketchSelectionItem): string {
    if (s.kind === "edge") return `e:${s.spaceId}:${s.polyId}:${s.edgeIdx}`;
    if (s.kind === "point") return `p:${s.spaceId}:${s.polyId}:${s.vertexIdx}`;
    if (s.kind === "circle") return `c:${s.spaceId}:${s.polyId}`;
    if (s.kind === "entityVertex") {
        const v = s.vertex.type === "center"
            ? "c" : `e${s.vertex.pointIdx}`;
        return `ev:${s.spaceId}:${s.entityId}:${v}`;
    }
    if (s.kind === "entityEdge") return `ee:${s.spaceId}:${s.entityId}:${s.edgeIdx ?? 0}`;
    if (s.kind === "entity") return `en:${s.spaceId}:${s.entityId}`;
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

export type RoomEditMode =
    | "select"
    | "rectangle"
    | "polyline"
    | "circle"
    | "line"     // 単一直線 (2 点)。SketchEntity の line を生成。
    | "arc"      // 3 点指定の円弧 (start, mid, end)。SketchEntity の arc を生成。
    | "arcEdge"  // 既存エッジ → Arc 化。chord は固定、マウスで bulge を決定。
    | "trim"     // 既存エンティティ (主に circle) を 2 点で部分化 → arc 化。
    | "wallPath";

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

    /**
     * 部屋作成モードに入ったが、まだ最初の図形を描いていない状態を保持する。
     * - レベル右クリックの「Add Room」/ Room ボタンで部屋モードに入った時点で
     *   set される。Tree に空の Space を即時生成しないための仕組み。
     * - 最初の Rectangle / Polyline / Circle 確定時に CreateSpaceCommand を
     *   実行し、ここを null へ戻して activeRoomId を新しい Space にする。
     */
    pendingRoomLevelId: ElementId | null;

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

    /**
     * 部屋編集モードの壁厚 (mm)。RoomEditPanel の入力フィールドと、
     * 図形コミット直後・ドラッグ完了時のリアルタイム壁生成で共有する。
     * 文字列で持つのは入力中の "200mm" 等を直接束縛するため。
     */
    wallThicknessMm: string;
    /** 円ポリゴンの壁分割角 (deg)。同じくリアルタイム生成と共有する。 */
    circleWallAngleDeg: string;
    /**
     * 部屋編集モードでのリアルタイム壁生成を有効にするか。
     *  - true (既定): 矩形・ポリライン・円の確定直後と、ポリゴンの
     *    ドラッグ完了直後に `regenerateAllWalls` を自動実行する。
     *  - false: 「全壁生成」ボタンを押した時のみ生成する従来挙動。
     */
    realtimeWallGen: boolean;

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

    /**
     * Space の `entities` を更新し、`polygons` をエンティティから派生し直す。
     * 真実の単一情報源は entities — 編集はすべてこの API を経由するのが望ましい。
     *  - updater: 現在の entities を受け取り、新リストを返す関数 (または直リスト)。
     *  - polygons は閉ループ (closed polyline / circle) のみが派生される。
     *    壁参照 (wallIds / wallsPerEdge / edgeIds) は polyId が一致する限り保持。
     *  - polyId 安定性のため `polyIdByEntity` を維持する。
     */
    setSpaceEntities: (
        spaceId: ElementId,
        updater: SketchEntity[] | ((entities: SketchEntity[]) => SketchEntity[]),
    ) => void;

    // Room editing actions
    setActiveRoom: (id: ElementId | null) => void;
    setRoomEditMode: (mode: RoomEditMode) => void;
    setPendingRoomLevel: (levelId: ElementId | null) => void;
    setWallThicknessMm: (mm: string) => void;
    setCircleWallAngleDeg: (deg: string) => void;
    setRealtimeWallGen: (on: boolean) => void;

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
    pendingRoomLevelId: null,
    wallThicknessMm: "200",
    circleWallAngleDeg: "15",
    realtimeWallGen: true,
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

    setSpaceEntities: (spaceId, updater) => {
        set((state) => {
            const el = state.elements[spaceId] as SpaceElement | undefined;
            if (!el || el.type !== "Space") return state;
            const cur = el.entities ?? [];
            const next = typeof updater === "function" ? updater(cur) : updater;

            // チェイン検出を含む派生は PolygonDerive 側に集約。返り値の
            // polyIdByEntity は「自己閉 entity 1:1」+「同じチェイン内全 entity
            // が同じ polyId を共有」する正準的なマップ。
            const { polygons: newPolygons, polyIdByEntity: nextMap } =
                derivePolygonsFromEntities(next, {
                    polyIdByEntity: el.polyIdByEntity,
                    previous: el.polygons,
                    nextPolyId: () => generateId(),
                });

            const updated: SpaceElement = {
                ...el,
                entities: next,
                polygons: newPolygons,
                polyIdByEntity: nextMap,
                dirtyFlags: new Set([...(el.dirtyFlags ?? []), "Geometry", "Mesh", "Render"]),
            };
            return { elements: { ...state.elements, [spaceId]: updated } };
        });
        // 拘束ソルバはエンティティ変更にも反応する想定 (vertex 移動など)。
        const mod = require('../constraint/SketchSolver') as typeof import('../constraint/SketchSolver');
        mod.runSketchSolver();
    },
    setActiveRoom: (id) =>
        set({
            activeRoomId: id,
            roomEditMode: "select",
            // 実体ある Space をアクティブにした時点で「pending」状態は終わり。
            // 部屋モード解除 (id=null) でも pending を残さないようクリアする。
            pendingRoomLevelId: null,
        }),
    setRoomEditMode: (mode) => set({ roomEditMode: mode }),
    setPendingRoomLevel: (levelId) =>
        set({
            pendingRoomLevelId: levelId,
            // pending に入る時は activeRoomId を握ったままだと
            // 古い部屋に追記してしまうので、合わせてクリアする。
            ...(levelId ? { activeRoomId: null, roomEditMode: "select" } : {}),
        }),
    setWallThicknessMm: (mm) => set({ wallThicknessMm: mm }),
    setCircleWallAngleDeg: (deg) => set({ circleWallAngleDeg: deg }),
    setRealtimeWallGen: (on) => set({ realtimeWallGen: on }),
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
