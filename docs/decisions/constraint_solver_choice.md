# 2D 拘束ソルバの選択

- **Date**: 2026-04-15 (initial) / 2026-04-15 (revised)
- **Status**: **Revised** — planegcs へ切り替え、拘束対象も壁 → スケッチ線に変更
- **Scope**: [docs/specification/2d_constraint_system_spec.md](../specification/2d_constraint_system_spec.md) に基づく 2D 幾何拘束システムの実装

---

## 最終決定（改訂後）

**[planegcs](https://github.com/Salusoft89/planegcs)（FreeCAD の GCS を WebAssembly 化した本格ソルバ）を採用する**。

同時に拘束対象を「壁の axis」から「作図線（Room 矩形のエッジ / コーナー）」へ変更。解決結果は矩形座標に書き戻され、壁はそこから再生成される。

**実装ファイル:**
- [src/cad/constraint/GcsBackend.ts](../../src/cad/constraint/GcsBackend.ts) — WASM 非同期ローダ
- [src/cad/constraint/SketchSolver.ts](../../src/cad/constraint/SketchSolver.ts) — 矩形 ↔ GCS primitive マッピング + solve
- [src/cad/model/constraint/Constraint.ts](../../src/cad/model/constraint/Constraint.ts) — SketchPoint / SketchEdge / Grid / Column を対象とするデータモデル

## 当初の決定（参考）

当初は **ハンドロール軽量逐次ソルバ**を採用した。仕様 §1「軽量拘束 + スナップ中心」、§6「全体最適化は行わない、局所更新のみ」に合わせた設計。MVP レベル1 の 8 拘束を個別実装でカバーした。

しかしユーザ要望により以下の理由で改訂した:

1. **拘束対象の変更**: 壁の axis ではなく**作図線そのもの**に拘束を付けたい → Room モードの矩形編集中にリアルタイム解決が必要
2. **レベル2/3 への拡張余地**: ハンドロール版は個別実装で、EqualSpacing・Symmetry 等の追加が煩雑
3. **矛盾/連成拘束の堅牢性**: 矩形同士の共有拘束など、局所逐次では振動する可能性

---

## 背景

仕様 §1 に次のとおり明記されている:

> 機械 CAD のような完全拘束スケッチは採用しない。
> 建築用途に最適化した「軽量拘束 + スナップ中心」の設計とする。

仕様 §6 のソルバ方針:

- 軽量逐次解法
- 全体最適化は行わない
- 局所更新のみ

仕様 §8 の AI 実装指示:

- フル拘束ソルバは実装しない
- 拘束は局所的に解決する

この前提のもとで「planegcs の方が優れているなら使ってよい」というオプションが提示された。

---

## 選択肢

### オプション A: ハンドロール軽量ソルバ（採用）

- BFS で変更起点壁から関連拘束 → 連鎖壁を収集
- 優先順位順に逐次適用、最大 N 反復で収束
- 壁軸 (`WallElement.axis`) のみを対象、他のプロパティは触らない
- 個別ソルバ関数: `solveHorizontal / Vertical / Length / Parallel / Perpendicular / Coincident / OnGrid / OnColumnCenter`

### オプション B: planegcs（見送り）

- FreeCAD の GCS を WebAssembly 化した本格ソルバ
- DogLeg / Levenberg-Marquardt / BFGS / SQP などの数値最適化
- 完全拘束から過拘束まで正しく解ける
- npm: `@salusoft89/planegcs`（TypeScript 型付き）

---

## 比較

| 観点 | ハンドロール | planegcs |
|---|---|---|
| 堅牢性 | MVP level1 は OK、矛盾拘束で振動あり | ◎ 本物の最適化ソルバ、連成拘束を正しく解く |
| 対応拘束 | 仕様レベル1 の 8 種類を個別実装 | あらゆる種類をサポート済み（レベル2/3 も含む） |
| 依存 | なし | WASM バンドル（数百 KB）+ async init |
| 起動 | 同期、即座に利用可 | WASM ロード待ち、初期化済みフラグと `await` が全経路に波及 |
| Next.js 統合 | 問題なし | WASM URL 設定 + webpack / turbopack 両対応要確認 |
| ドメインマッピング | `WallElement.axis` を直接更新 | domain ↔ GCS primitive の ID 双方向対応表が必要 |
| 仕様整合 | ✅ §6「全体最適化は行わない、局所更新のみ」と一致 | ✗ 仕様方針と逆方向（高機能・全体最適化） |
| デバッグ | 全ロジック可視、ブレークポイント容易 | ブラックボックスなソルバの振る舞い観察が必要 |
| バンドルサイズ影響 | 実質ゼロ | 数百 KB の追加 |
| 学習コスト | TypeScript 読めれば理解可能 | GCS 独自概念（primitive・parameter・tag）要習得 |

---

## 当初の決定根拠（参考 / 撤回）

1. **仕様整合性**: planegcs は仕様 §1／§6／§8 の「軽量」方針と逆方向。
2. **async 伝播のコスト**: リアルタイム同期パスに WASM を挟むと `await` が波及する。
3. **現行ソルバの既知の限界は MVP 範囲で重大ではない**: 矛盾拘束は反復上限で停止。
4. **差し替え可能性を確保**: データモデルはソルバ非依存。

## 改訂の決定根拠

1. **拘束対象の明確化**: ユーザ要望で「作図線（Room 矩形の辺/頂点）」が対象になった時点で、矩形・複数連成・グリッド参照など、局所逐次では扱いにくい問題が増えた。

2. **async 波及は preload で緩和可能**: [Viewport.tsx](../../src/cad/ui/layout/Viewport.tsx) の `useEffect` で `GcsBackend.ensureInitialized()` を起動時に 1 回呼ぶだけで、その後の solve は同じ wrapper を作り直す形で実行される。`AppState.updateElement` の rectangle 変更ハンドラは非同期 `runSketchSolver()` を呼ぶが、再入ガード + pending キューで折りたたみ、ユーザ入力はブロックしない。

3. **planegcs はバンドルサイズ ~500KB で許容範囲**: 実測 508KB の WASM を public/ に静的配置。

4. **仕様 §8 の「フル拘束ソルバは実装しない」は「ハンドロールしない」と解釈**: planegcs は外部ライブラリなので「実装しない」を満たす。仕様の精神（建築向けの軽量 UX）は UI 側で保つ（選べる拘束を絞る）。

---

## planegcs を再検討すべきトリガ

以下のいずれかが現実の要求になった時点で、planegcs 導入を改めて評価する:

- **レベル2 の連成拘束を本格サポートしたい**
  - 等間隔配置（EqualSpacing）
  - 対称（Symmetry）
  - グループ拘束（GroupConstraint）
  - 自動拘束推定（AutoConstraint）
- **矛盾 / 過拘束の診断 UI をユーザーに提示したい**
- **壁以外の曲線（円弧・自由曲線）に拘束を付けたい**
- **ハンドロール版で振動・発散の問題がユーザー体験を損なうようになった**

---

## 実装詳細（改訂後）

### WASM 配信
- `node_modules/@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm` を build 外の手動手順で [public/planegcs.wasm](../../public/planegcs.wasm) にコピー
- `GcsBackend.makeWrapper()` が `make_gcs_wrapper("/planegcs.wasm")` を呼び、Next.js が静的配信する

### スケッチモデル
- Room の各矩形 (RoomRectangle) は 4 コーナー + 4 辺のスケッチとして扱う
- コーナー id: `(spaceId, rectId, cornerIdx: 0-3)` — BL, BR, TR, TL の順
- 辺 id: `(spaceId, rectId, edgeIdx: 0-3)` — bottom, right, top, left
- GCS 上では各矩形につき 4 × `point` + 4 × `line` + 6 × implicit 拘束（2 horizontal_pp + 2 vertical_pp + 2 equal_length）を push し矩形を剛体＋軸平行に保つ

### 実行フロー
1. AppState の `addConstraint` / `removeConstraint` / `updateElement`（rectangles 変更時）が `runSketchSolver()` を呼ぶ
2. SketchSolver が「拘束に参照されている矩形」を収集 → GCS に primitive を push
3. ユーザ拘束を GCS constraint に翻訳して push（`horizontal_pp` / `vertical_pp` / `p2p_distance` / `parallel` / `perpendicular_ll` / `p2p_coincident` / `point_on_line_pl`）
4. `wrapper.solve()` → `apply_solution()`
5. 解決後の 4 corner 座標から矩形の AABB start/end を再導出し `updateElement` で書き戻す

### 再入防止
- `solvingDepth` カウンタで「solver 経由の updateElement が再度 solver を呼ぶ」ことを遮断
- 非同期 solve 中に新たな変更要求が来た場合は `pendingResolveRequested` フラグで 1 回だけ再 solve

## 仕様書との関係

当初は planegcs を「仕様 §1/§6/§8 の軽量方針と真逆」と判断したが、改訂後は次のように整理する:

- **仕様 §1 の「軽量拘束 + スナップ中心」**: UI で選べる拘束を MVP レベル1（Horizontal / Vertical / Length / Parallel / Perpendicular / Coincident / PointOnGrid / PointOnColumn）に絞ることで保つ
- **仕様 §6 の「全体最適化は行わない」**: planegcs 内部は数値最適化だが、scope を「拘束対象の矩形のみ」に絞ることで実質的な局所解決になっている
- **仕様 §8 の「フル拘束ソルバを実装しない」**: 外部ライブラリを使うため、プロジェクト内には実装しない（解釈として合致）

レベル2/3 の拡張（EqualSpacing, Symmetry, GroupConstraint, AutoConstraint）は planegcs 上に追加するだけで済む見込み。

---

## 参考資料

- [planegcs GitHub](https://github.com/Salusoft89/planegcs)
- [FreeCAD Sketcher GCS ドキュメント](https://wiki.freecad.org/Sketcher_ConstraintCoincident)
- [docs/specification/2d_constraint_system_spec.md](../specification/2d_constraint_system_spec.md)
- [src/cad/constraint/ConstraintSolver.ts](../../src/cad/constraint/ConstraintSolver.ts) — 実装本体
