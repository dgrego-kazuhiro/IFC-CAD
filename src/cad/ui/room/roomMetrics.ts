import { Vec2 } from "../../geometry/math/Vec2";
import { RoomPolygon } from "../../model/elements/SpaceElement";

const TATAMI_M2 = 1.6562; // 中京間 0.91 × 1.82
const SHAKU_MM = 910;

/** Shoelace area (m²) of an outer ring. Sign-corrected (always positive). */
export function polygonArea(outer: Vec2[]): number {
    const n = outer.length;
    if (n < 3) return 0;
    let s = 0;
    for (let i = 0; i < n; i++) {
        const a = outer[i], b = outer[(i + 1) % n];
        s += a[0] * b[1] - b[0] * a[1];
    }
    return Math.abs(s) * 0.5;
}

/** Axis-aligned bounding box of an outer ring (m). */
export function polygonBBox(outer: Vec2[]): { width: number; depth: number } {
    if (outer.length === 0) return { width: 0, depth: 0 };
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const v of outer) {
        if (v[0] < minX) minX = v[0];
        if (v[0] > maxX) maxX = v[0];
        if (v[1] < minY) minY = v[1];
        if (v[1] > maxY) maxY = v[1];
    }
    return { width: maxX - minX, depth: maxY - minY };
}

/** Round an area in m² to a 0.5-tatami count using 中京間 (1.6562 m²/畳). */
export function tatamiCount(areaM2: number): number {
    const raw = areaM2 / TATAMI_M2;
    return Math.round(raw * 2) / 2; // 0.5 step
}

/** Convert metres to millimetres, rounded. */
export function mToMm(m: number): number {
    return Math.round(m * 1000);
}

/** Round metres to the nearest 1P / 0.5P step expressed as a fractional P. */
export function pCount(mm: number): number {
    return Math.round((mm / SHAKU_MM) * 2) / 2;
}

export interface RoomMetrics {
    centerWidthMm: number;   // 芯々寸法 (mm)
    centerDepthMm: number;
    centerAreaM2: number;    // 芯々面積
    tatami: number;          // 畳数
    pCountWidth: number;     // P数 (横)
    pCountDepth: number;
    innerWidthMm: number;    // 推定内法寸法 (壁芯から壁厚分内側)
    innerDepthMm: number;
    innerAreaM2: number;     // 推定内法面積
}

/** Compute the room metrics for an inner polygon + wall thickness. */
export function computeRoomMetrics(poly: RoomPolygon, wallThickness: number = 0.105): RoomMetrics {
    const { width, depth } = polygonBBox(poly.outer);
    const centerWidthMm = mToMm(width);
    const centerDepthMm = mToMm(depth);
    const centerAreaM2 = polygonArea(poly.outer);
    // Inner approximation: subtract the wall thickness on both sides
    // (only meaningful for orthogonal rooms — for L-shapes it's a coarse hint).
    const innerWidth = Math.max(0, width - wallThickness);
    const innerDepth = Math.max(0, depth - wallThickness);
    const innerAreaM2 = centerAreaM2 - wallThickness * (width + depth);
    return {
        centerWidthMm,
        centerDepthMm,
        centerAreaM2,
        tatami: tatamiCount(centerAreaM2),
        pCountWidth: pCount(centerWidthMm),
        pCountDepth: pCount(centerDepthMm),
        innerWidthMm: mToMm(innerWidth),
        innerDepthMm: mToMm(innerDepth),
        innerAreaM2: Math.max(0, innerAreaM2),
    };
}

/** Format a P count: integer when whole, else "x.5P". */
export function formatP(p: number): string {
    if (p === Math.floor(p)) return `${p}P`;
    return `${p.toFixed(1)}P`;
}
