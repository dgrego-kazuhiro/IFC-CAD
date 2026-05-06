// First-class 2D sketch entities.
//
// 部屋(Space)が直接保持する作図要素。 RoomPolygon は entities から派生する
// キャッシュ (closed loop の幾何) であり、編集の真実の単一情報源は ここ。
//
// すべての座標は XZ 平面 (床面) の 2D。Y は床面の高さ (level) として
// SpaceElement 側が持つ。

import { Vec2 } from "../../geometry/math/Vec2";

export type SketchEntityId = string;

interface BaseEntity {
    id: SketchEntityId;
    /** 作図補助線として描画のみで壁軸 / 境界として使わないなら true。 */
    construction?: boolean;
}

/** 直線 (2 端点)。 */
export interface LineEntity extends BaseEntity {
    kind: "line";
    p0: Vec2;
    p1: Vec2;
}

/** 折れ線 (>= 2 頂点)。`closed = true` で最終→始点の閉エッジを暗黙追加。 */
export interface PolylineEntity extends BaseEntity {
    kind: "polyline";
    points: Vec2[];
    closed: boolean;
}

/** 完全円。Trim で部分化されると Arc に置き換わる。 */
export interface CircleEntity extends BaseEntity {
    kind: "circle";
    center: Vec2;
    radius: number;
}

/**
 * 円弧。aStart から CCW (反時計回り) に aEnd まで。
 *  - sweep = ((aEnd - aStart) mod 2π) で 0 < sweep < 2π を保証する。
 *  - sweep === 2π は CircleEntity に正規化する (Arc としては禁止)。
 *  - 角度は radians、0 = +X 方向。
 */
export interface ArcEntity extends BaseEntity {
    kind: "arc";
    center: Vec2;
    radius: number;
    aStart: number;
    aEnd: number;
}

export type SketchEntity = LineEntity | PolylineEntity | CircleEntity | ArcEntity;

// ────────────────────────────────────────────────────────────────────────
// Vertex / Edge addressing
// ────────────────────────────────────────────────────────────────────────

/**
 * 点参照: スケッチソルバ・拘束・スナップでこの形式を使う。
 *  - line:     pointIdx 0 = p0, 1 = p1
 *  - polyline: pointIdx 0..N-1 = points[i]
 *  - arc:      pointIdx 0 = start, 1 = end
 *  - circle:   pointIdx に意味なし — `kind: "center"` を使う
 *  - arc も中心は `kind: "center"` で参照する
 */
export type SketchVertexRef =
    | { kind: "endpoint"; entityId: SketchEntityId; pointIdx: number }
    | { kind: "center"; entityId: SketchEntityId };

/**
 * 辺参照:
 *  - line:     edgeIdx 省略 (= 0)
 *  - polyline: edgeIdx 0..M-1 (M = N-1 開, または N 閉)
 *  - arc / circle: edgeIdx 省略 (曲線そのもの)
 */
export interface SketchEdgeRef {
    entityId: SketchEntityId;
    edgeIdx?: number;
}

/** エンティティそのもの (circle / arc を主役にする拘束で使用)。 */
export interface SketchEntityRef {
    entityId: SketchEntityId;
}

// ────────────────────────────────────────────────────────────────────────
// Geometric helpers
// ────────────────────────────────────────────────────────────────────────

const TAU = Math.PI * 2;

/** 角度を [0, 2π) に正規化。 */
export function wrap2pi(a: number): number {
    let r = a % TAU;
    if (r < 0) r += TAU;
    return r;
}

/** Arc の sweep 角 (常に 0 < sweep < 2π)。完全周は CircleEntity を使うこと。 */
export function arcSweep(arc: ArcEntity): number {
    const d = wrap2pi(arc.aEnd - arc.aStart);
    return d === 0 ? TAU : d;
}

/**
 * エンティティの「頂点」位置を返す。スナップで端点候補として使う。
 *  - line: [p0, p1]
 *  - polyline: points
 *  - arc: [start, end]
 *  - circle: [] (端点なし、中心のみ)
 */
export function entityEndpoints(e: SketchEntity): Vec2[] {
    switch (e.kind) {
        case "line": return [e.p0, e.p1];
        case "polyline": return e.points.slice();
        case "arc": {
            const sx = e.center[0] + e.radius * Math.cos(e.aStart);
            const sy = e.center[1] + e.radius * Math.sin(e.aStart);
            const ex = e.center[0] + e.radius * Math.cos(e.aEnd);
            const ey = e.center[1] + e.radius * Math.sin(e.aEnd);
            return [[sx, sy], [ex, ey]];
        }
        case "circle": return [];
    }
}

/** 中心点を持つエンティティ (circle / arc) のみ。それ以外は null。 */
export function entityCenter(e: SketchEntity): Vec2 | null {
    return e.kind === "circle" || e.kind === "arc" ? e.center : null;
}

/** エッジ数。line=1, polyline=N-1 (open) | N (closed), arc=1, circle=1。 */
export function entityEdgeCount(e: SketchEntity): number {
    switch (e.kind) {
        case "line": return 1;
        case "polyline": return e.closed ? e.points.length : e.points.length - 1;
        case "arc": return 1;
        case "circle": return 1;
    }
}

/** エッジの両端点を返す (polyline 用 — line/arc/circle は edgeIdx 無視)。 */
export function entityEdgeEndpoints(e: SketchEntity, edgeIdx?: number): [Vec2, Vec2] | null {
    if (e.kind === "line") return [e.p0, e.p1];
    if (e.kind === "polyline") {
        const i = edgeIdx ?? 0;
        const n = e.points.length;
        const j = (i + 1) % n;
        if (i < 0 || i >= entityEdgeCount(e)) return null;
        return [e.points[i], e.points[j]];
    }
    return null; // 曲線エンティティはこの API では扱わない
}

/**
 * 折れ線 / 円 / 円弧をテッセレート。`maxSagitta` (m) を超えない弦に分割。
 * `minSegments` で曲線の最低分割数も担保。
 */
export function tessellateEntity(
    e: SketchEntity,
    maxSagitta = 0.005,
    minSegments = 12,
): Vec2[] {
    if (e.kind === "line") return [e.p0, e.p1];
    if (e.kind === "polyline") {
        const out = e.points.slice();
        if (e.closed && out.length >= 1) out.push(e.points[0]);
        return out;
    }
    // arc / circle: chord-error から segment 数を導出
    const r = e.radius;
    const sweep = e.kind === "circle" ? TAU : arcSweep(e);
    // sagitta = r * (1 - cos(theta/2))  ⇒  theta = 2 * acos(1 - s/r)
    let segs: number;
    if (maxSagitta >= r) segs = minSegments;
    else {
        const dtheta = 2 * Math.acos(1 - maxSagitta / r);
        segs = Math.max(minSegments, Math.ceil(sweep / dtheta));
    }
    const a0 = e.kind === "circle" ? 0 : e.aStart;
    const out: Vec2[] = [];
    for (let i = 0; i <= segs; i++) {
        const t = i / segs;
        const a = a0 + sweep * t;
        out.push([e.center[0] + r * Math.cos(a), e.center[1] + r * Math.sin(a)]);
    }
    return out;
}

/** AABB (xmin, ymin, xmax, ymax)。 */
export function entityBounds(e: SketchEntity): [number, number, number, number] {
    if (e.kind === "line") {
        const xmin = Math.min(e.p0[0], e.p1[0]);
        const xmax = Math.max(e.p0[0], e.p1[0]);
        const ymin = Math.min(e.p0[1], e.p1[1]);
        const ymax = Math.max(e.p0[1], e.p1[1]);
        return [xmin, ymin, xmax, ymax];
    }
    if (e.kind === "polyline") {
        let xmin = Infinity, ymin = Infinity, xmax = -Infinity, ymax = -Infinity;
        for (const [x, y] of e.points) {
            if (x < xmin) xmin = x;
            if (y < ymin) ymin = y;
            if (x > xmax) xmax = x;
            if (y > ymax) ymax = y;
        }
        return [xmin, ymin, xmax, ymax];
    }
    if (e.kind === "circle") {
        return [e.center[0] - e.radius, e.center[1] - e.radius,
                e.center[0] + e.radius, e.center[1] + e.radius];
    }
    // arc — テッセレートして包む (簡易)
    const pts = tessellateEntity(e, 0.001, 32);
    let xmin = Infinity, ymin = Infinity, xmax = -Infinity, ymax = -Infinity;
    for (const [x, y] of pts) {
        if (x < xmin) xmin = x;
        if (y < ymin) ymin = y;
        if (x > xmax) xmax = x;
        if (y > ymax) ymax = y;
    }
    return [xmin, ymin, xmax, ymax];
}

/**
 * クリック位置 `p` がエンティティ上にあるか判定。当たれば `t` (0..1 弧長
 * 比) と `distance` を返す。
 */
export function pickEntity(
    e: SketchEntity,
    p: Vec2,
    tolerance: number,
): { t: number; distance: number } | null {
    if (e.kind === "line") {
        return pickSegment(e.p0, e.p1, p, tolerance);
    }
    if (e.kind === "polyline") {
        const n = entityEdgeCount(e);
        let best: { t: number; distance: number; edge: number } | null = null;
        for (let i = 0; i < n; i++) {
            const a = e.points[i];
            const b = e.points[(i + 1) % e.points.length];
            const r = pickSegment(a, b, p, tolerance);
            if (r && (!best || r.distance < best.distance)) best = { ...r, edge: i };
        }
        if (!best) return null;
        const total = n;
        return { t: (best.edge + best.t) / total, distance: best.distance };
    }
    if (e.kind === "circle" || e.kind === "arc") {
        const dx = p[0] - e.center[0];
        const dy = p[1] - e.center[1];
        const r = Math.hypot(dx, dy);
        const dist = Math.abs(r - e.radius);
        if (dist > tolerance) return null;
        if (e.kind === "circle") return { t: 0, distance: dist };
        // arc: 角度範囲チェック
        const a = wrap2pi(Math.atan2(dy, dx));
        const a0 = wrap2pi(e.aStart);
        const sweep = arcSweep(e);
        const da = wrap2pi(a - a0);
        if (da > sweep + 1e-9) return null;
        return { t: da / sweep, distance: dist };
    }
    return null;
}

function pickSegment(
    a: Vec2,
    b: Vec2,
    p: Vec2,
    tolerance: number,
): { t: number; distance: number } | null {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len2 = dx * dx + dy * dy;
    if (len2 < 1e-12) {
        const d = Math.hypot(p[0] - a[0], p[1] - a[1]);
        return d <= tolerance ? { t: 0, distance: d } : null;
    }
    let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    const cx = a[0] + dx * t;
    const cy = a[1] + dy * t;
    const d = Math.hypot(p[0] - cx, p[1] - cy);
    return d <= tolerance ? { t, distance: d } : null;
}

// ────────────────────────────────────────────────────────────────────────
// Mutators (immutable, return new entity)
// ────────────────────────────────────────────────────────────────────────

/** 端点を移動 (ソルバ / ドラッグの結果反映)。 */
export function withVertexAt(
    e: SketchEntity,
    ref: SketchVertexRef,
    pos: Vec2,
): SketchEntity {
    if (ref.entityId !== e.id) return e;
    if (ref.kind === "center" && (e.kind === "circle" || e.kind === "arc")) {
        return { ...e, center: pos };
    }
    if (ref.kind === "endpoint") {
        if (e.kind === "line") {
            if (ref.pointIdx === 0) return { ...e, p0: pos };
            if (ref.pointIdx === 1) return { ...e, p1: pos };
        }
        if (e.kind === "polyline") {
            const i = ref.pointIdx;
            if (i < 0 || i >= e.points.length) return e;
            const next = e.points.slice();
            next[i] = pos;
            return { ...e, points: next };
        }
        if (e.kind === "arc") {
            // 端点移動は (radius, aStart, aEnd) の再計算を伴う。中心は固定。
            const dx = pos[0] - e.center[0];
            const dy = pos[1] - e.center[1];
            const a = Math.atan2(dy, dx);
            const r = Math.hypot(dx, dy);
            if (ref.pointIdx === 0) return { ...e, radius: r, aStart: a };
            if (ref.pointIdx === 1) return { ...e, radius: r, aEnd: a };
        }
    }
    return e;
}

/** 円エンティティを部分弧 (`[aStart, aEnd]`) に置き換える。Trim 用。 */
export function trimCircleToArc(c: CircleEntity, aStart: number, aEnd: number): ArcEntity {
    const sweep = wrap2pi(aEnd - aStart);
    if (sweep === 0) {
        // 完全周トリム = 何もしない (Arc にはできない) → 端を 1ε ずらす
        return { id: c.id, construction: c.construction, kind: "arc",
                 center: c.center, radius: c.radius,
                 aStart, aEnd: aEnd - 1e-9 };
    }
    return {
        id: c.id, construction: c.construction, kind: "arc",
        center: c.center, radius: c.radius, aStart, aEnd,
    };
}
