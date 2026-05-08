// Category — システム固定の Behavior Class (per ifc_webcad_core_architecture_spec §4)。
// ユーザ追加禁止、CAD の根幹要素分類。Tool/UI 切替と IFC Entity 決定に用いる。
//
// `model/base/ElementType.ts` の文字列 union (= インスタンス discriminator) と
// 1:1 対応する。Category 側は人間可読な name と toolId / ifcEntity を保持する。

import { ElementType as ElementDiscriminator } from "../base/ElementType";

export type CategoryId = ElementDiscriminator | "Roof" | "Stair" | "Grid";

export interface Category {
    id: CategoryId;
    /** 人間可読名 (UI 表示用)。 */
    name: string;
    /** AppState.activeTool の値とリンクする。 */
    toolId: string;
    /** IFC エクスポート時のエンティティ名。 */
    ifcEntity: string;
}

// ── システム固定リスト ───────────────────────────────────────────
//
// 並び順は UI のツールバー / カテゴリパネル表示順を兼ねる。新規追加は
// **コード変更が必要** (= ユーザ runtime 追加不可) であることに注意。
export const CATEGORIES: readonly Category[] = [
    { id: "Wall",    name: "壁",       toolId: "wall",     ifcEntity: "IfcWall" },
    { id: "Column",  name: "柱",       toolId: "column",   ifcEntity: "IfcColumn" },
    { id: "Beam",    name: "梁",       toolId: "beam",     ifcEntity: "IfcBeam" },
    { id: "Slab",    name: "床",       toolId: "slab",     ifcEntity: "IfcSlab" },
    { id: "Door",    name: "ドア",     toolId: "door",     ifcEntity: "IfcDoor" },
    { id: "Window",  name: "窓",       toolId: "window",   ifcEntity: "IfcWindow" },
    { id: "Roof",    name: "屋根",     toolId: "roof",     ifcEntity: "IfcRoof" },
    { id: "Stair",   name: "階段",     toolId: "stair",    ifcEntity: "IfcStair" },
    { id: "Space",   name: "空間",     toolId: "space",    ifcEntity: "IfcSpace" },
    { id: "Grid",    name: "通芯",     toolId: "gridline", ifcEntity: "IfcGrid" },
    { id: "Level",   name: "レベル",   toolId: "level",    ifcEntity: "IfcBuildingStorey" },
] as const;

const BY_ID = new Map(CATEGORIES.map((c) => [c.id, c]));
export function getCategory(id: CategoryId): Category | undefined {
    return BY_ID.get(id);
}
