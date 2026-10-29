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

LLM が作る文字列は、全体基本設計書で定める `LlmText`（生成済みの文と記録のキー、または未生成とその理由）で持つ。型の正は `src/types/scenario.ts` である。

### 4.0 入力 (`RepositoryArtifacts`)
```typescript
interface RepositoryArtifacts {
  files: Array<{ path: string; text: string }>; // テキストのファイルだけ。path はリポジトリのルートからの相対パス（"/" 区切り）
  screenshots?: string[];                       // 画面画像のパス
}
```
ファイルを読むのは呼び出し元（アダプターの側）であり、コアはファイルを読まない。どのファイルを渡すかも呼び出し元が決める。`package.json` と `tsconfig.json` は、`files` に入っていれば読む。

### 4.1 全体マップ形式 (`EventStormingMap`)
```typescript
interface EventStormingMap {
  boundedContexts: Array<{
    id: string;                    // ルートパスから作る（"CTX-<根>"）。単一コンテキストは "DEFAULT_CONTEXT"
    name: string;
    rootPaths: string[];
    isDefaultFallback: boolean;
    intent: LlmText;               // 意図の候補
    intentStatus: "CANDIDATE" | "CONFIRMED";
  }>;
  events: Array<{
    id: string; name: LlmText; contextId: string; aggregate?: string; handler: SourceLocation;
    signal: { kind: "DB_MUTATION" | "EVENT_EMIT" | "PUBLIC_FUNCTION"; callee: string; label: string | null; line: number };
    after: string[];
  }>;
  commands: Array<{ id: string; name: LlmText; contextId: string; actorId: string; readModelId?: string; eventIds: string[]; handler: SourceLocation }>;
  policies: Array<{ id: string; triggerEventId: string; actionCommandId: string; name: LlmText; listener: SourceLocation }>;
  readModels: Array<{ id: string; name: string; route: string; componentFile: string; screenshotPath?: string }>;
  actors: Array<{ id: string; name: string }>; // 認可のコードから見つけた役割と、必要なときだけ "Caller"
  diagnostics: {
    mode: "STATE_SIGNALS" | "PUBLIC_FUNCTIONS";
    entryFiles: string[];          // PUBLIC_FUNCTIONS のときにたどった入口のファイル
    parsedFileCount: number;
    parseFailures: Array<{ path: string; message: string }>;
    unattributedSignals: Array<{ kind: string; file: string; line: number; callee: string }>; // 最上位の名前付き関数の外にあったシグナル
  };
}

interface SourceLocation { file: string; symbol: string; line: number }
```

- `signal` は、イベントのもとになったシグナルの、コードから機械的に決まる値である。後段の LLM の入力に、LLM が付けた名前の代わりに使う（LLM の入力に LLM の結果を入れると、記録のキーが LLM の結果で変わるため）。
- `diagnostics` は、抽出の経過を報告に出すために持つ。構文の解析に失敗したファイルはマップに入れず、ここに記録して先へ進む。

### 4.2 個別シナリオ保持形式 (`ScenarioTarget`)
```typescript
interface ScenarioTarget {
  id: string;                      // "SCN-<起点の識別子>"（起点が複数のシナリオに分かれるときは "-<イベントの識別子>" を足す）
  boundedContext: string;          // Bounded Context の識別子（例: "DEFAULT_CONTEXT"）
  origin: "EXTRACTED" | "USER_DEFINED";
  intent: LlmText;                 // LLM が出す意図の候補
  intentStatus: "CANDIDATE" | "CONFIRMED"; // 人間（PdM）が確定するまでは CANDIDATE
  userIntent?: string;             // 利用者定義のシナリオで利用者が書いた目的。intent（LLM の結果）とは別に持つ
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
  rejected: Array<{ inlet: string; reason: string }>; // 受け付けなかった利用者定義のシナリオと、その理由
}
```

- 利用者が書いた目的（`userDefined[].intent`）は `userIntent` に入れる。`intent` は LLM の結果だけを表す型なので、利用者の文を入れない。`userIntent` があっても `intentStatus` は `CANDIDATE` のままである。
- 利用者定義の `route` は、全体マップのリードモデルのルートと一致するときだけ、そのリードモデルを付ける。一致しなければ、そのシナリオを出さずに `rejected` に理由を付けて返す（推測で画面を作らない）。
- `filter` は抽出したシナリオにだけ効く。利用者定義のシナリオは `filter` によらず出す。

### 4.3 初回の実装で決めたこと
3 章の各段について、初回の実装では次のように決めた。いずれも、見つからないものを決まった値で埋めないための限定である。

| 項目 | 決めたこと |
| :-- | :-- |
| 読むファイル | コードのファイル（`.d.ts` を除く）のうち、`node_modules/`・`tests/`・`__tests__/` の下、`*.test.*`・`*.spec.*`、`tsconfig.json` の `outDir` の下を除いたもの |
| AST | `@babel/parser` で読む。`@babel/types` の型には依存せず、関数・export・import・呼び出しの形だけを読む |
| コンテキストの境界 | `packages/`・`apps/`・`features/`・`modules/`・`domains/` の直下のディレクトリを根とし、根が 2 つ以上あるときだけ分ける。どの根にも入らないファイルは `DEFAULT_CONTEXT` に入れる。DB スキーマによる分割は行わない |
| DB の書き込み | 次の 4 つに限る。firebase のモジュールから import した `addDoc`・`setDoc`・`updateDoc`・`deleteDoc` の呼び出し。受け手の鎖に `collection()` か `doc()` がある `add`・`set`・`update`・`delete`。受け手の鎖に `from()` がある `insert`・`update`・`upsert`・`delete`。受け手の鎖が `prisma` で始まる `create` などの書き込み |
| イベントの発行 | `emit`・`dispatch`・`publish` の呼び出しと、関数 `dispatch` の呼び出し |
| シグナルの持ち主 | シグナルを含む最上位の名前付き関数（宣言と、関数を値に持つ `const`）をハンドラとする。その外（モジュールの最上位、クラスのメソッド）のシグナルはイベントにせず、`diagnostics.unattributedSignals` に残す |
| モード | DB の書き込みも画面も無いときだけ `PUBLIC_FUNCTIONS` とし、入口から公開されている関数 1 つを 1 つのコマンドとする（呼び出しの完了がイベント）。このときもイベントの発行はシグナルとして残す |
| 入口 | `package.json` の `exports`（`types` の枝、`*` を含むもの、`.d.ts` を除く）・`main`・`module`・`bin`。指す先が `outDir` の下なら `rootDir` の下の元のファイルに戻す（例: `dist/src/index.js` → `src/index.ts`）。見つからなければ `src/index.*` か `index.*`。再公開（`export ... from`、`export *`、import した名前の `export { a }`）はたどる。公開されている関数は関数の宣言と、関数を値に持つ `const` だけで、クラス・定数・型は数えない。`tsconfig.json` と `package.json` はコメントと末尾のカンマを許して読む |
| イベントの分け方 | 1 つのハンドラの中のシグナルを（種類、呼んでいる関数の名前、最初の文字列の引数）で分け、1 組を 1 イベントとする |
| 識別子 | コマンドは `CMD-<ファイル>#<関数名>`、イベントは `EVT-<ファイル>#<関数名>`（1 つのハンドラに 2 組以上あるときは、最初に現れた行の順に `-1`、`-2` を付ける）、ポリシーは `POL-<登録のファイル>#<関数名>@<行>`、リードモデルは `RM-<画面のファイル>`、アクターは `ACT-<役割>` |
| after | ポリシーでつながるときだけ、起動されるコマンドのイベントの `after` にきっかけのイベントを入れる。それ以外は空 |
| アクター | ハンドラの中の `role` の比較（`x.role === "admin"` など）の文字列から作る。`auth.uid` からは名前を作らない。見つからなければ `Caller` |
| リードモデル | Next.js の `app/**/page.*` と、`pages/` の下の `.tsx`・`.jsx`（`_app` などの `_` で始まるもの、`api/` を除く）。画面のファイルがハンドラのファイルそのものか、ハンドラを import しているときだけ、コマンドに付ける。画像は、名前がルートを `_` でつないだもの（`/` は `index`）と一致するものだけ付ける |
| ポリシー | `on`・`once`・`addListener`・`addEventListener`・`subscribe` によるリスナーの登録で、名前がイベントの発行の最初の文字列と一致し、渡された関数がコマンドのハンドラであるもの |
| ポリシーが起点のシナリオ | 起点の所在はリスナーの登録の場所とする（コマンドのハンドラにすると、コマンドが起点のシナリオと同じ中身になるため）。アクターとコンテキストは起動されるコマンドのものを使い、リードモデルは付けない |
| アグリゲート | 初回は付けない |
| LLM の処理 | `m0.context-intent`・`m0.name-event`・`m0.name-command`・`m0.name-policy`・`m0.scenario-intent` の 5 つ（`promptVersion` は "1"）。名前は PascalCase の 1 語、意図は改行の無い 200 字以内の 1 文であることを確かめ、合わなければ `INVALID_OUTPUT` とする。入力にはコードから機械的に決まる値（ハンドラの所在、シグナル、関数の頭の 12 行）だけを入れ、ほかの LLM の結果は入れない |

---

## 5. エラーハンドリングと決定論性

1. **フォールバック保証**:
   - リポジトリ構造が標準的でない場合でも例外でクラッシュさせず、単一 Bounded Context として最低限のシナリオスライスを成立させる。
   - ただし、見つからない要素（画面、ポリシー、実装に現れない役割）を決まった値で埋めることはフォールバックではない。見つからないものは「無い」と出力する。
2. **決定論的正規化**:
   - `EventStormingMap` の全配列、および `ScenarioTarget[]` のソート順は、IDの辞書順で安定ソートされ、何度実行しても同一の出力を保証する。