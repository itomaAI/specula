# SpecProjector 基本設計書

本設計書は、仕様射影モジュールの仕様書（`05_spec_projector.spec.md`）に規定された多面的ビュー（Markdown / DAG / フロー / マトリクス）への決定論的オンデマンド射影を、全体基本設計書（`system_solution.design.md`）の規約に準拠して**どのように技術的・構造的に実現するか（How）**を定義する。

---

## 1. アーキテクチャと全体設計制約の継承

### 1.1 全体設計制約の適用
- **配置場所**: `specula/src/core/spec_projector.js`（Pure ESM, Target: ES2022+）。
- **Zero-I/O Core の遵守**: 本モジュールは直接ディスクやDOMを操作せず、メモリ上で形式仕様モデルおよび論点カタログを受領し、要求されたビューデータ（Markdown/JSON）を返す純粋関数群として実装する。
- **仕様の世界への純化**: テストコード（`test.ts`）の実行・生成は下流のテスト生成ツールに委ね、本モジュールは純粋な仕様射影に閉じる。

### 1.2 プラグイン型サブプロジェクター構成
```
                         ┌──➔ [MarkdownProjector]  ➔ spec.md (完全ブラックボックス仕様書)
                         │
[FormalSpec (*.als)] ──➔ [Core Orchestrator] ──┼──➔ [GraphProjector]     ➔ dag.json / Mermaid DAG
                         │
[DomainLedger]       ────┤
                         ├──➔ [FlowProjector]      ➔ シーケンス図 / フローチャート
                         │
                         └──➔ [MatrixProjector]    ➔ 状態遷移決定表
```

---

## 2. 各サブプロジェクターの詳細設計 (Detailed Design)

### 2.1 MarkdownProjector (ブラックボックス仕様書射影)
- 入力された形式仕様コードのアノテーションと構造を走査。
- 目的（Why）、シナリオ概要、事前条件、事後条件、不変条件のセクションを、PdM が読解可能な自然な Markdown 文書としてシリアライズ。
- 合意された `DomainLedgerCatalog` を巻末に「意思決定論点カタログ」として付加。

### 2.2 GraphProjector (DAG / 依存グラフ射影)
- シナリオ間の因果関係（発行イベント ⇄ 購読イベント）およびオペレーションの順序関係を抽出。
- `DAG Viewer` で描画可能なノード・エッジ JSON（`dag.json`）および Mermaid グラフ構文を出力。
- マクロ俯瞰ビュー（高速道路マップ）からミクロ詳細ビュー（路線図）への粒度切り替えをサポート。

### 2.3 FlowProjector (時系列・フロー射影)
- 各述語（`pred`）におけるアクターとシステムのやり取りを、Mermaid シーケンス図（`sequenceDiagram`）またはアクティビティフローチャートとして出力。

### 2.4 MatrixProjector (状態遷移決定表射影)
- 状態集合 $S$（行）と操作集合 $C$（列）を展開した Markdown 決定表マトリクスを出力。各交点に遷移先状態または「禁止/未定義」を明示。

---

## 3. 決定論的レンダリング規約 (Deterministic Normalization)
- 全サブプロジェクター共通の不変条件として、乱数、外部時刻の暗黙参照、環境依存のオブジェクト走査順を完全排除する。
- 見出し、テーブル行、ノード、エッジの出力順序をすべて ID 昇順で正規化ソートし、同一の入力に対して何度再生成しても `git diff = 0` を数学的に保証する。