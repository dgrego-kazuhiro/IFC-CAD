import { Vec2 } from "../../geometry/math/Vec2";
import { RoomPolygon, resolveWallThicknesses } from "../../model/elements/SpaceElement";

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

/** 周長 (世界座標 m)。Shoelace 補正で AABB に依存しない実周長を求める。 */
function polygonPerimeter(outer: Vec2[]): number {
    const n = outer.length;
    if (n < 2) return 0;
    let s = 0;
    for (let i = 0; i < n; i++) {
        const a = outer[i], b = outer[(i + 1) % n];
        s += Math.hypot(b[0] - a[0], b[1] - a[1]);
    }
    return s;
}

/**
 * Compute the room metrics for a polygon + wall thickness, taking the
 * polygon's `wallReference` into account. The polygon's `outer` represents
 * the **sketch line**; depending on `wallReference`, that sketch line maps
 * to a different position relative to the wall:
 *
 *   - "Center"   : sketch line = wall centerline → 内法 contract by T/2 inward
 *   - "Interior" : sketch line = room inside face (= 内法 boundary)
 *                  → 内法 = polygonArea (no contraction); 芯々 expand by T/2
 *   - "Exterior" : sketch line = outside face → 内法 contract by T inward;
 *                  芯々 contract by T/2
 *
 * 値は Polygon のオフセット線形近似 (= polygonArea + perimeter × offset) で
 * 計算する。L字部屋等の非矩形でも実用上充分な精度。
 */
export function computeRoomMetrics(poly: RoomPolygon, wallThickness: number = 0.105): RoomMetrics {
    const { width, depth } = polygonBBox(poly.outer);
    const polygonAreaM2 = polygonArea(poly.outer);
    const perim = polygonPerimeter(poly.outer);
    const T = poly.wallThickness ?? wallThickness;
    const { inner, outer } = resolveWallThicknesses({
        innerThickness: poly.innerThickness,
        outerThickness: poly.outerThickness,
        wallThickness: T,
        wallReference: poly.wallReference,
    });
    // 内法 (= 部屋内部) は poly.outer を inner 分内側へオフセットした多角形。
    //   linear: area ≈ A − P × inner + (補正項)。負方向オフセットで perimeter
    //   項は減算される。+inner² × π/perim 等の高次項は無視 (薄壁前提)。
    const innerArea = Math.max(0, polygonAreaM2 - perim * inner);
    const innerWidth = Math.max(0, width - 2 * inner);
    const innerDepth = Math.max(0, depth - 2 * inner);
    // 芯々 (= 壁中心線) は poly.outer を centerOffset 分外側へオフセット。
    //   centerOffset = (outer − inner) / 2 (Center で 0、Interior で +T/2、
    //   Exterior で −T/2)。
    const centerOffset = (outer - inner) / 2;
    const centerArea = Math.max(0, polygonAreaM2 + perim * centerOffset);
    const centerWidth = Math.max(0, width + 2 * centerOffset);
    const centerDepth = Math.max(0, depth + 2 * centerOffset);
    const centerWidthMm = mToMm(centerWidth);
    const centerDepthMm = mToMm(centerDepth);
    return {
        centerWidthMm,
        centerDepthMm,
        centerAreaM2: centerArea,
        tatami: tatamiCount(centerArea),
        pCountWidth: pCount(centerWidthMm),
        pCountDepth: pCount(centerDepthMm),
        innerWidthMm: mToMm(innerWidth),
        innerDepthMm: mToMm(innerDepth),
        innerAreaM2: innerArea,
    };
}

/** Format a P count: integer when whole, else "x.5P". */
export function formatP(p: number): string {
    if (p === Math.floor(p)) return `${p}P`;
    return `${p.toFixed(1)}P`;
}
