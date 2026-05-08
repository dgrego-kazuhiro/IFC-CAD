import { BaseElement } from "../base/BaseElement";
import { Vec2 } from "../../geometry/math/Vec2";
import { ElementId } from "../base/ElementId";
import type { SlabTypeOverride } from "../catalog/ElementTypeDef";

// Type 化: 厚さ・層構成は SlabType に保持。`typeId` で参照、`thickness` は
// 有効値キャッシュ (Type 変更時に Command 側で再投影)。
export interface SlabElement extends BaseElement {
    type: "Slab";
    /** 参照する SlabType の id。 */
    typeId: ElementId;
    overrides?: SlabTypeOverride;
    /** Type+overrides から導出された有効厚のキャッシュ。 */
    thickness: number;

    boundary: Vec2[];
    holes?: Vec2[][];
    elevation: number;
    levelId?: ElementId;
}
