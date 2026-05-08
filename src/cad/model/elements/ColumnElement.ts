import { BaseElement } from "../base/BaseElement";
import { Profile } from "../profiles/Profile";
import { Modifier } from "../modifiers/Modifier";
import { ElementId } from "../base/ElementId";
import { Vec3 } from "../../geometry/math/Vec3";
import type { ColumnTypeOverride } from "../catalog/ElementTypeDef";

export type ColumnKind = "Structural" | "Architectural";

// Point-based structural element (spec §2/§3). Anchored by basePoint in XZ
// and vertically by base/top level references plus offsets. Extruded from
// the profile over the full height.
//
// Type/Family/Category 体系に準拠: 断面情報は **ColumnType** に保持され、
// インスタンスは `typeId` でその Type を参照する。`profile` フィールドは
// Type+overrides から導出された **キャッシュ** であり、Type 変更時に
// Command 側で再投影される (= mesh builder の入力としてそのまま使える)。
export interface ColumnElement extends BaseElement {
    type: "Column";
    /** 参照する ColumnType の id。新規作成では必須。標準 Type なら read-only。 */
    typeId: ElementId;
    /** Type に対するインスタンス側 override (= ユーザがこの柱だけ寸法変更したい場合)。 */
    overrides?: ColumnTypeOverride;
    /** Type+overrides から導出された有効断面のキャッシュ。Type を切り替えた
     *  ら必ず再投影される。mesh builder はこのフィールドを直接読む。 */
    profile: Profile;

    basePoint: Vec3;
    baseLevelId?: ElementId;
    topLevelId?: ElementId;
    baseOffset: number;
    topOffset: number;
    /** Rotation around the vertical axis, in radians. */
    rotation: number;
    kind: ColumnKind;
    stackId?: ElementId;
    modifiers?: Modifier[];
}
