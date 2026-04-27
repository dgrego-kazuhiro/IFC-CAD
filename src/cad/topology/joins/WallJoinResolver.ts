import { WallElement } from '../../model/elements/WallElement';
import { Vec3 } from '../../geometry/math/Vec3';

// ─── Types ───

export interface WallJoinResult {
    wallId: string;
    at: "Start" | "End";
    /** Overridden footprint corners [left, right] at this end */
    corners?: [Vec3, Vec3];
}

interface Line2D {
    px: number; pz: number;
    dx: number; dz: number;
}

// ─── 2D math helpers (XZ plane) ───

const TOLERANCE = 0.01; // 10mm

type Vec2 = {
  x: number;
  y: number;
};

type OffsetCornerResult = {
  inside: Vec2;
  outside: Vec2;
  turn: "left" | "right";
};

const EPS = 1e-12;

function add(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x + b.x, y: a.y + b.y };
}

function sub(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x - b.x, y: a.y - b.y };
}

function mul(v: Vec2, s: number): Vec2 {
  return { x: v.x * s, y: v.y * s };
}

function cross(a: Vec2, b: Vec2): number {
  return a.x * b.y - a.y * b.x;
}

function length(v: Vec2): number {
  return Math.hypot(v.x, v.y);
}

function normalize(v: Vec2): Vec2 {
  const len = length(v);
  if (len < EPS) {
    throw new Error("Zero-length vector");
  }
  return { x: v.x / len, y: v.y / len };
}

// 反時計回りに90度回転したベクトル（左法線）
function leftNormal(v: Vec2): Vec2 {
  return { x: -v.y, y: v.x };
}

/**
 * 2直線
 *   a + t*u
 *   b + s*v
 * の交点を返す
 */
function lineIntersection(a: Vec2, u: Vec2, b: Vec2, v: Vec2): Vec2 {
  const den = cross(u, v);

  if (Math.abs(den) < EPS) {
    throw new Error("Lines are parallel or nearly parallel");
  }

  const t = cross(sub(b, a), v) / den;
  return add(a, mul(u, t));
}

/**
 * 折れ線 p0 -> p1 -> p2 の角における左右オフセット交点を求める。
 *
 * 左/右は「p0 → p1 に歩いた時の左 (left normal) / 右 (-left normal)」を指す。
 * 壁の軸が必ずしも中心線とは限らない（locationLine = FinishInterior の場合、
 * 軸は片面上にある）ため、左右それぞれの面までの距離を独立に受け取る。
 *
 * @param p0       前方の折れ線頂点
 * @param p1       角の頂点（結合点）
 * @param p2       後方の折れ線頂点
 * @param leftT0   セグメント p0→p1 の左側面までの距離
 * @param rightT0  セグメント p0→p1 の右側面までの距離
 * @param leftT1   セグメント p1→p2 の左側面までの距離
 * @param rightT1  セグメント p1→p2 の右側面までの距離
 */
function offsetPolylineCorner(
  p0: Vec2,
  p1: Vec2,
  p2: Vec2,
  leftT0: number,
  rightT0: number,
  leftT1: number,
  rightT1: number,
): OffsetCornerResult {
  const e0 = sub(p1, p0);
  const e1 = sub(p2, p1);

  const t0 = normalize(e0);
  const t1 = normalize(e1);

  const n0 = leftNormal(t0);
  const n1 = leftNormal(t1);

  const c = cross(e0, e1);

  if (Math.abs(c) < EPS) {
    throw new Error("p0, p1, p2 are collinear or nearly collinear");
  }

  // c > 0: 左折, c < 0: 右折
  const s = c > 0 ? 1 : -1;

  // 左側オフセット線の交点（+法線方向、距離 leftT）
  const aLeft = add(p0, mul(n0, leftT0));
  const bLeft = add(p1, mul(n1, leftT1));
  const leftPt = lineIntersection(aLeft, t0, bLeft, t1);

  // 右側オフセット線の交点（-法線方向、距離 rightT）
  const aRight = add(p0, mul(n0, -rightT0));
  const bRight = add(p1, mul(n1, -rightT1));
  const rightPt = lineIntersection(aRight, t0, bRight, t1);

  // 左折: 内側=左, 外側=右 / 右折: 内側=右, 外側=左
  return {
    inside: s > 0 ? leftPt : rightPt,
    outside: s > 0 ? rightPt : leftPt,
    turn: s > 0 ? "left" : "right",
  };
}

/**
 * 壁の locationLine から、軸を基準とした [左面距離, 右面距離] を返す。
 * 「左」は、壁の axis[0] → axis[1] を進行方向としたときの左手側。
 *
 * - Center / CoreCenter: 左右とも t/2（軸が中心）
 * - FinishInterior: 左=0 / 右=t（軸が左面 = 内側面）
 * - FinishExterior: 左=t / 右=0（軸が右面 = 外側面）
 */
function wallFaceOffsets(wall: WallElement): [number, number] {
  const t = wall.thickness;
  switch (wall.locationLine) {
    case "FinishInterior": return [0, t];
    case "FinishExterior": return [t, 0];
    case "Center":
    case "CoreCenter":
    default:
      return [t / 2, t / 2];
  }
}


/** Intersect two 2D lines. Returns parameter t on each line, or null if parallel. */
function lineLineIntersect(
    l1: Line2D, l2: Line2D,
): { t1: number; t2: number } | null {
    const denom = l1.dx * l2.dz - l1.dz * l2.dx;
    if (Math.abs(denom) < 1e-10) return null;
    const dpx = l2.px - l1.px;
    const dpz = l2.pz - l1.pz;
    const t1 = (dpx * l2.dz - dpz * l2.dx) / denom;
    const t2 = (dpx * l1.dz - dpz * l1.dx) / denom;
    return { t1, t2 };
}

function pointAt(line: Line2D, t: number): [number, number] {
    return [line.px + line.dx * t, line.pz + line.dz * t];
}

function pointToSegmentDist(
    px: number, pz: number,
    ax: number, az: number,
    bx: number, bz: number,
): { dist: number; t: number } {
    const dx = bx - ax;
    const dz = bz - az;
    const lenSq = dx * dx + dz * dz;
    let t = lenSq > 0 ? ((px - ax) * dx + (pz - az) * dz) / lenSq : 0;
    t = Math.max(0, Math.min(1, t));
    return { dist: Math.hypot(px - (ax + t * dx), pz - (az + t * dz)), t };
}

// ─── Wall line helpers ───

interface WallLines {
    axis: Line2D;
    left: Line2D;
    right: Line2D;
    nx: number; nz: number;
    halfT: number;
    len: number;
}

function getWallLines(wall: WallElement): WallLines {
    const [p1, p2] = wall.axis;
    const dx = p2[0] - p1[0];
    const dz = p2[2] - p1[2];
    const len = Math.sqrt(dx * dx + dz * dz) || 1;
    const dirX = dx / len;
    const dirZ = dz / len;
    const nx = -dirZ;
    const nz = dirX;
    const halfT = wall.thickness / 2;

    return {
        axis: { px: p1[0], pz: p1[2], dx, dz },
        left: { px: p1[0] + nx * halfT, pz: p1[2] + nz * halfT, dx, dz },
        right: { px: p1[0] - nx * halfT, pz: p1[2] - nz * halfT, dx, dz },
        nx, nz, halfT, len,
    };
}

// ─── Join detection ───

interface JoinCandidate {
    wallA: WallElement;
    wallB: WallElement;
    endA: "Start" | "End";
    endB: "Start" | "End";
    type: "miter" | "butt";
}

function detectJoins(walls: WallElement[]): JoinCandidate[] {
    const candidates: JoinCandidate[] = [];
    const seen = new Set<string>();

    for (let i = 0; i < walls.length; i++) {
        for (let j = i + 1; j < walls.length; j++) {
            const a = walls[i];
            const b = walls[j];

            // Check 4 endpoint pairs for miter (shared endpoint)
            for (const [ai, bi] of [[0, 0], [0, 1], [1, 0], [1, 1]] as [0|1, 0|1][]) {
                const endA: "Start"|"End" = ai === 0 ? "Start" : "End";
                const endB: "Start"|"End" = bi === 0 ? "Start" : "End";
                if (endA === "Start" && !a.joinStart) continue;
                if (endA === "End" && !a.joinEnd) continue;
                if (endB === "Start" && !b.joinStart) continue;
                if (endB === "End" && !b.joinEnd) continue;

                const pa = a.axis[ai];
                const pb = b.axis[bi];
                const dist = Math.hypot(pa[0] - pb[0], pa[2] - pb[2]);

                if (dist < TOLERANCE) {
                    const key = [a.id, endA, b.id, endB].sort().join("|");
                    if (!seen.has(key)) {
                        seen.add(key);
                        candidates.push({ wallA: a, wallB: b, endA, endB, type: "miter" });
                    }
                }
            }

            // T-join: endpoint of one on body of other
            for (const [wall, other, flip] of [[a, b, false], [b, a, true]] as const) {
                for (const ei of [0, 1] as const) {
                    const endLabel: "Start"|"End" = ei === 0 ? "Start" : "End";
                    if (endLabel === "Start" && !wall.joinStart) continue;
                    if (endLabel === "End" && !wall.joinEnd) continue;

                    const ep = wall.axis[ei];
                    const { dist, t } = pointToSegmentDist(
                        ep[0], ep[2],
                        other.axis[0][0], other.axis[0][2],
                        other.axis[1][0], other.axis[1][2],
                    );
                    if (dist < TOLERANCE && t > 0.01 && t < 0.99) {
                        const key = [wall.id, endLabel, other.id, "body"].sort().join("|");
                        if (!seen.has(key)) {
                            seen.add(key);
                            if (!flip) {
                                candidates.push({ wallA: a, wallB: b, endA: endLabel, endB: "Start", type: "butt" });
                            } else {
                                candidates.push({ wallA: b, wallB: a, endA: "Start", endB: endLabel, type: "butt" });
                            }
                        }
                    }
                }
            }
        }
    }

    return candidates;
}

// ─── Miter join ───
// Both walls share an endpoint. The two wall axes form a polyline
// p0 → p1 → p2 where p1 is the shared point. offsetPolylineCorner
// computes the left/right offset intersection at the corner, giving
// us the miter corners directly.

function resolveMiter(
    wallA: WallElement, endA: "Start" | "End",
    wallB: WallElement, endB: "Start" | "End",
    results: Map<string, WallJoinResult[]>,
): void {
    const axisA = wallA.axis;
    const axisB = wallB.axis;

    // Build polyline p0 → p1 → p2
    // p1 = shared junction point
    // p0 = far end of wallA, p2 = far end of wallB
    const joinIdxA = endA === "End" ? 1 : 0;
    const farIdxA  = endA === "End" ? 0 : 1;
    const farIdxB  = endB === "End" ? 0 : 1;

    const p0: Vec2 = { x: axisA[farIdxA][0],  y: axisA[farIdxA][2] };
    const p1: Vec2 = { x: axisA[joinIdxA][0], y: axisA[joinIdxA][2] };
    const p2: Vec2 = { x: axisB[farIdxB][0],  y: axisB[farIdxB][2] };

    // Per-wall left/right face distances in the wall's natural direction
    // (axis[0] → axis[1]). If the polyline traverses a wall in reverse,
    // polyline-left corresponds to the wall's right face (and vice versa),
    // so we swap the pair before passing to offsetPolylineCorner.
    const [lA, rA] = wallFaceOffsets(wallA);
    const [lB, rB] = wallFaceOffsets(wallB);
    const polyLeftA0  = endA === "Start" ? rA : lA;
    const polyRightA0 = endA === "Start" ? lA : rA;
    const polyLeftB1  = endB === "End"   ? rB : lB;
    const polyRightB1 = endB === "End"   ? lB : rB;

    let result: OffsetCornerResult;
    try {
        result = offsetPolylineCorner(
            p0, p1, p2,
            polyLeftA0, polyRightA0,
            polyLeftB1, polyRightB1,
        );
    } catch {
        // Collinear walls — no miter needed
        return;
    }

    // offsetPolylineCorner returns inside/outside based on turn direction.
    // We need to map back to wall-left / wall-right for each wall.
    //
    // Polyline direction at p0→p1:
    //   endA="End"  → same as wall A natural direction → polyline-left = wall-left
    //   endA="Start"→ reversed from wall A direction   → polyline-left = wall-RIGHT
    //
    // Similarly for p1→p2:
    //   endB="Start"→ same as wall B natural direction → polyline-left = wall-left
    //   endB="End"  → reversed from wall B direction   → polyline-left = wall-RIGHT
    //
    // Turn mapping:
    //   left turn:  inside = polyline-left,  outside = polyline-right
    //   right turn: inside = polyline-right, outside = polyline-left

    const isLeft = result.turn === "left";
    const polylineLeft  = isLeft ? result.inside : result.outside;
    const polylineRight = isLeft ? result.outside : result.inside;

    // Wall A: polyline direction is reversed when endA="Start"
    const flipA = endA === "Start";
    const wallALeft  = flipA ? polylineRight : polylineLeft;
    const wallARight = flipA ? polylineLeft  : polylineRight;

    const baseYA = wallA.axis[0][1] + wallA.baseOffset;
    addResult(results, wallA.id as string, {
        wallId: wallA.id as string,
        at: endA,
        corners: [
            [wallALeft.x,  baseYA, wallALeft.y],
            [wallARight.x, baseYA, wallARight.y],
        ],
    });

    // Wall B: polyline direction is reversed when endB="End"
    const flipB = endB === "End";
    const wallBLeft  = flipB ? polylineRight : polylineLeft;
    const wallBRight = flipB ? polylineLeft  : polylineRight;

    const baseYB = wallB.axis[0][1] + wallB.baseOffset;
    addResult(results, wallB.id as string, {
        wallId: wallB.id as string,
        at: endB,
        corners: [
            [wallBLeft.x,  baseYB, wallBLeft.y],
            [wallBRight.x, baseYB, wallBRight.y],
        ],
    });
}

// ─── Butt / T-join ───

function resolveButt(
    wallA: WallElement, endA: "Start" | "End",
    wallB: WallElement,
    results: Map<string, WallJoinResult[]>,
): void {
    const lA = getWallLines(wallA);
    const lB = getWallLines(wallB);

    // Wall A approaches wall B. Trim/extend A's offset lines to B's face lines.
    const aDir = endA === "End" ? 1 : -1;

    // For each side of A (left, right), intersect with both sides of B
    // and pick the one in the forward direction that is closest.
    const findTrim = (aLine: Line2D): [number, number] | null => {
        const hits: { t: number; pt: [number, number] }[] = [];
        for (const bLine of [lB.left, lB.right]) {
            const h = lineLineIntersect(aLine, bLine);
            if (h && h.t1 * aDir >= -0.1 * lA.len) {
                hits.push({ t: h.t1, pt: pointAt(aLine, h.t1) });
            }
        }
        if (hits.length === 0) return null;
        // Pick the hit closest to the wall end in the forward direction
        hits.sort((a, b) => Math.abs(a.t * aDir) - Math.abs(b.t * aDir));
        return hits[0].pt;
    };

    const ptLeft = findTrim(lA.left);
    const ptRight = findTrim(lA.right);
    if (!ptLeft || !ptRight) return;

    const baseY = wallA.axis[0][1] + wallA.baseOffset;
    addResult(results, wallA.id as string, {
        wallId: wallA.id as string,
        at: endA,
        corners: [
            [ptLeft[0], baseY, ptLeft[1]],
            [ptRight[0], baseY, ptRight[1]],
        ],
    });
}

// ─── Helpers ───

function addResult(map: Map<string, WallJoinResult[]>, wallId: string, result: WallJoinResult): void {
    let arr = map.get(wallId);
    if (!arr) { arr = []; map.set(wallId, arr); }
    const existing = arr.findIndex(r => r.at === result.at);
    if (existing >= 0) arr[existing] = result;
    else arr.push(result);
}

// ─── Junction-cluster resolution ───
// Walls produced by 全壁生成 (bulk regenerate) routinely have 3+ walls
// meeting at a single endpoint — a collinear chain (e.g., the upper /
// shared / lower sub-segments of a split right edge) plus a perpendicular
// wall butting onto it from a side room. Resolving such a junction one
// pair at a time produces conflicting corner overrides and visible
// overlap blocks at the corner.
//
// Approach: cluster every joinable wall endpoint by 2D position. For each
// cluster:
//   * single direction group  → all collinear; mark joined, no corner
//                                override (cap suppressed, walls flow flat)
//   * two direction groups    → for any group with ≥ 2 ends (a collinear
//                                chain), its members are flat-joined; ends
//                                in the OTHER group are T-junction butts
//                                trimmed to the chain's face. Pure 1-vs-1
//                                falls back to the classic 2-way miter.
//   * 3+ direction groups     → rare; fall back to pairwise miter.

interface WallEnd {
    wall: WallElement;
    end: "Start" | "End";
    pos: [number, number];   // (x, z) in the floor plane
    /** Unit vector pointing FROM the endpoint INTO the wall's body. */
    inDir: [number, number];
}

function collectWallEnds(walls: WallElement[]): WallEnd[] {
    const ends: WallEnd[] = [];
    for (const w of walls) {
        const [a0, a1] = w.axis;
        const dx = a1[0] - a0[0], dz = a1[2] - a0[2];
        const len = Math.hypot(dx, dz);
        if (len < 1e-9) continue;
        const ux = dx / len, uz = dz / len;
        if (w.joinStart) ends.push({ wall: w, end: "Start", pos: [a0[0], a0[2]], inDir: [ux, uz] });
        if (w.joinEnd)   ends.push({ wall: w, end: "End",   pos: [a1[0], a1[2]], inDir: [-ux, -uz] });
    }
    return ends;
}

function clusterEndsByPosition(ends: WallEnd[]): WallEnd[][] {
    const clusters: WallEnd[][] = [];
    for (const e of ends) {
        let placed = false;
        for (const c of clusters) {
            const ref = c[0];
            if (Math.hypot(e.pos[0] - ref.pos[0], e.pos[1] - ref.pos[1]) < TOLERANCE) {
                c.push(e);
                placed = true;
                break;
            }
        }
        if (!placed) clusters.push([e]);
    }
    return clusters;
}

const PARALLEL_DOT = Math.cos((2 * Math.PI) / 180); // 2° tolerance

function groupEndsByDirection(cluster: WallEnd[]): WallEnd[][] {
    const groups: WallEnd[][] = [];
    for (const e of cluster) {
        let placed = false;
        for (const g of groups) {
            const ref = g[0];
            const dot = e.inDir[0] * ref.inDir[0] + e.inDir[1] * ref.inDir[1];
            if (Math.abs(dot) >= PARALLEL_DOT) {
                g.push(e);
                placed = true;
                break;
            }
        }
        if (!placed) groups.push([e]);
    }
    return groups;
}

function markJoinedNoCorners(
    results: Map<string, WallJoinResult[]>,
    e: WallEnd,
): void {
    addResult(results, e.wall.id as string, {
        wallId: e.wall.id as string,
        at: e.end,
    });
}

/**
 * Cluster T-junction trim. The chain (≥ 2 collinear walls) and a
 * cross-direction wall meet at the same vertex `e.pos`. We trim `e`'s end
 * to the chain's near face (junction + half_chain * inDir of the cross
 * wall) and emit flat corners perpendicular to the cross wall's axis.
 *
 * `chainHalfThickness` is the chain wall's half-thickness — chain and cross
 * walls may differ in thickness, so we use the chain's value here.
 * `wall.thickness / 2` is used for the perpendicular offsets to the cross
 * wall's own corners.
 */
function trimToChainFace(
    e: WallEnd,
    chainHalfThickness: number,
    results: Map<string, WallJoinResult[]>,
): void {
    const wall = e.wall;
    const halfB = wall.thickness / 2;
    // Endpoint pushed inward along the wall by the chain's half-thickness so
    // the cross wall stops at the chain face, not at the chain centerline.
    const cap: [number, number] = [
        e.pos[0] + e.inDir[0] * chainHalfThickness,
        e.pos[1] + e.inDir[1] * chainHalfThickness,
    ];
    // Wall's left normal = rotate inDir 90° CCW, but inDir points INTO the
    // wall; the wall axis natural direction (axis[0] → axis[1]) is +inDir at
    // Start and −inDir at End. The footprint normal n = (-dirZ, dirX) follows
    // the natural direction. Reproduce that orientation here so left/right
    // match WallGeometryBuilder's expectations.
    const sign = e.end === "Start" ? 1 : -1;
    const dirX = e.inDir[0] * sign;
    const dirZ = e.inDir[1] * sign;
    const nx = -dirZ;
    const nz = dirX;
    const left: Vec3 = [cap[0] + nx * halfB, wall.axis[0][1] + wall.baseOffset, cap[1] + nz * halfB];
    const right: Vec3 = [cap[0] - nx * halfB, wall.axis[0][1] + wall.baseOffset, cap[1] - nz * halfB];
    addResult(results, wall.id as string, {
        wallId: wall.id as string,
        at: e.end,
        corners: [left, right],
    });
}

// ─── Public API ───

export class WallJoinResolver {
    public static resolve(walls: WallElement[]): Map<string, WallJoinResult[]> {
        const results = new Map<string, WallJoinResult[]>();
        if (walls.length < 2) return results;

        // ── (1) Endpoint-clustered resolution ─────────────────────────────
        const ends = collectWallEnds(walls);
        const clusters = clusterEndsByPosition(ends);
        const handledEnds = new Set<string>(); // "wallId|end"
        const markHandled = (e: WallEnd) =>
            handledEnds.add(`${e.wall.id}|${e.end}`);

        for (const cluster of clusters) {
            if (cluster.length < 2) continue;
            const dirGroups = groupEndsByDirection(cluster);

            if (dirGroups.length === 1) {
                // All collinear at this point → flat continuation.
                for (const e of cluster) { markJoinedNoCorners(results, e); markHandled(e); }
                continue;
            }

            if (dirGroups.length === 2) {
                const [gA, gB] = dirGroups;
                const chainA = gA.length >= 2;
                const chainB = gB.length >= 2;

                if (gA.length === 1 && gB.length === 1) {
                    // Pure 2-way miter — preserves the original behaviour.
                    resolveMiter(gA[0].wall, gA[0].end, gB[0].wall, gB[0].end, results);
                    markHandled(gA[0]); markHandled(gB[0]);
                } else {
                    // Collinear chain on at least one side. Chain members are
                    // flat-joined; cross-direction ends are trimmed to the
                    // chain's near face via trimToChainFace (resolveButt's
                    // tie-breaker doesn't reliably pick the correct face when
                    // the cross wall's endpoint is exactly on the chain axis).
                    if (chainA) for (const e of gA) { markJoinedNoCorners(results, e); markHandled(e); }
                    if (chainB) for (const e of gB) { markJoinedNoCorners(results, e); markHandled(e); }
                    if (chainA) {
                        const chainHalf = gA[0].wall.thickness / 2;
                        for (const e of gB) {
                            trimToChainFace(e, chainHalf, results);
                            markHandled(e);
                        }
                    }
                    if (chainB) {
                        const chainHalf = gB[0].wall.thickness / 2;
                        for (const e of gA) {
                            trimToChainFace(e, chainHalf, results);
                            markHandled(e);
                        }
                    }
                }
                continue;
            }

            // 3+ direction groups (non-orthogonal star) → pairwise miter.
            for (let i = 0; i < cluster.length; i++) {
                for (let j = i + 1; j < cluster.length; j++) {
                    resolveMiter(
                        cluster[i].wall, cluster[i].end,
                        cluster[j].wall, cluster[j].end,
                        results,
                    );
                }
                markHandled(cluster[i]);
            }
        }

        // ── (2) Endpoint-on-body T-joins (only for ends not yet handled) ──
        // Picks up cases where one wall's endpoint lands mid-axis of another.
        for (const cand of detectJoins(walls)) {
            if (cand.type !== "butt") continue;
            const key = `${cand.wallA.id}|${cand.endA}`;
            if (handledEnds.has(key)) continue;
            resolveButt(cand.wallA, cand.endA, cand.wallB, results);
        }

        return results;
    }
}
