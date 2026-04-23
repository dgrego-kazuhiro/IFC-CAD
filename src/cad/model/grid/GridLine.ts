import { Vec3 } from '../../geometry/math/Vec3';

export type GridCurve =
    | { type: "Line"; start: Vec3; end: Vec3 }
    | { type: "Polyline"; points: Vec3[] }
    | { type: "Arc"; center: Vec3; radius: number; startAngle: number; endAngle: number };

export interface GridSegment { a: Vec3; b: Vec3; }

/** Ordered vertices of a Line / Polyline curve. Arc returns []. */
export function gridVertices(curve: GridCurve): Vec3[] {
    if (curve.type === "Line") return [curve.start, curve.end];
    if (curve.type === "Polyline") return curve.points;
    return [];
}

/** Successive linear segments. Arc returns []. */
export function gridSegments(curve: GridCurve): GridSegment[] {
    const v = gridVertices(curve);
    const segs: GridSegment[] = [];
    for (let i = 0; i < v.length - 1; i++) segs.push({ a: v[i], b: v[i + 1] });
    return segs;
}

export function gridFirstVertex(curve: GridCurve): Vec3 | null {
    const v = gridVertices(curve);
    return v.length > 0 ? v[0] : null;
}

export function gridLastVertex(curve: GridCurve): Vec3 | null {
    const v = gridVertices(curve);
    return v.length > 0 ? v[v.length - 1] : null;
}

/** Build a curve from a list of vertices: Line when 2, Polyline when ≥3. */
export function curveFromVertices(points: Vec3[]): GridCurve | null {
    if (points.length < 2) return null;
    if (points.length === 2) return { type: "Line", start: points[0], end: points[1] };
    return { type: "Polyline", points };
}

export interface GridExtents {
    mode: "Model" | "ViewSpecific";
    minZ?: number;
    maxZ?: number;
}

export interface GridLine {
    id: string;
    name: string;
    curve: GridCurve;
    kind: "Primary" | "Auxiliary";
    visible: boolean;
    locked: boolean;
    bubbleStart?: boolean;
    bubbleEnd?: boolean;
    extents?: GridExtents;
}

export type GridSeriesScheme = "Numeric" | "Alphabetic";

export interface GridSeries {
    scheme: GridSeriesScheme;
    nextValue: string;
}

export interface GridNamingState {
    xSeries: GridSeries;
    ySeries: GridSeries;
}

export const DEFAULT_GRID_NAMING: GridNamingState = {
    xSeries: { scheme: "Numeric", nextValue: "1" },
    ySeries: { scheme: "Alphabetic", nextValue: "A" },
};

// §8.2 — direction detection: |dx| >= |dz| → horizontal-like (numeric series)
export function detectGridAxis(start: Vec3, end: Vec3): "horizontal" | "vertical" {
    const dx = Math.abs(end[0] - start[0]);
    const dz = Math.abs(end[2] - start[2]);
    return dx >= dz ? "horizontal" : "vertical";
}

function nextNumeric(value: string): string {
    const n = parseInt(value, 10);
    return Number.isFinite(n) ? String(n + 1) : "1";
}

function nextAlphabetic(value: string): string {
    if (!value) return "A";
    // bijective base-26 increment: A..Z, AA..ZZ, ...
    const chars = value.toUpperCase().split("");
    let i = chars.length - 1;
    while (i >= 0) {
        if (chars[i] === "Z") {
            chars[i] = "A";
            i--;
        } else {
            chars[i] = String.fromCharCode(chars[i].charCodeAt(0) + 1);
            return chars.join("");
        }
    }
    return "A" + chars.join("");
}

export function advanceSeries(series: GridSeries): GridSeries {
    const next = series.scheme === "Numeric" ? nextNumeric(series.nextValue) : nextAlphabetic(series.nextValue);
    return { scheme: series.scheme, nextValue: next };
}

// §7 — produce next name for a new grid based on its direction
export function pickNextGridName(
    naming: GridNamingState,
    start: Vec3,
    end: Vec3,
): { name: string; nextNaming: GridNamingState } {
    const axis = detectGridAxis(start, end);
    // horizontal-like line → numeric series (per §8.1: 横方向 → Numeric)
    if (axis === "horizontal") {
        const name = naming.xSeries.nextValue;
        return {
            name,
            nextNaming: { ...naming, xSeries: advanceSeries(naming.xSeries) },
        };
    } else {
        const name = naming.ySeries.nextValue;
        return {
            name,
            nextNaming: { ...naming, ySeries: advanceSeries(naming.ySeries) },
        };
    }
}
