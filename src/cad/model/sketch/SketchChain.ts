// SketchEntity 列のチェイン検出 (= 共有端点で繋がるグループ抽出)。
//
// 線・弧・開ポリラインは「チェイン可能」エンティティで、共有端点で繋ぐと
// 閉ループ (= 部屋境界) または開チェイン (= 単独壁列) を成す。円と閉ポリ
// ラインは「自己閉」エンティティで、それ自身がループなのでチェインに参加
// しない。
//
// 入力 entity 列を connected components に分割し、各コンポーネントについて
//   - closed = true: 一周して始点に戻る閉チェイン
//   - closed = false: どちらかの端で行き止まる開チェイン (1 entity の場合も含む)
// として返す。各 entity には traversal 方向を示す `reversed` フラグが付く。

import { Vec2 } from "../../geometry/math/Vec2";
import {
    SketchEntity,
    SketchEntityId,
    tessellateEntity,
} from "./SketchEntity";

export interface ChainStep {
    entityId: SketchEntityId;
    /** false: 自然方向 (endpoint 0 → 1) で辿る。true: 逆向き (1 → 0)。 */
    reversed: boolean;
}

export interface SketchChain {
    steps: ChainStep[];
    closed: boolean;
}

/**
 * 端点一致の許容距離 (m)。Snap 経由でつないだ entity が浮動小数点で
 * 微妙にズレたケースを吸収する。
 */
export const CHAIN_ENDPOINT_EPS = 1e-4;

function quantize(v: number): number {
    return Math.round(v / CHAIN_ENDPOINT_EPS) * CHAIN_ENDPOINT_EPS;
}

function endpointKey(p: Vec2): string {
    return `${quantize(p[0])}:${quantize(p[1])}`;
}

/**
 * チェイン可能エンティティの端点 (end=0 = 始点 / end=1 = 終点) を返す。
 * 自己閉エンティティ (Circle / closed Polyline) は呼び出し側で除外すること。
 */
export function chainEndpoint(e: SketchEntity, end: 0 | 1): Vec2 {
    if (e.kind === "line") return end === 0 ? e.p0 : e.p1;
    if (e.kind === "polyline") {
        const pts = e.points;
        return end === 0 ? pts[0] : pts[pts.length - 1];
    }
    if (e.kind === "arc") {
        const a = end === 0 ? e.aStart : e.aEnd;
        return [
            e.center[0] + e.radius * Math.cos(a),
            e.center[1] + e.radius * Math.sin(a),
        ];
    }
    return [0, 0];
}

export function isChainable(e: SketchEntity): boolean {
    if (e.kind === "circle") return false;
    if (e.kind === "polyline" && e.closed) return false;
    return true;
}

/**
 * チェイン検出。
 *  - `chains`: 共有端点でつながった chainable entity のグループ。各グループは
 *    閉ループまたは開チェイン。単独の line/arc/open-polyline も長さ 1 の開
 *    チェインとして含まれる。
 *  - `selfClosed`: Circle + closed Polyline (= 自己閉エンティティ)。
 */
export function detectChains(entities: SketchEntity[]): {
    chains: SketchChain[];
    selfClosed: SketchEntity[];
} {
    const selfClosed: SketchEntity[] = [];
    const chainable: SketchEntity[] = [];
    for (const e of entities) {
        if (e.construction) continue;
        if (isChainable(e)) chainable.push(e);
        else selfClosed.push(e);
    }

    // 端点 → そこに集まる (entityId, end) のリスト
    const adj = new Map<string, { entityId: SketchEntityId; end: 0 | 1 }[]>();
    for (const e of chainable) {
        for (const end of [0, 1] as const) {
            const k = endpointKey(chainEndpoint(e, end));
            const arr = adj.get(k) ?? [];
            arr.push({ entityId: e.id, end });
            adj.set(k, arr);
        }
    }

    const byId = new Map<SketchEntityId, SketchEntity>(chainable.map((e) => [e.id, e]));
    const visited = new Set<SketchEntityId>();
    const chains: SketchChain[] = [];

    for (const start of chainable) {
        if (visited.has(start.id)) continue;
        const chain = walkChain(start, byId, adj, visited);
        chains.push(chain);
    }

    return { chains, selfClosed };
}

/**
 * `start` を起点に、両方向 (forward = end1 側 / backward = end0 側) に
 * チェインを伸ばす。閉ループに戻ったら closed=true で打ち切り、行き止まったら
 * 開チェインとして返す。
 *
 * 分岐 (3 本以上が同一端点に集まる T 字) では list 順で先頭の未訪問候補を採る
 * — 入力順に依存する不定挙動だが、エンティティモデルの自然な使い方では
 * T 字は別の RoomPolygon 経由で組まれるため、許容する。
 */
function walkChain(
    start: SketchEntity,
    byId: Map<SketchEntityId, SketchEntity>,
    adj: Map<string, { entityId: SketchEntityId; end: 0 | 1 }[]>,
    visited: Set<SketchEntityId>,
): SketchChain {
    visited.add(start.id);
    const startEntry0 = chainEndpoint(start, 0);
    let steps: ChainStep[] = [{ entityId: start.id, reversed: false }];

    // ── Forward extension (start.end1 から先へ) ─────────────────────────
    let last: SketchEntity = start;
    let lastExit: 0 | 1 = 1;
    while (true) {
        const exitPos = chainEndpoint(last, lastExit);
        // ループ閉合判定: もし exit が start の entry 0 と一致するなら閉
        if (steps.length > 1 && endpointKey(exitPos) === endpointKey(startEntry0)) {
            return { steps, closed: true };
        }
        const cands = (adj.get(endpointKey(exitPos)) ?? [])
            .filter((c) => c.entityId !== last.id && !visited.has(c.entityId));
        if (cands.length === 0) break;
        const next = cands[0];
        const nextEnt = byId.get(next.entityId);
        if (!nextEnt) break;
        // next.end === 0 で接続: forward 方向 (reversed=false) → exit = 1
        // next.end === 1 で接続: reversed 方向 → exit = 0
        const reversed = next.end === 1;
        steps.push({ entityId: nextEnt.id, reversed });
        visited.add(nextEnt.id);
        last = nextEnt;
        lastExit = reversed ? 0 : 1;
    }

    // ── Backward extension (start.end0 から手前へ) ─────────────────────
    last = start;
    let lastEntry: 0 | 1 = 0;
    const prepend: ChainStep[] = [];
    while (true) {
        const entryPos = chainEndpoint(last, lastEntry);
        const cands = (adj.get(endpointKey(entryPos)) ?? [])
            .filter((c) => c.entityId !== last.id && !visited.has(c.entityId));
        if (cands.length === 0) break;
        const prev = cands[0];
        const prevEnt = byId.get(prev.entityId);
        if (!prevEnt) break;
        // prev.end === 1 で接続: prev は forward に流れて 1 で抜ける
        //   → reversed=false、prev の entry は 0
        // prev.end === 0 で接続: prev は逆向きに辿られ 0 で抜ける
        //   → reversed=true、prev の entry は 1
        const reversed = prev.end === 0;
        prepend.unshift({ entityId: prevEnt.id, reversed });
        visited.add(prevEnt.id);
        last = prevEnt;
        lastEntry = reversed ? 1 : 0;
    }

    if (prepend.length > 0) steps = [...prepend, ...steps];
    return { steps, closed: false };
}

/**
 * チェインを Vec2 列にテッセレート。
 *  - 閉チェイン: 閉曲線 (始点重複なし)
 *  - 開チェイン: 始点〜終点の連結列
 *
 * 弧/円は `tessellateEntity` の chord-sagitta ベースのサンプリングを使う。
 * `reversed: true` の entity は点列を反転して接続する。隣接 entity 間で
 * 端点が同位置になるはずなので重複点は除去する。
 */
export function tessellateChain(
    chain: SketchChain,
    byId: Map<SketchEntityId, SketchEntity>,
    chordSagitta = 0.005,
): Vec2[] {
    return tessellateChainWithOwners(chain, byId, chordSagitta).points;
}

/**
 * `tessellateChain` の拡張版。各 **edge** (= 隣接 2 点の間) を生成した
 * SketchEntity の ID を `edgeOwners[i]` として並行出力する。長さは
 * `points.length` (閉チェインなら edge i = points[i] → points[(i+1)%N]、
 * 開チェインなら edge i = points[i] → points[i+1] で i ∈ [0, points.length-1])。
 *
 * - 直線/開ポリライン由来の連続 edge は対応 entity ID を共有
 * - 円弧由来の全テッセレーション edge は ArcEntity.id を共有
 *
 * これにより wallRegenerate 側で「同じ entity 由来の連続 edge」を 1 つの
 * 論理 wall としてグループ化できる。
 */
export function tessellateChainWithOwners(
    chain: SketchChain,
    byId: Map<SketchEntityId, SketchEntity>,
    chordSagitta = 0.005,
): { points: Vec2[]; edgeOwners: string[] } {
    const out: Vec2[] = [];
    // pointOwner[k] = points[k] を contributed した entity の id (最初の
    // entity の最初の点については undefined → 後で「edge i は points[(i+1)%N]
    // を出力した entity 由来」のルールで埋める)。
    const pointOwner: (string | undefined)[] = [];
    for (const step of chain.steps) {
        const ent = byId.get(step.entityId);
        if (!ent) continue;
        let pts = tessellateEntity(ent, chordSagitta, 64);
        if (step.reversed) pts = pts.slice().reverse();
        const startSkip = out.length > 0 && samePoint(out[out.length - 1], pts[0]) ? 1 : 0;
        for (let j = startSkip; j < pts.length; j++) {
            out.push(pts[j]);
            pointOwner.push(step.entityId);
        }
    }
    if (chain.closed && out.length > 1 && samePoint(out[0], out[out.length - 1])) {
        out.pop();
        pointOwner.pop();
    }
    const N = out.length;
    // edge i = points[i] → points[(i+1)%N] は points[(i+1)%N] を生成した
    // entity 由来とみなす (= 「次の点を出した entity が辺を引いた」)。
    // 例外: 閉チェインの末尾 edge (i=N-1) は dedup pop により「最後の entity
    // の最終 sample から最初の entity の最初の sample」へ繋ぐ wrap-around。
    // これは最後の entity の tessellation の最終 segment なので、最後の step
    // の entityId を採用する。
    const fallback = chain.steps.length > 0 ? chain.steps[0].entityId : "";
    const lastStepId = chain.steps.length > 0
        ? chain.steps[chain.steps.length - 1].entityId
        : fallback;
    const edgeOwners: string[] = [];
    for (let i = 0; i < N; i++) {
        if (chain.closed && i === N - 1) {
            edgeOwners.push(lastStepId);
            continue;
        }
        const next = (i + 1) % N;
        edgeOwners.push(pointOwner[next] ?? fallback);
    }
    return { points: out, edgeOwners };
}

function samePoint(a: Vec2, b: Vec2, eps = CHAIN_ENDPOINT_EPS): boolean {
    return Math.abs(a[0] - b[0]) < eps && Math.abs(a[1] - b[1]) < eps;
}
