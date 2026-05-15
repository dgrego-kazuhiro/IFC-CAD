/**
 * Junction-graph パイプライン: 全壁生成のための 2D 解析。
 *
 * 入力: `RoomPolygon[]` (= 全部屋の outer ring 群)
 * 出力: `Junction[]` + `VirtualEdge[]` の有向情報、各仮想エッジには両端での
 *      3 点 (外オフセット / 端点 / 内オフセット) が確定済み。
 *
 * パイプライン:
 *   1. Build  : 元 polygon outer 頂点 + 共線重なりの開始/終了点を junction
 *               候補として展開、5mm tolerance でクラスタ化。各 polygon edge を
 *               junction で分割して仮想エッジを生成。
 *   2. Resolve: 各 junction で incident 仮想エッジに対して 3 点を確定する。
 *               優先順位:
 *                  (a) 共線ペア (180°)         → perpendicular fallback
 *                  (b) 同一 polygon ペア (L)   → inner-inner / outer-outer miter
 *                  (c) 残り (cross-polygon stem) → Clipper diff
 *   3. Caps   : 仮想エッジの両端で 3 点が未確定なら自由端として垂直キャップ。
 *               元 polygon edge と紐付かず両端ともに確定無しなら単純矩形。
 *
 * 出力の `VirtualEdge.footprint` は CCW の Vec2[] で、後段の `WallElement
 * .footprint` にそのまま代入される。
 */

import polygonClipping, { type Pair, type Ring } from "polygon-clipping";
import { Vec2 } from "../../geometry/math/Vec2";
import { RoomPolygon, resolveWallThicknesses, polygonEdges } from "../../model/elements/SpaceElement";

// ─── Per-edge thickness map ────────────────────────────────────────────────
//
// Phase 2: ポリゴン共通の wallThickness ではなく **エッジ単位** の inner/outer
// 厚さを JunctionGraph に流し込むためのマップ。`wallRegenerate` が既存壁の
// `thickness` / `innerThickness` / `outerThickness` から組み立てる。
//
// veThickness / veOffsetLines は、まずこのマップを引いて見つかったらそれを
// 採用、無ければ従来通り `resolveWallThicknesses(poly)` (= ポリゴン共通) に
// フォールバックする。これでユーザが ChangeElementTypeCommand で 1 本だけ
// 厚さを変えた壁が、隣接壁とは違う厚さで接合される。Clipper diff (step c)
// は ve ごとの rect で動くため、異厚さの突き合わせも自然に吸収する。
//
// key: `${polyId}:${edgeIdx}` (= 元 polygon edge 単位)。
export type EdgeThicknessMap = Map<string, { inner: number; outer: number }>;
const edgeThicknessKey = (polyId: string, edgeIdx: number): string =>
    `${polyId}:${edgeIdx}`;
export function makeEdgeThicknessKey(polyId: string, edgeIdx: number): string {
    return edgeThicknessKey(polyId, edgeIdx);
}
import {
    edgeOffsetLines,
    intersectLines,
    type EdgeOffsetLines,
    type Line2,
} from "../../geometry/wall/EdgeGeometry";

// ─── Types ─────────────────────────────────────────────────────────────────

/** 交差点。同じ 2D 位置 (5mm tol) に集まった頂点の代表。 */
export interface Junction {
    id: string;
    pos: Vec2;
    /** ここに接続する仮想エッジへの参照。`endIdx` は仮想エッジの始点 (0)
     *  か終点 (1) か。 */
    incidents: Array<{ veId: string; endIdx: 0 | 1 }>;
}

/** 仮想エッジ。元 polygon edge を junction で分割した 1 セグメント。
 *  分割が起きない場合も 1 仮想エッジとして扱う (= 元 edge と 1:1)。 */
export interface VirtualEdge {
    id: string;
    sourcePolyId: string;
    sourceEdgeIdx: number;
    /** 仮想エッジの始点・終点 (XZ)。元 edge の方向 (s→e) を継承する。 */
    start: Vec2;
    end: Vec2;
    /** 始点が junction 上にあるならその id。`null` なら自由端。 */
    startJunctionId: string | null;
    endJunctionId: string | null;
    /** 共線重なり区間内の仮想エッジなら true。 */
    isShared: boolean;

    // ── resolve 後に書き込まれる 3 点 × 両端 ───────────────────────
    /** 始点側の 3 点 (CCW: outer → start → inner)。 */
    startCorners?: { outer: Vec2; junction: Vec2; inner: Vec2 };
    /** 終点側の 3 点 (CCW: outer → end → inner)。 */
    endCorners?: { outer: Vec2; junction: Vec2; inner: Vec2 };
}

export interface JunctionGraph {
    junctions: Map<string, Junction>;
    virtualEdges: Map<string, VirtualEdge>;
    /** 元 polygon edge → 派生仮想エッジ ID の配列 (順序付き)。
     *  キー = `${polyId}:${edgeIdx}`。 */
    edgeToVes: Map<string, string[]>;
}

/**
 * 同一レベル上に置かれた柱の 2D 床面フットプリント (XZ, CCW)。
 * `resolveJunctions` に渡すと、柱が交差点を覆う場合に壁矩形から
 * Clipper diff で柱形状を差し引き、壁端を柱面で切り落とす。
 */
export interface ColumnFootprint {
    id: string;
    /** XZ 平面、CCW。`polygon-clipping` の被クリップ形状として作用する。 */
    points: Vec2[];
}

// ─── Constants ─────────────────────────────────────────────────────────────

const VERTEX_TOL_M = 0.005; // 5mm — 既存 RoomEditPanel の vertexConnections 構築と同じ
const COLLINEAR_DOT = Math.cos(2 * Math.PI / 180); // 2° tol
const COLLINEAR_PERP_TOL = 0.005; // 5mm — 共線判定の perpendicular distance
const ON_LINE_TOL = 1e-4; // 0.1 mm — Clipper 結果からの 3 点抽出時に line 上判定

const JUNCTION_GRAPH_DEBUG = false;
const fmt = (v: Vec2) => `(${v[0].toFixed(3)},${v[1].toFixed(3)})`;
const fmtA = (deg: number) => `${deg.toFixed(1)}°`;

// ─── ID generation ─────────────────────────────────────────────────────────

let _junctionCounter = 0;
const newJunctionId = () => `J_${(++_junctionCounter).toString(36)}`;
let _veCounter = 0;
const newVirtualEdgeId = () => `VE_${(++_veCounter).toString(36)}`;

// ─── Geometry helpers ──────────────────────────────────────────────────────

const dist2 = (a: Vec2, b: Vec2): number =>
    (a[0] - b[0]) * (a[0] - b[0]) + (a[1] - b[1]) * (a[1] - b[1]);

const distance = (a: Vec2, b: Vec2): number =>
    Math.hypot(a[0] - b[0], a[1] - b[1]);

const pointLineDist = (p: Vec2, l: Line2): number => {
    const len = Math.hypot(l.dx, l.dy);
    if (len < 1e-12) return Infinity;
    return Math.abs(((p[0] - l.px) * (-l.dy) + (p[1] - l.py) * l.dx)) / len;
};

/** EdgeOffsetLines から壁本体の 4 頂点矩形 (CCW) を取り出す。 */
const rectFromEdge = (el: EdgeOffsetLines): Vec2[] => {
    const sx = el.axis.px, sy = el.axis.py;
    const ex = sx + el.dir[0] * el.length;
    const ey = sy + el.dir[1] * el.length;
    const tIn  = (el.inner.px - el.axis.px) * el.nIn[0]
               + (el.inner.py - el.axis.py) * el.nIn[1];
    const tOut = (el.outer.px - el.axis.px) * el.nOut[0]
               + (el.outer.py - el.axis.py) * el.nOut[1];
    return [
        [sx + el.nIn[0]  * tIn,  sy + el.nIn[1]  * tIn],
        [sx + el.nOut[0] * tOut, sy + el.nOut[1] * tOut],
        [ex + el.nOut[0] * tOut, ey + el.nOut[1] * tOut],
        [ex + el.nIn[0]  * tIn,  ey + el.nIn[1]  * tIn],
    ];
};

/** Junction-extended rect: junction で終端する側を「phantom」に延長した壁矩形。
 *  step (c) Clipper diff の accumulatedClips にこれを積むことで、ある ve が
 *  junction で終わっていても、相手側 ve から見ると **「壁が junction を超えて
 *  反対側にも続いている」** ように clip される。これで非対称 L コーナー
 *  (= 太壁が junction で終わり、細壁が直交して終わる) で細壁の終端が
 *  「太壁のあった側 / 無かった側」で違う位置で切られて斜面になる現象を防ぐ。
 *
 *  endIdxAtJunction = 0: ve.start が junction にある (= ve は junction から
 *      離れる方向に伸びる) → start を逆方向に延長
 *  endIdxAtJunction = 1: ve.end が junction にある (= ve は junction で
 *      終わる) → end を順方向に延長
 *
 *  延長距離は壁長 + 任意定数 (= 1000m) で「遠方まで」伸ばす。chain pair の
 *  ように両方向の ve が積まれる場合は元々両側カバーされるので、延長分が
 *  オーバーラップするだけで結果は同じ。 */
const PHANTOM_EXT = 1000;
const extendedRectFromEdge = (
    el: EdgeOffsetLines, endIdxAtJunction: 0 | 1,
): Vec2[] => {
    const tIn  = (el.inner.px - el.axis.px) * el.nIn[0]
               + (el.inner.py - el.axis.py) * el.nIn[1];
    const tOut = (el.outer.px - el.axis.px) * el.nOut[0]
               + (el.outer.py - el.axis.py) * el.nOut[1];
    let sx = el.axis.px, sy = el.axis.py;
    let ex = sx + el.dir[0] * el.length;
    let ey = sy + el.dir[1] * el.length;
    if (endIdxAtJunction === 0) {
        // ve は junction を起点に伸びる → start を後方 (= junction の反対側) へ延長
        sx -= el.dir[0] * PHANTOM_EXT;
        sy -= el.dir[1] * PHANTOM_EXT;
    } else {
        // ve は junction で終わる → end を前方 (= junction の反対側) へ延長
        ex += el.dir[0] * PHANTOM_EXT;
        ey += el.dir[1] * PHANTOM_EXT;
    }
    return [
        [sx + el.nIn[0]  * tIn,  sy + el.nIn[1]  * tIn],
        [sx + el.nOut[0] * tOut, sy + el.nOut[1] * tOut],
        [ex + el.nOut[0] * tOut, ey + el.nOut[1] * tOut],
        [ex + el.nIn[0]  * tIn,  ey + el.nIn[1]  * tIn],
    ];
};

/** 仮想エッジの方向ベクトル (始点 → 終点)。 */
const veDir = (ve: VirtualEdge): Vec2 => {
    const dx = ve.end[0] - ve.start[0];
    const dy = ve.end[1] - ve.start[1];
    const len = Math.hypot(dx, dy) || 1;
    return [dx / len, dy / len];
};

/** 元エッジの内側 (CCW で +90°) 法線厚さ / 外側厚さ。
 *  Phase 2: edgeThicknessMap が指定されていれば **per-edge** の厚さを優先する。
 *  無ければ従来通りポリゴン共通の `resolveWallThicknesses` を使う。 */
const veThickness = (
    ve: VirtualEdge,
    polyById: Map<string, RoomPolygon>,
    edgeThicknessMap?: EdgeThicknessMap,
): { inner: number; outer: number } => {
    if (edgeThicknessMap) {
        const t = edgeThicknessMap.get(edgeThicknessKey(ve.sourcePolyId, ve.sourceEdgeIdx));
        if (t) return t;
    }
    const poly = polyById.get(ve.sourcePolyId);
    if (!poly) return { inner: 0, outer: 0 };
    return resolveWallThicknesses(poly);
};

/** 仮想エッジから offset lines を作る (元 edge の幾何のうち、ve の axis に
 *  揃えた線として再構築)。元 polygon の +90° / -90° 法線方向を踏襲する。
 *  Phase 2: edgeThicknessMap が渡されていれば per-edge の厚さで offset を作る
 *  (= 隣接エッジが違う Type / 厚さでも独立に offset 線が引ける)。 */
const veOffsetLines = (
    ve: VirtualEdge,
    polyById: Map<string, RoomPolygon>,
    edgeThicknessMap?: EdgeThicknessMap,
): EdgeOffsetLines | null => {
    const poly = polyById.get(ve.sourcePolyId);
    if (!poly) return null;
    const dx = ve.end[0] - ve.start[0];
    const dy = ve.end[1] - ve.start[1];
    const len = Math.hypot(dx, dy);
    if (len < 1e-9) return null;
    const ux = dx / len, uy = dy / len;
    const nInX = -uy, nInY = ux;
    const nOutX = uy, nOutY = -ux;
    let tIn: number; let tOut: number;
    const perEdge = edgeThicknessMap?.get(edgeThicknessKey(ve.sourcePolyId, ve.sourceEdgeIdx));
    if (perEdge) {
        tIn = perEdge.inner; tOut = perEdge.outer;
    } else {
        const r = resolveWallThicknesses(poly);
        tIn = r.inner; tOut = r.outer;
    }
    const mx = (ve.start[0] + ve.end[0]) / 2;
    const my = (ve.start[1] + ve.end[1]) / 2;
    return {
        dir: [ux, uy],
        axis:  { px: ve.start[0], py: ve.start[1], dx: ux, dy: uy },
        inner: { px: mx + nInX  * tIn,  py: my + nInY  * tIn,  dx: ux, dy: uy },
        outer: { px: mx + nOutX * tOut, py: my + nOutY * tOut, dx: ux, dy: uy },
        nIn:  [nInX, nInY],
        nOut: [nOutX, nOutY],
        length: len,
    };
};

// ─── Build phase ───────────────────────────────────────────────────────────

interface RawEdge {
    polyId: string;
    edgeIdx: number;
    /** outer index of edge start vertex. */
    sIdx: number;
    /** outer index of edge end vertex. */
    eIdx: number;
    s: Vec2;
    e: Vec2;
}

interface VertexCluster {
    pos: Vec2;
    members: Array<{ polyId: string; vertexIdx: number }>;
}

/** outer 頂点を 5mm tolerance でクラスタ化する。各クラスタの代表座標は
 *  メンバーの平均ではなく **最初に見つかった頂点** を採用 (再現性のため)。 */
function clusterVertices(
    polygons: RoomPolygon[],
): { clusters: VertexCluster[]; lookup: Map<string, VertexCluster> } {
    const clusters: VertexCluster[] = [];
    const lookup = new Map<string, VertexCluster>(); // key = `${polyId}:${vertexIdx}`
    for (const poly of polygons) {
        for (let vi = 0; vi < poly.outer.length; vi++) {
            const p = poly.outer[vi];
            let placed: VertexCluster | null = null;
            for (const c of clusters) {
                if (distance(c.pos, p) < VERTEX_TOL_M) { placed = c; break; }
            }
            if (!placed) {
                placed = { pos: [p[0], p[1]], members: [] };
                clusters.push(placed);
            }
            placed.members.push({ polyId: poly.id, vertexIdx: vi });
            lookup.set(`${poly.id}:${vi}`, placed);
        }
    }
    return { clusters, lookup };
}

/** すべてのクラスタを junction として登録する。単一ポリゴンの corner も
 *  同部屋ペア (= polygon prev/next) の miter を適用するため必須。
 *  共線重なりの境界点は後段で追加 junction として挿入される。 */
function clustersToJunctions(
    clusters: VertexCluster[],
): { junctions: Map<string, Junction>; vertexToJunctionId: Map<string, string> } {
    const junctions = new Map<string, Junction>();
    const vertexToJunctionId = new Map<string, string>();
    for (const c of clusters) {
        const id = newJunctionId();
        junctions.set(id, { id, pos: [c.pos[0], c.pos[1]], incidents: [] });
        for (const m of c.members) {
            vertexToJunctionId.set(`${m.polyId}:${m.vertexIdx}`, id);
        }
    }
    return { junctions, vertexToJunctionId };
}

/** 共線重なり判定: A 辺と B 辺が共線で、線分 (s, e) として range が重なっているか。
 *  重なり区間の (start, end) パラメータ (a 辺基準) を返す。 */
interface OverlapInfo {
    /** a 上で重なり区間の開始位置 (0..1)。 */
    aStart: number;
    /** a 上で重なり区間の終了位置 (0..1)。 */
    aEnd: number;
    /** ワールド座標での重なり始点・終点。 */
    startPos: Vec2;
    endPos: Vec2;
}

function classifyOverlap(a: RawEdge, b: RawEdge): OverlapInfo | null {
    const adx = a.e[0] - a.s[0], ady = a.e[1] - a.s[1];
    const aLen = Math.hypot(adx, ady);
    if (aLen < 1e-9) return null;
    const ux = adx / aLen, uy = ady / aLen;
    const nx = -uy, ny = ux;
    const bdx = b.e[0] - b.s[0], bdy = b.e[1] - b.s[1];
    const bLen = Math.hypot(bdx, bdy);
    if (bLen < 1e-9) return null;
    const aTag = `${a.polyId.slice(0, 6)}#${a.edgeIdx}`;
    const bTag = `${b.polyId.slice(0, 6)}#${b.edgeIdx}`;
    // 平行性チェック
    const cross = adx * bdy - ady * bdx;
    const sinTh = Math.abs(cross / (aLen * bLen));
    if (sinTh > Math.sin(2 * Math.PI / 180)) {
        if (JUNCTION_GRAPH_DEBUG) {
            // eslint-disable-next-line no-console
            console.log(
                `[overlap] ${aTag} vs ${bTag} REJECT parallel sin=${sinTh.toFixed(4)}`,
            );
        }
        return null;
    }
    // 垂直距離チェック
    const d1 = Math.abs((b.s[0] - a.s[0]) * nx + (b.s[1] - a.s[1]) * ny);
    const d2 = Math.abs((b.e[0] - a.s[0]) * nx + (b.e[1] - a.s[1]) * ny);
    if (d1 > COLLINEAR_PERP_TOL || d2 > COLLINEAR_PERP_TOL) {
        if (JUNCTION_GRAPH_DEBUG) {
            // eslint-disable-next-line no-console
            console.log(
                `[overlap] ${aTag} vs ${bTag} REJECT perp d1=${d1.toFixed(4)} d2=${d2.toFixed(4)} ` +
                `tol=${COLLINEAR_PERP_TOL.toFixed(4)}`,
            );
        }
        return null;
    }
    // a の axis 上での b の両端のパラメータ
    const t1 = ((b.s[0] - a.s[0]) * ux + (b.s[1] - a.s[1]) * uy) / aLen;
    const t2 = ((b.e[0] - a.s[0]) * ux + (b.e[1] - a.s[1]) * uy) / aLen;
    const bMin = Math.min(t1, t2);
    const bMax = Math.max(t1, t2);
    const oMin = Math.max(0, bMin);
    const oMax = Math.min(1, bMax);
    if (oMax - oMin < VERTEX_TOL_M / aLen) {
        if (JUNCTION_GRAPH_DEBUG) {
            // eslint-disable-next-line no-console
            console.log(
                `[overlap] ${aTag} vs ${bTag} REJECT range b=[${bMin.toFixed(3)},${bMax.toFixed(3)}] ` +
                `clipped=[${oMin.toFixed(3)},${oMax.toFixed(3)}] needLen≥${(VERTEX_TOL_M / aLen).toFixed(4)}`,
            );
        }
        return null;
    }
    if (JUNCTION_GRAPH_DEBUG) {
        // eslint-disable-next-line no-console
        console.log(
            `[overlap] ${aTag} vs ${bTag} OK aRange=[${oMin.toFixed(3)},${oMax.toFixed(3)}] ` +
            `start=${fmt([a.s[0] + adx * oMin, a.s[1] + ady * oMin])} ` +
            `end=${fmt([a.s[0] + adx * oMax, a.s[1] + ady * oMax])}`,
        );
    }
    return {
        aStart: oMin,
        aEnd: oMax,
        startPos: [a.s[0] + adx * oMin, a.s[1] + ady * oMin],
        endPos:   [a.s[0] + adx * oMax, a.s[1] + ady * oMax],
    };
}

/** 共線重なりを探し、その境界点を junction に追加し、各 raw edge を分割
 *  ポイントのリストに変換する (パラメータ t の昇順、両端 0 と 1 を含む)。 */
function detectOverlapsAndSplits(
    rawEdges: RawEdge[],
    junctions: Map<string, Junction>,
    vertexToJunctionId: Map<string, string>,
    polygons: RoomPolygon[],
): {
    /** edgeKey (`polyId:edgeIdx`) → 分割パラメータ列 (0..1)。
     *  各要素は `{ t, junctionId }`。t = 0 と 1 は端点の junction (居れば)。 */
    splits: Map<string, Array<{ t: number; junctionId: string | null }>>;
    /** 共線重なり区間 (両 raw edge の edgeKey ペア) → 重なり区間にいる
     *  ことを示すための識別。ここでは仮想エッジ生成後に isShared を立てる
     *  目的で `Set<edgeKey>` で持つ — 重なり区間の split 範囲は別管理。 */
    sharedEdgeKeys: Set<string>;
    /** edgeKey → 共線重なりが起きた t 区間 [t0, t1] のリスト。
     *  仮想エッジ生成後、(t0, t1] 内に収まる仮想エッジを isShared = true にする。 */
    sharedRanges: Map<string, Array<[number, number]>>;
} {
    const splits = new Map<string, Array<{ t: number; junctionId: string | null }>>();
    const sharedEdgeKeys = new Set<string>();
    const sharedRanges = new Map<string, Array<[number, number]>>();

    // 既存 (端点が junction 上にある) を反映
    for (const re of rawEdges) {
        const key = `${re.polyId}:${re.edgeIdx}`;
        const list: Array<{ t: number; junctionId: string | null }> = [];
        const sjid = vertexToJunctionId.get(`${re.polyId}:${re.sIdx}`);
        list.push({ t: 0, junctionId: sjid ?? null });
        const ejid = vertexToJunctionId.get(`${re.polyId}:${re.eIdx}`);
        list.push({ t: 1, junctionId: ejid ?? null });
        splits.set(key, list);
    }

    // 共線重なりを探す
    for (let i = 0; i < rawEdges.length; i++) {
        for (let j = i + 1; j < rawEdges.length; j++) {
            const a = rawEdges[i];
            const b = rawEdges[j];
            if (a.polyId === b.polyId) continue;
            const ov = classifyOverlap(a, b);
            if (!ov) continue;
            // a と b に分割点を足す
            for (const re of [a, b]) {
                const key = `${re.polyId}:${re.edgeIdx}`;
                sharedEdgeKeys.add(key);
                // re axis 上での重なり境界の t を求める
                const dx = re.e[0] - re.s[0];
                const dy = re.e[1] - re.s[1];
                const lenSq = dx * dx + dy * dy;
                const tOf = (p: Vec2) =>
                    ((p[0] - re.s[0]) * dx + (p[1] - re.s[1]) * dy) / lenSq;
                let tA = tOf(ov.startPos);
                let tB = tOf(ov.endPos);
                let s0 = Math.min(tA, tB);
                let s1 = Math.max(tA, tB);
                s0 = Math.max(0, Math.min(1, s0));
                s1 = Math.max(0, Math.min(1, s1));
                // junction を生成 (重なり境界点)
                const ensureJunction = (pos: Vec2): string => {
                    for (const j of junctions.values()) {
                        if (distance(j.pos, pos) < VERTEX_TOL_M) return j.id;
                    }
                    const id = newJunctionId();
                    junctions.set(id, { id, pos: [pos[0], pos[1]], incidents: [] });
                    return id;
                };
                const startPos: Vec2 = [
                    re.s[0] + dx * s0,
                    re.s[1] + dy * s0,
                ];
                const endPos: Vec2 = [
                    re.s[0] + dx * s1,
                    re.s[1] + dy * s1,
                ];
                const jStart = ensureJunction(startPos);
                const jEnd = ensureJunction(endPos);
                const list = splits.get(key)!;
                // 既存 t 列に s0, s1 を挿入 (重複は捨てる)。
                // 許容誤差は VERTEX_TOL_M (= 5mm) を re axis 長で正規化した
                // 値。これより 1e-6 (= ~1μm) は厳しすぎて、共線重なり計算で
                // 出る FP 誤差 (10^-7 オーダー) を端点重複と判定できず、t≈0
                // / t≈1 付近に「ほぼ同じ位置」のスプリットを 2 重に積んで
                // しまうケースがあった (= len=0 の degenerate VE が誕生)。
                const reLen = Math.sqrt(lenSq);
                const T_MERGE_TOL = reLen > 1e-9
                    ? Math.max(1e-6, VERTEX_TOL_M / reLen)
                    : 1e-6;
                const tryInsert = (t: number, jid: string) => {
                    if (t <= T_MERGE_TOL || t >= 1 - T_MERGE_TOL) return;
                    for (const e of list) if (Math.abs(e.t - t) < T_MERGE_TOL) return;
                    list.push({ t, junctionId: jid });
                };
                tryInsert(s0, jStart);
                tryInsert(s1, jEnd);
                // shared range 記録
                let arr = sharedRanges.get(key);
                if (!arr) { arr = []; sharedRanges.set(key, arr); }
                arr.push([s0, s1]);
            }
        }
    }

    // ── 明示的 T 字接合 (= polygon.joints): スナップ確定の接合情報を最優先で
    //    splits Map に注入する。これがあれば後段の幾何検出 (5mm 距離判定) で
    //    取りこぼしたケース (FP 誤差・斜め) でも確実に T 字 split が入る。
    //
    //    joints[i].vertexIdx の頂点が、target の polyEdge 内部にスナップして
    //    いれば、ターゲット edge の splits に該当 t での split を挿入する。
    //    polyVertex (= 角同士スナップ) は clusterVertices で既に同一 junction
    //    に集約されているため、ここでは何もしなくて良い。
    {
        // edgeKey → rawEdge のルックアップ (geometric も使うので作っておく)。
        const rawByKey = new Map<string, RawEdge>();
        for (const re of rawEdges) rawByKey.set(`${re.polyId}:${re.edgeIdx}`, re);

        for (const sourcePoly of polygons) {
            const joints = sourcePoly.joints ?? [];
            if (joints.length === 0) continue;
            for (const j of joints) {
                if (j.target.kind !== "polyEdge") continue;
                const targetKey = `${j.target.polyId}:${j.target.targetEdgeIdx}`;
                const targetEdge = rawByKey.get(targetKey);
                if (!targetEdge) continue;
                const targetList = splits.get(targetKey);
                if (!targetList) continue;
                const adx = targetEdge.e[0] - targetEdge.s[0];
                const ady = targetEdge.e[1] - targetEdge.s[1];
                const aLenSq = adx * adx + ady * ady;
                const aLen = Math.sqrt(aLenSq);
                if (aLen < 1e-9) continue;
                // joint.target.t は edge の (start→end) 上での 0..1 比率。
                // 端点付近 (5mm 換算) は端点 junction で吸収されるのでスキップ。
                const tEpsilon = VERTEX_TOL_M / aLen;
                let t = j.target.t;
                if (t < tEpsilon || t > 1 - tEpsilon) continue;
                // スナップ元の頂点クラスタ junction id を引く。
                const sourceJid = vertexToJunctionId.get(
                    `${sourcePoly.id}:${j.vertexIdx}`,
                );
                if (!sourceJid) continue;
                // 重複チェック (= 既に近い t が入っていればスキップ)。
                const tEps = 1e-6;
                let dup = false;
                for (const e of targetList) {
                    if (Math.abs(e.t - t) < tEps) { dup = true; break; }
                }
                if (!dup) targetList.push({ t, junctionId: sourceJid });
            }
        }
    }

    // T 字接合の検出: 別ポリゴンの頂点が a の内部 (端点でない 5mm 内) に
    // 乗っているなら、その頂点クラスタの junction id を a の split に挿入。
    // これにより perpendicular な 2 本の壁が T 字に出会うケースで、長い方が
    // junction で分割され、3-incident junction として resolveJunctions の
    // chain-pair / Clipper diff 経路で正しく解決される。
    // (上の joints による明示注入のフォールバック; 重複は exists チェックで弾かれる)
    for (const a of rawEdges) {
        const aKey = `${a.polyId}:${a.edgeIdx}`;
        const aList = splits.get(aKey)!;
        const adx = a.e[0] - a.s[0];
        const ady = a.e[1] - a.s[1];
        const aLenSq = adx * adx + ady * ady;
        const aLen = Math.sqrt(aLenSq);
        if (aLen < 1e-9) continue;
        const tEpsilon = VERTEX_TOL_M / aLen;
        for (const otherPoly of polygons) {
            if (otherPoly.id === a.polyId) continue;
            const N = otherPoly.outer.length;
            for (let vi = 0; vi < N; vi++) {
                const v = otherPoly.outer[vi];
                const t = ((v[0] - a.s[0]) * adx + (v[1] - a.s[1]) * ady) / aLenSq;
                if (t < tEpsilon || t > 1 - tEpsilon) continue;
                const px = a.s[0] + adx * t;
                const py = a.s[1] + ady * t;
                if (Math.hypot(v[0] - px, v[1] - py) > VERTEX_TOL_M) continue;
                const otherJid = vertexToJunctionId.get(`${otherPoly.id}:${vi}`);
                if (!otherJid) continue;
                let exists = false;
                for (const e of aList) {
                    if (Math.abs(e.t - t) < 1e-6) { exists = true; break; }
                }
                if (!exists) aList.push({ t, junctionId: otherJid });
            }
        }
    }

    // 各リストを t 昇順にソート
    for (const list of splits.values()) {
        list.sort((a, b) => a.t - b.t);
    }

    if (JUNCTION_GRAPH_DEBUG) {
        // eslint-disable-next-line no-console
        console.group(`[detectOverlapsAndSplits] splits dump (${splits.size} edges)`);
        // edgeKey でソートして出力 (見やすさのため polyId 単位にまとまる)。
        const keys = [...splits.keys()].sort();
        const reByKey = new Map<string, RawEdge>();
        for (const re of rawEdges) reByKey.set(`${re.polyId}:${re.edgeIdx}`, re);
        for (const key of keys) {
            const list = splits.get(key)!;
            const re = reByKey.get(key);
            const range = sharedRanges.get(key);
            const isShared = sharedEdgeKeys.has(key);
            const tagged = list.map((e) =>
                `t=${e.t.toFixed(3)}${e.junctionId ? `→${e.junctionId}` : ""}`,
            ).join(", ");
            const edgeStr = re ? `${fmt(re.s)}→${fmt(re.e)}` : "(?)";
            const rangeStr = range
                ? ` shared=[${range.map(([a, b]) => `${a.toFixed(3)}–${b.toFixed(3)}`).join(",")}]`
                : "";
            // eslint-disable-next-line no-console
            console.log(
                `${key.slice(0, 12)}${isShared ? " *SHARED*" : ""} ${edgeStr} ` +
                `splits=[${tagged}]${rangeStr}`,
            );
        }
        // eslint-disable-next-line no-console
        console.groupEnd();
    }

    return { splits, sharedEdgeKeys, sharedRanges };
}

/** 仮想エッジを生成し JunctionGraph を組み立てる。 */
export function buildJunctionGraph(polygons: RoomPolygon[]): JunctionGraph {
    _junctionCounter = 0;
    _veCounter = 0;
    if (JUNCTION_GRAPH_DEBUG) {
        // eslint-disable-next-line no-console
        console.group(`[jgraph] build polygons=${polygons.length}`);
        console.log("polygons", polygons)
    }

    // 1. 全 raw edge 列挙。`poly.edges` が明示されていればそれを尊重し
    //    (= 部分的に開いた / 単一エッジのポリゴンに対応)、無ければ
    //    `outer.length` の循環エッジを生成する。
    const rawEdges: RawEdge[] = [];
    for (const poly of polygons) {
        const edges = polygonEdges(poly);
        for (let i = 0; i < edges.length; i++) {
            const [si, ei] = edges[i];
            rawEdges.push({
                polyId: poly.id,
                edgeIdx: i,
                sIdx: si,
                eIdx: ei,
                s: [poly.outer[si][0], poly.outer[si][1]],
                e: [poly.outer[ei][0], poly.outer[ei][1]],
            });
        }
    }

    // 2. 頂点クラスタリング → junction 候補
    const { clusters, lookup: _lookup } = clusterVertices(polygons);
    void _lookup;
    const { junctions, vertexToJunctionId } = clustersToJunctions(clusters);

    // 3. 共線重なり検出 + 分割 t を集める
    const { splits, sharedRanges } = detectOverlapsAndSplits(
        rawEdges,
        junctions,
        vertexToJunctionId,
        polygons,
    );

        if (JUNCTION_GRAPH_DEBUG) {
        // eslint-disable-next-line no-console
        console.log(`splits=${splits}`);
        console.log("sharedRanges", sharedRanges)
    }


    // 4. 仮想エッジ生成
    const virtualEdges = new Map<string, VirtualEdge>();
    const edgeToVes = new Map<string, string[]>();
    for (const re of rawEdges) {
        const key = `${re.polyId}:${re.edgeIdx}`;
        const list = splits.get(key)!;
        const dx = re.e[0] - re.s[0];
        const dy = re.e[1] - re.s[1];
        const sharedRangesForEdge = sharedRanges.get(key) ?? [];
        const veIds: string[] = [];
        for (let k = 0; k < list.length - 1; k++) {
            const a = list[k];
            const b = list[k + 1];
            // 退化区間 (b.t - a.t がほぼ 0) はスキップ。detectOverlapsAndSplits
            // 側で重複端点を吸収する許容誤差を緩めているので通常は発生しないが、
            // 数値的に同じ位置で 2 つの split が積まれた場合の防御。
            if (b.t - a.t < 1e-9) continue;
            const startPos: Vec2 = [re.s[0] + dx * a.t, re.s[1] + dy * a.t];
            const endPos:   Vec2 = [re.s[0] + dx * b.t, re.s[1] + dy * b.t];
            // shared 判定: 仮想エッジの (a.t, b.t) 区間が共線重なり範囲のいずれかに完全包含されるか
            const midT = (a.t + b.t) / 2;
            const isShared = sharedRangesForEdge.some(
                ([t0, t1]) => midT > t0 - 1e-6 && midT < t1 + 1e-6,
            );
            const id = newVirtualEdgeId();
            const ve: VirtualEdge = {
                id,
                sourcePolyId: re.polyId,
                sourceEdgeIdx: re.edgeIdx,
                start: startPos,
                end: endPos,
                startJunctionId: a.junctionId,
                endJunctionId: b.junctionId,
                isShared,
            };
            virtualEdges.set(id, ve);
            veIds.push(id);
            // junction.incidents 更新
            if (a.junctionId) {
                const j = junctions.get(a.junctionId);
                if (j) j.incidents.push({ veId: id, endIdx: 0 });
            }
            if (b.junctionId) {
                const j = junctions.get(b.junctionId);
                if (j) j.incidents.push({ veId: id, endIdx: 1 });
            }
        }
        edgeToVes.set(key, veIds);
    }

    if (JUNCTION_GRAPH_DEBUG) {
        // eslint-disable-next-line no-console
        console.log(
            `[jgraph] built: junctions=${junctions.size} ves=${virtualEdges.size}`,
        );
        for (const j of junctions.values()) {
            if (j.incidents.length < 3) continue; // T 字以上だけ詳細
            // eslint-disable-next-line no-console
            console.log(
                `  J ${j.id} pos=${fmt(j.pos)} incidents=${j.incidents.length}`,
            );
            for (const inc of j.incidents) {
                const ve = virtualEdges.get(inc.veId);
                if (!ve) continue;
                const otherEnd = inc.endIdx === 0 ? ve.end : ve.start;
                const dx = otherEnd[0] - j.pos[0];
                const dy = otherEnd[1] - j.pos[1];
                const len = Math.hypot(dx, dy);
                const angDeg = Math.atan2(dy, dx) * 180 / Math.PI;
                // eslint-disable-next-line no-console
                console.log(
                    `    ve=${ve.id} src=${ve.sourcePolyId.slice(0,6)}#${ve.sourceEdgeIdx} ` +
                    `endIdx=${inc.endIdx} away=${fmtA(angDeg)} len=${len.toFixed(3)}` +
                    `${ve.isShared ? " [SHARED]" : ""}`,
                );
            }
        }
        // eslint-disable-next-line no-console
        console.groupEnd();
    }
    return { junctions, virtualEdges, edgeToVes };
}

// ─── Resolve / Cap (placeholders for Phase 4-5) ────────────────────────────

/** 点が多角形内にあるか判定 (ray cast)。境界上はおおむね内側扱い。 */
function pointInPolygon(p: Vec2, poly: Vec2[]): boolean {
    let inside = false;
    const n = poly.length;
    for (let i = 0, j = n - 1; i < n; j = i++) {
        const xi = poly[i][0], yi = poly[i][1];
        const xj = poly[j][0], yj = poly[j][1];
        const denom = yj - yi;
        if (Math.abs(denom) < 1e-18) continue;
        const intersect =
            ((yi > p[1]) !== (yj > p[1])) &&
            (p[0] < ((xj - xi) * (p[1] - yi)) / denom + xi);
        if (intersect) inside = !inside;
    }
    return inside;
}

/** 各 junction で incident 仮想エッジに対して 3 点を確定する。
 *
 * 優先順位:
 *   (a) 共線ペア (180°)        → perpendicular fallback (= 直線並びキャップ)
 *   (b) 同 polygon ペア (L)     → standard miter (inner-inner / outer-outer)
 *   (c) 残り (cross-polygon stem) → 累積マージ形状に対する Clipper diff
 *
 * 柱が交差点を覆う場合 (`columnFootprints` のいずれかの多角形内に
 * `junction.pos` が入る) は (a)/(b) を抑止し全 incident を (c) に流す。
 * `accumulatedClips` の先頭に柱フットプリントが積まれているので、各壁
 * 矩形は柱面で切り落とされる。
 */
export function resolveJunctions(
    graph: JunctionGraph,
    polygons: RoomPolygon[],
    columnFootprints: ColumnFootprint[] = [],
    edgeThicknessMap?: EdgeThicknessMap,
): void {
    const polyById = new Map(polygons.map((p) => [p.id, p]));

    interface IncidentVE {
        ve: VirtualEdge;
        endIdx: 0 | 1;
        offsets: EdgeOffsetLines;
        dirAway: Vec2;
        angleAway: number;
    }

    if (JUNCTION_GRAPH_DEBUG) {
        // eslint-disable-next-line no-console
        console.group(`[jgraph] resolve junctions=${graph.junctions.size}`);
    }
    for (const junction of graph.junctions.values()) {
        const incidents: IncidentVE[] = [];
        for (const inc of junction.incidents) {
            const ve = graph.virtualEdges.get(inc.veId);
            if (!ve) continue;
            const offsets = veOffsetLines(ve, polyById, edgeThicknessMap);
            if (!offsets) continue;
            const dirAway: Vec2 = inc.endIdx === 0
                ? [offsets.dir[0], offsets.dir[1]]
                : [-offsets.dir[0], -offsets.dir[1]];
            const angleAway = Math.atan2(dirAway[1], dirAway[0]);
            incidents.push({ ve, endIdx: inc.endIdx, offsets, dirAway, angleAway });
        }
        if (incidents.length === 0) continue;

        // 角度ソート (CCW)
        incidents.sort((a, b) => a.angleAway - b.angleAway);

        // ── 0. 柱が交差点を覆っているか判定 ─────────────────────────
        // 覆っている柱フットプリントは accumulatedClips の先頭に積まれ、
        // 後段の Clipper diff で全壁矩形から差し引かれる。さらに (a)/(b)
        // の miter / cap を抑止し、全 incident を (c) に流すことで柱面で
        // 切り落とされた端点が確実に採用される。
        const columnsAtJunction: ColumnFootprint[] = [];
        for (const col of columnFootprints) {
            if (pointInPolygon(junction.pos, col.points)) {
                columnsAtJunction.push(col);
            }
        }
        const forceColumnClip = columnsAtJunction.length > 0;

        const debugThis = JUNCTION_GRAPH_DEBUG && (incidents.length >= 3 || forceColumnClip);
        if (debugThis) {
            // eslint-disable-next-line no-console
            console.group(
                `J ${junction.id} ${fmt(junction.pos)} (n=${incidents.length})` +
                (forceColumnClip ? ` [column×${columnsAtJunction.length}]` : ""),
            );
        }

        const processed = new Set<string>();
        const accumulatedClips: Ring[][] = [];
        for (const col of columnsAtJunction) {
            accumulatedClips.push([col.points.map<Pair>((v) => [v[0], v[1]])]);
        }

        /** 仮想エッジの該当端 (endIdx) の corners を書き込む。 */
        const setCorners = (inc: IncidentVE, outer: Vec2, inner: Vec2, tag = "") => {
            const corners = {
                outer,
                junction: [junction.pos[0], junction.pos[1]] as Vec2,
                inner,
            };
            if (inc.endIdx === 0) inc.ve.startCorners = corners;
            else inc.ve.endCorners = corners;
            processed.add(inc.ve.id);
            // 累積マージに自分の **junction-extended rect** を追加。junction を
            // 越えて反対側 (= phantom 領域) まで rect を伸ばすことで、後続の
            // 異厚さ ve が片側だけでなく両側で clip されるようにする。
            // これを行わないと「太壁が junction で終わる L コーナー」で細壁の
            // 終端面が斜めになる (= 三角形のスリバー)。
            const rect = extendedRectFromEdge(inc.offsets, inc.endIdx);
            accumulatedClips.push([rect.map<Pair>((v) => [v[0], v[1]])]);
            if (debugThis) {
                // eslint-disable-next-line no-console
                console.log(
                    `  set ${inc.ve.id} end=${inc.endIdx} src=${inc.ve.sourcePolyId.slice(0,6)}#${inc.ve.sourceEdgeIdx} ` +
                    `outer=${fmt(outer)} inner=${fmt(inner)} ${tag}`,
                );
            }
        };

        /** 端点における垂直オフセット (= 共線時のフォールバック)。 */
        const perpCap = (inc: IncidentVE): { outer: Vec2; inner: Vec2 } => {
            const t = veThickness(inc.ve, polyById, edgeThicknessMap);
            return {
                outer: [
                    junction.pos[0] + inc.offsets.nOut[0] * t.outer,
                    junction.pos[1] + inc.offsets.nOut[1] * t.outer,
                ],
                inner: [
                    junction.pos[0] + inc.offsets.nIn[0] * t.inner,
                    junction.pos[1] + inc.offsets.nIn[1] * t.inner,
                ],
            };
        };

        // ── (a) 1 ペアだけ共線 (180°) ペアを検出してチェーンとして cap ─
        // 4 本以上集まる + 字でも、片方のチェーンを 1 ペアだけ "primary" と
        // して扱い、もう片方や stem はすべて step (c) の Clipper 経路に
        // 流す。これで主チェーンが中央正方形を貫通し、副チェーン / stem は
        // チェーン面で butt-cut される。3 本の T 字交差と同じロジック。
        // 異厚さ判定ヘルパ。junction 上に厚さの違う ves が混在しているか。
        // 混在していれば (a)/(b) の対称厚さ前提アルゴリズムは破綻するため、
        // step (c) Clipper diff に処理を委ねる (= 厚い壁から累積 clip すれば
        // 細い壁が厚い壁の外面で正しく cut される)。
        const incThicknessSum = (inc: IncidentVE): number => {
            const t = veThickness(inc.ve, polyById, edgeThicknessMap);
            return t.inner + t.outer;
        };
        const hasAsymmetricThickness = (() => {
            if (incidents.length < 2) return false;
            const t0 = incThicknessSum(incidents[0]);
            for (let i = 1; i < incidents.length; i++) {
                if (Math.abs(incThicknessSum(incidents[i]) - t0) > 1e-6) return true;
            }
            return false;
        })();

        let chainFound = false;
        if (!forceColumnClip && !hasAsymmetricThickness) {
            outerA: for (let i = 0; i < incidents.length; i++) {
                for (let k = i + 1; k < incidents.length; k++) {
                    const a = incidents[i], b = incidents[k];
                    const dot = a.dirAway[0] * b.dirAway[0] + a.dirAway[1] * b.dirAway[1];
                    if (dot > -COLLINEAR_DOT) continue;
                    // 共線ペア → 両方に perpendicular cap
                    if (debugThis) {
                        // eslint-disable-next-line no-console
                        console.log(`  (a) chain pair ${a.ve.id} + ${b.ve.id}`);
                    }
                    for (const inc of [a, b]) {
                        const cap = perpCap(inc);
                        setCorners(inc, cap.outer, cap.inner, "[cap-chain]");
                    }
                    chainFound = true;
                    break outerA;
                }
            }
            if (debugThis && !chainFound) {
                // eslint-disable-next-line no-console
                console.log(`  (a) no chain pair`);
            }
        } else if (debugThis) {
            // eslint-disable-next-line no-console
            console.log(`  (a) skipped (column at junction)`);
        }

        // ── (b) 同 polygon ペア (L) ─────────────────────────────────
        // チェーンが既に存在する場合はスキップ: チェーンがある交差点では
        // 同部屋 L-miter 点がチェーン領域内に入って干渉するため、残りの
        // ves はすべて step (c) の Clipper diff に任せる。
        // 柱が交差点を覆っている場合も同様にスキップ — miter 点が柱内部
        // に落ちるのを避け、Clipper diff で柱面に揃える。
        if (!chainFound && !forceColumnClip) {
            for (let i = 0; i < incidents.length; i++) {
                if (processed.has(incidents[i].ve.id)) continue;
                for (let k = i + 1; k < incidents.length; k++) {
                    if (processed.has(incidents[k].ve.id)) continue;
                    // 同 polygon ペアが第一候補。2-incident 交差点に限り
                    // 異 polygon でも標準ミターを試みる (= 単体壁同士の L 字)。
                    const samePoly = incidents[i].ve.sourcePolyId === incidents[k].ve.sourcePolyId;
                    if (!samePoly && incidents.length !== 2) continue;
                    const a = incidents[i], b = incidents[k];
                    // 厚さが食い違うペアの扱い:
                    //  - 異 polygon (= 共有壁): step (c) Clipper diff に委ねる。
                    //    inner/outer 交点が junction から大きく外れて壁外領域
                    //    ("no-man's land") に飛ぶことがあり、wall fp 頂点に
                    //    採用すると三角形スリバーが出るため。
                    //  - 同 polygon (= L 字 corner): miter を **行う**。基準線
                    //    違い (Center / Interior / Exterior 混在) でも、
                    //    inner-inner / outer-outer 交点は L 字の正しい角を
                    //    与える (= 各壁の内/外側面が連続する 1 点で出会う)。
                    //    ここで skip すると、各壁が rect cap になり角に隙間や
                    //    段差が出る。
                    const taPre = veThickness(a.ve, polyById, edgeThicknessMap);
                    const tbPre = veThickness(b.ve, polyById, edgeThicknessMap);
                    const asymmetricPair =
                        Math.abs(taPre.inner - tbPre.inner) > 1e-6 ||
                        Math.abs(taPre.outer - tbPre.outer) > 1e-6;
                    if (asymmetricPair && !samePoly) {
                        if (debugThis) {
                            // eslint-disable-next-line no-console
                            console.log(`  (b) skipped — cross-poly asymmetric ${a.ve.id} + ${b.ve.id}`);
                        }
                        continue;
                    }
                    if (debugThis) {
                        // eslint-disable-next-line no-console
                        console.log(`  (b) same-poly pair ${a.ve.id} + ${b.ve.id}`);
                    }
                    // standard miter: inner ∩ inner, outer ∩ outer
                    const innerPt = intersectLines(a.offsets.inner, b.offsets.inner);
                    const outerPt = intersectLines(a.offsets.outer, b.offsets.outer);
                    // miter limit: 鋭角で交点が junction から遠く伸びるとスパイク
                    // (= ユーザー報告の "三角形" アーチファクト) になるので上限を
                    // 設けて perp cap にフォールバック。SVG/CSS の miter-limit と
                    // 同じ概念。
                    //
                    // 10×wallThickness: 弧 → 直線の浅い接合 (= 弧の sweep が
                    // semicircle に近く、両端での折れ曲がりが 12° 前後の場合)
                    // でも miter が適用される閾値。それ以下のほぼ平行な接合は
                    // perp cap に落ちるが、視覚的には目立たない。元の 4× では
                    // 接線連続に近い接合で perp cap になり段差が顕在化していた。
                    const ta = taPre;
                    const tb = tbPre;
                    const tMax = Math.max(ta.outer, ta.inner, tb.outer, tb.inner);
                    const MITER_LIMIT_FACTOR = 10;
                    const miterLimit = MITER_LIMIT_FACTOR * tMax;
                    const innerDist = innerPt
                        ? distance(innerPt, junction.pos) : Infinity;
                    const outerDist = outerPt
                        ? distance(outerPt, junction.pos) : Infinity;
                    const miterTooFar =
                        innerDist > miterLimit || outerDist > miterLimit;
                    // eslint-disable-next-line no-console
                    console.log(
                        `[junction/miter] j=(${junction.pos[0].toFixed(3)},${junction.pos[1].toFixed(3)}) ` +
                        `pair ${a.ve.id.slice(0,4)}+${b.ve.id.slice(0,4)} ` +
                        `tMax=${tMax.toFixed(3)} limit=${miterLimit.toFixed(3)} ` +
                        `innerDist=${innerDist === Infinity ? "∞" : innerDist.toFixed(3)} ` +
                        `outerDist=${outerDist === Infinity ? "∞" : outerDist.toFixed(3)} ` +
                        `decision=${(!innerPt || !outerPt) ? "parallel→cap" : (miterTooFar ? "tooFar→cap" : "miter")}`,
                    );
                    if (!innerPt || !outerPt || miterTooFar) {
                        // 平行 or 鋭角で miter 過剰 → perpendicular cap で打ち切り。
                        for (const inc of [a, b]) {
                            const cap = perpCap(inc);
                            setCorners(inc, cap.outer, cap.inner,
                                miterTooFar ? "[cap-miterLimit]" : "[cap-parallel]");
                        }
                    } else {
                        setCorners(a, outerPt, innerPt, "[miter]");
                        setCorners(b, outerPt, innerPt, "[miter]");
                    }
                    break;
                }
            }
        }

        // ── (c) 残り: 累積マージ形状に対する Clipper diff ───────────
        /** 2 つの ve が同一物理壁か判定: start/end が逆順で一致するなら共有壁。 */
        const isSameWall = (a: VirtualEdge, b: VirtualEdge): boolean => {
            const tol = VERTEX_TOL_M;
            return distance(a.start, b.end) < tol && distance(a.end, b.start) < tol;
        };

        // 異厚さ junction では **厚い ve から先に処理** する。各 ve の rect は
        // setCorners 内で accumulatedClips に追記されるので、先に処理した方が
        // 「先勝ち」で残りやすい。ユーザは「太い壁が表面を保ち、細い壁は太い
        // 壁の外面で切り落とされる」挙動を期待するので、厚い順 = 先処理が正解。
        // 厚さ同点の場合は incidents.sort 由来の角度順が維持されるよう
        // stable sort 相当に書く (= 元 index を tie-breaker に)。
        const cOrder = incidents
            .map((inc, idx) => ({ inc, idx, t: incThicknessSum(inc) }))
            .sort((a, b) => (b.t - a.t) || (a.idx - b.idx))
            .map((x) => x.inc);

        for (const inc of cOrder) {
            if (processed.has(inc.ve.id)) continue;

            // ── Sibling preempt: 同一物理壁の処理済み ve があれば、Clipper を
            //    回さずに sibling の corners を直接コピーする。
            //
            //    高密度交差 (例: 4 部屋 + 字、n=8) で、同一物理壁を 2 視点で
            //    persist する場合、Clipper diff では subj rect が accumulated
            //    にほぼ完全包含され、結果として「FP 誤差由来の極小スリバー」
            //    だけが残ることがある。そのスリバーは壁の遠端側に偏ること
            //    が多く、`dToJ` 最小選択が遠端の頂点を拾い上げて corners が
            //    junction から遠く外れてしまう (= 退化フットプリントで壁が
            //    描画されず "壁が消える" 症状)。
            //
            //    sibling が既に処理済みなら corners は確定しているので、
            //    そのまま流用するのが最も安全で正確。
            let bestOuter: Vec2 | null = null;
            let bestInner: Vec2 | null = null;
            let sibTag = "";
            for (const sib of incidents) {
                if (sib.ve.id === inc.ve.id) continue;
                if (!processed.has(sib.ve.id)) continue;
                if (!isSameWall(sib.ve, inc.ve)) continue;
                const sibCorners = sib.endIdx === 0
                    ? sib.ve.startCorners
                    : sib.ve.endCorners;
                if (!sibCorners) continue;
                // 同一壁の ve は方向が反対なので outer / inner を swap して採用。
                bestOuter = [sibCorners.inner[0], sibCorners.inner[1]];
                bestInner = [sibCorners.outer[0], sibCorners.outer[1]];
                sibTag = ` sib=${sib.ve.id} (preempt)`;
                break;
            }

            let diffPieces = 0;
            let diffVerts = 0;
            // sibling preempt が成立した場合は Clipper をスキップしても
            // 正しい corners が得られるので、accumulatedClips への自分の
            // rect 追加だけ確実にやれば良い (= setCorners 内で実施される)。
            if (!bestOuter || !bestInner) {
                const subj: Ring[] = [rectFromEdge(inc.offsets).map<Pair>((v) => [v[0], v[1]])];
                let bestOuterD = Infinity;
                let bestInnerD = Infinity;
                try {
                    const result = accumulatedClips.length === 0
                        ? [subj]
                        : polygonClipping.difference(subj, ...accumulatedClips);
                    diffPieces = result.length;
                    for (const piece of result) {
                        if (!piece || piece.length === 0) continue;
                        const ring = piece[0];
                        if (!ring || ring.length < 4) continue;
                        // polygon-clipping の出力は **最終頂点が始点と重複** した
                        // closed ring (= ring[0] === ring[len-1])。一方
                        // accumulatedClips が空で subj を直接流したパスは
                        // rectFromEdge 由来の重複無し 4 頂点。両者を区別して
                        // nRing を決めないと、無 clip パスで最後の頂点 (= 多くの
                        // 場合「もう一方の端の inner cap」) がスキップされ、
                        // 結果として ve の endCorners がもう一方の端の値に
                        // 摩り替わって wall が一端で taper する。
                        const last = ring[ring.length - 1];
                        const first = ring[0];
                        const closedDup =
                            Math.abs(first[0] - last[0]) < 1e-9 &&
                            Math.abs(first[1] - last[1]) < 1e-9;
                        const nRing = closedDup ? ring.length - 1 : ring.length;
                        diffVerts += nRing;
                        for (let m = 0; m < nRing; m++) {
                            const p: Vec2 = [ring[m][0], ring[m][1]];
                            const dToJ = distance(p, junction.pos);
                            if (pointLineDist(p, inc.offsets.outer) <= ON_LINE_TOL && dToJ < bestOuterD) {
                                bestOuterD = dToJ; bestOuter = p;
                            }
                            if (pointLineDist(p, inc.offsets.inner) <= ON_LINE_TOL && dToJ < bestInnerD) {
                                bestInnerD = dToJ; bestInner = p;
                            }
                        }
                    }
                } catch (err) {
                    // Clipper 失敗 → 後段の sibling copy / cap fallback
                    if (debugThis) {
                        // eslint-disable-next-line no-console
                        console.log(`  (c) ${inc.ve.id} CLIPPER ERR ${String(err)}`);
                    }
                }

                // Clipper 失敗時の sibling fallback (preempt とは別経路: ここでは
                // sibling が後から処理されるケース)。
                if (!bestOuter || !bestInner) {
                    for (const sib of incidents) {
                        if (sib.ve.id === inc.ve.id) continue;
                        if (!processed.has(sib.ve.id)) continue;
                        if (!isSameWall(sib.ve, inc.ve)) continue;
                        const sibCorners = sib.endIdx === 0
                            ? sib.ve.startCorners
                            : sib.ve.endCorners;
                        if (!sibCorners) continue;
                        if (!bestOuter) bestOuter = [sibCorners.inner[0], sibCorners.inner[1]];
                        if (!bestInner) bestInner = [sibCorners.outer[0], sibCorners.outer[1]];
                        sibTag = ` sib=${sib.ve.id}`;
                        break;
                    }
                }
            }

            const cap = perpCap(inc);
            const tag = `[clip pieces=${diffPieces} verts=${diffVerts} ` +
                `out=${bestOuter ? "ok" : "FALLBACK"} in=${bestInner ? "ok" : "FALLBACK"}${sibTag}]`;
            setCorners(inc, bestOuter ?? cap.outer, bestInner ?? cap.inner, tag);
        }

        if (debugThis) {
            // eslint-disable-next-line no-console
            console.groupEnd();
        }
    }
    if (JUNCTION_GRAPH_DEBUG) {
        // eslint-disable-next-line no-console
        console.groupEnd();
    }
}

/** 仮想エッジの両端で 3 点が未確定なら自由端として垂直キャップ (= 外オフ・
 *  端点・内オフが軸法線方向に直線で並ぶ) を当てる。
 *  両端ともキャップで埋まれば結果として矩形相当のフットプリントになる。 */
export function applyCaps(
    graph: JunctionGraph,
    polygons: RoomPolygon[],
    edgeThicknessMap?: EdgeThicknessMap,
): void {
    const polyById = new Map(polygons.map((p) => [p.id, p]));
    for (const ve of graph.virtualEdges.values()) {
        const offsets = veOffsetLines(ve, polyById, edgeThicknessMap);
        if (!offsets) continue;
        const t = veThickness(ve, polyById, edgeThicknessMap);
        if (!ve.startCorners) {
            ve.startCorners = {
                outer: [
                    ve.start[0] + offsets.nOut[0] * t.outer,
                    ve.start[1] + offsets.nOut[1] * t.outer,
                ],
                junction: [ve.start[0], ve.start[1]],
                inner: [
                    ve.start[0] + offsets.nIn[0] * t.inner,
                    ve.start[1] + offsets.nIn[1] * t.inner,
                ],
            };
        }
        if (!ve.endCorners) {
            ve.endCorners = {
                outer: [
                    ve.end[0] + offsets.nOut[0] * t.outer,
                    ve.end[1] + offsets.nOut[1] * t.outer,
                ],
                junction: [ve.end[0], ve.end[1]],
                inner: [
                    ve.end[0] + offsets.nIn[0] * t.inner,
                    ve.end[1] + offsets.nIn[1] * t.inner,
                ],
            };
        }
    }
}

/** 確定済み corners から CCW 4 頂点フットプリントを取り出す。
 *   [innerStart, outerStart, outerEnd, innerEnd]
 *
 *  junction 点は corners オブジェクトには保持されているが、フットプリント
 *  には含めない理由:
 *   - 同部屋ペア miter / 共線キャップでは junction は inner と outer の
 *     ちょうど中間 (collinear) になり、ポリゴン境界上で冗長な頂点になる。
 *     earcut が degenerate triangle を作って視覚アーティファクトの元になる。
 *   - Clipper diff (stem cut) では junction は wall band 内部に位置するため、
 *     ポリゴン境界に乗らない。
 *
 *  どちらかの端で corners が無ければ null を返す。 */
export function virtualEdgeFootprint(ve: VirtualEdge): Vec2[] | null {
    if (!ve.startCorners || !ve.endCorners) return null;
    return [
        [ve.startCorners.inner[0], ve.startCorners.inner[1]],
        [ve.startCorners.outer[0], ve.startCorners.outer[1]],
        [ve.endCorners.outer[0],   ve.endCorners.outer[1]],
        [ve.endCorners.inner[0],   ve.endCorners.inner[1]],
    ];
}

// ─── Re-exports for callers ────────────────────────────────────────────────

export {
    rectFromEdge,
    veOffsetLines,
    veDir,
    veThickness,
    pointLineDist,
    intersectLines,
    polygonClipping,
    type Pair,
    type Ring,
    COLLINEAR_DOT,
    ON_LINE_TOL,
};
