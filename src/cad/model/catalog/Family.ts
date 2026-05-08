// Family — 振る舞いテンプレート (per spec §5)。
//
// Family は **軽量** に保つ:
//   - mesh / BRep / renderer state は持たない
//   - parameters / geometry は GeometryBuilder と Type に分離
//   - Family 自体は「どの builder でどの schema を使うか」のラベル
//
// 出荷時に標準 Family をバンドル。ユーザ追加 (将来 plugin 経由) は許容するが
// 今は read-only 扱い。

import { CategoryId } from "./Category";

export type FamilyId = string;

/** Family が指す GeometryBuilder の種類 (= builder ディレクトリ内の実装識別子)。 */
export type GeometryBuilderId =
    | "WallLayered"
    | "ColumnExtruded"
    | "BeamSwept"
    | "SlabExtruded";

export interface Family {
    id: FamilyId;
    /** どの Category 配下の Family か。 */
    categoryId: CategoryId;
    /** 人間可読名 (UI 表示用)。 */
    name: string;
    /** GeometryBuilder の種別。Type+Instance を渡すと 3D 形状を返す側の識別子。 */
    geometryBuilderId: GeometryBuilderId;
    /** behavior フラグ (例: "structural", "loadBearing")。MVP では情報用途。 */
    behaviorFlags?: string[];
}

// ── 標準 Family 定義 ──────────────────────────────────────────────
//
// MVP は Wall / Column / Beam / Slab に絞り、各カテゴリで主要構造種別を
// 1〜3 種類だけ用意する。後で plugin で拡張可能。

export const STANDARD_FAMILIES: readonly Family[] = [
    // Wall
    {
        id: "BasicWall",
        categoryId: "Wall",
        name: "Basic Wall",
        geometryBuilderId: "WallLayered",
    },
    // Column — 構造種別ごとに分離 (= profile 体系・層構成が違うため)
    {
        id: "RCColumn",
        categoryId: "Column",
        name: "RC柱",
        geometryBuilderId: "ColumnExtruded",
        behaviorFlags: ["structural"],
    },
    {
        id: "SteelColumn",
        categoryId: "Column",
        name: "鉄骨柱",
        geometryBuilderId: "ColumnExtruded",
        behaviorFlags: ["structural"],
    },
    {
        id: "TimberColumn",
        categoryId: "Column",
        name: "木造柱",
        geometryBuilderId: "ColumnExtruded",
        behaviorFlags: ["structural"],
    },
    // Beam
    {
        id: "RCBeam",
        categoryId: "Beam",
        name: "RC梁",
        geometryBuilderId: "BeamSwept",
        behaviorFlags: ["structural"],
    },
    {
        id: "SteelBeam",
        categoryId: "Beam",
        name: "鉄骨梁",
        geometryBuilderId: "BeamSwept",
        behaviorFlags: ["structural"],
    },
    {
        id: "TimberBeam",
        categoryId: "Beam",
        name: "木造梁",
        geometryBuilderId: "BeamSwept",
        behaviorFlags: ["structural"],
    },
    // Slab
    {
        id: "RCSlab",
        categoryId: "Slab",
        name: "RC床",
        geometryBuilderId: "SlabExtruded",
        behaviorFlags: ["structural"],
    },
    {
        id: "DeckSlab",
        categoryId: "Slab",
        name: "デッキ合成スラブ",
        geometryBuilderId: "SlabExtruded",
        behaviorFlags: ["structural"],
    },
    {
        id: "WoodSlab",
        categoryId: "Slab",
        name: "木造床",
        geometryBuilderId: "SlabExtruded",
    },
] as const;

const BY_ID = new Map(STANDARD_FAMILIES.map((f) => [f.id, f]));
export function getFamily(id: FamilyId): Family | undefined {
    return BY_ID.get(id);
}
export function familiesOf(categoryId: CategoryId): Family[] {
    return STANDARD_FAMILIES.filter((f) => f.categoryId === categoryId);
}
