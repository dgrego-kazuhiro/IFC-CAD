# IFC Web-CAD モデリング詳細仕様書（AI実装指示用）

Version: 1.0  
Target: AI coding agents / LLM implementation assistants  
Language: 日本語  
Project Type: IFC互換 Web-BIM CAD / WebGPUベース

---

## 1. 目的

本仕様書は、AIエージェントに **IFC Web-CAD のモデリング機能** を実装させるための詳細指示書である。  
本CADは **メッシュ編集CADではなく、建築要素中心のBIM CAD** として実装する。

最重要原則:

```text
Element → Topology → Geometry → Mesh → Rendering
```

メッシュは最終生成物であり、直接編集対象にしないこと。

---

## 2. モデリング基本思想

本システムのモデリングは、Fusion360型の機械CADではなく、Revit / Archicad に近い **建築要素モデリング** とする。

### 2.1 基本ルール

- 壁は「線を引く」と生成される
- スラブは「輪郭を描く」と生成される
- 柱は「断面 + 高さ」で生成される
- 梁は「軸線 + 断面」で生成される（線ベース）
- ドア・窓はホスト壁へ挿入される
- Space は壁境界から自動生成または半自動生成される
- 形状は常に要素から再生成する

### 2.2 禁止事項

- メッシュ頂点を主編集対象にしない
- 何でも generic boolean で処理しない
- UI コンポーネントの中に幾何ロジックを入れない
- Renderer の中で BIM トポロジー処理をしない

---

## 3. モデリング対象要素

### 3.1 MVPで必須

- Wall
- Column
- Beam
- Slab
- Door
- Window
- Opening
- Space
- Level

### 3.2 将来拡張

- Roof
- Stair
- Railing
- Shaft
- Zone
- GenericElement
- CustomShape

---

## 4. 要素共通仕様

すべての要素は semantic object として保持する。

```ts
interface BaseElement {
  id: string;
  type: ElementType;
  name?: string;
  visible: boolean;
  locked: boolean;
  levelId?: string;
  dirtyFlags: DirtyFlag[];
}
```

### 4.1 共通要件

- すべての要素に一意IDを持たせる
- すべての要素に可視状態を持たせる
- すべての要素にロック状態を持たせる
- すべての要素に dirty flag を持たせる
- 可能な限り Type / Instance を分離する

---

## 5. Wall モデリング詳細仕様

### 5.1 定義

Wall は以下のパラメータで定義する。

```ts
interface WallElement extends BaseElement {
  type: "Wall";
  axis: [Vec3, Vec3];
  thickness: number;
  height: number;
  baseLevelId?: string;
  topLevelId?: string;
  baseOffset: number;
  topOffset: number;
  locationLine: "Center" | "FinishExterior" | "FinishInterior" | "CoreCenter";
  joinStart: boolean;
  joinEnd: boolean;
  openings: string[];
  wallTypeId?: string;
}
```

### 5.2 作成方法

サポートする入力方式:

1. 2点指定
2. 方向 + 長さ入力
3. 連続ポリライン壁
4. 既存2D線から壁化

### 5.3 作成フロー

```text
1. Wallツール開始
2. 始点取得
3. マウス移動でプレビュー
4. 終点取得
5. 必要なら数値補正
6. 壁生成コマンド実行
7. join候補を探索
8. geometry/mesh更新
```

### 5.4 編集可能項目

- 軸線始点
- 軸線終点
- 長さ
- 厚み
- 高さ
- baseOffset
- topOffset
- locationLine
- joinStart / joinEnd
- WallType

### 5.5 join仕様

MVPでは以下のみ実装:

- Butt
- Miter
- No Join

### 5.6 幾何生成ルール

壁は以下で生成する:

```text
axis
→ 左右オフセット線
→ join補正
→ footprint polygon
→ openings反映
→ extrusion
→ surface生成
→ triangulation
```

### 5.7 注意点

- 壁は generic boolean 主体にしない
- 壁開口は区間分割再生成を優先する
- ゼロ長壁は禁止

---

## 6. Column モデリング詳細仕様

### 6.1 定義

```ts
interface ColumnElement extends BaseElement {
  type: "Column";
  profile: Profile;
  height: number;
  baseLevelId?: string;
  topLevelId?: string;
  baseOffset: number;
  topOffset: number;
  modifiers: Modifier[];
  columnTypeId?: string;
}
```

### 6.2 作成方法

- 単一点配置
- グリッド交点配置
- 連続配置
- 将来的に矩形配列配置

### 6.3 対応 profile

MVP:

- RectangleProfile
- CircleProfile
- ArbitraryClosedProfile

拡張:

- IShapeProfile
- TShapeProfile
- LShapeProfile
- UShapeProfile

### 6.4 特殊柱

特殊柱は次の順に扱う:

1. 任意2D断面押し出し
2. Modifier付き柱
3. CustomShape柱

### 6.5 Modifier 例

- Notch
- ClipPlane
- VoidBox
- TopCut
- BottomCut

### 6.6 幾何生成

```text
profile
→ extrusion
→ modifiers適用
→ final surfaces
→ triangulation
```

### 6.7 重要ルール

- 一部が欠けた柱でも semantic type は Column のまま維持する
- すぐ MeshShape に落とさない

---

## 7. Beam モデリング詳細仕様

### 7.1 定義

```ts
interface BeamElement extends BaseElement {
  type: "Beam";
  axis: [Vec3, Vec3];
  profile: Profile;
  alignment: "Center" | "Top" | "Bottom";
  modifiers: Modifier[];
  beamTypeId?: string;
}
```

### 7.2 作成方法

- 2点指定
- 柱間スナップ配置
- レベル上配置

### 7.3 対応断面

- Rectangle
- IShape
- TShape
- ArbitraryClosedProfile

### 7.4 幾何生成

```text
axis
→ local frame生成
→ profile配置
→ sweep/extrusion
→ modifiers適用
→ mesh化
```

---

## 8. Slab モデリング詳細仕様

### 8.1 定義

```ts
interface SlabElement extends BaseElement {
  type: "Slab";
  boundary: Vec2[];
  holes?: Vec2[][];
  thickness: number;
  elevation: number;
  slabTypeId?: string;
}
```

### 8.2 作成方法

- ポリライン輪郭
- 矩形
- 既存閉曲線から生成
- 壁内側輪郭から自動生成

### 8.3 編集可能項目

- 頂点位置
- 辺追加削除
- 輪郭全体移動
- 穴追加/削除
- 厚み
- elevation

### 8.4 幾何生成

```text
boundary
→ validation
→ holes反映
→ top face triangulation
→ side faces
→ bottom face
→ mesh生成
```

### 8.5 制約

- 自己交差輪郭は禁止
- 閉ループ必須

---

## 9. Door / Window モデリング詳細仕様

### 9.1 定義

```ts
interface DoorElement extends BaseElement {
  type: "Door";
  hostWallId: string;
  offsetAlongWall: number;
  width: number;
  height: number;
  sillHeight: number;
  doorTypeId?: string;
}

interface WindowElement extends BaseElement {
  type: "Window";
  hostWallId: string;
  offsetAlongWall: number;
  width: number;
  height: number;
  sillHeight: number;
  windowTypeId?: string;
}
```

### 9.2 配置ルール

- 壁がホストであること
- 壁ローカル座標系に位置を持つこと
- 壁長さ範囲内であること
- 幅・高さは正の値であること

### 9.3 作成フロー

```text
1. Door/Windowツール起動
2. 壁をホバー
3. host wall決定
4. 壁上位置をスナップ
5. プレビュー表示
6. 確定
7. host wall再生成
8. 自要素mesh再生成
```

### 9.4 壁開口処理

MVPでは generic boolean ではなく、

```text
wall segmentation
```

で処理する。

つまり:

```text
wall left segment
opening zone
wall right segment
```

に分割して壁形状を再生成する。

---

## 10. Opening モデリング詳細仕様

### 10.1 用途

- 壁開口
- スラブ開口
- シャフト
- スリーブ

### 10.2 定義

```ts
interface OpeningElement extends BaseElement {
  type: "Opening";
  hostElementId: string;
  profile?: Profile;
  boundary?: Vec2[];
  width?: number;
  height?: number;
  depth?: number;
}
```

### 10.3 ルール

- Door / Window とは別要素として存在可能
- host が必要
- host 変更時に開口形状も再評価する

---

## 11. Space モデリング詳細仕様

### 11.1 定義

```ts
interface SpaceElement extends BaseElement {
  type: "Space";
  boundary: Vec2[];
  area: number;
  height: number;
  spaceTypeId?: string;
}
```

### 11.2 作成方法

- Auto Detect
- 候補から選択
- 手動境界指定

### 11.3 Space Detection アルゴリズム

```text
walls
→ 2D projection
→ intersections split
→ planar graph
→ closed loops
→ outer loop除去
→ room polygons
→ Space elements
```

### 11.4 更新方針

壁変更時に完全自動反映ではなく、

```text
候補再生成 + ユーザー承認
```

を基本とする。

---

## 12. Level モデリング詳細仕様

### 12.1 定義

```ts
interface LevelElement extends BaseElement {
  type: "Level";
  name: string;
  elevation: number;
}
```

### 12.2 役割

- 要素の基準高さ
- 平面ビュー基準
- 表示フィルタ
- 配置面
- top/base constraint の基準

---

## 13. Roof モデリング仕様（将来または簡易実装）

### MVP最小仕様

- 輪郭あり
- 厚みあり
- 一方向勾配

### 将来拡張

- 勾配矢印
- 面ごと勾配
- 複雑屋根

---

## 14. Stair モデリング仕様（将来または簡易実装）

### MVP最小仕様

- 直階段のみ
- 開始点・終了点
- 幅
- 蹴上
- 踏面
- 段数自動

---

## 15. 特殊形状仕様

### 15.1 原則

特殊形状は **標準要素 + modifier** で表現する。

例:

```text
欠けた柱 = Column + NotchModifier
斜め端部の壁 = Wall + ClipPlaneModifier
```

### 15.2 Modifier 仕様例

```ts
type Modifier =
  | NotchModifier
  | ClipPlaneModifier
  | VoidBoxModifier
  | TopCutModifier
  | BottomCutModifier;
```

### 15.3 ルール

- 元の要素種別を失わない
- 可能なら SweptSolid / ClippingSolid の範囲で保持する
- やむを得ない場合のみ MeshShape / BrepShape に落とす

---

## 16. 自由形状仕様

### 16.1 定義

```ts
interface CustomShapeElement extends BaseElement {
  type: "CustomShape";
  shape: MeshShape | BrepShape;
  semanticType?: string;
}
```

### 16.2 用途

- 曲面屋根
- 特殊ファサード
- 複雑設備形状
- IFCからの tessellation / brep インポート

### 16.3 MVPで許可する編集

- Move
- Rotate
- Uniform scale（必要なら）
- Replace shape

### 16.4 禁止

- 最初から自由形状をモデリングの主軸にしない

---

## 17. Profile モデリング仕様

### 17.1 サポート対象

- RectangleProfile
- CircleProfile
- IShapeProfile
- TShapeProfile
- LShapeProfile
- UShapeProfile
- ArbitraryClosedProfile

### 17.2 方針

- 柱・梁はできるだけ profile-based にする
- 任意断面は polygon ベースで持つ
- 重い sketch constraint solver は MVP では不要

---

## 18. Type / Instance 仕様

### 18.1 Type

共通属性を持つテンプレート。

例:

- WallType 150mm
- ColumnType 400x400
- DoorType 900x2100

### 18.2 Instance

実配置された個体。

### 18.3 原則

- 可能なら作成時に Type を選んで Instance を配置する
- Type変更時に instance への反映方針を明確にする

---

## 19. ホスト関係仕様

### 19.1 host relations

- Door → Wall
- Window → Wall
- Opening → Wall / Slab
- Space → surrounding boundaries

### 19.2 ルール

- host が削除されたら dependent 要素を削除するか orphan 化する
- MVPでは dependent 削除でよい

---

## 20. モデリング操作状態仕様

すべてのモデリングツールは以下の状態を持つ:

- Idle
- Preview
- Confirmed
- Cancelled

### 20.1 例: 壁ツール

```text
Idle
→ FirstPointAcquired
→ Preview
→ SecondPointAcquired
→ ExecuteCommand
→ Confirmed
```

---

## 21. プレビュー仕様

### 21.1 必須表示

- 仮線
- 仮輪郭
- 仮壁厚
- 仮ドア位置
- 仮柱断面
- snap marker

### 21.2 ルール

- preview は ToolState 側で持つ
- 確定前に Model を汚染しない

---

## 22. 数値入力仕様

### 22.1 必須対応

- 長さ入力
- 角度入力（将来）
- 幅/高さ入力
- 軸ロック
- orthogonal lock

### 22.2 例

- 壁長さ 6000
- 柱寸法 400 x 400
- ドア幅 900

---

## 23. 2D / 3D モデリング関係

本CADの本質は:

```text
2D plan-based modeling + 3D visualization
```

### 23.1 2D主体要素

- Wall
- Slab
- Space
- Opening boundary

### 23.2 3D主体だが2D基準配置

- Column
- Door
- Window
- Beam

---

## 24. 制約仕様

MVPでは軽量制約のみ実装する:

- orthogonal
- parallel
- perpendicular
- same thickness
- same level
- host must exist

本格拘束ソルバは実装しない。

---

## 25. 履歴仕様

Fusion360 的な重い feature timeline は採用しない。  
履歴は command history のみ。

### 必須

- Undo
- Redo
- Transaction grouping

---

## 26. 整合性チェック仕様

確定前に以下を検証する:

- 壁軸がゼロ長でない
- スラブ輪郭が閉じている
- スラブ輪郭が自己交差しない
- ドア位置が壁長内にある
- 柱高さが正
- opening が host 範囲内である
- space boundary が有効である

エラーなら command を reject する。

---

## 27. IFC整合仕様

内部モデリング仕様は IFC に寄せること。

### 27.1 要素マッピング

- Wall → IfcWall
- Column → IfcColumn
- Beam → IfcBeam
- Slab → IfcSlab
- Door → IfcDoor
- Window → IfcWindow
- Space → IfcSpace
- Level → IfcBuildingStorey

### 27.2 shape マッピング

- profile + extrusion → IfcExtrudedAreaSolid
- clipping / cut → IfcBooleanClippingResult
- exact complex solid → IfcFacetedBrep
- freeform / imported → IfcTriangulatedFaceSet

### 27.3 重要原則

- まず SweptSolid で表せるか考える
- 次に Clipping
- それでも無理なら Brep
- 最後に Tessellation / Mesh

---

## 28. UI操作仕様（モデリングに必要な範囲）

### 28.1 ツール

- Select
- Wall
- Column
- Beam
- Slab
- Door
- Window
- Opening
- Space
- Move
- Delete

### 28.2 パネル

- ProjectTreePanel
- PropertiesPanel
- ShapePanel
- SnapPanel

### 28.3 最低限必要な表示

- plan-like view
- 3D shaded
- shaded with edges
- selection highlight
- preview overlay

---

## 29. MVP モデリング機能セット

最初に実装するべき組み合わせ:

### 作成
- Wall
- Column
- Slab
- Door
- Window
- Opening
- Space
- Level

### 編集
- Move
- Delete
- Parameter edit
- Wall join / unjoin
- Slab boundary edit
- Column profile edit

### 補助
- Snap
- Preview
- Numeric input
- Undo/Redo

---

## 30. 実装優先順位

この順序で実装すること:

1. Wall
2. Column
3. Slab
4. Door / Window
5. Opening
6. Space
7. Level relation
8. Beam
9. Roof
10. Stair
11. CustomShape

---

## 31. AIへの最終指示

AIはこのCADを、

```text
自由メッシュ編集CAD
```

として実装してはならない。

正しくは、

```text
2D / Level 基準で建築要素を配置し、
profile と modifier を使って形状を定義し、
Topology を介して Geometry を再生成し、
Mesh は最終描画データとして扱う
```

建築要素中心の IFC Web-CAD として実装すること。

---

## 32. 一言でまとめた実装原則

```text
このCADは「形を直接いじる」CADではなく、
「建築要素を定義して、その結果として形が出る」CADである。
```

