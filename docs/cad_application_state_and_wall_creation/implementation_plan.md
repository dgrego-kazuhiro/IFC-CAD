# 実装計画: CADアプリケーション状態管理と壁作成機能

## フェーズ 1: ステート管理の導入 (Zustand)
- `src/cad/application/AppState.ts` を作成する。Zustandストアとしてプロジェクト（モデル）、現在選択されているツール、選択要素、などを保持する。
- 合わせで `ProjectModel`, `BuildingModel` などのベースとなる状態オブジェクトを定義する。

## フェーズ 2: ツールとコマンド基盤の作成
- `src/cad/ui/tools/WallTool.ts` を作成（あるいはスタブ化）し、キャンバス上でのクリックイベントから壁生成コマンドを呼び出せるようにする。
- `src/cad/commands/create/CreateWallCommand.ts` を実装し、引数から `WallElement` を生成して `AppState` に追加するロジックを組む。

## フェーズ 3: ジオメトリ・メッシュのビルダ実装
- `src/cad/geometry/builders/WallGeometryBuilder.ts` (2D線分からのオフセット・ポリゴン生成)
- `src/cad/mesh/builders/WallMeshBuilder.ts` (ジオメトリからのメッシュ生成・三角分割)
- これらを `Renderer` 用のオブジェクト(`RenderObject`)に変換するレイヤー（`scene.sync` のような機構）を整備する。

## フェーズ 4: UIとの統合・レンダラへの適用
- `CadShell.tsx` のボタンでツール ("wall", "column" など) を切り替えられるようにする。
- `Viewport.tsx` を更新し、ポインタ入力を `WallTool` に渡す。
- モデル状態の変更を検知してWebGPUレンダラーがシーンを再構築・再描画するようにする。
