import { ElementId } from "../base/ElementId";
import type { SketchEntityId } from "../sketch/SketchEntity";

// 2D 幾何拘束（軽量: docs/specification/2d_constraint_system_spec.md）
// 拘束は Space 内のポリゴン (RoomPolygon) の頂点 / 辺に付与する。矩形ツールで
// 作図されたものも 4 頂点ポリゴンとして格納されており、矩形性は自動追加された
// 拘束 (Horizontal / Vertical / Parallel / Perpendicular) によって維持される。
export type ConstraintType =
    | "Horizontal"
    | "Vertical"
    | "Parallel"
    | "Perpendicular"
    | "Coincident"
    | "PointOnGrid"
    | "PointOnColumn"
    | "Length"
    | "Angle"
    | "Collinear"
    | "EqualLength"
    | "PerpDistance"
    // 円関連 (RoomPolygon.shape.type === "circle" を対象とする)
    | "CircleRadius"
    | "CircleDiameter"
    | "Tangent"
    | "PointOnCircle"
    | "ConcentricCircle"
    | "EqualRadius"
    // 弧 (ArcEntity) / 円 (CircleEntity) 自体の半径・直径拘束 (entity 直接参照)
    | "ArcRadius"
    | "ArcDiameter"
    // 2 点間の水平 (X 軸) / 垂直 (Z 軸) 距離
    | "HorizDistance"
    | "VertDistance";

// 拘束対象 = ポリゴン外周の頂点 or 辺、もしくは参照系（通芯・柱・円）。
// 穴 (holes) の頂点・辺は対象外。
// WallAxis は壁モードで単独作成した壁の中心軸を 2 頂点 + 1 辺として扱う。
// solver は wall.axis[0]/[1] を 2D の (x,z) 点として push し、結果を書き戻す。
// WallAxisPoint は壁軸の 2 端点を個別の頂点として指定するもの (Coincident 等で
// ポリライン接続を維持する)。endIdx: 0=axis[0], 1=axis[1]。
export type ConstraintTarget =
    | { kind: "SketchPoint"; spaceId: ElementId; polyId: string; vertexIdx: number }
    | { kind: "SketchEdge"; spaceId: ElementId; polyId: string; edgeIdx: number }
    | { kind: "SketchCircle"; spaceId: ElementId; polyId: string }
    /** Arc / Circle entity 直接参照。Polygon ではなく SketchEntity に拘束を
     *  付ける場合に使う (= 弧の半径拘束など)。 */
    | { kind: "SketchEntity"; spaceId: ElementId; entityId: SketchEntityId }
    | { kind: "WallAxis"; wallId: ElementId }
    | { kind: "WallAxisPoint"; wallId: ElementId; endIdx: 0 | 1 }
    | { kind: "Grid"; gridId: string }
    | { kind: "Column"; columnId: ElementId }
    /** 通芯の端点を 1 つの "ポイント候補" として参照。Length 拘束で柱-通芯
     *  端点 距離などに使う。 */
    | { kind: "GridPoint"; gridId: string; vertexIdx: number }
    /** 原点 (0,0)。固定 fixed point として GCS に push される。 */
    | { kind: "Origin" }
    /** 柱フットプリントの頂点 (固定参照点)。部屋頂点・壁端点との
     *  Coincident / Length 拘束などで使う。 */
    | { kind: "ColumnVertex"; columnId: ElementId; vertexIdx: number }
    /** 柱フットプリントの辺 (固定参照線)。Parallel / Perpendicular /
     *  PerpDistance 拘束などで使う。 */
    | { kind: "ColumnEdge"; columnId: ElementId; edgeIdx: number };

export interface Constraint {
    id: string;
    type: ConstraintType;
    targets: ConstraintTarget[];
    /** Length 拘束用、単位: m */
    value?: number;
}

export function isSketchTarget(
    t: ConstraintTarget,
): t is Extract<ConstraintTarget, { kind: "SketchPoint" | "SketchEdge" | "SketchCircle" }> {
    return t.kind === "SketchPoint" || t.kind === "SketchEdge" || t.kind === "SketchCircle";
}

// 拘束が参照する space / polygon をユニークに列挙
export function constraintPolygons(c: Constraint): { spaceId: ElementId; polyId: string }[] {
    const out: { spaceId: ElementId; polyId: string }[] = [];
    const seen = new Set<string>();
    for (const t of c.targets) {
        if (t.kind === "SketchPoint" || t.kind === "SketchEdge" || t.kind === "SketchCircle") {
            const key = `${t.spaceId}:${t.polyId}`;
            if (!seen.has(key)) { seen.add(key); out.push({ spaceId: t.spaceId, polyId: t.polyId }); }
        }
    }
    return out;
}
