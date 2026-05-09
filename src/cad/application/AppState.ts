import { create } from 'zustand';
import { mat4 } from 'gl-matrix';
import { BaseElement } from '../model/base/BaseElement';
import { ElementId } from '../model/base/ElementId';
import { Command } from '../commands/base/Command';
import { CommandHistory } from '../commands/base/CommandHistory';
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
import {
    ElementTypeDef,
    seedStandardTypes,
    DEFAULT_TYPE_BY_CATEGORY,
    CategoryId,
} from '../model/catalog';

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
    | { kind: "wallPoint"; wallId: ElementId; endIdx: 0 | 1 }
    // 部屋外の "ポイント候補": Length などの拘束で 2 点間の距離をかける時、
    // 部屋頂点だけでなく柱中心 / 通芯端点 / 原点なども選べるようにする。
    | { kind: "column"; columnId: ElementId }
    | { kind: "gridPoint"; gridId: string; vertexIdx: number }
    | { kind: "origin" }
    // 通芯線そのもの (= 柱-通芯の垂直距離拘束に使う edge ライク選択)。
    | { kind: "gridLine"; gridId: string };

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
    if (s.kind === "wallPoint") return `wp:${s.wallId}:${s.endIdx}`;
    if (s.kind === "column") return `col:${s.columnId}`;
    if (s.kind === "gridPoint") return `gp:${s.gridId}:${s.vertexIdx}`;
    if (s.kind === "gridLine") return `gl:${s.gridId}`;
    return `o`;
}

/**
 * 拘束ソルバへのドラッグピン (= FreeCAD `MoveParameters` 相当)。
 * SketchSolver がこの頂点を **fixed** としてカーソル位置にピン留めし、
 * 他の頂点は拘束を満たすよう reflow する。
 *
 * 配列で複数ピンを許す:
 *  - 単点ドラッグ (= polyVertex):     1 ピン
 *  - 辺ドラッグ (= polyEdge):         2 ピン (辺両端を perp 位置に)
 *  - ポリゴン全体平行移動 (= poly):    全頂点をそれぞれの新位置にピン
 *
 * ピンによってソルバが拘束を満たす唯一の解を返すため、drag handler 側は
 * ジオメトリを直接書き込まず、ピンと現在のカーソル位置だけ伝える設計。
 * 複数ピンが拘束矛盾を生む場合は solver が失敗 → polygon の元位置維持。
 */
export interface SolverDragPin {
    spaceId: ElementId;
    polyId: string;
    vertexIdx: number;
    x: number;
    y: number;
}

/** 後方互換のため alias を残す (= 単点ピンは Pin[] の長さ 1 と等価)。 */
export type SolverDragHint = SolverDragPin;

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
    | "wallSkip" // 既存エッジの部分削除 (= 3D 壁を生成しない区間) を 2 クリックで定義。
    | "wallPath";

/** Wall-tool sub-mode: "add" draws new walls, "select" picks sketch lines. */
export type WallSubMode = "add" | "select";
export type BeamSubMode = "add" | "edit";
export type ColumnSubMode = "add" | "edit";

/** Top-level design mode (per docs/specification/new.md §8). */
export type DesignMode = "freeZoning" | "jpResidentialGrid";

/** ビュー切替: 2D = ortho top-down (作図中心)、3D = perspective (Door/Window 配置・確認)。 */
export type ViewMode = "2D" | "3D";

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
    // Beam tool sub-mode (add / edit)
    beamSubMode: BeamSubMode;
    // Column tool sub-mode (add / edit)
    columnSubMode: ColumnSubMode;

    /**
     * Top-level design mode (per docs/specification/new.md §8).
     *  - freeZoning:        no background grid, room blocks edited freely.
     *  - jpResidentialGrid: 910mm primary + 455mm secondary grid is rendered
     *                       and mouse / vertex motion snaps to it.
     */
    designMode: DesignMode;

    /** ビューモード (2D / 3D)。各モードで使えるツールが切り替わる:
     *  - 2D (既定): Select + 作図系 (Room / Column / Beam / Slab / Gridline / Door / Window)
     *  - 3D: Select + Door / Window のみ (3D 視点での開口配置・確認用) */
    viewMode: ViewMode;

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
    /**
     * スケッチ線 (= polygon outer) を壁のどこに置くかの既定モード。
     *  - "Center"   壁芯。outer はちょうど壁の真ん中 → inner=outer=T/2
     *  - "Interior" 内法線。outer は室内側仕上げ面 → inner=0, outer=T
     *  - "Exterior" 外法線。outer は屋外側仕上げ面 → inner=T, outer=0
     * wallRegenerate に流れて polygon.wallReference として保存され、
     * JunctionGraph の per-edge offset 計算と wall element の locationLine
     * フィールドに反映される。
     */
    wallReferenceMode: "Center" | "Interior" | "Exterior";
    /** 円ポリゴンの壁分割角 (deg)。同じくリアルタイム生成と共有する。 */
    circleWallAngleDeg: string;
    /**
     * 部屋編集モードでのリアルタイム壁生成を有効にするか。
     *  - true (既定): 矩形・ポリライン・円の確定直後と、ポリゴンの
     *    ドラッグ完了直後に `regenerateAllWalls` を自動実行する。
     *  - false: 「全壁生成」ボタンを押した時のみ生成する従来挙動。
     */
    realtimeWallGen: boolean;

    // ── Type / Family / Category システム ───────────────────────
    //
    // Type は要素の「データ定義」(per ifc_webcad_core_architecture_spec §6)。
    // 起動時に標準 Type が seed され、ユーザは複製してユーザ Type を作れる。
    // 各カテゴリの「現在アクティブな Type」を保持し、ツール起動時に自動で
    // その Type を新規要素へ割り当てる。
    types: Record<string, ElementTypeDef>;
    /** Category id → 現在アクティブな Type id (= 新規作成のデフォルト型)。 */
    activeTypeIdByCategory: Partial<Record<CategoryId, string>>;

    // 2D 幾何拘束 (docs/specification/2d_constraint_system_spec.md)
    constraints: Record<string, Constraint>;
    sketchSelection: SketchSelectionItem[];
    selectedConstraintId: string | null;
    /**
     * 拘束ソルバへのドラッグピン (= FreeCAD MoveParameters 相当)。配列の
     * 各要素は「この頂点をこの位置に固定して欲しい」という solver への
     * 希望値。pointerMove で更新し、pointerUp で空配列クリアする。
     * 空配列 (= []) は「ドラッグ中ではない」を表す。
     */
    solverDragHint: SolverDragPin[];

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
    setWallReferenceMode: (mode: "Center" | "Interior" | "Exterior") => void;
    setCircleWallAngleDeg: (deg: string) => void;
    setRealtimeWallGen: (on: boolean) => void;

    // Wall tool sub-mode action
    setWallSubMode: (mode: WallSubMode) => void;
    setBeamSubMode: (mode: BeamSubMode) => void;
    setColumnSubMode: (mode: ColumnSubMode) => void;

    // Design mode action
    setDesignMode: (mode: DesignMode) => void;
    setViewMode: (mode: ViewMode) => void;

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
    /** Drag ピンを設定 (= FreeCAD `initMove` + `moveGeometries` 相当)。
     *  null / 空配列 → drag 終了 (= ピン解除)。null クリアで再ソルブが走る。 */
    setSolverDragHint: (hint: SolverDragPin[] | SolverDragPin | null) => void;
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

    // Type system actions
    /** Type を AppState.types に追加 (= ユーザ複製・読み込み)。 */
    addType: (t: ElementTypeDef) => void;
    /** Type の partial update。標準 Type には触らない (= UI で弾く)。 */
    updateType: (id: string, partial: Partial<ElementTypeDef>) => void;
    /** Type 削除。標準 Type は削除不可 (= UI で弾く)。 */
    removeType: (id: string) => void;
    /** カテゴリのアクティブ Type 切替 (= ツールバーで現在型を選んだ時)。 */
    setActiveTypeId: (categoryId: CategoryId, typeId: string) => void;

    // Commands
    executeCommand: (command: Command) => void;
    undo: () => void;
    redo: () => void;
}

/**
 * Undo / Redo 用の Command 履歴。zustand state には乗せず module-level に置く:
 *   - 内部 (undoStack / redoStack) の更新は React 再描画とは独立してよい
 *   - command.execute() / undo() 自体が `useAppState.getState()` 経由で
 *     state を変えるので、それで UI が更新される
 *   - HMR で複数 instance になるのを防ぐため module top に singleton を 1 つ
 */
export const commandHistory = new CommandHistory();

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
    wallReferenceMode: "Center",
    circleWallAngleDeg: "15",
    realtimeWallGen: true,
    wallSubMode: "add",
    beamSubMode: "add",
    columnSubMode: "add",
    designMode: "freeZoning",
    viewMode: "2D",
    grids: [],
    gridNaming: DEFAULT_GRID_NAMING,
    gridlineDrafting: false,
    gridDraftMode: "line",
    selectedGridIds: [],
    constraints: {},
    sketchSelection: [],
    selectedConstraintId: null,
    solverDragHint: [],
    types: seedStandardTypes(),
    activeTypeIdByCategory: { ...DEFAULT_TYPE_BY_CATEGORY },

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
    setActiveTool: (tool) => set((state) => {
        // 2D 描画モードの相互排他: 部屋モードと両立しないツール (gridline /
        // column / beam / slab / door / window) を選んだ場合は、部屋モードを
        // 抜ける。"select" と "wall" は部屋モード中でも使える (= 共存)。
        const incompatibleWithRoom = new Set([
            "gridline", "column", "beam", "slab", "door", "window",
        ]);
        if (incompatibleWithRoom.has(tool)
            && (state.activeRoomId !== null || state.pendingRoomLevelId !== null)) {
            return {
                activeTool: tool,
                activeRoomId: null,
                pendingRoomLevelId: null,
                roomEditMode: "select",
            };
        }
        return { activeTool: tool };
    }),

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
        // ただし **drag 中** (= solverDragHint にピンが入っている) は solver
        // 起動を skip する。理由: drag handler は同フレームで polygon outer +
        // entity + wall axis を一斉更新しており、ここで async ソルバが間に
        // 入ると polygon と entity / wall axis が drift して「サイズ大⇆小」の
        // 振動になる (= ユーザ報告)。drag END の `setSolverDragHint(null)`
        // でピンが空になった時に最終ソルブを走らせる。
        const latest = get();
        if (latest.solverDragHint.length > 0) return;
        const mod = require('../constraint/SketchSolver') as typeof import('../constraint/SketchSolver');
        mod.runSketchSolver();
    },
    setActiveRoom: (id) =>
        set((state) => {
            // 部屋モードに入る時、両立しない activeTool ("gridline", "door",
            // "window", "column", "beam", "slab") は "select" にリセット。
            // "wall" は部屋モード中でも有効なのでそのまま。
            const incompatibleWithRoom = new Set([
                "gridline", "column", "beam", "slab", "door", "window",
            ]);
            const resetTool = id !== null && incompatibleWithRoom.has(state.activeTool);
            return {
                activeRoomId: id,
                roomEditMode: "select",
                // 実体ある Space をアクティブにした時点で「pending」状態は終わり。
                // 部屋モード解除 (id=null) でも pending を残さないようクリアする。
                pendingRoomLevelId: null,
                ...(resetTool ? { activeTool: "select" } : {}),
            };
        }),
    setRoomEditMode: (mode) => set({ roomEditMode: mode }),
    setPendingRoomLevel: (levelId) =>
        set((state) => {
            const incompatibleWithRoom = new Set([
                "gridline", "column", "beam", "slab", "door", "window",
            ]);
            const resetTool = levelId !== null && incompatibleWithRoom.has(state.activeTool);
            return {
                pendingRoomLevelId: levelId,
                // pending に入る時は activeRoomId を握ったままだと
                // 古い部屋に追記してしまうので、合わせてクリアする。
                ...(levelId ? { activeRoomId: null, roomEditMode: "select" } : {}),
                ...(resetTool ? { activeTool: "select" } : {}),
            };
        }),
    setWallThicknessMm: (mm) => set({ wallThicknessMm: mm }),
    setWallReferenceMode: (mode) => set({ wallReferenceMode: mode }),
    setCircleWallAngleDeg: (deg) => set({ circleWallAngleDeg: deg }),
    setRealtimeWallGen: (on) => set({ realtimeWallGen: on }),
    setWallSubMode: (mode) => set((state) => ({
        wallSubMode: mode,
        // Switching sub-modes clears any in-flight sketch selection so the
        // user starts fresh when they toggle.
        sketchSelection: mode === state.wallSubMode ? state.sketchSelection : [],
    })),
    setBeamSubMode: (mode) => set({ beamSubMode: mode }),
    setColumnSubMode: (mode) => set({ columnSubMode: mode }),

    setDesignMode: (mode) => set({ designMode: mode }),
    setViewMode: (mode) => set((state) => {
        // 各モードで使えないツールが有効なら select に戻す。
        //   2D (作図): Column / Beam / Slab / Gridline / Room
        //   3D (確認・開口配置): Door / Window
        // 例: 3D 切替時に Column が active → select に戻す。2D 切替時に
        // Door が active → select に戻す。
        const tools2DOnly = new Set([
            "column", "beam", "slab", "gridline", "wall",
        ]);
        const tools3DOnly = new Set(["door", "window"]);
        let nextTool = state.activeTool;
        let clearRoom = false;
        if (mode === "3D") {
            if (tools2DOnly.has(state.activeTool)) nextTool = "select";
            // Room mode は 2D 専用なので 3D 切替時に解除。
            if (state.activeRoomId !== null || state.pendingRoomLevelId !== null) {
                clearRoom = true;
            }
        } else {
            if (tools3DOnly.has(state.activeTool)) nextTool = "select";
        }
        if (nextTool === state.activeTool && !clearRoom) {
            return { viewMode: mode };
        }
        return {
            viewMode: mode,
            activeTool: nextTool,
            ...(clearRoom ? {
                activeRoomId: null,
                pendingRoomLevelId: null,
                roomEditMode: "select" as const,
            } : {}),
        };
    }),

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
            // この通芯に水平 / 垂直拘束が付いていれば、ドラッグ点の座標と
            // 他頂点の座標を **共有** して拘束を維持する。
            //   - Horizontal (水平): 全頂点が同じ Z を持つ → ドラッグ点の Z
            //     をそのまま使い、他頂点の Z も同値に更新 (= 線が上下に平行
            //     移動できる)
            //   - Vertical (垂直): 全頂点が同じ X を持つ → 同様に X を共有
            // 旧実装では「ドラッグ点の Z を他頂点に強制」していたため、線が
            // 上下に動かせなかった。
            //
            // また、原点との Length 拘束 (= 通過 / 距離) があれば、Horizontal
            // 軸での Z または Vertical 軸での X を「原点から D の位置」に強制
            // して拘束を保つ。
            const cons = Object.values(state.constraints);
            const hasH = cons.some((c) => c.type === "Horizontal"
                && c.targets.some((t) => t.kind === "Grid" && t.gridId === id));
            const hasV = cons.some((c) => c.type === "Vertical"
                && c.targets.some((t) => t.kind === "Grid" && t.gridId === id));
            const originLen = cons.find((c) =>
                c.type === "Length"
                && c.value !== undefined
                && c.targets.some((t) => t.kind === "Grid" && t.gridId === id)
                && c.targets.some((t) => t.kind === "Origin"));
            // 通芯-通芯 の Length 拘束を集める (= 他通芯との距離を固定)。
            // self の現在側 (= 他通芯から +n 側 / -n 側) を保ったまま強制。
            const gridGridLens = cons.filter((c) =>
                c.type === "Length"
                && c.value !== undefined
                && c.targets.length === 2
                && c.targets.every((t) => t.kind === "Grid")
                && c.targets.some((t) => t.kind === "Grid" && t.gridId === id),
            );
            let pos: typeof position = [position[0], position[1], position[2]];
            // 原点との距離拘束を最優先。軸平行通芯ならその軸で原点距離 D を保つ。
            if (originLen && originLen.value !== undefined) {
                const D = originLen.value;
                if (hasH) {
                    const prevZ = v[0][2];
                    const sign = prevZ >= 0 ? 1 : -1;
                    pos = [pos[0], pos[1], sign * D];
                } else if (hasV) {
                    const prevX = v[0][0];
                    const sign = prevX >= 0 ? 1 : -1;
                    pos = [sign * D, pos[1], pos[2]];
                }
            } else if (gridGridLens.length > 0) {
                // 通芯-通芯 距離拘束: self が水平/垂直軸平行で、他通芯も同方向
                // なら、その軸座標 (Z or X) を「他通芯の座標 ± D」に強制。
                //   - 両方水平 → Z 固定 (other.Z ± D)
                //   - 両方垂直 → X 固定 (other.X ± D)
                // 複数あれば最初の 1 個を採用 (= 矛盾拘束は前段で無効化想定)。
                for (const c of gridGridLens) {
                    const otherT = c.targets.find(
                        (t) => t.kind === "Grid" && t.gridId !== id,
                    );
                    if (!otherT || otherT.kind !== "Grid") continue;
                    const otherGrid = state.grids.find((g2) => g2.id === otherT.gridId);
                    if (!otherGrid) continue;
                    const ov = gridVertices(otherGrid.curve);
                    if (ov.length < 2) continue;
                    const odx = ov[1][0] - ov[0][0];
                    const odz = ov[1][2] - ov[0][2];
                    const olen = Math.hypot(odx, odz);
                    if (olen < 1e-9) continue;
                    const otherIsH = Math.abs(odz) / olen < 1e-3;
                    const otherIsV = Math.abs(odx) / olen < 1e-3;
                    const D = c.value as number;
                    if (hasH && otherIsH) {
                        const otherZ = ov[0][2];
                        const prevZ = v[0][2];
                        const sign = prevZ >= otherZ ? 1 : -1;
                        pos = [pos[0], pos[1], otherZ + sign * D];
                        break;
                    }
                    if (hasV && otherIsV) {
                        const otherX = ov[0][0];
                        const prevX = v[0][0];
                        const sign = prevX >= otherX ? 1 : -1;
                        pos = [otherX + sign * D, pos[1], pos[2]];
                        break;
                    }
                }
            }
            const next = v.slice();
            next[index] = pos;
            // Horizontal/Vertical: ドラッグ点の座標を全頂点に伝播。
            if (hasH) {
                for (let k = 0; k < next.length; k++) {
                    if (k !== index) next[k] = [next[k][0], next[k][1], pos[2]];
                }
            }
            if (hasV) {
                for (let k = 0; k < next.length; k++) {
                    if (k !== index) next[k] = [pos[0], next[k][1], next[k][2]];
                }
            }
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
        // Normalize: null → [], 単点 → [pin], 既に配列ならそのまま。
        const pins: SolverDragPin[] = hint === null
            ? []
            : Array.isArray(hint) ? hint : [hint];
        set({ solverDragHint: pins });
        // ドラッグ中 (= pins 非空) は solver を回さない。
        //  - drag handler は同フレームで polygon outer + entity + wall axis を
        //    一斉更新しており、ここで async ソルバが間に入ると 2D polygon と
        //    3D wall axis の sync が壊れる (= フリッカー)。
        //  - また solver writeback の arc reshape 経路 (SketchSolver.ts 1098+)
        //    は polygon outer の変化を起点に arc.aStart/aEnd を再計算するため、
        //    drag 中の中間状態に対して走らせると弧パラメータが破壊され「弧が
        //    円になる」「直線が消える」という症状を引き起こす。
        // drag END (= pins 空) で最終確定 solve を一度だけ走らせる。
        if (pins.length === 0) {
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

    // ── Type system actions ─────────────────────────────────────
    addType: (t) => set((state) => ({
        types: { ...state.types, [t.id]: t },
    })),
    updateType: (id, partial) => set((state) => {
        const cur = state.types[id];
        if (!cur) return state;
        if (cur.isStandard) {
            // 標準 Type は read-only。UI で弾く想定だが防御的にも拒否。
            return state;
        }
        return { types: { ...state.types, [id]: { ...cur, ...partial } as ElementTypeDef } };
    }),
    removeType: (id) => set((state) => {
        const cur = state.types[id];
        if (!cur || cur.isStandard) return state;
        const { [id]: _, ...rest } = state.types;
        return { types: rest };
    }),
    setActiveTypeId: (categoryId, typeId) => set((state) => ({
        activeTypeIdByCategory: { ...state.activeTypeIdByCategory, [categoryId]: typeId },
    })),

    executeCommand: (command) => {
        const result = commandHistory.execute(command);
        if (!result.success) {
            console.warn("Command failed:", result.message);
        }
    },
    undo: () => {
        const result = commandHistory.undo();
        if (!result.success) {
            // eslint-disable-next-line no-console
            console.log("[undo]", result.message);
        }
    },
    redo: () => {
        const result = commandHistory.redo();
        if (!result.success) {
            // eslint-disable-next-line no-console
            console.log("[redo]", result.message);
        }
    },
}));
