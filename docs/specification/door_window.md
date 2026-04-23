# ドア・窓（Opening / Door / Window）仕様書
Version: 1.0  
Target: AI coding agents  
Language: 日本語  
Project: IFC Web-CAD

---

# 1. 目的

本仕様は、IFC Web-CAD における以下の要素を定義する。

- Opening（開口）
- Door（ドア）
- Window（窓）

これらはすべて「壁に対するホスト要素」として扱う。

重要原則:

ドア・窓は単体要素ではなく、「壁に挿入される要素」である

---

# 2. 要素構造

Wall
 └ Opening（穴）
     └ Door または Window（充填要素）

---

# 3. Opening（開口）仕様

## 3.1 役割

- 壁に穴を開ける
- ドア・窓のベースとなる

## 3.2 データモデル

interface OpeningElement {
  id: string;
  hostWallId: string;
  position: number; // 壁軸上の位置（0〜1）
  width: number;
  height: number;
  sillHeight?: number;
}

## 3.3 幾何

wall solid
↓
opening volume（直方体）
↓
cut

---

# 4. Door（ドア）仕様

## 4.1 基本定義

interface DoorElement {
  id: string;
  openingId: string;
  type: "Single" | "Double" | "Sliding";
  width: number;
  height: number;
  swingDirection?: "Left" | "Right";
}

## 4.2 挙動

- Opening に依存する
- 単独では存在できない

## 4.3 表示

- 2D: 開き方向アーク
- 3D: 簡易形状

---

# 5. Window（窓）仕様

## 5.1 基本定義

interface WindowElement {
  id: string;
  openingId: string;
  type: "Fixed" | "Sliding" | "Casement";
  width: number;
  height: number;
  sillHeight: number;
}

## 5.2 挙動

- Opening に依存
- 壁内に配置

---

# 6. 作成フロー

## ドア

0. 事前にドアの種類を選ぶ。BBを決定する。
1. 壁の上にマウスをのせる
2. 壁に穴が開いて、ドアが配置されたプレビューが表示される
3. 位置クリックで確定
4. Opening生成
5. Door生成

## 窓


0. 事前に窓の種類を選ぶ。BBを決定する。
1. 壁の上にマウスをのせる
2. 壁に穴が開いて、窓が配置されたプレビューが表示される
3. 位置クリック
4. Opening生成
5. Window生成

---

# 7. スナップ

- 壁軸
- グリッド
- 他開口

---

# 8. 編集

- 幅
- 高さ
- 位置
- 種類

---

# 9. 削除

- Door削除 → Opening削除
- Window削除 → Opening削除

---

# 10. IFC

- Opening → IfcOpeningElement
- Door → IfcDoor
- Window → IfcWindow

---

# 11. 実装指示

必須:
- Openingを中間要素として扱う
- 壁に依存させる

禁止:
- ドア単独管理
- 直接mesh booleanのみ

---

# 12. まとめ

ドア・窓は「Opening + 要素」として扱うのが正しい
