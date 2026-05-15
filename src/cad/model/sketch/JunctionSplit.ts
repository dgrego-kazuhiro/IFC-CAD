// Cross-space junction splits applied at derive time.
//
// 設計原則: polygon は entity からの一方通行 derive。`derivePolygonsFromEntities`
// は 1 つの Space 内の polygon を作るだけだが、複数 Space の polygon が共通する
// edge / vertex を持つ場合は junction split (= 交点に頂点を挿入) が必要になる。
// これを wallRegenerate 側でやると polygon と entity が構造的に乖離するので、
// 全 Space 横断の split 計算をここで行い、entity → polygon の derive の一部として
// polygon に split 頂点を含めて返す。
//
// 仕様:
//  - 入力: elements (state.elements) — 全 Space を内包。
//  - 出力: Map<spaceId, RoomPolygon[]> — split が適用された polygon 配列。
//  - 非破壊: 入力 polygon は変更しない。新しい polygon オブジェクトを返す。
//  - wallOutline polygon (= wallOutlineOf 付き) は派生扱いなので split しない。

import { BaseElement } from "../base/BaseElement";
import { SpaceElement, RoomPolygon, polygonEdges } from "../elements/SpaceElement";
import { Vec2 } from "../../geometry/math/Vec2";
import { buildJunctionGraph } from "../../topology/junctions/JunctionGraph";

const ROOM_SHAPE_DEBUG = true;
const fmtPt = (p: Vec2) => `(${p[0].toFixed(3)},${p[1].toFixed(3)})`;
const fmtRing = (pts: Vec2[]) => `[${pts.map(fmtPt).join(" ")}]`;
const SAME_POINT_EPS = 1e-7;
const samePoint = (a: Vec2, b: Vec2) =>
    Math.abs(a[0] - b[0]) <= SAME_POINT_EPS && Math.abs(a[1] - b[1]) <= SAME_POINT_EPS;

export function applyJunctionSplitsAcrossSpaces(
    elements: Record<string, BaseElement>,
): Map<string, RoomPolygon[]> {
    // 1. 全 Space の non-outline polygon を集める。
    const allPolygons: { spaceId: string; poly: RoomPolygon }[] = [];
    for (const eid in elements) {
        const el = elements[eid];
        if (!el || el.type !== "Space") continue;
        const sp = el as SpaceElement;
        for (const poly of sp.polygons ?? []) {
            if (poly.wallOutlineOf) continue;
            allPolygons.push({ spaceId: eid, poly });
        }
    }
    // 0/1 個ならクロススペース overlap は発生しないので素通し。
    if (allPolygons.length < 2) {
        const result = new Map<string, RoomPolygon[]>();
        for (const eid in elements) {
            const sp = elements[eid] as SpaceElement | undefined;
            if (sp?.type === "Space") result.set(eid, sp.polygons ?? []);
        }
        return result;
    }

    // 2. JunctionGraph を構築 (= 全 polygon の overlap / shared edges を検出)。
    const graph = buildJunctionGraph(allPolygons.map((ap) => ap.poly));

    // 3. 各 polygon について、split 頂点を含む新しい outer を作る。
    const newPolyById = new Map<string, RoomPolygon>();
    for (const { poly } of allPolygons) {
        const polyEdgeList = polygonEdges(poly);
        const newOuter: Vec2[] = [];
        const oldVertexToNew: number[] = new Array(poly.outer.length).fill(-1);
        const appendUnique = (pt: Vec2): number => {
            const last = newOuter[newOuter.length - 1];
            if (last && samePoint(last, pt)) return newOuter.length - 1;
            // Closed polygon rings are stored without repeating the first point.
            // If a split lands exactly on the first point at the end of the pass,
            // do not append it as a duplicate terminal vertex.
            const first = newOuter[0];
            if (first && newOuter.length > 2 && samePoint(first, pt)) return 0;
            const idx = newOuter.length;
            newOuter.push([pt[0], pt[1]]);
            return idx;
        };
        const ensureOldVertex = (oldIdx: number): number => {
            if (oldVertexToNew[oldIdx] >= 0) return oldVertexToNew[oldIdx];
            const newIdx = appendUnique(poly.outer[oldIdx]);
            oldVertexToNew[oldIdx] = newIdx;
            return newIdx;
        };
        let modified = false;
        for (let ei = 0; ei < polyEdgeList.length; ei++) {
            const [aIdx, bIdx] = polyEdgeList[ei];
            ensureOldVertex(aIdx);
            const veIds = graph.edgeToVes.get(`${poly.id}:${ei}`) ?? [];
            // VE が複数あれば中間境界に split 頂点を挿入。
            //  veIds[0].end, veIds[1].end, ..., veIds[N-2].end が split 点 (= VE 区間の境界)。
            //  veIds[N-1].end は edge の終端 = bIdx と同じ位置。
            if (veIds.length > 1) {
                for (let k = 0; k < veIds.length - 1; k++) {
                    const ve = graph.virtualEdges.get(veIds[k]);
                    if (!ve) continue;
                    const before = newOuter.length;
                    appendUnique(ve.end);
                    if (newOuter.length !== before) modified = true;
                }
            }
            ensureOldVertex(bIdx);
        }
        if (modified) {
            if (ROOM_SHAPE_DEBUG) {
                const splitEdges: string[] = [];
                for (let ei = 0; ei < polyEdgeList.length; ei++) {
                    const veIds = graph.edgeToVes.get(`${poly.id}:${ei}`) ?? [];
                    if (veIds.length <= 1) continue;
                    splitEdges.push(
                        `e${ei}:ves=${veIds.length} `
                        + veIds
                            .slice(0, -1)
                            .map((id) => {
                                const ve = graph.virtualEdges.get(id);
                                return ve ? fmtPt(ve.end) : "?";
                            })
                            .join(","),
                    );
                }
                // eslint-disable-next-line no-console
                console.log(
                    `[room-debug] JunctionSplit poly=${poly.id.slice(0, 6)} `
                    + `old=${poly.outer.length}v${fmtRing(poly.outer)} `
                    + `new=${newOuter.length}v${fmtRing(newOuter)} `
                    + `splits=[${splitEdges.join(" | ")}]`,
                );
            }
            // 注意: wallIds / edgeIds / wallsPerEdge などのメタデータは旧 edge
            // index 基準で保存されているため、新 outer (= 頂点数増) と齟齬する。
            // ここではメタデータをクリアして wallRegenerate に再構築させる。
            // (wallRegenerate は edgeIds が無い場合 fresh に生成する。)
            const next: RoomPolygon = {
                ...poly,
                outer: newOuter,
                wallIds: undefined,
                wallsPerEdge: undefined,
                edgeIds: undefined,
                sharedEdgeIds: undefined,
                vertexConnections: undefined,
                edgeOwners: undefined,
                // edges (= 明示的 edge list) も outer の頂点数変化に合わせてクリア。
                // 閉ループなら次回 polygonEdges() が cyclic として再生成する。
                edges: undefined,
            };
            newPolyById.set(poly.id, next);
        } else {
            newPolyById.set(poly.id, poly);
        }
    }

    // 4. Space ごとに polygon 配列を組み立てて返す。
    //    outline polygon (wallOutlineOf 付き) はそのまま残す (= 派生処理は別途)。
    const result = new Map<string, RoomPolygon[]>();
    for (const eid in elements) {
        const el = elements[eid];
        if (!el || el.type !== "Space") continue;
        const sp = el as SpaceElement;
        const polys: RoomPolygon[] = (sp.polygons ?? []).map((p) => {
            if (p.wallOutlineOf) return p;
            return newPolyById.get(p.id) ?? p;
        });
        result.set(eid, polys);
    }
    return result;
}
