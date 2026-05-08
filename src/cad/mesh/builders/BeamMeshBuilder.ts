import { MeshData } from "../MeshData";
import { AABB } from "../../geometry/primitives/AABB";
import { Vec3 } from "../../geometry/math/Vec3";
import { Vec2 } from "../../geometry/math/Vec2";
import { vec3 } from "gl-matrix";
import { BeamElement, BeamZJustification } from "../../model/elements/BeamElement";
import { Profile } from "../../model/profiles/Profile";
import polygonClipping, { type Pair, type Ring } from "polygon-clipping";
import earcut from "earcut";

export interface BeamMeshParams {
    axis: [Vec3, Vec3];
    profile: Profile;
    /** Top elevation of the profile (= level elevation + topOffset). */
    topY: number;
    zJustification: BeamZJustification;
    rotation: number;
    /** 柱フットプリント (XZ 2D, CCW)。指定されると beam の水平断面から
     *  Clipper diff で柱を引き、残ったピース毎に独立した押し出し体を作る。
     *  rotation === 0 の梁にのみ適用 (回転梁は元実装で押し出し)。 */
    columnFootprints?: Vec2[][];
}

function profileBox(profile: Profile): { width: number; depth: number } {
    switch (profile.kind) {
        case "Rectangle":
            return { width: profile.width, depth: profile.depth };
        case "Circle":
            return { width: profile.radius * 2, depth: profile.radius * 2 };
        default:
            // MVP fallback for non-Rectangle profiles — use a default box
            return { width: 0.3, depth: 0.6 };
    }
}

/**
 * Build a beam mesh by extruding a rectangular profile along its 2-point axis.
 * - width: profile cross-dimension perpendicular to axis (horizontal)
 * - depth: profile cross-dimension along Y (vertical)
 * - zJustification anchors the profile's Top/Center/Bottom to `topY`
 * - rotation rotates the profile around the axis (radians)
 */
export class BeamMeshBuilder {
    public static buildFromElement(
        el: BeamElement,
        topY: number,
        columnFootprints?: Vec2[][],
    ): MeshData {
        return BeamMeshBuilder.build({
            axis: el.axis,
            profile: el.profile,
            topY,
            zJustification: el.zJustification,
            rotation: el.rotation,
            columnFootprints,
        });
    }

    public static build(p: BeamMeshParams): MeshData {
        const { axis, profile, topY, zJustification, rotation, columnFootprints } = p;
        const [a, b] = axis;
        const dx = b[0] - a[0];
        const dz = b[2] - a[2];
        const lenXZ = Math.hypot(dx, dz);
        if (lenXZ < 1e-6) return emptyMesh();

        const { width, depth } = profileBox(profile);

        // Axis direction in XZ plane
        const tx = dx / lenXZ;
        const tz = dz / lenXZ;
        // Horizontal normal (right-perpendicular in XZ)
        const nx = -tz;
        const nz = tx;
        // Apply rotation around the axis: rotate (normal, up) in the plane
        // perpendicular to the axis. For MVP we treat rotation as a rotation
        // of the cross-section around the beam axis.
        const cr = Math.cos(rotation);
        const sr = Math.sin(rotation);
        const rNx = nx * cr;
        const rNz = nz * cr;
        const rNy = sr; // tilt up as rotation opens
        // Vertical-ish vector (perpendicular to both axis and rotated normal)
        // Start from world-up (0,1,0) and rotate by `rotation` around the axis.
        const uX = nx * -sr;
        const uY = cr;
        const uZ = nz * -sr;

        const halfW = width / 2;
        const halfD = depth / 2;
        // Anchor the profile vertically per zJustification so that `topY`
        // represents Top/Center/Bottom of the profile.
        let yCenter: number;
        switch (zJustification) {
            case "Top": yCenter = topY - halfD; break;
            case "Center": yCenter = topY; break;
            case "Bottom": yCenter = topY + halfD; break;
        }

        // 8 corners of the beam box
        const makeCorner = (tEnd: 0 | 1, sw: number, sv: number): Vec3 => {
            const base = tEnd === 0 ? a : b;
            return [
                base[0] + rNx * sw + uX * sv,
                yCenter + rNy * sw + uY * sv,
                base[2] + rNz * sw + uZ * sv,
            ];
        };

        const b0 = makeCorner(0, -halfW, -halfD);
        const b1 = makeCorner(0,  halfW, -halfD);
        const b2 = makeCorner(1,  halfW, -halfD);
        const b3 = makeCorner(1, -halfW, -halfD);
        const t0 = makeCorner(0, -halfW,  halfD);
        const t1 = makeCorner(0,  halfW,  halfD);
        const t2 = makeCorner(1,  halfW,  halfD);
        const t3 = makeCorner(1, -halfW,  halfD);

        // 回転 0 + 柱フットプリントが指定されているケースは、Clipper で梁の
        // 水平断面から柱を引き算してから押し出す経路に切り替える。これで柱の
        // 形状が梁から打ち抜かれ、柱優先の見た目になる。
        if (columnFootprints && columnFootprints.length > 0 && Math.abs(rotation) < 1e-6) {
            const yBottom = yCenter - halfD;
            const yTop = yCenter + halfD;
            // beamRing: 上から見た梁の 4 頂点。CCW を保証するため signed area を
            // 確認 (axis dir と n の関係でどちらにもなり得る)。
            const r0: Pair = [b0[0], b0[2]]; // start, -n
            const r1: Pair = [b1[0], b1[2]]; // start, +n
            const r2: Pair = [b2[0], b2[2]]; // end,   +n
            const r3: Pair = [b3[0], b3[2]]; // end,   -n
            const beamRing: Pair[] = [r0, r1, r2, r3];
            // signed area (CCW > 0) を見て必要なら反転。
            let sa = 0;
            for (let i = 0; i < beamRing.length; i++) {
                const x = beamRing[i], y = beamRing[(i + 1) % beamRing.length];
                sa += x[0] * y[1] - y[0] * x[1];
            }
            const ringCCW: Pair[] = sa < 0 ? [...beamRing].reverse() : beamRing;
            const intersecting: Ring[][] = [];
            for (const col of columnFootprints) {
                if (col.length < 3) continue;
                const colRing: Pair[] = col.map<Pair>((p) => [p[0], p[1]]);
                try {
                    const inter = polygonClipping.intersection([ringCCW], [colRing]);
                    if (inter.length > 0) intersecting.push([colRing]);
                } catch { /* ignore */ }
            }
            if (intersecting.length > 0) {
                let pieces: Ring[][] | null = null;
                try {
                    pieces = polygonClipping.difference([ringCCW], ...intersecting);
                } catch {
                    pieces = null;
                }
                if (pieces) {
                    return buildExtrudedPiecesMesh(pieces, yBottom, yTop);
                }
            }
        }

        const positions: number[] = [];
        const normals: number[] = [];
        const indices: number[] = [];
        const edges: number[] = [];
        let off = 0;

        const addFace = (p0: Vec3, p1: Vec3, p2: Vec3, p3: Vec3) => {
            positions.push(...p0, ...p1, ...p2, ...p3);
            const v1 = vec3.subtract(vec3.create(), p1, p0);
            const v2 = vec3.subtract(vec3.create(), p2, p1);
            const n = vec3.cross(vec3.create(), v1, v2);
            vec3.normalize(n, n);
            for (let i = 0; i < 4; i++) normals.push(...n);
            indices.push(off, off + 1, off + 2, off, off + 2, off + 3);
            edges.push(off, off + 1, off + 1, off + 2, off + 2, off + 3, off + 3, off);
            off += 4;
        };

        // 6 faces of the extruded box
        addFace(b0, b1, t1, t0); // start cap
        addFace(b2, b3, t3, t2); // end cap
        addFace(b1, b2, t2, t1); // +normal face
        addFace(b3, b0, t0, t3); // -normal face
        addFace(t0, t1, t2, t3); // top
        addFace(b3, b2, b1, b0); // bottom

        const posArray = new Float32Array(positions);
        let minX = Infinity, minY = Infinity, minZ = Infinity;
        let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
        for (let i = 0; i < posArray.length; i += 3) {
            const x = posArray[i], y = posArray[i + 1], z = posArray[i + 2];
            if (x < minX) minX = x; if (x > maxX) maxX = x;
            if (y < minY) minY = y; if (y > maxY) maxY = y;
            if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
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

function emptyMesh(): MeshData {
    return {
        positions: new Float32Array(),
        normals: new Float32Array(),
        indices: new Uint32Array(),
        edgeIndices: new Uint32Array(),
        bounds: { min: [0, 0, 0], max: [0, 0, 0] },
    };
}

/**
 * polygon-clipping.difference の結果 (= 0+ の polygon ピース) を yBottom..yTop
 * の高さで押し出して、1 つの MeshData に統合する。
 * 各ピースの outer ring (CCW) を上から見た時の +Y 法線で天井、 -Y で床を組み、
 * 側面は ring の各エッジから 4 頂点 quad を作る。
 */
function buildExtrudedPiecesMesh(
    pieces: Ring[][],
    yBottom: number,
    yTop: number,
): MeshData {
    const positions: number[] = [];
    const normals: number[] = [];
    const indices: number[] = [];
    const edges: number[] = [];

    const addTri = (p0: Vec3, p1: Vec3, p2: Vec3) => {
        const idx0 = positions.length / 3;
        positions.push(...p0, ...p1, ...p2);
        const v1 = vec3.subtract(vec3.create(), p1, p0);
        const v2 = vec3.subtract(vec3.create(), p2, p0);
        const n = vec3.cross(vec3.create(), v1, v2);
        vec3.normalize(n, n);
        for (let i = 0; i < 3; i++) normals.push(...n);
        indices.push(idx0, idx0 + 1, idx0 + 2);
    };
    const addEdge = (p0: Vec3, p1: Vec3) => {
        const i0 = positions.length / 3;
        positions.push(...p0);
        normals.push(0, 1, 0);
        const i1 = positions.length / 3;
        positions.push(...p1);
        normals.push(0, 1, 0);
        edges.push(i0, i1);
    };

    for (const piece of pieces) {
        const ring = piece[0];
        if (!ring || ring.length < 4) continue;
        // ring は末尾 = 先頭で閉じている。open list で扱う。
        const open: Pair[] = ring.slice(0, -1);
        // 上面 (earcut, +Y 法線) — earcut の出力は CCW なので CW に反転して +Y。
        const flat: number[] = [];
        for (const p of open) flat.push(p[0], p[1]);
        const tris = earcut(flat, undefined, 2);
        for (let i = 0; i < tris.length; i += 3) {
            const a = tris[i], b = tris[i + 1], c = tris[i + 2];
            const pa: Vec3 = [open[a][0], yTop, open[a][1]];
            const pb: Vec3 = [open[b][0], yTop, open[b][1]];
            const pc: Vec3 = [open[c][0], yTop, open[c][1]];
            addTri(pc, pb, pa); // reverse → +Y
        }
        // 下面 (-Y) は元の winding のままで -Y 法線。
        for (let i = 0; i < tris.length; i += 3) {
            const a = tris[i], b = tris[i + 1], c = tris[i + 2];
            const pa: Vec3 = [open[a][0], yBottom, open[a][1]];
            const pb: Vec3 = [open[b][0], yBottom, open[b][1]];
            const pc: Vec3 = [open[c][0], yBottom, open[c][1]];
            addTri(pa, pb, pc);
        }
        // 側面 (ring の各エッジから 4 頂点 quad)。CCW ring なら外向き法線。
        for (let i = 0; i < open.length; i++) {
            const j = (i + 1) % open.length;
            const a: Vec3 = [open[i][0], yBottom, open[i][1]];
            const b: Vec3 = [open[j][0], yBottom, open[j][1]];
            const at: Vec3 = [open[i][0], yTop, open[i][1]];
            const bt: Vec3 = [open[j][0], yTop, open[j][1]];
            // 2 三角形 (a, at, bt) + (a, bt, b)
            addTri(a, at, bt);
            addTri(a, bt, b);
            // シルエット用エッジ
            addEdge(a, b);
            addEdge(at, bt);
            addEdge(a, at);
        }
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
