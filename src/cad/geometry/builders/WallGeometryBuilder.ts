import { WallElement } from "../../model/elements/WallElement";
import { Vec3 } from "../math/Vec3";
import { Vec2 } from "../math/Vec2";
import { WallJoinResult } from "../../topology/joins/WallJoinResolver";
import { RoomPolygon } from "../../model/elements/SpaceElement";
import { computeWallHexagon, signedArea, ensureCCW } from "../wall/EdgeGeometry";
import polygonClipping, { type Pair, type Ring } from "polygon-clipping";
import type { ColumnFootprint } from "../../topology/junctions/JunctionGraph";

/**
 * 壁の 3D フットプリント。長さは可変:
 *   - 4 (legacy): start-left / start-right / end-right / end-left の矩形。
 *   - 6 (hex):    `computeWallHexagon` の頂点を 3D 化したもの:
 *                 [innerPrev, s, outerPrev, outerNext, e, innerNext]
 *
 * `WallMeshBuilder` は長さで分岐して立面を生成する。
 */
export interface WallGeometryData {
    footprint: Vec3[];
    height: number;
    /** true のとき footprint は hex (6 verts)。false なら legacy rect (4)。 */
    isHexFootprint: boolean;
    /** Wall 軸の開始点 (baseY 補正済み)。legacy rect path で opening の
     *  内部境界を axis 基準で揃えるために WallMeshBuilder が参照する。
     *  未指定なら footprint c0..c3 のみで lerp。 */
    axisStart?: Vec3;
    /** Wall 軸の終点 (baseY 補正済み)。 */
    axisEnd?: Vec3;
    /**
     * footprint の中に存在する穴 (= inner ring) の配列。各 hole は CW で
     * 表現する。Circle 由来の壁が室内側をくり抜いた annulus フットプリントを
     * 3D 化するときに使う。未設定なら穴なし。
     */
    holes?: Vec3[][];
    /**
     * 隣接壁と完全一致する「内部接合面」の per-edge マスク。
     * 長さ = footprint.length。true の edge は WallMeshBuilder が
     * 側面 quad と silhouette edge を生成しない (= 内部の見えない面・
     * 線を消す)。`wall.footprint` が反転されて使われる場合は、ここでも
     * 同じ反転を適用してインデックスを揃える。
     */
    internalEdges?: boolean[];
}

export class WallGeometryBuilder {
    /**
     * Build wall footprint.
     * @param wall            The wall element
     * @param joins           Optional join results to override corners at Start/End (legacy rect path)
     * @param parentPolygon   When `wall.polyRef` is set, the caller looks up the
     *                        polygon and passes it here. Triggers the hex
     *                        footprint path so 3D shape matches the 2D hex.
     * @param polygonLookup   3+ 接続の交差点で他ポリゴンを参照するための
     *                        `polyId → RoomPolygon` ルックアップ。未指定だと
     *                        `vertexConnections` 経由のクロスポリゴンは無視され、
     *                        同一ポリゴン内 prev/next miter のみで形が決まる。
     */
    public static build(
        wall: WallElement,
        joins?: WallJoinResult[],
        parentPolygon?: RoomPolygon,
        polygonLookup?: (polyId: string) => RoomPolygon | undefined,
        /** Opening 切り欠きを適用する個数のヒント。caller (= Viewport) が
         *  hover preview を含む実際の opening 数を渡す。指定無しなら
         *  `wall.openings.length` をフォールバックとして使う。 */
        renderOpeningCount?: number,
        /** 同一レベルに置かれた柱の 2D フットプリント。指定されると壁の
         *  最終フットプリントを Clipper diff で差し引き、柱面で切り落とす。
         *  Opening を持つ壁は legacy rect path を保つため適用しない。 */
        columnFootprints?: ColumnFootprint[],
    ): WallGeometryData {
        const data = WallGeometryBuilder.buildBase(
            wall, joins, parentPolygon, polygonLookup, renderOpeningCount,
        );
        const openingCount = renderOpeningCount ?? (wall.openings ?? []).length;
        if (openingCount > 0) return data;
        if (!columnFootprints || columnFootprints.length === 0) return data;
        // wallRegenerate 側で既に柱を引き算した最終 fp を持つ壁は、二重クリップ
        // を避けるため clipByColumns をスキップする。
        if (wall.footprintIsFinal) return data;
        return clipByColumns(data, columnFootprints);
    }

    private static buildBase(
        wall: WallElement,
        joins?: WallJoinResult[],
        parentPolygon?: RoomPolygon,
        polygonLookup?: (polyId: string) => RoomPolygon | undefined,
        renderOpeningCount?: number,
    ): WallGeometryData {
        // ── Precomputed footprint path (junction-graph パイプライン) ──
        // wall.footprint が設定されていれば交差点解析で確定した 2D ポリゴン
        // をそのまま 3D 化する。
        //   - 4 頂点 AND openings がある場合: legacy rect path に渡して
        //     opening の切り欠きを行う (buildHexPrism は openings 未対応)。
        //     JunctionGraph の CCW [innerStart, outerStart, outerEnd,
        //     innerEnd] を legacy CW [c0, c1, c2, c3] = [start-(-n),
        //     start-(+n), end-(+n), end-(-n)] に並び替えて渡す。
        //     n = +90° CCW of dir = JunctionGraph の nIn と同方向。
        //     よって c0 = outerStart, c1 = innerStart, c2 = innerEnd,
        //     c3 = outerEnd。
        //   - それ以外 (5+ 頂点 or openings 無し): hex prism path で
        //     可変 N 頂点を Y 押し出し。
        //
        // 注: hover preview の "rendered opening" も切り欠き対象なので、
        //     `renderOpeningCount` を優先して見る (永続 wall.openings に
        //     入る前の preview 段階でも legacy path に流れて欲しい)。
        if (wall.footprint && wall.footprint.length >= 3) {
            const baseY = wall.axis[0][1] + wall.baseOffset;
            let fp = wall.footprint;
            let internalMask: boolean[] | undefined = wall.internalEdges
                && wall.internalEdges.length === fp.length
                ? wall.internalEdges.slice()
                : undefined;
            const openingCount = renderOpeningCount ?? (wall.openings ?? []).length;
            const hasOpenings = openingCount > 0;
            // JunctionGraph の virtual edge は、ある polygon の edge を辿る向きで
            // start/end を持つ。一方 wall.axis は CreateWallCommand 当時の方向で
            // 固定。両者が逆向きになっているケースがあり、fp が
            // [innerEnd, outerEnd, outerStart, innerStart] と axis 基準で逆順に
            // 来てしまう。これを fp[0] が wall.axis のどちらに近いかで検出して
            // 必要なら反転させ、以降のコードは常に
            // [innerStart, outerStart, outerEnd, innerEnd] を仮定できるようにする。
            if (fp.length >= 3) {
                const aS = wall.axis[0], aE = wall.axis[1];
                const d0Start = (fp[0][0] - aS[0]) ** 2 + (fp[0][1] - aS[2]) ** 2;
                const d0End   = (fp[0][0] - aE[0]) ** 2 + (fp[0][1] - aE[2]) ** 2;
                if (d0End < d0Start) {
                    fp = [...fp].reverse();
                    if (internalMask) {
                        // 反転後の edge i (= 元 fp の頂点 n-1-i → n-2-i) は
                        // 元の edge n-2-i に対応する。長さ n の cycle で
                        // newMask[i] = oldMask[(n-2-i+n) % n]。
                        const n = internalMask.length;
                        const reversed = new Array<boolean>(n);
                        for (let i = 0; i < n; i++) {
                            reversed[i] = internalMask[(n - 2 - i + n) % n];
                        }
                        internalMask = reversed;
                    }
                }
            }
            if (hasOpenings && fp.length === 4) {
                // legacy rect path: openings 切り欠きを buildBlocks 経由で行う。
                // mitered fp の場合 c0-c3 と c1-c2 で長さが異なり、lerp ベース
                // の opening 位置が axis ベースの door preview とズレる問題が
                // あるが、これは WallMeshBuilder 側で interior block boundary
                // のみ axis 投影することで解決 (axisStart/axisEnd を渡す)。
                // ここでは mitered fp を保持して wall 端の miter を温存する。
                return {
                    footprint: [
                        [fp[1][0], baseY, fp[1][1]], // c0 = outerStart
                        [fp[0][0], baseY, fp[0][1]], // c1 = innerStart
                        [fp[3][0], baseY, fp[3][1]], // c2 = innerEnd
                        [fp[2][0], baseY, fp[2][1]], // c3 = outerEnd
                    ],
                    height: wall.height + wall.topOffset,
                    isHexFootprint: false,
                    axisStart: [wall.axis[0][0], baseY, wall.axis[0][2]],
                    axisEnd: [wall.axis[1][0], baseY, wall.axis[1][2]],
                };
            }
            const footprint: Vec3[] = fp.map<Vec3>((p) =>
                [p[0], baseY, p[1]] as Vec3,
            );
            // wall.footprintHoles (= 円形 annulus などの内側ホール) があれば
            // baseY 補正して 3D に持ち上げる。
            let holes: Vec3[][] | undefined;
            if (wall.footprintHoles && wall.footprintHoles.length > 0) {
                holes = wall.footprintHoles.map((h) =>
                    h.map<Vec3>((p) => [p[0], baseY, p[1]] as Vec3),
                );
            }
            return {
                footprint,
                height: wall.height + wall.topOffset,
                isHexFootprint: true,
                holes,
                internalEdges: internalMask,
            };
        }

        // ── Hex path ────────────────────────────────────────────────
        if (wall.polyRef && parentPolygon) {
            const hex = computeWallHexagon(parentPolygon, wall.polyRef.edgeIdx, polygonLookup);
            if (hex) {
                const baseY = wall.axis[0][1] + wall.baseOffset;
                const footprint: Vec3[] = hex.vertices.map<Vec3>((p: Vec2) =>
                    [p[0], baseY, p[1]] as Vec3,
                );
                return {
                    footprint,
                    height: wall.height + wall.topOffset,
                    isHexFootprint: true,
                };
            }
            // computeWallHexagon が null を返したらフォールバック
        }

        // ── Legacy rect path ────────────────────────────────────────
        const [p1, p2] = wall.axis;
        const dx = p2[0] - p1[0];
        const dz = p2[2] - p1[2];
        const len = Math.sqrt(dx * dx + dz * dz) || 1;

        const dirX = dx / len;
        const dirZ = dz / len;
        const nx = -dirZ;
        const nz = dirX;

        let offset = 0;
        switch (wall.locationLine) {
            case "Center":
            case "CoreCenter":
                offset = 0;
                break;
            case "FinishExterior":
                offset = wall.thickness / 2;
                break;
            case "FinishInterior":
                offset = -wall.thickness / 2;
                break;
        }

        const halfT = wall.thickness / 2;

        const p1_offset: Vec3 = [
            p1[0] + nx * offset, p1[1] + wall.baseOffset, p1[2] + nz * offset,
        ];
        const p2_offset: Vec3 = [
            p2[0] + nx * offset, p2[1] + wall.baseOffset, p2[2] + nz * offset,
        ];

        let c0: Vec3 = [p1_offset[0] - nx * halfT, p1_offset[1], p1_offset[2] - nz * halfT];
        let c1: Vec3 = [p1_offset[0] + nx * halfT, p1_offset[1], p1_offset[2] + nz * halfT];
        let c2: Vec3 = [p2_offset[0] + nx * halfT, p2_offset[1], p2_offset[2] + nz * halfT];
        let c3: Vec3 = [p2_offset[0] - nx * halfT, p2_offset[1], p2_offset[2] - nz * halfT];

        if (joins) {
            for (const join of joins) {
                if (join.corners) {
                    const [left, right] = join.corners;
                    if (join.at === "Start") {
                        c0 = [right[0], c0[1], right[2]];
                        c1 = [left[0], c1[1], left[2]];
                    } else {
                        c2 = [left[0], c2[1], left[2]];
                        c3 = [right[0], c3[1], right[2]];
                    }
                }
            }
        }

        return {
            footprint: [c0, c1, c2, c3],
            height: wall.height + wall.topOffset,
            isHexFootprint: false,
        };
    }
}

/**
 * 壁の最終フットプリントを柱形状で Clipper diff し、最大領域だけを残して
 * hex フットプリントとして返す。柱の形状が壁を完全に覆う / 分断する場合は:
 *  - 完全包含 → 空フットプリント (= 描画消滅)
 *  - 分断 → 面積最大ピースのみ採用 (壁分割は将来の課題)
 */
function clipByColumns(
    data: WallGeometryData,
    columns: ColumnFootprint[],
): WallGeometryData {
    if (data.footprint.length < 3) return data;
    const baseY = data.footprint[0][1];

    // wall fp は legacy rect (4) なら順序 [c0, c1, c2, c3] = [outerStart,
    // innerStart, innerEnd, outerEnd] (=> CW in std math, CCW in screen).
    // hex / precomputed では既に CCW。polygon-clipping は signed area で
    // 自動判定するので向きを揃えるだけにする。
    const fp2D: Vec2[] = data.footprint.map<Vec2>((p) => [p[0], p[2]]);
    const fpCCW = ensureCCW(fp2D);
    const subj: Ring[] = [fpCCW.map<Pair>((v) => [v[0], v[1]])];

    // 壁 AABB と重ならない柱は除外 (clipping コスト削減)。
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
    for (const v of fpCCW) {
        if (v[0] < minX) minX = v[0]; if (v[0] > maxX) maxX = v[0];
        if (v[1] < minZ) minZ = v[1]; if (v[1] > maxZ) maxZ = v[1];
    }
    const clips: Ring[][] = [];
    for (const col of columns) {
        if (col.points.length < 3) continue;
        let cMinX = Infinity, cMinZ = Infinity, cMaxX = -Infinity, cMaxZ = -Infinity;
        for (const v of col.points) {
            if (v[0] < cMinX) cMinX = v[0]; if (v[0] > cMaxX) cMaxX = v[0];
            if (v[1] < cMinZ) cMinZ = v[1]; if (v[1] > cMaxZ) cMaxZ = v[1];
        }
        if (cMaxX < minX || cMinX > maxX || cMaxZ < minZ || cMinZ > maxZ) continue;
        clips.push([col.points.map<Pair>((v) => [v[0], v[1]])]);
    }
    if (clips.length === 0) return data;

    let result;
    try {
        result = polygonClipping.difference(subj, ...clips);
    } catch {
        return data;
    }
    if (result.length === 0) {
        return { ...data, footprint: [], isHexFootprint: false };
    }
    // 壁が複数ピースに分断されるケース (= 柱が壁の中間で壁を貫く) は
    // wallRegenerate 側で polygon edge を分割しており、ここに来る個別の wall は
    // 柱に対して 1 ピースに clip される想定。それでも稀に複数ピースになった
    // 場合は念のため最大ピースを採用する。
    let bestRing: Pair[] | null = null;
    let bestArea = 0;
    for (const piece of result) {
        if (!piece || piece.length === 0) continue;
        const ring = piece[0];
        if (!ring || ring.length < 4) continue;
        const open = ring.slice(0, -1);
        const area = Math.abs(signedArea(open as Vec2[]));
        if (area > bestArea) { bestArea = area; bestRing = open; }
    }
    if (!bestRing) return data;

    const ccw = signedArea(bestRing as Vec2[]) > 0
        ? bestRing
        : [...bestRing].reverse();
    const newFp: Vec3[] = ccw.map<Vec3>((p) => [p[0], baseY, p[1]]);
    return {
        footprint: newFp,
        height: data.height,
        isHexFootprint: true,
        axisStart: data.axisStart,
        axisEnd: data.axisEnd,
    };
}
