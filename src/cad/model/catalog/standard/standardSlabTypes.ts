// 標準 Slab Type カタログ (read-only)。

import { SlabType } from "../ElementTypeDef";

export const STANDARD_SLAB_TYPES: readonly SlabType[] = [
    // ── RCSlab ───────────────────────────────────────────────────
    {
        id: "slabType.std.rc.150",
        familyId: "RCSlab",
        kind: "SlabType",
        name: "RC床 150mm",
        isStandard: true,
        thickness: 0.15,
        layers: [
            { material: "RC", thickness: 0.15, isStructural: true },
        ],
        semanticTags: ["rc", "concrete", "structural"],
    },
    {
        id: "slabType.std.rc.180",
        familyId: "RCSlab",
        kind: "SlabType",
        name: "RC床 180mm",
        isStandard: true,
        thickness: 0.18,
        layers: [
            { material: "RC", thickness: 0.18, isStructural: true },
        ],
        semanticTags: ["rc", "concrete", "structural"],
    },
    {
        id: "slabType.std.rc.200",
        familyId: "RCSlab",
        kind: "SlabType",
        name: "RC床 200mm",
        isStandard: true,
        thickness: 0.2,
        layers: [
            { material: "RC", thickness: 0.2, isStructural: true },
        ],
        semanticTags: ["rc", "concrete", "structural"],
    },
    {
        id: "slabType.std.rc.250",
        familyId: "RCSlab",
        kind: "SlabType",
        name: "RC床 250mm",
        isStandard: true,
        thickness: 0.25,
        layers: [
            { material: "RC", thickness: 0.25, isStructural: true },
        ],
        semanticTags: ["rc", "concrete", "structural"],
    },

    // ── DeckSlab (合成スラブ) ────────────────────────────────────
    {
        id: "slabType.std.deck.t75",
        familyId: "DeckSlab",
        kind: "SlabType",
        name: "デッキ合成 t=75",
        isStandard: true,
        thickness: 0.075,
        layers: [
            { material: "Deck", thickness: 0.005 },
            { material: "Concrete", thickness: 0.07, isStructural: true },
        ],
        semanticTags: ["composite", "deck", "steel"],
    },
    {
        id: "slabType.std.deck.t100",
        familyId: "DeckSlab",
        kind: "SlabType",
        name: "デッキ合成 t=100",
        isStandard: true,
        thickness: 0.1,
        layers: [
            { material: "Deck", thickness: 0.005 },
            { material: "Concrete", thickness: 0.095, isStructural: true },
        ],
        semanticTags: ["composite", "deck", "steel"],
    },

    // ── WoodSlab ─────────────────────────────────────────────────
    {
        id: "slabType.std.wood.24",
        familyId: "WoodSlab",
        kind: "SlabType",
        name: "木床合板 24mm",
        isStandard: true,
        thickness: 0.024,
        layers: [
            { material: "Plywood", thickness: 0.024, isStructural: true },
        ],
        semanticTags: ["wood", "plywood"],
    },
    {
        id: "slabType.std.wood.28",
        familyId: "WoodSlab",
        kind: "SlabType",
        name: "木床合板 28mm",
        isStandard: true,
        thickness: 0.028,
        layers: [
            { material: "Plywood", thickness: 0.028, isStructural: true },
        ],
        semanticTags: ["wood", "plywood"],
    },
] as const;

export const DEFAULT_SLAB_TYPE_ID = "slabType.std.rc.180";
