// 2D 幾何拘束ソルバ — planegcs (FreeCAD GCS) バックエンド
//
// 対象は Space.polygons の各外周頂点 / 辺。すべてのポリゴンは一般の N 角形と
// して扱い、軸平行性などの形状特性は **暗黙的には強制しない**。矩形ツールで
// 作図された 4 頂点ポリゴンも、ユーザに見える Horizontal / Parallel 等の拘束
// によってその形状を維持する。
//
// pinning 戦略: いかなる頂点も `fixed: true` にしない。GCS は初期値に近い解
// を返すため、ドラッグ後は新しい位置が初期値となり、過拘束でなければそのまま
// 維持される。これにより異ポリゴン間の Coincident / PointOnGrid なども自然に
// 動作する。

import { useAppState } from "../application/AppState";
import { SpaceElement, RoomPolygon, polygonEdges } from "../model/elements/SpaceElement";
import { Constraint, ConstraintTarget } from "../model/constraint/Constraint";
import { GridLine } from "../model/grid/GridLine";
import { ColumnElement } from "../model/elements/ColumnElement";
import { WallElement } from "../model/elements/WallElement";
import { Vec2 } from "../geometry/math/Vec2";
import { Vec3 } from "../geometry/math/Vec3";
import { computeMiteredCorners, computeMiteredWallAxes, syncWallsToPolygonOuter } from "../ui/room/wallSync";
import { GcsBackend } from "./GcsBackend";

type OID = number;

interface PolyIds {
    points: OID[];               // outer vertex ids (length = outer.length)
    lines: OID[];                // edge ids in polygon edge order (length = polygonEdges(poly).length)
    edgeVerts: [number, number][]; // per edge, vertex indices into `points`
}

interface CircleIds {
    centerPoint: OID;
    circle: OID;
}

interface WallAxisIds {
    p1: OID; // axis[0] as 2D point
    p2: OID; // axis[1] as 2D point
    line: OID;
}

// ----- concurrency guard (re-entrance prevention) -----
let solvingDepth = 0;

// ----- solve runner -----
let running = false;
let pendingResolveRequested = false;

/**
 * Run the constraint solver against the current AppState and write back the
 * resulting polygon vertex coordinates. Called whenever polygons or constraints
 * change (via AppState hooks).
 *
 * Because planegcs is async (WASM), multiple concurrent requests are collapsed:
 * if a solve is already running, a new request is queued to run once.
 */
export function runSketchSolver(): void {
    if (solvingDepth > 0) return;
    if (running) {
        pendingResolveRequested = true;
        return;
    }
    running = true;
    void (async () => {
        try {
            await solveOnce();
            while (pendingResolveRequested) {
                pendingResolveRequested = false;
                await solveOnce();
            }
        } catch (e) {
            // eslint-disable-next-line no-console
            console.warn("[SketchSolver] failed:", e);
        } finally {
            running = false;
        }
    })();
}

async function solveOnce(): Promise<void> {
    const state = useAppState.getState();
    const constraints = Object.values(state.constraints);
    const dragHint = state.solverDragHint;
    if (constraints.length === 0) return;

    // Collect all polygons (non-circle), circles, and wall axes targeted by
    // any constraint.
    const polys = new Map<string, { spaceId: string; poly: RoomPolygon }>();
    const circles = new Map<string, { spaceId: string; poly: RoomPolygon }>();
    const walls = new Map<string, { wall: WallElement }>();
    for (const c of constraints) {
        for (const t of c.targets) {
            if (t.kind === "SketchPoint" || t.kind === "SketchEdge" || t.kind === "SketchCircle") {
                const key = `${t.spaceId}:${t.polyId}`;
                const space = state.elements[t.spaceId as string] as SpaceElement | undefined;
                if (!space || space.type !== "Space") continue;
                const poly = space.polygons?.find((p) => p.id === t.polyId);
                if (!poly) continue;
                if (poly.shape?.type === "circle" && t.kind === "SketchCircle") {
                    if (!circles.has(key)) circles.set(key, { spaceId: t.spaceId as string, poly });
                } else if (t.kind !== "SketchCircle") {
                    if (!polys.has(key)) polys.set(key, { spaceId: t.spaceId as string, poly });
                }
            } else if (t.kind === "WallAxis" || t.kind === "WallAxisPoint") {
                const wid = t.wallId as string;
                if (walls.has(wid)) continue;
                const wall = state.elements[wid] as WallElement | undefined;
                if (!wall || wall.type !== "Wall") continue;
                walls.set(wid, { wall });
            }
        }
    }
    // Always include wall-outline polygons, regardless of whether any
    // constraint references them. Outlines are derived from their inner
    // polygon + thickness, and we use the solver pass to snap them back
    // after the UI / drag handler has moved them. Also collect outline ids
    // so we can skip any existing constraint referencing them (legacy rect
    // wall data carries Parallel / PerpDistance that would conflict with
    // the fixed-outline strategy).
    const outlinePolyIds = new Set<string>();
    for (const el of Object.values(state.elements)) {
        const sp = el as SpaceElement;
        if (!sp || sp.type !== "Space" || !sp.polygons) continue;
        for (const p of sp.polygons) {
            if (!p.wallOutlineOf) continue;
            outlinePolyIds.add(p.id);
            const key = `${sp.id}:${p.id}`;
            if (!polys.has(key)) polys.set(key, { spaceId: sp.id, poly: p });
        }
    }

    if (polys.size === 0 && circles.size === 0 && walls.size === 0) return;

    // Build reverse index: wall.id → owning polygon (if any).
    // A wall is "owned" when it appears in some RoomPolygon.wallIds. For owned
    // walls we externally re-derive the axis from the polygon's outer ring
    // (applying dragHint) and push the endpoints as fixed primitives — the
    // solver therefore cannot drift walls out of their thickness offset from
    // the polygon. See Approach 2 in docs/… .
    type WallOwner = { spaceId: string; poly: RoomPolygon; edgeIdx: number };
    const wallOwnership = new Map<string, WallOwner>();
    for (const el of Object.values(state.elements)) {
        const sp = el as SpaceElement;
        if (!sp || sp.type !== "Space" || !sp.polygons) continue;
        for (const p of sp.polygons) {
            if (!p.wallIds) continue;
            for (let i = 0; i < p.wallIds.length; i++) {
                const wid = p.wallIds[i];
                if (wid) wallOwnership.set(wid, { spaceId: sp.id, poly: p, edgeIdx: i });
            }
        }
    }

    // Pre-compute mitered wall axes per polygon, applying dragHint to a single
    // vertex if it matches. Cached by spaceId:polyId. Returns null when the
    // polygon isn't wall-capable (no wallIds, mismatched lengths, no thickness).
    const computedAxesByPoly = new Map<string, [Vec3, Vec3][]>();
    const ensureAxes = (spaceId: string, poly: RoomPolygon): [Vec3, Vec3][] | null => {
        if (!poly.wallIds || poly.wallThickness == null) return null;
        if (poly.wallIds.length !== poly.outer.length) return null;
        const key = `${spaceId}:${poly.id}`;
        const cached = computedAxesByPoly.get(key);
        if (cached) return cached;
        const effective: Vec2[] = poly.outer.map((v, i) => {
            if (dragHint &&
                dragHint.spaceId === spaceId &&
                dragHint.polyId === poly.id &&
                dragHint.vertexIdx === i
            ) return [dragHint.x, dragHint.y];
            return [v[0], v[1]];
        });
        let cx = 0, cy = 0;
        for (const p of effective) { cx += p[0]; cy += p[1]; }
        cx /= effective.length; cy /= effective.length;
        const axes = computeMiteredWallAxes(effective, [cx, cy], poly.wallThickness / 2);
        computedAxesByPoly.set(key, axes);
        return axes;
    };

    const wrapper = await GcsBackend.makeWrapper();
    try {
        const idAlloc = new IdAllocator();
        const polyIds = new Map<string, PolyIds>();
        const circleIds = new Map<string, CircleIds>();
        const wallIds = new Map<string, WallAxisIds>();
        const fixedWallIds = new Set<string>(); // walls pushed as fixed (owned)
        const primitives: any[] = [];

        // ── Push polygons as N points + N lines (no implicit constraints) ──
        // If a drag hint is set, the matching vertex is pushed as `fixed: true`
        // at the drag-target xy. The solver then keeps that vertex anchored and
        // adjusts the other vertices around it (SolidWorks-style drag feel).
        // If the dragged vertex participates in a constraint that cannot be
        // satisfied while it's pinned (PointOnCircle / Tangent / PointOnGrid
        // etc.), fall back to using the cursor as the *initial guess* rather
        // than a fixed pin. The solver then snaps the point onto the curve.
        const dragVertexHasCurveConstraint = (() => {
            if (!dragHint) return false;
            for (const c of constraints) {
                if (c.type !== "PointOnCircle" && c.type !== "PointOnGrid") continue;
                for (const t of c.targets) {
                    if (t.kind === "SketchPoint"
                        && t.spaceId === dragHint.spaceId
                        && t.polyId === dragHint.polyId
                        && t.vertexIdx === dragHint.vertexIdx) return true;
                }
            }
            return false;
        })();

        // Derive an outline polygon's outer from its inner (with any dragHint
        // on the inner applied). Returns null when the inner is missing or
        // not wall-capable — caller then falls back to the outline's stored
        // outer (rare; stale data).
        const deriveOutlineOuter = (spaceId: string, outlinePoly: RoomPolygon): Vec2[] | null => {
            const innerId = outlinePoly.wallOutlineOf;
            if (!innerId) return null;
            const sp = state.elements[spaceId] as SpaceElement | undefined;
            if (!sp || sp.type !== "Space") return null;
            const inner = sp.polygons?.find((p) => p.id === innerId);
            if (!inner || inner.wallThickness == null || inner.outer.length < 3) return null;
            const innerEffective: Vec2[] = inner.outer.map((v, i) => {
                if (dragHint &&
                    dragHint.spaceId === spaceId &&
                    dragHint.polyId === inner.id &&
                    dragHint.vertexIdx === i
                ) return [dragHint.x, dragHint.y];
                return [v[0], v[1]];
            });
            let cx = 0, cy = 0;
            for (const v of innerEffective) { cx += v[0]; cy += v[1]; }
            cx /= innerEffective.length; cy /= innerEffective.length;
            return computeMiteredCorners(innerEffective, [cx, cy], inner.wallThickness);
        };

        for (const [key, entry] of polys) {
            const isOutline = !!entry.poly.wallOutlineOf;
            const outer: Vec2[] = isOutline
                ? (deriveOutlineOuter(entry.spaceId, entry.poly) ?? entry.poly.outer)
                : entry.poly.outer;
            const n = outer.length;
            const pIds: OID[] = [];
            for (let i = 0; i < n; i++) {
                const pid = idAlloc.next();
                pIds.push(pid);
                if (isOutline) {
                    primitives.push({
                        type: "point",
                        id: String(pid),
                        x: outer[i][0],
                        y: outer[i][1],
                        fixed: true,
                    });
                    continue;
                }
                const isDragMatch =
                    dragHint != null &&
                    dragHint.spaceId === entry.spaceId &&
                    dragHint.polyId === entry.poly.id &&
                    dragHint.vertexIdx === i;
                const isDragPin = isDragMatch && !dragVertexHasCurveConstraint;
                primitives.push({
                    type: "point",
                    id: String(pid),
                    x: isDragMatch ? dragHint.x : outer[i][0],
                    y: isDragMatch ? dragHint.y : outer[i][1],
                    fixed: isDragPin,
                });
            }
            const lIds: OID[] = [];
            const polyEdgeList = polygonEdges(entry.poly);
            const edgeVerts: [number, number][] = [];
            for (const [va, vb] of polyEdgeList) {
                const a = pIds[va];
                const b = pIds[vb];
                const lid = idAlloc.next();
                lIds.push(lid);
                edgeVerts.push([va, vb]);
                primitives.push({ type: "line", id: String(lid), p1_id: String(a), p2_id: String(b) });
            }
            polyIds.set(key, { points: pIds, lines: lIds, edgeVerts });
        }

        // ── Group concentric circles via union-find so each group shares a
        // single center-point primitive. This hard-wires concentricity at the
        // geometry level — the solver cannot drift the centers apart.
        const parent = new Map<string, string>();
        const find = (x: string): string => {
            if (!parent.has(x)) parent.set(x, x);
            const p = parent.get(x)!;
            if (p === x) return x;
            const r = find(p);
            parent.set(x, r);
            return r;
        };
        const unionKeys = (a: string, b: string) => {
            const ra = find(a), rb = find(b);
            if (ra !== rb) parent.set(ra, rb);
        };
        for (const c of constraints) {
            if (c.type !== "ConcentricCircle") continue;
            const cts = c.targets.filter((t) => t.kind === "SketchCircle");
            for (let i = 1; i < cts.length; i++) {
                unionKeys(
                    `${cts[0].spaceId}:${cts[0].polyId}`,
                    `${cts[i].spaceId}:${cts[i].polyId}`,
                );
            }
        }

        // ── Push circles as (center point + circle primitive); concentric
        //    groups share one center OID.
        const sharedCenter = new Map<string, OID>(); // union-root → center OID
        for (const [key, entry] of circles) {
            const shape = entry.poly.shape;
            if (!shape || shape.type !== "circle") continue;
            const root = find(key);
            let centerId = sharedCenter.get(root);
            if (centerId === undefined) {
                centerId = idAlloc.next();
                primitives.push({
                    type: "point",
                    id: String(centerId),
                    x: shape.center[0],
                    y: shape.center[1],
                    fixed: false,
                });
                sharedCenter.set(root, centerId);
            }
            const circleId = idAlloc.next();
            primitives.push({
                type: "circle",
                id: String(circleId),
                c_id: String(centerId),
                radius: shape.radius,
            });
            circleIds.set(key, { centerPoint: centerId, circle: circleId });
        }

        // ── Push wall axes as 2 points + 1 line ──
        // Owned walls (polygon.wallIds) use externally mitered coords with
        // fixed:true so the solver cannot break the thickness-offset invariant
        // against the inner polygon. Standalone walls stay unpinned.
        // Axis[0] / axis[1] go in as (x, z) since sketch is in the XZ plane.
        for (const [wid, entry] of walls) {
            const owner = wallOwnership.get(wid);
            let a: Vec3 = entry.wall.axis[0];
            let b: Vec3 = entry.wall.axis[1];
            let fixed = false;
            if (owner) {
                const axes = ensureAxes(owner.spaceId, owner.poly);
                if (axes && owner.edgeIdx < axes.length) {
                    a = axes[owner.edgeIdx][0];
                    b = axes[owner.edgeIdx][1];
                    fixed = true;
                    fixedWallIds.add(wid);
                }
            }
            const p1 = idAlloc.next();
            const p2 = idAlloc.next();
            const line = idAlloc.next();
            primitives.push({ type: "point", id: String(p1), x: a[0], y: a[2], fixed });
            primitives.push({ type: "point", id: String(p2), x: b[0], y: b[2], fixed });
            primitives.push({ type: "line", id: String(line), p1_id: String(p1), p2_id: String(p2) });
            wallIds.set(wid, { p1, p2, line });
        }

        // ── Translate and push user constraints ──
        // Outline polygons are derived + fixed. Only the legacy rect-wall
        // auto-added links (Parallel / PerpDistance between an outline and
        // its own inner) are skipped — they would fight the derived offset.
        // User-added constraints (Coincident, PointOnGrid, etc.) still
        // apply: because outline vertices go into the solver as fixed
        // primitives, they act as anchors that other polygons snap to.
        const isLegacyOutlineLink = (c: Constraint): boolean => {
            if (c.type !== "Parallel" && c.type !== "PerpDistance") return false;
            return c.targets.some((t) => {
                const tt = t as any;
                if (t.kind !== "SketchEdge" && t.kind !== "SketchPoint") return false;
                return outlinePolyIds.has(tt.polyId);
            });
        };
        for (const c of constraints) {
            if (isLegacyOutlineLink(c)) continue;
            const gcsPrimitives = translateConstraint(c, polyIds, circleIds, wallIds, idAlloc, state.grids, state.elements as any);
            for (const p of gcsPrimitives) primitives.push(p);
        }

        wrapper.push_primitives_and_params(primitives);
        const status = wrapper.solve();

        // SolveStatus: 0=Success, 1=Converged, 2=Failed, 3=SuccessfulSolutionInvalid
        // Only write back when the solver produced a valid solution. On failure
        // we leave the polygons untouched — better than committing a corrupted
        // shape that would force the user to undo.
        if (status !== 0 && status !== 1) {
            // eslint-disable-next-line no-console
            console.warn(`[SketchSolver] solve status=${status} (failed) — skipping writeback`);
            return;
        }

        wrapper.apply_solution();

        // eslint-disable-next-line no-console
        console.log(`[SketchSolver] solve status=${status} constraints=${constraints.length} polys=${polys.size}`);

        // ── Read back polygon outer vertices + circle shapes ──
        solvingDepth++;
        try {
            // Batch per-space updates so that multiple polygons / circles in the
            // same room don't clobber each other via stale-state overwrites.
            const CIRCLE_TESS = 128;
            const perSpaceUpdates = new Map<string, Map<string, Partial<RoomPolygon>>>();
            const dirty = (spaceId: string, polyId: string, patch: Partial<RoomPolygon>) => {
                let bucket = perSpaceUpdates.get(spaceId);
                if (!bucket) { bucket = new Map(); perSpaceUpdates.set(spaceId, bucket); }
                const cur = bucket.get(polyId) ?? {};
                bucket.set(polyId, { ...cur, ...patch });
            };

            for (const [key, entry] of polys) {
                const ids = polyIds.get(key);
                if (!ids) continue;
                const solved: Vec2[] = ids.points.map((pid) => {
                    const prim = wrapper.sketch_index.get_primitive_or_fail(String(pid)) as any;
                    return [prim.x as number, prim.y as number];
                });
                let changed = solved.length !== entry.poly.outer.length;
                if (!changed) {
                    for (let i = 0; i < solved.length; i++) {
                        if (Math.abs(solved[i][0] - entry.poly.outer[i][0]) > 1e-6 ||
                            Math.abs(solved[i][1] - entry.poly.outer[i][1]) > 1e-6) {
                            changed = true;
                            break;
                        }
                    }
                }
                if (!changed) continue;
                dirty(entry.spaceId, entry.poly.id, { outer: solved });
            }

            for (const [key, entry] of circles) {
                const ids = circleIds.get(key);
                const shape = entry.poly.shape;
                if (!ids || !shape || shape.type !== "circle") continue;
                const cp = wrapper.sketch_index.get_primitive_or_fail(String(ids.centerPoint)) as any;
                const circle = wrapper.sketch_index.get_primitive_or_fail(String(ids.circle)) as any;
                const cx = cp.x as number, cy = cp.y as number, r = circle.radius as number;
                const dCenter = Math.hypot(cx - shape.center[0], cy - shape.center[1]);
                const dRadius = Math.abs(r - shape.radius);
                if (dCenter < 1e-6 && dRadius < 1e-6) continue;
                const newOuter: Vec2[] = [];
                for (let i = 0; i < CIRCLE_TESS; i++) {
                    const a = (i / CIRCLE_TESS) * Math.PI * 2;
                    newOuter.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
                }
                dirty(entry.spaceId, entry.poly.id, {
                    outer: newOuter,
                    shape: { type: "circle", center: [cx, cy] as Vec2, radius: r },
                });
            }

            // Apply batched updates — re-read space each time so we see prior
            // updates from this same batch. Each polygon that owns walls gets
            // its wall axes re-synced from the post-solve outer ring, so the
            // solver moving the inner ring (e.g. via PointOnGrid snapping)
            // cannot strand walls at stale offsets. Works for any vertex count.
            for (const [spaceId, bucket] of perSpaceUpdates) {
                const latest = useAppState.getState().elements[spaceId] as SpaceElement | undefined;
                if (!latest) continue;
                let newPolys = latest.polygons.map((p) => {
                    const patch = bucket.get(p.id);
                    return patch ? { ...p, ...patch } : p;
                });
                // Re-derive outline polygons from their (now-updated) inner
                // so the outer outline tracks solver-driven inner motion.
                newPolys = newPolys.map((p) => {
                    if (!p.wallOutlineOf) return p;
                    const inner = newPolys.find((q) => q.id === p.wallOutlineOf);
                    if (!inner || inner.wallThickness == null || inner.outer.length < 3) return p;
                    let cx = 0, cy = 0;
                    for (const v of inner.outer) { cx += v[0]; cy += v[1]; }
                    cx /= inner.outer.length; cy /= inner.outer.length;
                    const derived = computeMiteredCorners(inner.outer, [cx, cy], inner.wallThickness);
                    return { ...p, outer: derived };
                });
                useAppState.getState().updateElement(spaceId, {
                    polygons: newPolys,
                    dirtyFlags: new Set([...latest.dirtyFlags, "Geometry", "Mesh", "Render"]),
                } as any);

                for (const polyId of bucket.keys()) {
                    const updated = newPolys.find((p) => p.id === polyId);
                    if (!updated || !updated.wallIds || updated.wallThickness == null) continue;
                    syncWallsToPolygonOuter(
                        updated.outer,
                        updated.wallIds,
                        updated.wallThickness,
                        (wallId, axis) => {
                            const w = useAppState.getState().elements[wallId] as WallElement | undefined;
                            if (!w || w.type !== "Wall") return;
                            // Preserve Y component from the existing axis.
                            const next: [Vec3, Vec3] = [
                                [axis[0][0], w.axis[0][1], axis[0][2]],
                                [axis[1][0], w.axis[1][1], axis[1][2]],
                            ];
                            const drift =
                                Math.abs(next[0][0] - w.axis[0][0]) + Math.abs(next[0][2] - w.axis[0][2]) +
                                Math.abs(next[1][0] - w.axis[1][0]) + Math.abs(next[1][2] - w.axis[1][2]);
                            if (drift < 1e-6) return;
                            useAppState.getState().updateElement(wallId, {
                                axis: next,
                                dirtyFlags: new Set([...(w.dirtyFlags ?? []), "Geometry", "Mesh", "Render"]),
                            } as any);
                        },
                    );
                }
            }

            // Wall-axis write-back — standalone walls only. Owned walls were
            // pushed as fixed and are re-synced from their polygon above.
            for (const [wid, ids] of wallIds) {
                if (fixedWallIds.has(wid)) continue;
                const latest = useAppState.getState().elements[wid] as WallElement | undefined;
                if (!latest || latest.type !== "Wall") continue;
                const p1 = wrapper.sketch_index.get_primitive_or_fail(String(ids.p1)) as any;
                const p2 = wrapper.sketch_index.get_primitive_or_fail(String(ids.p2)) as any;
                const ax: [number, number, number] = [p1.x as number, latest.axis[0][1], p1.y as number];
                const bx: [number, number, number] = [p2.x as number, latest.axis[1][1], p2.y as number];
                const dx0 = Math.abs(ax[0] - latest.axis[0][0]) + Math.abs(ax[2] - latest.axis[0][2]);
                const dx1 = Math.abs(bx[0] - latest.axis[1][0]) + Math.abs(bx[2] - latest.axis[1][2]);
                if (dx0 + dx1 < 1e-6) continue;
                useAppState.getState().updateElement(wid, {
                    axis: [ax, bx],
                    dirtyFlags: new Set([...(latest.dirtyFlags ?? []), "Geometry", "Mesh", "Render"]),
                } as any);
            }
        } finally {
            solvingDepth--;
        }
    } finally {
        wrapper.destroy_gcs_module();
    }
}

// ----- constraint translation -----

function translateConstraint(
    c: Constraint,
    polyIds: Map<string, PolyIds>,
    circleIds: Map<string, CircleIds>,
    wallIds: Map<string, WallAxisIds>,
    idAlloc: IdAllocator,
    grids: GridLine[],
    elements: Record<string, any>,
): any[] {
    const out: any[] = [];

    const pointIdFor = (t: ConstraintTarget): number | null => {
        if (t.kind === "SketchPoint") {
            const ids = polyIds.get(`${t.spaceId}:${t.polyId}`);
            if (!ids) return null;
            if (t.vertexIdx < 0 || t.vertexIdx >= ids.points.length) return null;
            return ids.points[t.vertexIdx];
        }
        if (t.kind === "WallAxisPoint") {
            const ids = wallIds.get(t.wallId as string);
            if (!ids) return null;
            return t.endIdx === 0 ? ids.p1 : ids.p2;
        }
        return null;
    };
    // SketchEdge and WallAxis both collapse to the same (line, p1, p2) bundle
    // since wall axes are pushed as a 2-vertex line primitive in solveOnce.
    const edgeIdsFor = (t: ConstraintTarget): { line: number; p1: number; p2: number } | null => {
        if (t.kind === "SketchEdge") {
            const ids = polyIds.get(`${t.spaceId}:${t.polyId}`);
            if (!ids) return null;
            if (t.edgeIdx < 0 || t.edgeIdx >= ids.lines.length) return null;
            const [va, vb] = ids.edgeVerts[t.edgeIdx];
            return {
                line: ids.lines[t.edgeIdx],
                p1: ids.points[va],
                p2: ids.points[vb],
            };
        }
        if (t.kind === "WallAxis") {
            const ids = wallIds.get(t.wallId as string);
            if (!ids) return null;
            return { line: ids.line, p1: ids.p1, p2: ids.p2 };
        }
        return null;
    };
    const circleIdFor = (t: ConstraintTarget): CircleIds | null => {
        if (t.kind !== "SketchCircle") return null;
        return circleIds.get(`${t.spaceId}:${t.polyId}`) ?? null;
    };

    switch (c.type) {
        case "Horizontal": {
            const edge = c.targets[0];
            const ids = edgeIdsFor(edge);
            if (!ids) return out;
            out.push({ type: "horizontal_pp", id: String(idAlloc.next()), p1_id: String(ids.p1), p2_id: String(ids.p2) });
            break;
        }
        case "Vertical": {
            const edge = c.targets[0];
            const ids = edgeIdsFor(edge);
            if (!ids) return out;
            out.push({ type: "vertical_pp", id: String(idAlloc.next()), p1_id: String(ids.p1), p2_id: String(ids.p2) });
            break;
        }
        case "Length": {
            const edge = c.targets[0];
            const ids = edgeIdsFor(edge);
            if (!ids || c.value === undefined) return out;
            out.push({
                type: "p2p_distance",
                id: String(idAlloc.next()),
                p1_id: String(ids.p1),
                p2_id: String(ids.p2),
                distance: c.value,
            });
            break;
        }
        case "Parallel": {
            if (c.targets.length < 2) return out;
            const a = edgeIdsFor(c.targets[0]);
            const b = edgeIdsFor(c.targets[1]);
            if (!a || !b) return out;
            out.push({ type: "parallel", id: String(idAlloc.next()), l1_id: String(a.line), l2_id: String(b.line) });
            break;
        }
        case "Perpendicular": {
            if (c.targets.length < 2) return out;
            const a = edgeIdsFor(c.targets[0]);
            const b = edgeIdsFor(c.targets[1]);
            if (!a || !b) return out;
            out.push({ type: "perpendicular_ll", id: String(idAlloc.next()), l1_id: String(a.line), l2_id: String(b.line) });
            break;
        }
        case "Angle": {
            if (c.targets.length < 2 || c.value === undefined) return out;
            const a = edgeIdsFor(c.targets[0]);
            const b = edgeIdsFor(c.targets[1]);
            if (!a || !b) return out;
            // l2l_angle_pppp passes the 4 endpoint param addrs directly — more
            // reliable than l2l_angle_ll in some planegcs builds. Angle is in
            // radians, signed CCW from line 1 to line 2.
            out.push({
                type: "l2l_angle_pppp",
                id: String(idAlloc.next()),
                l1p1_id: String(a.p1),
                l1p2_id: String(a.p2),
                l2p1_id: String(b.p1),
                l2p2_id: String(b.p2),
                angle: c.value,
            });
            break;
        }
        case "Collinear": {
            // Two edges share the same infinite line. Expressed as: both
            // endpoints of edge B lie on edge A's line.
            if (c.targets.length < 2) return out;
            const a = edgeIdsFor(c.targets[0]);
            const b = edgeIdsFor(c.targets[1]);
            if (!a || !b) return out;
            out.push({
                type: "point_on_line_pl",
                id: String(idAlloc.next()),
                p_id: String(b.p1),
                l_id: String(a.line),
            });
            out.push({
                type: "point_on_line_pl",
                id: String(idAlloc.next()),
                p_id: String(b.p2),
                l_id: String(a.line),
            });
            break;
        }
        case "PerpDistance": {
            // Perpendicular distance from a point to an edge's infinite line.
            if (c.targets.length < 2 || c.value === undefined) return out;
            const pt = c.targets.find((t) => t.kind === "SketchPoint");
            const edge = c.targets.find((t) => t.kind === "SketchEdge");
            if (!pt || !edge || pt.kind !== "SketchPoint" || edge.kind !== "SketchEdge") return out;
            const pid = pointIdFor(pt);
            const eids = edgeIdsFor(edge);
            if (pid == null || !eids) return out;
            out.push({
                type: "p2l_distance",
                id: String(idAlloc.next()),
                p_id: String(pid),
                l_id: String(eids.line),
                distance: c.value,
            });
            break;
        }
        case "EqualLength": {
            // All selected edges have the same length. Chain equal_length
            // from the first edge to each subsequent edge.
            const edgeTargets = c.targets.filter((t) => t.kind === "SketchEdge");
            if (edgeTargets.length < 2) return out;
            const ids: { line: number; p1: number; p2: number }[] = [];
            for (const t of edgeTargets) {
                const id = edgeIdsFor(t);
                if (!id) return out;
                ids.push(id);
            }
            for (let i = 1; i < ids.length; i++) {
                out.push({
                    type: "equal_length",
                    id: String(idAlloc.next()),
                    l1_id: String(ids[0].line),
                    l2_id: String(ids[i].line),
                });
            }
            break;
        }
        case "Coincident": {
            if (c.targets.length < 2) return out;
            const p1 = pointIdFor(c.targets[0]);
            const p2 = pointIdFor(c.targets[1]);
            if (p1 == null || p2 == null) return out;
            out.push({ type: "p2p_coincident", id: String(idAlloc.next()), p1_id: String(p1), p2_id: String(p2) });
            break;
        }
        case "PointOnGrid": {
            const pt = c.targets.find((t) => t.kind === "SketchPoint");
            const gridTgt = c.targets.find((t) => t.kind === "Grid");
            if (!pt || pt.kind !== "SketchPoint" || !gridTgt || gridTgt.kind !== "Grid") return out;
            const pid = pointIdFor(pt);
            if (pid == null) return out;
            const grid = grids.find((g) => g.id === gridTgt.gridId);
            if (!grid || grid.curve.type !== "Line") return out;
            // Push the grid as two fixed points + a line, then point_on_line
            const ga = idAlloc.next();
            const gb = idAlloc.next();
            const gl = idAlloc.next();
            out.push({ type: "point", id: String(ga), x: grid.curve.start[0], y: grid.curve.start[2], fixed: true });
            out.push({ type: "point", id: String(gb), x: grid.curve.end[0],   y: grid.curve.end[2],   fixed: true });
            out.push({ type: "line",  id: String(gl), p1_id: String(ga), p2_id: String(gb) });
            out.push({ type: "point_on_line_pl", id: String(idAlloc.next()), p_id: String(pid), l_id: String(gl) });
            break;
        }
        case "PointOnColumn": {
            const pt = c.targets.find((t) => t.kind === "SketchPoint");
            const colTgt = c.targets.find((t) => t.kind === "Column");
            if (!pt || pt.kind !== "SketchPoint" || !colTgt || colTgt.kind !== "Column") return out;
            const pid = pointIdFor(pt);
            if (pid == null) return out;
            const col = elements[colTgt.columnId as string] as ColumnElement | undefined;
            if (!col || !col.basePoint) return out;
            // Fixed point at column center + coincident
            const cp = idAlloc.next();
            out.push({ type: "point", id: String(cp), x: col.basePoint[0], y: col.basePoint[2], fixed: true });
            out.push({ type: "p2p_coincident", id: String(idAlloc.next()), p1_id: String(pid), p2_id: String(cp) });
            break;
        }
        case "CircleRadius": {
            const ct = c.targets.find((t) => t.kind === "SketchCircle");
            if (!ct || ct.kind !== "SketchCircle" || c.value === undefined) return out;
            const ids = circleIdFor(ct);
            if (!ids) return out;
            out.push({
                type: "circle_radius",
                id: String(idAlloc.next()),
                c_id: String(ids.circle),
                radius: c.value,
            });
            break;
        }
        case "CircleDiameter": {
            const ct = c.targets.find((t) => t.kind === "SketchCircle");
            if (!ct || ct.kind !== "SketchCircle" || c.value === undefined) return out;
            const ids = circleIdFor(ct);
            if (!ids) return out;
            out.push({
                type: "circle_diameter",
                id: String(idAlloc.next()),
                c_id: String(ids.circle),
                diameter: c.value,
            });
            break;
        }
        case "Tangent": {
            // Accept: edge+circle, or two circles.
            const circleTargets = c.targets.filter((t) => t.kind === "SketchCircle");
            const edgeTargets = c.targets.filter((t) => t.kind === "SketchEdge");
            if (circleTargets.length === 2) {
                const a = circleIdFor(circleTargets[0]);
                const b = circleIdFor(circleTargets[1]);
                if (!a || !b) return out;
                out.push({
                    type: "tangent_cc",
                    id: String(idAlloc.next()),
                    c1_id: String(a.circle),
                    c2_id: String(b.circle),
                });
            } else if (circleTargets.length === 1 && edgeTargets.length === 1) {
                const ci = circleIdFor(circleTargets[0]);
                const ei = edgeIdsFor(edgeTargets[0]);
                if (!ci || !ei) return out;
                out.push({
                    type: "tangent_lc",
                    id: String(idAlloc.next()),
                    l_id: String(ei.line),
                    c_id: String(ci.circle),
                });
            } else {
                return out;
            }
            break;
        }
        case "PointOnCircle": {
            const pt = c.targets.find((t) => t.kind === "SketchPoint");
            const ct = c.targets.find((t) => t.kind === "SketchCircle");
            if (!pt || pt.kind !== "SketchPoint" || !ct || ct.kind !== "SketchCircle") return out;
            const pid = pointIdFor(pt);
            const ids = circleIdFor(ct);
            if (pid == null || !ids) return out;
            out.push({
                type: "point_on_circle",
                id: String(idAlloc.next()),
                p_id: String(pid),
                c_id: String(ids.circle),
            });
            break;
        }
        case "ConcentricCircle": {
            // Concentricity is enforced at the geometry level by sharing a
            // single center-point OID (see SketchSolver push step). No GCS
            // constraint needed.
            break;
        }
        case "EqualRadius": {
            const cts = c.targets.filter((t) => t.kind === "SketchCircle");
            if (cts.length < 2) return out;
            const a = circleIdFor(cts[0]);
            const b = circleIdFor(cts[1]);
            if (!a || !b) return out;
            out.push({
                type: "equal_radius_cc",
                id: String(idAlloc.next()),
                c1_id: String(a.circle),
                c2_id: String(b.circle),
            });
            break;
        }
    }

    return out;
}

class IdAllocator {
    private n = 1;
    public next(): number {
        return this.n++;
    }
}
