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

/**
 * Vec3[] (XZ 平面) を上から見たときの shoelace 符号付き面積。
 * 戻り値 > 0 は CCW (上から見て反時計回り)、< 0 は CW。
 *
 * Wall 面の winding 判定に使う: `cullMode: "back"` の WebGPU パイプラインは
 * CCW (頂点シェーダ後) の三角形を表面とみなすため、addFace の cross 計算で
 * 出る面法線が外向きになるように footprint の向きを揃える必要がある。
 */
function signedAreaXZ(pts: Vec3[]): number {
    let s = 0;
    const n = pts.length;
    for (let i = 0; i < n; i++) {
        const a = pts[i], b = pts[(i + 1) % n];
        s += a[0] * b[2] - b[0] * a[2];
    }
    return s / 2;
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

        // Interior block boundary projection.
        //   c0..c3 が mitered な場合 (= JunctionGraph 由来 fp で wall 端が
        //   斜め切り)、c0-c3 の長さ ≠ c1-c2 の長さ となり、lerp(c0,c3,t) と
        //   lerp(c1,c2,t) が同じ t でも異なる world 位置を返す。これが原因で
        //   opening hole の outer / inner 境界が傾き、door preview (axis ベース)
        //   とズレる。
        //   data.axisStart / axisEnd が指定されていれば、それを使って
        //   interior 境界 (= block.coversStart=false / coversEnd=false の側)
        //   は axis 上の t 位置に **垂直方向オフセットだけを**当てた
        //   axis-aligned な点を採用する。wall 端 (= coversStart/End=true 側)
        //   はミター保持のため c0..c3 をそのまま使う。
        const aS = data.axisStart;
        const aE = data.axisEnd;
        let outerPerpX = 0, outerPerpZ = 0;
        let innerPerpX = 0, innerPerpZ = 0;
        let axLen = 0, axUx = 0, axUz = 0;
        const haveAxis = aS && aE;
        if (haveAxis) {
            const dx = aE![0] - aS![0];
            const dz = aE![2] - aS![2];
            axLen = Math.hypot(dx, dz);
            if (axLen > 1e-9) {
                axUx = dx / axLen;
                axUz = dz / axLen;
                // c0 = outerStart, c1 = innerStart. 軸方向成分を除いた
                // 垂直オフセットを抽出 (= start 側の thickness に対応する
                // perpendicular 位置)。
                const c0OffX = c0[0] - aS![0];
                const c0OffZ = c0[2] - aS![2];
                const c0AxisProj = c0OffX * axUx + c0OffZ * axUz;
                outerPerpX = c0OffX - c0AxisProj * axUx;
                outerPerpZ = c0OffZ - c0AxisProj * axUz;
                const c1OffX = c1[0] - aS![0];
                const c1OffZ = c1[2] - aS![2];
                const c1AxisProj = c1OffX * axUx + c1OffZ * axUz;
                innerPerpX = c1OffX - c1AxisProj * axUx;
                innerPerpZ = c1OffZ - c1AxisProj * axUz;
            }
        }
        const axisProject = (t: number, side: "outer" | "inner"): Vec3 => {
            if (!haveAxis || axLen <= 1e-9) {
                // フォールバック: 旧来の lerp(c0..c3) を使う
                if (side === "outer") return lerp(c0, c3, t);
                return lerp(c1, c2, t);
            }
            const x = aS![0] + axUx * (t * axLen);
            const z = aS![2] + axUz * (t * axLen);
            const px = side === "outer" ? outerPerpX : innerPerpX;
            const pz = side === "outer" ? outerPerpZ : innerPerpZ;
            return [x + px, aS![1], z + pz];
        };

        // ── Winding orientation detection ────────────────────────────────
        // fp (= [c0, c1, c2, c3] = [outerStart, innerStart, innerEnd, outerEnd])
        // の符号付き面積で決定的に判定する。
        //
        // 既定の addFace winding (b1, b2, t2, t1) は CW math fp (上から見て
        // 時計回り = 標準の screen 座標系で CCW) を前提に外向き法線を出す。
        // 入力 fp が CCW math (= 反時計回り) のときは winding を反転する。
        //
        // 過去はヒューリスティック (innerPerp と axis cross の dot 積) で
        // 判定していたが、ジャンクションで innerPerp ≈ 0 になるケースや
        // axis 方向と fp 順序が一致しないケースを取りこぼす。signed area は
        // 形状全体の向きを 1 つの符号で返すので、極端な mitering / 縮退
        // コーナーがあっても安定する。
        const fpCorners: Vec3[] = [c0, c1, c2, c3];
        const flipWinding = signedAreaXZ(fpCorners) > 0;
        const addFaceOriented = (p0: Vec3, p1: Vec3, p2: Vec3, p3: Vec3) => {
            if (flipWinding) addFace(p0, p3, p2, p1);
            else addFace(p0, p1, p2, p3);
        };

        for (const block of blocks) {
            // wall 端 (coversStart/End) はミター保持のため c0..c3 を直接使い、
            // interior block 境界 (= opening 境界) は axis 投影で揃える。
            const sLeft  = block.coversStart ? c0 : axisProject(block.tStart, "outer");
            const sRight = block.coversStart ? c1 : axisProject(block.tStart, "inner");
            const eLeft  = block.coversEnd   ? c3 : axisProject(block.tEnd,   "outer");
            const eRight = block.coversEnd   ? c2 : axisProject(block.tEnd,   "inner");

            const b0: Vec3 = [sLeft[0],  block.yBase, sLeft[2]];
            const b1: Vec3 = [sRight[0], block.yBase, sRight[2]];
            const b2: Vec3 = [eRight[0], block.yBase, eRight[2]];
            const b3: Vec3 = [eLeft[0],  block.yBase, eLeft[2]];
            const t0: Vec3 = [sLeft[0],  block.yTop, sLeft[2]];
            const t1: Vec3 = [sRight[0], block.yTop, sRight[2]];
            const t2: Vec3 = [eRight[0], block.yTop, eRight[2]];
            const t3: Vec3 = [eLeft[0],  block.yTop, eLeft[2]];

            // front (+n side)
            addFaceOriented(b1, b2, t2, t1);
            // back (-n side)
            addFaceOriented(b3, b0, t0, t3);
            // sill / lintel block かどうか (= 全高でない部分壁)。
            // sill / lintel の side cap は隣接する wall block の side cap と
            // 同一 X-Z 平面に位置し、Y 範囲が wall block 側 (full height) の
            // 部分集合となるため、両方描画すると Z-fighting で「窓の両側に
            // 灰色の縦帯」が見える。wall block 側だけが jamb を描画するよう
            // sill / lintel の side cap は省略する。
            const isPartialHeight = block.yBase !== yBaseWall || block.yTop !== yTopWall;
            // start cap: external if it covers the wall start (and not joined),
            // or interior reveal (jamb) where an opening cut the wall.
            const showStartCap = block.coversStart
                ? !options?.joinedStart
                : !isPartialHeight; // sill / lintel は省略
            if (showStartCap) addFaceOriented(b0, b1, t1, t0);
            const showEndCap = block.coversEnd
                ? !options?.joinedEnd
                : !isPartialHeight;
            if (showEndCap) addFaceOriented(b2, b3, t3, t2);
            // top
            addFaceOriented(t0, t1, t2, t3);
            // bottom
            addFaceOriented(b3, b2, b1, b0);
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
        // edge lerp は face と同じ axis-projection を使う。t が wall 端 (0 / 1)
        // のときは miter 保持のため c0..c3 を直接使い、interior の t は axis
        // 投影で揃える。これで face と edge が一致して、開口境界に余計な線が
        // 出ない。
        const lerpFront = (t: number): Vec3 => {
            if (t <= 0) return [C1[0], yBaseWall, C1[2]];
            if (t >= 1) return [C2[0], yBaseWall, C2[2]];
            const p = axisProject(t, "inner");
            return [p[0], yBaseWall, p[2]];
        };
        const lerpBack = (t: number): Vec3 => {
            if (t <= 0) return [C0[0], yBaseWall, C0[2]];
            if (t >= 1) return [C3[0], yBaseWall, C3[2]];
            const p = axisProject(t, "outer");
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
        // axis-projection で face と同じ位置を使う (mitered fp で c0-c3 と
        // c1-c2 の長さが異なるケースで edge と face がズレるのを防止)。
        for (const o of norm) {
            const sillY = yBaseWall + o.sillHeight;
            const topY = yBaseWall + o.sillHeight + o.height;
            const fL = axisProject(o.startT, "inner");
            const fR = axisProject(o.endT, "inner");
            const bL = axisProject(o.startT, "outer");
            const bR = axisProject(o.endT, "outer");
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
        // earcut の規約に合わせて **outer は CCW、hole は CW** に揃える。
        //   - outer CCW (signedArea > 0): 入力が CW なら反転
        //   - hole  CW  (signedArea < 0): 入力が CCW なら反転
        // 側面の winding は (a, at, bt, b) で統一し、cross product 法線が
        // (dz, 0, -dx) = -90° CW rotation of edge dir になる。これは
        //   outer CCW: RIGHT side = away from material = OUTWARD ✓
        //   hole  CW:  RIGHT side = into hole = ROOM-FACING ✓
        // のため outer / hole 共通でフリップ不要。
        const inputCCW = signedAreaXZ(data.footprint) > 0;
        const fp = inputCCW ? [...data.footprint] : [...data.footprint].reverse();
        const holesIn: Vec3[][] = (data.holes ?? []).map((h) => {
            const ccw = signedAreaXZ(h) > 0;
            return ccw ? [...h].reverse() : [...h];
        });
        const yBase = fp.length > 0 ? fp[0][1] : 0;
        const yTop = yBase + data.height;

        const positions: number[] = [];
        const normals: number[] = [];
        const indices: number[] = [];
        const edges: number[] = [];
        let indexOffset = 0;

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

        // 円周分割の既定 (circleWallAngleDeg) はちょうど 15° なので、それ以下
        // を smooth とすると 24 分割 circle が判定漏れする。25° まで許容して
        // 円側面を滑らかに、弧端の直線とのコーナー (通常 30° 以上) は描画。
        // 円側面 (= holes 付き annulus) は無条件で smooth、それ以外は折れ
        // 曲がりが 25° 未満を smooth と判定。
        // 25°: 既定 circleWallAngleDeg=15° (24 分割) 由来の 15° turns を許容
        // しつつ、弧↔直線のコーナー (典型 30°+) は visible に残す。
        const ARC_INTERIOR_TURN_RAD = (25 * Math.PI) / 180;
        const isAnnular = holesIn.length > 0;
        const addEdgePoint = (p: Vec3): number => {
            const idx = positions.length / 3;
            positions.push(p[0], p[1], p[2]);
            normals.push(0, 1, 0);
            return idx;
        };
        const addEdge = (a: Vec3, b: Vec3) => {
            edges.push(addEdgePoint(a), addEdgePoint(b));
        };

        /**
         * 1 つの ring (= 連続した頂点列) を処理して側面 quad / シルエット
         * エッジを発行する。outer (CCW) でも hole (CW) でも同じロジックで
         * 動く: winding (a, at, bt, b) の cross product = (dz, 0, -dx) が
         *   outer CCW: 外向き (= 室外側)
         *   hole  CW : ホール内側向き (= 室内側)
         * となるため法線符号反転は不要。
         */
        const processRing = (ring: Vec3[]) => {
            const m = ring.length;
            if (m < 3) return;
            const baseAt = (i: number): Vec3 => [ring[i][0], yBase, ring[i][2]];
            const topAt  = (i: number): Vec3 => [ring[i][0], yTop,  ring[i][2]];
            const turnAt = (i: number): number => {
                const prev = ring[(i - 1 + m) % m];
                const cur = ring[i];
                const next = ring[(i + 1) % m];
                const ax = cur[0] - prev[0], az = cur[2] - prev[2];
                const bx = next[0] - cur[0], bz = next[2] - cur[2];
                const la = Math.hypot(ax, az);
                const lb = Math.hypot(bx, bz);
                if (la < 1e-9 || lb < 1e-9) return 0;
                const cos = (ax * bx + az * bz) / (la * lb);
                return Math.acos(Math.max(-1, Math.min(1, cos)));
            };
            const isSmoothAt = (i: number): boolean => {
                if (m < 6) return false;
                // Annulus (= 円形 wall) は全頂点無条件 smooth。粗い分割でも
                // 連続曲面として扱う。
                if (isAnnular) return true;
                return turnAt(i) < ARC_INTERIOR_TURN_RAD;
            };
            // 各 face i の (水平) 法線 = (dz, -dx) (cross product 結果と同方向)。
            const faceNormalsXZ: [number, number][] = [];
            for (let i = 0; i < m; i++) {
                const a = baseAt(i);
                const b = baseAt((i + 1) % m);
                const dx = b[0] - a[0], dz = b[2] - a[2];
                const nx = dz, nz = -dx;
                const len = Math.hypot(nx, nz) || 1;
                faceNormalsXZ.push([nx / len, nz / len]);
            }
            const vertexNormalAt = (vIdx: number, faceIdx: number): [number, number] => {
                if (!isSmoothAt(vIdx)) return faceNormalsXZ[faceIdx];
                const prev = (vIdx - 1 + m) % m;
                const fa = faceNormalsXZ[prev];
                const fb = faceNormalsXZ[vIdx];
                const x = fa[0] + fb[0], z = fa[1] + fb[1];
                const len = Math.hypot(x, z) || 1;
                return [x / len, z / len];
            };
            // Side face quad: 統一 winding (a, at, bt, b)。
            for (let i = 0; i < m; i++) {
                const a = baseAt(i);
                const b = baseAt((i + 1) % m);
                const at = topAt(i);
                const bt = topAt((i + 1) % m);
                const na = vertexNormalAt(i, i);
                const nb = vertexNormalAt((i + 1) % m, i);
                const idx0 = positions.length / 3;
                positions.push(a[0], a[1], a[2]);
                normals.push(na[0], 0, na[1]);
                positions.push(at[0], at[1], at[2]);
                normals.push(na[0], 0, na[1]);
                positions.push(bt[0], bt[1], bt[2]);
                normals.push(nb[0], 0, nb[1]);
                positions.push(b[0], b[1], b[2]);
                normals.push(nb[0], 0, nb[1]);
                indices.push(
                    idx0,     idx0 + 1, idx0 + 2,
                    idx0,     idx0 + 2, idx0 + 3,
                );
                indexOffset = idx0 + 4;
            }
            // Edge silhouettes: top / bottom は常に描画 (= 壁シルエット)。
            // vertical は smooth 頂点で抑制。
            for (let i = 0; i < m; i++) {
                const a = baseAt(i);
                const b = baseAt((i + 1) % m);
                const at = topAt(i);
                const bt = topAt((i + 1) % m);
                addEdge(a, b);
                addEdge(at, bt);
                if (!isSmoothAt(i)) addEdge(a, at);
            }
        };

        // ── Side faces + edge silhouettes ────────────────────────────────
        processRing(fp);
        for (const h of holesIn) processRing(h);

        // ── Top + bottom (triangulated via earcut, holes 対応) ──────────
        // earcut は入力の signedArea を見て **常に内部 CCW に正規化** する。
        const flat: number[] = [];
        for (const p of fp) flat.push(p[0], p[2]);
        const holeIndices: number[] = [];
        for (const h of holesIn) {
            holeIndices.push(flat.length / 2);
            for (const p of h) flat.push(p[0], p[2]);
        }
        const tris = earcut(
            flat,
            holeIndices.length > 0 ? holeIndices : undefined,
            2,
        );
        // 3D 復元: vertex idx → ring + local idx → Vec3。
        // earcut の入力は flat = [outer..., hole0..., hole1...] で連結されて
        // いるので ringStarts[r] = ring r の global 開始 index。
        const ringsList: Vec3[][] = [fp, ...holesIn];
        const ringStarts: number[] = [0];
        for (let r = 0; r < ringsList.length - 1; r++) {
            ringStarts.push(ringStarts[r] + ringsList[r].length);
        }
        const vertAt = (yPlane: number, gIdx: number): Vec3 => {
            for (let r = ringsList.length - 1; r >= 0; r--) {
                if (gIdx >= ringStarts[r]) {
                    const local = gIdx - ringStarts[r];
                    const rv = ringsList[r][local];
                    return [rv[0], yPlane, rv[2]];
                }
            }
            return [0, yPlane, 0];
        };
        // Top face (+Y normal): reverse earcut output (CCW → CW math).
        for (let i = 0; i < tris.length; i += 3) {
            const a = tris[i], b = tris[i + 1], c = tris[i + 2];
            addTri(vertAt(yTop, c), vertAt(yTop, b), vertAt(yTop, a));
        }
        // Bottom face (-Y normal): keep earcut output as-is (CCW math).
        for (let i = 0; i < tris.length; i += 3) {
            const a = tris[i], b = tris[i + 1], c = tris[i + 2];
            addTri(vertAt(yBase, a), vertAt(yBase, b), vertAt(yBase, c));
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
