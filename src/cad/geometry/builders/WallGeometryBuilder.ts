import { WallElement } from "../../model/elements/WallElement";
import { Vec3 } from "../math/Vec3";
import { Vec2 } from "../math/Vec2";
import { WallJoinResult } from "../../topology/joins/WallJoinResolver";
import { RoomPolygon } from "../../model/elements/SpaceElement";
import { computeWallHexagon } from "../wall/EdgeGeometry";

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
    ): WallGeometryData {
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
