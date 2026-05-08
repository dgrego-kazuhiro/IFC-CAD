// 標準 Wall Type カタログ (read-only)。
// アプリ起動時に AppState.types に seed する。複製→編集はユーザ Type として
// `isStandard: false` で別 ID 発行。

import { WallType } from "../ElementTypeDef";

export const STANDARD_WALL_TYPES: readonly WallType[] = [
    // ── 内壁 (LGS+PB) ────────────────────────────────────────────
    {
        id: "wallType.std.interior.lgs100",
        familyId: "BasicWall",
        kind: "WallType",
        name: "内壁 LGS-100",
        isStandard: true,
        thickness: 0.1,
        locationLine: "Center",
        layers: [
            { material: "PB", thickness: 0.0125 },
            { material: "LGS", thickness: 0.075 },
            { material: "PB", thickness: 0.0125 },
        ],
        semanticTags: ["interior", "partition", "lgs", "lightweight"],
    },
    {
        id: "wallType.std.interior.lgs150",
        familyId: "BasicWall",
        kind: "WallType",
        name: "内壁 LGS-150",
        isStandard: true,
        thickness: 0.15,
        locationLine: "Center",
        layers: [
            { material: "PB", thickness: 0.0125 },
            { material: "LGS", thickness: 0.125 },
            { material: "PB", thickness: 0.0125 },
        ],
        semanticTags: ["interior", "partition", "lgs"],
    },

    // ── 間仕切り (PB のみ) ──────────────────────────────────────
    {
        id: "wallType.std.partition.pb75",
        familyId: "BasicWall",
        kind: "WallType",
        name: "間仕切り PB-75",
        isStandard: true,
        thickness: 0.075,
        locationLine: "Center",
        layers: [
            { material: "PB", thickness: 0.0375 },
            { material: "PB", thickness: 0.0375 },
        ],
        semanticTags: ["interior", "partition", "thin"],
    },
    {
        id: "wallType.std.partition.pb100",
        familyId: "BasicWall",
        kind: "WallType",
        name: "間仕切り PB-100",
        isStandard: true,
        thickness: 0.1,
        locationLine: "Center",
        layers: [
            { material: "PB", thickness: 0.05 },
            { material: "PB", thickness: 0.05 },
        ],
        semanticTags: ["interior", "partition"],
    },

    // ── 外壁 (ALC) ──────────────────────────────────────────────
    {
        id: "wallType.std.exterior.alc150",
        familyId: "BasicWall",
        kind: "WallType",
        name: "外壁 ALC-150",
        isStandard: true,
        thickness: 0.15,
        locationLine: "FinishExterior",
        layers: [
            { material: "ALC", thickness: 0.15, isStructural: true },
        ],
        fireRatingHours: 1,
        semanticTags: ["exterior", "alc", "fireproof"],
    },
    {
        id: "wallType.std.exterior.alc200",
        familyId: "BasicWall",
        kind: "WallType",
        name: "外壁 ALC-200",
        isStandard: true,
        thickness: 0.2,
        locationLine: "FinishExterior",
        layers: [
            { material: "ALC", thickness: 0.2, isStructural: true },
        ],
        fireRatingHours: 2,
        semanticTags: ["exterior", "alc", "fireproof"],
    },

    // ── 構造壁 (RC 単層) ────────────────────────────────────────
    {
        id: "wallType.std.rc.150",
        familyId: "BasicWall",
        kind: "WallType",
        name: "RC壁 150mm",
        isStandard: true,
        thickness: 0.15,
        locationLine: "Center",
        layers: [
            { material: "RC", thickness: 0.15, isStructural: true },
        ],
        fireRatingHours: 2,
        semanticTags: ["structural", "rc", "loadBearing"],
    },
    {
        id: "wallType.std.rc.200",
        familyId: "BasicWall",
        kind: "WallType",
        name: "RC壁 200mm",
        isStandard: true,
        thickness: 0.2,
        locationLine: "Center",
        layers: [
            { material: "RC", thickness: 0.2, isStructural: true },
        ],
        fireRatingHours: 2,
        semanticTags: ["structural", "rc", "loadBearing"],
    },
    {
        id: "wallType.std.rc.250",
        familyId: "BasicWall",
        kind: "WallType",
        name: "RC壁 250mm",
        isStandard: true,
        thickness: 0.25,
        locationLine: "Center",
        layers: [
            { material: "RC", thickness: 0.25, isStructural: true },
        ],
        fireRatingHours: 2,
        semanticTags: ["structural", "rc", "loadBearing"],
    },
] as const;

export const DEFAULT_WALL_TYPE_ID = "wallType.std.interior.lgs100";
