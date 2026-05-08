// ElementTypeDef — 「Type = データ定義」(per spec §6)。
//
// Revit 流の Type 概念。寸法 / profile / レイヤ / 材料 / 分類タグを保持し、
// **mesh は持たない**。実際の 3D 形状は GeometryBuilder が Type+Instance から
// 生成する。
//
// 命名注意: ファイル名は `ElementTypeDef.ts`。`model/base/ElementType.ts` には
// インスタンス discriminator (= "Wall" | "Column" | …) がある。両者を混同しない。

import { FamilyId } from "./Family";
import { Profile } from "../profiles/Profile";

// ── 共通ベース ───────────────────────────────────────────────────
export interface ElementTypeBase {
    /** 一意 ID。ユーザ複製時もユニーク発行。 */
    id: string;
    /** どの Family に属する Type か。 */
    familyId: FamilyId;
    /** 人間可読名 (UI 表示・検索の主キー)。 */
    name: string;
    /** 出荷時にバンドルした標準 Type なら true。標準は **read-only** 扱い。 */
    isStandard: boolean;
    /** 材料 ID (将来の Material システム用、MVP では string ラベル)。 */
    materialId?: string;
    /** Classification 参照 (Uniclass / OmniClass 等)。 */
    classificationRefs?: ClassificationRef[];
    /** Semantic 検索向けタグ。例: ["steel", "narrow", "fireproof"] */
    semanticTags?: string[];
}

export interface ClassificationRef {
    system: string;
    code: string;
    name: string;
}

// ── Wall Type ────────────────────────────────────────────────────
export type WallLocationLine =
    | "Center"           // 壁芯
    | "FinishExterior"   // 仕上外面
    | "FinishInterior"   // 仕上内面
    | "CoreCenter";      // 構造芯

export interface WallLayer {
    /** 仕上順 (内→外) のラベル (例: "PB", "LGS", "ALC", "RC")。 */
    material: string;
    /** 厚さ (m)。 */
    thickness: number;
    /** 構造層なら true (= 1 Type に最大 1 つ)。 */
    isStructural?: boolean;
}

export interface WallType extends ElementTypeBase {
    kind: "WallType";
    /** 全層合計厚 (m)。レイヤ和と一致させる (= バリデーション対象)。 */
    thickness: number;
    /** 内→外の層構成。空なら単層 (= materialId / thickness のみ)。 */
    layers?: WallLayer[];
    /** デフォルトの基準線位置。 */
    locationLine: WallLocationLine;
    /** 耐火等級 (h)。0 = 非耐火。 */
    fireRatingHours?: number;
}

// ── Column Type ──────────────────────────────────────────────────
export interface ColumnType extends ElementTypeBase {
    kind: "ColumnType";
    /** 断面形状。Profile を直に持つ (= ColumnGeometryBuilder の押し出し入力)。 */
    profile: Profile;
}

// ── Beam Type ────────────────────────────────────────────────────
export interface BeamType extends ElementTypeBase {
    kind: "BeamType";
    profile: Profile;
}

// ── Slab Type ────────────────────────────────────────────────────
export interface SlabLayer {
    material: string;
    thickness: number;
    isStructural?: boolean;
}

export interface SlabType extends ElementTypeBase {
    kind: "SlabType";
    /** 厚さ (m)。layers がある場合は合計と一致させる。 */
    thickness: number;
    layers?: SlabLayer[];
}

// ── 合成型 ────────────────────────────────────────────────────────
export type ElementTypeDef = WallType | ColumnType | BeamType | SlabType;

// ── Type-discriminator ヘルパ ─────────────────────────────────────
export function isWallType(t: ElementTypeDef): t is WallType {
    return t.kind === "WallType";
}
export function isColumnType(t: ElementTypeDef): t is ColumnType {
    return t.kind === "ColumnType";
}
export function isBeamType(t: ElementTypeDef): t is BeamType {
    return t.kind === "BeamType";
}
export function isSlabType(t: ElementTypeDef): t is SlabType {
    return t.kind === "SlabType";
}

// ── Override ヘルパ ──────────────────────────────────────────────
//
// Instance 側に override を持たせる場合の **適用関数**。Type のキー値の
// shallow merge。GeometryBuilder はこの結果 (= effectiveType) を渡されると
// override を意識せずに実装できる。

/** Override は Type の派生 partial。`kind` / `id` / `familyId` は変えない。 */
export type WallTypeOverride = Partial<Omit<WallType, "kind" | "id" | "familyId" | "isStandard">>;
export type ColumnTypeOverride = Partial<Omit<ColumnType, "kind" | "id" | "familyId" | "isStandard">>;
export type BeamTypeOverride = Partial<Omit<BeamType, "kind" | "id" | "familyId" | "isStandard">>;
export type SlabTypeOverride = Partial<Omit<SlabType, "kind" | "id" | "familyId" | "isStandard">>;

export function applyWallOverride(t: WallType, ov?: WallTypeOverride): WallType {
    return ov ? { ...t, ...ov } : t;
}
export function applyColumnOverride(t: ColumnType, ov?: ColumnTypeOverride): ColumnType {
    return ov ? { ...t, ...ov } : t;
}
export function applyBeamOverride(t: BeamType, ov?: BeamTypeOverride): BeamType {
    return ov ? { ...t, ...ov } : t;
}
export function applySlabOverride(t: SlabType, ov?: SlabTypeOverride): SlabType {
    return ov ? { ...t, ...ov } : t;
}
