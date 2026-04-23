# Wall Sketch 詳細仕様書
Version: 1.0
Target: AI coding agents / implementation specification
Language: 日本語

---

## 1. 目的

Wall Sketch は、Wall 要素を生成するための **2D入力用スケッチ機構**である。  
これは Fusion360 のような汎用 Sketch ではなく、**Wall 作成専用の軽量スケッチ**として設計する。

Wall Sketch の役割は、ユーザーが入力した 2D の軸線・連続線・基準情報をもとに、WallElement を生成することである。

重要原則:

```text
Wall Sketch = 汎用作図機能ではなく、Wall生成のための入力モデル
```

Wall Sketch 自体は最終モデルではない。  
最終モデルは WallElement であり、Sketch はその入力ソースまたは補助データである。

---

## 2. Wall Sketch の設計方針

### 2.1 基本思想

Wall Sketch は、以下の用途に限定する。

- 壁の軸線入力
- 壁の連続入力
- 壁輪郭生成の基準作成
- 壁の方向・長さ・接続制御
- 壁生成前のプレビュー管理

Wall Sketch は **自由な2D CAD図面編集機能**を目指さない。

---

### 2.2 禁止事項

Wall Sketch に以下を持ち込まないこと。

- 完全な拘束スケッチソルバ
- 汎用円弧/スプラインベース作図
- 複雑な寸法拘束ネットワーク
- wall 以外の要素を直接定義する責務
- mesh 生成責務

---

## 3. Wall Sketch の責務

Wall Sketch の責務は以下とする。

1. 入力点の収集
2. スナップ結果の反映
3. 軸線候補のプレビュー
4. 数値入力の反映
5. 連続壁入力の管理
6. WallElement 生成用の中間データ出力

Wall Sketch の責務ではないもの:

- 壁の最終メッシュ生成
- 壁接続の最終解決
- IFC export
- Render mesh buffer 管理

---

## 4. Wall Sketch の内部モデル

### 4.1 基本データ構造

```ts
interface WallSketchState {
  mode: WallSketchMode;
  plane: SketchPlane;
  points: Vec2[];
  segments: WallSketchSegment[];
  preview?: WallSketchPreview;
  options: WallSketchOptions;
  constraints: WallSketchConstraintState;
}
```

### 4.2 Segment 構造

```ts
interface WallSketchSegment {
  id: string;
  start: Vec2;
  end: Vec2;
  inputType: "TwoPoint" | "DirectionLength" | "Polyline";
  lockedLength?: number;
  lockedAngle?: number;
  snappedStart?: SnapInfo;
  snappedEnd?: SnapInfo;
}
```

### 4.3 Preview 構造

```ts
interface WallSketchPreview {
  currentStart?: Vec2;
  currentEnd?: Vec2;
  ghostSegments: WallSketchSegment[];
  wallThicknessPreview: number;
  locationLinePreview: WallLocationLine;
}
```

### 4.4 オプション構造

```ts
interface WallSketchOptions {
  defaultThickness: number;
  defaultHeight: number;
  locationLine: WallLocationLine;
  chainMode: boolean;
  orthoMode: boolean;
  angleSnapEnabled: boolean;
  angleSnapStepDeg: number;
  autoJoinEnabled: boolean;
  trimExtendPreviewEnabled: boolean;
}
```

### 4.5 Mode

```ts
type WallSketchMode =
  | "Idle"
  | "AwaitFirstPoint"
  | "AwaitNextPoint"
  | "Previewing"
  | "NumericInput"
  | "Confirmed"
  | "Cancelled";
```

---

## 5. スケッチ平面仕様

Wall Sketch は原則として **現在アクティブな Level の XY 平面上**で行う。

### 5.1 基本ルール

- Sketch plane は Level elevation に対応する平面
- 入力座標は 2D (Vec2) として扱う
- 3D 表示中でも内部的には level plane に投影して処理する

### 5.2 SketchPlane

```ts
interface SketchPlane {
  origin: Vec3;
  xAxis: Vec3;
  yAxis: Vec3;
  normal: Vec3;
  levelId?: string;
}
```

### 5.3 変換

- View 上の pointer 座標を plane へ ray-plane intersection で投影する
- plane 上の点を local 2D 座標に変換する
- WallElement 作成時に 3D へ戻す

---

## 6. 入力モード仕様

Wall Sketch は以下の入力モードを持つ。

### 6.1 Two Point Mode

最も基本的なモード。

操作:

```text
1. 始点クリック
2. 終点クリック
3. 1本の壁軸線を確定
```

用途:

- 単独壁
- 単純入力

---

### 6.2 Polyline Mode

連続して壁を入力するモード。

操作:

```text
1. 始点クリック
2. 次点クリック
3. 次点クリック
4. ...
5. Enter / ダブルクリック / Esc で終了
```

用途:

- 連続壁
- 室の外周線
- 間仕切りの連続入力

---

### 6.3 Direction + Length Mode

クリック後に方向を指定し、長さを数値で入れる。

操作:

```text
1. 始点クリック
2. マウスで方向決定
3. 長さ入力
4. 確定
```

用途:

- 正確な長さ指定
- 図面ベース入力

---

### 6.4 Continue From Last Mode

直前の壁終点を自動始点にする。

用途:

- 連続入力の高速化
- 壁列の作成

---

## 7. スナップ仕様

Wall Sketch では Snap が非常に重要である。

### 7.1 必須 snap 種類

- Endpoint
- Midpoint
- Intersection
- Grid
- Axis
- Existing wall axis
- Existing wall face center
- Column center
- Level reference line

### 7.2 Snap 結果構造

```ts
interface SnapInfo {
  type: SnapType;
  point: Vec2;
  sourceId?: string;
  priority: number;
}
```

### 7.3 優先順位例

1. Intersection
2. Endpoint
3. Midpoint
4. Existing axis
5. Grid
6. Free cursor point

### 7.4 挙動

- Snap 候補があれば preview 点を snap 位置へ吸着する
- Shift や Ctrl で snap 無効化可能にしてもよい
- snap marker を表示すること

---

## 8. Ortho / 角度スナップ仕様

### 8.1 Ortho Mode

Ortho Mode 有効時は入力方向を以下に制限する。

- 0°
- 90°
- 180°
- 270°

### 8.2 Angle Snap Mode

有効時は `angleSnapStepDeg` 単位で方向を量子化する。

例:

- 15°
- 30°
- 45°

### 8.3 優先順位

- 明示的寸法入力が最優先
- 次に Ortho
- 次に Angle Snap
- 最後に自由方向

---

## 9. 数値入力仕様

Wall Sketch はマウス操作だけでなく数値入力に対応する。

### 9.1 入力対象

- 長さ
- 角度
- 厚み（オプション）
- 高さ（オプション）

### 9.2 入力例

- `6000`
- `6000,90`
- `6000<45`

実装は簡略化してもよいが、少なくとも長さ入力は必須。

### 9.3 挙動

- 始点確定後に数値入力で終点を決定可能
- Polyline 中も各 segment ごとに長さ入力可能
- 数値入力中は mode を `NumericInput` に遷移させる

---

## 10. Wall Location Line 仕様

Wall は center line だけでなく、どの基準線を軸とみなすかを持つ。

### 10.1 種類

```ts
type WallLocationLine =
  | "Center"
  | "FinishExterior"
  | "FinishInterior"
  | "CoreCenter";
```

### 10.2 スケッチ上の意味

ユーザーが引く線をどの基準線として解釈するかを決定する。

### 10.3 表示

Preview 時に以下を表示する。

- 軸線
- 厚み付きプレビュー
- location line の基準位置

---

## 11. 壁厚プレビュー仕様

スケッチ中に **線だけでなく壁幅のゴースト表示** を行う。

### 11.1 表示内容

- 軸線
- 左右 offset された壁輪郭
- start/end cap preview
- join preview（可能なら）

### 11.2 目的

- 単なる2D線入力ではなく、壁としてどう建つかを視覚化する
- location line の理解を助ける
- 既存壁との干渉を把握しやすくする

---

## 12. 連続入力（Chain / Polyline）仕様

### 12.1 基本仕様

Polyline モードでは、前セグメント終点が次セグメント始点となる。

### 12.2 ルール

- 各セグメントは独立した WallElement になる
- ただし入力時点では WallSketchSegment の列として保持する
- 確定時に複数の CreateWallCommand に分解するか、TransactionCommand でまとめる

### 12.3 自動接続

chain mode 中は、連続セグメント間の join 候補を自動付与する。

### 12.4 閉ループ

閉ループ自体は許可してよいが、壁の polygon object を意味しない。  
各辺は個別 Wall として作る。

---

## 13. プレビュー状態遷移仕様

### 13.1 状態遷移

```text
Idle
→ AwaitFirstPoint
→ AwaitNextPoint
→ Previewing
→ Confirmed
```

### 13.2 詳細

- Idle: ツール未開始
- AwaitFirstPoint: 最初の点待ち
- AwaitNextPoint: 次点待ち
- Previewing: マウス移動中
- NumericInput: 数値入力中
- Confirmed: 壁作成確定
- Cancelled: キャンセル

### 13.3 Esc の扱い

- segment 未確定なら現在 preview を破棄
- polyline 中なら入力を終了または 1ステップ戻る
- 実装方針は単純でよいが一貫性を持たせる

---

## 14. 制約仕様（軽量）

MVP の Wall Sketch では軽量制約のみ実装する。

### 14.1 対応制約

- Ortho
- Angle Snap
- Parallel to existing segment
- Perpendicular to existing segment
- Coincident to snap point

### 14.2 非対応

- 完全拘束スケッチ
- 複数寸法拘束ネットワーク
- 自動 solve 必須の parametric sketch

---

## 15. 既存要素参照仕様

Wall Sketch は既存 BIM 要素を参照できる。

### 15.1 参照対象

- 既存 Wall の軸線
- 既存 Wall の端点
- 既存 Column の中心
- Grid line
- Space boundary
- Level reference

### 15.2 用途

- 壁合わせ
- 通り芯合わせ
- 柱芯合わせ
- 室境界に沿った壁配置

---

## 16. Wall Sketch から WallElement への変換仕様

### 16.1 基本ルール

WallSketchSegment 1本につき、通常は WallElement 1つを生成する。

### 16.2 変換関数イメージ

```ts
function buildWallElementFromSketchSegment(
  seg: WallSketchSegment,
  options: WallSketchOptions,
  levelId?: string
): WallElement
```

### 16.3 生成時に付与するもの

- axis
- thickness
- height
- locationLine
- joinStart / joinEnd
- levelId
- base/top offsets

### 16.4 確定単位

- 単独入力なら 1 wall command
- polyline なら transaction command

---

## 17. エラーチェック仕様

確定前に最低限以下を確認する。

### 17.1 必須チェック

- 始点と終点が一致しない
- 長さが epsilon 未満でない
- 厚みが正
- 高さが正
- plane が有効
- snap 結果が壊れていない

### 17.2 推奨警告

- 極端に短い壁
- 既存壁と完全重複
- 壁厚より短い壁
- 自己交差 polyline

---

## 18. 自動 Join 連携仕様

Wall Sketch 自体は Join の最終責任を持たないが、join のためのヒントを渡す。

### 18.1 渡すべき情報

- segment の連続順序
- chain 中の隣接関係
- segment endpoint snap source
- existing wall endpoint に吸着した情報

### 18.2 役割分担

- Wall Sketch: 入力関係を記録
- Topology / WallJoinResolver: 最終 join 判定

---

## 19. UI 表示仕様

### 19.1 画面に表示するもの

- current cursor point
- snap marker
- preview axis line
- preview thickness polygon
- current segment length
- current angle
- active location line mode
- active level

### 19.2 補助表示

- Ortho ON/OFF
- Angle snap step
- chain mode ON/OFF
- numeric input box

---

## 20. Undo / Redo 仕様

Wall Sketch の preview 操作そのものは undo 履歴に入れない。  
確定後の CreateWallCommand のみを履歴対象とする。

### 20.1 例

- マウス移動 → undo対象外
- 壁1本確定 → undo対象
- polyline 5本確定 → まとめて 1 transaction undo でも可

---

## 21. 保存仕様

Wall Sketch の一時状態は通常保存不要。  
ただし将来対応として、途中編集再開のために保存してもよい。

MVPでは:

- 確定済み WallElement のみ保存
- preview sketch state は保存不要

---

## 22. AI実装ルール

AI は Wall Sketch を以下のように実装すること。

### 22.1 必須

- Two Point wall input
- Polyline wall input
- Snap integration
- Preview thickness display
- Numeric length input
- Ortho mode
- WallElement conversion
- Command integration

### 22.2 推奨

- Angle snap
- Existing wall alignment
- Transaction command for chain input

### 22.3 禁止

- 完全な汎用2D CAD sketcher にしない
- geometry kernel の責務を sketch tool に混ぜない
- React component の中に sketch core logic を埋め込まない

---

## 23. 実装ファイル候補

```text
src/cad/ui/tools/WallTool.ts
src/cad/ui/tools/WallSketchController.ts
src/cad/ui/tools/WallSketchState.ts
src/cad/ui/tools/WallSketchPreview.ts
src/cad/snapping/SnapManager.ts
src/cad/commands/create/CreateWallCommand.ts
src/cad/commands/composite/TransactionCommand.ts
src/cad/model/elements/WallElement.ts
src/cad/topology/joins/WallJoinResolver.ts
src/cad/geometry/builders/WallGeometryBuilder.ts
```

---

## 24. 一言でまとめた仕様

```text
Wall Sketch は「壁を作るための軽量2D入力システム」であり、
汎用スケッチャではない。
入力された線は WallElement の軸線候補となり、
厚み・高さ・基準線・連続関係を伴って、
最終的に Wall 要素へ変換される。
```
