import { BaseElement } from "../base/BaseElement";
import { Vec2 } from "../../geometry/math/Vec2";
import { ElementId } from "../base/ElementId";

/**
 * 部屋を構成する 1 個のポリゴン。矩形・マージ後の任意形状ともこの型で表す。
 *
 * - `outer`: 外周リング (CCW 推奨、最後の点に始点を重複させない)
 * - `holes`: 内側の穴 (CW 推奨)
 *
 * 矩形ツールで作図された場合も 4 頂点のポリゴンとして格納し、軸平行性は
 * ユーザに見える幾何拘束 (Horizontal / Vertical / Parallel / Perpendicular)
 * によって維持する。データ層には「矩形である」という暗黙状態は持たない。
 */
/**
 * パラメトリックな形状メタ情報。現状は円のみサポート。
 * `shape` があるポリゴンは、outer を「表示用のテッセレーション」とみなし、
 * 下流処理 (壁生成など) で再サンプルし直す。
 */
export type RoomShape = { type: "circle"; center: Vec2; radius: number };

export interface RoomPolygon {
    id: string;
    outer: Vec2[];
    holes: Vec2[][];
    /**
     * 明示的なエッジリスト（outer へのインデックスペア）。
     * 未設定 = 循環閉形状 (edge i = outer[i] → outer[(i+1) % n])。
     * 編集によって閉形状から外れた時点で materialize され、以降はこのフィールドが
     * 真。`polygonEdges(poly)` で常に同じ形式で取得する。
     */
    edges?: [number, number][];
    /** IDs of the walls generated from this polygon's outer ring */
    wallIds?: string[];
    /** Thickness (m) used when the walls were generated */
    wallThickness?: number;
    /** 真の幾何 (ある場合)。outer はこれをテッセレートしたもの。 */
    shape?: RoomShape;
    /** このポリゴンが他のポリゴンの壁アウトラインなら、元ポリゴンの ID。
     *  アウトラインは編集可能な辺／頂点を持ち、Parallel + PerpDistance 拘束で
     *  元ポリゴンに連動する。 */
    wallOutlineOf?: string;
}

/**
 * 明示的なエッジリストを返す。`edges` が未設定なら循環閉形状として
 * materialize。返り値は読み取り専用想定 (shallow)。
 */
export function polygonEdges(poly: RoomPolygon): [number, number][] {
    if (poly.edges) return poly.edges;
    const n = poly.outer.length;
    const out: [number, number][] = [];
    for (let i = 0; i < n; i++) out.push([i, (i + 1) % n]);
    return out;
}

/**
 * ポリゴンが閉じた単一環か判定。全頂点が次数 2 かつ連結ならば単一ハミルトン
 * 閉路 (= 閉じた環)。`edges` が未設定 = 循環として常に true。
 */
export function isPolygonClosed(poly: RoomPolygon): boolean {
    if (!poly.edges) return true;
    const n = poly.outer.length;
    if (n < 3) return false;
    if (poly.edges.length !== n) return false;
    const degree = new Array<number>(n).fill(0);
    const adj: number[][] = Array.from({ length: n }, () => []);
    for (const [a, b] of poly.edges) {
        if (a < 0 || a >= n || b < 0 || b >= n || a === b) return false;
        degree[a]++; degree[b]++;
        adj[a].push(b); adj[b].push(a);
    }
    for (let i = 0; i < n; i++) if (degree[i] !== 2) return false;
    const seen = new Array<boolean>(n).fill(false);
    const stack = [0];
    seen[0] = true;
    let count = 1;
    while (stack.length) {
        const v = stack.pop()!;
        for (const u of adj[v]) if (!seen[u]) { seen[u] = true; count++; stack.push(u); }
    }
    return count === n;
}

export interface SpaceElement extends BaseElement {
    type: "Space";
    boundary: Vec2[];
    polygons: RoomPolygon[];
    area: number;
    height: number;
    levelId?: ElementId;
    /** 用途タグ (e.g. 個室 / LDK / 収納 / 玄関). free-text optional. */
    usage?: string;
}
