import { MeshData } from "../MeshData";
import { WallGeometryData } from "../../geometry/builders/WallGeometryBuilder";
import { AABB } from "../../geometry/primitives/AABB";
import { vec3 } from "gl-matrix";
import { Vec3 } from "../../geometry/math/Vec3";

export interface WallMeshOptions {
    joinedStart?: boolean;
    joinedEnd?: boolean;
}

// Per-opening info expressed in wall-local coordinates so the builder can
// segment the wall into sill / lintel blocks without doing CSG.
export interface WallOpeningInfo {
    startT: number;   // 0..1 along the wall axis
    endT: number;     // 0..1 along the wall axis
    sillHeight: number;
    height: number;
}

interface BlockSpec {
    tStart: number;
    tEnd: number;
    yBase: number;
    yTop: number;
    coversStart: boolean; // touches the wall start cap
    coversEnd: boolean;   // touches the wall end cap
}

function lerp(a: Vec3, b: Vec3, t: number): Vec3 {
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

export class WallMeshBuilder {
    /**
     * Build a wall mesh, optionally cut by openings.
     * Openings are realised as segmentation: instead of CSG, the wall is broken
     * into solid blocks (full-height segments + sill / lintel blocks around each
     * opening). This satisfies §11 of door_window.md (no direct mesh boolean).
     */
    public static build(
        data: WallGeometryData,
        options?: WallMeshOptions,
        openings?: WallOpeningInfo[],
    ): MeshData {
        const h = data.height;
        const [c0, c1, c2, c3] = data.footprint;
        const yBaseWall = c0[1];
        const yTopWall = yBaseWall + h;

        const norm = normalizeOpenings(openings ?? [], yTopWall - yBaseWall);
        const blocks = computeBlocks(norm, yBaseWall, yTopWall);

        const positions: number[] = [];
        const normals: number[] = [];
        const indices: number[] = [];
        const edges: number[] = [];
        let indexOffset = 0;

        const addFace = (p0: Vec3, p1: Vec3, p2: Vec3, p3: Vec3) => {
            positions.push(...p0, ...p1, ...p2, ...p3);
            const v1 = vec3.subtract(vec3.create(), p1, p0);
            const v2 = vec3.subtract(vec3.create(), p2, p1);
            const n = vec3.cross(vec3.create(), v1, v2);
            vec3.normalize(n, n);
            for (let i = 0; i < 4; i++) normals.push(...n);
            indices.push(
                indexOffset, indexOffset + 1, indexOffset + 2,
                indexOffset, indexOffset + 2, indexOffset + 3,
            );
            indexOffset += 4;
        };

        for (const block of blocks) {
            // Interpolate the four base footprint corners along the wall length.
            // c0=start-left(-n), c1=start-right(+n), c2=end-right(+n), c3=end-left(-n)
            const sLeft  = lerp(c0, c3, block.tStart);
            const sRight = lerp(c1, c2, block.tStart);
            const eLeft  = lerp(c0, c3, block.tEnd);
            const eRight = lerp(c1, c2, block.tEnd);

            const b0: Vec3 = [sLeft[0],  block.yBase, sLeft[2]];
            const b1: Vec3 = [sRight[0], block.yBase, sRight[2]];
            const b2: Vec3 = [eRight[0], block.yBase, eRight[2]];
            const b3: Vec3 = [eLeft[0],  block.yBase, eLeft[2]];
            const t0: Vec3 = [sLeft[0],  block.yTop, sLeft[2]];
            const t1: Vec3 = [sRight[0], block.yTop, sRight[2]];
            const t2: Vec3 = [eRight[0], block.yTop, eRight[2]];
            const t3: Vec3 = [eLeft[0],  block.yTop, eLeft[2]];

            // front (+n side)
            addFace(b1, b2, t2, t1);
            // back (-n side)
            addFace(b3, b0, t0, t3);
            // start cap: external if it covers the wall start (and not joined),
            // or interior reveal where an opening cut the wall
            const showStartCap = block.coversStart ? !options?.joinedStart : true;
            if (showStartCap) addFace(b0, b1, t1, t0);
            const showEndCap = block.coversEnd ? !options?.joinedEnd : true;
            if (showEndCap) addFace(b2, b3, t3, t2);
            // top
            addFace(t0, t1, t2, t3);
            // bottom
            addFace(b3, b2, b1, b0);
        }

        // ── Edges ─────────────────────────────────────────────────────────
        // We do NOT reuse face vertex indices — those would emit per-block
        // boundaries (e.g. the seam where a lintel meets the surrounding wall),
        // producing the spurious vertical lines above an opening. Instead we
        // append edge-only vertices and build the silhouette + opening edges
        // explicitly.
        const addEdgePoint = (p: Vec3): number => {
            const idx = positions.length / 3;
            positions.push(p[0], p[1], p[2]);
            normals.push(0, 1, 0);
            return idx;
        };
        const addEdge = (a: Vec3, b: Vec3) => {
            edges.push(addEdgePoint(a), addEdgePoint(b));
        };

        // Outer box: 8 corners
        const C0 = c0, C1 = c1, C2 = c2, C3 = c3;
        const T0c: Vec3 = [C0[0], yTopWall, C0[2]];
        const T1c: Vec3 = [C1[0], yTopWall, C1[2]];
        const T2c: Vec3 = [C2[0], yTopWall, C2[2]];
        const T3c: Vec3 = [C3[0], yTopWall, C3[2]];

        // Front and back bottom edges, broken at each opening so the part of
        // the wall base where a door (sill=0) sits is not drawn.
        const intervalsExcluding = (excludes: { startT: number; endT: number }[]): [number, number][] => {
            const result: [number, number][] = [];
            let cursor = 0;
            for (const e of excludes) {
                if (e.startT > cursor) result.push([cursor, e.startT]);
                cursor = Math.max(cursor, e.endT);
            }
            if (cursor < 1) result.push([cursor, 1]);
            return result;
        };
        const doorOpenings = norm.filter((o) => o.sillHeight <= 1e-6);
        const lerpFront = (t: number): Vec3 => {
            const p = lerp(C1, C2, t);
            return [p[0], yBaseWall, p[2]];
        };
        const lerpBack = (t: number): Vec3 => {
            const p = lerp(C0, C3, t);
            return [p[0], yBaseWall, p[2]];
        };
        for (const [s, e] of intervalsExcluding(doorOpenings)) {
            addEdge(lerpFront(s), lerpFront(e));
            addEdge(lerpBack(s), lerpBack(e));
        }

        // Top edges (always full length)
        addEdge(T1c, T2c); // front top
        addEdge(T3c, T0c); // back top

        // Cap edges (start / end), only if not joined
        if (!options?.joinedStart) {
            addEdge(C0, C1); // start bottom
            addEdge(T0c, T1c); // start top
            addEdge(C0, T0c); // start back vertical
            addEdge(C1, T1c); // start front vertical
        }
        if (!options?.joinedEnd) {
            addEdge(C2, C3);
            addEdge(T2c, T3c);
            addEdge(C2, T2c);
            addEdge(C3, T3c);
        }

        // Per-opening edges: the rectangular hole on each face plus the
        // 4 inside-reveal depth lines connecting front and back.
        for (const o of norm) {
            const sillY = yBaseWall + o.sillHeight;
            const topY = yBaseWall + o.sillHeight + o.height;
            const fL = lerp(C1, C2, o.startT);
            const fR = lerp(C1, C2, o.endT);
            const bL = lerp(C0, C3, o.startT);
            const bR = lerp(C0, C3, o.endT);
            const F_BL: Vec3 = [fL[0], sillY, fL[2]];
            const F_BR: Vec3 = [fR[0], sillY, fR[2]];
            const F_TL: Vec3 = [fL[0], topY,  fL[2]];
            const F_TR: Vec3 = [fR[0], topY,  fR[2]];
            const B_BL: Vec3 = [bL[0], sillY, bL[2]];
            const B_BR: Vec3 = [bR[0], sillY, bR[2]];
            const B_TL: Vec3 = [bL[0], topY,  bL[2]];
            const B_TR: Vec3 = [bR[0], topY,  bR[2]];

            // Front face hole
            if (o.sillHeight > 1e-6) addEdge(F_BL, F_BR);
            addEdge(F_TL, F_TR);
            addEdge(F_BL, F_TL);
            addEdge(F_BR, F_TR);
            // Back face hole
            if (o.sillHeight > 1e-6) addEdge(B_BL, B_BR);
            addEdge(B_TL, B_TR);
            addEdge(B_BL, B_TL);
            addEdge(B_BR, B_TR);
            // Inside reveal depth lines (front ↔ back at each corner)
            if (o.sillHeight > 1e-6) {
                addEdge(F_BL, B_BL);
                addEdge(F_BR, B_BR);
            }
            addEdge(F_TL, B_TL);
            addEdge(F_TR, B_TR);
        }

        const posArray = new Float32Array(positions);
        let minX = Infinity, minY = Infinity, minZ = Infinity;
        let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
        if (posArray.length > 0) {
            for (let i = 0; i < posArray.length; i += 3) {
                const x = posArray[i], y = posArray[i + 1], z = posArray[i + 2];
                if (x < minX) minX = x; if (x > maxX) maxX = x;
                if (y < minY) minY = y; if (y > maxY) maxY = y;
                if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
            }
        } else {
            minX = minY = minZ = 0;
            maxX = maxY = maxZ = 0;
        }
        const bounds: AABB = { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] };

        return {
            positions: posArray,
            normals: new Float32Array(normals),
            indices: new Uint32Array(indices),
            edgeIndices: new Uint32Array(edges),
            bounds,
        };
    }
}

// ---------------------------------------------------------------------------
// Block computation
// ---------------------------------------------------------------------------

function normalizeOpenings(openings: WallOpeningInfo[], fullHeight: number): WallOpeningInfo[] {
    const norm = openings
        .map((o) => ({
            startT: Math.max(0, Math.min(1, o.startT)),
            endT: Math.max(0, Math.min(1, o.endT)),
            sillHeight: Math.max(0, Math.min(fullHeight, o.sillHeight)),
            height: Math.max(0, Math.min(fullHeight, o.height)),
        }))
        .filter((o) => o.endT > o.startT)
        .sort((a, b) => a.startT - b.startT);
    // Resolve overlap: trim each opening's start to the running cursor
    let cursor = 0;
    const out: WallOpeningInfo[] = [];
    for (const o of norm) {
        if (o.startT < cursor) {
            if (o.endT <= cursor) continue;
            o.startT = cursor;
        }
        out.push(o);
        cursor = o.endT;
    }
    return out;
}

function computeBlocks(norm: WallOpeningInfo[], yBase: number, yTop: number): BlockSpec[] {
    if (norm.length === 0) {
        return [{ tStart: 0, tEnd: 1, yBase, yTop, coversStart: true, coversEnd: true }];
    }

    const blocks: BlockSpec[] = [];
    let cursor = 0;
    for (const o of norm) {
        // full-height wall segment before the opening
        if (o.startT > cursor) {
            blocks.push({
                tStart: cursor,
                tEnd: o.startT,
                yBase,
                yTop,
                coversStart: cursor === 0,
                coversEnd: false,
            });
        }
        const sillTop = yBase + o.sillHeight;
        const lintelBase = yBase + o.sillHeight + o.height;
        // sill block
        if (o.sillHeight > 1e-6) {
            blocks.push({
                tStart: o.startT,
                tEnd: o.endT,
                yBase,
                yTop: sillTop,
                coversStart: o.startT === 0,
                coversEnd: o.endT === 1,
            });
        }
        // lintel block
        if (yTop - lintelBase > 1e-6) {
            blocks.push({
                tStart: o.startT,
                tEnd: o.endT,
                yBase: lintelBase,
                yTop,
                coversStart: o.startT === 0,
                coversEnd: o.endT === 1,
            });
        }
        cursor = o.endT;
    }
    if (cursor < 1) {
        blocks.push({
            tStart: cursor,
            tEnd: 1,
            yBase,
            yTop,
            coversStart: cursor === 0,
            coversEnd: true,
        });
    }
    return blocks;
}
