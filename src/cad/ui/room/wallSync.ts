import { Vec2 } from "../../geometry/math/Vec2";
import { Vec3 } from "../../geometry/math/Vec3";
import { offsetClosedPolygon } from "../../occt/OcctOffset";

function outwardNormal(p1: Vec2, p2: Vec2, center: Vec2): [number, number] {
    const dx = p2[0] - p1[0], dy = p2[1] - p1[1];
    const len = Math.sqrt(dx * dx + dy * dy) || 1;
    const nx = -dy / len, ny = dx / len;
    const dot = nx * (center[0] - (p1[0] + p2[0]) / 2) + ny * (center[1] - (p1[1] + p2[1]) / 2);
    return dot > 0 ? [-nx, -ny] : [nx, ny];
}

function intersectLines(
    p1x: number, p1y: number, d1x: number, d1y: number,
    p2x: number, p2y: number, d2x: number, d2y: number,
): [number, number] | null {
    const denom = d1x * d2y - d1y * d2x;
    if (Math.abs(denom) < 1e-10) return null;
    const t = ((p2x - p1x) * d2y - (p2y - p1y) * d2x) / denom;
    return [p1x + d1x * t, p1y + d1y * t];
}

/** Mitered polygon corners offset outward by `offset` from `corners`. */
export function computeMiteredCorners(
    corners: Vec2[], center: Vec2, offset: number,
): Vec2[] {
    const n = corners.length;
    const offsetLines: { px: number; py: number; dx: number; dy: number }[] = [];
    for (let i = 0; i < n; i++) {
        const p1 = corners[i], p2 = corners[(i + 1) % n];
        const [nx, ny] = outwardNormal(p1, p2, center);
        offsetLines.push({ px: p1[0] + nx * offset, py: p1[1] + ny * offset, dx: p2[0] - p1[0], dy: p2[1] - p1[1] });
    }
    const mitered: Vec2[] = [];
    for (let i = 0; i < n; i++) {
        const prev = offsetLines[(i - 1 + n) % n], curr = offsetLines[i];
        const pt = intersectLines(prev.px, prev.py, prev.dx, prev.dy, curr.px, curr.py, curr.dx, curr.dy);
        if (pt) mitered.push(pt);
        else { const [nx, ny] = outwardNormal(corners[(i - 1 + n) % n], corners[i], center); mitered.push([corners[i][0] + nx * offset, corners[i][1] + ny * offset]); }
    }
    return mitered;
}

/**
 * Compute a wall-outline polygon from an inner ring and a per-edge wall mask.
 * For each inner vertex i, inspects the two adjacent walls (edge (i-1)%n and
 * edge i) and picks a corresponding outline vertex:
 *  - both walls present  → mitred intersection of the two offset lines
 *  - only prev present   → square cap at end of wall (i-1)%n
 *  - only next present   → square cap at start of wall i
 *  - both absent         → no outline vertex (corner drops out)
 * Outline edges are included only for walls that exist (so cut-side edges
 * don't appear). `innerToOuter[i]` maps inner vertex i → outline vertex index
 * (or null when dropped), which callers use to add constraints that keep the
 * outline driven by inner-edge moves.
 */
export function computeWalledOutlineGeometry(
    inner: Vec2[],
    wallIds: string[],
    wallThickness: number,
    center: Vec2,
): {
    outer: Vec2[];
    innerToOuter: (number | null)[];
    edges: [number, number][];
} {
    const n = inner.length;
    const T = wallThickness;
    // Per-wall outward normal, scaled by T.
    const wallN: [number, number][] = [];
    for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const dx = inner[j][0] - inner[i][0];
        const dy = inner[j][1] - inner[i][1];
        const len = Math.hypot(dx, dy) || 1;
        let nx = (-dy / len) * T, ny = (dx / len) * T;
        const mx = (inner[i][0] + inner[j][0]) / 2;
        const my = (inner[i][1] + inner[j][1]) / 2;
        if (nx * (center[0] - mx) + ny * (center[1] - my) > 0) { nx = -nx; ny = -ny; }
        wallN.push([nx, ny]);
    }
    const outer: Vec2[] = [];
    const innerToOuter: (number | null)[] = new Array(n).fill(null);
    for (let i = 0; i < n; i++) {
        const prev = (i - 1 + n) % n;
        const hasPrev = !!wallIds[prev];
        const hasNext = !!wallIds[i];
        if (!hasPrev && !hasNext) continue;
        let pos: Vec2;
        if (hasPrev && hasNext) {
            const op = wallN[prev], oc = wallN[i];
            const pt = intersectLines(
                inner[prev][0] + op[0], inner[prev][1] + op[1],
                inner[i][0] - inner[prev][0], inner[i][1] - inner[prev][1],
                inner[i][0] + oc[0], inner[i][1] + oc[1],
                inner[(i + 1) % n][0] - inner[i][0], inner[(i + 1) % n][1] - inner[i][1],
            );
            pos = pt ?? [inner[i][0] + oc[0], inner[i][1] + oc[1]];
        } else if (hasPrev) {
            pos = [inner[i][0] + wallN[prev][0], inner[i][1] + wallN[prev][1]];
        } else {
            pos = [inner[i][0] + wallN[i][0], inner[i][1] + wallN[i][1]];
        }
        innerToOuter[i] = outer.length;
        outer.push(pos);
    }
    const edges: [number, number][] = [];
    for (let i = 0; i < n; i++) {
        if (!wallIds[i]) continue;
        const a = innerToOuter[i];
        const b = innerToOuter[(i + 1) % n];
        if (a === null || b === null) continue;
        edges.push([a, b]);
    }
    return { outer, innerToOuter, edges };
}

/**
 * Clip a closed polygon by the half-plane on the side of `insidePt` relative
 * to the line through `a`→`b`. Returns the portion that contains `insidePt`.
 * Uses Sutherland-Hodgman; assumes `poly` is closed (CCW or CW).
 */
export function clipPolygonHalfPlane(
    poly: Vec2[], a: Vec2, b: Vec2, insidePt: Vec2,
): Vec2[] {
    const n = poly.length;
    if (n === 0) return [];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    // Normal (nx, ny); flip so the half-plane contains insidePt.
    let nx = -dy, ny = dx;
    const dot = nx * (insidePt[0] - a[0]) + ny * (insidePt[1] - a[1]);
    if (dot < 0) { nx = -nx; ny = -ny; }
    const signedDist = (p: Vec2) => (p[0] - a[0]) * nx + (p[1] - a[1]) * ny;
    const EPS = 1e-9;
    const out: Vec2[] = [];
    for (let i = 0; i < n; i++) {
        const prev = poly[(i - 1 + n) % n];
        const curr = poly[i];
        const dPrev = signedDist(prev);
        const dCurr = signedDist(curr);
        const prevIn = dPrev >= -EPS;
        const currIn = dCurr >= -EPS;
        if (currIn) {
            if (!prevIn) {
                const t = dPrev / (dPrev - dCurr);
                out.push([prev[0] + t * (curr[0] - prev[0]), prev[1] + t * (curr[1] - prev[1])]);
            }
            out.push(curr);
        } else if (prevIn) {
            const t = dPrev / (dPrev - dCurr);
            out.push([prev[0] + t * (curr[0] - prev[0]), prev[1] + t * (curr[1] - prev[1])]);
        }
    }
    return out;
}

/**
 * OCCT BRepOffsetAPI_MakeOffset を使った内/外オフセット (async)。
 *  - distance > 0: 外側 (CCW 入力)
 *  - distance < 0: 内側
 * 戻り値は閉ポリゴン (始点重複なし)。OCCT が失敗した場合は手書きの
 * `computeMiteredCorners` にフォールバックする。
 *
 * 用途: 壁外枠 (`wallOutlineOf` polygon) の生成、内法オフセット計算など。
 */
export async function offsetClosedPolygonOCCT(
    corners: Vec2[], offset: number,
): Promise<Vec2[]> {
    if (corners.length < 3 || offset === 0) return corners.slice();
    // CCW を仮定して signed area を確認、CW なら反転して再度 CCW 化。
    const isCcw = signedArea(corners) > 0;
    const ccw = isCcw ? corners : corners.slice().reverse();
    const result = await offsetClosedPolygon(ccw, offset);
    if (result && result.length >= 3) return result;
    // Fallback: 手書きの miter 計算 (全エッジ垂直オフセット → 交点)
    let cx = 0, cy = 0;
    for (const v of corners) { cx += v[0]; cy += v[1]; }
    cx /= corners.length; cy /= corners.length;
    return computeMiteredCorners(corners, [cx, cy], offset);
}

function signedArea(p: Vec2[]): number {
    let a = 0;
    for (let i = 0; i < p.length; i++) {
        const j = (i + 1) % p.length;
        a += p[i][0] * p[j][1] - p[j][0] * p[i][1];
    }
    return a / 2;
}

export function computeMiteredWallAxes(
    corners: Vec2[], center: Vec2, offset: number,
): [Vec3, Vec3][] {
    const mitered = computeMiteredCorners(corners, center, offset);
    const n = mitered.length;
    const axes: [Vec3, Vec3][] = [];
    for (let i = 0; i < n; i++) {
        const [sx, sz] = mitered[i], [ex, ez] = mitered[(i + 1) % n];
        axes.push([[sx, 0, sz], [ex, 0, ez]]);
    }
    return axes;
}

/**
 * Recompute wall axes for a polygon's outer ring and update them via the
 * provided callback. wallIds.length must equal outer.length.
 */
export function syncWallsToPolygonOuter(
    outer: Vec2[],
    wallIds: string[] | undefined,
    wallThickness: number,
    updateWallAxis: (wallId: string, axis: [Vec3, Vec3]) => void,
): void {
    if (!wallIds || wallIds.length !== outer.length) return;
    let cx = 0, cy = 0;
    for (const p of outer) { cx += p[0]; cy += p[1]; }
    cx /= outer.length; cy /= outer.length;
    const center: Vec2 = [cx, cy];
    const axes = computeMiteredWallAxes(outer, center, wallThickness / 2);
    for (let i = 0; i < wallIds.length; i++) {
        if (!wallIds[i]) continue;
        updateWallAxis(wallIds[i], axes[i]);
    }
}
