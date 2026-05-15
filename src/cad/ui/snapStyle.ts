/**
 * スナップシンボルの統一スタイル定義。
 * SnapSymbolOverlay / OriginOverlay / GridAxisGuideOverlay /
 * RoomSketchOverlay / Viewport の全モードが参照する。
 */

// ── CSS 文字列カラー (SVG オーバーレイ用) ─────────────────────────────────
/** オブジェクトスナップ (端点・格子交点) マーカーの塗り色 */
export const SNAP_OBJ_COLOR       = "rgb(25,204,102)";
/** 軸整列スナップ マーカーの塗り色 */
export const SNAP_AXIS_COLOR      = "rgb(51,191,242)";
/** スナップマーカー共通ストローク色 */
export const SNAP_STROKE_COLOR    = "#ffffff";
/** 軸整列ガイド線 / 距離ラベルの色 (sky-600) */
export const SNAP_GUIDE_COLOR     = "rgb(2,132,199)";
/** ガイドラベルのテキストハロー色 */
export const SNAP_GUIDE_TEXT_HALO = "rgba(255,255,255,0.85)";

// ── 原点シンボル色 ───────────────────────────────────────────────────────
/** ワールド +X 軸 (red-500) */
export const ORIGIN_X_COLOR    = "#ef4444";
/** ワールド +Z 軸 (green-500) */
export const ORIGIN_Z_COLOR    = "#22c55e";
/** 原点ドット塗り */
export const ORIGIN_DOT_FILL   = "#ffffff";
/** 原点ドットストローク */
export const ORIGIN_DOT_STROKE = "#505050";

// ── ポーラーガイド線色 (WallPath モード) ─────────────────────────────────
/** 45° ポーラーガイド線 (非アクティブ・薄いアンバー) */
export const POLAR_GUIDE_COLOR  = "rgba(251,191,36,0.35)";
/** アクティブな 45° ポーラーレイ (オレンジ) */
export const POLAR_ACTIVE_COLOR = "rgba(251,146,60,0.88)";

// ── サイズ ────────────────────────────────────────────────────────────────
/** スナップマーカーの半径 / half-extent (CSS px)。
 *  SVG の rect offset (x={-HALF} width={HALF*2}) と
 *  WebGPU SketchMarker の radius の両方に使う。→ 表示サイズ 16×16px */
export const SNAP_MARKER_HALF    = 8;
/** スナップマーカーのストローク幅 */
export const SNAP_STROKE_WIDTH   = 1.5;
/** 軸整列ガイド線の幅 */
export const SNAP_GUIDE_WIDTH    = 1;
/** 軸整列ガイド線のダッシュパターン */
export const SNAP_GUIDE_DASH     = "4 3";
/** 原点軸線の長さ (CSS px) */
export const ORIGIN_AXIS_LEN_PX  = 30;
/** 原点ドットの半径 */
export const ORIGIN_DOT_RADIUS   = 4;
/** 原点シンボルのストローク幅 */
export const ORIGIN_STROKE_WIDTH = 1.5;

// ── ラベルフォント ────────────────────────────────────────────────────────
export const SNAP_LABEL_FONT_SIZE   = 11;
export const SNAP_LABEL_FONT_WEIGHT = 600;
export const SNAP_LABEL_FONT_FAMILY = "ui-sans-serif, system-ui, sans-serif";
/** ガイドラベルのハローストローク幅 */
export const SNAP_LABEL_HALO_WIDTH  = 3;

// ── RGBA float タプル (WebGPU / SketchMarker 用) ─────────────────────────
export type RGBA4 = [number, number, number, number];

/** オブジェクトスナップ塗り (緑) */
export const SNAP_RGBA_OBJ:          RGBA4 = [25  / 255, 204 / 255, 102 / 255, 1.0];
/** 軸整列スナップ塗り (水色) */
export const SNAP_RGBA_AXIS:         RGBA4 = [51  / 255, 191 / 255, 242 / 255, 1.0];
/** 白ストローク */
export const SNAP_RGBA_WHITE:        RGBA4 = [1, 1, 1, 1];
/** ポーラーガイド (暗めのアンバー) */
export const SNAP_RGBA_POLAR_GUIDE:  RGBA4 = [251 / 255, 191 / 255,  36 / 255, 0.35];
/** アクティブなポーラーレイ (オレンジ) */
export const SNAP_RGBA_POLAR_ACTIVE: RGBA4 = [251 / 255, 146 / 255,  60 / 255, 0.88];

// ── 原点シンボル RGBA (WebGPU / SketchLine 用) ────────────────────────────
/** ワールド +X 軸 (red-500) */
export const ORIGIN_RGBA_X:          RGBA4 = [239 / 255,  68 / 255,  68 / 255, 1.0];
/** ワールド +Z 軸 (green-500) */
export const ORIGIN_RGBA_Z:          RGBA4 = [ 34 / 255, 197 / 255,  94 / 255, 1.0];
/** 原点ドットストローク (dark gray) */
export const ORIGIN_RGBA_DOT_STROKE: RGBA4 = [ 80 / 255,  80 / 255,  80 / 255, 1.0];

// ── スナップ kind 別シンボル定義 ──────────────────────────────────────────
//
// スナップ対象ごとに「どの形状 / 色 / 線幅で描くか」を表で集約する。
// RoomSketchOverlay / SnapSymbolOverlay など全モードが同じ表を参照することで
// 「頂点スナップは緑のひし形」「辺スナップは緑の円」を全画面で揃える。

/** SketchMarker.shape と一致 (同名のため import せずに済む) */
export type SnapMarkerShape = "circle" | "diamond" | "square";

/**
 * スナップ種別の識別子。
 *  - "vertex": 既存ポリゴンの頂点 / 端点
 *  - "edge"  : 既存ポリゴンの辺上 (垂直投影)
 *  - "obj"   : 通芯交点 / 原点
 *  - "axis"  : 軸整列 (XY 軸へのアライメント)
 */
export type SnapKind = "vertex" | "edge" | "obj" | "axis";

export interface SnapMarkerStyle {
    shape: SnapMarkerShape;
    /** マーカー塗り色 (RGBA float タプル) */
    fillRgba: RGBA4;
    /** マーカーストローク色 (RGBA float タプル) */
    strokeRgba: RGBA4;
    /** マーカー半径 / half-extent (CSS px) */
    radius: number;
    /** ストローク幅 (CSS px) */
    strokeWidth: number;
}

/** スナップ kind ごとの描画スタイル。kind 別シンボル変更はここを編集する。 */
export const SNAP_MARKER_STYLES: Record<SnapKind, SnapMarkerStyle> = {
    vertex: {
        shape: "diamond",
        fillRgba: SNAP_RGBA_OBJ,
        strokeRgba: SNAP_RGBA_WHITE,
        radius: SNAP_MARKER_HALF,
        strokeWidth: SNAP_STROKE_WIDTH,
    },
    edge: {
        // 辺スナップは円で表現 (頂点ひし形・grid 四角と区別)。
        shape: "circle",
        fillRgba: SNAP_RGBA_OBJ,
        strokeRgba: SNAP_RGBA_WHITE,
        radius: SNAP_MARKER_HALF,
        strokeWidth: SNAP_STROKE_WIDTH + 0.5,
    },
    obj: {
        shape: "square",
        fillRgba: SNAP_RGBA_OBJ,
        strokeRgba: SNAP_RGBA_WHITE,
        radius: SNAP_MARKER_HALF,
        strokeWidth: SNAP_STROKE_WIDTH,
    },
    axis: {
        shape: "circle",
        fillRgba: SNAP_RGBA_AXIS,
        strokeRgba: SNAP_RGBA_WHITE,
        radius: SNAP_MARKER_HALF,
        strokeWidth: SNAP_STROKE_WIDTH,
    },
};

// ── グリッド作図プレビュー (WebGPU LineMeshBuilder 用、ワールド単位) ─────────
/** 確定済みセグメントの色 */
export const GRID_DRAFT_RGBA_SOLID: RGBA4 = [0.85, 0.2, 0.2, 0.9];
/** カーソル脚プレビューの色 (点線) */
export const GRID_DRAFT_RGBA_DASH:  RGBA4 = [0.85, 0.2, 0.2, 1.0];
/** ダッシュ長 (m) */
export const GRID_DRAFT_DASH_LEN_M = 0.3;
/** ギャップ長 (m) */
export const GRID_DRAFT_GAP_LEN_M  = 0.2;
