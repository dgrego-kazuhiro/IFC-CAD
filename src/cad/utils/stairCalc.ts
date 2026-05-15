// 階段パラメータの派生値計算ユーティリティ。
//
// 階段は「ユーザ入力値は最小限、残りは自動計算」が CAD として使いやすい
// (例: 階高と希望蹴上を入れれば riserCount / riserHeight が決まる)。
// この派生計算を 1 ヶ所に集めることで、StairPropertyPanel・MeshBuilder・
// CreateStairCommand 等から同一ロジックを呼び出せる。
//
// すべて純関数で副作用を持たない。

import type {
    BaseStairParams,
    RiserCalculationMode,
    StairElement,
    TwoQuarterTurnLandingStairExtras,
} from "../model/elements/StairElement";

// 安全クランプ。極端に小さい値で 0 除算等の不正状態を起こさないため。
const MIN_RISER = 1;
const MIN_TREAD = 0.05;       // 5cm 未満の踏面は実用上 NG。
const MIN_HEIGHT = 0.01;       // 1cm 未満の蹴上はクランプ。

/** totalHeight (= top - base) を計算。負値は 0 にクランプ。 */
export function computeTotalHeight(base: number, top: number): number {
    return Math.max(0, top - base);
}

/**
 * auto モード: totalHeight と targetRiserHeight から riserCount を計算。
 * manual モード: 引数 manualRiserCount をそのまま使う (1 以上にクランプ)。
 *
 * 戻り値は { riserCount, riserHeight } の組。auto / manual の差を吸収する。
 */
export function resolveRiserCount(
    mode: RiserCalculationMode,
    totalHeight: number,
    targetRiserHeight: number,
    manualRiserCount: number,
): { riserCount: number; riserHeight: number } {
    let count: number;
    if (mode === "auto") {
        const target = Math.max(MIN_HEIGHT, targetRiserHeight);
        count = Math.max(MIN_RISER, Math.ceil(totalHeight / target));
    } else {
        count = Math.max(MIN_RISER, Math.round(manualRiserCount));
    }
    const height = totalHeight > 0 ? totalHeight / count : MIN_HEIGHT;
    return { riserCount: count, riserHeight: height };
}

/**
 * 直階段の水平方向ラン長 (= 上階床縁までの距離)。
 * 慣例: runLength = treadDepth * riserCount。最上段の踏面は上階床面に
 * 一致するため、踏面数 = 蹴上数として扱う (= mesh が単純で破綻しない)。
 */
export function straightStairRunLength(treadDepth: number, riserCount: number): number {
    return Math.max(MIN_TREAD, treadDepth) * Math.max(MIN_RISER, riserCount);
}

/**
 * U 字階段の踊り場 elevation (= 第 1 フライト top の高さ)。
 *   landingElevation = baseElevation + riserHeight * flight1RiserCount
 */
export function landingElevation(
    baseElevation: number,
    riserHeight: number,
    flight1RiserCount: number,
): number {
    return baseElevation + riserHeight * Math.max(0, flight1RiserCount);
}

/** U 字階段の第 2 フライト段数 (= 全段数 - 第 1 段数)。下限 1 でクランプ。 */
export function flight2RiserCount(riserCount: number, flight1RiserCount: number): number {
    return Math.max(MIN_RISER, riserCount - Math.max(0, flight1RiserCount));
}

/**
 * 階段のすべての派生値をまとめて計算 (UI 表示・mesh 生成で使う)。
 * 入力 BaseStairParams + Kind 固有値 → 派生値オブジェクト。
 *
 * UI から「riserCount を上げたら riserHeight が下がる」「totalHeight を
 * 変えたら riserHeight が再計算される」といった連動表示を実現する。
 */
export interface DerivedStairValues {
    totalHeight: number;
    riserCount: number;
    riserHeight: number;
    /** 直階段のラン長 (U 字階段では 1 フライト分の長さ)。 */
    flight1RunLength: number;
    /** U 字階段専用: 第 2 フライトラン長。直階段では 0。 */
    flight2RunLength: number;
    /** U 字階段専用: 踊り場の絶対 elevation。直階段では topElevation と同じ。 */
    landingElevation: number;
}

export function deriveStairValues(s: StairElement | (BaseStairParams & {
    kind: StairElement["kind"];
} & Partial<TwoQuarterTurnLandingStairExtras>)): DerivedStairValues {
    const totalH = computeTotalHeight(s.baseElevation, s.topElevation);
    const { riserCount, riserHeight } = resolveRiserCount(
        s.calculationMode,
        totalH,
        s.targetRiserHeight,
        s.riserCount,
    );

    if (s.kind === "straight") {
        return {
            totalHeight: totalH,
            riserCount,
            riserHeight,
            flight1RunLength: straightStairRunLength(s.treadDepth, riserCount),
            flight2RunLength: 0,
            landingElevation: s.topElevation,
        };
    }
    // twoQuarterTurnLanding
    const f1 = Math.max(1, Math.min(riserCount - 1, s.flight1RiserCount ?? Math.ceil(riserCount / 2)));
    const f2 = flight2RiserCount(riserCount, f1);
    return {
        totalHeight: totalH,
        riserCount,
        riserHeight,
        flight1RunLength: straightStairRunLength(s.treadDepth, f1),
        flight2RunLength: straightStairRunLength(s.treadDepth, f2),
        landingElevation: landingElevation(s.baseElevation, riserHeight, f1),
    };
}
