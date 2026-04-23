# 梁作成UI仕様書
Version: 1.0  
Target: AI coding agents  
Language: 日本語  
Project: IFC Web-CAD

---

# 1. 目的

本仕様は、IFC Web-CAD における **梁（Beam）作成UI** の挙動を定義する。  
梁は「線ベース」で配置され、軸線と断面、そして高さ拘束によって生成される。

重要原則:

```text
梁は「線を引く」と生成される
```

ただし壁とは異なり、梁は面要素ではなく **構造軸要素** である。

---

# 2. 基本思想

## 2.1 梁の本質

梁は以下の情報で定義される。

- 軸線（start/end）
- 断面（profile）
- 所属レベル
- 上端または中心の高さ拘束
- 回転 / justification
- 端部接合情報

## 2.2 UIの目的

梁作成UIは、以下を自然に行えることを目的とする。

- 2点指定による梁作成
- 柱間配置
- 通芯に沿った配置
- 数値入力
- 連続配置
- 作成後の端部接合解決

---

# 3. データモデル前提

```ts
interface BeamElement {
  id: string;
  axis: [Vec3, Vec3];
  profile: Profile;
  levelId: string;
  topOffset: number;
  zJustification: "Top" | "Center" | "Bottom";
  rotation?: number;
  kind?: "Structural" | "Architectural";
}
```

---

# 4. UI構成

梁作成UIは以下で構成する。

- Toolbar の Beam ツール
- Options / Properties パネル
- Viewport preview
- Snap overlay
- Numeric input / status bar

---

# 5. ツール起動時の初期状態

```ts
interface BeamToolState {
  mode: "Idle" | "AwaitFirstPoint" | "Preview" | "AwaitNextPoint" | "NumericInput" | "Confirmed" | "Cancelled";
  levelId: string;
  profile: Profile;
  topOffset: number;
  zJustification: "Top" | "Center" | "Bottom";
  rotation: number;
  chainMode: boolean;
  startPoint?: Vec3;
  previewEndPoint?: Vec3;
  snappedStart?: SnapInfo;
  snappedEnd?: SnapInfo;
}
```

初期値:

- levelId = activeLevelId
- profile = last used beam type or default
- topOffset = 0
- zJustification = "Top"
- rotation = 0

---

# 6. 作成モード

## 6.1 2点指定モード（必須）

最も基本的な梁作成。

### フロー

```text
1. Beamツール起動
2. 始点クリック
3. マウス移動で preview
4. 終点クリック
5. CreateBeamCommand 実行
```

### 用途

- 単独梁
- 手動配置
- 構造梁の基本入力

---

## 6.2 柱間配置モード（最重要）

梁端点を柱中心または柱面に基づいて配置する。

### フロー

```text
1. Beamツール起動
2. 柱中心に snap して始点取得
3. 別の柱中心に snap して終点取得
4. 梁作成
5. Beam-Column join 解決
```

### 実務的重要性

梁は柱と柱の間に配置されることが多いため、最重要モードの1つ。

---

## 6.3 通芯追従配置モード

通芯に沿って梁を作成する。

### フロー

```text
1. Grid line に snap
2. その方向に沿って始点終点を決定
3. 梁作成
```

### 用途

- 整形グリッド構造
- 通り芯ベースのフレーム生成

---

## 6.4 連続配置モード

複数梁を連続して配置する。

### フロー

```text
1. chainMode ON
2. 1本目の梁作成
3. 終点が次の始点候補になる
4. Enter / Esc で終了
```

---

## 6.5 数値入力モード

### 必須入力

- 長さ
- profile 寸法
- level
- topOffset

### 将来対応

- 角度
- 方位拘束

---

# 7. スナップ仕様

梁作成での snap は非常に重要。

## 7.1 必須 snap

- Column center
- Column face reference
- Beam endpoint
- Grid intersection
- Grid line
- Wall center line
- Wall face
- Existing node / point
- Free point

## 7.2 推奨優先順位

1. Column center
2. Beam endpoint
3. Grid intersection
4. Grid line
5. Wall face / center
6. Free point

## 7.3 注意

配置時の snap と、確定後の join trim は分けて扱う。  
例えば柱中心に snap しても、最終形状は柱面で trim する。

---

# 8. Preview 仕様

## 8.1 表示内容

- 軸線プレビュー
- profile の簡易断面ゴースト
- 3D 梁ボックス preview
- snap marker
- 梁上端高さ基準の表示

## 8.2 目的

- 梁方向の確認
- 柱との接続候補確認
- レベル・高さ整合確認
- profile 回転確認

---

# 9. Profile UI 仕様

## 9.1 対応 profile

MVP:

- Rectangle
- IShape
- ArbitraryClosedProfile

将来:

- TShape
- UShape
- LShape

## 9.2 UI

Beam ツール起動時、Options パネルで beam type / profile を選択。

### Rectangle
- width
- depth

### IShape
- flange width
- depth
- web thickness
- flange thickness

### Arbitrary
- future profile editor

---

# 10. 高さ UI 仕様

梁は通常、スラブ下面に上端を合わせる。

## 10.1 入力項目

- Level
- Top Offset
- Z Justification
- Rotation

## 10.2 推奨デフォルト

- Level = Active Level
- Z Justification = Top
- Top Offset = 0

## 10.3 意味

```text
beam top elevation = level elevation - slab thickness + topOffset
```

---

# 11. Z Justification UI

```ts
type ZJustification = "Top" | "Center" | "Bottom";
```

## 11.1 推奨

MVP では "Top" を標準とする。

### 理由

構造梁では「上端をスラブ下面に合わせる」ことが多い。

## 11.2 用途

- Top: 構造梁
- Center: 特殊梁
- Bottom: 下端基準配置

---

# 12. 回転 UI 仕様

## 12.1 入力項目

- 断面回転角

## 12.2 用途

- 鉄骨 profile の向き
- 特殊断面の回転

MVP では Options パネルで数値入力でよい。

---

# 13. Type / Instance UI

梁も Type / Instance を分ける。

## 13.1 Type 例

- RC 300x600
- Steel H-400x200
- Rectangle 250x500

## 13.2 Instance

配置された各梁は instance とする。

---

# 14. 作成確定後の挙動

梁作成後:

1. CreateBeamCommand 実行
2. BeamElement を ModelStore に追加
3. Beam-Column / Beam-Wall / Beam-Slab relation を近傍評価
4. join 解決
5. geometry rebuild
6. Tree 追加
7. 新規梁を selection primary にする

---

# 15. 柱間配置の特別ルール

## 15.1 配置時

- 柱中心に snap してもよい
- preview では柱中心まで線を表示してよい

## 15.2 確定後

- BeamColumnJoinResolver により柱面 trim を適用する
- つまり「配置の基準点」と「最終形状端点」は一致しなくてもよい

---

# 16. 壁との関係

梁が壁に接する場合、MVP では wall face で trim する。

### UIとしては

- wall face snap 可能
- または自由配置後に自動 trim

---

# 17. 連続入力仕様

chainMode 中は、前の梁終点を次の始点候補にする。

### 用途

- 梁列
- フレームの連続入力
- 折れた梁列（将来）

MVP では、単純な end-to-start 継続でよい。

---

# 18. エラーチェック

確定前に以下を検証する。

- start/end が一致しない
- 長さが epsilon 未満でない
- profile 寸法が正
- levelId が有効
- depth が正
- topOffset により不正高さにならない

---

# 19. Command 連携

```ts
class CreateBeamCommand {
  execute()
  undo()
}
```

## execute

- BeamElement 作成
- ModelStore 追加
- Join resolver 実行
- SelectionStore.setSingle(newBeam)

## undo

- 梁削除
- relation 削除
- selection 復元または解除

---

# 20. Tree 連携

通常は以下に追加する。

```text
Building
 └ Levels
    └ Level N
       └ Beams
          └ Beam-001
```

---

# 21. 推奨 UI フロー

## 最小MVP

- Beam ツール
- 2点指定
- Column center snap
- profile/type 選択
- top alignment
- create command

## 実務で強い拡張

- 柱間自動候補表示
- Grid follow mode
- chainMode
- trim preview
- beam system creation（将来）

---

# 22. AI 実装指示

## 必須

- 線ベース入力にする
- Column center snap を実装する
- 配置後に Beam-Column join を解く
- beam top を slab bottom に合わせる前提をUIで扱う
- CreateBeamCommand 経由で作成する

## 推奨

- chainMode
- grid-follow mode
- beam type selector
- trim preview

## 禁止

- 柱のような点配置にしない
- wall と同じ面要素扱いにしない
- snap と final trim を混同しない

---

# 23. 一言まとめ

```text
梁作成UIは「線を引く」「柱や通芯に吸着する」「断面と高さ拘束で生成する」
ことを中心に設計するのが正しい。
```
