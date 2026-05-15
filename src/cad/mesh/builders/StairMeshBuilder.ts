// 階段の 3D メッシュ生成 (面分割版 / waist slab 形状)。
//
// ● 形状方針 (添付参考画像準拠):
//   - 階段本体は「ウエストスラブ」型 = 下面は **単一斜面** にカット。
//     段ごとにタワー状の立方体を積み上げる方式は廃止。
//   - 各段の **踏面** (tread)、**蹴面** (riser)、両 **側面** (side)、
//     **背面** (back, 上階接続部)、**底面** (underside, 斜面) を
//     それぞれ独立したポリゴンとして emit する (= 共通頂点を共有しない)。
//   - 法線は面ごとに固定 (= ハードシェード)。エッジも面ごとに 4 本ずつ。
//
// ● ローカル座標系:
//   - X: 上り進行方向 (= startDirection)。+X 側が上り。
//   - Y: 鉛直 (= 重力方向の逆)。
//   - Z: 幅方向。
//   - 1 段目下端の **手前下角** をローカル原点 (0, 0, 0) とする。
//
// ● サイドプロファイル (XY 平面、CCW):
//     1. (0, 0)              手前下 (= 1 段目蹴面の下端 = 床面)
//     2. (Nd, Nh-t)          奥下   (= 上階床 - 階段スラブ厚 t = 斜面終端)
//     3. (Nd, Nh)            奥上   (= 上階床縁 = 最上段踏面奥)
//     4. ((N-1)d, Nh)        最上段踏面の手前
//     5. ((N-1)d, (N-1)h)    最上段蹴面の下端
//     6. ((N-2)d, (N-1)h)
//     7. ((N-2)d, (N-2)h)
//     ...
//     (0, h)                 1 段目踏面の手前
//   閉じて (0, 0) へ戻る。1→2 が斜め下面、2→3 が背面、3→終端が階段段
//   テッセレーション、終端→1 が前面 (= 1 段目蹴面)。
//
// ● U 字階段:
//   - flight 1 を上記方針で +X 方向に emit。
//   - 中間踊り場を 6 面ボックスで emit。
//   - flight 2 を **X 反転** (= flipX = -1) で emit して -X 方向に登らせる。
//   - 法線は flipX に応じて X 成分を反転、ポリゴン winding は反転側でも
//     正しく見えるよう noCull: true 前提で emit (Slab と同じ思想)。

import earcut from "earcut";
import { MeshData, AABB } from "../MeshData";
import type { Vec3 } from "../../geometry/math/Vec3";
import type {
    StairElement,
    StairAlignment,
    TwoQuarterTurnLandingStairExtras,
} from "../../model/elements/StairElement";
import { deriveStairValues } from "../../utils/stairCalc";

// ── 蓄積バッファ ─────────────────────────────────────────────
interface MeshAccum {
    positions: number[];
    normals: number[];
    indices: number[];
    edges: number[];
}

// ── 1 つの平面ポリゴン (4 頂点 quad) を emit ─────────────────────
// verts は CCW で 4 点 (= 1 つの quad)。法線 ns は全頂点共通。
function emitQuad(
    verts: [Vec3, Vec3, Vec3, Vec3],
    ns: Vec3,
    out: MeshAccum,
): void {
    const off = out.positions.length / 3;
    for (const v of verts) {
        out.positions.push(v[0], v[1], v[2]);
        out.normals.push(ns[0], ns[1], ns[2]);
    }
    // 2 三角形 (CCW)
    out.indices.push(off, off + 1, off + 2, off, off + 2, off + 3);
    // 4 辺をワイヤフレームエッジとして emit (各エッジ 1 本ずつ)
    out.edges.push(off, off + 1, off + 1, off + 2, off + 2, off + 3, off + 3, off);
}

// ── earcut で任意 N 角形ポリゴンを三角形化して emit ─────────────────
// verts は (CCW or CW) 平面上の頂点列。各頂点は 3D 位置で渡し、平面は
// 法線 ns に直交するものとする (= verts は同一平面上にあること)。
// winding が法線と整合しなくても面ごと法線指定なので最終的にはハード
// シェードで描かれる (noCull 前提)。
function emitTriangulatedPolygon(
    verts: Vec3[],
    ns: Vec3,
    /** 三角形化用 2D 投影: i 番目頂点を (a, b) に。法線 ns に直交するよう選ぶ。 */
    proj: (v: Vec3) => [number, number],
    out: MeshAccum,
): void {
    if (verts.length < 3) return;
    const flat: number[] = [];
    for (const v of verts) {
        const p = proj(v);
        flat.push(p[0], p[1]);
    }
    const tris = earcut(flat, undefined, 2);
    if (tris.length === 0) return;

    const off = out.positions.length / 3;
    for (const v of verts) {
        out.positions.push(v[0], v[1], v[2]);
        out.normals.push(ns[0], ns[1], ns[2]);
    }
    for (let i = 0; i < tris.length; i += 3) {
        out.indices.push(off + tris[i], off + tris[i + 1], off + tris[i + 2]);
    }
    // ポリゴン外周をエッジとして emit (= シルエット線)
    for (let i = 0; i < verts.length; i++) {
        const a = i;
        const b = (i + 1) % verts.length;
        out.edges.push(off + a, off + b);
    }
}

// ── サイドプロファイル (2D, CCW) ─────────────────────────────────
// riserCount=N、treadDepth=d、riserHeight=h、waistThickness(垂直)=t。
// 戻り値は [x, y] 配列。
function buildSideProfile2D(
    N: number, d: number, h: number, t: number,
): [number, number][] {
    const Nd = N * d;
    const Nh = N * h;
    const tClamped = Math.max(0.01, Math.min(t, Nh - 0.01)); // 上階突き抜け防止
    const pts: [number, number][] = [];
    pts.push([0, 0]);             // 1: 手前下
    pts.push([Nd, Nh - tClamped]); // 2: 奥下 (斜面終端)
    pts.push([Nd, Nh]);            // 3: 奥上 (= 上階床縁)
    // 階段段 (CCW で左下方向へ stepping)
    // 最上段踏面手前 → 最上段蹴面下 → 1 段下の踏面手前 → 1 段下の蹴面下 ...
    for (let k = N; k >= 1; k--) {
        // 踏面手前 ((k-1)*d, k*h)
        pts.push([(k - 1) * d, k * h]);
        if (k > 1) {
            // 蹴面下 ((k-1)*d, (k-1)*h)
            pts.push([(k - 1) * d, (k - 1) * h]);
        }
        // k=1 では (0, 0) に戻る (= ループ閉じ用なので push しない)
    }
    return pts;
}

// ── 1 フライト分の各面ポリゴンを emit ────────────────────────────
//
// 引数:
//   N, d, h, W: 段数 / 踏面 / 蹴上 / 幅
//   t:          ウエストスラブ厚 (背面位置の垂直高さ Nh - t に底面が到達)
//   nosing:     段鼻の出 (踏面前方への張り出し量)
//   xOrigin:    ローカル X=0 を世界 X (= 階段ローカル) のどこに置くか
//   yOrigin:    ローカル Y=0 を世界 Y のどこに置くか (= flight 開始高さ)
//   zOrigin:    ローカル Z=0 を世界 Z のどこに置くか
//   flipX:      +1 で +X 方向に登る、-1 で -X 方向に登る (= flight 2)
//
// 注意: flipX = -1 でも法線・winding は内部で適切に反転して emit する。
function emitFlightFaces(
    N: number, d: number, h: number, W: number,
    t: number, nosing: number,
    xOrigin: number, yOrigin: number, zOrigin: number,
    flipX: 1 | -1,
    out: MeshAccum,
    /**
     * U 字階段で flight 1 の背面 (= 踊り場と接合する内部界面) を skip するため
     * のフラグ。skip するとそこには面が emit されないので、踊り場側の手前面
     * (matching position) も同じ Z 範囲を skip する必要がある (= 結合体の
     * 内部界面はどちらも emit しないことで Z-fighting と二重描画を防ぐ)。
     */
    skipBack: boolean = false,
): void {
    if (N < 1 || d <= 0 || h <= 0 || W <= 0) return;
    const Nd = N * d;
    const Nh = N * h;
    const tClamped = Math.max(0.01, Math.min(t, Nh - 0.01));

    // ローカル(x,y,z) → 世界(stair-local 座標)変換。
    const X = (x: number) => xOrigin + flipX * x;
    const Y = (y: number) => yOrigin + y;
    const Z = (z: number) => zOrigin + z;

    // ── 踏面 (Tread) × N: 各段の水平面 (法線 +Y) ───────────────
    for (let k = 1; k <= N; k++) {
        const y = Y(k * h);
        const x1 = (k - 1) * d;
        // 段鼻の出は最終段以外に適用 (最終段は上階床と一致)
        const x2 = k * d + (k < N ? nosing : 0);
        // CCW (上から見て): (x1,z=0)→(x2,z=0)→(x2,z=W)→(x1,z=W)
        // flipX=-1 では X の順が反転するので、winding を保つため順序入れ替え。
        const verts: [Vec3, Vec3, Vec3, Vec3] = flipX === 1 ? [
            [X(x1), y, Z(0)],
            [X(x2), y, Z(0)],
            [X(x2), y, Z(W)],
            [X(x1), y, Z(W)],
        ] : [
            [X(x2), y, Z(0)],
            [X(x1), y, Z(0)],
            [X(x1), y, Z(W)],
            [X(x2), y, Z(W)],
        ];
        emitQuad(verts, [0, 1, 0], out);
    }

    // ── 蹴面 (Riser) × N: 各段前面の垂直面 (法線 -X、flipX=-1 で +X) ──
    const riserNx: Vec3 = flipX === 1 ? [-1, 0, 0] : [1, 0, 0];
    for (let k = 1; k <= N; k++) {
        const x = (k - 1) * d;
        const yBot = Y((k - 1) * h);
        const yTop = Y(k * h);
        const verts: [Vec3, Vec3, Vec3, Vec3] = flipX === 1 ? [
            [X(x), yBot, Z(0)],
            [X(x), yTop, Z(0)],
            [X(x), yTop, Z(W)],
            [X(x), yBot, Z(W)],
        ] : [
            [X(x), yBot, Z(W)],
            [X(x), yTop, Z(W)],
            [X(x), yTop, Z(0)],
            [X(x), yBot, Z(0)],
        ];
        emitQuad(verts, riserNx, out);
    }

    // ── 背面 (Back): 上階側の垂直面 (= 最上段奥の小さな垂直面) ──
    // x = Nd の Y∈[Nh-t, Nh] × Z∈[0, W]。
    // U 字階段の flight 1 では skipBack=true で省略 (= 踊り場と内部接合)。
    const backNx: Vec3 = flipX === 1 ? [1, 0, 0] : [-1, 0, 0];
    if (!skipBack) {
        const x = Nd;
        const yBot = Y(Nh - tClamped);
        const yTop = Y(Nh);
        const verts: [Vec3, Vec3, Vec3, Vec3] = flipX === 1 ? [
            [X(x), yBot, Z(0)],
            [X(x), yBot, Z(W)],
            [X(x), yTop, Z(W)],
            [X(x), yTop, Z(0)],
        ] : [
            [X(x), yBot, Z(W)],
            [X(x), yBot, Z(0)],
            [X(x), yTop, Z(0)],
            [X(x), yTop, Z(W)],
        ];
        emitQuad(verts, backNx, out);
    }

    // ── 底面 (Underside, 斜面): (0,0) → (Nd, Nh-t) を頂点に持つ斜め長方形 ──
    // 2D 方向ベクトル (Nd, Nh-t)。外向き法線は CW 90° 回転 = (Nh-t, -Nd)。
    // 正規化して 3D 法線 (Nx, Ny, 0) に。
    {
        const dx2 = Nd, dy2 = Nh - tClamped;
        const ulen = Math.hypot(dx2, dy2) || 1;
        // 外向き (= ポリゴン手前 / 下向き) 法線
        let nx = dy2 / ulen;
        let ny = -dx2 / ulen;
        // flipX=-1 では X 反転 → 法線 X も反転
        if (flipX === -1) nx = -nx;
        const ns: Vec3 = [nx, ny, 0];
        const yBot = Y(0);
        const yTopBack = Y(Nh - tClamped);
        const verts: [Vec3, Vec3, Vec3, Vec3] = flipX === 1 ? [
            [X(0), yBot, Z(0)],
            [X(Nd), yTopBack, Z(0)],
            [X(Nd), yTopBack, Z(W)],
            [X(0), yBot, Z(W)],
        ] : [
            [X(Nd), yTopBack, Z(0)],
            [X(0), yBot, Z(0)],
            [X(0), yBot, Z(W)],
            [X(Nd), yTopBack, Z(W)],
        ];
        emitQuad(verts, ns, out);
    }

    // ── 側面 (Side) × 2: 階段の左右側面。フル 2D プロファイルを earcut で
    //   三角形化、Z=0 と Z=W の 2 枚を emit。法線は ±Z。
    const profile2D = buildSideProfile2D(N, d, h, t);
    // 左側 (Z = 0、法線 -Z)
    {
        const verts3D: Vec3[] = profile2D.map(([px, py]) =>
            [X(px), Y(py), Z(0)] as Vec3);
        // flipX=-1 では平面上での winding が反転するため、頂点列を逆順に
        // しないと earcut が裏向き三角形を吐く。
        if (flipX === -1) verts3D.reverse();
        emitTriangulatedPolygon(
            verts3D,
            [0, 0, -1],
            (v) => [v[0], v[1]],
            out,
        );
    }
    // 右側 (Z = W、法線 +Z)
    {
        const verts3D: Vec3[] = profile2D.map(([px, py]) =>
            [X(px), Y(py), Z(W)] as Vec3);
        if (flipX === 1) verts3D.reverse();  // 反対側は CW (内側から見て CCW)
        emitTriangulatedPolygon(
            verts3D,
            [0, 0, 1],
            (v) => [v[0], v[1]],
            out,
        );
    }
}

// ── U 字階段の踊り場ボックスを emit。
//   フライト 1 は手前面 (-X) の Z=[zCut0, zCut1] 範囲を覆うので、その範囲を
//   skip。手前面は [zMin, zCut0] と [zCut1, zMax] の 2 枚に分割して emit する
//   (フライト 1 が完全に覆う = [zMin, zMax] = [zCut0, zCut1] なら手前面ゼロ枚)。
// ─────────────────────────────────────────────────────────────
function emitLandingBoxWithCut(
    minX: number, maxX: number,
    minY: number, maxY: number,
    minZ: number, maxZ: number,
    nearCutZ0: number, nearCutZ1: number,
    out: MeshAccum,
): void {
    // +Y (上 = 踊り場床)
    emitQuad([
        [minX, maxY, minZ], [maxX, maxY, minZ], [maxX, maxY, maxZ], [minX, maxY, maxZ],
    ], [0, 1, 0], out);
    // -Y (下 = 踊り場下面)
    emitQuad([
        [minX, minY, maxZ], [maxX, minY, maxZ], [maxX, minY, minZ], [minX, minY, minZ],
    ], [0, -1, 0], out);
    // +X (奥 / 上階側)
    emitQuad([
        [maxX, minY, minZ], [maxX, minY, maxZ], [maxX, maxY, maxZ], [maxX, maxY, minZ],
    ], [1, 0, 0], out);
    // -X (手前 / フライト 1 接続側) — Z 範囲をフライト 1 でカット。
    // 露出部分 1: Z=[minZ, nearCutZ0]
    if (nearCutZ0 > minZ + 1e-9) {
        emitQuad([
            [minX, minY, nearCutZ0], [minX, minY, minZ], [minX, maxY, minZ], [minX, maxY, nearCutZ0],
        ], [-1, 0, 0], out);
    }
    // 露出部分 2: Z=[nearCutZ1, maxZ]
    if (maxZ > nearCutZ1 + 1e-9) {
        emitQuad([
            [minX, minY, maxZ], [minX, minY, nearCutZ1], [minX, maxY, nearCutZ1], [minX, maxY, maxZ],
        ], [-1, 0, 0], out);
    }
    // +Z (奥背)
    emitQuad([
        [minX, minY, maxZ], [minX, maxY, maxZ], [maxX, maxY, maxZ], [maxX, minY, maxZ],
    ], [0, 0, 1], out);
    // -Z (手前背)
    emitQuad([
        [maxX, minY, minZ], [maxX, maxY, minZ], [minX, maxY, minZ], [minX, minY, minZ],
    ], [0, 0, -1], out);
}

// ── 6 面ボックスを emit (汎用、共有頂点なし) ───────────────────
function emitBox(
    minX: number, maxX: number,
    minY: number, maxY: number,
    minZ: number, maxZ: number,
    out: MeshAccum,
): void {
    // +Y (上)
    emitQuad([
        [minX, maxY, minZ], [maxX, maxY, minZ], [maxX, maxY, maxZ], [minX, maxY, maxZ],
    ], [0, 1, 0], out);
    // -Y (下)
    emitQuad([
        [minX, minY, maxZ], [maxX, minY, maxZ], [maxX, minY, minZ], [minX, minY, minZ],
    ], [0, -1, 0], out);
    // +X (右)
    emitQuad([
        [maxX, minY, minZ], [maxX, minY, maxZ], [maxX, maxY, maxZ], [maxX, maxY, minZ],
    ], [1, 0, 0], out);
    // -X (左)
    emitQuad([
        [minX, minY, maxZ], [minX, minY, minZ], [minX, maxY, minZ], [minX, maxY, maxZ],
    ], [-1, 0, 0], out);
    // +Z (奥)
    emitQuad([
        [minX, minY, maxZ], [minX, maxY, maxZ], [maxX, maxY, maxZ], [maxX, minY, maxZ],
    ], [0, 0, 1], out);
    // -Z (手前)
    emitQuad([
        [maxX, minY, minZ], [maxX, maxY, minZ], [minX, maxY, minZ], [minX, minY, minZ],
    ], [0, 0, -1], out);
}

// ── referenceLine から幅方向 Z シフトを取得 ─────────────────────
// flight 1 (= U 字でも幅起点フライト) を z ∈ [zShift, zShift+W] に置く。
function widthZShift(
    width: number, ref: StairAlignment,
    isUShape: boolean, totalUWidth: number,
): number {
    if (isUShape) {
        switch (ref) {
            case "left":   return 0;
            case "right":  return -totalUWidth;
            case "center":
            default:       return -totalUWidth / 2;
        }
    } else {
        switch (ref) {
            case "left":   return 0;
            case "right":  return -width;
            case "center":
            default:       return -width / 2;
        }
    }
}

// ── ローカル → ワールド 変換 (回転 + 平行移動) ────────────────────
// startDirection を +X、Y はそのまま、+Z は startDirection の XZ 平面で
// 90° 反時計回り (= 右手側) とする変換。startPoint が原点に入る。
function transformInPlace(
    out: MeshAccum,
    startPoint: Vec3,
    startDirection: Vec3,
): void {
    const dx = startDirection[0];
    const dz = startDirection[2];
    const len = Math.hypot(dx, dz) || 1;
    const ux = dx / len;
    const uz = dz / len;
    const wx = -uz;
    const wz = ux;
    for (let i = 0; i < out.positions.length; i += 3) {
        const lx = out.positions[i];
        const ly = out.positions[i + 1];
        const lz = out.positions[i + 2];
        out.positions[i]     = startPoint[0] + ux * lx + wx * lz;
        out.positions[i + 1] = ly;
        out.positions[i + 2] = startPoint[2] + uz * lx + wz * lz;
    }
    for (let i = 0; i < out.normals.length; i += 3) {
        const lnx = out.normals[i];
        const lny = out.normals[i + 1];
        const lnz = out.normals[i + 2];
        out.normals[i]     = ux * lnx + wx * lnz;
        out.normals[i + 1] = lny;
        out.normals[i + 2] = uz * lnx + wz * lnz;
    }
}

// ── メインビルダー ─────────────────────────────────────────────
export class StairMeshBuilder {
    public static build(stair: StairElement): MeshData {
        const out: MeshAccum = { positions: [], normals: [], indices: [], edges: [] };
        const dvals = deriveStairValues(stair);
        const W = stair.stairWidth;

        if (stair.kind === "straight") {
            const zShift = widthZShift(W, stair.referenceLine, false, 0);
            emitFlightFaces(
                dvals.riserCount, stair.treadDepth, dvals.riserHeight, W,
                stair.waistSlabThickness, stair.nosingLength,
                /* xOrigin */ 0,
                /* yOrigin */ stair.baseElevation,
                /* zOrigin */ zShift,
                /* flipX   */ 1,
                out,
            );
        } else {
            // U 字階段: flight 1 → landing → flight 2 (= -X 方向)
            const u = stair as StairElement & TwoQuarterTurnLandingStairExtras;
            const f1 = Math.max(1, Math.min(dvals.riserCount - 1, u.flight1RiserCount));
            const f2 = Math.max(1, dvals.riserCount - f1);
            const flight1Length = f1 * u.treadDepth;
            const landingLevel = dvals.landingElevation;
            const totalUWidth = 2 * W + u.gapBetweenFlights;
            const zShift = widthZShift(W, stair.referenceLine, true, totalUWidth);

            // Flight 1: z = [zShift, zShift + W]。
            // skipBack=true: 背面 (上階接続面 = 踊り場と内部接合する界面) を
            //  emit しない。代わりに踊り場の手前面が残部分を担当 (= 内部界面
            //  の Z-fighting と二重描画を防ぐ)。
            emitFlightFaces(
                f1, u.treadDepth, dvals.riserHeight, W,
                u.waistSlabThickness, u.nosingLength,
                /* xOrigin */ 0,
                /* yOrigin */ stair.baseElevation,
                /* zOrigin */ zShift,
                /* flipX   */ 1,
                out,
                /* skipBack */ true,
            );

            // 踊り場: 6 面ボックス。X=[flight1Length, flight1Length+landingDepth]、
            //  Y=[landingLevel - landingSlabThickness, landingLevel]、
            //  Z=[zShift, zShift + 2W + gap]。
            // 手前面 (-X) は flight 1 が覆う Z=[zShift, zShift+W] を skip し、
            //  露出部分 (= flight 1 と gap の外側) のみ emit する。
            const lx0 = flight1Length;
            const lx1 = flight1Length + u.landingDepth;
            const ly0 = landingLevel - Math.max(0.05, u.landingSlabThickness);
            const ly1 = landingLevel;
            const lz0 = zShift;
            const lz1 = zShift + totalUWidth;
            emitLandingBoxWithCut(
                lx0, lx1, ly0, ly1, lz0, lz1,
                /* nearCutZ0 */ zShift,
                /* nearCutZ1 */ zShift + W,
                out,
            );

            // Flight 2: フライト 1 の終端 (= flight1Length) を **そのまま** 開始
            //  X とし、Z 方向 (= 横) にのみスライドして配置する (= "ハサミ"
            //  配置の U 字階段)。flight 2 は -X 方向に登るので、
            //   - 1 段目蹴面が X=flight1Length に立つ
            //   - 上階接続 (背面) が X=flight1Length - flight2Length に来る
            //   - flight 1 と X 範囲が重なるが、Z が異なる (= flight2 z origin
            //     = zShift + W + gap) ため空間衝突はなし。
            //  踊り場 (X=[flight1Length, flight1Length+landingDepth]) は flight 2
            //  の "前方" (+X 側) に水平な張り出しとして残る = 折返し時の
            //  足場として機能。
            emitFlightFaces(
                f2, u.treadDepth, dvals.riserHeight, W,
                u.waistSlabThickness, u.nosingLength,
                /* xOrigin */ flight1Length,
                /* yOrigin */ landingLevel,
                /* zOrigin */ zShift + W + u.gapBetweenFlights,
                /* flipX   */ -1,
                out,
            );

            // turnDirection が "left" なら全体の Z 符号を反転 (= 鏡像配置)。
            if (u.turnDirection === "left") {
                for (let i = 2; i < out.positions.length; i += 3) {
                    out.positions[i] = -out.positions[i];
                }
                for (let i = 2; i < out.normals.length; i += 3) {
                    out.normals[i] = -out.normals[i];
                }
            }
        }

        // ローカル → ワールド (startPoint, startDirection 適用)
        transformInPlace(out, stair.startPoint, stair.startDirection);

        // AABB 計算
        let minX = Infinity, minY = Infinity, minZ = Infinity;
        let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
        for (let i = 0; i < out.positions.length; i += 3) {
            const x = out.positions[i], y = out.positions[i + 1], z = out.positions[i + 2];
            if (x < minX) minX = x; if (x > maxX) maxX = x;
            if (y < minY) minY = y; if (y > maxY) maxY = y;
            if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
        }
        if (!isFinite(minX)) return emptyMesh();
        const bounds: AABB = { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] };

        return {
            positions: new Float32Array(out.positions),
            normals: new Float32Array(out.normals),
            indices: new Uint32Array(out.indices),
            edgeIndices: new Uint32Array(out.edges),
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
