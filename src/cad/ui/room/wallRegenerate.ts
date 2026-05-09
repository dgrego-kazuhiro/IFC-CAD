// 全壁生成の本体ロジックを RoomEditPanel から切り出したモジュール。
// 部屋編集 UI のボタン (= 全壁生成) と、図形ドロー直後・ポリゴンドラッグ完了
// 直後の自動再生成 (リアルタイム壁生成) の両方から同じパスを呼ぶ。
//
// 副作用: useAppState.getState() を直接読み・書きする。React 内/外どちらから
// 呼んでも問題ない。

import { useAppState } from "../../application/AppState";
import {
    SpaceElement,
    RoomPolygon,
    polygonEdges,
    isPolygonClosed,
    WallReferenceLine,
} from "../../model/elements/SpaceElement";
import { ensureCCW, computeWallHexagon } from "../../geometry/wall/EdgeGeometry";
import { generateId } from "../../utils/ids";
import { CreateWallCommand } from "../../commands/create/CreateWallCommand";
import {
    AddConstraintCommand,
    RemoveConstraintCommand,
    generateConstraintId,
} from "../../commands/create/AddConstraintCommand";
import { Vec2 } from "../../geometry/math/Vec2";
import { Vec3 } from "../../geometry/math/Vec3";
import { ElementId } from "../../model/base/ElementId";
import {
    buildJunctionGraph,
    resolveJunctions,
    applyCaps,
    virtualEdgeFootprint,
    type ColumnFootprint,
    type EdgeThicknessMap,
    makeEdgeThicknessKey,
} from "../../topology/junctions/JunctionGraph";
import { ColumnElement } from "../../model/elements/ColumnElement";
import { WallElement } from "../../model/elements/WallElement";
import { columnFootprint2D } from "../../mesh/builders/ColumnMeshBuilder";
import polygonClipping, { type Pair, type Ring } from "polygon-clipping";

export interface RegenerateAllWallsOptions {
    /** 壁厚 (mm)。"200" のような数値文字列でも数値でも受け付ける。 */
    wallThicknessMm: string | number;
    /** 円ポリゴンのテッセレーション角 (deg)。 */
    circleWallAngleDeg: string | number;
    /** スケッチ線を壁のどこに置くか。未指定なら "Center" にフォールバック。 */
    wallReferenceMode?: "Center" | "Interior" | "Exterior";
    /** デバッグログを出すか (既定 false)。UI ボタン経由の時だけ true で呼ぶ想定。 */
    debug?: boolean;
    /**
     * 影響範囲を絞るシード polyId 集合。指定された場合、これらと
     *   (a) 既存共通壁を共有する、または
     *   (b) AABB が壁厚マージン内で交差し、かつ少なくとも 1 辺が共線で
     *       重なり合う
     * polygon だけを再構築対象とし、それ以外の部屋の壁は温存する。
     * 未指定なら全部屋を処理 (= 「全壁生成」ボタン経由の従来挙動)。
     *
     * リアルタイム生成 (図形 commit / ドラッグ完了) で使う想定。
     */
    seedPolyIds?: Iterable<string>;
}

/**
 * 全部屋の境界から壁を一括生成 / 再生成する。`RoomEditPanel.handleGenerateAllWalls`
 * の本体をそのまま移植したもの。エッジ単位ではなく **コリニア部分区間** 単位で
 * 共有判定するので、長さの違うエッジが一部だけ重なるケース (spec §6) に対応する。
 */
/**
 * realtime regen が ON の時だけ最新の AppState を読んで壁を再生成する共通
 * トリガ。部屋モードのポリゴン編集だけでなく、柱の配置・移動・削除など、
 * 壁の最終フットプリントに影響する全操作から呼ぶ。
 *
 * `reason` はログ用 (例: "column-create", "column-delete")。
 * `seedPolyIds` を渡すと影響範囲を絞れる (未指定なら全部屋再生成)。
 */
export function triggerWallRegenIfEnabled(reason: string, seedPolyIds?: string[]): void {
    const s = useAppState.getState();
    if (!s.realtimeWallGen) return;
    // eslint-disable-next-line no-console
    console.log(`[wallRegen-trigger] ${reason}` +
        (seedPolyIds && seedPolyIds.length
            ? ` seeds=[${seedPolyIds.map((p) => p.slice(0, 6)).join(",")}]`
            : ""));
    regenerateAllWalls({
        wallThicknessMm: s.wallThicknessMm,
        circleWallAngleDeg: s.circleWallAngleDeg,
        wallReferenceMode: s.wallReferenceMode,
        seedPolyIds,
    });
}

export function regenerateAllWalls(opts: RegenerateAllWallsOptions): void {
    const wallThickness = (parseFloat(String(opts.wallThicknessMm)) || 200) / 1000;
    const circleAngleDeg = Math.max(
        1,
        Math.min(180, parseFloat(String(opts.circleWallAngleDeg)) || 30),
    );
    const circleAngleRad = (circleAngleDeg * Math.PI) / 180;
    const debug = !!opts.debug;
    const seedSet = opts.seedPolyIds ? new Set(opts.seedPolyIds) : null;

    const state = useAppState.getState();
    const { elements, constraints, executeCommand, updateElement, removeElement } = state;

    // 壁基準線。UI から `wallReferenceMode` で受け取り、polygon.wallReference
    // とエッジ単位 inner/outer 厚さに反映する。
    //  - Center   : inner = outer = T/2 (= スケッチ線が壁芯)
    //  - Interior : inner = 0, outer = T (= スケッチ線が室内側仕上げ面、壁は外側へ)
    //  - Exterior : inner = T, outer = 0 (= スケッチ線が屋外側仕上げ面、壁は内側へ)
    const wallReference: WallReferenceLine = opts.wallReferenceMode ?? "Center";
    let innerT: number, outerT: number;
    switch (wallReference) {
        case "Interior": innerT = 0;             outerT = wallThickness;     break;
        case "Exterior": innerT = wallThickness; outerT = 0;                 break;
        case "Center":
        default:         innerT = wallThickness / 2; outerT = wallThickness / 2; break;
    }

    interface AABB { minX: number; minY: number; maxX: number; maxY: number; }
    interface PolyWork {
        roomId: ElementId;
        room: SpaceElement;
        poly: RoomPolygon;
        workingOuter: Vec2[];
        workingEdges: [number, number][];
        isOpen: boolean;
        aabb: AABB;
    }

    /**
     * 連続する共線頂点を畳み込む。前回までの regen 走行で挿入された
     * ブレークポイント (= ある辺の途中に追加された頂点) は、その辺の
     * 連続頂点と共線になっているはずなので、ここで一度クリーンに戻す。
     * これをしないと毎ドラッグで微小な端切れが累積し、`splits` が崩壊する。
     *
     * 閉図形のみ対象。開いたポリラインは形状情報を厳格に保ちたいので素通し。
     */
    const collapseCollinear = (outer: Vec2[]): Vec2[] => {
        const n = outer.length;
        if (n < 4) return outer;
        const SIN_TOL = Math.sin((1 * Math.PI) / 180); // 1° 以内なら共線扱い
        const PERP_TOL = 0.001; // 1 mm 以内なら共線扱い
        const out: Vec2[] = [];
        for (let i = 0; i < n; i++) {
            const prev = outer[(i - 1 + n) % n];
            const cur = outer[i];
            const next = outer[(i + 1) % n];
            const dx1 = cur[0] - prev[0], dy1 = cur[1] - prev[1];
            const dx2 = next[0] - cur[0], dy2 = next[1] - cur[1];
            const len1 = Math.hypot(dx1, dy1);
            const len2 = Math.hypot(dx2, dy2);
            if (len1 < 1e-9 || len2 < 1e-9) {
                // 縮退頂点はドロップ。
                continue;
            }
            const cross = dx1 * dy2 - dy1 * dx2;
            const sin = Math.abs(cross) / (len1 * len2);
            // prev→cur と cur→next が同じ方向で、cur が prev→next 直線から離れていなければ共線。
            // 折り返し (180°反転) は cross≈0 でも逆方向なのでドット積で除外。
            const dot = dx1 * dx2 + dy1 * dy2;
            if (sin < SIN_TOL && dot > 0) {
                // 中点 cur が prev→next の直線から PERP_TOL 内かを念押しチェック。
                const dx = next[0] - prev[0], dy = next[1] - prev[1];
                const len = Math.hypot(dx, dy) || 1;
                const perp = Math.abs((cur[0] - prev[0]) * (-dy / len)
                                    + (cur[1] - prev[1]) * (dx / len));
                if (perp < PERP_TOL) continue; // ドロップ
            }
            out.push(cur);
        }
        // 全頂点が共線で潰れた異常ケースだけ元を返す。
        return out.length >= 3 ? out : outer;
    };
    // まず候補となる全 polygon を集める (まだ scope 絞り込みはしない)。
    const allWorks: PolyWork[] = [];
    for (const eid in elements) {
        const el = elements[eid];
        if (!el || el.type !== "Space") continue;
        const space = el as SpaceElement;
        if (!space.polygons || space.polygons.length === 0) continue;
        for (const poly of space.polygons) {
            if (poly.wallOutlineOf) continue;

            let workingOuter = poly.outer;
            let workingEdges: [number, number][];
            let isOpen = false;
            if (poly.shape?.type === "circle") {
                const n = Math.max(3, Math.round((Math.PI * 2) / circleAngleRad));
                const c = poly.shape.center, r = poly.shape.radius;
                const pts: Vec2[] = [];
                for (let i = 0; i < n; i++) {
                    const a = (i / n) * Math.PI * 2;
                    pts.push([c[0] + Math.cos(a) * r, c[1] + Math.sin(a) * r]);
                }
                workingOuter = pts;
                workingEdges = pts.map((_, i) => [i, (i + 1) % pts.length] as [number, number]);
            } else if (isPolygonClosed(poly)) {
                workingOuter = ensureCCW(workingOuter);
                // 前回 regen で挿入されたブレークポイント残骸を畳み込む。
                // これをしないと毎ドラッグで「t = 0.001 ずつズレた」微小端切れが
                // 累積し、splits dump で観察されたフィボナッチ的増殖が起きる。
                workingOuter = collapseCollinear(workingOuter);
                const n = workingOuter.length;
                workingEdges = Array.from({ length: n }, (_, i) =>
                    [i, (i + 1) % n] as [number, number]);
            } else {
                workingEdges = polygonEdges(poly).map(
                    ([a, b]) => [a, b] as [number, number],
                );
                isOpen = true;
            }
            if (workingEdges.length === 0) continue;
            // AABB (workingOuter ベース)。
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            for (const v of workingOuter) {
                if (v[0] < minX) minX = v[0];
                if (v[1] < minY) minY = v[1];
                if (v[0] > maxX) maxX = v[0];
                if (v[1] > maxY) maxY = v[1];
            }
            allWorks.push({
                roomId: eid as ElementId, room: space, poly, workingOuter, workingEdges, isOpen,
                aabb: { minX, minY, maxX, maxY },
            });
        }
    }
    if (allWorks.length === 0) return;

    // ── scope 絞り込み ────────────────────────────────────────────
    // seedSet 指定時は「seed と (a) 既存壁を共有する / (b) AABB 交差 +
    // 共線辺重なり」polygon だけを再構築対象とする。これは
    //   - commit 直後 (新図形 1 個): 影響範囲は新図形の周辺だけ
    //   - ドラッグ完了 (移動図形 1 個): 影響範囲は移動先の周辺だけ
    // という性質を活かして、無関係な部屋の壁を温存し regen コストを下げる。
    let works: PolyWork[];
    if (seedSet) {
        const SCOPE_ANGLE_TOL = (3 * Math.PI) / 180;
        const SCOPE_DIST_TOL = Math.max(0.02, wallThickness);
        const margin = SCOPE_DIST_TOL;

        // wallId → それを参照する polyId 一覧 (既存共通壁の検出用)
        const polysByWid = new Map<string, string[]>();
        for (const w of allWorks) {
            for (const wid of w.poly.wallIds ?? []) {
                if (!wid) continue;
                if (!polysByWid.has(wid)) polysByWid.set(wid, []);
                polysByWid.get(wid)!.push(w.poly.id);
            }
        }

        const inScope = new Set<string>();
        for (const w of allWorks) {
            if (seedSet.has(w.poly.id)) inScope.add(w.poly.id);
        }

        const aabbIntersects = (a: AABB, b: AABB): boolean =>
            a.maxX + margin >= b.minX
            && b.maxX + margin >= a.minX
            && a.maxY + margin >= b.minY
            && b.maxY + margin >= a.minY;

        const hasCollinearEdgePair = (a: PolyWork, b: PolyWork): boolean => {
            for (const [aiA, aiB] of a.workingEdges) {
                const p1 = a.workingOuter[aiA], p2 = a.workingOuter[aiB];
                const adx = p2[0] - p1[0], ady = p2[1] - p1[1];
                const aLen = Math.hypot(adx, ady);
                if (aLen < 1e-9) continue;
                const aux = adx / aLen, auy = ady / aLen;
                const anx = -auy, any = aux;
                let aTheta = Math.atan2(ady, adx);
                if (aTheta < 0) aTheta += Math.PI;
                if (aTheta >= Math.PI) aTheta -= Math.PI;
                for (const [biA, biB] of b.workingEdges) {
                    const q1 = b.workingOuter[biA], q2 = b.workingOuter[biB];
                    const bdx = q2[0] - q1[0], bdy = q2[1] - q1[1];
                    const bLen = Math.hypot(bdx, bdy);
                    if (bLen < 1e-9) continue;
                    let bTheta = Math.atan2(bdy, bdx);
                    if (bTheta < 0) bTheta += Math.PI;
                    if (bTheta >= Math.PI) bTheta -= Math.PI;
                    let dTh = Math.abs(aTheta - bTheta);
                    if (dTh > Math.PI / 2) dTh = Math.PI - dTh;
                    if (dTh > SCOPE_ANGLE_TOL) continue;
                    // b の両端点が a の無限直線から DIST_TOL 内?
                    const perp1 = Math.abs((q1[0] - p1[0]) * anx + (q1[1] - p1[1]) * any);
                    const perp2 = Math.abs((q2[0] - p1[0]) * anx + (q2[1] - p1[1]) * any);
                    if (perp1 > SCOPE_DIST_TOL || perp2 > SCOPE_DIST_TOL) continue;
                    // a 軸方向への射影で区間重なり (許容外なら別方向の異なるエッジ扱い)
                    const t1 = (q1[0] - p1[0]) * aux + (q1[1] - p1[1]) * auy;
                    const t2 = (q2[0] - p1[0]) * aux + (q2[1] - p1[1]) * auy;
                    const tMin = Math.min(t1, t2), tMax = Math.max(t1, t2);
                    if (Math.min(tMax, aLen) < Math.max(tMin, 0) - SCOPE_DIST_TOL) continue;
                    return true;
                }
            }
            return false;
        };

        /**
         * T 字接合の検出: a の頂点が b のいずれかの辺の内部 (端点ではない位置、
         * SCOPE_DIST_TOL 内) に乗っているか。または b 側で同様。
         *
         * これは WallPath が部屋の壁面に直角に突き当たるケース (= 共線辺は無いが
         * 端点が壁エッジ上にある) を scope に取り込むために必要。これが無いと
         * JunctionGraph 側で T 字接合の split が走らず、WallPath の壁端と部屋の
         * 壁帯が **そのまま重なる** (= ユーザー報告のオーバーラップ症状)。
         */
        const hasVertexOnEdge = (a: PolyWork, b: PolyWork): boolean => {
            const tol = SCOPE_DIST_TOL;
            const check = (vs: Vec2[], edges: [number, number][], owner: PolyWork): boolean => {
                for (const v of vs) {
                    for (const [bi1, bi2] of edges) {
                        const p1 = owner.workingOuter[bi1];
                        const p2 = owner.workingOuter[bi2];
                        const dx = p2[0] - p1[0];
                        const dy = p2[1] - p1[1];
                        const lenSq = dx * dx + dy * dy;
                        if (lenSq < 1e-12) continue;
                        let t = ((v[0] - p1[0]) * dx + (v[1] - p1[1]) * dy) / lenSq;
                        // 端点付近 (t ≈ 0 / 1) は cluster で吸収されるので除外しないと
                        // 全部のコーナー隣接ペアが「接続」扱いになって scope が広がりすぎる。
                        const tol_t = tol / Math.sqrt(lenSq);
                        if (t < tol_t || t > 1 - tol_t) continue;
                        const px = p1[0] + dx * t;
                        const py = p1[1] + dy * t;
                        if (Math.hypot(v[0] - px, v[1] - py) < tol) return true;
                    }
                }
                return false;
            };
            return check(a.workingOuter, b.workingEdges, b)
                || check(b.workingOuter, a.workingEdges, a);
        };

        // 凸閉包: 影響セットが安定するまで反復で展開。
        // (a) seed と既存壁を共有する poly、
        // (b) seed の AABB+共線辺で繋がる poly、
        // (b') seed と T 字接合 (= 一方の頂点が他方の辺内部に乗る) する poly、
        // (c) 上記で追加された poly に再帰的に同じ条件で繋がる poly
        // をすべて取り込む。実用上ほぼ 2 回の反復で収束する。
        let changed = true;
        while (changed) {
            changed = false;
            for (const w of allWorks) {
                if (inScope.has(w.poly.id)) continue;
                let connected = false;
                for (const wid of w.poly.wallIds ?? []) {
                    if (!wid) continue;
                    const sharers = polysByWid.get(wid) ?? [];
                    if (sharers.some((pid) => pid !== w.poly.id && inScope.has(pid))) {
                        connected = true;
                        break;
                    }
                }
                if (!connected) {
                    for (const other of allWorks) {
                        if (!inScope.has(other.poly.id)) continue;
                        if (!aabbIntersects(w.aabb, other.aabb)) continue;
                        if (hasCollinearEdgePair(w, other)
                            || hasVertexOnEdge(w, other)) { connected = true; break; }
                    }
                }
                if (connected) { inScope.add(w.poly.id); changed = true; }
            }
        }

        works = allWorks.filter((w) => inScope.has(w.poly.id));
        if (debug || works.length !== allWorks.length) {
            // eslint-disable-next-line no-console
            console.log(
                `[regenerateAllWalls] scope ${works.length}/${allWorks.length} polys ` +
                `(seeds=${seedSet.size})`,
            );
        }
    } else {
        works = allWorks;
    }
    if (works.length === 0) return;

    // ── 0. Column footprints (壁分断のために cluster 段で必要) ───────
    // works に含まれる polygon の levelId 集合に紐付く Column のみ対象。
    // levelId が未設定の Column は安全側で含める。
    const earlyRoomLevelIds = new Set<ElementId>();
    for (const w of works) {
        if (w.room.levelId) earlyRoomLevelIds.add(w.room.levelId);
    }
    // 診断: 全 Column 要素を列挙してフィルタの結果を出力。
    let allColumnsCount = 0;
    let filteredOutByLevel = 0;
    let filteredOutByFp = 0;
    const columnFootprints: ColumnFootprint[] = [];
    for (const eid in elements) {
        const el = elements[eid];
        if (!el || el.type !== "Column") continue;
        allColumnsCount++;
        const col = el as ColumnElement;
        if (col.baseLevelId && earlyRoomLevelIds.size > 0
            && !earlyRoomLevelIds.has(col.baseLevelId)) {
            // eslint-disable-next-line no-console
            console.log(
                `[wallRegen/§0] col ${(col.id as string).slice(0,6)} ` +
                `SKIPPED by level: col.baseLevelId=${col.baseLevelId} ` +
                `roomLevelIds=[${[...earlyRoomLevelIds].join(",")}]`,
            );
            filteredOutByLevel++;
            continue;
        }
        const fp = columnFootprint2D(col);
        if (fp.length >= 3) {
            columnFootprints.push({ id: col.id as string, points: ensureCCW(fp) });
        } else {
            // eslint-disable-next-line no-console
            console.log(
                `[wallRegen/§0] col ${(col.id as string).slice(0,6)} ` +
                `SKIPPED by fp: fp.length=${fp.length} ` +
                `basePoint=${col.basePoint ? `(${col.basePoint[0].toFixed(2)},${col.basePoint[2].toFixed(2)})` : "null"}`,
            );
            filteredOutByFp++;
        }
    }
    // eslint-disable-next-line no-console
    console.log(
        `[wallRegen/§0] columns total=${allColumnsCount} ` +
        `passed=${columnFootprints.length} ` +
        `filteredByLevel=${filteredOutByLevel} ` +
        `filteredByFp=${filteredOutByFp} ` +
        `roomLevelIds=[${[...earlyRoomLevelIds].join(",")}]`,
    );

    // 柱フットプリントを 1 度だけ console に出して位置を確認できるようにする。
    if (columnFootprints.length > 0) {
        // eslint-disable-next-line no-console
        console.log(
            `[wallRegen/§0] columnFootprints (${columnFootprints.length}):` +
            columnFootprints.map((c) =>
                `\n  id=${c.id.slice(0, 6)} pts=[${c.points.map((p) => `(${p[0].toFixed(2)},${p[1].toFixed(2)})`).join(" ")}]`,
            ).join(""),
        );
    }

    // ── 1. Cluster edges by collinear line (cross-room) ─────────────
    const ANGLE_TOL = (3 * Math.PI) / 180;
    const DIST_TOL = Math.max(0.02, wallThickness);
    const T_QUANTUM = 0.001; // 1 mm

    interface ClusterEdge {
        workIdx: number;
        edgeIdx: number;
        tStart: number;
        tEnd: number;
    }
    interface Cluster {
        theta: number;
        dir: [number, number];
        normal: [number, number];
        refPoint: Vec2;
        edges: ClusterEdge[];
    }
    const clusters: Cluster[] = [];
    for (let wi = 0; wi < works.length; wi++) {
        const outer = works[wi].workingOuter;
        const wEdges = works[wi].workingEdges;
        for (let ei = 0; ei < wEdges.length; ei++) {
            const [aIdx, bIdx] = wEdges[ei];
            const p1 = outer[aIdx];
            const p2 = outer[bIdx];
            const dx = p2[0] - p1[0], dy = p2[1] - p1[1];
            const len = Math.hypot(dx, dy);
            if (len < 1e-9) continue;
            let theta = Math.atan2(dy, dx);
            if (theta < 0) theta += Math.PI;
            if (theta >= Math.PI) theta -= Math.PI;

            let cluster: Cluster | null = null;
            for (const c of clusters) {
                let dTh = Math.abs(theta - c.theta);
                if (dTh > Math.PI / 2) dTh = Math.PI - dTh;
                if (dTh > ANGLE_TOL) continue;
                const perp = Math.abs(
                    (p1[0] - c.refPoint[0]) * c.normal[0] +
                    (p1[1] - c.refPoint[1]) * c.normal[1],
                );
                if (perp > DIST_TOL) continue;
                cluster = c;
                break;
            }
            if (!cluster) {
                const dir: [number, number] = [Math.cos(theta), Math.sin(theta)];
                const normal: [number, number] = [-Math.sin(theta), Math.cos(theta)];
                cluster = { theta, dir, normal, refPoint: [p1[0], p1[1]], edges: [] };
                clusters.push(cluster);
            }
            const tStart =
                (p1[0] - cluster.refPoint[0]) * cluster.dir[0] +
                (p1[1] - cluster.refPoint[1]) * cluster.dir[1];
            const tEnd =
                (p2[0] - cluster.refPoint[0]) * cluster.dir[0] +
                (p2[1] - cluster.refPoint[1]) * cluster.dir[1];
            cluster.edges.push({ workIdx: wi, edgeIdx: ei, tStart, tEnd });
        }
    }

    // ── 2/3. Per cluster, derive sub-segments per edge ───────────────
    const quantize = (t: number) => Math.round(t / T_QUANTUM) * T_QUANTUM;

    interface SubSeg {
        clusterIdx: number;
        tA: number;
        tB: number;
        startWorld: Vec2;
        endWorld: Vec2;
    }
    const perEdgeSubs: SubSeg[][][] = works.map((w) =>
        w.workingEdges.map(() => [] as SubSeg[]),
    );

    for (let ci = 0; ci < clusters.length; ci++) {
        const cluster = clusters[ci];
        const tSet = new Set<number>();
        for (const e of cluster.edges) {
            tSet.add(quantize(e.tStart));
            tSet.add(quantize(e.tEnd));
        }
        // T 字接合 breakpoint は **追加しない**。これを加えると polyRebuilds 側で
        // ホスト壁のエッジが 2 本に分断され、見た目で壁が 2 枚に割れる原因に
        // なる。JunctionGraph 側は引き続き T 字接合を検出して 2 つの仮想エッジ
        // に split するので、後段 §7 の wall 作成で **両 VE の corners を統合した
        // フットプリント** を採用すれば 1 壁としてレンダしつつ stem との butt-cut
        // も正しく決まる。
        const breakpoints = [...tSet].sort((a, b) => a - b);

        for (const e of cluster.edges) {
            const qS = quantize(e.tStart);
            const qE = quantize(e.tEnd);
            const tMin = Math.min(qS, qE);
            const tMax = Math.max(qS, qE);
            if (tMax - tMin < T_QUANTUM / 2) continue;
            const reverse = qS > qE;

            const interior = breakpoints.filter(
                (t) => t > tMin + T_QUANTUM / 2 && t < tMax - T_QUANTUM / 2,
            );
            const tValues = [tMin, ...interior, tMax];

            const subRanges: SubSeg[] = [];
            for (let k = 0; k < tValues.length - 1; k++) {
                const tA = tValues[k];
                const tB = tValues[k + 1];
                const wA: Vec2 = [
                    cluster.refPoint[0] + cluster.dir[0] * tA,
                    cluster.refPoint[1] + cluster.dir[1] * tA,
                ];
                const wB: Vec2 = [
                    cluster.refPoint[0] + cluster.dir[0] * tB,
                    cluster.refPoint[1] + cluster.dir[1] * tB,
                ];
                subRanges.push({ clusterIdx: ci, tA, tB, startWorld: wA, endWorld: wB });
            }
            if (reverse) {
                subRanges.reverse();
                for (const s of subRanges) {
                    const tmp = s.startWorld; s.startWorld = s.endWorld; s.endWorld = tmp;
                }
            }
            perEdgeSubs[e.workIdx][e.edgeIdx] = subRanges;
        }
    }

    // ── 4. Group sub-segments across polygons ────────────────────────
    const groupKey = (clusterIdx: number, tA: number, tB: number) =>
        `${clusterIdx}|${tA.toFixed(4)}|${tB.toFixed(4)}`;

    interface SubGroupContributor {
        workIdx: number;
        oldEdgeIdx: number;
        subIdx: number;
    }
    interface SubGroup {
        polysContributing: Set<string>;
        axis: [Vec3, Vec3];
        contributors: SubGroupContributor[];
    }
    const subGroups = new Map<string, SubGroup>();
    for (let wi = 0; wi < works.length; wi++) {
        const polyId = works[wi].poly.id;
        // perEdgeSubs[wi] は workingEdges に対応 (1 entry / edge)。
        // 開いたポリラインだと workingEdges.length < workingOuter.length のため、
        // outer.length で回すと存在しない edge を見にいく。edges.length で回す。
        const edgeCount = works[wi].workingEdges.length;
        for (let ei = 0; ei < edgeCount; ei++) {
            const subList = perEdgeSubs[wi][ei];
            for (let si = 0; si < subList.length; si++) {
                const sub = subList[si];
                const key = groupKey(sub.clusterIdx, sub.tA, sub.tB);
                let g = subGroups.get(key);
                if (!g) {
                    const cluster = clusters[sub.clusterIdx];
                    const aWorld: Vec2 = [
                        cluster.refPoint[0] + cluster.dir[0] * sub.tA,
                        cluster.refPoint[1] + cluster.dir[1] * sub.tA,
                    ];
                    const bWorld: Vec2 = [
                        cluster.refPoint[0] + cluster.dir[0] * sub.tB,
                        cluster.refPoint[1] + cluster.dir[1] * sub.tB,
                    ];
                    g = {
                        polysContributing: new Set(),
                        axis: [
                            [aWorld[0], 0, aWorld[1]],
                            [bWorld[0], 0, bWorld[1]],
                        ] as [Vec3, Vec3],
                        contributors: [],
                    };
                    subGroups.set(key, g);
                }
                g.polysContributing.add(polyId);
                g.contributors.push({ workIdx: wi, oldEdgeIdx: ei, subIdx: si });
            }
        }
    }

    // ── 5. Build new outer + new wallIds per polygon ─────────────────
    interface PolyRebuild {
        workIdx: number;
        newOuter: Vec2[];
        newEdges: [number, number][];
        newWallIds: string[];
        /** 各 new edge に対応する全 wall id (柱で分断された場合は複数)。
         *  newWallIds[i] は `newWallsPerEdge[i][0]` (= canonical wallId) と
         *  一致する。`newWallsPerEdge` が未設定 (= 柱分断なし) の場合は
         *  newWallIds から `[id]` で導出する。 */
        newWallsPerEdge?: string[][];
        newSharedEdgeIds: (string | undefined)[];
        newEdgeIds: string[];
        modified: boolean;
        oldEdgeToNewEdges: number[][];
        oldVertexToNew: number[];
        isOpen: boolean;
    }

    // 1 sub-group につき 0+ 個の wall id を保持 (柱で分断された場合は複数)。
    const groupWallIds = new Map<string, string[]>();
    const groupSharedEdgeId = new Map<string, string>();

    const polyRebuilds: PolyRebuild[] = [];
    for (let wi = 0; wi < works.length; wi++) {
        const w = works[wi];
        const oldOuter = w.workingOuter;
        const oldEdges = w.workingEdges;
        const oldN = oldOuter.length;
        // newOuter / newEdges を **エッジ巡回順** で構築する。
        // 旧実装は「全旧頂点をまとめて push → ブレークポイントを末尾に追加」
        // としていたため newOuter が回転順を保たず、closed polygon を cyclic
        // (= edges 未設定) として解釈する側でリングが自己交差し、レンダリ
        // ングが破綻していた (= 「Room 1 が消える」現象の原因)。
        const newOuter: Vec2[] = [];
        const newEdges: [number, number][] = [];
        const oldVertexToNew: number[] = new Array(oldN).fill(-1);
        const oldEdgeToNewEdges: number[][] = [];
        let modified = false;
        // 必要に応じて旧頂点を 1 度だけ newOuter に追加するヘルパー。
        const ensureOldVertex = (vi: number): number => {
            if (oldVertexToNew[vi] !== -1) return oldVertexToNew[vi];
            const idx = newOuter.length;
            oldVertexToNew[vi] = idx;
            newOuter.push([oldOuter[vi][0], oldOuter[vi][1]]);
            return idx;
        };

        for (let ei = 0; ei < oldEdges.length; ei++) {
            const [aIdx, bIdx] = oldEdges[ei];
            const startIdx = ensureOldVertex(aIdx);
            const subs = perEdgeSubs[wi][ei];
            const newEdgeIdxList: number[] = [];
            let curIdx = startIdx;
            if (subs.length > 1) {
                modified = true;
                // ブレークポイントを巡回順に挿入。
                for (let k = 0; k < subs.length - 1; k++) {
                    const bpIdx = newOuter.length;
                    newOuter.push([subs[k + 1].startWorld[0], subs[k + 1].startWorld[1]]);
                    newEdgeIdxList.push(newEdges.length);
                    newEdges.push([curIdx, bpIdx]);
                    curIdx = bpIdx;
                }
            }
            const endIdx = ensureOldVertex(bIdx);
            newEdgeIdxList.push(newEdges.length);
            newEdges.push([curIdx, endIdx]);
            oldEdgeToNewEdges.push(newEdgeIdxList);
        }
        const newEdgeCount = newEdges.length;
        polyRebuilds.push({
            workIdx: wi,
            newOuter,
            newEdges,
            newWallIds: new Array(newEdgeCount).fill(""),
            newSharedEdgeIds: new Array(newEdgeCount).fill(undefined),
            newEdgeIds: Array.from({ length: newEdgeCount }, () => generateId()),
            modified,
            oldEdgeToNewEdges,
            oldVertexToNew,
            isOpen: w.isOpen,
        });
    }

    // ── 6. Drop existing walls referenced by any contributing polygon ─
    // wallIds (= 各エッジの canonical) と wallsPerEdge (= 柱で分断された
    // 子壁を含む全 ID) の両方を見て古い壁を確実に消す。
    //
    // 削除前に **per-edge で typeId / overrides を捕獲** しておく。再生成
    // で新規 wall を CreateWallCommand で作るとき、global activeTypeId では
    // なくこの per-edge スナップショットの typeId を優先することで、ユーザが
    // ChangeElementTypeCommand で個別に変えた wall の Type 情報がドラッグ等
    // の regen を介して保持される。
    interface PrevWallInfo {
        typeId: ElementId;
        overrides?: any;
        thickness: number;
        innerThickness: number;
        outerThickness: number;
        locationLine: WallElement["locationLine"];
    }
    const prevWallTypeByEdge = new Map<string, PrevWallInfo>();
    const prevEdgeKey = (polyId: string, edgeIdx: number) => `${polyId}:${edgeIdx}`;
    // Phase 2: per-edge 厚さマップ。JunctionGraph に流して、ユーザが Type 変更
    // した壁の厚さで隣接壁との接合を計算する。
    const edgeThicknessMap: EdgeThicknessMap = new Map();

    const prevWallIds = new Set<string>();
    for (const w of works) {
        const wallIds = w.poly.wallIds ?? [];
        // wallIds は **pre-collapse** の poly.outer に対応するインデックス
        // (= 前回 regen の breakpoint も含む)。一方 §1 cluster / §7 lookup は
        // **post-collapse** の workingEdges インデックス (= 0..workingOuter.length-1)
        // を使う。同じ polyId / 同じ「論理 edge」でも index がずれるので、
        // ここで pre→post マッピングを作って post-collapse index で
        // prevWallTypeByEdge を keying する。
        //
        // マッピング: pre-edge i (= polygon.outer[i] → outer[(i+1)%n]) の
        // 中点が、post-collapse working のどの edge ライン上にあるか。
        // collinear に潰された breakpoint も「親 edge」上にあるので一意に決まる。
        const preToPostEdge = new Map<number, number>();
        const preOuter = w.poly.outer;
        const preN = preOuter.length;
        const wEdges = w.workingEdges;
        const wOuter = w.workingOuter;
        if (preN > 0 && wEdges.length > 0) {
            const COLLINEAR_TOL = 1e-3; // 1 mm
            for (let preEi = 0; preEi < preN; preEi++) {
                const pa = preOuter[preEi];
                const pb = preOuter[(preEi + 1) % preN];
                const mid: Vec2 = [(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2];
                let bestEi = -1;
                let bestDist = Infinity;
                for (let ei = 0; ei < wEdges.length; ei++) {
                    const [ai, bi] = wEdges[ei];
                    const wa = wOuter[ai];
                    const wb = wOuter[bi];
                    const dx = wb[0] - wa[0], dy = wb[1] - wa[1];
                    const lenSq = dx * dx + dy * dy;
                    if (lenSq < 1e-12) continue;
                    let t = ((mid[0] - wa[0]) * dx + (mid[1] - wa[1]) * dy) / lenSq;
                    t = Math.max(0, Math.min(1, t));
                    const px = wa[0] + dx * t;
                    const py = wa[1] + dy * t;
                    const d = Math.hypot(mid[0] - px, mid[1] - py);
                    if (d < bestDist) { bestDist = d; bestEi = ei; }
                }
                if (bestEi >= 0 && bestDist < COLLINEAR_TOL) {
                    preToPostEdge.set(preEi, bestEi);
                }
            }
        }
        for (let edgeIdx = 0; edgeIdx < wallIds.length; edgeIdx++) {
            const wid = wallIds[edgeIdx];
            if (!wid) continue;
            prevWallIds.add(wid);
            const wallEl = elements[wid] as WallElement | undefined;
            if (wallEl && wallEl.type === "Wall") {
                const t = wallEl.thickness;
                const innerT = wallEl.innerThickness ?? t / 2;
                const outerT = wallEl.outerThickness ?? t / 2;
                // post-collapse edge index に正規化。マッピングが取れない
                // (= 異常: pre-edge が working line から外れている) 場合は
                // フォールバックで pre-index を使う (= 旧挙動と同等)。
                const postEi = preToPostEdge.get(edgeIdx) ?? edgeIdx;
                if (wallEl.typeId) {
                    // 同じ post-edge に複数の pre-edge が紐付く場合 (= 共有
                    // 壁を含む sub-segment が collapse で merge した) は、
                    // **isShared を優先** して prevInfo を確定する。共有
                    // でない sub-segment の prevInfo に上書きされて
                    // しまうと、step 4 detach 後に top wall が shared
                    // wall の locationLine を継承してしまうバグになる。
                    const existing = prevWallTypeByEdge.get(prevEdgeKey(w.poly.id, postEi));
                    const candidate: PrevWallInfo = {
                        typeId: wallEl.typeId,
                        overrides: wallEl.overrides,
                        thickness: t,
                        innerThickness: innerT,
                        outerThickness: outerT,
                        locationLine: wallEl.locationLine,
                    };
                    // 採用ルール: existing が無ければ採用。あれば、現候補の
                    // wid が **shared でない** (= 単独所有) ものを優先。
                    // shared 壁は §6.7 で他部屋から伝搬された情報を持つこと
                    // があり、collapse 後の post-edge 本来の所有者の方が
                    // 信頼できる。
                    if (!existing || !wallEl.isShared) {
                        prevWallTypeByEdge.set(prevEdgeKey(w.poly.id, postEi), candidate);
                    }
                }
                // per-edge 厚さマップを構築。Type 違いで thickness が違っても、
                // JunctionGraph は各 ve 自身の inner/outer offset で miter / Clipper
                // diff を行うので、隣接壁が違う厚さでも接合面が自然に閉じる。
                // edgeThicknessMap も post-collapse index で keying。
                edgeThicknessMap.set(
                    makeEdgeThicknessKey(w.poly.id, postEi),
                    { inner: innerT, outer: outerT },
                );
            }
        }
        // wallsPerEdge は柱で分断された場合の補助。canonical (= wallIds[i]) の
        // typeId を採用する方針なので追加捕獲は不要。
        for (const idsForEdge of w.poly.wallsPerEdge ?? []) {
            for (const wid of idsForEdge) if (wid) prevWallIds.add(wid);
        }
    }
    for (const wid of prevWallIds) {
        if (elements[wid]) removeElement(wid);
    }

    const innerIds = new Set<string>();
    for (const w of works) innerIds.add(w.poly.id);
    const staleOutlineIds = new Set<string>();
    for (const w of works) {
        for (const p of w.room.polygons) {
            if (p.wallOutlineOf && innerIds.has(p.wallOutlineOf)) {
                staleOutlineIds.add(p.id);
            }
        }
    }

    const modifiedPolyIds = new Set<string>();
    for (const r of polyRebuilds) {
        if (r.modified) modifiedPolyIds.add(works[r.workIdx].poly.id);
    }

    for (const cid in constraints) {
        const c = constraints[cid];
        const drop = c.targets.some((t) => {
            const tt = t as any;
            if (t.kind !== "SketchEdge" && t.kind !== "SketchPoint" && t.kind !== "SketchCircle") {
                return false;
            }
            return staleOutlineIds.has(tt.polyId) || modifiedPolyIds.has(tt.polyId);
        });
        if (drop) executeCommand(new RemoveConstraintCommand(cid));
    }

    // ── 6.5. Build JunctionGraph from rebuilt polygons ────────────────
    const rebuiltPolysForGraph: RoomPolygon[] = polyRebuilds.map((r) => {
        const w = works[r.workIdx];
        const edges: [number, number][] | undefined = r.isOpen
            ? r.newEdges.map(([a, b]) => [a, b] as [number, number])
            : undefined;
        return {
            ...w.poly,
            outer: r.newOuter,
            edges,
            wallIds: r.newWallIds,
            wallsPerEdge: r.newWallIds.map((id) => (id ? [id] : [])),
            wallThickness,
            innerThickness: innerT,
            outerThickness: outerT,
            wallReference,
            edgeIds: r.newEdgeIds,
            sharedEdgeIds: r.newSharedEdgeIds,
        };
    });
    // ── 6.7. Shared edge の厚さ / typeId を統一 ──────────────────────
    //
    // Phase 2 補正: 部屋境界の共有エッジは「片方の部屋が Type 変更で違う
    // 厚さ・Type になっている」ケースがある。両ポリゴンの edgeThicknessMap
    // と prevWallTypeByEdge に別々の値が入っていると、JunctionGraph が
    // **同じ axis 上に異厚さの 2 ves** として処理し、step (b) miter が両側で
    // 食い違い、接合部に三角形のスリバーや段差が出る。
    //
    // 解決: 各 shared subgroup について、「最大厚さの prevInfo を持つ
    // contributor」を canonical とみなし、その prevInfo / 厚さを **全
    // contributors に伝搬** する。
    //   - max 選択: ユーザが明示的に厚くした方を優先 (= 太い側を維持して
    //     薄い側のフットプリントが食い込まないようにする)。
    //   - 伝搬範囲: prevWallTypeByEdge (= §7 wall 作成時の Type 復元キー)
    //     と edgeThicknessMap (= JunctionGraph の per-edge 厚さ) の両方。
    //   - polyId 順 (= §7 canonical) と独立に動くので、どの polygon が
    //     canonical でも結果は同じ。
    for (const [, group] of subGroups) {
        if (group.polysContributing.size <= 1) continue;
        let bestPrev: PrevWallInfo | undefined;
        let bestSum = -1;
        for (const c of group.contributors) {
            const k = prevEdgeKey(works[c.workIdx].poly.id, c.oldEdgeIdx);
            const info = prevWallTypeByEdge.get(k);
            if (!info) continue;
            const sum = info.innerThickness + info.outerThickness;
            if (sum > bestSum) { bestSum = sum; bestPrev = info; }
        }
        if (!bestPrev) continue;
        const propagated = {
            inner: bestPrev.innerThickness,
            outer: bestPrev.outerThickness,
        };
        for (const c of group.contributors) {
            const polyId = works[c.workIdx].poly.id;
            // prevWallTypeByEdge: canonical の Type 情報を全 contributors に
            // 上書き伝搬する (= 上書きしないと §7 が contributor 別に違う
            // Type で wall を作ってしまう可能性)。
            prevWallTypeByEdge.set(prevEdgeKey(polyId, c.oldEdgeIdx), bestPrev);
            edgeThicknessMap.set(makeEdgeThicknessKey(polyId, c.oldEdgeIdx), propagated);
        }
    }

    // columnFootprints は §0 で計算済み (cluster 段で柱を breakpoint として
    // 使うため、JunctionGraph 用にも同じデータを再利用)。
    // Phase 2: edgeThicknessMap を渡して per-edge 厚さで miter / Clipper diff
    // を計算させる。マップに無いエッジはポリゴン共通厚さにフォールバック。
    const jgraph = buildJunctionGraph(rebuiltPolysForGraph);
    resolveJunctions(jgraph, rebuiltPolysForGraph, columnFootprints, edgeThicknessMap);
    applyCaps(jgraph, rebuiltPolysForGraph, edgeThicknessMap);

    // ── 7. Create wall(s) per sub-group ───────────────────────────────
    // Sub-group は通常 1 つの wall に対応するが、柱が wall fp と重なる場合は
    // wall fp - (柱の union) を polygon-clipping で計算し、結果のピースごとに
    // 別々の wall element を作る (= ユーザ仕様)。
    let sharedGroups = 0;
    let createdWallCount = 0;
    // 「edge 全体に wall を生成しない」スキップ判定。contributors のいずれかが
    // wallSkips で full skip (= t0=0, t1=1) を指定していれば、この wall group
    // 自体を作らずスキップ。共有壁では「いずれかの部屋が削除を望む」だけで
    // 壁を消す挙動 (= 開口を作るのに十分)。部分削除 (t0/t1 が中間) は
    // wallRegenerate ではまだ扱わず、後段の applyPartialWallSkips で処理する想定。
    const isContributorFullySkipped = (c: { workIdx: number; oldEdgeIdx: number }) => {
        const poly = works[c.workIdx].poly;
        const skips = poly.wallSkips ?? [];
        return skips.some((s) => s.edgeIdx === c.oldEdgeIdx && s.t0 <= 0 && s.t1 >= 1);
    };
    for (const [key, group] of subGroups) {
        const isShared = group.polysContributing.size > 1;
        if (isShared) {
            sharedGroups++;
            groupSharedEdgeId.set(key, generateId());
        }
        let canonical = group.contributors[0];
        for (const c of group.contributors) {
            const cId = works[c.workIdx].poly.id;
            const bestId = works[canonical.workIdx].poly.id;
            if (cId < bestId) canonical = c;
        }
        // wallSkips: full skip があれば壁を生成しない。canonical / 全 contributor
        // のいずれかにマークがあれば skip 対象。
        if (group.contributors.some(isContributorFullySkipped)) {
            // eslint-disable-next-line no-console
            console.log(`[wallRegen/§7] subGroup ${key.slice(0,12)} fully skipped via wallSkips — no wall created`);
            continue;
        }
        const canonicalWork = works[canonical.workIdx];
        const canonicalRebuild = polyRebuilds[canonical.workIdx];
        const newEdges = canonicalRebuild.oldEdgeToNewEdges[canonical.oldEdgeIdx];
        const canonicalNewEdgeIdx =
            canonical.subIdx < newEdges.length ? newEdges[canonical.subIdx] : -1;

        // ─ JunctionGraph で計算済みのミター済みフットプリント (4 頂点)。
        let mitered: Vec2[] | null = null;
        let veIsShared = false;
        if (canonicalNewEdgeIdx >= 0) {
            const veKey = `${canonicalWork.poly.id}:${canonicalNewEdgeIdx}`;
            const veIds = jgraph.edgeToVes.get(veKey);
            if (veIds && veIds.length > 0) {
                const firstVe = jgraph.virtualEdges.get(veIds[0]);
                const lastVe = jgraph.virtualEdges.get(veIds[veIds.length - 1]);
                if (firstVe && lastVe
                    && firstVe.startCorners && lastVe.endCorners) {
                    mitered = [
                        [firstVe.startCorners.inner[0], firstVe.startCorners.inner[1]],
                        [firstVe.startCorners.outer[0], firstVe.startCorners.outer[1]],
                        [lastVe.endCorners.outer[0],    lastVe.endCorners.outer[1]],
                        [lastVe.endCorners.inner[0],    lastVe.endCorners.inner[1]],
                    ];
                    veIsShared = firstVe.isShared || lastVe.isShared;
                } else if (firstVe) {
                    mitered = virtualEdgeFootprint(firstVe);
                    veIsShared = firstVe.isShared;
                }
            }
        }
        // フォールバック: ミター情報が取れない時は group.axis ± thickness/2 で矩形。
        const ax0 = group.axis[0];
        const ax1 = group.axis[1];
        const adx = ax1[0] - ax0[0], adz = ax1[2] - ax0[2];
        const axLen = Math.hypot(adx, adz);
        if (!mitered && axLen > 1e-9) {
            const ux = adx / axLen, uz = adz / axLen;
            const px = -uz, pz = ux;  // 90° CCW perpendicular
            const ht = wallThickness / 2;
            mitered = [
                [ax0[0] + px * ht, ax0[2] + pz * ht],
                [ax0[0] - px * ht, ax0[2] - pz * ht],
                [ax1[0] - px * ht, ax1[2] - pz * ht],
                [ax1[0] + px * ht, ax1[2] + pz * ht],
            ];
        }

        // ─ 柱 ↔ wall fp の polygon-clipping。
        // intersectingCols = この wall fp と実際に重なる柱フットプリントだけ。
        const wallRing: Pair[] = (mitered ?? []).map<Pair>((p) => [p[0], p[1]]);
        const intersectingCols: Ring[][] = [];
        const intersectingColIds: string[] = [];
        if (wallRing.length >= 3) {
            for (const col of columnFootprints) {
                const colRing: Pair[] = col.points.map<Pair>((p) => [p[0], p[1]]);
                try {
                    const inter = polygonClipping.intersection([wallRing], [colRing]);
                    if (inter.length > 0) {
                        intersectingCols.push([colRing]);
                        intersectingColIds.push(col.id);
                    }
                } catch (e) {
                    // eslint-disable-next-line no-console
                    console.warn(`[wallRegen] intersection 失敗 col=${col.id.slice(0,6)}`, e);
                }
            }
        }
        // eslint-disable-next-line no-console
        console.log(
            `[wallRegen/§7] subgroup=${key.slice(0,12)} ` +
            `mitered=${mitered ? `[${mitered.length}pt]` : "null"} ` +
            `wallRing=[${wallRing.map((p) => `(${p[0].toFixed(2)},${p[1].toFixed(2)})`).join(" ")}] ` +
            `intersectCols=[${intersectingColIds.map((id) => id.slice(0,6)).join(",")}]`,
        );

        // ─ ピース計算: 柱が無ければ wall fp = mitered のまま 1 ピース。
        //              柱があれば wall fp - union(columns) で 0+ ピース。
        type Piece = { ring: Vec2[]; tMin: number; tMax: number };
        const pieces: Piece[] = [];
        if (intersectingCols.length === 0 || axLen < 1e-9) {
            if (mitered) pieces.push({ ring: mitered, tMin: 0, tMax: axLen });
        } else {
            const ux = adx / axLen, uz = adz / axLen;
            let result: Ring[][] | null = null;
            let diffError: unknown = null;
            try {
                result = polygonClipping.difference([wallRing], ...intersectingCols);
            } catch (e) {
                diffError = e;
                result = null;
            }
            // eslint-disable-next-line no-console
            console.log(
                `[wallRegen/§7] subgroup=${key.slice(0,12)} difference ` +
                `result.length=${result?.length ?? "null"} ` +
                (diffError ? `error=${String(diffError)}` : ""),
            );
            if (result && result.length > 0) {
                for (let pi = 0; pi < result.length; pi++) {
                    const piece = result[pi];
                    const ring = piece[0];
                    if (!ring || ring.length < 4) {
                        // eslint-disable-next-line no-console
                        console.log(`  piece[${pi}]: ring too small (len=${ring?.length})`);
                        continue;
                    }
                    const open = ring.slice(0, -1);
                    const ringV2: Vec2[] = open.map<Vec2>((p) => [p[0], p[1]]);
                    let tMin = Infinity, tMax = -Infinity;
                    for (const p of open) {
                        const t = (p[0] - ax0[0]) * ux + (p[1] - ax0[2]) * uz;
                        if (t < tMin) tMin = t;
                        if (t > tMax) tMax = t;
                    }
                    // eslint-disable-next-line no-console
                    console.log(
                        `  piece[${pi}]: ${open.length}pt ` +
                        `tMin=${tMin.toFixed(3)} tMax=${tMax.toFixed(3)} ` +
                        `verts=[${open.map((p) => `(${p[0].toFixed(2)},${p[1].toFixed(2)})`).join(" ")}]`,
                    );
                    if (tMax - tMin < 1e-6) {
                        // eslint-disable-next-line no-console
                        console.log(`  piece[${pi}]: skipped (degenerate t-range)`);
                        continue;
                    }
                    pieces.push({ ring: ringV2, tMin, tMax });
                }
            } else if (mitered) {
                // eslint-disable-next-line no-console
                console.log(`[wallRegen/§7] subgroup=${key.slice(0,12)} difference produced 0 pieces — fallback to original`);
                pieces.push({ ring: mitered, tMin: 0, tMax: axLen });
            }
        }

        // ─ 各ピースについて wall element を生成。
        const widsForGroup: string[] = [];
        for (const piece of pieces) {
            // ピースの中心線 axis (= group.axis 方向に沿って tMin..tMax を切り出す)。
            const ux = axLen > 1e-9 ? adx / axLen : 1;
            const uz = axLen > 1e-9 ? adz / axLen : 0;
            const startT = Math.max(0, piece.tMin);
            const endT = Math.min(axLen, piece.tMax);
            const pieceAxis: [Vec3, Vec3] = [
                [ax0[0] + ux * startT, ax0[1], ax0[2] + uz * startT],
                [ax0[0] + ux * endT,   ax0[1], ax0[2] + uz * endT],
            ];
            // 既存壁の typeId / overrides を per-edge で復元 (= ChangeElementType
            // で個別に変えた wall の Type が regen 後も保持される)。canonical
            // edge (= work.poly.id : canonicalWork.oldEdgeIdx) のスナップショットを
            // 引く。無ければ global activeTypeId にフォールバック。
            const prevInfo = prevWallTypeByEdge.get(
                prevEdgeKey(canonicalWork.poly.id, canonical.oldEdgeIdx),
            );
            const wallTypeId = prevInfo?.typeId
                ?? useAppState.getState().activeTypeIdByCategory.Wall;
            if (!wallTypeId) {
                // Type 未 seed の異常系。fallback で生成スキップ。
                console.warn("[wallRegen] no active WallType — skipping piece");
                continue;
            }
            // overrides も同様に復元。なければ {thickness: wallThickness} で
            // ポリゴン共通厚を上書き。
            const cmdOverrides = prevInfo?.overrides
                ?? { thickness: wallThickness };
            const cmd = new CreateWallCommand(
                pieceAxis,
                wallTypeId as any,
                canonicalWork.room.height,
                undefined,
                canonicalWork.room.levelId,
                cmdOverrides,
            );
            executeCommand(cmd);
            const wid = cmd.getElementId();
            // Per-edge 厚さの保持: prevInfo があればその inner/outer を採用、
            // 無ければポリゴン共通の innerT/outerT を使う。これにより、ユーザが
            // ChangeElementTypeCommand で個別に変えた壁の厚さが、ドラッグ等で
            // wallRegenerate が再実行されても保持される。
            const wallInnerT = prevInfo?.innerThickness ?? innerT;
            const wallOuterT = prevInfo?.outerThickness ?? outerT;
            // locationLine も per-edge で復元 (= ChangeWallReferenceCommand で
            // 個別に変えた基準線が regen 後も保持される)。prevInfo が無い場合
            // (= 新規 edge) は CreateWallCommand が Type 既定値で設定済み。
            updateElement(wid, {
                wallCategory: isShared ? "shared" : "exterior",
                innerThickness: wallInnerT,
                outerThickness: wallOuterT,
                ...(prevInfo?.locationLine ? { locationLine: prevInfo.locationLine } : {}),
                polyRef: canonicalNewEdgeIdx >= 0 ? {
                    spaceId: canonicalWork.roomId,
                    polyId: canonicalWork.poly.id,
                    edgeIdx: canonicalNewEdgeIdx,
                } : undefined,
                footprint: piece.ring,
                // 柱との polygon-clipping は §7 で確定。WallGeometryBuilder で
                // clipByColumns を再適用しないようマークする (二重クリップ防止)。
                footprintIsFinal: intersectingCols.length > 0,
                isShared: veIsShared || isShared,
            } as any);
            widsForGroup.push(wid);
            createdWallCount++;
        }
        groupWallIds.set(key, widsForGroup);
        // eslint-disable-next-line no-console
        console.log(
            `[regenerateAllWalls] subgroup key=${key.slice(0, 12)} ${isShared ? "SHARED" : "exterior"} ` +
            `axis=(${ax0[0].toFixed(2)},${ax0[2].toFixed(2)})→(${ax1[0].toFixed(2)},${ax1[2].toFixed(2)}) ` +
            `len=${axLen.toFixed(3)} pieces=${pieces.length}` +
            (intersectingCols.length > 0 ? ` (cols=${intersectingCols.length})` : ""),
        );
    }
    // eslint-disable-next-line no-console
    console.log(
        `[regenerateAllWalls] created ${createdWallCount} walls (${sharedGroups} shared) ` +
        `from ${works.length} polys`,
    );

    // ── 8. Wire wallIds + sharedEdgeIds into each polygon's new outer ─
    for (const rebuild of polyRebuilds) {
        const wi = rebuild.workIdx;
        const oldEdgeCount = works[wi].workingEdges.length;
        for (let ei = 0; ei < oldEdgeCount; ei++) {
            const subs = perEdgeSubs[wi][ei];
            const newEdgeIdxList = rebuild.oldEdgeToNewEdges[ei];
            if (subs.length === 0) continue;
            for (let k = 0; k < subs.length; k++) {
                const sub = subs[k];
                const key = groupKey(sub.clusterIdx, sub.tA, sub.tB);
                const wids = groupWallIds.get(key) ?? [];
                const canonicalWid = wids[0];
                const sharedId = groupSharedEdgeId.get(key);
                if (k < newEdgeIdxList.length) {
                    if (canonicalWid) rebuild.newWallIds[newEdgeIdxList[k]] = canonicalWid;
                    if (!rebuild.newWallsPerEdge) {
                        rebuild.newWallsPerEdge = rebuild.newWallIds.map(() => []);
                    }
                    rebuild.newWallsPerEdge[newEdgeIdxList[k]] = wids;
                    if (sharedId) rebuild.newSharedEdgeIds[newEdgeIdxList[k]] = sharedId;
                }
            }
        }
    }

    // ── 8.1. 曲線 (Arc / Circle) 由来の連続 edge を 1 wall にグループ化 ──
    // 対象:
    //   (a) poly.shape?.type === "circle" の場合: 全 new edge を 1 グループに
    //       (wallRegenerate が circleAngleDeg で再テッセレートするので edge
    //        数は元の 128 と一致しないが、すべて同じ円周なので 1 wall でよい)
    //   (b) それ以外で poly.edgeOwners が設定: 所有 entity が ArcEntity の
    //       連続 edge 群を canonical wall に統合
    // canonical (= 最初の) wall に footprint を統合し、他の wall element は
    // 削除。polygon の wallsPerEdge / wallIds 内の該当 index も canonical
    // wallId に書き換える。
    const liveElementsForArc = useAppState.getState().elements;
    for (const rebuild of polyRebuilds) {
        const wi = rebuild.workIdx;
        const work = works[wi];
        const poly = work.poly;
        const space = work.room;
        const newCount = rebuild.newEdges.length;
        const N = newCount;

        type Group = { startEi: number; endEi: number; ownerId: string };
        const groups: Group[] = [];

        if (poly.shape?.type === "circle") {
            // (a) 円 polygon は全 edge 1 グループ。
            if (N >= 2) {
                const ownerId = poly.edgeOwners?.[0] ?? "";
                groups.push({ startEi: 0, endEi: N - 1, ownerId });
            }
        } else if (poly.edgeOwners && poly.edgeOwners.length === rebuild.oldEdgeToNewEdges.length) {
            // (b) 弧 (ArcEntity 由来) の連続 edge を 1 wall に統合し、curved
            //     footprint で「分割されていない」見た目にする。実体はポリ
            //     ライン近似の chord 列 (= IFC 出力等で多角形として扱える)
            //     だが、表示は弧として一体化する。旧 → 新 edge マッピング。
            const newOwners = new Array<string>(N).fill("");
            for (let oi = 0; oi < poly.edgeOwners.length; oi++) {
                for (const ne of rebuild.oldEdgeToNewEdges[oi]) {
                    if (ne >= 0 && ne < N) newOwners[ne] = poly.edgeOwners[oi];
                }
            }
            const entById = new Map<string, any>();
            for (const e of space.entities ?? []) entById.set(e.id, e);
            const isArcOwner = (oid: string) => {
                const e = entById.get(oid);
                return e && e.kind === "arc";
            };
            const visited = new Array<boolean>(N).fill(false);
            for (let i = 0; i < N; i++) {
                if (visited[i]) continue;
                const oid = newOwners[i];
                if (!isArcOwner(oid)) continue;
                let start = i;
                if (!rebuild.isOpen) {
                    let prev = (start - 1 + N) % N;
                    while (!visited[prev] && newOwners[prev] === oid && prev !== i) {
                        start = prev;
                        prev = (start - 1 + N) % N;
                    }
                }
                let end = start;
                for (;;) {
                    visited[end] = true;
                    const next = rebuild.isOpen
                        ? (end + 1 < N ? end + 1 : -1)
                        : ((end + 1) % N);
                    if (next < 0 || visited[next]) break;
                    if (newOwners[next] !== oid) break;
                    end = next;
                }
                const len = rebuild.isOpen
                    ? end - start + 1
                    : (end >= start ? end - start + 1 : (N - start) + end + 1);
                if (len < 2) continue;
                groups.push({ startEi: start, endEi: end, ownerId: oid });
            }
        }

        if (groups.length === 0) continue;

        // 各 group: canonical wall を決め、footprint を統合し、redundant walls を削除。
        const removeWallIds = new Set<string>();
        for (const g of groups) {
            // group 内の new edge index 列挙。
            const idxList: number[] = [];
            if (rebuild.isOpen || g.endEi >= g.startEi) {
                for (let i = g.startEi; i <= g.endEi; i++) idxList.push(i);
            } else {
                for (let i = g.startEi; i < N; i++) idxList.push(i);
                for (let i = 0; i <= g.endEi; i++) idxList.push(i);
            }
            // 各 edge の wallId を取得。
            const widList = idxList.map((i) => rebuild.newWallIds[i]).filter((s) => !!s);
            if (widList.length === 0) continue;
            const canonical = widList[0];
            // 残りを削除リストへ。
            for (let k = 1; k < widList.length; k++) {
                if (widList[k] !== canonical) removeWallIds.add(widList[k]);
            }
            // newWallIds[i] を canonical に書き換え。
            for (const i of idxList) rebuild.newWallIds[i] = canonical;
            // 統合 footprint を作る: 各 edge の hexagon を取り inner / outer を
            // 順に並べて curved 矩形を組み立てる。
            //   hex = [innerPrev, s, outerPrev, outerNext, e, innerNext]
            // 連続 edge 間で innerNext_i ≈ innerPrev_{i+1}、outerNext_i ≈
            // outerPrev_{i+1} なので重複は中点で吸収する。
            const innerPath: Vec2[] = [];
            const outerPath: Vec2[] = [];
            const polyForHex: RoomPolygon = {
                ...poly,
                outer: rebuild.newOuter,
                edges: rebuild.isOpen
                    ? rebuild.newEdges.map(([a, b]) => [a, b] as [number, number])
                    : undefined,
                wallThickness,
                innerThickness: innerT,
                outerThickness: outerT,
                wallReference,
            };
            for (let k = 0; k < idxList.length; k++) {
                const ei = idxList[k];
                const hex = computeWallHexagon(polyForHex, ei);
                if (!hex) continue;
                const [iPrev, s, oPrev, oNext, e, iNext] = hex.vertices;
                if (k === 0) {
                    innerPath.push([iPrev[0], iPrev[1]] as Vec2);
                    outerPath.push([oPrev[0], oPrev[1]] as Vec2);
                }
                innerPath.push([iNext[0], iNext[1]] as Vec2);
                outerPath.push([oNext[0], oNext[1]] as Vec2);
                void s; void e;
            }
            // ─ Footprint 構築 ─
            // 閉ループ全体を覆うグループ (= circle 由来) は **annulus** (= 外
            // 周 + 内周ホール) として保存する必要がある。outer ring CCW、inner
            // ring を CW (hole) として持たせる。
            // 開グループ (= arc 一部) は **simply-connected curved rectangle**
            // = inner + 逆順 outer を連結した単一 ring。
            const isClosedFullLoop =
                !rebuild.isOpen && idxList.length === N;
            let footprint: Vec2[] = [];
            let footprintHoles: Vec2[][] | undefined;
            if (isClosedFullLoop) {
                // 末尾と先頭が同点になっているので末尾を 1 個削る。
                const innerRing = innerPath.slice(0, -1);
                const outerRing = outerPath.slice(0, -1);
                // 外周は CCW、ホールは CW。元の innerPath / outerPath は
                // ポリゴンの edge 巡回順 (CCW) で並んでいる。outer ring (室外
                // 側) はそのままでは CW のことが多いので signed area で判定。
                const signedArea = (ring: Vec2[]): number => {
                    let s = 0;
                    for (let i = 0; i < ring.length; i++) {
                        const a = ring[i], b = ring[(i + 1) % ring.length];
                        s += a[0] * b[1] - b[0] * a[1];
                    }
                    return s / 2;
                };
                let outerCCW = signedArea(outerRing) > 0
                    ? outerRing : [...outerRing].reverse();
                let innerCW = signedArea(innerRing) < 0
                    ? innerRing : [...innerRing].reverse();
                footprint = outerCCW;
                footprintHoles = [innerCW];
            } else {
                // CCW: inner 順に並べた後 outer を逆順で連結。
                const merged: Vec2[] = [...innerPath];
                for (let i = outerPath.length - 1; i >= 0; i--) merged.push(outerPath[i]);
                footprint = merged;
            }
            // canonical wall の footprint を更新。
            const w = liveElementsForArc[canonical];
            if (w) {
                updateElement(canonical, {
                    footprint,
                    footprintHoles,
                    dirtyFlags: new Set([...(w.dirtyFlags ?? []), "Geometry", "Mesh", "Render"]),
                } as any);
            }
        }
        // 削除リストの wall を消す。
        for (const wid of removeWallIds) {
            if (liveElementsForArc[wid]) removeElement(wid);
        }
    }

    // ── 8.2. Internal-edge detection (隣接壁の接合面マスク) ───────────
    //
    // 壁同士が L 字 / T 字で接合した部分は、各壁の miter 端 cap が **互いに
    // 完全一致** する (= 壁 A の cap edge と壁 B の cap edge が逆向きで
    // 同じ線分)。このペアは内部接合面で外から見えないので 3D 側面・
    // silhouette edge を生成しないようマスクする。
    //
    // 検出方法: 全壁ペアの footprint edge を端点 5mm tol で比較し、
    // 反転一致 (a.start ≒ b.end かつ a.end ≒ b.start) すれば双方の
    // edge を internal としてマーク。柱で分断された壁の同方向同位置
    // の継ぎ目もここで除去される。
    //
    // 計算量: 壁数 W, 平均 footprint 頂点数 V で O(W² × V²)。典型的な
    // シーン (W=数十、V=4-6) では十分速い。AABB pre-filter を入れれば
    // 線形に近づくが、現状は不要。
    const liveElementsForInternal = useAppState.getState().elements;
    interface WallEdge {
        wallId: ElementId;
        edgeIdx: number;
        a: Vec2;
        b: Vec2;
    }
    const allEdges: WallEdge[] = [];
    for (const elId in liveElementsForInternal) {
        const el = liveElementsForInternal[elId];
        if (!el || el.type !== "Wall") continue;
        const wEl = el as WallElement;
        const fp = wEl.footprint;
        if (!fp || fp.length < 3) continue;
        for (let i = 0; i < fp.length; i++) {
            allEdges.push({
                wallId: elId as ElementId,
                edgeIdx: i,
                a: fp[i],
                b: fp[(i + 1) % fp.length],
            });
        }
    }
    const TOL_INTERNAL = 5e-3; // 5mm — VERTEX_TOL_M と整合
    const eq = (p: Vec2, q: Vec2) =>
        Math.abs(p[0] - q[0]) < TOL_INTERNAL && Math.abs(p[1] - q[1]) < TOL_INTERNAL;
    const internalByWall = new Map<ElementId, Set<number>>();
    for (let i = 0; i < allEdges.length; i++) {
        const ei = allEdges[i];
        for (let j = i + 1; j < allEdges.length; j++) {
            const ej = allEdges[j];
            if (ei.wallId === ej.wallId) continue;
            // 反転一致: ei.a ≒ ej.b かつ ei.b ≒ ej.a
            if (eq(ei.a, ej.b) && eq(ei.b, ej.a)) {
                if (!internalByWall.has(ei.wallId)) internalByWall.set(ei.wallId, new Set());
                if (!internalByWall.has(ej.wallId)) internalByWall.set(ej.wallId, new Set());
                internalByWall.get(ei.wallId)!.add(ei.edgeIdx);
                internalByWall.get(ej.wallId)!.add(ej.edgeIdx);
            }
        }
    }
    // 各壁に internalEdges (boolean[]) を書き戻す。マスク無し壁は undefined のまま。
    for (const [wid, idxSet] of internalByWall) {
        const w = liveElementsForInternal[wid] as WallElement | undefined;
        if (!w || !w.footprint) continue;
        const mask = new Array<boolean>(w.footprint.length).fill(false);
        for (const idx of idxSet) mask[idx] = true;
        updateElement(wid, {
            internalEdges: mask,
            dirtyFlags: new Set([...(w.dirtyFlags ?? []), "Mesh", "Render"]),
        } as any);
    }

    // ── 8.5. Build vertexConnections (cross-polygon vertex incidence) ──
    interface VCEntry {
        polyId: string;
        vertexIdx: number;
        pos: Vec2;
        incidentEdges: number[];
    }
    const vcEntries: VCEntry[] = [];
    for (const rebuild of polyRebuilds) {
        const polyId = works[rebuild.workIdx].poly.id;
        const outerLen = rebuild.newOuter.length;
        const vertexIncidents: number[][] = Array.from({ length: outerLen }, () => []);
        for (let ei = 0; ei < rebuild.newEdges.length; ei++) {
            const [a, b] = rebuild.newEdges[ei];
            vertexIncidents[a].push(ei);
            vertexIncidents[b].push(ei);
        }
        for (let i = 0; i < outerLen; i++) {
            vcEntries.push({
                polyId,
                vertexIdx: i,
                pos: rebuild.newOuter[i],
                incidentEdges: vertexIncidents[i],
            });
        }
    }
    const VERTEX_TOL_M = 0.005;
    const vcClusters: VCEntry[][] = [];
    for (const v of vcEntries) {
        let placed = false;
        for (const c of vcClusters) {
            const ref = c[0];
            if (Math.hypot(v.pos[0] - ref.pos[0], v.pos[1] - ref.pos[1]) < VERTEX_TOL_M) {
                c.push(v);
                placed = true;
                break;
            }
        }
        if (!placed) vcClusters.push([v]);
    }
    type VCList = Array<{ polyId: string; edgeIdx: number }>;
    const vcByPoly = new Map<string, Map<number, VCList>>();
    for (const cluster of vcClusters) {
        if (cluster.length < 2) continue;
        interface Inc { polyId: string; edgeIdx: number; }
        const incidents: Inc[] = [];
        for (const m of cluster) {
            for (const ei of m.incidentEdges) {
                incidents.push({ polyId: m.polyId, edgeIdx: ei });
            }
        }
        for (const m of cluster) {
            const seen = new Set<string>();
            const list: VCList = [];
            for (const inc of incidents) {
                if (inc.polyId === m.polyId) continue;
                const k = `${inc.polyId}:${inc.edgeIdx}`;
                if (seen.has(k)) continue;
                seen.add(k);
                list.push(inc);
            }
            if (list.length === 0) continue;
            if (!vcByPoly.has(m.polyId)) vcByPoly.set(m.polyId, new Map());
            vcByPoly.get(m.polyId)!.set(m.vertexIdx, list);
        }
    }

    // ── 9. Push polygon updates per room ─────────────────────────────
    // 重要: ストアの最新を直接読む。`elements` スナップショットには SketchSolver
    // (非同期) の writeback が反映されておらず、その間に polygon の参照が新しい
    // オブジェクトに差し替わっている可能性がある。`work.poly === poly` での参照
    // 一致チェックは race condition で偽になり、ポリゴンを silent drop して
    // 部屋自体が消える原因になっていた。ここでは polyId 単位で rebuild を引き、
    // 一致すれば必ず置き換える (= 部屋を失わない) ようにする。
    const rebuildByPolyId = new Map<string, PolyRebuild>();
    for (const r of polyRebuilds) rebuildByPolyId.set(works[r.workIdx].poly.id, r);
    const roomIds = new Set<ElementId>();
    for (const w of works) roomIds.add(w.roomId);
    const liveElements = useAppState.getState().elements;
    for (const rid of roomIds) {
        const space = (liveElements[rid] ?? elements[rid]) as SpaceElement | undefined;
        if (!space) continue;
        const updatedPolys: RoomPolygon[] = [];
        for (const poly of space.polygons) {
            if (staleOutlineIds.has(poly.id)) continue;
            const rebuild = rebuildByPolyId.get(poly.id);
            if (!rebuild) { updatedPolys.push(poly); continue; }
            const { edges: _legacyEdges, ...rest } = poly;
            void _legacyEdges;
            const polyVCons = vcByPoly.get(poly.id);
            const newVertexConnections: (Array<{ polyId: string; edgeIdx: number }> | null)[] =
                new Array(rebuild.newOuter.length).fill(null);
            if (polyVCons) {
                for (const [vi, list] of polyVCons) {
                    if (vi >= 0 && vi < newVertexConnections.length) {
                        newVertexConnections[vi] = list;
                    }
                }
            }
            // 柱分断で 1 edge に複数 wall がある場合は newWallsPerEdge から、
            // それ以外は canonical 1 件を [id] で包んで wallsPerEdge を構築。
            const wallsPerEdge: string[][] = rebuild.newWallIds.map(
                (id, i) => {
                    const list = rebuild.newWallsPerEdge?.[i];
                    if (list && list.length > 0) return list;
                    return id ? [id] : [];
                },
            );
            const explicitEdges: [number, number][] | undefined = rebuild.isOpen
                ? rebuild.newEdges.map(([a, b]) => [a, b] as [number, number])
                : undefined;
            // edgeOwners を旧 → 新マッピングで引き継ぐ。oldEdgeToNewEdges[oi]
            // 内の全ての new edge は old edge oi の owner を継承する。
            // 元 polygon の outer 長と oldEdgeToNewEdges の length が一致するのは
            // 「閉ループで edges 未設定 = cyclic」のケース。`workingEdges` は
            // collapseCollinear で頂点が減っている可能性がある (= 旧 edge 数の
            // 方が多い)。長さ不一致時は edgeOwners を破棄して 1 wall/1 edge に
            // フォールバック。
            let newEdgeOwners: string[] | undefined;
            const oldOwners = (poly as RoomPolygon).edgeOwners;
            if (poly.shape?.type === "circle") {
                // Circle polygon は wallRegenerate で circleAngleDeg ベースの
                // 別 tessellation に置き換わるので edge 長は元と一致しない。
                // 全 edge は単一 CircleEntity 由来なので owner を一律で割り当てる。
                const circleEntityId = oldOwners?.[0];
                if (circleEntityId) {
                    newEdgeOwners = new Array(rebuild.newEdges.length).fill(circleEntityId);
                }
            } else if (oldOwners && oldOwners.length === rebuild.oldEdgeToNewEdges.length) {
                newEdgeOwners = new Array(rebuild.newEdges.length).fill("");
                for (let oi = 0; oi < oldOwners.length; oi++) {
                    for (const newEi of rebuild.oldEdgeToNewEdges[oi]) {
                        if (newEi >= 0 && newEi < newEdgeOwners.length) {
                            newEdgeOwners[newEi] = oldOwners[oi];
                        }
                    }
                }
            }
            updatedPolys.push({
                ...rest,
                outer: rebuild.newOuter,
                edges: explicitEdges,
                wallIds: rebuild.newWallIds,
                wallsPerEdge,
                wallThickness,
                innerThickness: innerT,
                outerThickness: outerT,
                wallReference,
                edgeIds: rebuild.newEdgeIds,
                sharedEdgeIds: rebuild.newSharedEdgeIds,
                vertexConnections: newVertexConnections,
                edgeOwners: newEdgeOwners,
            });
        }
        updateElement(rid, {
            polygons: updatedPolys,
            dirtyFlags: new Set([...space.dirtyFlags, "Geometry", "Mesh", "Render"]),
        } as any);
        // 診断: 各部屋の polygon 最終状態をダンプ。Room 1 が崩れた症状の
        // 切り分け用。post-collapse 後の outer / wallIds の長さが一致して
        // いるか、wallIds に空文字が残っていないかを確認する。
        for (const p of updatedPolys) {
            if (p.wallOutlineOf) continue;
            const wallIdsLen = (p.wallIds ?? []).length;
            const wpeLen = (p.wallsPerEdge ?? []).length;
            const filled = (p.wallIds ?? []).filter(Boolean).length;
            // eslint-disable-next-line no-console
            console.log(
                `[wallRegen/§9] poly=${p.id.slice(0, 6)} room=${(rid as string).slice(0, 6)} ` +
                `outer=${p.outer.length} wallIds=${wallIdsLen}(filled=${filled}) ` +
                `wallsPerEdge=${wpeLen} thickness=${p.wallThickness}`,
            );
        }
    }

    // ── 10. Re-add Horizontal / Vertical on modified polys ───────────
    const AXIS_DOT_TOL = Math.cos((2 * Math.PI) / 180);
    for (const rebuild of polyRebuilds) {
        if (!rebuild.modified) continue;
        const polyId = works[rebuild.workIdx].poly.id;
        const spaceId = works[rebuild.workIdx].roomId;
        const newOuter = rebuild.newOuter;
        for (let ei = 0; ei < rebuild.newEdges.length; ei++) {
            const [aIdx, bIdx] = rebuild.newEdges[ei];
            const a = newOuter[aIdx];
            const b = newOuter[bIdx];
            const dx = b[0] - a[0], dy = b[1] - a[1];
            const len = Math.hypot(dx, dy);
            if (len < 1e-9) continue;
            const ax = Math.abs(dx / len), ay = Math.abs(dy / len);
            let type: "Horizontal" | "Vertical" | null = null;
            if (ax >= AXIS_DOT_TOL) type = "Horizontal";
            else if (ay >= AXIS_DOT_TOL) type = "Vertical";
            if (!type) continue;
            executeCommand(new AddConstraintCommand({
                id: generateConstraintId(),
                type,
                targets: [{ kind: "SketchEdge", spaceId, polyId, edgeIdx: ei }],
            }));
        }
    }

    if (debug) {
        // eslint-disable-next-line no-console
        console.log(
            `[Walls/all] rooms=${roomIds.size} polys=${works.length} ` +
            `walls=${subGroups.size} shared=${sharedGroups} ` +
            `modifiedPolys=${modifiedPolyIds.size}`,
        );

        // eslint-disable-next-line no-console
        console.group("[Walls/debug] Vertex clusters");
        let multiCount = 0;
        for (const c of vcClusters) {
            if (c.length < 2) continue;
            multiCount++;
            const pos = `(${c[0].pos[0].toFixed(3)}, ${c[0].pos[1].toFixed(3)})`;
            const members = c
                .map((m) => `${m.polyId.slice(0, 6)}/v${m.vertexIdx}`)
                .join(", ");
            // eslint-disable-next-line no-console
            console.log(`${pos} size=${c.length} members=[${members}]`);
        }
        // eslint-disable-next-line no-console
        console.log(
            `total clusters=${vcClusters.length}, multi-member=${multiCount}`,
        );
        // eslint-disable-next-line no-console
        console.groupEnd();

        const dbgState = useAppState.getState();
        const dbgLookup = (polyId: string): RoomPolygon | undefined => {
            for (const eid in dbgState.elements) {
                const ee = dbgState.elements[eid];
                if (!ee || ee.type !== "Space") continue;
                const sp = ee as SpaceElement;
                const f = sp.polygons?.find((p) => p.id === polyId);
                if (f) return f;
            }
            return undefined;
        };
        // eslint-disable-next-line no-console
        console.group("[Walls/debug] Per-edge hex computation");
        for (const rebuild of polyRebuilds) {
            const polyId = works[rebuild.workIdx].poly.id;
            const updPoly = dbgLookup(polyId);
            if (!updPoly) {
                // eslint-disable-next-line no-console
                console.warn(`poly ${polyId.slice(0, 6)} not found in state`);
                continue;
            }
            // eslint-disable-next-line no-console
            console.group(
                `poly=${polyId.slice(0, 6)} verts=${updPoly.outer.length}`,
            );
            for (let ei = 0; ei < updPoly.outer.length; ei++) {
                computeWallHexagon(updPoly, ei, dbgLookup, true);
            }
            // eslint-disable-next-line no-console
            console.groupEnd();
        }
        // eslint-disable-next-line no-console
        console.groupEnd();
    }
}
