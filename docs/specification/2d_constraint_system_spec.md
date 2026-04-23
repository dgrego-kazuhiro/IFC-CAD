# 2D幾何拘束システム仕様書（IFC Web-CAD向け）

## 1. 基本方針

本システムでは、機械CADのような完全拘束スケッチは採用しない。  
建築用途に最適化した「軽量拘束 + スナップ中心」の設計とする。

### 設計原則
- 壁：拘束主体
- 梁：拘束補助
- 柱：スナップ主体

---

## 2. 拘束レベル定義

### レベル1（必須）
- 水平（Horizontal）
- 垂直（Vertical）
- 平行（Parallel）
- 直交（Perpendicular）
- 端点一致（Coincident）
- 通芯一致（OnGrid）
- 柱中心一致（OnColumnCenter）
- 長さ寸法（Length）

### レベル2（建築特化）
- 壁芯一致（WallCenterAlign）
- 壁面一致（WallFaceAlign）
- 同厚（EqualThickness）
- 通芯オフセット（GridOffset）
- 等間隔配置（EqualSpacing）
- 梁端柱一致（BeamToColumn）

### レベル3（拡張）
- 対称（Symmetry）
- グループ拘束（GroupConstraint）
- 参照平面拘束（ReferencePlane）
- 自動拘束推定（AutoConstraint）

---

## 3. 要素別仕様

## 3.1 壁（Wall）

### スケッチ対象
- 軸線（中心線）

### 使用拘束
- 水平 / 垂直
- 平行 / 直交
- 端点一致
- 通芯一致
- 長さ寸法

### 特徴
- 拘束主体の設計
- スケッチ編集中心

---

## 3.2 梁（Beam）

### スケッチ対象
- 軸線

### 使用拘束
- 柱中心一致
- 通芯一致
- 平行 / 直交
- 端点一致

### 特徴
- 拘束は補助的
- 主にスナップで配置

---

## 3.3 柱（Column）

### スケッチ対象
- 配置点

### 使用拘束
- 通芯交点一致
- 整列
- 等間隔
- 寸法指定

### 特徴
- 拘束よりスナップ優先
- 点配置中心

---

## 4. スナップシステム

### 優先順位
1. 柱中心
2. 梁端点
3. 通芯交点
4. 壁軸線
5. フリー点

---

## 5. データ構造

```ts
interface Constraint {
  type: ConstraintType;
  targets: string[];
  value?: number;
}

type ConstraintType =
  | "Horizontal"
  | "Vertical"
  | "Parallel"
  | "Perpendicular"
  | "Coincident"
  | "OnGrid"
  | "OnColumnCenter"
  | "Length";
```

---

## 6. ソルバ設計

### 方針
- 軽量逐次解法
- 全体最適化は行わない
- 局所更新のみ

### 処理フロー
1. 入力変更
2. 関連拘束取得
3. 優先順位順に解決
4. ジオメトリ更新

---

## 7. UI仕様

### 表示
- 拘束アイコン表示
- ホバーで説明表示

### 操作
- クリックで拘束追加
- 右クリックで削除
- 寸法ダブルクリックで編集

---

## 8. AI実装指示（要約）

- フル拘束ソルバは実装しない
- 壁は拘束中心で設計する
- 梁はスナップ中心 + 軽拘束
- 柱は点配置 + スナップ
- 拘束は局所的に解決する
- 通芯を最優先参照とする
