import { useAppState } from "./AppState";
import { DEFAULT_GRID_NAMING } from "../model/grid/GridLine";
import { generateId } from "../utils/ids";
import { entitiesFromLegacyPolygons } from "../model/sketch/PolygonDerive";

const STORAGE_KEY = "ifc-cad.scene.v1";
const SCHEMA_VERSION = 1;

function replacer(_key: string, value: any) {
    if (value instanceof Set) return { __kind: "Set", v: Array.from(value) };
    if (value instanceof Float32Array) return { __kind: "F32", v: Array.from(value) };
    if (value instanceof Uint32Array) return { __kind: "U32", v: Array.from(value) };
    if (value instanceof Int32Array) return { __kind: "I32", v: Array.from(value) };
    return value;
}

function reviver(_key: string, value: any) {
    if (value && typeof value === "object" && typeof value.__kind === "string") {
        if (value.__kind === "Set") return new Set(value.v);
        if (value.__kind === "F32") return new Float32Array(value.v);
        if (value.__kind === "U32") return new Uint32Array(value.v);
        if (value.__kind === "I32") return new Int32Array(value.v);
    }
    return value;
}

interface PersistedScene {
    schemaVersion: number;
    elements: Record<string, any>;
    selection: string[];
    levels: any[];
    activeLevelId: string | null;
    grids: any[];
    gridNaming: any;
    constraints: Record<string, any>;
}

function snapshot(): PersistedScene {
    const s = useAppState.getState();
    // Drop `shape` (non-serializable cached geometry — regenerated on load).
    const strippedElements: Record<string, any> = {};
    for (const id in s.elements) {
        const { shape: _dropped, ...rest } = s.elements[id] as any;
        strippedElements[id] = rest;
    }
    return {
        schemaVersion: SCHEMA_VERSION,
        elements: strippedElements,
        selection: s.selection,
        levels: s.levels,
        activeLevelId: s.activeLevelId,
        grids: s.grids,
        gridNaming: s.gridNaming,
        constraints: s.constraints,
    };
}

export function saveScene(): boolean {
    try {
        const snap = snapshot();
        const json = JSON.stringify(snap, replacer);
        localStorage.setItem(STORAGE_KEY, json);
        // eslint-disable-next-line no-console
        console.log(
            `[saveScene] ok bytes=${json.length} ` +
            `elements=${Object.keys(snap.elements).length} ` +
            `grids=${snap.grids.length} ` +
            `levels=${snap.levels.length} ` +
            `activeLevelId=${snap.activeLevelId} ` +
            `constraints=${Object.keys(snap.constraints).length}`,
        );
        // eslint-disable-next-line no-console
        console.log("[saveScene] levels content:", snap.levels);
        return true;
    } catch (e) {
        // eslint-disable-next-line no-console
        console.warn("[saveScene] FAILED:", e);
        return false;
    }
}

export function loadScene(): boolean {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
        // eslint-disable-next-line no-console
        console.log("[loadScene] no saved data in localStorage");
        return false;
    }
    let data: PersistedScene;
    try {
        data = JSON.parse(raw, reviver) as PersistedScene;
    } catch (e) {
        // eslint-disable-next-line no-console
        console.warn("[loadScene] parse failed:", e);
        return false;
    }
    if (data.schemaVersion !== SCHEMA_VERSION) {
        // eslint-disable-next-line no-console
        console.warn(
            `[loadScene] schema version mismatch: saved=${data.schemaVersion} ` +
            `current=${SCHEMA_VERSION}`,
        );
        return false;
    }
    // eslint-disable-next-line no-console
    console.log(
        `[loadScene] reading bytes=${raw.length} ` +
        `elements=${Object.keys(data.elements ?? {}).length} ` +
        `grids=${(data.grids ?? []).length} ` +
        `levels=${(data.levels ?? []).length} ` +
        `activeLevelId=${data.activeLevelId} ` +
        `constraints=${Object.keys(data.constraints ?? {}).length}`,
    );
    // eslint-disable-next-line no-console
    console.log("[loadScene] levels content:", data.levels);
    // Force every element to regenerate derived geometry/mesh on first render
    // after load by dropping `shape` and raising all build-related dirty flags.
    const restored: Record<string, any> = {};
    for (const id in data.elements) {
        const el = data.elements[id];
        let migrated = { ...el };
        // Legacy data has no `entities` on Space — synthesize from polygons.
        if (el?.type === "Space" && !Array.isArray(el.entities)) {
            const { entities, polyIdByEntity } = entitiesFromLegacyPolygons(
                Array.isArray(el.polygons) ? el.polygons : [],
                generateId,
            );
            migrated = { ...migrated, entities, polyIdByEntity };
        }
        restored[id] = {
            ...migrated,
            shape: null,
            dirtyFlags: new Set(["Geometry", "Mesh", "Render"]),
        };
    }
    useAppState.setState({
        elements: restored,
        selection: data.selection ?? [],
        levels: data.levels ?? [],
        activeLevelId: data.activeLevelId ?? null,
        grids: data.grids ?? [],
        gridNaming: data.gridNaming ?? DEFAULT_GRID_NAMING,
        constraints: data.constraints ?? {},
        activeRoomId: null,
        pendingRoomLevelId: null,
        roomEditMode: "select",
        gridlineDrafting: false,
        selectedGridIds: [],
        sketchSelection: [],
        selectedConstraintId: null,
        solverDragHint: [],
        activeTool: "select",
    });
    return true;
}

export function hasSavedScene(): boolean {
    return localStorage.getItem(STORAGE_KEY) !== null;
}

export function clearScene(): void {
    localStorage.removeItem(STORAGE_KEY);
    useAppState.setState({
        elements: {},
        selection: [],
        grids: [],
        gridNaming: DEFAULT_GRID_NAMING,
        constraints: {},
        activeRoomId: null,
        pendingRoomLevelId: null,
        activeLevelId: null,
        roomEditMode: "select",
        gridlineDrafting: false,
        selectedGridIds: [],
        sketchSelection: [],
        selectedConstraintId: null,
        solverDragHint: [],
        activeTool: "select",
    });
}
