# BIM Tree Panel Specification (SolidWorks-like Feature Tree for IFC Web-CAD)

Version: 1.0  
Target: AI coding agents  
Purpose: Implement a left-side hierarchical tree panel for BIM elements, grids, levels, and references.

---

# 1. 目的

左側に表示するツリーは以下を統合するUIである。

1. BIM構造（Project / Building / Storey / Elements）
2. 参照要素（Grid / Level）
3. 補助要素（Space / Annotation）
4. 将来：履歴（Feature Tree）

重要：

```text
単なるリストではなく「意味を持つ階層構造」

2. ツリーの基本構造
Project
 ├ Site
 │   ├ Building
 │   │   ├ Levels
 │   │   │   ├ Level 1
 │   │   │   │   ├ Walls
 │   │   │   │   ├ Columns
 │   │   │   │   ├ Beams
 │   │   │   │   ├ Slabs
 │   │   │   │   ├ Doors
 │   │   │   │   ├ Windows
 │   │   │   │   └ Spaces
 │   │   │   └ Level 2
 │   │   ├ Grids
 │   │   └ Reference
 │   └ ...

 3. ノードタイプ定義
type TreeNodeType =
  | "Project"
  | "Site"
  | "Building"
  | "Level"
  | "Category"
  | "Element"
  | "Grid"
  | "GridLine"
  | "Reference"
  | "Space";

4. Tree Node データ構造
interface TreeNode {
  id: string;
  type: TreeNodeType;
  name: string;
  icon?: string;
  children?: TreeNode[];
  parentId?: string;
  expanded?: boolean;
  visible?: boolean;
  locked?: boolean;
  selectable?: boolean;
  elementId?: string;
}

5. カテゴリ構造

Level配下はカテゴリでグルーピングする。

type CategoryType =
  | "Walls"
  | "Columns"
  | "Beams"
  | "Slabs"
  | "Doors"
  | "Windows"
  | "Spaces";


6. Level（レベル）仕様
6.1 Levelとは

高さ基準（Z基準面）

6.2 データ構造
interface Level {
  id: string;
  name: string;
  elevation: number;
}
6.3 ツリー表示
Levels
 ├ Level 1 (0.000)
 ├ Level 2 (3000)
 └ Level 3 (6000)

6.4 役割
Wall / Column / Slab の配置基準
Sketch plane の基準
表示フィルタ
7. Grid（通芯）仕様
7.1 Gridとは

建物の基準線

7.2 データ構造
interface GridLine {
  id: string;
  name: string;
  axis: [Vec3, Vec3];
}

7.3 ツリー表示
Grids
 ├ A
 ├ B
 ├ C
 ├ 1
 ├ 2
 └ 3

7.4 特徴
数字 / アルファベット混在
snap対象
infinite lineとして扱う

8. Element ノード仕様
interface ElementNode extends TreeNode {
  elementId: string;
}

例：

Walls
 ├ Wall-001
 ├ Wall-002

9. ツリーのUI仕様
9.1 表示要素

各ノードに表示するもの：

アイコン
名前
visibility toggle（目アイコン）
lock toggle（鍵）
expand/collapse

9.2 選択連動
Tree選択 → 3Dハイライト
3D選択 → Treeハイライト

9.3 複数選択
Ctrlクリック
Shift範囲選択
Tree → 複数要素選択

9.4 コンテキストメニュー

右クリックメニュー例：

Element
Delete
Hide
Isolate
Rename
Duplicate
Level
Set Active
Rename
Delete
Grid
Rename
Delete
10. 可視性制御
node.visible = true | false

挙動：

親をOFF → 子も非表示
子単体OFF可能

11. ロック仕様
node.locked = true

挙動：

編集不可
選択不可（オプション）

12. 並び順

Levelは elevation順

Level 1 (低)
Level 2
Level 3 (高)

Gridは名前順

1,2,3...
A,B,C...
13. 状態管理
interface TreeState {
  selectedIds: string[];
  expandedIds: string[];
  hiddenIds: string[];
}

14. ツリー更新トリガー

以下で更新する：

Element作成
Element削除
Level変更
Grid追加
名前変更

15. 3Dとの同期

15.1 選択
click tree → viewer.select(elementId)

15.2 可視性
toggle → viewer.setVisible(elementId)

16. 将来拡張（重要）

16.1 Feature Tree（履歴）
Wall Sketch
Extrude
Cut
Join

16.2 フィルタ
Level単位表示
Categoryフィルタ

16.3 検索
名前検索
ID検索

17. UIコンポーネント構成（React）
TreePanel
 ├ TreeHeader
 ├ TreeView
 │   ├ TreeNodeComponent
 │   └ TreeNodeChildren
 └ TreeFooter

18. 実装ファイル候補
src/cad/ui/tree/TreePanel.tsx
src/cad/ui/tree/TreeView.tsx
src/cad/ui/tree/TreeNode.tsx
src/cad/state/tree/TreeStore.ts
src/cad/model/levels/Level.ts
src/cad/model/grids/Grid.ts

19. UXルール（重要）
Tree = モデル構造を理解するUI

つまり：

ユーザーが迷わない
IFC構造と一致
CAD的にも直感的
20. 一言まとめ
このツリーは「IFC構造 + CAD操作性 + 参照系（Grid/Level）」を統合したUIであり、
単なるファイルツリーではない。