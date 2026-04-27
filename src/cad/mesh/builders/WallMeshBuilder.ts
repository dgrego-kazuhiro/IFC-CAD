import { MeshData } from "../MeshData";
import { WallGeometryData } from "../../geometry/builders/WallGeometryBuilder";
import { AABB } from "../../geometry/primitives/AABB";
import { vec3 } from "gl-matrix";
import { Vec3 } from "../../geometry/math/Vec3";
import earcut from "earcut";

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
        // 6 頂点の hex フットプリントは別パスで処理する。openings を伴うと
        // hex 断面のオープニング切り取りが現状未対応なので、呼び出し側で
        // openings を持つ壁は legacy rect path に落とすこと。
        if (data.isHexFootprint) {
            return WallMeshBuilder.buildHexPrism(data);
        }
        const h = data.height;
        const c0 = data.footprint[0];
        const c1 = data.footprint[1];
        const c2 = data.footprint[2];
        const c3 = data.footprint[3];
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

    /**
     * Hex (= N 頂点) フットプリントを縦に押し出してメッシュ化する。
     * `data.footprint` は CCW (上から見て) で、`computeWallHexagon` の
     * 6 頂点 [innerPrev, s, outerPrev, outerNext, e, innerNext] を想定。
     *
     * 構成:
     *   - 側面 (1 quad / 底辺): N 個
     *   - 天井 (Y=yTop): フットプリントを `earcut` で三角化
     *   - 床   (Y=yBase): 同じ三角化を逆向き winding で
     *
     * Openings (door / window) は現状未対応 — 持つ壁は呼び出し側で legacy
     * rect path に落とすこと。
     */
    private static buildHexPrism(data: WallGeometryData): MeshData {
        // computeWallHexagon は CCW (= 標準数学 convention の正 signedArea)
        // で hex を返す。一方 WallMeshBuilder の addQuad / addTri は legacy
        // rect path (CW フットプリント) の winding を前提に外向き法線を出す。
        // よってここで fp を反転して CW にしておくと、側面の外向き法線、
        // 天面 +Y、底面 -Y がすべて揃う。
        const fp = [...data.footprint].reverse();
        const n = fp.length;
        const yBase = fp.length > 0 ? fp[0][1] : 0;
        const yTop = yBase + data.height;

        // ── DEBUG: hex prism construction summary ───────────────────────
        // (top/bottom が出ていないバグ調査用。安定したら削除可。)
        if ((globalThis as any).__hexPrismDebug !== false) {
            // eslint-disable-next-line no-console
            console.log(
                `[hexPrism] verts=${n} h=${data.height.toFixed(3)} ` +
                `yBase=${yBase.toFixed(3)} yTop=${yTop.toFixed(3)} ` +
                `fp=[${fp.map((p) => `(${p[0].toFixed(2)},${p[2].toFixed(2)})`).join(",")}]`,
            );
        }

        const positions: number[] = [];
        const normals: number[] = [];
        const indices: number[] = [];
        const edges: number[] = [];
        let indexOffset = 0;

        const addQuad = (p0: Vec3, p1: Vec3, p2: Vec3, p3: Vec3) => {
            positions.push(...p0, ...p1, ...p2, ...p3);
            const v1 = vec3.subtract(vec3.create(), p1, p0);
            const v2 = vec3.subtract(vec3.create(), p2, p1);
            const nrm = vec3.cross(vec3.create(), v1, v2);
            vec3.normalize(nrm, nrm);
            for (let i = 0; i < 4; i++) normals.push(...nrm);
            indices.push(
                indexOffset,     indexOffset + 1, indexOffset + 2,
                indexOffset,     indexOffset + 2, indexOffset + 3,
            );
            indexOffset += 4;
        };
        const addTri = (p0: Vec3, p1: Vec3, p2: Vec3) => {
            positions.push(...p0, ...p1, ...p2);
            const v1 = vec3.subtract(vec3.create(), p1, p0);
            const v2 = vec3.subtract(vec3.create(), p2, p0);
            const nrm = vec3.cross(vec3.create(), v1, v2);
            vec3.normalize(nrm, nrm);
            for (let i = 0; i < 3; i++) normals.push(...nrm);
            indices.push(indexOffset, indexOffset + 1, indexOffset + 2);
            indexOffset += 3;
        };

        // ── Side faces: one quad per base edge ───────────────────────────
        // Winding (base[i], base[i+1], top[i+1], top[i]) で CCW hex の
        // 「右手」(= 外向き) 法線になる (cross product で確認済)。
        const baseAt = (i: number): Vec3 => [fp[i][0], yBase, fp[i][2]];
        const topAt  = (i: number): Vec3 => [fp[i][0], yTop,  fp[i][2]];
        for (let i = 0; i < n; i++) {
            const a = baseAt(i);
            const b = baseAt((i + 1) % n);
            const at = topAt(i);
            const bt = topAt((i + 1) % n);
            addQuad(a, b, bt, at);
        }

        // ── Top + bottom (triangulated via earcut) ───────────────────────
        // earcut は入力の signedArea を見て **常に内部 CCW に正規化** して
        // 三角化するため、出力 triangle は CCW math。3D で
        //   - CCW math at y=yTop  → -Y 法線 (= 上から見て背面 = 不可視)
        //   - CCW math at y=yBase → -Y 法線 (= 下から見て表面 = 可視 = 底面 OK)
        // よって TOP は winding を逆転 (a,b,c → c,b,a) して CW math に直し、
        // +Y 法線に揃える。BOTTOM は CCW のままで -Y で OK。
        const flat: number[] = [];
        for (const p of fp) flat.push(p[0], p[2]);
        const tris = earcut(flat, undefined, 2);
        if ((globalThis as any).__hexPrismDebug !== false) {
            // eslint-disable-next-line no-console
            console.log(
                `  earcut: ${tris.length / 3} tri(s)` +
                (tris.length === 0 ? " ⚠ NO TOP/BOTTOM TRIANGLES" : ""),
            );
        }
        // Top face (+Y normal): reverse earcut output (CCW → CW math).
        for (let i = 0; i < tris.length; i += 3) {
            const a = tris[i], b = tris[i + 1], c = tris[i + 2];
            addTri(topAt(c), topAt(b), topAt(a));
        }
        // Bottom face (-Y normal): keep earcut output as-is (CCW math).
        for (let i = 0; i < tris.length; i += 3) {
            const a = tris[i], b = tris[i + 1], c = tris[i + 2];
            addTri(baseAt(a), baseAt(b), baseAt(c));
        }

        // ── Edge silhouettes: top, bottom, vertical ──────────────────────
        const addEdgePoint = (p: Vec3): number => {
            const idx = positions.length / 3;
            positions.push(p[0], p[1], p[2]);
            normals.push(0, 1, 0);
            return idx;
        };
        const addEdge = (a: Vec3, b: Vec3) => {
            edges.push(addEdgePoint(a), addEdgePoint(b));
        };
        for (let i = 0; i < n; i++) {
            const a = baseAt(i);
            const b = baseAt((i + 1) % n);
            const at = topAt(i);
            const bt = topAt((i + 1) % n);
            addEdge(a, b);   // bottom
            addEdge(at, bt); // top
            addEdge(a, at);  // vertical
        }

        // ── Bounds ───────────────────────────────────────────────────────
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
