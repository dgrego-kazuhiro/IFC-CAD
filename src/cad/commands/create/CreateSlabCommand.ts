import { Command } from "../base/Command";
import { CommandResult } from "../base/CommandResult";
import { useAppState } from "../../application/AppState";
import { SlabElement } from "../../model/elements/SlabElement";
import { SpaceElement } from "../../model/elements/SpaceElement";
import { ElementId } from "../../model/base/ElementId";
import { Vec2 } from "../../geometry/math/Vec2";
import { SlabTypeOverride } from "../../model/catalog/ElementTypeDef";
import { effectiveSlabType } from "../../model/catalog/TypeResolver";
import { mat4 } from "gl-matrix";
import polygonClipping from "polygon-clipping";

let nextId = 0;
function genId(): ElementId {
    nextId++;
    return `slab-${Date.now().toString(36)}-${nextId.toString(36)}` as ElementId;
}

/**
 * Build a slab outer/hole profile from a Space (per spec §5).
 * All shapes in the room (rectangles drawn by the user become 4-vertex
 * polygons too) are stored as `space.polygons`; this function unions them.
 */
export function collectSpaceProfiles(space: SpaceElement): { outer: Vec2[]; holes: Vec2[][] }[] {
    const inputs: [number, number][][][] = [];
    for (const p of space.polygons ?? []) {
        if (p.outer.length < 3) continue;
        const outer = [...p.outer.map((v) => [v[0], v[1]] as [number, number])];
        if (outer.length > 0 && (outer[0][0] !== outer[outer.length - 1][0] || outer[0][1] !== outer[outer.length - 1][1])) {
            outer.push([outer[0][0], outer[0][1]]);
        }
        const rings: [number, number][][] = [outer];
        for (const h of p.holes ?? []) {
            if (h.length < 3) continue;
            const hh = [...h.map((v) => [v[0], v[1]] as [number, number])];
            if (hh.length > 0 && (hh[0][0] !== hh[hh.length - 1][0] || hh[0][1] !== hh[hh.length - 1][1])) {
                hh.push([hh[0][0], hh[0][1]]);
            }
            rings.push(hh);
        }
        inputs.push(rings);
    }
    if (inputs.length === 0) {
        if (space.boundary && space.boundary.length >= 3) {
            return [{ outer: space.boundary, holes: [] }];
        }
        return [];
    }

    const [first, ...rest] = inputs;
    const merged = polygonClipping.union(first, ...rest);

    const out: { outer: Vec2[]; holes: Vec2[][] }[] = [];
    for (const poly of merged) {
        if (poly.length === 0) continue;
        const outerRing = poly[0].map(([x, z]) => [x, z] as Vec2);
        if (outerRing.length > 1 &&
            outerRing[0][0] === outerRing[outerRing.length - 1][0] &&
            outerRing[0][1] === outerRing[outerRing.length - 1][1]) {
            outerRing.pop();
        }
        if (outerRing.length < 3) continue;
        const holes: Vec2[][] = [];
        for (let i = 1; i < poly.length; i++) {
            const h = poly[i].map(([x, z]) => [x, z] as Vec2);
            if (h.length > 1 &&
                h[0][0] === h[h.length - 1][0] &&
                h[0][1] === h[h.length - 1][1]) {
                h.pop();
            }
            if (h.length >= 3) holes.push(h);
        }
        out.push({ outer: outerRing, holes });
    }
    return out;
}

export function buildSlabProfileFromSpace(space: SpaceElement): { outer: Vec2[]; holes: Vec2[][] } | null {
    const profiles = collectSpaceProfiles(space);
    return profiles.length > 0 ? profiles[0] : null;
}

export class CreateSlabCommand implements Command {
    private slabId: ElementId;

    constructor(
        public boundary: Vec2[],
        /** SlabType の id。AppState.types から引いて thickness を導出。 */
        public typeId: ElementId,
        public elevation: number = 0,
        public holes: Vec2[][] = [],
        public levelId?: ElementId,
        public sourceSpaceId?: ElementId,
        public overrides?: SlabTypeOverride,
    ) {
        this.slabId = genId();
    }

    getSlabId(): ElementId { return this.slabId; }

    /** Convenience: build a CreateSlabCommand from a Space. */
    static fromSpace(spaceId: ElementId, typeId: ElementId): CreateSlabCommand | null {
        const state = useAppState.getState();
        const space = state.elements[spaceId] as SpaceElement | undefined;
        if (!space || space.type !== "Space") return null;
        const profile = buildSlabProfileFromSpace(space);
        if (!profile) return null;
        return new CreateSlabCommand(
            profile.outer,
            typeId,
            0,
            profile.holes,
            space.levelId,
            spaceId,
        );
    }

    execute(): CommandResult {
        const state = useAppState.getState();
        const eff = effectiveSlabType(state.types, this.typeId, this.overrides);
        if (!eff) {
            return { success: false, message: `SlabType not found: ${this.typeId}` };
        }
        const slab: SlabElement = {
            id: this.slabId,
            type: "Slab",
            name: this.sourceSpaceId ? "Slab (from Space)" : "Slab",
            visible: true,
            locked: false,
            transform: mat4.create(),
            dirtyFlags: new Set(["Geometry", "Mesh", "Render"]),
            shape: null,
            typeId: this.typeId,
            overrides: this.overrides,
            boundary: this.boundary,
            holes: this.holes.length > 0 ? this.holes : undefined,
            thickness: eff.thickness,
            elevation: this.elevation,
            levelId: this.levelId,
        };
        state.addElement(slab);
        return { success: true };
    }

    undo(): CommandResult {
        const state = useAppState.getState();
        state.removeElement(this.slabId);
        return { success: true };
    }
}
