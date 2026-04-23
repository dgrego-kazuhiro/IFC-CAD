# 柱作成UI仕様書
Version: 1.0  
Target: AI coding agents  
Language: 日本語  
Project: IFC Web-CAD

---

# 1. 目的

本仕様は、IFC Web-CAD における **柱（Column）作成UI** の挙動を定義する。  
柱は「点ベース」で配置され、断面と高さ情報により生成される。

重要原則:

```text
柱は「点を置く」と生成される
```

柱は壁のような線入力ではなく、**配置点 + 断面 + 高さ拘束** によって作成する。

---

# 2. 基本思想

## 2.1 柱の本質

柱は以下の情報で定義される。

- 基準点（base point）
- 断面（profile）
- 高さ拘束（base level / top level）
- 回転
- offset

## 2.2 UIの目的

柱作成UIは、以下を高速かつ自然に行えることを目的とする。

- 単一点配置
- 通芯交点配置
- 連続配置
- 数値入力による正確配置
- 既存柱との整列
- 作成直後の編集

---

# 3. データモデル前提

```ts
interface ColumnElement {
  id: string;
  basePoint: Vec3;
  profile: Profile;
  baseLevelId: string;
  topLevelId: string;
  baseOffset: number;
  topOffset: number;
  rotation?: number;
  kind?: "Structural" | "Architectural";
  stackId?: string;
}
```

---

# 4. UI構成

柱作成UIは以下の要素で構成する。

- Toolbar の Column ツール
- Properties / Options パネル
- Viewport preview
- Snap overlay
- Bottom status / numeric input

---

# 5. ツール起動時の初期状態

Column ツール起動時に以下を持つ。

```ts
interface ColumnToolState {
  mode: "Idle" | "Preview" | "Placed" | "NumericInput" | "Cancelled";
  activeLevelId: string;
  baseLevelId: string;
  topLevelId: string;
  profile: Profile;
  baseOffset: number;
  topOffset: number;
  rotation: number;
  chainMode: boolean;
  previewPoint?: Vec3;
  snappedTo?: SnapInfo;
}
```

初期値:

- baseLevelId = activeLevelId
- topLevelId = activeLevelId の1つ上の Level（推奨）
- profile = 最後に使った profile または default type
- baseOffset = 0
- topOffset = 0
- rotation = 0

---

# 6. 作成モード

## 6.1 単一点配置モード（必須）

最も基本的な柱配置。

### フロー

```text
1. Columnツール起動
2. カーソル移動
3. preview 表示
4. クリック
5. CreateColumnCommand 実行
6. 作成された柱を選択
```

### 用途

- 単独柱
- 手動配置
- 仮配置

---

## 6.2 通芯交点配置モード（最重要）

通芯交点に柱を置くモード。

### フロー

```text
1. Columnツール起動
2. Grid intersection に snap
3. preview 表示
4. クリック
5. 柱作成
```

### 理由

実務で最も重要な配置方法の1つ。  
柱は通芯交点に置かれることが多い。

---

## 6.3 連続配置モード

同一設定で複数柱を連続配置する。

### フロー

```text
1. chainMode ON
2. クリックごとに柱作成
3. Esc / Enter で終了
```

### 用途

- 複数通芯交点に連続配置
- 柱列の作成

---

## 6.4 数値入力配置モード

座標・オフセット・回転を数値指定する。

### 入力対象

- X, Y
- 回転角
- profile 寸法
- baseLevel / topLevel
- offsets

MVP では少なくとも以下を対応:

- profile 寸法
- rotation
- base/top level

---

# 7. スナップ仕様

柱作成時の snap 対象は重要である。

## 7.1 必須 snap

- Grid intersection
- Grid line
- Existing column center
- Wall center line
- Wall face center
- Existing beam endpoint
- Existing node / point
- Cursor free point

## 7.2 推奨優先順位

1. Grid intersection
2. Existing column center
3. Existing beam endpoint
4. Grid line
5. Wall center / face
6. Free point

## 7.3 Snap 結果

```ts
interface SnapInfo {
  type: string;
  point: Vec3;
  sourceId?: string;
  priority: number;
}
```

---

# 8. Preview 仕様

配置前に preview 柱を表示する。

## 8.1 表示内容

- base point marker
- profile outline
- 柱の簡易3Dゴースト
- active base/top level
- snap marker

## 8.2 Preview の目的

- 位置の確認
- profile 向きの確認
- grid 交点整合の確認
- 高さ範囲の確認

---

# 9. Profile UI 仕様

柱は profile ベースで作る。

## 9.1 対応 profile

MVP:

- Rectangle
- Circle
- ArbitraryClosedProfile

将来:

- IShape
- TShape
- LShape
- UShape

## 9.2 UI

Column ツール起動時、Options パネルで profile を選べる。

```text
Profile Type
- Rectangle
- Circle
- Arbitrary
```

### Rectangle
- width
- depth

### Circle
- radius

### Arbitrary
- points list or separate profile editor（将来）

---

# 10. 高さ拘束 UI 仕様

## 10.1 入力項目

- Base Level
- Top Level
- Base Offset
- Top Offset

## 10.2 デフォルト

- Base Level = Active Level
- Top Level = 次の Level

## 10.3 高さの意味

柱は通常、下階スラブ下面から上階スラブ下面まで連続するが、
UI上は level + offset で扱う。

---

# 11. 回転 UI 仕様

## 11.1 必須対応

- rotation angle（度数）
- 0° をデフォルト

## 11.2 用途

- 矩形柱の向き
- 鉄骨 profile の向き

## 11.3 操作方法

- Options パネル入力
- 将来は viewport 上の回転ハンドルも可

---

# 12. Type / Instance UI 仕様

柱は Type と Instance を分ける。

## 12.1 Type 選択

ツール起動時に ColumnType を選択可能にする。

例:

- RC 400x400
- RC 600x600
- Steel H-300x300
- Circle 500

## 12.2 Instance

配置後の個別柱は instance とする。

---

# 13. 作成確定後の挙動

柱作成後:

1. CreateColumnCommand を実行
2. Tree に node を追加
3. 新規柱を selection primary にする
4. PropertiesPanel を新規柱内容に更新
5. 必要なら近傍 beam / wall / slab relation を再評価

---

# 14. 柱スタック仕様（UI観点）

上下階で同一位置・同一断面なら同一 ColumnStack とみなせる。

## 14.1 UI上の扱い

MVPでは単独柱として作成してよい。  
将来、以下を追加可能:

- 「上下に同じ柱を作成」
- 「ColumnStack に追加」
- 「全階へ複製」

---

# 15. 編集前提

作成後、以下を編集可能にする。

- base point
- profile 寸法
- rotation
- base/top level
- base/top offset
- kind
- type

---

# 16. エラーチェック

確定前に以下を検証する。

- baseLevelId / topLevelId が有効
- topLevel が baseLevel より上
- profile 寸法が正
- basePoint が有効
- offset により高さが負にならない

---

# 17. Command 連携

```ts
class CreateColumnCommand {
  execute()
  undo()
}
```

## execute 時

- ColumnElement 生成
- ModelStore へ追加
- TreeStore 更新
- SelectionStore.setSingle(newColumn)
- relation 再評価（必要最小限）

## undo 時

- 柱削除
- selection 復元または解除

---

# 18. Tree 連携

Tree では通常以下に追加する。

```text
Building
 └ Levels
    └ Level N
       └ Columns
          └ Column-001
```

### 注意

表示上は level 配下でも、モデル的には stack や relation を別管理してよい。

---

# 19. 推奨 UI フロー

## 最小MVP

- Column ツール
- profile 選択
- grid intersection snap
- click で作成
- properties edit

## 実務で強い拡張

- 連続配置
- ColumnType 選択
- 上下階複製
- 通芯交点自動候補表示

---

# 20. AI 実装指示

## 必須

- 点ベース配置にする
- Grid intersection snap を最優先で実装する
- profile + level constraint で作成する
- 作成後は即選択状態にする
- CreateColumnCommand を通して作成する

## 推奨

- chainMode
- type selector
- rotation input
- future ColumnStack support

## 禁止

- 壁のような線入力にしない
- mesh primitive を直接置くだけにしない
- level / offset を無視して profile だけで作らない

---

# 21. 一言まとめ

```text
柱作成UIは「点を置く」「通芯交点に吸着する」「断面と高さ拘束で生成する」
ことを中心に設計するのが正しい。
```
