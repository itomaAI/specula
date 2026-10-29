# ScenarioExtractor 基本設計書

本設計書は、シナリオ同定モジュールの仕様書（`00_scenario_extractor.spec.md`）に規定されたイベントストーミング全体マップ構築および個別シナリオ切り出しを、全体基本設計書（`system_solution.design.md`）の規約に準拠して**どのように技術的・構造的に実現するか（How）**を定義する。

---

## 1. アーキテクチャと基本制約

### 1.1 基本制約の遵守
- **配置場所**: `specula/src/core/scenario_extractor.ts`（ビルド後は `dist/` の JS）（Pure ESM, Target: ES2022+）。
- **Zero-I/O Core の遵守**:
  - 本モジュールはファイルシステム（`fs`）やネットワーク呼び出しを直接行わない。
  - 解析対象のリポジトリメタ情報（ファイル一覧、パッケージ定義、ソーステキスト、ドキュメントテキスト等）は呼び出し元からインメモリデータ構造（または Port）経由で注入されて動作する純粋な計算・解析エンジンとする。
- **完全決定論的再現性**:
  - 同一の入力データ群に対して、出力される全体マップおよび個別シナリオは完全に決定論的（ソート済み・一意）であること。

---

## 2. 段階的詳細化パイプライン (Loom 3操作 ＆ 4-Stage Pipeline)

システム全体のマクロな境界から、ミクロな実行可能シナリオへと段階的に解像度を上げていく過程を、Loom の基本構造（プロジェクト＝コンテキスト、タスク＝シナリオ）および 3 つの操作（置く・畳む・移す）の実装として体系化する。

- **置く（分解）**: システム全体から Bounded Context（プロジェクト）を同定し、その内部に存在するコマンド/ポリシーを個別シナリオ（タスク）として分解・切り出す。
- **畳む（集約）**: 各個別シナリオの抽出事実（関与するスキーマや画面）を集約し、Bounded Context の文脈（EventStormingMap）へと折りたたむ。
- **移す（伝播）**: ある Bounded Context で発生したドメインイベントを、別コンテキストのポリシー起動トリガーへと受け渡す。

モジュール内部は以下の 4 つの独立したサブパイプラインで構成する：

```
[リポジトリ見取り図データ (Files, Docs, Package, Schemas)]
                           │
                           ▼
┌────────────────────────────────────────────────────────┐
│ Stage 1: ContextBoundaryAnalyzer (境界同定)             │
│  - ディレクトリ/モジュール/スキーマの境界スキャン        │
│  - Bounded Context の分割または単一コンテキストへの集約 │
└──────────────────────────┬─────────────────────────────┘
                           │ BoundedContext[]
                           ▼
┌────────────────────────────────────────────────────────┐
│ Stage 2: EventStreamDiscoverer (事実骨格抽出)          │
│  - 各コンテキストにおける完了形ドメインイベントの同定   │
│  - イベント間の時系列・因果関係タイムラインの構築       │
└──────────────────────────┬─────────────────────────────┘
                           │ DomainEvent[]
                           ▼
┌────────────────────────────────────────────────────────┐
│ Stage 3: EventStormingAssembler (関係性統合)           │
│  - イベントを起動するコマンド、発火ポリシーの同定       │
│  - アクター、リードモデル（画面）、アグリゲートのバインド│
│  ➔ 【出力 1: EventStormingMap】                        │
└──────────────────────────┬─────────────────────────────┘
                           │ EventStormingMap
                           ▼
┌────────────────────────────────────────────────────────┐
│ Stage 4: ScenarioSlicerResolver (具象シナリオ生成)     │
│  - コマンド / ポリシーを起点とする因果スライスカット   │
│  - 画面ファイルパス、画像参照、目的のバインド          │
│  ➔ 【出力 2: ScenarioTarget[]】                        │
└────────────────────────────────────────────────────────┘
```

---

## 3. 各ステージの詳細設計 (Detailed Design)

### 3.1 Stage 1: ContextBoundaryAnalyzer (境界同定)
- **入力**: ディレクトリ木構造、`package.json`（monorepo/workspaces）、DBスキーマ定義ファイル群。
- **同定アルゴリズム**:
  1. **明示的境界スキャン**:
     - `packages/*`, `apps/*`, `features/*`, `modules/*`, `domains/*` ディレクトリが存在する場合、各ディレクトリを独立した Bounded Context の第1候補として抽出。
     - DB スキーマ定義が複数ファイルまたはスキーマ名で分離されている場合、エンティティの凝集度に基づいてコンテキストを特定。
  2. **密結合度判定とフォールバック規則**:
     - ディレクトリ分割が存在しない、あるいは全画面がフラットに共通ストア・単一テーブル群を参照している場合、**「境界同定不能」と判定し、システム全体を単一コンテキスト（`DEFAULT_CONTEXT`）にフォールバック**する。
- **出力**: `BoundedContextDefinition[]`（識別子、名称、対象ルートパス群）。

### 3.2 Stage 2: EventStreamDiscoverer (事実骨格抽出)
- **入力**: 各 Bounded Context 内のコードファイル群、API/ルーター定義、DBマイグレーション/ミューテーションコード。
- **解析ロジック**:
  1. **状態変化シグナルの検出**:
     - DBへの `insert`, `update`, `delete` や Firestore の `addDoc`, `updateDoc` 等のミューテーション呼び出しを検出。
     - イベント発行コード（`emit`, `dispatch`, `publish` 等）を検出。
  2. **ドメインイベント命名の正規化**:
     - 操作完了時の事実を「過去分詞（Domain Event）」として正規化（例: `UserRegistered`, `PasswordChanged`, `PaymentCompleted`）。
  3. **時系列トポロジー整列**:
     - 呼び出しの前提条件や依存関係から、イベント間の先行・後続関係をグラフとして整列。
- **出力**: `DomainEvent[]`。

### 3.3 Stage 3: EventStormingAssembler (関係性統合)
- **入力**: `DomainEvent[]`、画面ルーティングファイル（Next.js pages/app routes等）、ハンドラ関数。
- **統合ロジック**:
  1. **コマンド (Command) のバインド**:
     - イベントの直前に実行されるユーザー意思・HTTPリクエスト（例: `ChangePassword`, `SubmitOrder`）を抽出・紐付け。
  2. **アクター (Actor) の特定**:
     - 認証ミドルウェア、権限ロール（`role === 'admin'`, `auth.uid` 等）をスキャンし、コマンドの発行主体（`User`, `Admin`, `SystemWorker` 等）を決定。
  3. **リードモデル (Read Model / 画面) の接続**:
     - コマンドが発火される画面ルート、入力フォーム、UIコンポーネントを特定し、リードモデルとして紐付け。
  4. **ポリシー (Policy) の同定**:
     - あるイベントをリッスンして非同期に次のコマンドを呼び出すロジック（`onDocumentCreated`, イベントリスナー等）を「ポリシー」として抽出。
- **出力**: **`EventStormingMap`**。

### 3.4 Stage 4: ScenarioSlicerResolver (具象シナリオ生成)
- **入力**: `EventStormingMap`、画面キャプチャ一覧、人間からの直接指定（存在する場合）。
- **スライシングロジック**:
  1. **アトミック因果スライス**:
     - マップ上の各 **`Command`** または **`Policy`** を単一のエントリーポイント（Inlet）として切り出し。
     - 紐づく Actor、Read Model（画面パス）、到達すべき期待 Domain Event を1つのタプルとして結合。
  2. **具象パスの解決 (Path Resolver)**:
     - 画面ルート（例: `/mypage`）から実際のソースコードファイルパス（例: `src/app/(dashboard)/mypage/page.tsx`）および画面画像パスを確定。
  3. **人間指定のオーバレイ**:
     - 人間（PdM）が特定の画面や目的を指定した場合、該当するスライスを特定・優先して出力。
- **出力**: **`ScenarioTarget[]`**。

---

## 4. データ構造と保持形式 (Data Persistence Model)

### 4.1 全体マップ形式 (`EventStormingMap`)
```typescript
interface EventStormingMap {
  boundedContexts: Array<{
    id: string;
    name: string;
    isDefaultFallback: boolean;
  }>;
  events: Array<{ id: string; name: string; contextId: string; aggregate?: string }>;
  commands: Array<{ id: string; name: string; contextId: string; actorId: string; readModelId: string }>;
  policies: Array<{ id: string; triggerEventId: string; actionCommandId: string; name: string }>;
  readModels: Array<{ id: string; name: string; route: string; componentFile: string; screenshotPath?: string }>;
  actors: Array<{ id: string; name: string }>;
}
```

### 4.2 個別シナリオ保持形式 (`ScenarioTarget`)
```typescript
interface ScenarioTarget {
  id: string;                      // 例: "SCN-MYPAGE-PASSWORD-CHANGE"
  boundedContext: string;          // 例: "UserAccount" または "DEFAULT_CONTEXT"
  intent: string;                  // 例: "ユーザーがパスワードを変更し安全性を確保する"（LLM が出す意図の候補）
  intentStatus: "CANDIDATE" | "CONFIRMED"; // 人間（PdM）が確定するまでは CANDIDATE
  inletType: "COMMAND" | "POLICY"; // 同期か非同期か
  inletTrigger: {
    name: string;                  // コマンド名またはポリシー名
    handlerName?: string;          // ソース上の関数名（特定可能な場合）
  };
  actor: {
    id: string;
    name: string;
  };
  readModel: {
    name: string;
    route: string;
    entryFile: string;             // 具象ソースファイルパス
    screenshotPath?: string;       // 画面画像パス
  };
  expectedEvent: string;           // 完了時に発生すべきドメインイベント
}
```

---

## 5. エラーハンドリングと決定論性

1. **フォールバック保証**:
   - リポジトリ構造が標準的でない場合でも例外でクラッシュさせず、単一 Bounded Context および汎用ルートとして最低限のシナリオスライスを成立させる。
2. **決定論的正規化**:
   - `EventStormingMap` の全配列、および `ScenarioTarget[]` のソート順は、IDの辞書順で安定ソートされ、何度実行しても同一の出力を保証する。