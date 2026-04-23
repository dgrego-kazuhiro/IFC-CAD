# 床（Slab）作成仕様書（Space 連携型）

- **Version**: 1.0
- **Target**: AI coding agents
- **Language**: 日本語
- **Project**: IFC Web-CAD

---

## 1. 目的

本仕様は、床（Slab）の作成方法を定義する。

特に以下を実現する:

- 手動スケッチによる床作成
- Space（部屋）からの自動床生成
- 壁との整合を保つ床形状生成

**重要原則:**

> 床は「輪郭」または「空間（Space）」から生成される

---

## 2. 基本モデル

```ts
interface SlabElement {
  id: string;
  profile: Vec2[];      // 平面輪郭（閉じたポリゴン）
  thickness: number;
  levelId: string;
  elevation: number;
  holes?: Vec2[][];     // 開口（階段・吹抜など）
}
```

---

## 3. 作成モード

### 3.1 手動スケッチモード

1. 輪郭を描く（ポリライン）
2. 閉じる
3. 床生成

**Snap**

- 壁面
- 壁交点
- グリッド
- 既存頂点

### 3.2 Space ベース自動生成（最重要）

1. Space を選択
2. 「床作成」実行
3. 自動で輪郭生成
4. 床生成

---

## 4. Space の定義（前提）

```ts
interface Space {
  id: string;
  boundary: Vec2[]; // 閉じた領域
  levelId: string;
}
```

Space は壁から生成される。

---

## 5. Space → Slab 生成アルゴリズム

### 5.1 基本フロー

1. Space boundary を取得
2. 壁の内側面を基準に輪郭生成
3. 必要に応じてオフセット
4. Slab profile 作成

### 5.2 壁内側の取得（重要）

壁は以下の構造:

```text
axis + thickness
```

Space は通常「壁内側」で囲まれる。

**方法**

1. 各壁の内側面を取得
2. 面同士の交点を連結
3. 閉ポリゴン生成

### 5.3 オフセット処理

必要に応じて床を少し小さくする:

```text
offset = -finishOffset
```

**例:**

- 壁仕上げを考慮
- スラブを内側に縮める

---

## 6. 複雑形状対応

### 6.1 凹形状

- concave polygon OK
- → triangulation で対応

### 6.2 穴（開口）

```ts
holes: Vec2[][]
```

**用途:**

- 階段
- 吹抜
- シャフト

---

## 7. 幾何生成

```text
2D profile
↓
extrude(thickness)
↓
slab solid
```

**IFC 対応:**

- IfcSlab
- IfcExtrudedAreaSolid

---

## 8. 壁との関係

### 8.1 原則

- 床は壁に従属しない
- 独立要素
- ただし位置整合は重要

### 8.2 自動整合

- Space から生成
- → 壁内側に一致

---

## 9. 更新ルール（重要）

### 9.1 Space 変更時

- 壁変更
- → Space 更新
- → Slab 再生成（オプション）

### 9.2 自動更新モード

```ts
autoUpdateFromSpace: boolean;
```

- `true` → 常に追従
- `false` → 固定

---

## 10. UI 仕様

### 10.1 作成方法

```text
[床]
 ├ スケッチ作成
 └ Spaceから作成（推奨）
```

### 10.2 選択時

**表示:**

- 面ハイライト
- 輪郭表示

### 10.3 編集

- 厚さ変更
- レベル変更
- 輪郭編集
- Space リンク ON/OFF

---

## 11. スナップ仕様

床作成時:

1. 壁内側（最優先）
2. 壁端点
3. グリッド
4. 他床の頂点

---

## 12. Tree 構造

```text
Level
 ├ Spaces
 ├ Slabs
 └ Walls
```

---

## 13. 削除仕様

- Slab 削除 → Space は残る
- Space 削除 → Slab は残す（リンク解除）

---

## 14. IFC 整合

- Slab → `IfcSlab`
- Profile → `IfcArbitraryClosedProfileDef`
- Hole → `IfcOpeningElement`（将来）

---

## 15. 実装指示

### 必須

- Space ベース生成を優先実装
- concave polygon 対応
- 壁内側基準で輪郭生成
- Slab は再生成可能にする

### 推奨

- 自動更新フラグ
- 開口対応
- offset 設定

### 禁止

- mesh boolean のみで床生成
- Space 無視で適当に生成

---

## 16. 一言まとめ

> 床は「輪郭」ではなく「空間（Space）」から作ると、壁との整合が自動で取れる最も強い設計になる
