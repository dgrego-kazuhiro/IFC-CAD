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

/**
 * 壁の基準線 (壁芯) の取り方。`outer` のポリラインがどの位置に対応するかを表す。
 *   - "Center"     壁中心線。outer はちょうど壁の真ん中に乗り、
 *                  innerThickness と outerThickness の合計が壁厚。
 *   - "Interior"   内法線。outer は室内側の仕上げ面に乗り、
 *                  innerThickness = 0、outerThickness が壁厚。
 *   - "Exterior"   外法線。outer は屋外側の仕上げ面に乗り、
 *                  innerThickness = 壁厚、outerThickness = 0。
 *   - "Structural" 構造芯。outer は柱芯／構造体中心に乗り、
 *                  inner/outer は仕上げ込みの内訳で決める。
 */
export type WallReferenceLine = "Center" | "Interior" | "Exterior" | "Structural";

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
    /** IDs of the walls generated from this polygon's outer ring (legacy 1:1).
     *  新パイプライン（junction-graph 経由）が生成した場合は `wallsPerEdge` を
     *  使用するため空または未設定。読み出し側は両方を許容する。 */
    wallIds?: string[];
    /** outer 各エッジから派生した壁 ID 配列。長さは `outer.length`。
     *  共線重なりで分割された場合 `wallsPerEdge[i]` は 2+ 要素となる。
     *  順序は仮想エッジが outer[i] → outer[(i+1)%N] の方向に並ぶ順。
     *  新パイプラインで設定される。未設定なら従来の `wallIds` 経路。 */
    wallsPerEdge?: string[][];

    // ── 壁厚モデル ─────────────────────────────────────────────
    /** 旧 API: 単一壁厚 (m)。新しい inner/outer 分離フィールドが両方
     *  設定されていればそちらが優先される。下位互換のため残置。 */
    wallThickness?: number;
    /** 内側厚さ (m)。CCW polygon の +90° 法線方向 (= 室内側) への
     *  オフセット距離。outer ポリラインから内法面までの距離。 */
    innerThickness?: number;
    /** 外側厚さ (m)。CCW polygon の -90° 法線方向 (= 屋外側) への
     *  オフセット距離。outer ポリラインから外法面までの距離。 */
    outerThickness?: number;
    /** 壁基準線の種別。inner/outer の既定値の決め方 (および IFC 出力の
     *  locationLine) を決める。未設定なら "Center"。 */
    wallReference?: WallReferenceLine;

    // ── エッジ ID と共通エッジ参照 ───────────────────────────────
    /** outer の各エッジに付けた永続 ID。長さ = outer.length。
     *  全壁生成時に振られ、共通エッジ判定や履歴差分で参照される。
     *  edge i = outer[i] → outer[(i+1) % n]。 */
    edgeIds?: string[];
    /** 各エッジが他ポリゴンと重なっている (= 共通エッジ) なら、
     *  その SharedEdge.id。なければ undefined。長さ = outer.length。 */
    sharedEdgeIds?: (string | undefined)[];
    /**
     * 各 outer 頂点に対する **他ポリゴンの incident edge 一覧** (= 交差点
     * で接続されているエッジ)。長さ = outer.length。
     *
     * 全壁生成時に、頂点位置でクラスタ化して 2 つ以上のポリゴンが集まる
     * 頂点を「交差点」とみなし、その交差点に集まる他ポリゴンの 2 隣接
     * エッジを記録する。同一ポリゴンの prev/next は含めない (computeWall
     * Hexagon が outer 索引で自前取得できるため)。
     *
     * `null` または undefined = 交差点なし (= 完全に同一ポリゴン内のコーナー)。
     * `computeWallHexagon` はこの値を見て、コーナー計算を「接続する全
     * エッジの L_in / L_out との交点のうちエッジ中点に最近接のものを
     * 採用」する 3+ 接続対応モードに切り替える。
     */
    vertexConnections?: (Array<{ polyId: string; edgeIdx: number }> | null)[];

    /** 真の幾何 (ある場合)。outer はこれをテッセレートしたもの。 */
    shape?: RoomShape;
    /** このポリゴンが他のポリゴンの壁アウトラインなら、元ポリゴンの ID。
     *  アウトラインは編集可能な辺／頂点を持ち、Parallel + PerpDistance 拘束で
     *  元ポリゴンに連動する。 */
    wallOutlineOf?: string;
}

/**
 * 共通エッジ (= 2 つの RoomPolygon が部分的にでも重なっている境界)。
 * 全壁生成のたびに再計算される。各 RoomPolygon は `sharedEdgeIds[i]` で
 * 参照する。
 */
export interface SharedEdge {
    id: string;
    /** 重なっている全参加ポリゴンのリスト (通常 2、3 以上もあり得る)。 */
    participants: { polyId: string; edgeIdx: number }[];
    /** 共通区間の世界座標 (CCW 側ポリゴンから見た start/end)。 */
    start: Vec2;
    end: Vec2;
}

/**
 * Inner/Outer 厚さを決定する。inner/outerThickness が両方設定されていれば
 * そのまま、片方だけ設定なら未設定側を 0、どちらも未設定なら wallReference と
 * wallThickness から既定値を導出する。
 */
export function resolveWallThicknesses(
    poly: Pick<RoomPolygon, "innerThickness" | "outerThickness" | "wallThickness" | "wallReference">,
): { inner: number; outer: number } {
    if (poly.innerThickness !== undefined && poly.outerThickness !== undefined) {
        return { inner: poly.innerThickness, outer: poly.outerThickness };
    }
    const T = poly.wallThickness ?? 0;
    const ref = poly.wallReference ?? "Center";
    let inner: number, outer: number;
    switch (ref) {
        case "Interior":   inner = 0;     outer = T;     break;
        case "Exterior":   inner = T;     outer = 0;     break;
        case "Structural":
        case "Center":
        default:           inner = T / 2; outer = T / 2; break;
    }
    if (poly.innerThickness !== undefined) inner = poly.innerThickness;
    if (poly.outerThickness !== undefined) outer = poly.outerThickness;
    return { inner, outer };
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
