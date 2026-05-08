# IFC Web-CAD コアアーキテクチャ仕様書
Version: 1.0  
Target: VS Code AI Agents / Roo Code / Claude Code / Codex  
Language: 日本語  
Project: IFC Web-CAD

---

# 1. 目的

本仕様は、IFC Web-CAD のコアアーキテクチャを定義する。

対象:

- Category / Family / Type システム
- GeometryBuilder システム
- Type / Instance 分離
- IFC整合
- Classification 整合
- AI検索
- 2D拘束
- 柱・梁・壁の生成思想
- 軽量Family設計

本システムは、Revit の UI/UX の強みを維持しつつ、以下を改善することを目的とする。

- Family の肥大化
- 幾何とUIの密結合
- 再生成負荷
- IFC export の複雑化
- AI検索との相性の悪さ
- Web/WASMへの不適合

---

# 2. 設計原則

## 2.1 基本方針

```text
UI:
Revit型 Category → Family → Type

内部:
IFC + Classification + Procedural Geometry
```

---

## 2.2 Family軽量化

RevitのようにFamilyへ全責務を持たせない。

### Revitの問題

```text
Family
 ├ geometry
 ├ UI
 ├ parameters
 ├ formulas
 ├ visibility
 ├ materials
 ├ classification
 ├ behavior
 └ constraints
```

これにより:

- 重い
- 複雑
- 依存関係が巨大
- AI化しにくい
- IFC exportしにくい

---

## 2.3 本システムの分離

```text
Category
 └ Family (behavior only)

Type
 └ Parameters / Shape Definition

GeometryBuilder
 └ Actual Geometry

Classification
 └ External Semantics
```

---

# 3. システム階層

```text
Category
 └ Family
     └ Type
         └ Instance
```

---

# 4. Category

## 4.1 定義

Category はシステム固定の要素分類である。

```text
Category = Behavior Class
```

---

## 4.2 特徴

- システム固定
- ユーザー定義禁止
- CADの根幹
- Tool/UI切替に使用
- IFC Entity決定に使用

---

## 4.3 代表Category

```text
Wall
Beam
Column
Slab
Door
Window
Roof
Stair
Space
Grid
Level
```

---

## 4.4 Categoryで決定するもの

### Wall

- 線入力
- wall join
- space boundary
- layer handling

### Beam

- 線入力
- beam-column join
- slab alignment

### Column

- 点配置
- column stack
- grid snap

---

## 4.5 データ構造

```ts
interface Category {
  id: string;
  name: string;

  toolId: string;

  ifcEntity: string;
}
```

---

# 5. Family

## 5.1 定義

Family は振る舞いテンプレートである。

```text
Family = Behavior Template
```

---

## 5.2 Familyの役割

- Geometry generation方式
- Parameter schema
- Join behavior
- UI behavior
- Constraint behavior

---

## 5.3 代表例

### Wall

```text
BasicWall
CurtainWall
StackedWall
```

### Column

```text
RCColumn
SteelColumn
TimberColumn
```

### Door

```text
SingleDoor
SlidingDoor
DoubleDoor
```

---

## 5.4 Familyは軽量にする

### Familyに持たせないもの

- mesh
- BRep
- renderer state
- giant formulas
- nested CAD system

---

## 5.5 Familyに持つもの

```ts
interface Family {
  id: string;

  categoryId: string;

  name: string;

  geometryBuilderId: string;

  parameterSchemaId: string;

  behaviorFlags: string[];
}
```

---

# 6. Type

## 6.1 定義

Type は実データ定義である。

```text
Type = Data Definition
```

---

## 6.2 Typeの役割

- 寸法
- profile
- layer definition
- material
- fire resistance
- classification
- semantic tags

---

## 6.3 Typeは自由定義可能

ユーザー・企業・ライブラリがTypeを追加可能。

---

## 6.4 Typeはmeshを持たない

重要:

```text
Type ≠ Mesh
```

Typeは procedural definition を持つ。

---

## 6.5 柱Type例

```ts
interface ColumnType {
  id: string;

  familyId: string;

  profile: Profile;

  materialId: string;

  parameters: Parameter[];

  classificationRefs: ClassificationRef[];

  semanticTags: string[];
}
```

---

## 6.6 profile例

### Rectangle

```ts
{
  type: "Rectangle",
  width: 400,
  depth: 400
}
```

### Circle

```ts
{
  type: "Circle",
  radius: 250
}
```

### IShape

```ts
{
  type: "IShape",
  flangeWidth: 300,
  depth: 300,
  webThickness: 12,
  flangeThickness: 16
}
```

---

# 7. Instance

## 7.1 定義

Instance は実際に配置された要素である。

---

## 7.2 Instanceで持つもの

- Position
- Rotation
- Height
- Overrides
- Relation
- Join state
- Modifiers

---

## 7.3 Column Instance例

```ts
interface ColumnInstance {
  id: string;

  typeId: string;

  basePoint: Vec3;

  baseLevelId: string;

  topLevelId: string;

  baseOffset: number;

  topOffset: number;

  modifiers?: GeometryModifier[];
}
```

---

# 8. GeometryBuilder

## 8.1 定義

GeometryBuilder は:

```text
Type + Instance
↓
実際の3D形状生成
```

を行うクラスまたはモジュールである。

---

## 8.2 役割

- Procedural Geometry
- Extrusion
- Sweep
- Clipping
- Boolean
- Join適用
- LOD生成
- IFC geometry export

---

## 8.3 ColumnGeometryBuilder例

```ts
class ColumnGeometryBuilder {

  build(
    type: ColumnType,
    instance: ColumnInstance
  ): GeometryResult {

    const profile = buildProfile(type.profile);

    const solid = extrude(
      profile,
      instance.height
    );

    return solid;
  }
}
```

---

## 8.4 BeamGeometryBuilder例

```ts
class BeamGeometryBuilder {

  build(
    type: BeamType,
    instance: BeamInstance
  ): GeometryResult {

    const section = buildProfile(type.profile);

    return sweepAlongAxis(
      section,
      instance.axis
    );
  }
}
```

---

## 8.5 WallGeometryBuilder例

```ts
class WallGeometryBuilder {

  build(
    type: WallType,
    instance: WallInstance
  ): GeometryResult {

    return createLayeredWall(
      type.layers,
      instance.axis,
      instance.height
    );
  }
}
```

---

## 8.6 推奨フォルダ構成

```text
src/cad/geometry/
 ├ builders/
 │   ├ WallGeometryBuilder.ts
 │   ├ BeamGeometryBuilder.ts
 │   ├ ColumnGeometryBuilder.ts
 │   ├ SlabGeometryBuilder.ts
 │   └ DoorGeometryBuilder.ts
 │
 ├ profiles/
 ├ boolean/
 ├ topology/
 └ kernels/
```

---

# 9. IFC整合

## 9.1 基本方針

IFCは内部DBではなく交換フォーマットとして扱う。

---

## 9.2 Mapping

| Internal | IFC |
|---|---|
| Category | IfcEntity |
| Family | behavior/plugin |
| Type | IfcTypeObject |
| Instance | IfcProduct |
| Classification | IfcClassificationReference |

---

## 9.3 IFC Geometry

基本:

```text
Swept Solid 優先
```

使用:

- IfcExtrudedAreaSolid
- IfcSweptAreaSolid
- IfcBooleanResult
- IfcArbitraryClosedProfileDef

複雑時のみ:

```text
BRep fallback
```

---

# 10. Classification

## 10.1 使用分類

- Uniclass
- OmniClass
- 独自分類

---

## 10.2 Typeに保持

```ts
interface ClassificationRef {
  system: string;
  code: string;
  name: string;
}
```

---

## 10.3 例

```text
Ss_25_10_20
Pr_20_85_63
```

---

# 11. Semantic Search

## 11.1 基本思想

Type検索は:

```text
自然文
↓
トークン化
↓
parameter / tag filter
↓
ranking
```

で行う。

---

## 11.2 semanticTags

```ts
semanticTags: [
  "steel",
  "column",
  "narrow",
  "fireproof"
]
```

---

## 11.3 例

入力:

```text
細い鉄骨柱
```

変換:

```json
{
  "category": "column",
  "material": "steel",
  "width": "<300"
}
```

---

## 11.4 MVP

MVPではEmbedding不要。

```text
dictionary + filter
```

で十分。

---

# 12. 2D拘束

## 12.1 基本思想

```text
壁 = 拘束主体
梁 = 拘束補助
柱 = スナップ主体
```

---

## 12.2 壁拘束

- Horizontal
- Vertical
- Parallel
- Perpendicular
- Coincident
- OnGrid
- Length

---

## 12.3 梁拘束

- ColumnCenter
- OnGrid
- Parallel
- Perpendicular

---

## 12.4 柱拘束

- GridIntersection
- Alignment
- EqualSpacing

---

## 12.5 ソルバ

MVP:

```text
軽量局所解法
```

完全拘束ソルバは不要。

---

# 13. 柱生成思想

## 13.1 基本

```text
柱 = 点配置
```

---

## 13.2 推奨UI

```text
Category
 → Family
   → Type
      → Grid snap
         → Place
```

---

## 13.3 柱形状

```text
Type = 断面
Instance = 高さ + 位置
```

---

## 13.4 特殊加工

```text
Type
 + Modifiers
```

Modifier例:

- CornerCut
- Notch
- Chamfer
- Void

---

# 14. 梁生成思想

## 14.1 基本

```text
梁 = 線配置
```

---

## 14.2 推奨UI

```text
柱中心 snap
↓
2点指定
↓
BeamColumnJoinResolver
↓
柱面 trim
```

---

## 14.3 重要

```text
配置点 ≠ 最終端点
```

配置:

```text
柱中心
```

最終形状:

```text
柱面
```

---

# 15. 壁生成思想

## 15.1 基本

```text
壁 = 軸線 + 厚み
```

---

## 15.2 Geometry

```text
Axis
↓
Offset Faces
↓
Layered Wall
```

---

## 15.3 Join

- Butt
- Miter
- NoJoin

---

# 16. StructuralSlab思想

## 16.1 構造床

```text
階全体
壁下も含む
```

---

## 16.2 FinishFloor

```text
Spaceごと
壁内側まで
```

---

# 17. Level思想

## 17.1 基準

```text
Level = Finish Floor Level (FL)
```

---

## 17.2 構造床

```text
Levelから下方向へ
```

---

## 17.3 柱

```text
下階スラブ下面
↓
上階スラブ下面
```

---

## 17.4 梁

```text
梁上端 = スラブ下面
```

---

# 18. WASM方針

## 18.1 WASM向き

- GeometryBuilder
- Constraint Solver
- Search Engine
- IFC parser
- Spatial Index
- Boolean

---

## 18.2 Server向き

- LLM
- 学習
- 巨大Embedding

---

# 19. 推奨実装順序

## Phase 1

- Category / Family / Type
- ColumnGeometryBuilder
- WallGeometryBuilder
- BeamGeometryBuilder
- Grid
- Level

---

## Phase 2

- Wall Join
- Beam-Column Join
- Space
- StructuralSlab

---

## Phase 3

- Door / Window
- Classification
- Semantic Search
- IFC Export

---

## Phase 4

- AI Assistant
- Embedding Search
- Plugin System
- Advanced Geometry

---

# 20. AI実装指示

## 必須

- Familyへmeshを持たせない
- Typeへ完成meshを持たせない
- GeometryBuilderを分離する
- IFCは交換形式として扱う
- Categoryは固定する
- Familyはbehavior templateに限定する
- Typeはdata definitionとして扱う
- Geometryはprocedural generationする
- SweptSolidを優先する

---

## 推奨

- Rust/WASM化
- plugin化
- semantic search
- classification support
- modifier system

---

## 禁止

- Revit型巨大Family
- nested CAD system inside family
- giant parameter dependency graph
- mesh-only architecture
- IFCを内部DBとして扱うこと

---

# 21. 一言まとめ

```text
本システムでは、
Category をシステム固定、
Family を軽量behavior template、
Type を procedural shape definition とし、
GeometryBuilder により実際の形状を生成する。

これにより、IFC整合・AI検索・WASM・軽量Web-CADを
同時に成立させる。
```

