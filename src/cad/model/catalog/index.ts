// Type/Family/Category システムの公開エントリ。
// AppState はここから `seedStandardTypes()` を呼び出し、初期 types マップを
// 構築する。

import { CategoryId } from "./Category";
import {
    ElementTypeDef, WallType, ColumnType, BeamType, SlabType,
} from "./ElementTypeDef";
import { STANDARD_WALL_TYPES, DEFAULT_WALL_TYPE_ID } from "./standard/standardWallTypes";
import { STANDARD_COLUMN_TYPES, DEFAULT_COLUMN_TYPE_ID } from "./standard/standardColumnTypes";
import { STANDARD_BEAM_TYPES, DEFAULT_BEAM_TYPE_ID } from "./standard/standardBeamTypes";
import { STANDARD_SLAB_TYPES, DEFAULT_SLAB_TYPE_ID } from "./standard/standardSlabTypes";

export * from "./Category";
export * from "./Family";
export * from "./ElementTypeDef";

/** ロード時に AppState に流し込む全標準 Type のフラット配列。 */
export const STANDARD_TYPES: readonly ElementTypeDef[] = [
    ...STANDARD_WALL_TYPES,
    ...STANDARD_COLUMN_TYPES,
    ...STANDARD_BEAM_TYPES,
    ...STANDARD_SLAB_TYPES,
];

/** AppState 構造に合わせた seed (record 形式)。 */
export function seedStandardTypes(): Record<string, ElementTypeDef> {
    const out: Record<string, ElementTypeDef> = {};
    for (const t of STANDARD_TYPES) out[t.id] = t;
    return out;
}

/** 各カテゴリのデフォルト activeTypeId (= ツール起動時に最初に選ばれる Type)。 */
export const DEFAULT_TYPE_BY_CATEGORY: Partial<Record<CategoryId, string>> = {
    Wall:   DEFAULT_WALL_TYPE_ID,
    Column: DEFAULT_COLUMN_TYPE_ID,
    Beam:   DEFAULT_BEAM_TYPE_ID,
    Slab:   DEFAULT_SLAB_TYPE_ID,
};

// ── 検索 / フィルタヘルパ ─────────────────────────────────────────
export function typesOfFamily(
    types: Record<string, ElementTypeDef>, familyId: string,
): ElementTypeDef[] {
    return Object.values(types).filter((t) => t.familyId === familyId);
}

export function typesOfCategory(
    types: Record<string, ElementTypeDef>,
    families: { id: string; categoryId: CategoryId }[],
    categoryId: CategoryId,
): ElementTypeDef[] {
    const familyIds = new Set(
        families.filter((f) => f.categoryId === categoryId).map((f) => f.id),
    );
    return Object.values(types).filter((t) => familyIds.has(t.familyId));
}

// ── 複製 (= 標準 Type をユーザ Type 化) ──────────────────────────
//
// 標準 Type は read-only 扱いなので、編集したい場合はまず複製。新 ID を
// 発行し、isStandard: false を立てる。

let cloneCounter = 0;
export function cloneType(
    src: ElementTypeDef, newName?: string,
): ElementTypeDef {
    cloneCounter++;
    const newId = `${src.kind.replace(/Type$/, "").toLowerCase()}Type.user.${Date.now().toString(36)}.${cloneCounter}`;
    const copy: ElementTypeDef = {
        ...src,
        id: newId,
        name: newName ?? `${src.name} (複製)`,
        isStandard: false,
    } as ElementTypeDef;
    return copy;
}

// ── 個別エクスポート ──────────────────────────────────────────────
export { STANDARD_WALL_TYPES, DEFAULT_WALL_TYPE_ID };
export { STANDARD_COLUMN_TYPES, DEFAULT_COLUMN_TYPE_ID };
export { STANDARD_BEAM_TYPES, DEFAULT_BEAM_TYPE_ID };
export { STANDARD_SLAB_TYPES, DEFAULT_SLAB_TYPE_ID };
export type { WallType, ColumnType, BeamType, SlabType };
