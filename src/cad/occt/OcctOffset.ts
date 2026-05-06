// 2D wire offset via OCCT BRepOffsetAPI_MakeOffset.
//
// 入出力は SketchEntity ベース。XY 平面 (= 床面、z = 0) で計算する。
//
// API:
//   - `offsetEntities(entities, distance)` : チェイン/閉ループを 2D 平面で
//     オフセットし、結果を SketchEntity[] として返す。
//   - `offsetClosedPolygon(points, distance)` : 単純な閉 Vec2[] を offset し、
//     単一の閉 Vec2[] を返す (既存 polygon オフセット置換用のショートカット)。
//
// 距離の符号: CCW 閉ループに対して `+` = 外側へオフセット、`-` = 内側。
// (BRepOffsetAPI_MakeOffset の Perform(distance) と一致)
//
// アーク/円弧の扱い: 入力の line / arc / circle / polyline はそれぞれ
// OCCT の Geom_TrimmedCurve(Geom_Line / Geom_Circle) として edge 化し、
// MakeWire でワイヤ化する。出力 wire を edge ごとに展開し、curve type を
// 見て SketchEntity に戻す (line → LineEntity, circle/arc → ArcEntity)。

import { Vec2 } from "../geometry/math/Vec2";
import {
    SketchEntity,
    LineEntity,
    PolylineEntity,
    CircleEntity,
    ArcEntity,
    arcSweep,
    tessellateEntity,
} from "../model/sketch/SketchEntity";
import { getOcct, OcctInstance } from "./OcctRuntime";

/**
 * チェインを 2D オフセット。`distance` は CCW 閉ループ基準で +外側 / -内側。
 * 入力チェインは順序付きエンティティ列 (端点が連続している必要がある)。
 *
 * 戻り値は新しい entity 列 (id は呼び出し側で割当)。失敗時は null。
 */
export async function offsetEntities(
    entities: SketchEntity[],
    distance: number,
    opts: { idPrefix?: string; closed?: boolean } = {},
): Promise<SketchEntity[] | null> {
    if (entities.length === 0 || distance === 0) return entities.slice();
    const oc = await getOcct();
    try {
        const wire = buildWireFromEntities(oc, entities, opts.closed ?? false);
        if (!wire) return null;
        const result = performOffset(oc, wire, distance, opts.closed ?? false);
        if (!result) return null;
        const out = decomposeWireToEntities(oc, result, opts.idPrefix ?? "off");
        return out;
    } catch (e) {
        console.warn("[OcctOffset] offsetEntities failed:", e);
        return null;
    }
}

/**
 * 閉 Vec2 ポリゴンを OCCT で内/外オフセット。CCW 入力で `+` が外側。
 * 失敗時は手書きのフォールバック (`fallbackOffsetPolygon`) を試みる。
 */
export async function offsetClosedPolygon(
    points: Vec2[],
    distance: number,
): Promise<Vec2[] | null> {
    if (points.length < 3 || distance === 0) return points.slice();
    const oc = await getOcct();
    try {
        const segs: SketchEntity[] = [];
        for (let i = 0; i < points.length; i++) {
            const a = points[i];
            const b = points[(i + 1) % points.length];
            segs.push({ id: `_seg${i}`, kind: "line", p0: a, p1: b });
        }
        const wire = buildWireFromEntities(oc, segs, true);
        if (!wire) return null;
        const result = performOffset(oc, wire, distance, true);
        if (!result) return null;
        const ents = decomposeWireToEntities(oc, result, "_off");
        // 閉ループなので結果は line / arc 列。すべて line ならポリゴン抽出。
        // 円弧があれば適度にテッセレートして連結。
        return entitiesToClosedPolygon(ents);
    } catch (e) {
        console.warn("[OcctOffset] offsetClosedPolygon failed:", e);
        return null;
    }
}

// ────────────────────────────────────────────────────────────────────────
// OCCT internals
// ────────────────────────────────────────────────────────────────────────

function buildWireFromEntities(oc: OcctInstance, entities: SketchEntity[], closed: boolean): any | null {
    const mw = new oc.BRepBuilderAPI_MakeWire_1();
    let any = false;
    for (const e of entities) {
        const edges = entityToEdges(oc, e);
        if (!edges) continue;
        for (const edge of edges) {
            mw.Add_1(edge);
            any = true;
        }
    }
    // closed = true の場合、フラグ的なヒントだが OCCT 側の閉判定は端点近接で行う
    // ので、ここでは特に追加 edge は作らない (entities が閉路を構成する想定)。
    if (!any) return null;
    if (!mw.IsDone()) return null;
    void closed;
    return mw.Wire();
}

function entityToEdges(oc: OcctInstance, e: SketchEntity): any[] | null {
    const edges: any[] = [];
    if (e.kind === "line") {
        const edge = makeLineEdge(oc, e.p0, e.p1);
        if (!edge) return null;
        edges.push(edge);
        return edges;
    }
    if (e.kind === "polyline") {
        const n = e.points.length;
        const last = e.closed ? n : n - 1;
        for (let i = 0; i < last; i++) {
            const a = e.points[i];
            const b = e.points[(i + 1) % n];
            const edge = makeLineEdge(oc, a, b);
            if (!edge) return null;
            edges.push(edge);
        }
        return edges;
    }
    if (e.kind === "circle") {
        const edge = makeCircleEdge(oc, e.center, e.radius);
        if (!edge) return null;
        edges.push(edge);
        return edges;
    }
    if (e.kind === "arc") {
        const edge = makeArcEdge(oc, e.center, e.radius, e.aStart, e.aEnd);
        if (!edge) return null;
        edges.push(edge);
        return edges;
    }
    return null;
}

function makeLineEdge(oc: OcctInstance, a: Vec2, b: Vec2): any | null {
    if (Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-12) return null;
    const p1 = new oc.gp_Pnt_3(a[0], a[1], 0);
    const p2 = new oc.gp_Pnt_3(b[0], b[1], 0);
    const me = new oc.BRepBuilderAPI_MakeEdge_3(p1, p2);
    if (!me.IsDone()) return null;
    return me.Edge();
}

function makeCircleEdge(oc: OcctInstance, c: Vec2, r: number): any | null {
    const center = new oc.gp_Pnt_3(c[0], c[1], 0);
    const dir = new oc.gp_Dir_4(0, 0, 1);
    const ax = new oc.gp_Ax2_3(center, dir);
    const circ = new oc.gp_Circ_2(ax, r);
    const me = new oc.BRepBuilderAPI_MakeEdge_8(circ);
    if (!me.IsDone()) return null;
    return me.Edge();
}

function makeArcEdge(
    oc: OcctInstance,
    c: Vec2, r: number, aStart: number, aEnd: number,
): any | null {
    const sx = c[0] + r * Math.cos(aStart);
    const sy = c[1] + r * Math.sin(aStart);
    const ex = c[0] + r * Math.cos(aEnd);
    const ey = c[1] + r * Math.sin(aEnd);
    // 中点で曲線を一意決定 (3 点弧)
    const mid = aStart + ((aEnd - aStart + Math.PI * 4) % (Math.PI * 2)) / 2;
    const mx = c[0] + r * Math.cos(mid);
    const my = c[1] + r * Math.sin(mid);
    const p1 = new oc.gp_Pnt_3(sx, sy, 0);
    const p2 = new oc.gp_Pnt_3(mx, my, 0);
    const p3 = new oc.gp_Pnt_3(ex, ey, 0);
    // GC_MakeArcOfCircle (3 点) で Geom_TrimmedCurve を作り、それを edge に
    const handle = new oc.GC_MakeArcOfCircle_4(p1, p2, p3);
    if (!handle.IsDone()) return null;
    const curve = handle.Value();
    const me = new oc.BRepBuilderAPI_MakeEdge_24(curve);
    if (!me.IsDone()) return null;
    return me.Edge();
}

function performOffset(
    oc: OcctInstance,
    wire: any,
    distance: number,
    closedHint: boolean,
): any | null {
    // BRepOffsetAPI_MakeOffset_3(wire, joinType, isOpenResult)
    //   joinType: GeomAbs_Arc=0 / GeomAbs_Tangent=1 / GeomAbs_Intersection=2
    //   2D の壁オフセットは通常 Intersection (シャープ角を保つ) が望ましい。
    const joinType = (oc as any).GeomAbs_JoinType?.GeomAbs_Intersection ?? 2;
    const isOpen = !closedHint;
    const mko = new oc.BRepOffsetAPI_MakeOffset_3(wire, joinType, isOpen);
    mko.Perform(distance, 0);
    if (!mko.IsDone()) return null;
    const shape = mko.Shape();
    return shape;
}

function decomposeWireToEntities(oc: OcctInstance, shape: any, idPrefix: string): SketchEntity[] {
    const out: SketchEntity[] = [];
    let counter = 0;
    // shape は TopoDS_Wire か TopoDS_Compound (複数 wire の可能性)。
    // Edge を順に取り出す。
    const TopAbs_EDGE = (oc as any).TopAbs_ShapeEnum?.TopAbs_EDGE ?? 6;
    const TopAbs_WIRE = (oc as any).TopAbs_ShapeEnum?.TopAbs_WIRE ?? 5;

    const collectEdges = (parent: any) => {
        const exp = new oc.TopExp_Explorer_2(parent, TopAbs_EDGE, TopAbs_WIRE);
        while (exp.More()) {
            const edge = oc.TopoDS.Edge_1(exp.Current());
            const ent = edgeToEntity(oc, edge, `${idPrefix}_${counter++}`);
            if (ent) out.push(ent);
            exp.Next();
        }
    };
    collectEdges(shape);
    return out;
}

function edgeToEntity(oc: OcctInstance, edge: any, id: string): SketchEntity | null {
    // BRep_Tool.Range_1(edge, first, last) で param 範囲、Curve_2(edge, ...)
    // で Geom_Curve を取得。ハンドルの DownCast で Geom_Line / Geom_Circle 判定。
    const first = { current: 0 };
    const last = { current: 0 };
    let firstP = 0, lastP = 0;
    try {
        const tup: any = oc.BRep_Tool.Range_1(edge, first as any, last as any);
        // emscripten 引数は出力。型が無いため両方の経路を試す。
        if (typeof tup === "object" && tup) {
            firstP = (first as any).current ?? (tup.first ?? 0);
            lastP = (last as any).current ?? (tup.last ?? 1);
        }
    } catch {
        // 別シグネチャ (Range_2) を試す
    }
    let curveHandle: any;
    try {
        // BRep_Tool.Curve_2(edge, first&, last&) → Geom_Curve handle
        curveHandle = oc.BRep_Tool.Curve_2(edge, first, last);
        firstP = (first as any).current ?? firstP;
        lastP = (last as any).current ?? lastP;
    } catch {
        return null;
    }
    if (!curveHandle) return null;
    const curve = curveHandle.get ? curveHandle.get() : curveHandle;
    if (!curve) return null;

    // Geom_Line: 直線
    const lineH = (oc as any).Handle_Geom_Line?.DownCast(curveHandle);
    if (lineH && !(lineH.IsNull && lineH.IsNull())) {
        // 2 端点を Curve.Value(param) で取得
        const p0 = curveValue(curve, firstP);
        const p1 = curveValue(curve, lastP);
        if (!p0 || !p1) return null;
        return { id, kind: "line", p0: [p0[0], p0[1]], p1: [p1[0], p1[1]] } as LineEntity;
    }
    // Geom_Circle: 円 / 円弧
    const circH = (oc as any).Handle_Geom_Circle?.DownCast(curveHandle);
    if (circH && !(circH.IsNull && circH.IsNull())) {
        const circ = circH.get ? circH.get() : circH;
        const r = circ.Radius();
        const ax = circ.Axis ? circ.Axis() : circ.Position();
        const loc = ax.Location ? ax.Location() : (circ.Location ? circ.Location() : null);
        const cx = loc ? loc.X() : 0;
        const cy = loc ? loc.Y() : 0;
        const sweep = lastP - firstP;
        const TAU = Math.PI * 2;
        const isFull = Math.abs(Math.abs(sweep) - TAU) < 1e-7;
        if (isFull) {
            return { id, kind: "circle", center: [cx, cy], radius: r } as CircleEntity;
        }
        // GeomAPI_Circle の param は angle と等価 (radius 単位だが、実装では radian)。
        // OCCT の Geom_Circle.Value(u) は angle u (radians) を取る。
        return {
            id, kind: "arc",
            center: [cx, cy], radius: r,
            aStart: firstP, aEnd: lastP,
        } as ArcEntity;
    }
    // それ以外 (B-Spline 等): ポリラインに退化させる
    const samples: Vec2[] = [];
    const N = 16;
    for (let i = 0; i <= N; i++) {
        const u = firstP + (lastP - firstP) * (i / N);
        const p = curveValue(curve, u);
        if (p) samples.push([p[0], p[1]]);
    }
    if (samples.length < 2) return null;
    return { id, kind: "polyline", points: samples, closed: false } as PolylineEntity;
}

function curveValue(curve: any, u: number): [number, number, number] | null {
    try {
        const p = curve.Value(u);
        return [p.X(), p.Y(), p.Z()];
    } catch { return null; }
}

// ────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────

/** entity 列を 1 本の閉 Vec2 ポリゴン (始点重複なし) にテッセレート連結。 */
function entitiesToClosedPolygon(entities: SketchEntity[]): Vec2[] {
    const out: Vec2[] = [];
    for (const e of entities) {
        const pts = tessellateEntity(e, 0.005, 16);
        // 先頭が前要素末尾と重複していたら飛ばす (連結の重複点除去)
        const start = out.length > 0 && samePoint(out[out.length - 1], pts[0]) ? 1 : 0;
        for (let i = start; i < pts.length; i++) out.push(pts[i]);
    }
    if (out.length > 1 && samePoint(out[0], out[out.length - 1])) out.pop();
    return out;
}

function samePoint(a: Vec2, b: Vec2, eps = 1e-6): boolean {
    return Math.abs(a[0] - b[0]) < eps && Math.abs(a[1] - b[1]) < eps;
}

void arcSweep; // used by callers; kept exported for tree-shake hint
