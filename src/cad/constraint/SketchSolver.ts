// 2D 幾何拘束ソルバ — planegcs (FreeCAD GCS) バックエンド
//
// 対象は Space.polygons の各外周頂点 / 辺。すべてのポリゴンは一般の N 角形と
// して扱い、軸平行性などの形状特性は **暗黙的には強制しない**。矩形ツールで
// 作図された 4 頂点ポリゴンも、ユーザに見える Horizontal / Parallel 等の拘束
// によってその形状を維持する。
//
// pinning 戦略: いかなる頂点も `fixed: true` にしない。GCS は初期値に近い解
// を返すため、ドラッグ後は新しい位置が初期値となり、過拘束でなければそのまま
// 維持される。これにより異ポリゴン間の Coincident / PointOnGrid なども自然に
// 動作する。

import { useAppState } from "../application/AppState";
import { SpaceElement, RoomPolygon, polygonEdges } from "../model/elements/SpaceElement";
import { Constraint, ConstraintTarget } from "../model/constraint/Constraint";
import { GridLine, gridVertices } from "../model/grid/GridLine";
import { ColumnElement } from "../model/elements/ColumnElement";
import { columnFootprint2D } from "../mesh/builders/ColumnMeshBuilder";
import { WallElement } from "../model/elements/WallElement";
import { Vec2 } from "../geometry/math/Vec2";
import { Vec3 } from "../geometry/math/Vec3";
import { computeMiteredCorners, computeMiteredWallAxes, syncWallsToPolygonOuter } from "../ui/room/wallSync";
import { GcsBackend } from "./GcsBackend";
import { triggerWallRegenIfEnabled } from "../ui/room/wallRegenerate";
import type { SketchEntity, ArcEntity, PolylineEntity, LineEntity } from "../model/sketch/SketchEntity";

const ROOM_SHAPE_DEBUG = true;
const fmtPt = (p: Vec2) => `(${p[0].toFixed(3)},${p[1].toFixed(3)})`;
const fmtRing = (pts: Vec2[]) => `[${pts.map(fmtPt).join(" ")}]`;

/**
 * 弧 / 円エンティティの「途中点」(= 弧をテッセレートして生まれた polygon
 * 頂点) を判定する。ユーザがポリゴンに拘束を入れたとき、ソルバが弧の
 * tessellation 頂点を勝手に動かして弧の形状を壊さないよう、そういう頂点は
 * `fixed: true` で押し込み、解きほぐしの自由度から外す必要がある。
 *
 * 隣接する 2 本のエッジの owner が同じ ArcEntity / CircleEntity なら interior。
 */
function isArcInteriorVertex(
    poly: RoomPolygon,
    vIdx: number,
    entities: SketchEntity[],
): boolean {
    if (!poly.edgeOwners) return false;
    const polyEdgeList = polygonEdges(poly);
    let owner: string | undefined;
    let count = 0;
    for (let ei = 0; ei < polyEdgeList.length; ei++) {
        const [va, vb] = polyEdgeList[ei];
        if (va !== vIdx && vb !== vIdx) continue;
        const o = poly.edgeOwners[ei];
        if (!o) return false;
        if (owner === undefined) owner = o;
        else if (owner !== o) return false;
        count++;
    }
    if (count < 2 || !owner) return false;
    const ent = entities.find((e) => e.id === owner);
    return !!ent && (ent.kind === "arc" || ent.kind === "circle");
}

type OID = number;

interface PolyIds {
    points: OID[];               // outer vertex ids (length = outer.length)
    lines: OID[];                // edge ids in polygon edge order (length = polygonEdges(poly).length)
    edgeVerts: [number, number][]; // per edge, vertex indices into `points`
}

interface CircleIds {
    centerPoint: OID;
    circle: OID;
}

interface WallAxisIds {
    p1: OID; // axis[0] as 2D point
    p2: OID; // axis[1] as 2D point
    line: OID;
}

// ----- concurrency guard (re-entrance prevention) -----
let solvingDepth = 0;

// ----- solve runner -----
let running = false;
let pendingResolveRequested = false;
/** 弧含み polygon の再派生が走った直後に立てる。runSketchSolver の while
 *  ループで pendingResolveRequested と合流させ、再派生後の polygon outer に
 *  対してもう一度解く (= 拘束が再派生で破られていれば収束させる)。 */
let arcRederiveRequested = false;
const MAX_SOLVE_ITERATIONS = 5;

/**
 * Run the constraint solver against the current AppState and write back the
 * resulting polygon vertex coordinates. Called whenever polygons or constraints
 * change (via AppState hooks).
 *
 * Because planegcs is async (WASM), multiple concurrent requests are collapsed:
 * if a solve is already running, a new request is queued to run once.
 */
export function runSketchSolver(): void {
    if (solvingDepth > 0) return;
    // Drag 中、もしくは多段階の polygon/constraint 更新の途中 (= solverDragHint
    // にダミーピンを入れて抑制している) は走らせない。setSpaceEntities /
    // updateElement(polygons) 側でも同じチェックをしているが、addConstraint /
    // removeConstraint は直接ここを呼ぶため、この層で一律に抑制する。
    const dragHints = useAppState.getState().solverDragHint;
    if (dragHints.length > 0) {
        // 抑制中でも次のクリアでまとめて 1 回走らせるために pending を立てる。
        if (running) pendingResolveRequested = true;
        return;
    }
    if (running) {
        pendingResolveRequested = true;
        return;
    }
    running = true;
    void (async () => {
        try {
            // ─── 初回 solveOnce 直前で drag が始まっていたら走らせない ───
            // 距離拘束追加直後 (= addConstraint → runSketchSolver) の async solve が
            // 立ち上がる前にユーザがドラッグ開始するケース。dragHints が set されて
            // いるなら、この一連の solver イテレーションを完全に skip して mouseup
            // 側に委ねる。これがないと WASM solver が drag 中ずっと回り続け、
            // フレームレートが大幅に低下する (= ユーザ報告「距離拘束を付けると
            // 全体のドラッグが非常に遅くなる」の原因)。
            if (useAppState.getState().solverDragHint.length > 0) {
                pendingResolveRequested = true;
                return;
            }
            await solveOnce();
            let iter = 1;
            while ((pendingResolveRequested || arcRederiveRequested) && iter < MAX_SOLVE_ITERATIONS) {
                // 各イテレーション前に dragHints を再チェック。drag が始まったら
                // ループ脱出し、solver を停止させる。drag フレームごとの updateElement
                // が pending を立て続ける限り、このループは無限に WASM solver を
                // 起動して drag を妨害してしまう。
                if (useAppState.getState().solverDragHint.length > 0) break;
                pendingResolveRequested = false;
                arcRederiveRequested = false;
                await solveOnce();
                iter++;
            }
        } catch (e) {
            // eslint-disable-next-line no-console
            console.warn("[SketchSolver] failed:", e);
        } finally {
            running = false;
        }
    })();
}

async function solveOnce(): Promise<void> {
    const state = useAppState.getState();
    const constraints = Object.values(state.constraints);
    // 複数ピン対応 (= FreeCAD MoveParameters 配列相当)。drag handler が
    // setSolverDragHint([pin1, pin2, ...]) でセット。ピンが指す頂点は
    // ソルバ内で fixed=true として push され、他の頂点は拘束を満たすよう
    // reflow する。
    const dragHints = state.solverDragHint;
    // Drag 中でも拘束が無ければソルブする意味は無い。早期 return。
    if (constraints.length === 0 && dragHints.length === 0) return;

    // Collect all polygons (non-circle), circles, and wall axes targeted by
    // any constraint.
    const polys = new Map<string, { spaceId: string; poly: RoomPolygon }>();
    const circles = new Map<string, { spaceId: string; poly: RoomPolygon }>();
    const walls = new Map<string, { wall: WallElement }>();
    /** SketchEntity (Arc / Circle entity) を直接参照する拘束用。
     *  key = `${spaceId}:${entityId}` */
    const arcEntities = new Map<string, {
        spaceId: string; entityId: string;
        kind: "arc" | "circle";
        center: [number, number]; radius: number;
    }>();
    for (const c of constraints) {
        for (const t of c.targets) {
            if (t.kind === "SketchPoint" || t.kind === "SketchEdge" || t.kind === "SketchCircle") {
                const key = `${t.spaceId}:${t.polyId}`;
                const space = state.elements[t.spaceId as string] as SpaceElement | undefined;
                if (!space || space.type !== "Space") continue;
                const poly = space.polygons?.find((p) => p.id === t.polyId);
                if (!poly) continue;
                if (poly.shape?.type === "circle" && t.kind === "SketchCircle") {
                    if (!circles.has(key)) circles.set(key, { spaceId: t.spaceId as string, poly });
                } else if (t.kind !== "SketchCircle") {
                    if (!polys.has(key)) polys.set(key, { spaceId: t.spaceId as string, poly });
                }
            } else if (t.kind === "SketchEntity") {
                const key = `${t.spaceId}:${t.entityId}`;
                if (arcEntities.has(key)) continue;
                const space = state.elements[t.spaceId as string] as SpaceElement | undefined;
                if (!space || space.type !== "Space") continue;
                const ent = (space.entities ?? []).find((e) => e.id === t.entityId);
                if (!ent) continue;
                if (ent.kind === "arc" || ent.kind === "circle") {
                    arcEntities.set(key, {
                        spaceId: t.spaceId as string,
                        entityId: t.entityId,
                        kind: ent.kind,
                        center: [ent.center[0], ent.center[1]],
                        radius: ent.radius,
                    });
                }
            } else if (t.kind === "WallAxis" || t.kind === "WallAxisPoint") {
                const wid = t.wallId as string;
                if (walls.has(wid)) continue;
                const wall = state.elements[wid] as WallElement | undefined;
                if (!wall || wall.type !== "Wall") continue;
                walls.set(wid, { wall });
            }
        }
    }
    // Always include wall-outline polygons, regardless of whether any
    // constraint references them. Outlines are derived from their inner
    // polygon + thickness, and we use the solver pass to snap them back
    // after the UI / drag handler has moved them. Also collect outline ids
    // so we can skip any existing constraint referencing them (legacy rect
    // wall data carries Parallel / PerpDistance that would conflict with
    // the fixed-outline strategy).
    const outlinePolyIds = new Set<string>();
    for (const el of Object.values(state.elements)) {
        const sp = el as SpaceElement;
        if (!sp || sp.type !== "Space" || !sp.polygons) continue;
        for (const p of sp.polygons) {
            if (!p.wallOutlineOf) continue;
            outlinePolyIds.add(p.id);
            const key = `${sp.id}:${p.id}`;
            if (!polys.has(key)) polys.set(key, { spaceId: sp.id, poly: p });
        }
    }

    // 部屋/壁を参照しない拘束 (= 柱-柱 / 柱-通芯 / 柱-原点 など) があれば
    // solver は走らせる必要がある。Column / Grid / GridPoint / Origin の
    // 何れかを参照する拘束があるかをチェック。
    const hasNonRoomTarget = constraints.some((c) =>
        c.targets.some((t) =>
            t.kind === "Column" || t.kind === "ColumnVertex" || t.kind === "ColumnEdge"
            || t.kind === "Grid"
            || t.kind === "GridPoint" || t.kind === "Origin"));
    if (
        polys.size === 0 && circles.size === 0 && walls.size === 0
        && arcEntities.size === 0 && !hasNonRoomTarget
    ) return;

    // Build reverse index: wall.id → owning polygon (if any).
    // A wall is "owned" when it appears in some RoomPolygon.wallIds. For owned
    // walls we externally re-derive the axis from the polygon's outer ring
    // (applying dragHint) and push the endpoints as fixed primitives — the
    // solver therefore cannot drift walls out of their thickness offset from
    // the polygon. See Approach 2 in docs/… .
    type WallOwner = { spaceId: string; poly: RoomPolygon; edgeIdx: number };
    const wallOwnership = new Map<string, WallOwner>();
    for (const el of Object.values(state.elements)) {
        const sp = el as SpaceElement;
        if (!sp || sp.type !== "Space" || !sp.polygons) continue;
        for (const p of sp.polygons) {
            if (!p.wallIds) continue;
            for (let i = 0; i < p.wallIds.length; i++) {
                const wid = p.wallIds[i];
                if (wid) wallOwnership.set(wid, { spaceId: sp.id, poly: p, edgeIdx: i });
            }
        }
    }

    // Pre-compute mitered wall axes per polygon, applying dragHint to a single
    // vertex if it matches. Cached by spaceId:polyId. Returns null when the
    // polygon isn't wall-capable (no wallIds, mismatched lengths, no thickness).
    const computedAxesByPoly = new Map<string, [Vec3, Vec3][]>();
    const ensureAxes = (spaceId: string, poly: RoomPolygon): [Vec3, Vec3][] | null => {
        if (!poly.wallIds || poly.wallThickness == null) return null;
        if (poly.wallIds.length !== poly.outer.length) return null;
        const key = `${spaceId}:${poly.id}`;
        const cached = computedAxesByPoly.get(key);
        if (cached) return cached;
        const effective: Vec2[] = poly.outer.map((v, i) => {
            const pin = dragHints.find((p) =>
                p.spaceId === spaceId && p.polyId === poly.id && p.vertexIdx === i,
            );
            if (pin) return [pin.x, pin.y];
            return [v[0], v[1]];
        });
        let cx = 0, cy = 0;
        for (const p of effective) { cx += p[0]; cy += p[1]; }
        cx /= effective.length; cy /= effective.length;
        const axes = computeMiteredWallAxes(effective, [cx, cy], poly.wallThickness / 2);
        computedAxesByPoly.set(key, axes);
        return axes;
    };

    const wrapper = await GcsBackend.makeWrapper();
    try {
        const idAlloc = new IdAllocator();
        const polyIds = new Map<string, PolyIds>();
        const circleIds = new Map<string, CircleIds>();
        const wallIds = new Map<string, WallAxisIds>();
        const fixedWallIds = new Set<string>(); // walls pushed as fixed (owned)
        const primitives: any[] = [];

        // ── Push polygons as N points + N lines (no implicit constraints) ──
        // ドラッグピンは hard pin (fixed: true) で表現する (parametric-cad と同じ)。
        // (spaceId, polyId, vertexIdx) → pin の高速 lookup。複数ピンを多用
        // するので毎回線形検索しない。
        const pinByVertex = new Map<string, typeof dragHints[number]>();
        for (const p of dragHints) {
            pinByVertex.set(`${p.spaceId}:${p.polyId}:${p.vertexIdx}`, p);
        }
        const pinKey = (spaceId: string, polyId: string, vIdx: number) =>
            `${spaceId}:${polyId}:${vIdx}`;

        // Derive an outline polygon's outer from its inner (with any dragHint
        // pin on the inner applied). 複数ピン対応。
        const deriveOutlineOuter = (spaceId: string, outlinePoly: RoomPolygon): Vec2[] | null => {
            const innerId = outlinePoly.wallOutlineOf;
            if (!innerId) return null;
            const sp = state.elements[spaceId] as SpaceElement | undefined;
            if (!sp || sp.type !== "Space") return null;
            const inner = sp.polygons?.find((p) => p.id === innerId);
            if (!inner || inner.wallThickness == null || inner.outer.length < 3) return null;
            const innerEffective: Vec2[] = inner.outer.map((v, i) => {
                const pin = pinByVertex.get(pinKey(spaceId, inner.id, i));
                if (pin) return [pin.x, pin.y];
                return [v[0], v[1]];
            });
            let cx = 0, cy = 0;
            for (const v of innerEffective) { cx += v[0]; cy += v[1]; }
            cx /= innerEffective.length; cy /= innerEffective.length;
            return computeMiteredCorners(innerEffective, [cx, cy], inner.wallThickness);
        };

        for (const [key, entry] of polys) {
            const isOutline = !!entry.poly.wallOutlineOf;
            const outer: Vec2[] = isOutline
                ? (deriveOutlineOuter(entry.spaceId, entry.poly) ?? entry.poly.outer)
                : entry.poly.outer;
            const n = outer.length;
            const sp = state.elements[entry.spaceId] as SpaceElement | undefined;
            const spEntities = sp?.entities ?? [];
            const pIds: OID[] = [];
            for (let i = 0; i < n; i++) {
                const pid = idAlloc.next();
                pIds.push(pid);
                if (isOutline) {
                    primitives.push({
                        type: "point",
                        id: String(pid),
                        x: outer[i][0],
                        y: outer[i][1],
                        fixed: true,
                    });
                    continue;
                }
                // 弧 / 円 entity 由来の tessellation interior 頂点は **固定** で
                // push する。これらをフリー変数として残すと、外部拘束 (= 矩形の
                // 上辺 Horizontal 等) が弧の途中の点を勝手に動かして弧の形状を
                // 壊してしまう。`fixed: true` にしておけば解後も弧の見た目が
                // 保たれる (弧自体は ArcEntity の center / radius / aStart / aEnd
                // でパラメトリックに表現され、setSpaceEntities 経由で再テッセレ
                // ートされるのが本来の真実)。
                //
                // Drag pin は hard pin (= fixed: true)。parametric-cad と同じ。
                // 曲線上拘束 (PointOnCircle / PointOnGrid 等) を持つ頂点で
                // カーソルが拘束を破ると solver が status != 0 で失敗 → writeback
                // しない (= polygon は前フレームのまま) ので暴走はしない。
                const isArcInterior = isArcInteriorVertex(entry.poly, i, spEntities);
                const pin = pinByVertex.get(pinKey(entry.spaceId, entry.poly.id, i));
                const isDragPin = pin != null;
                primitives.push({
                    type: "point",
                    id: String(pid),
                    x: pin ? pin.x : outer[i][0],
                    y: pin ? pin.y : outer[i][1],
                    fixed: isArcInterior || isDragPin,
                });
            }
            const lIds: OID[] = [];
            const polyEdgeList = polygonEdges(entry.poly);
            const edgeVerts: [number, number][] = [];
            for (const [va, vb] of polyEdgeList) {
                const a = pIds[va];
                const b = pIds[vb];
                const lid = idAlloc.next();
                lIds.push(lid);
                edgeVerts.push([va, vb]);
                primitives.push({ type: "line", id: String(lid), p1_id: String(a), p2_id: String(b) });
            }
            polyIds.set(key, { points: pIds, lines: lIds, edgeVerts });
        }

        // ── Group concentric circles via union-find so each group shares a
        // single center-point primitive. This hard-wires concentricity at the
        // geometry level — the solver cannot drift the centers apart.
        const parent = new Map<string, string>();
        const find = (x: string): string => {
            if (!parent.has(x)) parent.set(x, x);
            const p = parent.get(x)!;
            if (p === x) return x;
            const r = find(p);
            parent.set(x, r);
            return r;
        };
        const unionKeys = (a: string, b: string) => {
            const ra = find(a), rb = find(b);
            if (ra !== rb) parent.set(ra, rb);
        };
        for (const c of constraints) {
            if (c.type !== "ConcentricCircle") continue;
            const cts = c.targets.filter((t) => t.kind === "SketchCircle");
            for (let i = 1; i < cts.length; i++) {
                unionKeys(
                    `${cts[0].spaceId}:${cts[0].polyId}`,
                    `${cts[i].spaceId}:${cts[i].polyId}`,
                );
            }
        }

        // ── Push circles as (center point + circle primitive); concentric
        //    groups share one center OID.
        const sharedCenter = new Map<string, OID>(); // union-root → center OID
        for (const [key, entry] of circles) {
            const shape = entry.poly.shape;
            if (!shape || shape.type !== "circle") continue;
            const root = find(key);
            let centerId = sharedCenter.get(root);
            if (centerId === undefined) {
                centerId = idAlloc.next();
                primitives.push({
                    type: "point",
                    id: String(centerId),
                    x: shape.center[0],
                    y: shape.center[1],
                    fixed: false,
                });
                sharedCenter.set(root, centerId);
            }
            const circleId = idAlloc.next();
            primitives.push({
                type: "circle",
                id: String(circleId),
                c_id: String(centerId),
                radius: shape.radius,
            });
            circleIds.set(key, { centerPoint: centerId, circle: circleId });
        }

        // ── Push arc / circle entities (= ArcRadius など SketchEntity 直接
        //    参照拘束用)。circles map とは別系統で、entity 単位で center +
        //    circle primitive を発行する。 ─────────────────────────────
        const arcEntityIds = new Map<string, { centerPoint: OID; circle: OID }>();
        for (const [key, entry] of arcEntities) {
            const cp = idAlloc.next();
            primitives.push({
                type: "point", id: String(cp),
                x: entry.center[0], y: entry.center[1], fixed: false,
            });
            const cId = idAlloc.next();
            primitives.push({
                type: "circle", id: String(cId),
                c_id: String(cp), radius: entry.radius,
            });
            arcEntityIds.set(key, { centerPoint: cp, circle: cId });
        }

        // ── Push wall axes as 2 points + 1 line ──
        // Owned walls (polygon.wallIds) use externally mitered coords with
        // fixed:true so the solver cannot break the thickness-offset invariant
        // against the inner polygon. Standalone walls stay unpinned.
        // Axis[0] / axis[1] go in as (x, z) since sketch is in the XZ plane.
        for (const [wid, entry] of walls) {
            const owner = wallOwnership.get(wid);
            let a: Vec3 = entry.wall.axis[0];
            let b: Vec3 = entry.wall.axis[1];
            let fixed = false;
            if (owner) {
                const axes = ensureAxes(owner.spaceId, owner.poly);
                if (axes && owner.edgeIdx < axes.length) {
                    a = axes[owner.edgeIdx][0];
                    b = axes[owner.edgeIdx][1];
                    fixed = true;
                    fixedWallIds.add(wid);
                }
            }
            const p1 = idAlloc.next();
            const p2 = idAlloc.next();
            const line = idAlloc.next();
            primitives.push({ type: "point", id: String(p1), x: a[0], y: a[2], fixed });
            primitives.push({ type: "point", id: String(p2), x: b[0], y: b[2], fixed });
            primitives.push({ type: "line", id: String(line), p1_id: String(p1), p2_id: String(p2) });
            wallIds.set(wid, { p1, p2, line });
        }

        // ── 拘束で参照される Column / GridPoint / Origin を GCS に push ──
        // Column basePoint は **自由 (= 拘束で動く)**。
        // GridPoint / Origin は **fixed** (= 動かない参照点)。
        // pointIdFor 経由で Length 等の点拘束に使う。
        const columnPointIds = new Map<string, OID>();
        const columnVertexPointIds = new Map<string, OID>();
        const gridPointIds = new Map<string, OID>();
        let originPointId: OID | null = null;
        for (const c of constraints) {
            for (const t of c.targets) {
                if (t.kind === "ColumnVertex") {
                    const col = state.elements[t.columnId as string] as ColumnElement | undefined;
                    if (!col || !col.basePoint) continue;
                    // Push vertex as fixed reference point (deduplicated)
                    const key = `${t.columnId}:${t.vertexIdx}`;
                    if (!columnVertexPointIds.has(key)) {
                        const fp = columnFootprint2D(col);
                        if (t.vertexIdx >= 0 && t.vertexIdx < fp.length) {
                            const v = fp[t.vertexIdx];
                            const pid = idAlloc.next();
                            primitives.push({ type: "point", id: String(pid), x: v[0], y: v[1], fixed: true });
                            columnVertexPointIds.set(key, pid);
                        }
                    }
                    // Push column center as free point — grid constraints remap to center with offset
                    if (!columnPointIds.has(t.columnId as string)) {
                        const cpid = idAlloc.next();
                        const isBeingDragged = state.draggingColumnId === (t.columnId as string);
                        primitives.push({
                            type: "point",
                            id: String(cpid),
                            x: col.basePoint[0],
                            y: col.basePoint[2],
                            fixed: isBeingDragged,
                        });
                        columnPointIds.set(t.columnId as string, cpid);
                    }
                    continue;
                }
                if (t.kind === "ColumnEdge") {
                    // Push column center as free point — collinear/parallel constraints remap to center
                    const col = state.elements[t.columnId as string] as ColumnElement | undefined;
                    if (!col || !col.basePoint) continue;
                    if (!columnPointIds.has(t.columnId as string)) {
                        const cpid = idAlloc.next();
                        const isBeingDragged = state.draggingColumnId === (t.columnId as string);
                        primitives.push({
                            type: "point",
                            id: String(cpid),
                            x: col.basePoint[0],
                            y: col.basePoint[2],
                            fixed: isBeingDragged,
                        });
                        columnPointIds.set(t.columnId as string, cpid);
                    }
                    continue;
                }
                if (t.kind === "Column") {
                    if (columnPointIds.has(t.columnId as string)) continue;
                    const col = state.elements[t.columnId as string] as ColumnElement | undefined;
                    if (!col || !col.basePoint) continue;
                    const pid = idAlloc.next();
                    const isBeingDragged = state.draggingColumnId === (t.columnId as string);
                    primitives.push({
                        type: "point",
                        id: String(pid),
                        x: col.basePoint[0],
                        y: col.basePoint[2],
                        fixed: isBeingDragged,
                    });
                    columnPointIds.set(t.columnId as string, pid);
                } else if (t.kind === "GridPoint") {
                    const key = `${t.gridId}:${t.vertexIdx}`;
                    if (gridPointIds.has(key)) continue;
                    const grid = state.grids.find((g) => g.id === t.gridId);
                    if (!grid) continue;
                    const verts = gridVertices(grid.curve);
                    if (t.vertexIdx < 0 || t.vertexIdx >= verts.length) continue;
                    const v = verts[t.vertexIdx];
                    const pid = idAlloc.next();
                    primitives.push({ type: "point", id: String(pid), x: v[0], y: v[2], fixed: true });
                    gridPointIds.set(key, pid);
                } else if (t.kind === "Origin") {
                    if (originPointId == null) {
                        originPointId = idAlloc.next();
                        primitives.push({ type: "point", id: String(originPointId), x: 0, y: 0, fixed: true });
                    }
                }
            }
        }

        // ドラッグ中の柱が拘束に含まれない場合、柱-柱の拘束系に固定アンカーが無く
        // 不定系になる → 他の拘束柱が漂流する。ドラッグ柱が拘束に無ければ skip。
        if (state.draggingColumnId != null && !columnPointIds.has(state.draggingColumnId)) {
            return;
        }

        // ── Translate and push user constraints ──
        // Outline polygons are derived + fixed. Only the legacy rect-wall
        // auto-added links (Parallel / PerpDistance between an outline and
        // its own inner) are skipped — they would fight the derived offset.
        // User-added constraints (Coincident, PointOnGrid, etc.) still
        // apply: because outline vertices go into the solver as fixed
        // primitives, they act as anchors that other polygons snap to.
        const isLegacyOutlineLink = (c: Constraint): boolean => {
            if (c.type !== "Parallel" && c.type !== "PerpDistance") return false;
            // 内壁 (= inner) と外壁 (= outline) を結ぶレガシー自動拘束は **両方の
            // ターゲットが部屋ポリゴン (SketchEdge / SketchPoint)** で作られる
            // (RoomEditPanel の outline 再構築で投入)。これらは固定 outline と
            // 競合するので skip する。一方、ユーザが外壁頂点 + 通芯 (Grid) や
            // 外壁頂点 + 壁軸 (WallAxis) で追加した PerpDistance は **少なくとも
            // 1 つが非ポリゴン target** になるので skip しない (= ユーザ意図を
            // 尊重して solver に流す)。
            const polyTargetCount = c.targets.filter(
                (t) => t.kind === "SketchEdge" || t.kind === "SketchPoint",
            ).length;
            if (polyTargetCount < 2) return false;
            return c.targets.some((t) => {
                const tt = t as any;
                if (t.kind !== "SketchEdge" && t.kind !== "SketchPoint") return false;
                return outlinePolyIds.has(tt.polyId);
            });
        };
        for (const c of constraints) {
            if (isLegacyOutlineLink(c)) continue;
            const gcsPrimitives = translateConstraint(
                c, polyIds, circleIds, wallIds, idAlloc, state.grids, state.elements as any,
                arcEntityIds, columnPointIds, gridPointIds, originPointId, columnVertexPointIds,
            );
            for (const p of gcsPrimitives) primitives.push(p);
        }

        wrapper.push_primitives_and_params(primitives);
        const status = wrapper.solve();

        // SolveStatus: 0=Success, 1=Converged, 2=Failed, 3=SuccessfulSolutionInvalid
        // Only write back when the solver produced a valid solution. On failure
        // we leave the polygons untouched — better than committing a corrupted
        // shape that would force the user to undo.
        if (status !== 0 && status !== 1) {
            // eslint-disable-next-line no-console
            console.warn(`[SketchSolver] solve status=${status} (failed) — skipping writeback`);
            return;
        }

        // ── DOF / 矛盾 / 冗長 拘束の警告 ─────────────────────────────
        // planegcs に問い合わせて over/under-constrained や矛盾している拘束を
        // 検出し、コンソールに通知する。これだけで暴走は止まらないが、
        // ユーザは「最後に追加した拘束のせいでおかしい」と気付ける。
        try {
            const dof = wrapper.gcs.dof();
            const hasConflicting = wrapper.has_gcs_conflicting_constraints();
            const hasRedundant = wrapper.has_gcs_redundant_constraints();
            if (hasConflicting || hasRedundant || dof < 0) {
                const conflicting = hasConflicting ? wrapper.get_gcs_conflicting_constraints() : [];
                const redundant = hasRedundant ? wrapper.get_gcs_redundant_constraints() : [];
                // eslint-disable-next-line no-console
                console.warn(
                    `[SketchSolver] constraint health: dof=${dof}` +
                    (conflicting.length ? ` conflicting=[${conflicting.join(",")}]` : "") +
                    (redundant.length ? ` redundant=[${redundant.join(",")}]` : ""),
                );
            }
        } catch (e) {
            // eslint-disable-next-line no-console
            console.warn("[SketchSolver] DOF/conflict query failed:", e);
        }

        wrapper.apply_solution();


        // ── Read back polygon outer vertices + circle shapes ──
        solvingDepth++;
        try {
            // Batch per-space updates so that multiple polygons / circles in the
            // same room don't clobber each other via stale-state overwrites.
            const CIRCLE_TESS = 256;
            const perSpaceUpdates = new Map<string, Map<string, Partial<RoomPolygon>>>();
            const dirty = (spaceId: string, polyId: string, patch: Partial<RoomPolygon>) => {
                let bucket = perSpaceUpdates.get(spaceId);
                if (!bucket) { bucket = new Map(); perSpaceUpdates.set(spaceId, bucket); }
                const cur = bucket.get(polyId) ?? {};
                bucket.set(polyId, { ...cur, ...patch });
            };

            // ヘルパ: 頂点列の AABB と最大絶対座標 (= 暴走検知用)。
            const aabbOf = (pts: Vec2[]): { w: number; h: number; absMax: number } => {
                let mnX = Infinity, mxX = -Infinity, mnY = Infinity, mxY = -Infinity;
                let absMax = 0;
                for (const p of pts) {
                    if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) {
                        return { w: Infinity, h: Infinity, absMax: Infinity };
                    }
                    if (p[0] < mnX) mnX = p[0]; if (p[0] > mxX) mxX = p[0];
                    if (p[1] < mnY) mnY = p[1]; if (p[1] > mxY) mxY = p[1];
                    const a = Math.max(Math.abs(p[0]), Math.abs(p[1]));
                    if (a > absMax) absMax = a;
                }
                return { w: mxX - mnX, h: mxY - mnY, absMax };
            };
            // 暴走判定の閾値:
            //   - NaN / Inf       → 即 reject
            //   - 元 polygon の幅・高さの 5 倍を超える膨張は reject
            //   - 全頂点の絶対座標が 1000m を超えるのは reject (= 室内寸法で
            //     ありえない位置)
            //   - 元の幅・高さが COLLAPSE_RATIO 倍未満まで縮退するのも reject
            //     (= 位置拘束が無いポリゴンに H/V/Parallel/Perp 等の方向系
            //     拘束だけが効いた状態で、ソルバが自由度を消費して縮退解
            //     [= 矩形が線分や点に潰れた形] に収束するのを防ぐ。
            //     例: 隣接していた部屋同士のリンクが解放された後、片方の部屋
            //     に方向拘束しか残らないケース)
            const RUNAWAY_RATIO = 5.0;
            const RUNAWAY_ABS_M = 1000;
            const COLLAPSE_RATIO = 0.05; // 5% 未満まで縮んだら縮退とみなす

            for (const [key, entry] of polys) {
                const ids = polyIds.get(key);
                if (!ids) continue;
                const solved: Vec2[] = ids.points.map((pid) => {
                    const prim = wrapper.sketch_index.get_primitive_or_fail(String(pid)) as any;
                    return [prim.x as number, prim.y as number];
                });
                let changed = solved.length !== entry.poly.outer.length;
                if (!changed) {
                    for (let i = 0; i < solved.length; i++) {
                        if (Math.abs(solved[i][0] - entry.poly.outer[i][0]) > 1e-6 ||
                            Math.abs(solved[i][1] - entry.poly.outer[i][1]) > 1e-6) {
                            changed = true;
                            break;
                        }
                    }
                }
                if (!changed) continue;
                // 暴走/縮退検知: 解が NaN/Inf を含む、元の AABB の RUNAWAY_RATIO
                // 倍を超える膨張、絶対座標が RUNAWAY_ABS_M を超える、または
                // 元の幅・高さの COLLAPSE_RATIO 倍未満まで縮んだ場合は
                // writeback を skip。元 polygon の幅と高さの両方が 0 に近い
                // (= 元から細長い線分等) なら collapse 判定をスキップする
                // (誤判定を避ける)。
                const oldAabb = aabbOf(entry.poly.outer);
                const newAabb = aabbOf(solved);
                const oldExtent = Math.max(oldAabb.w, oldAabb.h, 0.1);
                const newExtent = Math.max(newAabb.w, newAabb.h);
                const runaway =
                    !Number.isFinite(newExtent) ||
                    !Number.isFinite(newAabb.absMax) ||
                    newAabb.absMax > RUNAWAY_ABS_M ||
                    newExtent > oldExtent * RUNAWAY_RATIO;
                const SIG_DIM_M = 1e-3; // 1mm。これより薄いのは元から線分扱い
                const oldHasW = oldAabb.w > SIG_DIM_M;
                const oldHasH = oldAabb.h > SIG_DIM_M;
                const collapsedW = oldHasW && newAabb.w < oldAabb.w * COLLAPSE_RATIO;
                const collapsedH = oldHasH && newAabb.h < oldAabb.h * COLLAPSE_RATIO;
                const collapsed = collapsedW || collapsedH;
                if (runaway || collapsed) {
                    // eslint-disable-next-line no-console
                    console.warn(
                        `[SketchSolver] ${collapsed ? "collapsed" : "runaway"} ` +
                        `solution rejected for poly ${entry.poly.id.slice(0, 6)}: ` +
                        `oldAABB=${oldAabb.w.toFixed(2)}×${oldAabb.h.toFixed(2)} → ` +
                        `newAABB=${newAabb.w.toFixed(2)}×${newAabb.h.toFixed(2)} ` +
                        `absMax=${newAabb.absMax.toFixed(2)}m。` +
                        (collapsed
                            ? "位置拘束 (Distance/PerpDistance/Coincident 等) が無いと、方向系拘束だけでは ソルバが縮退解に収束することがあります。"
                            : "直近で追加した拘束が過剰 / 矛盾している可能性があります。"),
                    );
                    continue;
                }
                if (ROOM_SHAPE_DEBUG) {
                    // eslint-disable-next-line no-console
                    console.log(
                        `[room-debug] solver dirty space=${entry.spaceId.slice(0, 6)} poly=${entry.poly.id.slice(0, 6)} `
                        + `old=${entry.poly.outer.length}v${fmtRing(entry.poly.outer)} `
                        + `solved=${solved.length}v${fmtRing(solved)} `
                        + `oldAABB=${oldAabb.w.toFixed(3)}x${oldAabb.h.toFixed(3)} `
                        + `newAABB=${newAabb.w.toFixed(3)}x${newAabb.h.toFixed(3)}`,
                    );
                }
                dirty(entry.spaceId, entry.poly.id, { outer: solved });
            }

            // Sketch-circle 経由で動いた円は、polygon.shape を書き戻すだけでは
            // **対応する CircleEntity が陳腐化** する (= 中心マーカが古い位置に
            // 留まる / 次の setSpaceEntities 再派生で polygon が古い位置に snap
            // back するなどのドリフト原因)。spaceId 単位で circle entity の
            // center/radius も同期する。
            const circleEntitySyncBySpace = new Map<string, Map<string, { center: [number, number]; radius: number }>>();
            for (const [key, entry] of circles) {
                const ids = circleIds.get(key);
                const shape = entry.poly.shape;
                if (!ids || !shape || shape.type !== "circle") continue;
                const cp = wrapper.sketch_index.get_primitive_or_fail(String(ids.centerPoint)) as any;
                const circle = wrapper.sketch_index.get_primitive_or_fail(String(ids.circle)) as any;
                const cx = cp.x as number, cy = cp.y as number, r = circle.radius as number;
                const dCenter = Math.hypot(cx - shape.center[0], cy - shape.center[1]);
                const dRadius = Math.abs(r - shape.radius);
                if (dCenter < 1e-6 && dRadius < 1e-6) continue;
                const newOuter: Vec2[] = [];
                for (let i = 0; i < CIRCLE_TESS; i++) {
                    const a = (i / CIRCLE_TESS) * Math.PI * 2;
                    newOuter.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
                }
                dirty(entry.spaceId, entry.poly.id, {
                    outer: newOuter,
                    shape: { type: "circle", center: [cx, cy] as Vec2, radius: r },
                });
                // 対応する CircleEntity を polyId 逆引きで特定し、entity 同期。
                const sp = state.elements[entry.spaceId] as SpaceElement | undefined;
                const map = sp?.polyIdByEntity ?? {};
                let circleEntId: string | null = null;
                for (const eid in map) {
                    if (map[eid] === entry.poly.id) { circleEntId = eid; break; }
                }
                if (circleEntId) {
                    let bucket = circleEntitySyncBySpace.get(entry.spaceId);
                    if (!bucket) { bucket = new Map(); circleEntitySyncBySpace.set(entry.spaceId, bucket); }
                    bucket.set(circleEntId, { center: [cx, cy], radius: r });
                }
            }
            // Apply circle entity sync via setSpaceEntities (consistent path).
            // arcRederiveRequested を立てて、再派生後の polygon に対しても拘束が
            // 満たされているか再確認する (= constraints 経由で円が動かされた場合
            // に他の polygon と整合させるため)。
            for (const [spaceId, bucket] of circleEntitySyncBySpace) {
                if (bucket.size === 0) continue;
                arcRederiveRequested = true;
                useAppState.getState().setSpaceEntities(spaceId, (entities) => entities.map((e) => {
                    const patch = bucket.get(e.id);
                    if (!patch || e.kind !== "circle") return e;
                    return { ...e, center: patch.center, radius: patch.radius };
                }));
            }

            // ── Arc / Circle entity の半径・中心 writeback ─────────────
            // SketchEntity 直接参照拘束 (ArcRadius / ArcDiameter) で更新された
            // 値を、対応する SpaceElement.entities に書き戻す。
            //
            // Arc の場合: 半径を大きくしたら弧も大きく見える挙動を期待される
            // ので、center / aStart / aEnd は据え置きで radius だけ更新する。
            // すると chord 端点 (= recompute(aStart) / recompute(aEnd)) は半径
            // にスケールして移動する。これに合わせて **同じ space 内の隣接
            // polyline 端点** も新しい chord 端点位置へ移動させて連結を維持
            // する。Circle は chord が無いので solver の center / radius を
            // そのまま使う。
            interface ArcChordUpdate {
                spaceId: string;
                oldP0: [number, number];
                oldP1: [number, number];
                newP0: [number, number];
                newP1: [number, number];
            }
            const arcChordUpdates: ArcChordUpdate[] = [];
            const entityPatches = new Map<string, Map<string, Partial<{ center: [number, number]; radius: number; aStart: number; aEnd: number }>>>();
            for (const [key, entry] of arcEntities) {
                const ids = arcEntityIds.get(key);
                if (!ids) continue;
                const cp = wrapper.sketch_index.get_primitive_or_fail(String(ids.centerPoint)) as any;
                const circle = wrapper.sketch_index.get_primitive_or_fail(String(ids.circle)) as any;
                const cx = cp.x as number, cy = cp.y as number, r = circle.radius as number;
                const dCenter = Math.hypot(cx - entry.center[0], cy - entry.center[1]);
                const dRadius = Math.abs(r - entry.radius);
                if (dCenter < 1e-6 && dRadius < 1e-6) continue;

                let patch: Partial<{ center: [number, number]; radius: number; aStart: number; aEnd: number }>;
                if (entry.kind === "arc") {
                    const sp = state.elements[entry.spaceId] as SpaceElement | undefined;
                    const ent = sp?.entities?.find((e) => e.id === entry.entityId);
                    if (!ent || ent.kind !== "arc") continue;
                    const oldCx = entry.center[0], oldCy = entry.center[1];
                    const oldR = entry.radius;
                    const aS = ent.aStart, aE = ent.aEnd;
                    // OLD chord 端点 (= 既存 polyline 端点位置)。
                    const oldP0: [number, number] = [
                        oldCx + oldR * Math.cos(aS),
                        oldCy + oldR * Math.sin(aS),
                    ];
                    const oldP1: [number, number] = [
                        oldCx + oldR * Math.cos(aE),
                        oldCy + oldR * Math.sin(aE),
                    ];
                    // center は据え置き、radius だけ NEW へ。
                    // NEW chord 端点 (= 新しい弧の端点位置)。
                    const newP0: [number, number] = [
                        oldCx + r * Math.cos(aS),
                        oldCy + r * Math.sin(aS),
                    ];
                    const newP1: [number, number] = [
                        oldCx + r * Math.cos(aE),
                        oldCy + r * Math.sin(aE),
                    ];
                    patch = { radius: r };
                    arcChordUpdates.push({
                        spaceId: entry.spaceId,
                        oldP0, oldP1, newP0, newP1,
                    });
                } else {
                    patch = { center: [cx, cy], radius: r };
                }
                let bucket = entityPatches.get(entry.spaceId);
                if (!bucket) { bucket = new Map(); entityPatches.set(entry.spaceId, bucket); }
                bucket.set(entry.entityId, patch);
            }

            // arc 端点と一致する polyline / line 端点を NEW 位置へ追従させる。
            // CHAIN_ENDPOINT_EPS と同じ許容で一致判定。
            const SNAP_EPS = 1e-3;
            const movePoint = (p: [number, number], oldA: [number, number], newA: [number, number],
                               oldB: [number, number], newB: [number, number]): [number, number] | null => {
                if (Math.hypot(p[0] - oldA[0], p[1] - oldA[1]) < SNAP_EPS) return [newA[0], newA[1]];
                if (Math.hypot(p[0] - oldB[0], p[1] - oldB[1]) < SNAP_EPS) return [newB[0], newB[1]];
                return null;
            };

            // ArcRadius / ArcDiameter 由来で arc 半径/中心が変わると、隣接
            // polyline 端点が新 chord に追従して polygon が再派生する。これは
            // 外部拘束 (Horizontal 等) が破られる可能性があるので、再派生後に
            // もう一度 solveOnce を回して収束させる。
            if (entityPatches.size > 0) arcRederiveRequested = true;
            for (const [spaceId, patches] of entityPatches) {
                useAppState.getState().setSpaceEntities(spaceId, (entities) => {
                    return entities.map((e) => {
                        const p = patches.get(e.id);
                        let updated: any = e;
                        if (p) {
                            if (e.kind === "arc") {
                                updated = {
                                    ...e,
                                    ...(p.center !== undefined ? { center: p.center } : {}),
                                    ...(p.radius !== undefined ? { radius: p.radius } : {}),
                                    ...(p.aStart !== undefined ? { aStart: p.aStart } : {}),
                                    ...(p.aEnd !== undefined ? { aEnd: p.aEnd } : {}),
                                };
                            } else if (e.kind === "circle") {
                                updated = {
                                    ...e,
                                    ...(p.center !== undefined ? { center: p.center } : {}),
                                    ...(p.radius !== undefined ? { radius: p.radius } : {}),
                                };
                            }
                        }
                        // 隣接 polyline / line 端点を arc の新しい chord 位置に追従。
                        const updatesForSpace = arcChordUpdates.filter((u) => u.spaceId === spaceId);
                        for (const u of updatesForSpace) {
                            if (updated.kind === "polyline") {
                                let newPoints = updated.points;
                                let dirty = false;
                                const remap = (pt: [number, number]) =>
                                    movePoint(pt as any, u.oldP0, u.newP0, u.oldP1, u.newP1);
                                // 開ポリラインなら端点 (first / last) のみ、閉
                                // ポリラインなら全頂点を対象に snap 判定。
                                if (!updated.closed) {
                                    const first = remap(newPoints[0]);
                                    const last = remap(newPoints[newPoints.length - 1]);
                                    if (first || last) {
                                        newPoints = newPoints.slice();
                                        if (first) { newPoints[0] = first; dirty = true; }
                                        if (last)  { newPoints[newPoints.length - 1] = last; dirty = true; }
                                    }
                                } else {
                                    const next = newPoints.map((pt: [number, number]) => {
                                        const m = remap(pt);
                                        if (m) { dirty = true; return m; }
                                        return pt;
                                    });
                                    if (dirty) newPoints = next;
                                }
                                if (dirty) updated = { ...updated, points: newPoints };
                            } else if (updated.kind === "line") {
                                const np0 = movePoint(updated.p0, u.oldP0, u.newP0, u.oldP1, u.newP1);
                                const np1 = movePoint(updated.p1, u.oldP0, u.newP0, u.oldP1, u.newP1);
                                if (np0 || np1) {
                                    updated = {
                                        ...updated,
                                        ...(np0 ? { p0: np0 } : {}),
                                        ...(np1 ? { p1: np1 } : {}),
                                    };
                                }
                            }
                        }
                        return updated;
                    });
                });
            }

            // ── 全 polygon 用の解書き戻しパス (entity 経由) ────────────────
            // 設計原則: entity が真値、polygon は派生物。ソルバ解 (= polygon.outer
            // の各頂点位置) を **エンティティ側** に伝播 → 続く setSpaceEntities
            // で polygon を再派生する。フロー:
            //   ソルバ解 → entity 更新 → derive → JunctionSplit → wallRegen
            // 旧来は弧含む space だけ entity 経路、それ以外は polygon 直接書き戻し
            // にしていたが、後者が「entity と polygon が乖離する」唯一の経路だった
            // ため、全 space を entity 経路に統一する。
            for (const [spaceId, bucket] of perSpaceUpdates) {
                const latest = useAppState.getState().elements[spaceId] as SpaceElement | undefined;
                if (!latest) continue;

                type EntityPatch =
                    | { kind: "polyline"; points: Vec2[] }
                    | { kind: "line"; p0?: Vec2; p1?: Vec2 }
                    | { kind: "arc"; center?: Vec2; radius?: number; aStart?: number; aEnd?: number };
                const entityPatches = new Map<string, EntityPatch>();
                const ents = latest.entities ?? [];

                const findPolylinePoint = (pl: PolylineEntity, target: Vec2): number => {
                    let best = -1, bestD = 1e-3;
                    for (let i = 0; i < pl.points.length; i++) {
                        const d = Math.hypot(pl.points[i][0] - target[0], pl.points[i][1] - target[1]);
                        if (d < bestD) { bestD = d; best = i; }
                    }
                    return best;
                };
                const findLinePoint = (ln: LineEntity, target: Vec2): 0 | 1 | -1 => {
                    const d0 = Math.hypot(ln.p0[0] - target[0], ln.p0[1] - target[1]);
                    const d1 = Math.hypot(ln.p1[0] - target[0], ln.p1[1] - target[1]);
                    if (d0 < 1e-3 && d0 <= d1) return 0;
                    if (d1 < 1e-3) return 1;
                    return -1;
                };
                const ensurePolylinePatch = (pl: PolylineEntity): { kind: "polyline"; points: Vec2[] } => {
                    let p = entityPatches.get(pl.id) as { kind: "polyline"; points: Vec2[] } | undefined;
                    if (!p) {
                        p = { kind: "polyline", points: pl.points.map((q) => [q[0], q[1]] as Vec2) };
                        entityPatches.set(pl.id, p);
                    }
                    return p;
                };
                const ensureLinePatch = (ln: LineEntity): { kind: "line"; p0?: Vec2; p1?: Vec2 } => {
                    let p = entityPatches.get(ln.id) as { kind: "line"; p0?: Vec2; p1?: Vec2 } | undefined;
                    if (!p) { p = { kind: "line" }; entityPatches.set(ln.id, p); }
                    return p;
                };

                for (const [polyId, patch] of bucket) {
                    if (!patch.outer) continue;
                    const poly = latest.polygons.find((p) => p.id === polyId);
                    if (!poly?.edgeOwners) continue;
                    if (patch.outer.length !== poly.outer.length) continue;
                    const newOuter = patch.outer;
                    const polyEdgeList = polygonEdges(poly);

                    // Per-vertex propagation: 弧 interior は entity 更新せず、
                    // それ以外は対応する polyline / line の point を新位置で更新。
                    for (let vi = 0; vi < poly.outer.length; vi++) {
                        const newPos = newOuter[vi];
                        const oldPos = poly.outer[vi];
                        if (Math.hypot(newPos[0] - oldPos[0], newPos[1] - oldPos[1]) < 1e-9) continue;
                        const incEdges: number[] = [];
                        for (let ei = 0; ei < polyEdgeList.length; ei++) {
                            const [va, vb] = polyEdgeList[ei];
                            if (va === vi || vb === vi) incEdges.push(ei);
                        }
                        const incOwners = Array.from(new Set(
                            incEdges.map((ei) => poly.edgeOwners![ei]).filter(Boolean) as string[],
                        ));
                        let isArcInterior = false;
                        for (const ow of incOwners) {
                            const e = ents.find((x) => x.id === ow);
                            if (e && (e.kind === "arc" || e.kind === "circle")
                                && incOwners.length === 1) {
                                isArcInterior = true;
                                break;
                            }
                        }
                        if (isArcInterior) continue;
                        for (const ow of incOwners) {
                            const e = ents.find((x) => x.id === ow);
                            if (!e) continue;
                            if (e.kind === "polyline") {
                                const idx = findPolylinePoint(e, oldPos);
                                if (idx >= 0) {
                                    const p = ensurePolylinePatch(e);
                                    p.points[idx] = [newPos[0], newPos[1]];
                                }
                            } else if (e.kind === "line") {
                                const idx = findLinePoint(e, oldPos);
                                if (idx >= 0) {
                                    const p = ensureLinePatch(e);
                                    if (idx === 0) p.p0 = [newPos[0], newPos[1]];
                                    else p.p1 = [newPos[0], newPos[1]];
                                }
                            }
                        }
                    }

                    // 弧自体の center / radius / aStart / aEnd を新 chord 位置に
                    // 合わせて再計算 (strategy A: 旧 radius を保つ、収まらなけれ
                    // ば最小限の拡大。bulge 方向は旧 arc 側を継承)。
                    const arcOwners = Array.from(new Set(
                        (poly.edgeOwners ?? []).filter(Boolean) as string[],
                    )).filter((id) => {
                        const e = ents.find((x) => x.id === id);
                        return e && e.kind === "arc";
                    });
                    for (const arcId of arcOwners) {
                        const arc = ents.find((x) => x.id === arcId) as ArcEntity | undefined;
                        if (!arc) continue;
                        // この arc の chord 端点 (= polygon 上の vertex) を 2 つ取得。
                        const chordVerts: number[] = [];
                        const vertEdges = new Map<number, number[]>();
                        for (let ei = 0; ei < polyEdgeList.length; ei++) {
                            const [va, vb] = polyEdgeList[ei];
                            for (const v of [va, vb]) {
                                const arr = vertEdges.get(v) ?? [];
                                arr.push(ei);
                                vertEdges.set(v, arr);
                            }
                        }
                        for (const [vi, edges] of vertEdges) {
                            if (edges.length !== 2) continue;
                            const o0 = poly.edgeOwners![edges[0]];
                            const o1 = poly.edgeOwners![edges[1]];
                            const arcSide = (o0 === arcId) !== (o1 === arcId);
                            if (arcSide) chordVerts.push(vi);
                        }
                        if (chordVerts.length !== 2) continue;
                        // 旧 arc の chord 端点世界座標。どちらの polygon 頂点が
                        // aStart 側 / aEnd 側かを近接判定で対応付ける。
                        const oldStart: Vec2 = [
                            arc.center[0] + arc.radius * Math.cos(arc.aStart),
                            arc.center[1] + arc.radius * Math.sin(arc.aStart),
                        ];
                        const oldEnd: Vec2 = [
                            arc.center[0] + arc.radius * Math.cos(arc.aEnd),
                            arc.center[1] + arc.radius * Math.sin(arc.aEnd),
                        ];
                        const v0 = chordVerts[0], v1 = chordVerts[1];
                        const oldP0 = poly.outer[v0], oldP1 = poly.outer[v1];
                        const d0_oldStart = Math.hypot(oldP0[0] - oldStart[0], oldP0[1] - oldStart[1]);
                        const d0_oldEnd = Math.hypot(oldP0[0] - oldEnd[0], oldP0[1] - oldEnd[1]);
                        const startVi = d0_oldStart <= d0_oldEnd ? v0 : v1;
                        const endVi = startVi === v0 ? v1 : v0;
                        const newStart = newOuter[startVi];
                        const newEnd = newOuter[endVi];
                        // chord が動いていないなら更新不要。
                        const movedStart = Math.hypot(newStart[0] - oldStart[0], newStart[1] - oldStart[1]);
                        const movedEnd = Math.hypot(newEnd[0] - oldEnd[0], newEnd[1] - oldEnd[1]);
                        if (movedStart < 1e-9 && movedEnd < 1e-9) continue;
                        // strategy A: 旧 radius を保ち、新 chord に合わせて center を再計算。
                        const dx = newEnd[0] - newStart[0];
                        const dy = newEnd[1] - newStart[1];
                        const chordLen = Math.hypot(dx, dy);
                        if (chordLen < 1e-9) continue;
                        let R = arc.radius;
                        const half = chordLen / 2;
                        if (R < half) R = half; // chord 長が大きすぎる場合は最小限拡大
                        const Mx = (newStart[0] + newEnd[0]) / 2;
                        const My = (newStart[1] + newEnd[1]) / 2;
                        const ux = dx / chordLen, uy = dy / chordLen;
                        const nx = -uy, ny = ux;
                        // 旧 arc center の chord 法線方向の符号を保つ。
                        const oldDx = oldEnd[0] - oldStart[0];
                        const oldDy = oldEnd[1] - oldStart[1];
                        const oldChordLen = Math.hypot(oldDx, oldDy) || 1;
                        const oldNx = -oldDy / oldChordLen, oldNy = oldDx / oldChordLen;
                        const oldMx = (oldStart[0] + oldEnd[0]) / 2;
                        const oldMy = (oldStart[1] + oldEnd[1]) / 2;
                        const oldSide = (arc.center[0] - oldMx) * oldNx + (arc.center[1] - oldMy) * oldNy;
                        const sign = oldSide >= 0 ? 1 : -1;
                        const d = Math.sqrt(Math.max(0, R * R - half * half));
                        const newCx = Mx + sign * d * nx;
                        const newCy = My + sign * d * ny;
                        const newAStart = Math.atan2(newStart[1] - newCy, newStart[0] - newCx);
                        const newAEnd = Math.atan2(newEnd[1] - newCy, newEnd[0] - newCx);
                        entityPatches.set(arc.id, {
                            kind: "arc",
                            center: [newCx, newCy] as Vec2,
                            radius: R,
                            aStart: newAStart,
                            aEnd: newAEnd,
                        });
                    }
                }

                // Apply entity updates → setSpaceEntities が polygon を再派生する。
                // 再派生後は polygon outer が変わっているので、外部拘束 (= 矩形の
                // Horizontal 等) が再派生で破られていないかを確認するため、
                // ラッパループでもう一度 solveOnce を回す。`arcRederiveRequested`
                // を立てて pendingResolveRequested と合流させる。
                if (entityPatches.size > 0) {
                    arcRederiveRequested = true;
                    useAppState.getState().setSpaceEntities(spaceId, (entities) => entities.map((e) => {
                        const p = entityPatches.get(e.id);
                        if (!p) return e;
                        if (p.kind === "polyline" && e.kind === "polyline") {
                            return { ...e, points: p.points };
                        }
                        if (p.kind === "line" && e.kind === "line") {
                            return {
                                ...e,
                                ...(p.p0 ? { p0: p.p0 } : {}),
                                ...(p.p1 ? { p1: p.p1 } : {}),
                            };
                        }
                        if (p.kind === "arc" && e.kind === "arc") {
                            return {
                                ...e,
                                ...(p.center ? { center: p.center } : {}),
                                ...(p.radius !== undefined ? { radius: p.radius } : {}),
                                ...(p.aStart !== undefined ? { aStart: p.aStart } : {}),
                                ...(p.aEnd !== undefined ? { aEnd: p.aEnd } : {}),
                            };
                        }
                        return e;
                    }));
                    // 再派生後の polygon outer に既存壁の axis を追従させる。
                    // (非弧 space と同じ wall sync を行わないと、ソルバ前の axis
                    //  位置に壁が取り残されてしまう。)
                    const post = useAppState.getState().elements[spaceId] as SpaceElement | undefined;
                    if (post) {
                        for (const polyId of bucket.keys()) {
                            const updated = post.polygons.find((p) => p.id === polyId);
                            if (!updated || !updated.wallIds || updated.wallThickness == null) continue;
                            syncWallsToPolygonOuter(
                                updated.outer,
                                updated.wallIds,
                                updated.wallThickness,
                                (wallId, axis) => {
                                    const w = useAppState.getState().elements[wallId] as WallElement | undefined;
                                    if (!w || w.type !== "Wall") return;
                                    const next: [Vec3, Vec3] = [
                                        [axis[0][0], w.axis[0][1], axis[0][2]],
                                        [axis[1][0], w.axis[1][1], axis[1][2]],
                                    ];
                                    const drift =
                                        Math.abs(next[0][0] - w.axis[0][0]) + Math.abs(next[0][2] - w.axis[0][2]) +
                                        Math.abs(next[1][0] - w.axis[1][0]) + Math.abs(next[1][2] - w.axis[1][2]);
                                    if (drift < 1e-6) return;
                                    useAppState.getState().updateElement(wallId, {
                                        axis: next,
                                        dirtyFlags: new Set([...(w.dirtyFlags ?? []), "Geometry", "Mesh", "Render"]),
                                    } as any);
                                },
                            );
                        }
                    }
                }
            }

            // ── Outline polygon の再派生 ───────────────────────────────
            // entity を経由した setSpaceEntities ではアウトライン (= wallOutlineOf 付き)
            // は derive 対象外なので、内側 polygon が動いた space については
            // ここでアウトライン outer を再計算する。
            for (const [spaceId] of perSpaceUpdates) {
                const latest = useAppState.getState().elements[spaceId] as SpaceElement | undefined;
                if (!latest) continue;
                let touched = false;
                const newPolys = (latest.polygons ?? []).map((p) => {
                    if (!p.wallOutlineOf) return p;
                    const inner = (latest.polygons ?? []).find((q) => q.id === p.wallOutlineOf);
                    if (!inner || inner.wallThickness == null || inner.outer.length < 3) return p;
                    let cx = 0, cy = 0;
                    for (const v of inner.outer) { cx += v[0]; cy += v[1]; }
                    cx /= inner.outer.length; cy /= inner.outer.length;
                    const derived = computeMiteredCorners(inner.outer, [cx, cy], inner.wallThickness);
                    touched = true;
                    return { ...p, outer: derived };
                });
                if (touched) {
                    useAppState.getState().updateElement(spaceId, {
                        polygons: newPolys,
                        dirtyFlags: new Set([...latest.dirtyFlags, "Geometry", "Mesh", "Render"]),
                    } as any);
                }
            }

            // ── 壁 axis 同期 (= 再派生後の polygon outer に追従させる) ─────
            for (const [spaceId, bucket] of perSpaceUpdates) {
                const post = useAppState.getState().elements[spaceId] as SpaceElement | undefined;
                if (!post) continue;
                for (const polyId of bucket.keys()) {
                    const updated = (post.polygons ?? []).find((p) => p.id === polyId);
                    if (!updated || !updated.wallIds || updated.wallThickness == null) continue;
                    syncWallsToPolygonOuter(
                        updated.outer,
                        updated.wallIds,
                        updated.wallThickness,
                        (wallId, axis) => {
                            const w = useAppState.getState().elements[wallId] as WallElement | undefined;
                            if (!w || w.type !== "Wall") return;
                            const next: [Vec3, Vec3] = [
                                [axis[0][0], w.axis[0][1], axis[0][2]],
                                [axis[1][0], w.axis[1][1], axis[1][2]],
                            ];
                            const drift =
                                Math.abs(next[0][0] - w.axis[0][0]) + Math.abs(next[0][2] - w.axis[0][2]) +
                                Math.abs(next[1][0] - w.axis[1][0]) + Math.abs(next[1][2] - w.axis[1][2]);
                            if (drift < 1e-6) return;
                            useAppState.getState().updateElement(wallId, {
                                axis: next,
                                dirtyFlags: new Set([...(w.dirtyFlags ?? []), "Geometry", "Mesh", "Render"]),
                            } as any);
                        },
                    );
                }
            }

            // Column basePoint write-back: 自由 SketchPoint として登録した柱は
            // ソルバが動かす可能性があるので、解の x/y を読み戻して basePoint
            // を更新する。Y は元の値を維持。暴走検知 (= 大幅移動) は省略
            // (拘束は通常 m オーダーで距離指定するので暴走しにくい想定)。
            let anyColumnMoved = false;
            for (const [columnId, pid] of columnPointIds) {
                // ドラッグ中の柱は pointer move で位置を管理 — solver writeback は
                // スキップしないと solver の古いスナップショット値でドラッグが上書きされる。
                if (state.draggingColumnId === columnId) continue;
                const latest = useAppState.getState().elements[columnId] as ColumnElement | undefined;
                if (!latest || latest.type !== "Column") continue;
                const prim = wrapper.sketch_index.get_primitive_or_fail(String(pid)) as any;
                const newX = prim.x as number;
                const newZ = prim.y as number;
                if (!Number.isFinite(newX) || !Number.isFinite(newZ)) continue;
                const drift = Math.abs(newX - latest.basePoint[0]) + Math.abs(newZ - latest.basePoint[2]);
                if (drift < 1e-6) continue;
                useAppState.getState().updateElement(columnId, {
                    basePoint: [newX, latest.basePoint[1], newZ],
                    dirtyFlags: new Set([...(latest.dirtyFlags ?? []), "Geometry", "Mesh", "Render"]),
                } as any);
                anyColumnMoved = true;
            }

            // Wall-axis write-back — standalone walls only. Owned walls were
            // pushed as fixed and are re-synced from their polygon above.
            for (const [wid, ids] of wallIds) {
                if (fixedWallIds.has(wid)) continue;
                const latest = useAppState.getState().elements[wid] as WallElement | undefined;
                if (!latest || latest.type !== "Wall") continue;
                const p1 = wrapper.sketch_index.get_primitive_or_fail(String(ids.p1)) as any;
                const p2 = wrapper.sketch_index.get_primitive_or_fail(String(ids.p2)) as any;
                const ax: [number, number, number] = [p1.x as number, latest.axis[0][1], p1.y as number];
                const bx: [number, number, number] = [p2.x as number, latest.axis[1][1], p2.y as number];
                const dx0 = Math.abs(ax[0] - latest.axis[0][0]) + Math.abs(ax[2] - latest.axis[0][2]);
                const dx1 = Math.abs(bx[0] - latest.axis[1][0]) + Math.abs(bx[2] - latest.axis[1][2]);
                if (dx0 + dx1 < 1e-6) continue;
                useAppState.getState().updateElement(wid, {
                    axis: [ax, bx],
                    dirtyFlags: new Set([...(latest.dirtyFlags ?? []), "Geometry", "Mesh", "Render"]),
                } as any);
            }

            // 拘束追加で polygon outer が変わった場合、syncWallsToPolygonOuter
            // で wall.axis は更新されるが **wall.footprint (= JunctionGraph の
            // ミター済み fp)** は古いままで、レンダリング上 wall が古い位置に
            // 取り残される。影響を受けた polygon を seed にして wallRegenerate
            // をトリガし、ミター fp と柱クリップを再計算する。
            const seedPolyIds: string[] = [];
            for (const [, bucket] of perSpaceUpdates) {
                for (const polyId of bucket.keys()) seedPolyIds.push(polyId);
            }
            if (seedPolyIds.length > 0 || anyColumnMoved) {
                // 柱が動いた場合は seed 不要 (= 全部屋スコープで再計算)。
                triggerWallRegenIfEnabled(
                    "solver-writeback",
                    seedPolyIds.length > 0 ? seedPolyIds : undefined,
                );
            }
        } finally {
            solvingDepth--;
        }
    } finally {
        wrapper.destroy_gcs_module();
    }
}

// ----- constraint translation -----

function translateConstraint(
    c: Constraint,
    polyIds: Map<string, PolyIds>,
    circleIds: Map<string, CircleIds>,
    wallIds: Map<string, WallAxisIds>,
    idAlloc: IdAllocator,
    grids: GridLine[],
    elements: Record<string, any>,
    arcEntityIds?: Map<string, { centerPoint: OID; circle: OID }>,
    columnPointIds?: Map<string, OID>,
    gridPointIds?: Map<string, OID>,
    originPointId?: OID | null,
    columnVertexPointIds?: Map<string, OID>,
): any[] {
    const out: any[] = [];

    // 外壁 outline polygon → 対応する inner polygon の id 解決ヘルパ。
    // Outline は派生形状で solver 内で fixed: true として push されるため、
    // ユーザが outline の頂点 / 辺をピックして拘束を付けても、その固定点は
    // 動かせず制約が満たせない (= 矩形が暴れる)。inner にリダイレクトすれば
    // solver が拘束対象として動かせるようになる。inner 側は wallSync を介して
    // outline を再生成するので、結果として outline も同期して動く。
    const innerPolyIdForOutline = (
        spaceId: string, polyId: string,
    ): string | null => {
        const sp = elements[spaceId];
        if (!sp || sp.type !== "Space" || !sp.polygons) return null;
        const poly = sp.polygons.find((p: RoomPolygon) => p.id === polyId);
        if (!poly || !poly.wallOutlineOf) return null;
        return poly.wallOutlineOf as string;
    };
    const redirectSketchPolyId = (
        spaceId: string, polyId: string, vertexIdx: number,
    ): { polyId: string; vertexIdx: number } => {
        const innerId = innerPolyIdForOutline(spaceId, polyId);
        if (!innerId) return { polyId, vertexIdx };
        // outline と inner は (現状) 同じ vertex 数で順序対応するので index は
        // そのまま流用できる。万が一サイズが違う時は安全側で元の index を返す。
        const sp = elements[spaceId];
        const inner = sp?.polygons?.find((p: RoomPolygon) => p.id === innerId);
        if (!inner) return { polyId, vertexIdx };
        if (vertexIdx < 0 || vertexIdx >= inner.outer.length) {
            return { polyId, vertexIdx };
        }
        return { polyId: innerId, vertexIdx };
    };

    const pointIdFor = (t: ConstraintTarget): number | null => {
        if (t.kind === "SketchPoint") {
            const r = redirectSketchPolyId(t.spaceId as string, t.polyId, t.vertexIdx);
            const ids = polyIds.get(`${t.spaceId}:${r.polyId}`);
            if (!ids) return null;
            if (r.vertexIdx < 0 || r.vertexIdx >= ids.points.length) return null;
            return ids.points[r.vertexIdx];
        }
        if (t.kind === "WallAxisPoint") {
            const ids = wallIds.get(t.wallId as string);
            if (!ids) return null;
            return t.endIdx === 0 ? ids.p1 : ids.p2;
        }
        if (t.kind === "Column") {
            return columnPointIds?.get(t.columnId as string) ?? null;
        }
        if (t.kind === "ColumnVertex") {
            return columnVertexPointIds?.get(`${t.columnId}:${t.vertexIdx}`) ?? null;
        }
        if (t.kind === "GridPoint") {
            return gridPointIds?.get(`${t.gridId}:${t.vertexIdx}`) ?? null;
        }
        if (t.kind === "Origin") {
            return originPointId ?? null;
        }
        return null;
    };
    /** SketchEntity (Arc / Circle entity 直接参照) → solver circle ids。 */
    const entityCircleFor = (t: ConstraintTarget): { centerPoint: OID; circle: OID } | null => {
        if (t.kind !== "SketchEntity") return null;
        return arcEntityIds?.get(`${t.spaceId}:${t.entityId}`) ?? null;
    };
    // SketchEdge and WallAxis both collapse to the same (line, p1, p2) bundle
    // since wall axes are pushed as a 2-vertex line primitive in solveOnce.
    // Grid は通芯線 (= 動かない参照線) として fixed 点 2 個 + line を即席で
    // push し、その ids を返す。Parallel / Perpendicular / Length 等の
    // edge 系拘束を通芯にもかけられるようにするため。
    const edgeIdsFor = (t: ConstraintTarget): { line: number; p1: number; p2: number } | null => {
        if (t.kind === "SketchEdge") {
            // outline edge → inner edge へリダイレクト (= pointIdFor と同じ理由)。
            const innerId = innerPolyIdForOutline(t.spaceId as string, t.polyId);
            const polyKey = innerId ? `${t.spaceId}:${innerId}` : `${t.spaceId}:${t.polyId}`;
            const ids = polyIds.get(polyKey);
            if (!ids) return null;
            if (t.edgeIdx < 0 || t.edgeIdx >= ids.lines.length) return null;
            const [va, vb] = ids.edgeVerts[t.edgeIdx];
            return {
                line: ids.lines[t.edgeIdx],
                p1: ids.points[va],
                p2: ids.points[vb],
            };
        }
        if (t.kind === "WallAxis") {
            const ids = wallIds.get(t.wallId as string);
            if (!ids) return null;
            return { line: ids.line, p1: ids.p1, p2: ids.p2 };
        }
        if (t.kind === "Grid") {
            const grid = grids.find((g) => g.id === t.gridId);
            const verts = grid ? gridVertices(grid.curve) : [];
            if (verts.length < 2) return null;
            const a = verts[0];
            const b = verts[verts.length - 1];
            const aId = idAlloc.next();
            const bId = idAlloc.next();
            const lineId = idAlloc.next();
            out.push({ type: "point", id: String(aId), x: a[0], y: a[2], fixed: true });
            out.push({ type: "point", id: String(bId), x: b[0], y: b[2], fixed: true });
            out.push({ type: "line",  id: String(lineId), p1_id: String(aId), p2_id: String(bId) });
            return { line: lineId, p1: aId, p2: bId };
        }
        if (t.kind === "ColumnEdge") {
            const col = elements[t.columnId as string] as ColumnElement | undefined;
            if (!col || !col.basePoint) return null;
            const fp = columnFootprint2D(col);
            const n = fp.length;
            if (n < 2 || t.edgeIdx < 0 || t.edgeIdx >= n) return null;
            const a = fp[t.edgeIdx];
            const b = fp[(t.edgeIdx + 1) % n];
            const aId = idAlloc.next();
            const bId = idAlloc.next();
            const lineId = idAlloc.next();
            out.push({ type: "point", id: String(aId), x: a[0], y: a[1], fixed: true });
            out.push({ type: "point", id: String(bId), x: b[0], y: b[1], fixed: true });
            out.push({ type: "line",  id: String(lineId), p1_id: String(aId), p2_id: String(bId) });
            return { line: lineId, p1: aId, p2: bId };
        }
        return null;
    };
    const circleIdFor = (t: ConstraintTarget): CircleIds | null => {
        if (t.kind !== "SketchCircle") return null;
        return circleIds.get(`${t.spaceId}:${t.polyId}`) ?? null;
    };

    switch (c.type) {
        case "Horizontal": {
            const edge = c.targets[0];
            const ids = edgeIdsFor(edge);
            if (!ids) return out;
            out.push({ type: "horizontal_pp", id: String(idAlloc.next()), p1_id: String(ids.p1), p2_id: String(ids.p2) });
            break;
        }
        case "Vertical": {
            const edge = c.targets[0];
            const ids = edgeIdsFor(edge);
            if (!ids) return out;
            out.push({ type: "vertical_pp", id: String(idAlloc.next()), p1_id: String(ids.p1), p2_id: String(ids.p2) });
            break;
        }
        case "Length": {
            if (c.value === undefined) return out;
            // パターン1: 単一 edge の長さ拘束 (SketchEdge / WallAxis / ColumnEdge)。
            // targets.length === 1 の時だけ適用。Grid や Column が混在する
            // 多目的 Length (パターン3/4) はここで break させない。
            const edge = c.targets[0];
            const eIds = c.targets.length === 1 ? edgeIdsFor(edge) : null;
            if (eIds) {
                out.push({
                    type: "p2p_distance",
                    id: String(idAlloc.next()),
                    p1_id: String(eIds.p1),
                    p2_id: String(eIds.p2),
                    distance: c.value,
                });
                break;
            }
            // パターン3: 通芯 + 点 → 通芯線への垂直距離 (= PerpDistance 相当)。
            // 軸平行通芯は coordinate_x / coordinate_y で点座標を直接固定し、
            // 斜め通芯は p2l_distance フォールバック。
            // ColumnVertex の場合は column center へリマップし、オフセット分を調整する。
            const gridTargets = c.targets.filter((t) => t.kind === "Grid");
            const pointKindsSet = new Set([
                "SketchPoint", "WallAxisPoint", "Column", "ColumnVertex", "GridPoint", "Origin",
            ]);
            const pointTargets = c.targets.filter((t) => pointKindsSet.has(t.kind));
            if (gridTargets.length === 1 && pointTargets.length === 1) {
                const ln = gridTargets[0];
                const pt = pointTargets[0];
                // ColumnVertex → column center にリマップし、頂点オフセットを計算
                let pid3: number | null;
                let vOffX = 0, vOffZ = 0;
                if (pt.kind === "ColumnVertex") {
                    const col3 = elements[(pt as any).columnId as string] as ColumnElement | undefined;
                    if (!col3 || !col3.basePoint) break;
                    pid3 = columnPointIds?.get((pt as any).columnId as string) ?? null;
                    if (pid3 != null) {
                        const fp3 = columnFootprint2D(col3);
                        const vi3 = (pt as any).vertexIdx as number;
                        if (vi3 >= 0 && vi3 < fp3.length) {
                            vOffX = fp3[vi3][0] - col3.basePoint[0];
                            vOffZ = fp3[vi3][1] - col3.basePoint[2];
                        }
                    }
                } else {
                    pid3 = pointIdFor(pt);
                }
                if (pid3 == null) break;
                if (ln.kind !== "Grid") break;
                const grid = grids.find((g) => g.id === ln.gridId);
                const verts = grid ? gridVertices(grid.curve) : [];
                if (verts.length < 2) break;
                const a = verts[0];
                const b = verts[verts.length - 1];
                const ex = b[0] - a[0];
                const ez = b[2] - a[2];
                const lineLen = Math.hypot(ex, ez);
                const axisRel = lineLen > 1e-9 ? 1e-3 : 0;
                const isVertical = Math.abs(ex) <= axisRel * lineLen;
                const isHorizontal = Math.abs(ez) <= axisRel * lineLen;
                // 点側の現ワールド座標 (= 線の左右どちら側にいるか判定用)。
                const pwOf = (target: ConstraintTarget): [number, number] | null => {
                    if (target.kind === "SketchPoint") {
                        const sp = elements[target.spaceId as string];
                        if (!sp || sp.type !== "Space") return null;
                        const r = redirectSketchPolyId(
                            target.spaceId as string, target.polyId, target.vertexIdx,
                        );
                        const poly = (sp.polygons ?? []).find((p: RoomPolygon) => p.id === r.polyId);
                        const v = poly?.outer?.[r.vertexIdx];
                        return v ? [v[0], v[1]] : null;
                    }
                    if (target.kind === "WallAxisPoint") {
                        const w = elements[target.wallId as string] as WallElement | undefined;
                        if (!w || w.type !== "Wall") return null;
                        const av = w.axis[target.endIdx];
                        return [av[0], av[2]];
                    }
                    if (target.kind === "Column") {
                        const col = elements[target.columnId as string] as ColumnElement | undefined;
                        if (!col || !col.basePoint) return null;
                        return [col.basePoint[0], col.basePoint[2]];
                    }
                    if (target.kind === "ColumnVertex") {
                        const col = elements[target.columnId as string] as ColumnElement | undefined;
                        if (!col || !col.basePoint) return null;
                        const fp = columnFootprint2D(col);
                        if (target.vertexIdx < 0 || target.vertexIdx >= fp.length) return null;
                        return [fp[target.vertexIdx][0], fp[target.vertexIdx][1]];
                    }
                    if (target.kind === "GridPoint") {
                        const g = grids.find((gg) => gg.id === target.gridId);
                        if (!g) return null;
                        const gv = gridVertices(g.curve);
                        const v = gv[target.vertexIdx];
                        return v ? [v[0], v[2]] : null;
                    }
                    if (target.kind === "Origin") return [0, 0];
                    return null;
                };
                const pw = pwOf(pt);
                if (isVertical && pw) {
                    const G = a[0];
                    const sign = pw[0] >= G ? +1 : -1;
                    out.push({
                        type: "coordinate_x",
                        id: String(idAlloc.next()),
                        p_id: String(pid3),
                        x: G + sign * c.value - vOffX,
                    });
                    break;
                }
                if (isHorizontal && pw) {
                    const G = a[2];
                    const sign = pw[1] >= G ? +1 : -1;
                    out.push({
                        type: "coordinate_y",
                        id: String(idAlloc.next()),
                        p_id: String(pid3),
                        y: G + sign * c.value - vOffZ,
                    });
                    break;
                }
                // 斜め通芯: 線端点を fixed として push、p2l_distance で
                // 距離を拘束 (符号無し)。点の現在側で a↔b 向きを反転する。
                let aa = a, bb = b;
                if (pw) {
                    const dx = pw[0] - a[0], dz = pw[1] - a[2];
                    const signed = dx * ez - dz * ex;
                    if (signed < 0) { aa = b; bb = a; }
                }
                const ga = idAlloc.next();
                const gb = idAlloc.next();
                const gl = idAlloc.next();
                // ColumnVertex の場合は通芯線をオフセット分シフト
                out.push({ type: "point", id: String(ga), x: aa[0] - vOffX, y: aa[2] - vOffZ, fixed: true });
                out.push({ type: "point", id: String(gb), x: bb[0] - vOffX, y: bb[2] - vOffZ, fixed: true });
                out.push({ type: "line",  id: String(gl), p1_id: String(ga), p2_id: String(gb) });
                out.push({
                    type: "p2l_distance",
                    id: String(idAlloc.next()),
                    p_id: String(pid3),
                    l_id: String(gl),
                    distance: c.value,
                });
                break;
            }
            // パターン4: 通芯 + 通芯 → 1 本目の線に対する 2 本目の端点の距離。
            // 両通芯は固定値で push されるので、平行な場合は距離が「正しいか」を
            // 検証する制約として機能する (= 通芯位置を solver で動かさない構造)。
            // 通芯位置を実際に動かしたい場合は別途 grid 編集 UI で調整する想定。
            if (gridTargets.length === 2) {
                const gA = gridTargets[0];
                const gB = gridTargets[1];
                if (gA.kind !== "Grid" || gB.kind !== "Grid") break;
                const gridA = grids.find((g) => g.id === gA.gridId);
                const gridB = grids.find((g) => g.id === gB.gridId);
                const vA = gridA ? gridVertices(gridA.curve) : [];
                const vB = gridB ? gridVertices(gridB.curve) : [];
                if (vA.length < 2 || vB.length < 2) break;
                // Grid A を線として push。
                const a = vA[0];
                const b = vA[vA.length - 1];
                const aaId = idAlloc.next();
                const abId = idAlloc.next();
                const aLineId = idAlloc.next();
                out.push({ type: "point", id: String(aaId), x: a[0], y: a[2], fixed: true });
                out.push({ type: "point", id: String(abId), x: b[0], y: b[2], fixed: true });
                out.push({ type: "line",  id: String(aLineId), p1_id: String(aaId), p2_id: String(abId) });
                // Grid B の端点を fixed 点として push。p2l_distance で距離を拘束。
                const bv = vB[0];
                const bId = idAlloc.next();
                out.push({ type: "point", id: String(bId), x: bv[0], y: bv[2], fixed: true });
                out.push({
                    type: "p2l_distance",
                    id: String(idAlloc.next()),
                    p_id: String(bId),
                    l_id: String(aLineId),
                    distance: c.value,
                });
                break;
            }
            // パターン2: targets[0]/[1] が点ライク (SketchPoint / WallAxisPoint /
            // Column / GridPoint / Origin) → 2 点間距離。
            if (c.targets.length >= 2) {
                const p1 = pointIdFor(c.targets[0]);
                const p2 = pointIdFor(c.targets[1]);
                if (p1 != null && p2 != null) {
                    out.push({
                        type: "p2p_distance",
                        id: String(idAlloc.next()),
                        p1_id: String(p1),
                        p2_id: String(p2),
                        distance: c.value,
                    });
                }
            }
            break;
        }
        case "Parallel": {
            if (c.targets.length < 2) return out;
            const a = edgeIdsFor(c.targets[0]);
            const b = edgeIdsFor(c.targets[1]);
            if (!a || !b) return out;
            out.push({ type: "parallel", id: String(idAlloc.next()), l1_id: String(a.line), l2_id: String(b.line) });
            break;
        }
        case "Perpendicular": {
            if (c.targets.length < 2) return out;
            const a = edgeIdsFor(c.targets[0]);
            const b = edgeIdsFor(c.targets[1]);
            if (!a || !b) return out;
            out.push({ type: "perpendicular_ll", id: String(idAlloc.next()), l1_id: String(a.line), l2_id: String(b.line) });
            break;
        }
        case "Angle": {
            if (c.targets.length < 2 || c.value === undefined) return out;
            const a = edgeIdsFor(c.targets[0]);
            const b = edgeIdsFor(c.targets[1]);
            if (!a || !b) return out;
            // l2l_angle_pppp passes the 4 endpoint param addrs directly — more
            // reliable than l2l_angle_ll in some planegcs builds. Angle is in
            // radians, signed CCW from line 1 to line 2.
            out.push({
                type: "l2l_angle_pppp",
                id: String(idAlloc.next()),
                l1p1_id: String(a.p1),
                l1p2_id: String(a.p2),
                l2p1_id: String(b.p1),
                l2p2_id: String(b.p2),
                angle: c.value,
            });
            break;
        }
        case "Collinear": {
            // Two edges share the same infinite line. Expressed as: both
            // endpoints of edge B lie on edge A's line.
            if (c.targets.length < 2) return out;

            // Special case: Grid + ColumnEdge — remap to column center constrained
            // to grid lines shifted by -vertex_offset (so vertex lands on original grid).
            const gridTgtC = c.targets.find((t) => t.kind === "Grid");
            const colEdgeTgt = c.targets.find((t) => t.kind === "ColumnEdge");
            if (gridTgtC && colEdgeTgt && gridTgtC.kind === "Grid" && colEdgeTgt.kind === "ColumnEdge") {
                const col = elements[colEdgeTgt.columnId as string] as ColumnElement | undefined;
                if (!col || !col.basePoint) return out;
                const centerId = columnPointIds?.get(colEdgeTgt.columnId as string);
                if (centerId == null) return out;
                const fp = columnFootprint2D(col);
                const n = fp.length;
                if (n < 2 || colEdgeTgt.edgeIdx < 0 || colEdgeTgt.edgeIdx >= n) return out;
                const grid = grids.find((g) => g.id === gridTgtC.gridId);
                const gverts = grid ? gridVertices(grid.curve) : [];
                if (gverts.length < 2) return out;
                const ga = gverts[0], gb = gverts[gverts.length - 1];
                // Push point_on_line_pl for each of the two edge endpoint offsets.
                // The grid line is shifted by -offset so that column center on the
                // shifted line is equivalent to the edge endpoint on the original line.
                for (const vi of [colEdgeTgt.edgeIdx, (colEdgeTgt.edgeIdx + 1) % n]) {
                    const ox = fp[vi][0] - col.basePoint[0];
                    const oz = fp[vi][1] - col.basePoint[2];
                    const pa = idAlloc.next();
                    const pb = idAlloc.next();
                    const pl = idAlloc.next();
                    out.push({ type: "point", id: String(pa), x: ga[0] - ox, y: ga[2] - oz, fixed: true });
                    out.push({ type: "point", id: String(pb), x: gb[0] - ox, y: gb[2] - oz, fixed: true });
                    out.push({ type: "line",  id: String(pl), p1_id: String(pa), p2_id: String(pb) });
                    out.push({ type: "point_on_line_pl", id: String(idAlloc.next()), p_id: String(centerId), l_id: String(pl) });
                }
                break;
            }

            const a = edgeIdsFor(c.targets[0]);
            const b = edgeIdsFor(c.targets[1]);
            if (!a || !b) return out;
            out.push({
                type: "point_on_line_pl",
                id: String(idAlloc.next()),
                p_id: String(b.p1),
                l_id: String(a.line),
            });
            out.push({
                type: "point_on_line_pl",
                id: String(idAlloc.next()),
                p_id: String(b.p2),
                l_id: String(a.line),
            });
            break;
        }
        case "PerpDistance": {
            // Perpendicular distance from a point to a line (= edge / wall axis /
            // 通芯線 / 柱辺)。点側は SketchPoint / WallAxisPoint / Column / ColumnVertex /
            // GridPoint / Origin、線側は SketchEdge / WallAxis / Grid / ColumnEdge を受け付ける。
            // ColumnVertex の場合は column center (free point) へリマップし、
            // 距離値をオフセット分だけ調整する。
            if (c.targets.length < 2 || c.value === undefined) return out;
            const pointKinds = new Set([
                "SketchPoint", "WallAxisPoint", "Column", "ColumnVertex", "GridPoint", "Origin",
            ]);
            const lineKinds = new Set(["SketchEdge", "WallAxis", "Grid", "ColumnEdge"]);
            const pt = c.targets.find((t) => pointKinds.has(t.kind));
            const ln = c.targets.find((t) => lineKinds.has(t.kind));
            // 点側の現ワールド座標 (xz 平面) — 線の向き決定に使う。
            const pointWorldXZ = (
                target: ConstraintTarget,
            ): [number, number] | null => {
                if (target.kind === "SketchPoint") {
                    const sp = elements[target.spaceId as string];
                    if (!sp || sp.type !== "Space") return null;
                    const r = redirectSketchPolyId(
                        target.spaceId as string, target.polyId, target.vertexIdx,
                    );
                    const poly = (sp.polygons ?? []).find((p: RoomPolygon) => p.id === r.polyId);
                    const v = poly?.outer?.[r.vertexIdx];
                    return v ? [v[0], v[1]] : null;
                }
                if (target.kind === "WallAxisPoint") {
                    const w = elements[target.wallId as string] as WallElement | undefined;
                    if (!w || w.type !== "Wall") return null;
                    const a = w.axis[target.endIdx];
                    return [a[0], a[2]];
                }
                if (target.kind === "Column") {
                    const col = elements[target.columnId as string] as ColumnElement | undefined;
                    if (!col || !col.basePoint) return null;
                    return [col.basePoint[0], col.basePoint[2]];
                }
                if (target.kind === "ColumnVertex") {
                    const col = elements[target.columnId as string] as ColumnElement | undefined;
                    if (!col || !col.basePoint) return null;
                    const fp = columnFootprint2D(col);
                    if (target.vertexIdx < 0 || target.vertexIdx >= fp.length) return null;
                    return [fp[target.vertexIdx][0], fp[target.vertexIdx][1]];
                }
                if (target.kind === "GridPoint") {
                    const g = grids.find((gg) => gg.id === target.gridId);
                    if (!g) return null;
                    const verts = gridVertices(g.curve);
                    const v = verts[target.vertexIdx];
                    return v ? [v[0], v[2]] : null;
                }
                if (target.kind === "Origin") return [0, 0];
                return null;
            };
            if (!pt || !ln) return out;
            // ColumnVertex → column center にリマップし、頂点オフセットを計算
            let pid: number | null;
            let vertexOffsetX = 0, vertexOffsetZ = 0;
            if (pt.kind === "ColumnVertex") {
                const col = elements[(pt as any).columnId as string] as ColumnElement | undefined;
                if (!col || !col.basePoint) return out;
                pid = columnPointIds?.get((pt as any).columnId as string) ?? null;
                if (pid != null) {
                    const fp = columnFootprint2D(col);
                    const vi = (pt as any).vertexIdx as number;
                    if (vi >= 0 && vi < fp.length) {
                        vertexOffsetX = fp[vi][0] - col.basePoint[0];
                        vertexOffsetZ = fp[vi][1] - col.basePoint[2];
                    }
                }
            } else {
                pid = pointIdFor(pt);
            }
            if (pid == null) return out;
            // 線 ID の解決:
            //   SketchEdge / WallAxis / ColumnEdge → 既存 edgeIdsFor (.line) を使う
            //   Grid                               → grid.start/end を fixed point として push
            //                                        + line を即席で作る
            let lineId: number | null = null;
            if (ln.kind === "SketchEdge" || ln.kind === "WallAxis" || ln.kind === "ColumnEdge") {
                const eids = edgeIdsFor(ln);
                lineId = eids?.line ?? null;
            } else if (ln.kind === "Grid") {
                const grid = grids.find((g) => g.id === ln.gridId);
                const verts = grid ? gridVertices(grid.curve) : [];
                if (verts.length >= 2) {
                    const a = verts[0];
                    const b = verts[verts.length - 1];
                    const ex = b[0] - a[0];
                    const ez = b[2] - a[2];
                    // 軸平行判定は **相対** トレランスで行う。マウス作図は浮動小数で
                    // 微小な傾きが入るので 1e-6 m の絶対判定は厳しすぎ、ほぼ水平な
                    // 通芯が「斜め」扱いされて p2l_distance フォールバックに落ちる。
                    // 相対比 0.1% 未満なら axis-aligned と見なす。
                    const lineLen = Math.hypot(ex, ez);
                    const axisRel = lineLen > 1e-9 ? 1e-3 : 0;
                    const isVertical = Math.abs(ex) <= axisRel * lineLen;     // 縦線 (= X 一定)
                    const isHorizontal = Math.abs(ez) <= axisRel * lineLen;   // 横線 (= Z 一定)
                    const pw = pointWorldXZ(pt);
                    // 軸平行な通芯では p2l_distance (= 符号無し) の左右両解曖昧性
                    // を避けるため、coordinate_x / coordinate_y で点座標を直接
                    // 固定する。値の符号は点の現在側に合わせて決める (= 線越しに
                    // 反転しないので矩形が潰れない)。
                    // ColumnVertex の場合は vertexOffset でシフト済みの座標を使う。
                    if (isVertical && pw) {
                        // 縦の通芯: 点の x を G ± D に固定
                        const G = a[0];
                        const sign = pw[0] >= G ? +1 : -1;
                        out.push({
                            type: "coordinate_x",
                            id: String(idAlloc.next()),
                            p_id: String(pid),
                            x: G + sign * c.value - vertexOffsetX,
                        });
                        break;
                    }
                    if (isHorizontal && pw) {
                        // 横の通芯: 点の z (GCS の y) を G ± D に固定
                        const G = a[2];
                        const sign = pw[1] >= G ? +1 : -1;
                        out.push({
                            type: "coordinate_y",
                            id: String(idAlloc.next()),
                            p_id: String(pid),
                            y: G + sign * c.value - vertexOffsetZ,
                        });
                        break;
                    }
                    // 斜め通芯: p2l_distance フォールバック (= 符号無し距離)。
                    // ColumnVertex の場合は通芯線をオフセット分シフトして使う。
                    let aa = a, bb = b;
                    if (pw) {
                        const dx = pw[0] - a[0], dz = pw[1] - a[2];
                        // 符号付き距離分子: dx*ez - dz*ex
                        const signed = dx * ez - dz * ex;
                        if (signed < 0) { aa = b; bb = a; }
                    }
                    const ga = idAlloc.next();
                    const gb = idAlloc.next();
                    const gl = idAlloc.next();
                    // ColumnVertex の場合は通芯線をオフセット分シフト
                    out.push({ type: "point", id: String(ga), x: aa[0] - vertexOffsetX, y: aa[2] - vertexOffsetZ, fixed: true });
                    out.push({ type: "point", id: String(gb), x: bb[0] - vertexOffsetX, y: bb[2] - vertexOffsetZ, fixed: true });
                    out.push({ type: "line",  id: String(gl), p1_id: String(ga), p2_id: String(gb) });
                    lineId = gl;
                }
            }
            if (lineId == null) return out;
            out.push({
                type: "p2l_distance",
                id: String(idAlloc.next()),
                p_id: String(pid),
                l_id: String(lineId),
                distance: c.value,
            });
            break;
        }
        case "EqualLength": {
            // All selected edges have the same length. Chain equal_length
            // from the first edge to each subsequent edge.
            const edgeTargets = c.targets.filter((t) => t.kind === "SketchEdge");
            if (edgeTargets.length < 2) return out;
            const ids: { line: number; p1: number; p2: number }[] = [];
            for (const t of edgeTargets) {
                const id = edgeIdsFor(t);
                if (!id) return out;
                ids.push(id);
            }
            for (let i = 1; i < ids.length; i++) {
                out.push({
                    type: "equal_length",
                    id: String(idAlloc.next()),
                    l1_id: String(ids[0].line),
                    l2_id: String(ids[i].line),
                });
            }
            break;
        }
        case "Coincident": {
            if (c.targets.length < 2) return out;
            const p1 = pointIdFor(c.targets[0]);
            const p2 = pointIdFor(c.targets[1]);
            if (p1 == null || p2 == null) return out;
            out.push({ type: "p2p_coincident", id: String(idAlloc.next()), p1_id: String(p1), p2_id: String(p2) });
            break;
        }
        case "PointOnGrid": {
            // SketchPoint に加え Column / ColumnVertex / WallAxisPoint / GridPoint / Origin も受け付ける。
            // ColumnVertex の場合は column center へリマップし、通芯をオフセット分シフトする。
            const pointKindsForOnGrid = new Set(["SketchPoint", "Column", "ColumnVertex", "WallAxisPoint", "GridPoint", "Origin"]);
            const pt = c.targets.find((t) => pointKindsForOnGrid.has(t.kind));
            const gridTgt = c.targets.find((t) => t.kind === "Grid");
            if (!pt || !gridTgt || gridTgt.kind !== "Grid") return out;
            const grid = grids.find((g) => g.id === gridTgt.gridId);
            if (!grid || grid.curve.type !== "Line") return out;

            if (pt.kind === "ColumnVertex") {
                const col = elements[(pt as any).columnId as string] as ColumnElement | undefined;
                if (!col || !col.basePoint) return out;
                const centerId = columnPointIds?.get((pt as any).columnId as string);
                if (centerId == null) return out;
                const fp = columnFootprint2D(col);
                const vi = (pt as any).vertexIdx as number;
                if (vi < 0 || vi >= fp.length) return out;
                const ox = fp[vi][0] - col.basePoint[0];
                const oz = fp[vi][1] - col.basePoint[2];
                // Shift grid by -offset: center on shifted line ≡ vertex on original
                const ga = idAlloc.next(), gb = idAlloc.next(), gl = idAlloc.next();
                out.push({ type: "point", id: String(ga), x: grid.curve.start[0] - ox, y: grid.curve.start[2] - oz, fixed: true });
                out.push({ type: "point", id: String(gb), x: grid.curve.end[0] - ox,   y: grid.curve.end[2] - oz,   fixed: true });
                out.push({ type: "line",  id: String(gl), p1_id: String(ga), p2_id: String(gb) });
                out.push({ type: "point_on_line_pl", id: String(idAlloc.next()), p_id: String(centerId), l_id: String(gl) });
                break;
            }

            const pid = pointIdFor(pt);
            if (pid == null) return out;
            // Push the grid as two fixed points + a line, then point_on_line
            const ga = idAlloc.next();
            const gb = idAlloc.next();
            const gl = idAlloc.next();
            out.push({ type: "point", id: String(ga), x: grid.curve.start[0], y: grid.curve.start[2], fixed: true });
            out.push({ type: "point", id: String(gb), x: grid.curve.end[0],   y: grid.curve.end[2],   fixed: true });
            out.push({ type: "line",  id: String(gl), p1_id: String(ga), p2_id: String(gb) });
            out.push({ type: "point_on_line_pl", id: String(idAlloc.next()), p_id: String(pid), l_id: String(gl) });
            break;
        }
        case "PointOnColumn": {
            const pt = c.targets.find((t) => t.kind === "SketchPoint");
            const colTgt = c.targets.find((t) => t.kind === "Column");
            if (!pt || pt.kind !== "SketchPoint" || !colTgt || colTgt.kind !== "Column") return out;
            const pid = pointIdFor(pt);
            if (pid == null) return out;
            const col = elements[colTgt.columnId as string] as ColumnElement | undefined;
            if (!col || !col.basePoint) return out;
            // Fixed point at column center + coincident
            const cp = idAlloc.next();
            out.push({ type: "point", id: String(cp), x: col.basePoint[0], y: col.basePoint[2], fixed: true });
            out.push({ type: "p2p_coincident", id: String(idAlloc.next()), p1_id: String(pid), p2_id: String(cp) });
            break;
        }
        case "CircleRadius": {
            const ct = c.targets.find((t) => t.kind === "SketchCircle");
            if (!ct || ct.kind !== "SketchCircle" || c.value === undefined) return out;
            const ids = circleIdFor(ct);
            if (!ids) return out;
            out.push({
                type: "circle_radius",
                id: String(idAlloc.next()),
                c_id: String(ids.circle),
                radius: c.value,
            });
            break;
        }
        case "CircleDiameter": {
            const ct = c.targets.find((t) => t.kind === "SketchCircle");
            if (!ct || ct.kind !== "SketchCircle" || c.value === undefined) return out;
            const ids = circleIdFor(ct);
            if (!ids) return out;
            out.push({
                type: "circle_diameter",
                id: String(idAlloc.next()),
                c_id: String(ids.circle),
                diameter: c.value,
            });
            break;
        }
        case "ArcRadius": {
            // SketchEntity を直接ターゲットとする半径拘束 (= Arc / Circle entity)。
            const ct = c.targets.find((t) => t.kind === "SketchEntity");
            if (!ct || ct.kind !== "SketchEntity" || c.value === undefined) return out;
            const ids = entityCircleFor(ct);
            if (!ids) return out;
            out.push({
                type: "circle_radius",
                id: String(idAlloc.next()),
                c_id: String(ids.circle),
                radius: c.value,
            });
            break;
        }
        case "ArcDiameter": {
            const ct = c.targets.find((t) => t.kind === "SketchEntity");
            if (!ct || ct.kind !== "SketchEntity" || c.value === undefined) return out;
            const ids = entityCircleFor(ct);
            if (!ids) return out;
            out.push({
                type: "circle_diameter",
                id: String(idAlloc.next()),
                c_id: String(ids.circle),
                diameter: c.value,
            });
            break;
        }
        case "HorizDistance": {
            // 2 点間の水平 (world X / planegcs x) 距離。
            // c.value は符号付き: targets[0].x - targets[1].x の符号を作成時に固定。
            // ColumnVertex の場合は column center へリマップし、頂点 X オフセット分を調整する。
            if (c.value == null || c.targets.length < 2) return out;
            const resolveHorizPoint = (t: ConstraintTarget): { id: OID; offsetX: number } | null => {
                if (t.kind === "ColumnVertex") {
                    const col = elements[(t as any).columnId as string] as ColumnElement | undefined;
                    if (!col || !col.basePoint) return null;
                    const cid = columnPointIds?.get((t as any).columnId as string);
                    if (cid == null) return null;
                    const fp = columnFootprint2D(col);
                    const vi = (t as any).vertexIdx as number;
                    const ox = (vi >= 0 && vi < fp.length) ? fp[vi][0] - col.basePoint[0] : 0;
                    return { id: cid, offsetX: ox };
                }
                const id = pointIdFor(t);
                return id != null ? { id, offsetX: 0 } : null;
            };
            const rA = resolveHorizPoint(c.targets[0]);
            const rB = resolveHorizPoint(c.targets[1]);
            if (!rA || !rB) return out;
            // (centerA.x + offsetA.x) - (centerB.x + offsetB.x) = c.value
            // → centerA.x - centerB.x = c.value - offsetA.x + offsetB.x
            const adjustedValue = c.value - rA.offsetX + rB.offsetX;
            const [first, second] = (adjustedValue >= 0) ? [rA.id, rB.id] : [rB.id, rA.id];
            out.push({
                type: "difference",
                id: String(idAlloc.next()),
                param1: { o_id: String(first), prop: "x" },
                param2: { o_id: String(second), prop: "x" },
                difference: Math.abs(adjustedValue),
            });
            break;
        }
        case "VertDistance": {
            // 2 点間の垂直 (world Z / planegcs y) 距離。
            // c.value は符号付き: targets[0].z - targets[1].z の符号を作成時に固定。
            // ColumnVertex の場合は column center へリマップし、頂点 Z オフセット分を調整する。
            if (c.value == null || c.targets.length < 2) return out;
            const resolveVertPoint = (t: ConstraintTarget): { id: OID; offsetZ: number } | null => {
                if (t.kind === "ColumnVertex") {
                    const col = elements[(t as any).columnId as string] as ColumnElement | undefined;
                    if (!col || !col.basePoint) return null;
                    const cid = columnPointIds?.get((t as any).columnId as string);
                    if (cid == null) return null;
                    const fp = columnFootprint2D(col);
                    const vi = (t as any).vertexIdx as number;
                    const oz = (vi >= 0 && vi < fp.length) ? fp[vi][1] - col.basePoint[2] : 0;
                    return { id: cid, offsetZ: oz };
                }
                const id = pointIdFor(t);
                return id != null ? { id, offsetZ: 0 } : null;
            };
            const rA = resolveVertPoint(c.targets[0]);
            const rB = resolveVertPoint(c.targets[1]);
            if (!rA || !rB) return out;
            const adjustedValue = c.value - rA.offsetZ + rB.offsetZ;
            const [first, second] = (adjustedValue >= 0) ? [rA.id, rB.id] : [rB.id, rA.id];
            out.push({
                type: "difference",
                id: String(idAlloc.next()),
                param1: { o_id: String(first), prop: "y" },
                param2: { o_id: String(second), prop: "y" },
                difference: Math.abs(adjustedValue),
            });
            break;
        }
        case "Tangent": {
            // Accept: edge+circle, or two circles.
            const circleTargets = c.targets.filter((t) => t.kind === "SketchCircle");
            const edgeTargets = c.targets.filter((t) => t.kind === "SketchEdge");
            if (circleTargets.length === 2) {
                const a = circleIdFor(circleTargets[0]);
                const b = circleIdFor(circleTargets[1]);
                if (!a || !b) return out;
                out.push({
                    type: "tangent_cc",
                    id: String(idAlloc.next()),
                    c1_id: String(a.circle),
                    c2_id: String(b.circle),
                });
            } else if (circleTargets.length === 1 && edgeTargets.length === 1) {
                const ci = circleIdFor(circleTargets[0]);
                const ei = edgeIdsFor(edgeTargets[0]);
                if (!ci || !ei) return out;
                out.push({
                    type: "tangent_lc",
                    id: String(idAlloc.next()),
                    l_id: String(ei.line),
                    c_id: String(ci.circle),
                });
            } else {
                return out;
            }
            break;
        }
        case "PointOnCircle": {
            const pt = c.targets.find((t) => t.kind === "SketchPoint");
            const ct = c.targets.find((t) => t.kind === "SketchCircle");
            if (!pt || pt.kind !== "SketchPoint" || !ct || ct.kind !== "SketchCircle") return out;
            const pid = pointIdFor(pt);
            const ids = circleIdFor(ct);
            if (pid == null || !ids) return out;
            out.push({
                type: "point_on_circle",
                id: String(idAlloc.next()),
                p_id: String(pid),
                c_id: String(ids.circle),
            });
            break;
        }
        case "ConcentricCircle": {
            // Concentricity is enforced at the geometry level by sharing a
            // single center-point OID (see SketchSolver push step). No GCS
            // constraint needed.
            break;
        }
        case "EqualRadius": {
            const cts = c.targets.filter((t) => t.kind === "SketchCircle");
            if (cts.length < 2) return out;
            const a = circleIdFor(cts[0]);
            const b = circleIdFor(cts[1]);
            if (!a || !b) return out;
            out.push({
                type: "equal_radius_cc",
                id: String(idAlloc.next()),
                c1_id: String(a.circle),
                c2_id: String(b.circle),
            });
            break;
        }
    }

    return out;
}

class IdAllocator {
    private n = 1;
    public next(): number {
        return this.n++;
    }
}
