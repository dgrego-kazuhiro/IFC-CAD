// SketchEntity[] → RoomPolygon[] 派生 (チェイン対応)。
//
// 真実の単一情報源は `SpaceElement.entities`。`RoomPolygon` は壁/IFC パイプ
// ラインが消費する派生キャッシュ。共有端点で繋がった line / arc / polyline
// (open) は 1 本のチェインとしてまとめ、閉ループなら閉ポリゴン、開チェイン
// なら edges 明示の開ポリゴンとして派生する。Circle / closed Polyline は
// 単独の自己閉ループ。

import { Vec2 } from "../../geometry/math/Vec2";
import { RoomPolygon } from "../elements/SpaceElement";
import { SketchEntity, tessellateEntity } from "./SketchEntity";
import { detectChains, tessellateChain, tessellateChainWithOwners } from "./SketchChain";

export interface DeriveOptions {
    /** 既存対応表 (entityId → polyId)。同じ chain / 自己閉 entity が再 derive
     *  される際に同じ polyId を保つ — 壁/エッジ ID のひも付きを維持する。 */
    polyIdByEntity?: Record<string, string>;
    /** 既存 polygon 群。`previous[id] === polyId` の RoomPolygon が見つかれば
     *  wallIds / wallsPerEdge / edgeIds 等の壁紐付けを引き継ぐ。 */
    previous?: RoomPolygon[];
    /** 新規 polyId 生成。 */
    nextPolyId: () => string;
    /** 円 / 弧のテッセレーション弦誤差 (m)。 */
    chordSagitta?: number;
}

export interface DeriveResult {
    polygons: RoomPolygon[];
    /**
     * derive 後の正準的な対応表 (entityId → polyId)。各 chain に属する
     * すべての entity が同じ polyId を持つ。setSpaceEntities 側はこれを
     * そのまま `SpaceElement.polyIdByEntity` に書く。
     */
    polyIdByEntity: Record<string, string>;
}

export function derivePolygonsFromEntities(
    entities: SketchEntity[],
    opts: DeriveOptions,
): DeriveResult {
    const previousById = new Map<string, RoomPolygon>();
    if (opts.previous) for (const p of opts.previous) previousById.set(p.id, p);
    const sagitta = opts.chordSagitta ?? 0.005;
    const oldMap = opts.polyIdByEntity ?? {};

    const polygons: RoomPolygon[] = [];
    const polyIdByEntity: Record<string, string> = {};
    const byId = new Map<string, SketchEntity>(entities.map((e) => [e.id, e]));

    const { chains, selfClosed } = detectChains(entities);

    // ── 1. 自己閉エンティティ (Circle / closed Polyline) ─────────────────
    for (const e of selfClosed) {
        const polyId = oldMap[e.id] ?? opts.nextPolyId();
        polyIdByEntity[e.id] = polyId;
        const prev = previousById.get(polyId);
        if (e.kind === "circle") {
            const tess = tessellateEntity(e, sagitta, 128);
            const outer = sameVec2(tess[0], tess[tess.length - 1])
                ? tess.slice(0, -1)
                : tess;
            // 全 edge が circle entity 由来 (= 単一 wall グループ)。
            const edgeOwners = new Array<string>(outer.length).fill(e.id);
            polygons.push(makeRoomPolygon(polyId, outer, prev, {
                shape: { type: "circle", center: e.center, radius: e.radius },
                edgeOwners,
            }));
        } else if (e.kind === "polyline" && e.closed && e.points.length >= 3) {
            // 全 edge が polyline entity 由来。
            const edgeOwners = new Array<string>(e.points.length).fill(e.id);
            polygons.push(makeRoomPolygon(polyId, e.points.slice(), prev, { edgeOwners }));
        }
    }

    // ── 2. チェイン (line / open polyline / arc の連結) ──────────────────
    for (const chain of chains) {
        if (chain.steps.length === 0) continue;
        const { points, edgeOwners } = tessellateChainWithOwners(chain, byId, sagitta);
        if (points.length < 2) continue;

        // polyId はチェイン内の既存 entity から先勝ち優先で引き継ぐ。
        // 全 entity 未知なら新規発行。
        let polyId: string | null = null;
        for (const step of chain.steps) {
            const existing = oldMap[step.entityId];
            if (existing) { polyId = existing; break; }
        }
        if (!polyId) polyId = opts.nextPolyId();
        for (const step of chain.steps) polyIdByEntity[step.entityId] = polyId;

        const prev = previousById.get(polyId);
        const overrides: Partial<RoomPolygon> = { edgeOwners };
        if (!chain.closed) {
            // 開チェイン: explicit edges (= 既存 wallPath と同形式)
            const edges: [number, number][] = [];
            for (let i = 0; i < points.length - 1; i++) edges.push([i, i + 1]);
            overrides.edges = edges;
            // 開チェインは edge 数 = points.length - 1。tessellateChainWithOwners
            // は閉チェインを想定して edge 数 = points.length を出すので末尾を切る。
            overrides.edgeOwners = edgeOwners.slice(0, edges.length);
        }
        polygons.push(makeRoomPolygon(polyId, points, prev, overrides));
    }

    return { polygons, polyIdByEntity };
}

function makeRoomPolygon(
    id: string,
    outer: Vec2[],
    prev: RoomPolygon | undefined,
    overrides: Partial<RoomPolygon> = {},
): RoomPolygon {
    return {
        id,
        outer,
        holes: [],
        wallIds: prev?.wallIds,
        wallsPerEdge: prev?.wallsPerEdge,
        wallThickness: prev?.wallThickness,
        innerThickness: prev?.innerThickness,
        outerThickness: prev?.outerThickness,
        wallReference: prev?.wallReference,
        edgeIds: prev?.edgeIds,
        sharedEdgeIds: prev?.sharedEdgeIds,
        vertexConnections: prev?.vertexConnections,
        wallOutlineOf: prev?.wallOutlineOf,
        edgeOwners: prev?.edgeOwners,
        // joints: WallPath で確定した T 字接合ヒント。entity 駆動の re-derive
        // (= setSpaceEntities → derivePolygonsFromEntities) でも保持しないと、
        // 隣接 setSpaceEntities が走った瞬間に joints が消えて WallPath の
        // 接合情報が失われる。
        joints: prev?.joints,
        ...overrides,
    };
}

/**
 * 既存 RoomPolygon[] から SketchEntity[] を合成する (永続データ移行用)。
 *  - shape:circle ある → CircleEntity
 *  - 閉ループ (= edges 未設定 OR cyclic) → 閉 PolylineEntity
 *  - 開ポリゴン (edges chain) → 開 PolylineEntity (1 本)
 */
export function entitiesFromLegacyPolygons(
    polygons: RoomPolygon[],
    nextEntityId: () => string,
): { entities: SketchEntity[]; polyIdByEntity: Record<string, string> } {
    const entities: SketchEntity[] = [];
    const polyIdByEntity: Record<string, string> = {};
    for (const p of polygons) {
        const id = nextEntityId();
        polyIdByEntity[id] = p.id;
        if (p.shape?.type === "circle") {
            entities.push({
                id, kind: "circle",
                center: p.shape.center, radius: p.shape.radius,
            });
        } else if (isPolygonOpen(p)) {
            entities.push({
                id, kind: "polyline",
                points: p.outer.map(([x, y]) => [x, y] as Vec2),
                closed: false,
            });
        } else {
            entities.push({
                id, kind: "polyline",
                points: p.outer.map(([x, y]) => [x, y] as Vec2),
                closed: true,
            });
        }
    }
    return { entities, polyIdByEntity };
}

function isPolygonOpen(p: RoomPolygon): boolean {
    if (!p.edges) return false;
    const n = p.outer.length;
    if (p.edges.length !== n) return true; // edges < n → 必ず開
    // edges が cyclic でなければ open (= chain 形式)
    for (let i = 0; i < n; i++) {
        const [a, b] = p.edges[i];
        if (a !== i || b !== (i + 1) % n) return true;
    }
    return false;
}

function sameVec2(a: Vec2, b: Vec2, eps = 1e-9): boolean {
    return Math.abs(a[0] - b[0]) < eps && Math.abs(a[1] - b[1]) < eps;
}
