"use client";

import React, { useState } from "react";
import { RectangleHorizontal, Trash2, MousePointer2, Square, Spline, Circle } from "lucide-react";
import { useAppState, AppState } from "../../application/AppState";
import { SpaceElement, RoomPolygon, polygonEdges, isPolygonClosed } from "../../model/elements/SpaceElement";
import { WallElement } from "../../model/elements/WallElement";
import { CreateWallCommand } from "../../commands/create/CreateWallCommand";
import {
    AddConstraintCommand,
    RemoveConstraintCommand,
    generateConstraintId,
} from "../../commands/create/AddConstraintCommand";
import { Constraint } from "../../model/constraint/Constraint";
import { Vec2 } from "../../geometry/math/Vec2";
import { Vec3 } from "../../geometry/math/Vec3";

import { computeMiteredWallAxes, computeWalledOutlineGeometry } from "./wallSync";

export default function RoomEditPanel() {
    const [wallThicknessMm, setWallThicknessMm] = useState("200");
    const [circleWallAngleDeg, setCircleWallAngleDeg] = useState("30");

    const activeRoomId = useAppState((s: AppState) => s.activeRoomId);
    const roomEditMode = useAppState((s: AppState) => s.roomEditMode);
    const setRoomEditMode = useAppState((s: AppState) => s.setRoomEditMode);
    const elements = useAppState((s: AppState) => s.elements);
    const selection = useAppState((s: AppState) => s.selection);
    const sketchSelection = useAppState((s: AppState) => s.sketchSelection);
    const clearSketchSelection = useAppState((s: AppState) => s.clearSketchSelection);
    const constraints = useAppState((s: AppState) => s.constraints);
    const executeCommand = useAppState((s: AppState) => s.executeCommand);
    const updateElement = useAppState((s: AppState) => s.updateElement);
    const removeElement = useAppState((s: AppState) => s.removeElement);
    const setSelection = useAppState((s: AppState) => s.setSelection);

    // Delete / Backspace handler registered at top level (above the early
    // returns) so the hook order remains stable across renders. The actual
    // behavior is routed through a ref filled in below.
    const deleteHandlerRef = React.useRef<() => void>(() => {});
    React.useEffect(() => {
        if (!activeRoomId) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key !== "Delete" && e.key !== "Backspace") return;
            const t = e.target as HTMLElement | null;
            if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
            deleteHandlerRef.current();
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [activeRoomId]);

    if (!activeRoomId) return null;

    const room = elements[activeRoomId] as SpaceElement | undefined;
    if (!room || room.type !== "Space") return null;

    const selectedWall = selection.length === 1
        ? elements[selection[0]] as WallElement | undefined
        : undefined;
    const isWallSelected = selectedWall?.type === "Wall";

    const selectedPolyIds = new Set(
        selection
            .filter((s: string) => s.startsWith("poly:"))
            .map((s: string) => s.slice(5))
    );
    const hasSelectedShapes = selectedPolyIds.size > 0;
    const hasSelectedCircle = room.polygons.some(
        (p) => selectedPolyIds.has(p.id) && p.shape?.type === "circle",
    );

    const handleGenerateWalls = () => {
        if ((room.polygons?.length ?? 0) === 0) return;

        const wallThickness = (parseFloat(wallThicknessMm) || 20) / 1000;
        const circleAngleDeg = Math.max(1, Math.min(180, parseFloat(circleWallAngleDeg) || 30));
        const circleAngleRad = (circleAngleDeg * Math.PI) / 180;

        // 1) For each selected polygon, build its working outer (circles get
        //    resampled at the user's split angle) and its mitered wall axes.
        interface PolyWork {
            poly: RoomPolygon;
            workingOuter: Vec2[];
            axes: [Vec3, Vec3][];
        }
        const works: PolyWork[] = [];
        const skippedOpen: string[] = [];
        for (const poly of room.polygons) {
            if (!selectedPolyIds.has(poly.id)) continue;
            // Phase 1: only closed polygons can generate walls. Open boundary
            // objects are tracked but wall generation is skipped with a warn.
            if (poly.shape?.type !== "circle" && !isPolygonClosed(poly)) {
                skippedOpen.push(poly.id);
                continue;
            }

            let workingOuter = poly.outer;
            if (poly.shape?.type === "circle") {
                const n = Math.max(3, Math.round((Math.PI * 2) / circleAngleRad));
                const c = poly.shape.center, r = poly.shape.radius;
                const pts: Vec2[] = [];
                for (let i = 0; i < n; i++) {
                    const a = (i / n) * Math.PI * 2;
                    pts.push([c[0] + Math.cos(a) * r, c[1] + Math.sin(a) * r]);
                }
                workingOuter = pts;
            }
            let cx = 0, cy = 0;
            for (const p of workingOuter) { cx += p[0]; cy += p[1]; }
            cx /= workingOuter.length; cy /= workingOuter.length;
            const axes = computeMiteredWallAxes(workingOuter, [cx, cy], wallThickness / 2);
            works.push({ poly, workingOuter, axes });
        }

        // 2) Union-find on edges across selected polygons, merging edges linked
        //    by a Collinear constraint. Each group will map to ONE wall (shared).
        const edgeKey = (polyId: string, i: number) => `${polyId}:${i}`;
        const parent = new Map<string, string>();
        const find = (x: string): string => {
            if (!parent.has(x)) parent.set(x, x);
            const p = parent.get(x)!;
            if (p === x) return x;
            const r = find(p);
            parent.set(x, r);
            return r;
        };
        const union = (a: string, b: string) => {
            const ra = find(a), rb = find(b);
            if (ra !== rb) parent.set(ra, rb);
        };
        // Seed every edge into the union-find (so lone edges still get a root)
        for (const w of works) {
            for (let i = 0; i < w.workingOuter.length; i++) {
                find(edgeKey(w.poly.id, i));
            }
        }
        const selectedEdgeSet = new Set<string>();
        for (const w of works) {
            for (let i = 0; i < w.workingOuter.length; i++) {
                selectedEdgeSet.add(edgeKey(w.poly.id, i));
            }
        }
        for (const cid in constraints) {
            const cc = constraints[cid];
            if (cc.type !== "Collinear") continue;
            const edges = cc.targets
                .filter((t) => t.kind === "SketchEdge")
                .map((t) => edgeKey((t as any).polyId as string, (t as any).edgeIdx as number));
            // Only fold groups whose edges are all currently being generated
            const inScope = edges.filter((k) => selectedEdgeSet.has(k));
            for (let i = 1; i < inScope.length; i++) union(inScope[0], inScope[i]);
        }

        // 2b) Geometric fallback: also merge edges that are coincident even
        //     without an explicit Collinear constraint. Handles "user just
        //     snapped two rooms together" without additional ceremony.
        const ANGLE_TOL = (3 * Math.PI) / 180;                    // 3° slack
        const DIST_TOL = Math.max(0.02, wallThickness);           // ≥ 2cm or ≥ wall thickness
        let sharedPairs = 0;
        for (let i = 0; i < works.length; i++) {
            const wa = works[i];
            for (let j = i + 1; j < works.length; j++) {
                const wb = works[j];
                const na = wa.workingOuter.length;
                const nb = wb.workingOuter.length;
                for (let ei = 0; ei < na; ei++) {
                    const pa1 = wa.workingOuter[ei];
                    const pa2 = wa.workingOuter[(ei + 1) % na];
                    const dxa = pa2[0] - pa1[0], dya = pa2[1] - pa1[1];
                    const lenA = Math.hypot(dxa, dya);
                    if (lenA < 1e-9) continue;
                    const ux = dxa / lenA, uy = dya / lenA;
                    const nx = -uy, ny = ux;
                    for (let ej = 0; ej < nb; ej++) {
                        const pb1 = wb.workingOuter[ej];
                        const pb2 = wb.workingOuter[(ej + 1) % nb];
                        const dxb = pb2[0] - pb1[0], dyb = pb2[1] - pb1[1];
                        const lenB = Math.hypot(dxb, dyb);
                        if (lenB < 1e-9) continue;
                        // Parallel check via |sin(θ)| = |cross|/(lenA*lenB)
                        const cross = dxa * dyb - dya * dxb;
                        if (Math.abs(cross / (lenA * lenB)) > Math.sin(ANGLE_TOL)) continue;
                        // Both endpoints of B on A's infinite line
                        const d1 = Math.abs((pb1[0] - pa1[0]) * nx + (pb1[1] - pa1[1]) * ny);
                        const d2 = Math.abs((pb2[0] - pa1[0]) * nx + (pb2[1] - pa1[1]) * ny);
                        if (d1 > DIST_TOL || d2 > DIST_TOL) continue;
                        // Projected overlap along A's direction
                        const t1 = (pb1[0] - pa1[0]) * ux + (pb1[1] - pa1[1]) * uy;
                        const t2 = (pb2[0] - pa1[0]) * ux + (pb2[1] - pa1[1]) * uy;
                        const bMin = Math.min(t1, t2), bMax = Math.max(t1, t2);
                        if (bMax < -DIST_TOL || bMin > lenA + DIST_TOL) continue;
                        // Require a non-trivial overlap length so corner-only
                        // contact doesn't erroneously merge.
                        const overlap = Math.min(bMax, lenA) - Math.max(bMin, 0);
                        if (overlap <= DIST_TOL) continue;
                        union(edgeKey(wa.poly.id, ei), edgeKey(wb.poly.id, ej));
                        sharedPairs++;
                    }
                }
            }
        }
        // eslint-disable-next-line no-console
        console.log(`[Walls] geometric shared-edge pairs detected=${sharedPairs}`);

        // 3) Clean up previously-generated walls for the selected polygons.
        const prevWallIds = new Set<string>();
        for (const w of works) {
            for (const wid of w.poly.wallIds ?? []) if (wid) prevWallIds.add(wid);
        }
        for (const wid of prevWallIds) {
            // Only drop if no NON-selected polygon references it (so we don't
            // delete a shared wall whose other owner is still outside the
            // regeneration set).
            let referencedElsewhere = false;
            for (const p of room.polygons) {
                if (selectedPolyIds.has(p.id)) continue;
                if (p.wallIds?.includes(wid)) { referencedElsewhere = true; break; }
            }
            if (!referencedElsewhere && elements[wid]) removeElement(wid);
        }

        // 4) Create one wall per group. For shared groups (≥ 2 edges) use the
        //    un-mitered polygon-edge axis so the wall sits *centered* on the
        //    shared boundary. For single-owner groups use the mitered axis
        //    (so corners with the owning polygon's other walls join cleanly).
        const groupSize = new Map<string, number>();
        for (const w of works) {
            for (let i = 0; i < w.workingOuter.length; i++) {
                const root = find(edgeKey(w.poly.id, i));
                groupSize.set(root, (groupSize.get(root) ?? 0) + 1);
            }
        }
        const groupWallId = new Map<string, string>();
        const groupRepresentative = new Map<string, { axis: [Vec3, Vec3] }>();
        for (const w of works) {
            const n = w.workingOuter.length;
            for (let i = 0; i < n; i++) {
                const root = find(edgeKey(w.poly.id, i));
                if (groupRepresentative.has(root)) continue;
                const size = groupSize.get(root) ?? 1;
                if (size > 1) {
                    const p1 = w.workingOuter[i];
                    const p2 = w.workingOuter[(i + 1) % n];
                    groupRepresentative.set(root, {
                        axis: [[p1[0], 0, p1[1]], [p2[0], 0, p2[1]]] as [Vec3, Vec3],
                    });
                } else {
                    groupRepresentative.set(root, { axis: w.axes[i] });
                }
            }
        }
        for (const [root, { axis }] of groupRepresentative) {
            const cmd = new CreateWallCommand(axis, wallThickness, room.height, undefined, room.levelId);
            executeCommand(cmd);
            groupWallId.set(root, cmd.getElementId());
        }
        // eslint-disable-next-line no-console
        console.log(`[Walls] groups=${groupRepresentative.size} edges=${
            works.reduce((s, w) => s + w.workingOuter.length, 0)
        }${skippedOpen.length ? ` (skipped open: ${skippedOpen.join(",")})` : ""}`);

        // 5) Compose updated polygons. Selected polygons get wallIds from the
        //    group map (so shared edges point at the same wall id).
        //    Drop any legacy outline polygons tied to these inners (and their
        //    constraints) — outlines are now pure derived geometry drawn at
        //    render time from (inner outer + wallThickness), not first-class
        //    sketch polygons. This avoids cross-polygon constraint collapse.
        const innerIdsBeingRegenerated = selectedPolyIds;
        const staleOutlineIds = new Set<string>();
        for (const p of room.polygons) {
            if (p.wallOutlineOf && innerIdsBeingRegenerated.has(p.wallOutlineOf)) {
                staleOutlineIds.add(p.id);
            }
        }
        for (const cid in constraints) {
            const c = constraints[cid];
            const refsStale = c.targets.some((t) => {
                const tt = t as any;
                return (t.kind === "SketchEdge" || t.kind === "SketchPoint" || t.kind === "SketchCircle")
                    && staleOutlineIds.has(tt.polyId);
            });
            if (refsStale) executeCommand(new RemoveConstraintCommand(cid));
        }
        const updatedPolys: RoomPolygon[] = [];
        for (const poly of room.polygons) {
            if (staleOutlineIds.has(poly.id)) continue;
            if (!selectedPolyIds.has(poly.id)) { updatedPolys.push(poly); continue; }
            const w = works.find((ww) => ww.poly.id === poly.id)!;
            const wallIds: string[] = [];
            for (let i = 0; i < w.workingOuter.length; i++) {
                const root = find(edgeKey(poly.id, i));
                const wid = groupWallId.get(root);
                if (wid) wallIds.push(wid);
            }
            updatedPolys.push({ ...poly, wallIds, wallThickness });
        }

        // Per the new spec ("自由ゾーニングモード"), walls track the inner
        // polygon directly via syncWallsToPolygonOuter. No wall-outline
        // polygon is materialized — the wall slabs are rendered procedurally
        // from (inner outer + thickness) at render time.
        updateElement(activeRoomId, {
            polygons: updatedPolys,
            dirtyFlags: new Set([...room.dirtyFlags, "Geometry", "Mesh", "Render"]),
        } as any);
    };

    const handleDeleteWall = () => {
        if (!isWallSelected || !selectedWall) return;
        removeElement(selectedWall.id);
        setSelection([]);
    };

    const handleDeletePolys = () => {
        if (selectedPolyIds.size === 0) return;
        // Expand selection to include any wallOutline polygons attached to
        // the ones being deleted — they have no meaning once their inner is
        // gone and their constraints would dangle.
        const expanded = new Set<string>(selectedPolyIds);
        for (const p of room.polygons) {
            if (p.wallOutlineOf && selectedPolyIds.has(p.wallOutlineOf)) expanded.add(p.id);
        }
        // Remove walls that ONLY belong to the polygons being deleted.
        const toDelete = new Set<string>();
        for (const poly of room.polygons) {
            if (!expanded.has(poly.id)) continue;
            for (const wid of poly.wallIds ?? []) if (wid) toDelete.add(wid);
        }
        for (const poly of room.polygons) {
            if (expanded.has(poly.id)) continue;
            for (const wid of poly.wallIds ?? []) if (wid) toDelete.delete(wid);
        }
        for (const wid of toDelete) {
            if (elements[wid]) removeElement(wid);
        }
        // Remove constraints referencing any polygon being deleted.
        for (const cid in constraints) {
            const c = constraints[cid];
            const refsDeleted = c.targets.some((t) => {
                const tt = t as any;
                return (t.kind === "SketchEdge" || t.kind === "SketchPoint" || t.kind === "SketchCircle")
                    && expanded.has(tt.polyId);
            });
            if (refsDeleted) executeCommand(new RemoveConstraintCommand(cid));
        }
        const remaining = room.polygons.filter((p) => !expanded.has(p.id));
        updateElement(activeRoomId, {
            polygons: remaining,
            dirtyFlags: new Set([...room.dirtyFlags, "Geometry", "Mesh", "Render"]),
        } as any);
        setSelection([]);
    };

    const selectedEdges = sketchSelection.filter(
        (s): s is { kind: "edge"; spaceId: string; polyId: string; edgeIdx: number } => s.kind === "edge",
    );

    // Delete selected edges. Two paths depending on whether the edge has an
    // associated wall:
    //   (A) Edge has a wall → remove the wall element, keep the inner edge
    //       (so the boundary still defines the room), and trim the outer
    //       wall-outline polygon by clipping it with the edge's extended
    //       line (keeps the inner-side half). `wallIds[edgeIdx]` becomes ""
    //       to mark "no wall at this slot" while preserving the 1:1 length
    //       invariant with `outer`.
    //   (B) Edge has no wall → legacy behavior: remove the inner edge, drop
    //       wallIds. The polygon becomes an open boundary.
    // Constraints touching edges being remapped / outlines being modified
    // are cleaned up.
    const handleDeleteEdges = () => {
        if (selectedEdges.length === 0) return;
        const byPoly = new Map<string, Set<number>>();
        for (const s of selectedEdges) {
            if (s.spaceId !== activeRoomId) continue;
            if (!byPoly.has(s.polyId)) byPoly.set(s.polyId, new Set());
            byPoly.get(s.polyId)!.add(s.edgeIdx);
        }
        if (byPoly.size === 0) return;

        // Partition edges: wall-delete vs edge-delete.
        const wallDeletes = new Map<string, Set<number>>();
        const edgeDeletes = new Map<string, Set<number>>();
        for (const [polyId, delSet] of byPoly) {
            const poly = room.polygons.find((p) => p.id === polyId);
            if (!poly) continue;
            if (poly.shape?.type === "circle") continue;
            const perEdgeWall =
                poly.wallIds && poly.wallIds.length === poly.outer.length;
            for (const edgeIdx of delSet) {
                if (perEdgeWall && poly.wallIds![edgeIdx]) {
                    if (!wallDeletes.has(polyId)) wallDeletes.set(polyId, new Set());
                    wallDeletes.get(polyId)!.add(edgeIdx);
                } else {
                    if (!edgeDeletes.has(polyId)) edgeDeletes.set(polyId, new Set());
                    edgeDeletes.get(polyId)!.add(edgeIdx);
                }
            }
        }

        // ---- Wall-delete path: new wallIds, recompute outline from scratch ----
        interface OutlineRebuild {
            innerId: string;
            outlineId: string;
            outer: Vec2[];
            edges: [number, number][];
            innerToOuter: (number | null)[];
        }
        const stagedWallIds = new Map<string, string[]>();
        const candidateWallIdsToDelete = new Set<string>();
        const outlineRebuilds: OutlineRebuild[] = [];
        const outlineToRemove = new Set<string>();
        for (const [polyId, edgeSet] of wallDeletes) {
            const poly = room.polygons.find((p) => p.id === polyId)!;
            const newWallIds = [...(poly.wallIds ?? [])];
            for (const edgeIdx of edgeSet) {
                if (edgeIdx >= newWallIds.length) continue;
                const wid = newWallIds[edgeIdx];
                if (!wid) continue;
                candidateWallIdsToDelete.add(wid);
                newWallIds[edgeIdx] = "";
            }
            stagedWallIds.set(polyId, newWallIds);

            const outline = room.polygons.find((p) => p.wallOutlineOf === polyId);
            if (!outline) continue;
            const T = poly.wallThickness ?? 0;
            if (T <= 0) continue;
            let cx = 0, cy = 0;
            for (const v of poly.outer) { cx += v[0]; cy += v[1]; }
            cx /= poly.outer.length; cy /= poly.outer.length;
            const { outer, edges: outEdges, innerToOuter } =
                computeWalledOutlineGeometry(poly.outer, newWallIds, T, [cx, cy]);
            if (outer.length < 2 || outEdges.length === 0) {
                outlineToRemove.add(outline.id);
            } else {
                outlineRebuilds.push({
                    innerId: polyId,
                    outlineId: outline.id,
                    outer,
                    edges: outEdges,
                    innerToOuter,
                });
            }
        }
        // Keep a wall id only if no polygon still references it in a non-empty slot.
        const stillReferenced = new Set<string>();
        for (const poly of room.polygons) {
            const ids = stagedWallIds.get(poly.id) ?? poly.wallIds ?? [];
            for (const wid of ids) if (wid) stillReferenced.add(wid);
        }
        const finalWallIdsToDelete = new Set<string>();
        for (const wid of candidateWallIdsToDelete) {
            if (!stillReferenced.has(wid)) finalWallIdsToDelete.add(wid);
        }

        // ---- Edge-delete path (legacy) ----
        interface DelPlan {
            newEdges: [number, number][];
            oldToNewE: Map<number, number>;
        }
        const edgePlans = new Map<string, DelPlan>();
        for (const [polyId, delSet] of edgeDeletes) {
            const poly = room.polygons.find((p) => p.id === polyId);
            if (!poly) continue;
            const curEdges = polygonEdges(poly);
            const newEdges: [number, number][] = [];
            const oldToNewE = new Map<number, number>();
            for (let i = 0; i < curEdges.length; i++) {
                if (delSet.has(i)) continue;
                oldToNewE.set(i, newEdges.length);
                newEdges.push(curEdges[i]);
            }
            edgePlans.set(polyId, { newEdges, oldToNewE });
        }

        // ---- Constraint surgery ----
        // Drop any constraint that references an outline polygon being
        // trimmed or removed (its vertex/edge indices are no longer valid,
        // and the inner↔outline offset relation no longer applies across
        // the cut edge). Remap surviving edge indices for edge-delete polys.
        const state = useAppState.getState();
        const touchedOutlines = new Set<string>(outlineToRemove);
        for (const r of outlineRebuilds) touchedOutlines.add(r.outlineId);
        for (const cid in constraints) {
            const c = constraints[cid];
            const refsTouchedOutline = c.targets.some((t) => {
                if (t.kind !== "SketchEdge" && t.kind !== "SketchPoint") return false;
                return touchedOutlines.has((t as any).polyId as string);
            });
            if (refsTouchedOutline) {
                executeCommand(new RemoveConstraintCommand(cid));
                continue;
            }
            let drop = false;
            const newTargets = c.targets.map((t) => {
                if (t.kind !== "SketchEdge") return t;
                const plan = edgePlans.get(t.polyId);
                if (!plan) return t;
                const ne = plan.oldToNewE.get(t.edgeIdx);
                if (ne === undefined) { drop = true; return t; }
                return { ...t, edgeIdx: ne };
            });
            if (drop) {
                executeCommand(new RemoveConstraintCommand(cid));
            } else {
                const changed = newTargets.some((nt, i) => nt !== c.targets[i]);
                if (changed) state.updateConstraint(cid, { targets: newTargets });
            }
        }

        // ---- Compose updated polygon list ----
        const outlineRebuildById = new Map<string, OutlineRebuild>();
        for (const r of outlineRebuilds) outlineRebuildById.set(r.outlineId, r);
        const updatedPolys: RoomPolygon[] = [];
        for (const poly of room.polygons) {
            if (outlineToRemove.has(poly.id)) continue;
            const rebuild = outlineRebuildById.get(poly.id);
            if (rebuild) {
                updatedPolys.push({
                    ...poly,
                    outer: rebuild.outer,
                    edges: rebuild.edges,
                });
                continue;
            }
            const edgePlan = edgePlans.get(poly.id);
            if (edgePlan) {
                const { wallIds: _wid, ...rest } = poly;
                updatedPolys.push({ ...rest, edges: edgePlan.newEdges });
                continue;
            }
            const newWids = stagedWallIds.get(poly.id);
            if (newWids) {
                updatedPolys.push({ ...poly, wallIds: newWids });
                continue;
            }
            updatedPolys.push(poly);
        }

        for (const wid of finalWallIdsToDelete) {
            if (elements[wid]) removeElement(wid);
        }

        updateElement(activeRoomId, {
            polygons: updatedPolys,
            dirtyFlags: new Set([...room.dirtyFlags, "Geometry", "Mesh", "Render"]),
        } as any);

        // Re-attach inner↔outline constraints so solver-driven moves of the
        // inner polygon still propagate to the outline after cuts. For each
        // surviving outline vertex (mapped from inner vertex i), pin it with
        // two PerpDistance constraints against the two adjacent inner edges:
        //   - wall-present side → distance = wallThickness (offset face)
        //   - wall-absent side  → distance = 0 (vertex lies on that edge's
        //     extended line, which is where the cut was made)
        const spaceId = activeRoomId;
        for (const rebuild of outlineRebuilds) {
            const inner = updatedPolys.find((p) => p.id === rebuild.innerId);
            if (!inner) continue;
            const wallIds = inner.wallIds;
            if (!wallIds) continue;
            const T = inner.wallThickness ?? 0;
            if (T <= 0) continue;
            const n = inner.outer.length;
            for (let i = 0; i < n; i++) {
                const outIdx = rebuild.innerToOuter[i];
                if (outIdx === null) continue;
                const prev = (i - 1 + n) % n;
                const prevDist = wallIds[prev] ? T : 0;
                const nextDist = wallIds[i] ? T : 0;
                const mk = (edgeIdx: number, value: number): Constraint => ({
                    id: generateConstraintId(),
                    type: "PerpDistance",
                    targets: [
                        { kind: "SketchEdge", spaceId, polyId: rebuild.innerId, edgeIdx },
                        { kind: "SketchPoint", spaceId, polyId: rebuild.outlineId, vertexIdx: outIdx },
                    ],
                    value,
                });
                executeCommand(new AddConstraintCommand(mk(prev, prevDist)));
                executeCommand(new AddConstraintCommand(mk(i, nextDist)));
            }
        }

        clearSketchSelection();
    };

    const canDelete =
        isWallSelected || selectedPolyIds.size > 0 || selectedEdges.length > 0;
    const handleDelete = () => {
        if (selectedEdges.length > 0) handleDeleteEdges();
        else if (isWallSelected) handleDeleteWall();
        else if (selectedPolyIds.size > 0) handleDeletePolys();
    };

    // Keep the ref'd keyboard handler pointing at the latest closure so the
    // top-level useEffect (above the early return) can invoke it.
    deleteHandlerRef.current = () => {
        if (canDelete) handleDelete();
    };

    const btnClass = (active: boolean) =>
        `px-3 py-2 rounded text-xs font-medium flex items-center gap-1.5 transition-colors ${
            active
                ? "bg-blue-600 text-white shadow-md"
                : "bg-zinc-700 text-zinc-200 hover:bg-zinc-600"
        }`;

    const disabledBtnClass =
        "px-3 py-2 rounded text-xs font-medium flex items-center gap-1.5 bg-zinc-800 text-zinc-500 cursor-not-allowed";

    return (
        <div className="absolute bottom-6 left-1/2 -translate-x-1/2 z-30 flex items-center gap-2 bg-zinc-800/95 backdrop-blur border border-zinc-600 rounded-lg px-3 py-2 shadow-xl">
            <span className="text-[10px] text-zinc-400 uppercase font-bold mr-1">Room</span>
            <button
                className={btnClass(roomEditMode === "select")}
                onClick={() => setRoomEditMode("select")}
                title="Select mode"
            >
                <MousePointer2 size={14} />
                Select
            </button>
            <button
                className={btnClass(roomEditMode === "rectangle")}
                onClick={() => setRoomEditMode("rectangle")}
                title="Draw rectangle"
            >
                <RectangleHorizontal size={14} />
                Rectangle
            </button>
            <button
                className={btnClass(roomEditMode === "polyline")}
                onClick={() => setRoomEditMode("polyline")}
                title="Draw closed polygon (Enter / double-click / close-click to finalize)"
            >
                <Spline size={14} />
                Polyline
            </button>
            <button
                className={btnClass(roomEditMode === "circle")}
                onClick={() => setRoomEditMode("circle")}
                title="Draw circle (click center, then click to set radius)"
            >
                <Circle size={14} />
                Circle
            </button>
            <div className="w-px h-6 bg-zinc-600 mx-1" />
            <div className="flex items-center gap-1">
                <input
                    type="number"
                    value={wallThicknessMm}
                    onChange={(e) => setWallThicknessMm(e.target.value)}
                    className="w-14 bg-zinc-900 border border-zinc-600 rounded px-1.5 py-1 text-xs text-zinc-100 text-center outline-none focus:border-blue-500"
                    title="Wall thickness (mm)"
                    min={1}
                />
                <span className="text-[10px] text-zinc-500">mm</span>
            </div>
            {hasSelectedCircle && (
                <div className="flex items-center gap-1 pl-1 border-l border-zinc-600 ml-1">
                    <span className="text-[10px] text-zinc-400">円分割</span>
                    <input
                        type="number"
                        value={circleWallAngleDeg}
                        onChange={(e) => setCircleWallAngleDeg(e.target.value)}
                        className="w-12 bg-zinc-900 border border-zinc-600 rounded px-1.5 py-1 text-xs text-zinc-100 text-center outline-none focus:border-blue-500"
                        title="Circle wall split angle (degrees)"
                        min={1}
                        max={180}
                    />
                    <span className="text-[10px] text-zinc-500">°</span>
                </div>
            )}
            <button
                className={hasSelectedShapes ? btnClass(false) : disabledBtnClass}
                onClick={handleGenerateWalls}
                disabled={!hasSelectedShapes}
                title={hasSelectedShapes ? `Generate walls for ${selectedPolyIds.size} selected polygon(s) (${wallThicknessMm}mm thick)` : "Select polygon(s) first"}
            >
                <Square size={14} />
                Create Walls
            </button>
            <button
                className={canDelete ? btnClass(false) : disabledBtnClass}
                onClick={handleDelete}
                disabled={!canDelete}
                title={
                    selectedEdges.length > 0
                        ? `選択中の ${selectedEdges.length} 本のエッジの壁を削除。壁のないエッジはエッジ自体を削除 (Delete)`
                        : isWallSelected
                            ? "壁を削除 (Delete)"
                            : selectedPolyIds.size > 0
                                ? `選択中の ${selectedPolyIds.size} 個の図形を削除 (Delete)`
                                : "削除対象を選択してください"
                }
            >
                <Trash2 size={14} />
                Delete
            </button>
        </div>
    );
}
