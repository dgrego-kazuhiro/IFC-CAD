import { BaseElement } from "../base/BaseElement";
import { Vec3 } from "../../geometry/math/Vec3";
import { ElementId } from "../base/ElementId";

export interface WallElement extends BaseElement {
    type: "Wall";
    axis: [Vec3, Vec3];
    thickness: number;
    height: number;
    baseLevelId?: ElementId;
    topLevelId?: ElementId;
    baseOffset: number;
    topOffset: number;
    locationLine: "Center" | "FinishExterior" | "FinishInterior" | "CoreCenter";
    joinStart: boolean;
    joinEnd: boolean;
    openings: ElementId[];
    wallTypeId?: ElementId;
    /**
     * 壁分類 (per docs/specification/new.md §4):
     *  - "exterior" (外壁): edge belongs to only one room
     *  - "shared"   (共通壁): edge is shared between ≥ 2 room boundaries
     * Set by the bulk wall-generator (Boundary→Wall pass). Optional so legacy
     * walls created via the per-room `Create Walls` button stay untyped.
     */
    wallCategory?: "exterior" | "shared";
    /**
     * 親 RoomPolygon 上のエッジへの参照。全壁生成 (boundary→wall pass) が
     * 設定する。これがあると WallGeometryBuilder は `RoomPolygon.outer` +
     * `computeWallHexagon` から **6 頂点フットプリント** を作って 3D 押し
     * 出すので、コーナーは 2D で計算したヘキサゴンと同形になる。
     * 共通壁の場合 1 wall に複数 polygon が紐付くが、ここには「正準 (lex
     * smallest polyId) のもの」を 1 つだけ入れる — フットプリント自体は
     * どちら側から計算しても同じ axis を共有しているので等価。
     */
    polyRef?: {
        spaceId: ElementId;
        polyId: string;
        edgeIdx: number;
    };
    /** 内側厚さ (m)。RoomPolygon 由来。未設定なら `thickness/2` 互換。 */
    innerThickness?: number;
    /** 外側厚さ (m)。RoomPolygon 由来。未設定なら `thickness/2` 互換。 */
    outerThickness?: number;
}
