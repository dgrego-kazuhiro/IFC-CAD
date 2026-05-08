// Type 解決ヘルパ — AppState.types から指定 ID の Type を引き、override を
// 適用した「effective type」を返す。Create コマンド / mesh builder / Type
// 変更コマンドが共通で使う。

import {
    ElementTypeDef,
    WallType, ColumnType, BeamType, SlabType,
    isWallType, isColumnType, isBeamType, isSlabType,
    applyWallOverride, applyColumnOverride,
    applyBeamOverride, applySlabOverride,
    WallTypeOverride, ColumnTypeOverride,
    BeamTypeOverride, SlabTypeOverride,
} from "./ElementTypeDef";

export function effectiveWallType(
    types: Record<string, ElementTypeDef>,
    typeId: string,
    overrides?: WallTypeOverride,
): WallType | null {
    const t = types[typeId];
    if (!t || !isWallType(t)) return null;
    return applyWallOverride(t, overrides);
}

export function effectiveColumnType(
    types: Record<string, ElementTypeDef>,
    typeId: string,
    overrides?: ColumnTypeOverride,
): ColumnType | null {
    const t = types[typeId];
    if (!t || !isColumnType(t)) return null;
    return applyColumnOverride(t, overrides);
}

export function effectiveBeamType(
    types: Record<string, ElementTypeDef>,
    typeId: string,
    overrides?: BeamTypeOverride,
): BeamType | null {
    const t = types[typeId];
    if (!t || !isBeamType(t)) return null;
    return applyBeamOverride(t, overrides);
}

export function effectiveSlabType(
    types: Record<string, ElementTypeDef>,
    typeId: string,
    overrides?: SlabTypeOverride,
): SlabType | null {
    const t = types[typeId];
    if (!t || !isSlabType(t)) return null;
    return applySlabOverride(t, overrides);
}
