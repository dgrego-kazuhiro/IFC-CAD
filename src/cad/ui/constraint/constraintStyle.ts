/**
 * 拘束シンボルの統一スタイル定義。
 * ConstraintIconOverlay (SVG) と DimensionOverlay (Canvas) の両方から参照する。
 */

// ── カテゴリ色 (アイコン円の背景 + 寸法線に共用) ──────────────────────────────
/** 水平 / 垂直 */
export const COLOR_DIRECTION   = "#60a5fa"; // blue-400
/** 平行 / 直交 */
export const COLOR_ORIENTATION = "#a78bfa"; // violet-400
/** 寸法系 (Length / Angle / PerpDistance / Radius) */
export const COLOR_DIMENSION   = "#fbbf24"; // amber-400
/** 位置系 (Coincident / HorizDistance / VertDistance) */
export const COLOR_POSITION    = "#f97316"; // orange-500
/** 通芯上 */
export const COLOR_POINTONGRID = "#ef4444"; // red-500
/** 円 / 弧系 */
export const COLOR_CIRCLE      = "#10b981"; // emerald-500
/** 共線 / 同長 */
export const COLOR_COLLINEAR   = "#06b6d4"; // cyan-500

// ── UI クローム ────────────────────────────────────────────────────────────
/** アイコン内グリフのテキスト色 */
export const COLOR_ICON_TEXT    = "#ffffff";
/** 選択時ハイライト */
export const COLOR_SELECTED     = "#fbbf24"; // amber-400
/** 寸法線 (SVGモード・通常) */
export const COLOR_DIM_LINE     = "#334155"; // slate-700
/** 寸法線 (SVGモード・選択時) */
export const COLOR_DIM_LINE_SEL = "#fbbf24"; // amber-400
/** 寸法ラベルテキスト (通常) */
export const COLOR_DIM_TEXT     = "#0f172a"; // slate-900
/** 寸法ラベルテキスト (選択時) */
export const COLOR_DIM_TEXT_SEL = "#92400e"; // amber-900
/** 寸法ラベル背景 */
export const COLOR_LABEL_BG     = "rgba(255,255,255,0.92)";

// ── サイズ ─────────────────────────────────────────────────────────────────
/** アイコン円の半径 (px) */
export const ICON_RADIUS        = 9;
/** 選択時の外リングの半径 (px) */
export const ICON_RADIUS_SEL    = 13;
/** アイコン・寸法ラベルのフォントサイズ (px) */
export const ICON_FONT_SIZE     = 11;
/** アイコングリフのフォントウェイト */
export const ICON_FONT_WEIGHT   = 700;
/** 共通フォントファミリ */
export const ICON_FONT_FAMILY   = "ui-sans-serif, system-ui, sans-serif";
/** 寸法ラベルの canvas font 文字列 */
export const DIM_FONT           = `bold ${ICON_FONT_SIZE}px ${ICON_FONT_FAMILY}`;
/** 寸法線の線幅 (通常) */
export const DIM_LINE_WIDTH     = 1.2;
/** 寸法線の線幅 (選択時) */
export const DIM_LINE_WIDTH_SEL = 1.6;
/** 矢頭のサイズ (px) */
export const DIM_ARROW_PX       = 9;
/** 寸法線と対象要素の距離オフセット (px) */
export const DIM_OFFSET_PX      = 44;
/** 延長線が寸法線を超えるマージン (px) */
export const DIM_EXT_EXTRA_PX   = 8;
/** PerpDistance の直角記号サイズ (px) */
export const DIM_RIGHTANGLE_PX  = 5;
/** 寸法ラベル背景パディング (px) */
export const DIM_LABEL_PAD      = 3;

// ── アイコン配置 ───────────────────────────────────────────────────────────
/** 同一セルに複数アイコンが積まれるときの水平間隔 (px) */
export const ICON_STACK_GAP_PX  = 18;
/** 衝突判定グリッドのセルサイズ (px) */
export const ICON_CELL_SIZE_PX  = 8;

// ── 拘束タイプごとの定義 ──────────────────────────────────────────────────
export interface ConstraintGlyphDef {
    /** アイコン円内に描画する Unicode 記号 */
    glyph: string;
    /** アイコン円の背景色 (= カテゴリ色) */
    color: string;
    /** ツールチップ / ラベル文字列 */
    tip: string;
}

export const CONSTRAINT_GLYPHS: Record<string, ConstraintGlyphDef> = {
    Horizontal:       { glyph: "─",  color: COLOR_DIRECTION,   tip: "水平" },
    Vertical:         { glyph: "│",  color: COLOR_DIRECTION,   tip: "垂直" },
    Parallel:         { glyph: "∥",  color: COLOR_ORIENTATION, tip: "平行" },
    Perpendicular:    { glyph: "⊥",  color: COLOR_ORIENTATION, tip: "直交" },
    Coincident:       { glyph: "●",  color: COLOR_POSITION,    tip: "点一致" },
    PointOnGrid:      { glyph: "⊕",  color: COLOR_POINTONGRID, tip: "通芯上" },
    PointOnColumn:    { glyph: "⊙",  color: COLOR_CIRCLE,      tip: "柱中心" },
    Length:           { glyph: "↔",  color: COLOR_DIMENSION,   tip: "長さ寸法" },
    Collinear:        { glyph: "≡",  color: COLOR_COLLINEAR,   tip: "共線" },
    EqualLength:      { glyph: "=",  color: COLOR_COLLINEAR,   tip: "同長" },
    Angle:            { glyph: "∠",  color: COLOR_DIMENSION,   tip: "角度" },
    PerpDistance:     { glyph: "⫯",  color: COLOR_DIMENSION,   tip: "点-辺距離" },
    Tangent:          { glyph: "⌒",  color: COLOR_CIRCLE,      tip: "接する" },
    PointOnCircle:    { glyph: "◌",  color: COLOR_CIRCLE,      tip: "円周上" },
    ConcentricCircle: { glyph: "◎",  color: COLOR_CIRCLE,      tip: "同心" },
    EqualRadius:      { glyph: "R=", color: COLOR_CIRCLE,      tip: "半径同じ" },
    CircleRadius:     { glyph: "R",  color: COLOR_DIMENSION,   tip: "半径" },
    CircleDiameter:   { glyph: "⌀",  color: COLOR_DIMENSION,   tip: "直径" },
    ArcRadius:        { glyph: "R",  color: COLOR_DIMENSION,   tip: "弧半径" },
    ArcDiameter:      { glyph: "⌀",  color: COLOR_DIMENSION,   tip: "弧直径" },
    HorizDistance:    { glyph: "↔",  color: COLOR_POSITION,    tip: "水平距離" },
    VertDistance:     { glyph: "↕",  color: COLOR_POSITION,    tip: "垂直距離" },
};
