# ScenarioExtractor 基本設計書

本設計書は、シナリオ同定モジュールの仕様書（`00_scenario_extractor.spec.md`）に規定されたイベントストーミング全体マップ構築および個別シナリオ切り出しを、全体基本設計書（`system_solution.design.md`）の規約に準拠して**どのように技術的・構造的に実現するか（How）**を定義する。

---

## 1. アーキテクチャと基本制約

### 1.1 基本制約の遵守
- **配置場所**: `specula/src/core/scenario_extractor.ts`（ビルド後は `dist/` の JS）（Pure ESM, Target: ES2022+）。
- **Zero-I/O Core の遵守**:
  - 本モジュールはファイルシステム（`fs`）やネットワーク呼び出しを直接行わない。
  - 解析対象のリポジトリメタ情報（ファイル一覧、パッケージ定義、ソーステキスト、ドキュメントテキスト等）は呼び出し元からインメモリデータ構造（または Port）経由で注入されて動作する純粋な計算・解析エンジンとする。
  - LLM はポート（`LanguageModelPort`）経由でだけ呼ぶ（全体基本設計書の「LLM の担当範囲」と「LLM 出力の記録」）。
- **完全決定論的再現性**:
  - 同一の入力データ群に対して、出力される全体マップおよび個別シナリオは完全に決定論的（ソート済み・一意）であること。LLM が作る項目は記録を再利用して一致させる。
  - 識別子（`id`）は、LLM が作る名前からは作らない。ハンドラの所在など、コードから機械的に決まる値から作る。

### 1.2 公開する関数
仕様書 2.2 の 2 つの操作に対応して、関数を 2 つ公開する。

```typescript
discoverSystemContext(repo: RepositoryArtifacts, deps: { llm: LanguageModelPort }): Promise<EventStormingMap>;
sliceScenarios(map: EventStormingMap, selection?: ScenarioSelection, deps?: { llm: LanguageModelPort }): Promise<SliceResult>;
```

---

## 2. 段階的詳細化パイプライン (4-Stage Pipeline)

システム全体のマクロな境界から、ミクロな実行可能シナリオへと段階的に解像度を上げていく。処理はすべて具象化の向き（Bounded Context → 全体マップ → シナリオ）に進み、Loom の基本操作では「置く（分解）」に当たる。

- **置く（分解）**: システム全体から Bounded Context（プロジェクト）を同定して全体マップを作り（Stage 1〜3）、全体マップから個別シナリオ（タスク）を切り出す（Stage 4）。
- **畳む（集約）と移す（伝播）**: 検証と人間の合意の後に行う操作であり、2 回目以降の実行で前回の合意結果を入力として受け取って行う。初回の実行を対象とする現在の設計には含めない（全体仕様 1.5）。

モジュール内部は以下の 4 つの独立したサブパイプラインで構成する。Stage 1〜3 が `discoverSystemContext`、Stage 4 が `sliceScenarios` である。

```
[リポジトリ見取り図データ (Files, Docs, Package, Schemas)]
                           │
                           ▼
┌────────────────────────────────────────────────────────┐
│ Stage 1: ContextBoundaryAnalyzer (境界同定)             │
│  - ディレクトリ/モジュール/スキーマの境界スキャン        │
│  - Bounded Context の分割または単一コンテキストへの集約 │
│  - コンテキストの意図の候補（LLM。記録を再利用）        │
└──────────────────────────┬─────────────────────────────┘
                           │ BoundedContext[]
                           ▼
┌────────────────────────────────────────────────────────┐
│ Stage 2: EventStreamDiscoverer (事実骨格抽出)          │
│  - 状態変化シグナルの検出（AST）                        │
│  - ドメインイベントの命名（LLM。記録を再利用）          │
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
│  - 画面ファイルパス、画像参照、意図の候補のバインド    │
│  - 利用者が定義したシナリオの照合と正規化              │
│  ➔ 【出力 2: ScenarioTarget[]】                        │
└────────────────────────────────────────────────────────┘
```

---

## 3. 各ステージの詳細設計 (Detailed Design)

ソースコードは `@babel/parser`（TypeScript と JSX のプラグインを有効にする）で AST にして読む。正規表現でコードの構造を読まない。

### 3.1 Stage 1: ContextBoundaryAnalyzer (境界同定)
- **入力**: ディレクトリ木構造、`package.json`（monorepo/workspaces）、DBスキーマ定義ファイル群。
- **同定アルゴリズム**:
  1. **明示的境界スキャン**:
     - `packages/*`, `apps/*`, `features/*`, `modules/*`, `domains/*` ディレクトリが存在する場合、各ディレクトリを独立した Bounded Context の第1候補として抽出。
     - DB スキーマ定義が複数ファイルまたはスキーマ名で分離されている場合、エンティティの凝集度に基づいてコンテキストを特定。
  2. **密結合度判定とフォールバック規則**:
     - ディレクトリ分割が存在しない、あるいは全画面がフラットに共通ストア・単一テーブル群を参照している場合、**「境界同定不能」と判定し、システム全体を単一コンテキスト（`DEFAULT_CONTEXT`）にフォールバック**する。
  3. **意図の候補（LLM）**:
     - 各コンテキストの意図（存在理由・責務）の候補を LLM に書かせ、記録して再利用する。`intentStatus` は初回の実行ではすべて `CANDIDATE`。LLM に届かないときは `NOT_GENERATED` として記録する。
- **出力**: `BoundedContextDefinition[]`（識別子、名称、対象ルートパス群、意図の候補）。識別子はルートパスから作る（`DEFAULT_CONTEXT` は固定の識別子）。

### 3.2 Stage 2: EventStreamDiscoverer (事実骨格抽出)
- **入力**: 各 Bounded Context 内のコードファイル群、API/ルーター定義、DBマイグレーション/ミューテーションコード。
- **解析ロジック**:
  1. **状態変化シグナルの検出（決定論。AST）**:
     - DBへの `insert`, `update`, `delete` や Firestore の `addDoc`, `updateDoc` 等のミューテーション呼び出しを検出。
     - イベント発行コード（`emit`, `dispatch`, `publish` 等）を検出。
     - **画面も DB も持たないシステム（ライブラリ、コマンドラインツール）**: パッケージの入口（`package.json` の `exports`・`main`・`bin`、またはそれが再公開するモジュール）から公開されている関数を検出し、その関数の呼び出しの完了を状態変化シグナルとする。
     - シグナルごとに、それを含む関数の名前とファイルの位置を記録する。これが後でコマンドのハンドラになる。
  2. **ドメインイベントの命名（LLM）**:
     - 操作完了時の事実を「過去分詞（Domain Event）」の名前にする（例: `UserRegistered`, `PasswordChanged`, `PaymentCompleted`）。
     - 命名は LLM に任せ、入力（ハンドラ名、シグナルの種類、周辺のコード）をキーに記録して再利用する。関数名の末尾を正規表現で削るような機械的な変換はしない。
     - LLM に届かないときは、イベントの名前を `NOT_GENERATED` として記録する。イベントの識別子（`id`）は、ハンドラの所在から機械的に作るので、名前が未生成でも後段の処理は進む。
  3. **時系列トポロジー整列**:
     - 呼び出しの前提条件や依存関係から、イベント間の先行・後続関係を求める。関係は各イベントの `after`（先に起きるイベントの識別子の一覧）として持つ。配列そのものは識別子の辞書順に並べるので、時系列は `after` から読む。
     - 関係をコードから決められないイベントには `after` を空にする。推測で順序を付けない。
- **出力**: `DomainEvent[]`。

### 3.3 Stage 3: EventStormingAssembler (関係性統合)
- **入力**: `DomainEvent[]`、画面ルーティングファイル（Next.js pages/app routes等）、ハンドラ関数。
- **統合ロジック**:
  1. **コマンド (Command) のバインド**:
     - イベントの直前に実行されるユーザー意思・HTTPリクエスト（例: `ChangePassword`, `SubmitOrder`）を抽出・紐付け。
     - 各コマンドは、自分が発生させるイベントを 1 つ以上持つ。コマンドとイベントの対応は、Stage 2 で記録したハンドラの所在で決める（同じコンテキストの最初のイベントを当てるような決め打ちはしない）。
     - コマンドの名前も LLM が付け、イベントと同じく記録して再利用する。識別子はハンドラの所在から作る。
  2. **アクター (Actor) の特定**:
     - 認証ミドルウェア、権限ロール（`role === 'admin'`, `auth.uid` 等）をスキャンし、コマンドの発行主体（`User`, `Admin`, `SystemWorker` 等）を決定。
     - 認可のコードが見つからないコマンドでは、入口を呼ぶ側（`Caller`）をアクターとする。画面を持たないシステムで公開関数を呼ぶ側も `Caller` である。`Caller` は、入口が存在することから導くアクターであり、決まった一覧から足すものではない。
     - 実装に現れない役割（`Admin` など）を、決まった一覧から足さない。
  3. **リードモデル (Read Model / 画面) の接続**:
     - コマンドが発火される画面ルート、入力フォーム、UIコンポーネントを特定し、リードモデルとして紐付け。
     - 画面が見つからないコマンドには、リードモデルを付けない。別の画面（一覧の先頭など）で埋めない。
  4. **ポリシー (Policy) の同定**:
     - あるイベントをリッスンして非同期に次のコマンドを呼び出すロジック（`onDocumentCreated`, イベントリスナー等）を「ポリシー」として抽出。
     - 対応するリスナーのコードが無いポリシーは作らない。
- **出力**: **`EventStormingMap`**。

### 3.4 Stage 4: ScenarioSlicerResolver (具象シナリオ生成)
- **入力**: `EventStormingMap`、画面キャプチャ一覧、シナリオの選択（`ScenarioSelection`。存在する場合）。
- **スライシングロジック**:
  1. **アトミック因果スライス**:
     - マップ上の各 **`Command`** または **`Policy`** を単一のエントリーポイント（Inlet）として切り出す。
     - 1 つのシナリオの期待イベントは 1 つである。起点のコマンドがイベントを複数発生させるときは、イベントごとに別のシナリオにする。ポリシーが起点のときは、ポリシーが起動するコマンドの発生させるイベントを期待イベントとし、同じく 1 イベントにつき 1 シナリオとする。
     - 紐づく Actor、Read Model（画面パス）、起点の所在（ハンドラのファイルと関数名）、期待イベントを 1 つのタプルとして結合する。
     - シナリオの識別子は `SCN-<起点の識別子>` とする。起点が複数のシナリオに分かれるときだけ、`SCN-<起点の識別子>-<イベントの識別子>` とする。
  2. **具象パスの解決 (Path Resolver)**:
     - 画面ルート（例: `/mypage`）から実際のソースコードファイルパス（例: `src/app/(dashboard)/mypage/page.tsx`）および画面画像パスを確定。
  3. **意図の候補（LLM）**:
     - 意図の文は LLM に任せ、記録して再利用する。`intentStatus` は初回の実行ではすべて `CANDIDATE`。LLM に届かないときは `NOT_GENERATED` として記録する。
  4. **絞り込みと利用者定義のシナリオ**:
     - 起点の指定は、起点の識別子か、ハンドラの所在（`ファイル#関数名`）で行う。LLM が付けた名前では照合しない（未生成のことがあり、版によって変わるため）。
     - `selection.filter` があれば、それに合うシナリオだけを出力する。
     - `selection.userDefined` の各シナリオは、起点が全体マップにあることを確かめてから正規化し、`origin: 'USER_DEFINED'` で出力する。起点が全体マップに無いときは、そのシナリオを出力せず、`rejected` に理由を付けて返す。
     - 抽出したシナリオは `origin: 'EXTRACTED'`。同じ起点のシナリオが両方にあるときは、利用者が定義したものを残す。
- **出力**: **`SliceResult`**（`ScenarioTarget[]` と、受け付けなかった利用者定義のシナリオ）。

---

## 4. データ構造と保持形式 (Data Persistence Model)

LLM が作る文字列は、全体基本設計書で定める `LlmText`（生成済みの文と記録のキー、または未生成とその理由）で持つ。

### 4.1 全体マップ形式 (`EventStormingMap`)
```typescript
interface EventStormingMap {
  boundedContexts: Array<{
    id: string;                    // ルートパスから作る。単一コンテキストは "DEFAULT_CONTEXT"
    name: string;
    rootPaths: string[];
    isDefaultFallback: boolean;
    intent: LlmText;               // 意図の候補
    intentStatus: "CANDIDATE" | "CONFIRMED";
  }>;
  events: Array<{ id: string; name: LlmText; contextId: string; aggregate?: string; handler: SourceLocation; after: string[] }>;
  commands: Array<{ id: string; name: LlmText; contextId: string; actorId: string; readModelId?: string; eventIds: string[]; handler: SourceLocation }>;
  policies: Array<{ id: string; triggerEventId: string; actionCommandId: string; name: LlmText; listener: SourceLocation }>;
  readModels: Array<{ id: string; name: string; route: string; componentFile: string; screenshotPath?: string }>;
  actors: Array<{ id: string; name: string }>; // 認可のコードから見つけた役割と、必要なときだけ "Caller"
}

interface SourceLocation { file: string; symbol: string; line: number }
```

### 4.2 個別シナリオ保持形式 (`ScenarioTarget`)
```typescript
interface ScenarioTarget {
  id: string;                      // "SCN-<起点の識別子>"（起点が複数のシナリオに分かれるときは "-<イベントの識別子>" を足す）
  boundedContext: string;          // Bounded Context の識別子（例: "DEFAULT_CONTEXT"）
  origin: "EXTRACTED" | "USER_DEFINED";
  intent: LlmText;                 // LLM が出す意図の候補
  intentStatus: "CANDIDATE" | "CONFIRMED"; // 人間（PdM）が確定するまでは CANDIDATE
  inletType: "COMMAND" | "POLICY"; // 同期か非同期か
  inletTrigger: {
    id: string;                    // コマンドまたはポリシーの識別子
    name: LlmText;                 // コマンドまたはポリシーの名前
    handler: SourceLocation;       // 起点の所在（M1 はここから追跡を始める）
  };
  actor: {
    id: string;
    name: string;
  };
  readModel?: {                    // 画面を持たないシステムでは無い
    name: string;
    route: string;
    entryFile: string;             // 具象ソースファイルパス
    screenshotPath?: string;       // 画面画像パス
  };
  expectedEvent: string;           // 期待イベントの識別子（1 シナリオに 1 つ）
}

interface ScenarioSelection {
  filter?: { boundedContext?: string; inlets?: string[] };          // 起点の識別子か "ファイル#関数名"
  userDefined?: Array<{ inlet: string; intent?: string; route?: string }>; // inlet も同じ形
}

interface SliceResult {
  scenarios: ScenarioTarget[];
  rejected: Array<{ inlet: string; reason: string }>; // 起点が全体マップに無かった利用者定義のシナリオ
}
```

---

## 5. エラーハンドリングと決定論性

1. **フォールバック保証**:
   - リポジトリ構造が標準的でない場合でも例外でクラッシュさせず、単一 Bounded Context として最低限のシナリオスライスを成立させる。
   - ただし、見つからない要素（画面、ポリシー、実装に現れない役割）を決まった値で埋めることはフォールバックではない。見つからないものは「無い」と出力する。
2. **決定論的正規化**:
   - `EventStormingMap` の全配列、および `ScenarioTarget[]` のソート順は、IDの辞書順で安定ソートされ、何度実行しても同一の出力を保証する。