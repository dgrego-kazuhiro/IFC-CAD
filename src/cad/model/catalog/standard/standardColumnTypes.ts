// 標準 Column Type カタログ (read-only)。
// 国内の構造設計でよく使われる断面寸法をベースに最小セットを用意。

import { ColumnType } from "../ElementTypeDef";

export const STANDARD_COLUMN_TYPES: readonly ColumnType[] = [
    // ── RCColumn (矩形) ─────────────────────────────────────────
    {
        id: "columnType.std.rc.rect.400",
        familyId: "RCColumn",
        kind: "ColumnType",
        name: "RC柱 400×400",
        isStandard: true,
        profile: { kind: "Rectangle", width: 0.4, depth: 0.4 },
        semanticTags: ["rc", "concrete", "rectangular"],
    },
    {
        id: "columnType.std.rc.rect.500",
        familyId: "RCColumn",
        kind: "ColumnType",
        name: "RC柱 500×500",
        isStandard: true,
        profile: { kind: "Rectangle", width: 0.5, depth: 0.5 },
        semanticTags: ["rc", "concrete", "rectangular"],
    },
    {
        id: "columnType.std.rc.rect.600",
        familyId: "RCColumn",
        kind: "ColumnType",
        name: "RC柱 600×600",
        isStandard: true,
        profile: { kind: "Rectangle", width: 0.6, depth: 0.6 },
        semanticTags: ["rc", "concrete", "rectangular"],
    },
    {
        id: "columnType.std.rc.rect.700",
        familyId: "RCColumn",
        kind: "ColumnType",
        name: "RC柱 700×700",
        isStandard: true,
        profile: { kind: "Rectangle", width: 0.7, depth: 0.7 },
        semanticTags: ["rc", "concrete", "rectangular"],
    },
    // ── RCColumn (円形) ─────────────────────────────────────────
    {
        id: "columnType.std.rc.circ.400",
        familyId: "RCColumn",
        kind: "ColumnType",
        name: "RC円柱 φ400",
        isStandard: true,
        profile: { kind: "Circle", radius: 0.2 },
        semanticTags: ["rc", "concrete", "circular"],
    },
    {
        id: "columnType.std.rc.circ.500",
        familyId: "RCColumn",
        kind: "ColumnType",
        name: "RC円柱 φ500",
        isStandard: true,
        profile: { kind: "Circle", radius: 0.25 },
        semanticTags: ["rc", "concrete", "circular"],
    },
    {
        id: "columnType.std.rc.circ.600",
        familyId: "RCColumn",
        kind: "ColumnType",
        name: "RC円柱 φ600",
        isStandard: true,
        profile: { kind: "Circle", radius: 0.3 },
        semanticTags: ["rc", "concrete", "circular"],
    },

    // ── SteelColumn (角形鋼管) ──────────────────────────────────
    {
        id: "columnType.std.steel.box.300",
        familyId: "SteelColumn",
        kind: "ColumnType",
        name: "□-300×300",
        isStandard: true,
        profile: { kind: "Rectangle", width: 0.3, depth: 0.3 },
        semanticTags: ["steel", "box", "structural"],
    },
    {
        id: "columnType.std.steel.box.400",
        familyId: "SteelColumn",
        kind: "ColumnType",
        name: "□-400×400",
        isStandard: true,
        profile: { kind: "Rectangle", width: 0.4, depth: 0.4 },
        semanticTags: ["steel", "box", "structural"],
    },
    // ── SteelColumn (鋼管) ──────────────────────────────────────
    {
        id: "columnType.std.steel.pipe.300",
        familyId: "SteelColumn",
        kind: "ColumnType",
        name: "鋼管 φ300",
        isStandard: true,
        profile: { kind: "Circle", radius: 0.15 },
        semanticTags: ["steel", "pipe", "structural", "circular"],
    },
    {
        id: "columnType.std.steel.pipe.400",
        familyId: "SteelColumn",
        kind: "ColumnType",
        name: "鋼管 φ400",
        isStandard: true,
        profile: { kind: "Circle", radius: 0.2 },
        semanticTags: ["steel", "pipe", "structural", "circular"],
    },

    // ── TimberColumn ─────────────────────────────────────────────
    {
        id: "columnType.std.timber.105",
        familyId: "TimberColumn",
        kind: "ColumnType",
        name: "木柱 105×105",
        isStandard: true,
        profile: { kind: "Rectangle", width: 0.105, depth: 0.105 },
        semanticTags: ["timber", "wood", "post"],
    },
    {
        id: "columnType.std.timber.120",
        familyId: "TimberColumn",
        kind: "ColumnType",
        name: "木柱 120×120",
        isStandard: true,
        profile: { kind: "Rectangle", width: 0.12, depth: 0.12 },
        semanticTags: ["timber", "wood", "post"],
    },
    {
        id: "columnType.std.timber.150",
        familyId: "TimberColumn",
        kind: "ColumnType",
        name: "木柱 150×150",
        isStandard: true,
        profile: { kind: "Rectangle", width: 0.15, depth: 0.15 },
        semanticTags: ["timber", "wood", "post"],
    },
] as const;

export const DEFAULT_COLUMN_TYPE_ID = "columnType.std.rc.rect.500";
