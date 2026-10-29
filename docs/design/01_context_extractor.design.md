# ContextExtractor 基本設計書

本設計書は、実装事実抽出モジュールの仕様書（`01_context_extractor.spec.md`）に規定された多層システム事実抽出（UI・API・バッチ・DBスキーマ）を、全体基本設計書（`system_solution.design.md`）の規約に準拠して**どのように技術的・構造的に実現するか（How）**を定義する。

---

## 1. アーキテクチャと全体設計制約の継承

### 1.1 全体設計制約の適用
- **配置場所**: `specula/src/core/context_extractor.ts`（ビルド後は `dist/` の JS）（Pure ESM, Target: ES2022+）。
- **Zero-I/O Core の遵守**: 本モジュールは `node:fs` や `window.MetaOS.fs` を直接インポートしてはならない。ファイル入出力は行わず、呼び出し元からインメモリのテキストデータ（または `FileSystemPort`）を注入されて動作する純粋な構文解析器として実装する。
- **依存方向の一方向性**: 本モジュールは `src/ports/` のインターフェースのみに依存し、`src/adapters/` の具象環境実装を一切参照しない。

### 1.2 4層アナライザーのパイプライン構成
システム各層から事実を漏れなく収集するため、以下の 4 つのアナライザーサブモジュールで構成する。

```
[フロントエンド TSX/画像] ──➔ [UIAnalyzer] ──────────────┐
                                                          │
[バックエンド API/関数] ──➔ [BackendAnalyzer] ───────────┼─➔ [FactMerger & Normalizer]
                                                          │           │
[バッチ / トリガー]     ──➔ [TriggerAnalyzer] ───────────┤           ▼
                                                          │   [RawContextModel]
[DBスキーマ / DDL]      ──➔ [SchemaAnalyzer] ────────────┘
```

---

## 2. 各アナライザーの詳細設計 (Detailed Design)

### 2.1 UIAnalyzer (フロントエンド構文・視覚解析)
- **構文解析エンジン**: `@babel/parser`（Plugins: `typescript`, `jsx`）をコアとする。外部バイナリやネイティブCLIを一切不要とし、ブラウザ内（Web Worker / Itera OS）および Node.js CLI の双方で完全に同一動作させる。
- **AST トラバース規則**:
  - `VariableDeclarator`: `useState` および状態管理フックの呼び出しを走査し、変数名と初期値を `STATE` として抽出。
  - `FunctionDeclaration` / `ArrowFunctionExpression`: コンポーネント内の関数を走査。関数名、引数型、および関数内部で発火される API 呼び出し（`fetch`, `httpsCallable` 等）を `OPERATION` として抽出。
  - `JSXElement` / `JSXAttribute`: `label`, `title`, `placeholder` 属性および `JSXText` の文字列リテラルを `INTERFACE_TEXT` として抽出。
  - `ConditionalExpression` / `LogicalExpression` / `IfStatement`: 画面の条件付き描画ロジックを `BRANCH_CONDITION` として抽出。
- **コンポーネントスコープの保持**:
  - 各要素の親コンポーネント名（関数名）を `componentScope` として付与し、同一ファイル内の複数コンポーネントの混同を防止する。

### 2.2 BackendAnalyzer (API・ビジネスロジック解析)
- **対象**: ルーティング定義、エンドポイントハンドラ、コントローラ。
- **AST トラバース規則**:
  - ルート定義（`app.get`, `app.post`, `httpsCallable`, Next.js route handlers）を走査し、HTTPメソッドとパスを抽出。
  - リクエストバリデーション（zod, Joi, 型定義）から入力パラメータ仕様を抽出。
  - ハンドラ内部の DB クエリ（ORM メソッド、Firestore SDK 操作）を抽出し、データ変更事実を記録。

### 2.3 TriggerAnalyzer (非同期バッチ・イベントトリガー解析)
- **対象**: Cron 設定ファイル、クラウドストレージ/DBイベントトリガー定義。
- **解析規則**:
  - トリガーの起動契機（定期実行スケジュール、オブジェクト作成イベント、DBミューテーション）と、それによって呼び出されるハンドラ関数の紐付けを抽出。

### 2.4 SchemaAnalyzer (データモデル解析)
- **対象**: DDL, Prisma/TypeORM スキーマ, Firestore rules/indexes, JSON Schema。
- **解析規則**:
  - エンティティ名、フィールド名、データ型、Null 許容性、外部キー・リレーション制約、ユニーク制約を抽出。

---

## 3. 事実の統合と決定論的正規化 (Fact Normalization)

1. **因果チェーンの接続と探索境界の判定 (Boundary Enforcement)**:
   - **開始境界 (Inlet)**: 指定された単一操作ハンドラまたは外部トリガー（1つのAPIエンドポイント等）をトラバース起点として登録。
   - **因果接続**: UI 側の API 呼び出し関数名と Backend 側のエンドポイントパスを突合してリンクし、Backend 側の DB 操作と Schema 側のエンティティ定義を突合してリンク。
   - **終了境界 (Outlet) 検出**:
     - 更新系: DB永続化処理（SQL/ORM/SDK）のコミットと、クライアントへのHTTPレスポンス返却（またはUI状態更新/トースト発火）の両方が検出された時点で以降の探索を打ち切る。
     - 参照系: 副作用を伴わないDB/ストア読み取りと、レスポンス返却が検出された時点で以降の探索を打ち切る。
     - ガード失敗系: バリデーション失敗や権限エラーによる早期リターンブロックを識別し、エラー応答までの独立した経路を確定。
   - **非同期境界 (Async Boundary) の切断**:
     - メッセージキューへのエンキュー（SQS/Kafka等）や、DBイベントトリガー（Functions/CDC等）の発火点を検出した場合、その呼び出しを「境界の終端」として記録し、キュー/イベントのハンドラ内部への追跡は意図的に停止・切断する。
2. **ユースケーススライスの分割 (Branch Slicing)**:
   - ガード節（`if`, `switch`, `try-catch`）による分岐パスごとに、[前提条件 (Pre-condition) ➔ 状態変化/応答 (Outcome)] のタプルとして事実経路を正規化。
3. **完全決定論的ソート**:
   - 抽出された `units` 配列は、実行環境やファイル読み込み順に左右されないよう、`componentScope` ➔ `kind` ➔ `name` の辞書順で完全にソートする。
4. **エラーハンドリング**:
   - 構文解析エラーが発生した場合は、推測や不完全なパース結果を返さず、行番号・列番号・原因を含む `SyntaxExtractionError` を即座にスローする（Fail-Fast 原則）。