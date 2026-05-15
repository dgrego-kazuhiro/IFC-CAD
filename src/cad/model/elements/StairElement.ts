import { BaseElement } from "../base/BaseElement";
import { Vec3 } from "../../geometry/math/Vec3";
import { ElementId } from "../base/ElementId";

// 階段種別 (Kind)。
//   - "straight":             真直ぐ上がる直階段。1 フライト。
//   - "twoQuarterTurnLanding": 90° に 2 回曲がり、間に踊り場を持つ U 字階段。
//                              IFC では TWO_QUARTER_TURN_STAIR 相当。
export type StairKind = "straight" | "twoQuarterTurnLanding";

// 踊り場での回転方向 (上りから見て左 / 右)。U 字階段専用。
export type TurnDirection = "left" | "right";

// 配置基準線。階段の startPoint をどの幅方向位置に取るかを決める。
//   - "left":   左端 (= startDirection を向いた左端、つまり -幅方向側)
//   - "center": 中心線 (= 既定)
//   - "right":  右端
export type StairAlignment = "left" | "center" | "right";

// 段数の決定方法。
//   - "auto":   ユーザは totalHeight + targetRiserHeight だけ指定し、
//               riserCount = ceil(totalHeight / targetRiserHeight) を自動計算。
//   - "manual": riserCount をユーザが直接指定。riserHeight は派生値。
export type RiserCalculationMode = "auto" | "manual";

// ── 共通パラメータ ────────────────────────────────────────────────
// 全階段に必須。直階段 / U 字階段で共有する基本寸法・配置情報。
//
// 単位は内部すべて メートル (m)。UI は mm で入力させ、ここに入る前に
// /1000 する想定 (Wall.thickness と同じ慣習)。
export interface BaseStairParams {
    /** 階段種別。 */
    kind: StairKind;

    // ── 基本寸法 ───────────────────────────────────────────────
    /** 階段開始 (= 1 段目下端) の絶対 elevation [m]。 */
    baseElevation: number;
    /** 階段終了 (= 上階床面) の絶対 elevation [m]。totalHeight = top - base。 */
    topElevation: number;
    /** 階段幅 [m]。U 字階段では片フライトの幅。 */
    stairWidth: number;
    /** 踏面寸法 (1 段の水平長さ) [m]。 */
    treadDepth: number;
    /** 蹴上寸法 (1 段の垂直高さ) [m]。riserCount から派生計算可能。 */
    riserHeight: number;
    /** 蹴上数 (= 段数)。totalHeight / riserHeight に等しい。 */
    riserCount: number;
    /** 段鼻の出 [m]。0 で段鼻なし。視覚調整のみ (構造には影響しない)。 */
    nosingLength: number;

    // ── 段数計算モード ───────────────────────────────────────────
    /** 段数を自動計算するか手動指定か。 */
    calculationMode: RiserCalculationMode;
    /** 希望蹴上高さ [m]。auto モード時に riserCount = ceil(totalHeight / target) で使用。 */
    targetRiserHeight: number;

    // ── 配置 ──────────────────────────────────────────────────
    /** 階段の開始原点 (= 1 段目下端の中心 / 左端 / 右端のいずれか referenceLine に従う)。 */
    startPoint: Vec3;
    /** 上り方向の単位ベクトル (XZ 平面)。通常 [1,0,0] や [0,0,1] 等。 */
    startDirection: Vec3;
    /** 配置基準線。startPoint がどの幅方向端を表すか。 */
    referenceLine: StairAlignment;

    // ── 構造 ──────────────────────────────────────────────────
    /** 階段スラブ (踏板) の厚み [m]。PoC では描画には未使用。 */
    waistSlabThickness: number;
    /** 踊り場スラブの厚み [m]。U 字階段専用。 */
    landingSlabThickness: number;

    // ── レベル参照 (任意) ─────────────────────────────────────
    /** 下階レベル ID (Level 要素の id)。指定時は baseElevation の参考表示用。 */
    baseLevelId?: ElementId;
    /** 上階レベル ID。 */
    topLevelId?: ElementId;
}

// ── 直階段固有パラメータ ──────────────────────────────────────────
// 派生値:
//   runLength = treadDepth * riserCount  (= 上階床縁までの水平長)
export interface StraightStairExtras {
    kind: "straight";
}

// ── U 字階段 (90° × 2 + 踊り場) 固有パラメータ ────────────────────
// 派生値:
//   flight2RiserCount = riserCount - flight1RiserCount
//   landingElevation  = baseElevation + riserHeight * flight1RiserCount
export interface TwoQuarterTurnLandingStairExtras {
    kind: "twoQuarterTurnLanding";
    /** 第1階段の蹴上数 (= 踊り場までの段数)。 */
    flight1RiserCount: number;
    /** 踊り場の奥行 [m] (= 第1階段の進行方向に対する踊り場の長さ)。 */
    landingDepth: number;
    /** 2 つの階段フライトの幅方向間隔 [m] (= 隙間 / 開口部)。 */
    gapBetweenFlights: number;
    /** 踊り場での回転方向 (上りから見て left / right)。 */
    turnDirection: TurnDirection;
}

export type StairExtras = StraightStairExtras | TwoQuarterTurnLandingStairExtras;

// ── StairElement (BaseElement 拡張) ──────────────────────────────
// パラメータは BaseStairParams (共通) + StairExtras (Kind 固有) で
// 完全に表現される。形状は StairMeshBuilder が要素から都度生成する。
export type StairElement = BaseElement & {
    type: "Stair";
    name: string;
} & BaseStairParams & StairExtras;

// 型ガード。
export function isStraightStair(s: StairElement): s is StairElement & StraightStairExtras {
    return s.kind === "straight";
}
export function isTwoQuarterTurnLandingStair(
    s: StairElement,
): s is StairElement & TwoQuarterTurnLandingStairExtras {
    return s.kind === "twoQuarterTurnLanding";
}
