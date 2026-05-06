/**
 * 壁エッジ単位の幾何ユーティリティ。
 *
 * 仕様（RoomPolygon ベース、CCW polygon 前提）
 *  - エッジ i = outer[i] (= s) → outer[(i+1) % n] (= e)
 *  - エッジ方向 d = unit(e - s)
 *  - +90° 法線 n+ = (-d.y, +d.x)  …  CCW polygon では INWARD (室内側)
 *  - -90° 法線 n- = (+d.y, -d.x)  …  CCW polygon では OUTWARD (屋外側)
 *  - 内側厚さ T_in  → エッジ中点から n+ 方向に T_in だけ平行移動した
 *                     直線が L_in (内法面)
 *  - 外側厚さ T_out → エッジ中点から n- 方向に T_out だけ平行移動した
 *                     直線が L_out (外法面)
 *
 * 各エッジ i の壁形状は 6 頂点ポリゴンで、頂点列は自己交差しないよう
 *
 *     inner_prev → s → outer_prev → outer_next → e → inner_next → (戻る)
 *
 * の順で構成する (内側 / 外側それぞれの隣接エッジとの mitered 交点を取り、
 * 軸の端点 s, e は壁芯位置として保持する)。
 */

import { Vec2 } from "../math/Vec2";
import { RoomPolygon, resolveWallThicknesses, polygonEdges } from "../../model/elements/SpaceElement";

// ─── 2D primitives ─────────────────────────────────────────────────────────

/** Infinite line: 点 (px, py) を通り方向 (dx, dy) に伸びる。 */
export interface Line2 {
    px: number;
    py: number;
    dx: number;
    dy: number;
}

/** 2 直線の交点 (t1, t2 は各直線上のパラメータ)。平行なら null。 */
export function intersectLines(a: Line2, b: Line2): Vec2 | null {
    const denom = a.dx * b.dy - a.dy * b.dx;
    if (Math.abs(denom) < 1e-10) return null;
    const t = ((b.px - a.px) * b.dy - (b.py - a.py) * b.dx) / denom;
    return [a.px + a.dx * t, a.py + a.dy * t];
}

/** 線分 a→b 上の最近接 t (∈ [0, 1]) を返す。 */
export function projectOntoSegment(p: Vec2, a: Vec2, b: Vec2): { t: number; dist: number } {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const len2 = dx * dx + dy * dy;
    if (len2 < 1e-18) return { t: 0, dist: Math.hypot(p[0] - a[0], p[1] - a[1]) };
    let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    const qx = a[0] + dx * t, qy = a[1] + dy * t;
    return { t, dist: Math.hypot(p[0] - qx, p[1] - qy) };
}

// ─── Polygon orientation ───────────────────────────────────────────────────

/** Signed area (CCW なら正、CW なら負)。Shoelace。 */
export function signedArea(outer: Vec2[]): number {
    let s = 0;
    const n = outer.length;
    for (let i = 0; i < n; i++) {
        const a = outer[i], b = outer[(i + 1) % n];
        s += a[0] * b[1] - b[0] * a[1];
    }
    return s / 2;
}

export function isCCW(outer: Vec2[]): boolean {
    return signedArea(outer) > 0;
}

/** CW なら反転して CCW にする。元の配列は変更しない (新しい配列を返す)。 */
export function ensureCCW(outer: Vec2[]): Vec2[] {
    if (isCCW(outer)) return outer;
    return [...outer].reverse();
}

// ─── Edge → offset lines ───────────────────────────────────────────────────

/**
 * 与えられた CCW polygon のエッジ i について、L_in / L_out を返す。
 * 内側厚さ T_in / 外側厚さ T_out は `resolveWallThicknesses(poly)` から取る
 * (現状は per-polygon — 将来 per-edge にするならここを拡張)。
 *
 * `null` が返るのは退化エッジ (長さ ≈ 0) のとき。
 */
export interface EdgeOffsetLines {
    /** エッジの方向単位ベクトル s→e。 */
    dir: Vec2;
    /** 軸 = エッジ自体の直線 (s 通過)。 */
    axis: Line2;
    /** 内法面 (CCW では +90° 側、室内側)。 */
    inner: Line2;
    /** 外法面 (CCW では -90° 側、屋外側)。 */
    outer: Line2;
    /** +90° 法線 (内向き、単位ベクトル)。 */
    nIn: Vec2;
    /** -90° 法線 (外向き、単位ベクトル)。 */
    nOut: Vec2;
    /** エッジ長。 */
    length: number;
}

export function edgeOffsetLines(
    poly: RoomPolygon,
    edgeIdx: number,
): EdgeOffsetLines | null {
    const edges = polygonEdges(poly);
    if (edgeIdx < 0 || edgeIdx >= edges.length) return null;
    const [ai, bi] = edges[edgeIdx];
    const s = poly.outer[ai];
    const e = poly.outer[bi];
    const dx = e[0] - s[0], dy = e[1] - s[1];
    const len = Math.hypot(dx, dy);
    if (len < 1e-9) return null;
    const ux = dx / len, uy = dy / len;
    const nInX = -uy, nInY = ux;       // +90° (CCW polygon → 内向き)
    const nOutX = uy, nOutY = -ux;     // -90° (外向き)
    const { inner: tIn, outer: tOut } = resolveWallThicknesses(poly);
    const mx = (s[0] + e[0]) / 2;
    const my = (s[1] + e[1]) / 2;
    return {
        dir: [ux, uy],
        axis:  { px: s[0],            py: s[1],            dx: ux, dy: uy },
        inner: { px: mx + nInX  * tIn,  py: my + nInY  * tIn,  dx: ux, dy: uy },
        outer: { px: mx + nOutX * tOut, py: my + nOutY * tOut, dx: ux, dy: uy },
        nIn:  [nInX, nInY],
        nOut: [nOutX, nOutY],
        length: len,
    };
}

// ─── Wall hexagon (per-edge wall slab in 2D) ───────────────────────────────

export interface WallHexagon {
    /** 6 頂点。CCW で
     *    [innerPrev, s, outerPrev, outerNext, e, innerNext]
     */
    vertices: [Vec2, Vec2, Vec2, Vec2, Vec2, Vec2];
}

/**
 * エッジ i の 6 頂点壁ポリゴンを計算する。
 *
 * 各端点 (start = s, end = e) について
 *   - `poly.vertexConnections[vertexIdx]` が設定されている (= 交差点)
 *     なら、**接続する全エッジ** (own prev/next + 他ポリゴンの incident
 *     edge) の L_in / L_out と現エッジの L_in / L_out との交点候補を
 *     列挙し、現エッジ中点から最近接の inner / outer 交点をそれぞれ
 *     コーナーに採用する。3 本以上が集まるジャンクションでも一貫した
 *     形を出せる。
 *   - 交差点なし、または接続エッジから有効交点が取れない場合は同一
 *     ポリゴン内 prev/next との standard miter (= L_in × L_in / L_out
 *     × L_out)。それも平行で取れなければ垂直オフセットへフォールバック。
 *
 * `polygonLookup` は他ポリゴンを `polyId` 経由で引くためのコールバック。
 * 渡されないと `vertexConnections` 経由のクロスポリゴンは無効化され、
 * standard miter のみで動く。
 */
export function computeWallHexagon(
    poly: RoomPolygon,
    edgeIdx: number,
    polygonLookup?: (polyId: string) => RoomPolygon | undefined,
    debug?: boolean,
): WallHexagon | null {
    const edges = polygonEdges(poly);
    const n = edges.length;
    if (n === 0) return null;
    const cur = edgeOffsetLines(poly, edgeIdx);
    if (!cur) return null;
    const [aiCur, biCur] = edges[edgeIdx];
    // 閉じ図形は cyclic 隣接で OK。開いたポリライン (wallPath 等) は
    // 端点で wrap せず、頂点接続から prev / next を探す。マッチが無ければ
    // null (= rectangular cap fallback) になる。
    let prevIdx: number;
    let nextIdx: number;
    if (poly.edges) {
        // 明示 edges を持つケース (= 開いたポリラインを許容)。頂点同士の接続で隣接を決める。
        prevIdx = -1;
        nextIdx = -1;
        for (let i = 0; i < n; i++) {
            if (i === edgeIdx) continue;
            const [a, b] = edges[i];
            if (b === aiCur && prevIdx === -1) prevIdx = i;
            if (a === biCur && nextIdx === -1) nextIdx = i;
        }
    } else {
        prevIdx = (edgeIdx - 1 + n) % n;
        nextIdx = (edgeIdx + 1) % n;
    }
    const prev = prevIdx >= 0 ? edgeOffsetLines(poly, prevIdx) : null;
    const next = nextIdx >= 0 ? edgeOffsetLines(poly, nextIdx) : null;

    const s = poly.outer[aiCur];
    const e = poly.outer[biCur];

    const fmt = (v: Vec2) => `(${v[0].toFixed(3)}, ${v[1].toFixed(3)})`;
    if (debug) {
        const polyTag = poly.id.slice(0, 6);
        console.log(
            `[hex] poly=${polyTag} edge=${edgeIdx} s=${fmt(s)} e=${fmt(e)} ` +
            `len=${cur.length.toFixed(3)} ` +
            `t_in=${resolveWallThicknesses(poly).inner.toFixed(3)} ` +
            `t_out=${resolveWallThicknesses(poly).outer.toFixed(3)}`,
        );
    }

    const fallbackInnerAt = (vertex: Vec2): Vec2 => [
        vertex[0] + cur.nIn[0] * resolveWallThicknesses(poly).inner,
        vertex[1] + cur.nIn[1] * resolveWallThicknesses(poly).inner,
    ];
    const fallbackOuterAt = (vertex: Vec2): Vec2 => [
        vertex[0] + cur.nOut[0] * resolveWallThicknesses(poly).outer,
        vertex[1] + cur.nOut[1] * resolveWallThicknesses(poly).outer,
    ];

    // 共有エッジ判定。現エッジ自身、または隣接 (prev/next) が共有エッジの
    // 場合、その側の **inner コーナー** だけ miter / 最近接を使わずに
    // 現エッジの法線方向に innerThickness 分だけ垂直オフセットした点を
    // 採用する。outer コーナーは従来どおり交差点 / miter ロジック。
    const sharedAt = (idx: number): boolean =>
        !!poly.sharedEdgeIds && !!poly.sharedEdgeIds[idx];
    const curIsShared = sharedAt(edgeIdx);
    const prevIsShared = sharedAt(prevIdx);
    const nextIsShared = sharedAt(nextIdx);
    const innerPerpAtStart = curIsShared || prevIsShared;
    const innerPerpAtEnd = curIsShared || nextIsShared;

    /** outer コーナーを決める (1 本目 = cur, 2 本目 = polygon prev/next の
     *  standard miter)。共線 (180°) の場合 intersectLines が parallel で
     *  null を返し、端点の垂直オフセットへ fallback する → 外オフ・端点・
     *  内オフが直線で並ぶ。 */
    const resolveOuter = (
        vert: Vec2,
        miterNeighbor: EdgeOffsetLines | null,
    ): Vec2 => {
        if (miterNeighbor) {
            return intersectLines(miterNeighbor.outer, cur.outer) ?? fallbackOuterAt(vert);
        }
        return fallbackOuterAt(vert);
    };
    /** inner コーナーを決める (上の outer と対)。共有エッジ近傍では呼ばれず、
     *  垂直オフセットが優先される。 */
    const resolveInner = (
        vert: Vec2,
        miterNeighbor: EdgeOffsetLines | null,
    ): Vec2 => {
        if (miterNeighbor) {
            return intersectLines(miterNeighbor.inner, cur.inner) ?? fallbackInnerAt(vert);
        }
        return fallbackInnerAt(vert);
    };

    // ── 1 本目 (cur) + 2 本目 (polygon prev/next) の standard miter で
    //    6 頂点 hex を計算する。共線 (180°) の場合は intersectLines が
    //    parallel で null を返し、垂直オフセット fallback で外/端点/内が
    //    直線並びになる。この経路はユーザ仕様の「直線関係を優先」を満たす。
    if (debug) {
        const tag = innerPerpAtStart ? "INNER-PERP" :
            prev ? "miter" : "no-prev";
        console.log(
            `  start v${aiCur} ${tag} (cur_shared=${curIsShared} ` +
            `prev_shared=${prevIsShared})`,
        );
    }
    const innerPrev: Vec2 = innerPerpAtStart
        ? fallbackInnerAt(s)
        : resolveInner(s, prev);
    const outerPrev: Vec2 = resolveOuter(s, prev);
    if (debug) {
        console.log(`    innerPrev=${fmt(innerPrev)} outerPrev=${fmt(outerPrev)}`);
    }

    if (debug) {
        const tag = innerPerpAtEnd ? "INNER-PERP" :
            next ? "miter" : "no-next";
        console.log(
            `  end v${biCur} ${tag} (cur_shared=${curIsShared} ` +
            `next_shared=${nextIsShared})`,
        );
    }
    const innerNext: Vec2 = innerPerpAtEnd
        ? fallbackInnerAt(e)
        : resolveInner(e, next);
    const outerNext: Vec2 = resolveOuter(e, next);
    if (debug) {
        console.log(`    innerNext=${fmt(innerNext)} outerNext=${fmt(outerNext)}`);
    }

    return {
        vertices: [
            innerPrev,
            [s[0], s[1]],
            outerPrev,
            outerNext,
            [e[0], e[1]],
            innerNext,
        ],
    };
}

// ─── Edge-pair classification (overlap / intersect) ────────────────────────

const ANGLE_PARALLEL_TOL = (3 * Math.PI) / 180;
const COLLINEAR_PERP_DIST_TOL = 0.02; // 2 cm

export type EdgePairRelation =
    | { kind: "none" }
    /** 同一直線上で範囲が重なる (= 共通エッジ候補)。
     *  range は cluster axis (a 側のエッジ方向で測ったパラメータ範囲) で、
     *  a から見た重なり区間。 */
    | { kind: "overlap"; a0: number; a1: number; b0: number; b1: number; overlapStart: Vec2; overlapEnd: Vec2 }
    /** 非平行で線分内部で交わる (= T 字交差)。 `point` は交点。
     *  `tA`, `tB` はそれぞれ a, b の正規化パラメータ (0..1)。 */
    | { kind: "intersect"; point: Vec2; tA: number; tB: number };

/**
 * エッジ A (aS→aE) と エッジ B (bS→bE) を分類する。
 * `tol` は数値許容 (距離換算)。`tol = max(2cm, 平均壁厚)` 程度を渡すと
 * 共通エッジ判定が安定する。
 */
export function classifyEdgePair(
    aS: Vec2, aE: Vec2,
    bS: Vec2, bE: Vec2,
    tol = COLLINEAR_PERP_DIST_TOL,
): EdgePairRelation {
    const adx = aE[0] - aS[0], ady = aE[1] - aS[1];
    const aLen = Math.hypot(adx, ady);
    if (aLen < 1e-9) return { kind: "none" };
    const ux = adx / aLen, uy = ady / aLen;
    const nx = -uy, ny = ux;

    const bdx = bE[0] - bS[0], bdy = bE[1] - bS[1];
    const bLen = Math.hypot(bdx, bdy);
    if (bLen < 1e-9) return { kind: "none" };

    const cross = adx * bdy - ady * bdx;
    const sinTheta = cross / (aLen * bLen);
    const isParallel = Math.abs(sinTheta) <= Math.sin(ANGLE_PARALLEL_TOL);

    if (isParallel) {
        // Perpendicular distance from a's line to b's endpoints
        const d1 = Math.abs((bS[0] - aS[0]) * nx + (bS[1] - aS[1]) * ny);
        const d2 = Math.abs((bE[0] - aS[0]) * nx + (bE[1] - aS[1]) * ny);
        if (d1 > tol || d2 > tol) return { kind: "none" };
        // Project b's endpoints onto a's parameter axis
        const t1 = ((bS[0] - aS[0]) * ux + (bS[1] - aS[1]) * uy) / aLen;
        const t2 = ((bE[0] - aS[0]) * ux + (bE[1] - aS[1]) * uy) / aLen;
        const bMin = Math.min(t1, t2);
        const bMax = Math.max(t1, t2);
        // a's range is [0, 1]
        const oMin = Math.max(0, bMin);
        const oMax = Math.min(1, bMax);
        if (oMax - oMin < tol / aLen) return { kind: "none" };
        const startW: Vec2 = [aS[0] + adx * oMin, aS[1] + ady * oMin];
        const endW:   Vec2 = [aS[0] + adx * oMax, aS[1] + ady * oMax];
        return {
            kind: "overlap",
            a0: oMin, a1: oMax,
            b0: t1, b1: t2,
            overlapStart: startW,
            overlapEnd: endW,
        };
    }

    // Non-parallel: line-line intersection in normalised form
    const denom = cross;
    const dpx = bS[0] - aS[0], dpy = bS[1] - aS[1];
    const tA = (dpx * bdy - dpy * bdx) / denom;
    const tB = (dpx * ady - dpy * adx) / denom;
    const inA = tA > -tol / aLen && tA < 1 + tol / aLen;
    const inB = tB > -tol / bLen && tB < 1 + tol / bLen;
    if (!inA || !inB) return { kind: "none" };
    return {
        kind: "intersect",
        point: [aS[0] + adx * tA, aS[1] + ady * tA],
        tA, tB,
    };
}

// ─── T-junction trim (棒側の2点を選択) ──────────────────────────────────

/**
 * T 字交差で「棒の方の」エッジ B (= 棒側) の端点を、十字側エッジ A の
 * L_in / L_out との 4 交点のうち最も近い 2 点として返す。
 *
 * - `near` = B 側の交差端点 (B のうち A に近い側)
 *   棒側はその端点の側で A の本体に突き当たる。
 * - 戻り値の 2 点は B 上で「壁面の左右コーナー」に相当する。
 *   (B の inner / outer のどちらかとマッチ)
 *
 * `null` は A の両ライン (inner/outer) と B の両ライン (inner/outer) が
 * すべて平行で交点が取れない場合。
 */
export interface TBarTrim {
    /** B の inner 面側の終端点。 */
    innerHit: Vec2;
    /** B の outer 面側の終端点。 */
    outerHit: Vec2;
}
export function tBarTrimAgainst(
    bar: EdgeOffsetLines,
    barNearEnd: Vec2,
    /** 棒側端点 `barNearEnd` から棒本体に向かう単位ベクトル。本体側の候補
     *  (棒の中身に向かう側) だけを採用するために使う。これが無いと、
     *  共通エッジの 4 隅 (4 候補) が `barNearEnd` から等距離になるケースで
     *  逆側 (本体の外) の点を選んで壁が突き抜ける。 */
    barInDir: Vec2,
    cross: EdgeOffsetLines,
): TBarTrim | null {
    interface Cand { v: Vec2; side: "inner" | "outer"; t: number; }
    const project = (p: Vec2): number =>
        (p[0] - barNearEnd[0]) * barInDir[0] + (p[1] - barNearEnd[1]) * barInDir[1];
    const candidates: Cand[] = [];
    const push = (v: Vec2 | null, side: "inner" | "outer") => {
        if (!v) return;
        candidates.push({ v, side, t: project(v) });
    };
    push(intersectLines(bar.inner, cross.inner), "inner");
    push(intersectLines(bar.inner, cross.outer), "inner");
    push(intersectLines(bar.outer, cross.inner), "outer");
    push(intersectLines(bar.outer, cross.outer), "outer");

    // 本体側 (t >= 0) の候補だけに絞る。境界誤差用に微小な負値を許容。
    const onBody = candidates.filter((c) => c.t >= -1e-6);
    if (onBody.length < 2) return null;
    // 本体に深い順 (t 昇順 = 本体側で `barNearEnd` に近い順)。
    onBody.sort((a, b) => a.t - b.t);
    let innerHit: Vec2 | null = null, outerHit: Vec2 | null = null;
    for (const c of onBody) {
        if (c.side === "inner" && !innerHit) innerHit = c.v;
        else if (c.side === "outer" && !outerHit) outerHit = c.v;
        if (innerHit && outerHit) break;
    }
    if (!innerHit || !outerHit) return null;
    return { innerHit, outerHit };
}
