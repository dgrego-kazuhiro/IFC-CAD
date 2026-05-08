// 標準 Beam Type カタログ (read-only)。

import { BeamType } from "../ElementTypeDef";

export const STANDARD_BEAM_TYPES: readonly BeamType[] = [
    // ── RCBeam ──────────────────────────────────────────────────
    {
        id: "beamType.std.rc.300x600",
        familyId: "RCBeam",
        kind: "BeamType",
        name: "RC梁 300×600",
        isStandard: true,
        profile: { kind: "Rectangle", width: 0.3, depth: 0.6 },
        semanticTags: ["rc", "concrete"],
    },
    {
        id: "beamType.std.rc.400x800",
        familyId: "RCBeam",
        kind: "BeamType",
        name: "RC梁 400×800",
        isStandard: true,
        profile: { kind: "Rectangle", width: 0.4, depth: 0.8 },
        semanticTags: ["rc", "concrete"],
    },
    {
        id: "beamType.std.rc.500x900",
        familyId: "RCBeam",
        kind: "BeamType",
        name: "RC梁 500×900",
        isStandard: true,
        profile: { kind: "Rectangle", width: 0.5, depth: 0.9 },
        semanticTags: ["rc", "concrete"],
    },

    // ── SteelBeam (H形鋼を矩形近似で MVP 化) ────────────────────
    // IShape の builder 整備後に正規 H 形に差し替え可。
    {
        id: "beamType.std.steel.h400",
        familyId: "SteelBeam",
        kind: "BeamType",
        name: "H-400×200",
        isStandard: true,
        profile: { kind: "Rectangle", width: 0.2, depth: 0.4 },
        semanticTags: ["steel", "hsection"],
    },
    {
        id: "beamType.std.steel.h500",
        familyId: "SteelBeam",
        kind: "BeamType",
        name: "H-500×200",
        isStandard: true,
        profile: { kind: "Rectangle", width: 0.2, depth: 0.5 },
        semanticTags: ["steel", "hsection"],
    },
    {
        id: "beamType.std.steel.h600",
        familyId: "SteelBeam",
        kind: "BeamType",
        name: "H-600×200",
        isStandard: true,
        profile: { kind: "Rectangle", width: 0.2, depth: 0.6 },
        semanticTags: ["steel", "hsection"],
    },
    {
        id: "beamType.std.steel.h700",
        familyId: "SteelBeam",
        kind: "BeamType",
        name: "H-700×300",
        isStandard: true,
        profile: { kind: "Rectangle", width: 0.3, depth: 0.7 },
        semanticTags: ["steel", "hsection"],
    },

    // ── TimberBeam ─────────────────────────────────────────────
    {
        id: "beamType.std.timber.105sq",
        familyId: "TimberBeam",
        kind: "BeamType",
        name: "木梁 105×105",
        isStandard: true,
        profile: { kind: "Rectangle", width: 0.105, depth: 0.105 },
        semanticTags: ["timber", "wood"],
    },
    {
        id: "beamType.std.timber.105x210",
        familyId: "TimberBeam",
        kind: "BeamType",
        name: "木梁 105×210",
        isStandard: true,
        profile: { kind: "Rectangle", width: 0.105, depth: 0.21 },
        semanticTags: ["timber", "wood"],
    },
    {
        id: "beamType.std.timber.120sq",
        familyId: "TimberBeam",
        kind: "BeamType",
        name: "木梁 120×120",
        isStandard: true,
        profile: { kind: "Rectangle", width: 0.12, depth: 0.12 },
        semanticTags: ["timber", "wood"],
    },
    {
        id: "beamType.std.timber.120x240",
        familyId: "TimberBeam",
        kind: "BeamType",
        name: "木梁 120×240",
        isStandard: true,
        profile: { kind: "Rectangle", width: 0.12, depth: 0.24 },
        semanticTags: ["timber", "wood"],
    },
] as const;

export const DEFAULT_BEAM_TYPE_ID = "beamType.std.rc.400x800";
