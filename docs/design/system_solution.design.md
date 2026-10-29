# 汎用仕様抽出・検証システム 全体基本設計書 (System Solution Design)

本設計書は、システム全体仕様書（`system_solution.spec.md`）に規定された振る舞い・契約を**どのように技術的・構造的に実現するか（How）**を定義する。

---

## 1. 根本思想: 3アクター分担と Loom オーケストレーション

### 1.1 3 アクターの責任分界点 (Division of Labor)
本システムの中核思想は、**「LLM単体に論理的計算・証明をさせない」**ことである。
LLMを「計算機」ではなく、**「人間と数学的決定論的ソルバ（計算機）の間を取り持つ翻訳・合成インターフェース」**として位置づける。

| アクター | 役割の定義 | 担当する具体的な処理 | 禁忌（アンチパターン） |
| :--- | :--- | :--- | :--- |
| **人間 (PdM / 意思決定者)** | **「意図」と「価値判断」** | 要求の提示、意図の確定、意思決定論点（Domain Ledger）に対する判断 | 全状態探索、エッジケースの網羅的暗算 |
| **LLM** | **「翻訳」と「要約」** | 抽出済みの事実への命名、実装の語からドメインの語への言い換え、反例の自然言語化、意図の候補の文 | コードからの事実の抽出、仕様の矛盾の「推測解決」、論理証明の自己完結、選択肢の採択 |
| **外部ツール（パーサとソルバ）** | **「決定論的な抽出」と「上限つきの網羅的な検査」** | `@babel/parser` による AST の構築、Alloy 6 による、スコープとステップ数の範囲での未定義遷移・操作の重なり・到達できない操作・デッドロックの検出 | 自然言語の解釈、ビジネス要件の勝手な補完 |

事実の抽出（どの関数がどの状態を変えるか、どの分岐があるか）は AST から決定論的に行う。LLM はその結果に名前と文を付けるだけで、事実を作らない。

### 1.2 LLM の担当範囲と決定論性の約束
どのモジュールのどの処理が LLM を使うかを、ここに一覧する。決定論性の約束は、処理の担当によって分ける（全体仕様書 3.3 の 2）。

| モジュール | LLM を使う処理 | 決定論的な処理 | 決定論性の約束 |
| :--- | :--- | :--- | :--- |
| M0 ScenarioExtractor | ドメインイベントとコマンドの命名、Bounded Context とシナリオの**意図の候補** | 境界のスキャン、ミューテーション・ルート・ハンドラの検出、識別子の生成、ソート | LLM の出力は記録して再利用する。それ以外は再実行で一致 |
| M1 ContextExtractor | なし | AST による事実抽出のすべて | 再実行で一致 |
| M2 FormalTranspiler | 実装の識別子からドメイン語彙への言い換え（DomainVocabularyMapper） | 状態の組み立て、Alloy の構文木の組み立て、曖昧性の検知、正準化出力 | 言い換えの結果は対応表として記録して再利用する。それ以外は再実行で一致 |
| M3 FormalSolver | なし | 検査コマンドの組み立て、Alloy 6 の実行、結果の正規化 | 同一の実行条件のもとで一致 |
| M4 LedgerSynthesizer | 反例の自然言語化（主張・観測事実・判断質問・選択肢の文） | 反例どうしの依存の分析、トポロジカルソート、グルーピング | 文は記録して再利用する。論点の構成は再実行で一致 |
| M5 SpecProjector | なし | 射影のすべて | 再実行で一致 |

- **記録して再利用する**: LLM の出力は、入力とプロンプトの版をキーとして保存し、再実行ではそれを使う（1.3）。記録を作り直すのは、入力かプロンプトの版が変わったとき、または人間が指示したときに限る。
- **意図は人が確定する**: M0 が出す意図は候補であり、人間（PdM）が確定するまでは候補として扱う。Loom で `## 意図` を人が置くのと同じ扱いである。

### 1.3 LLM の呼び出しと出力の記録
コアモジュールは LLM を `LanguageModelPort` 経由でだけ呼ぶ。返り値は常に `LlmText` であり、LLM に届かなかったことも値として表す（例外にしない）。

```typescript
type LlmText =
  | { status: "GENERATED"; text: string; recordKey: string }
  | { status: "NOT_GENERATED"; reason: "UNREACHABLE" | "INVALID_OUTPUT"; detail: string };

interface LlmRequest {
  task: string;            // 処理の種類（例: "m0.name-event"）
  promptVersion: string;   // プロンプトの版。プロンプトを変えたら上げる
  input: unknown;          // JSON にできる値だけ
}

interface LanguageModelPort {
  generate(request: LlmRequest): Promise<LlmText>;
}
```

- **記録のキー**: `task`・`promptVersion`・正準化した `input`（キーを辞書順に並べた JSON）をつないだ文字列の SHA-256。ハッシュは Web Crypto（`globalThis.crypto.subtle`）で計算する。Node.js 22 とブラウザの両方にあるので、依存を足さない。
- **記録の置き場所**: 解析結果の出力先の下の `llm-records/<キー>.json`。中身は `request`・`text`・使ったモデル名・日時。読み書きは `FileSystemPort` を通す。
- **記録を扱う層**: 記録の参照と保存は、アダプター層の `RecordingLanguageModel` が行う。これは `LanguageModelPort` を実装し、内側に実際の LLM のアダプターと `FileSystemPort` を持つ。コアは記録の有無を知らない。
- **出力の検査**: 各処理は、LLM の出力が期待する形か（例: イベント名が識別子として使える 1 語か）を確かめる。形が合わなければ `INVALID_OUTPUT` として扱い、記録しない。
- **届かないとき**: LLM に届かない（ポートが無い、接続できない、時間切れ）ときは `UNREACHABLE` を返し、記録しない。次の実行で改めて呼ぶ。未生成の項目を、機械的に作った文や名前で埋めない。

### 1.4 ソルバに届かないとき
M3 は `SolverPort` 経由で Alloy 6 を呼ぶ。ソルバに届かないとき（ポートが無い、ローカルブリッジにつながらない、時間切れ）は、報告の状態を `UNVERIFIED`（未検証）とし、理由を付ける。反例が無いことを意味する状態（検証済み）にしない。M4 と M5 は、未検証の報告をそのまま「未検証」と表示する。

---

## 2. 全体アーキテクチャと 6 モジュールパイプライン

各モジュールは互いの存在・結合順序を一切知らず、入力契約（Input Contract）と出力契約（Output Contract）のみに依存する。全体パイプラインのワイヤリングおよびデータ中継は、オーケストレーター（`orchestrator.ts`）が集約管理する。オーケストレーターもコアに属し、ポートを受け取って動く。

```
[リポジトリ全体 (コード/Docs/画面)]
               │
               ▼
┌────────────────────────────────────────────────────────┐
│ M0: ScenarioExtractor                                  │
│  - Stage 1: ContextBoundaryAnalyzer (境界同定)         │
│  - Stage 2: EventStreamDiscoverer (事実骨格)           │
│  - Stage 3: EventStormingAssembler ➔ EventStormingMap │ 【置く: プロジェクト】
│  - Stage 4: ScenarioSlicerResolver ➔ ScenarioTarget[] │ 【置く: タスク】
└──────────────────────┬─────────────────────────────────┘
                       │ ScenarioTarget
                       ▼
┌────────────────────────────────────────────────────────┐
│ M1: ContextExtractor                                   │
│  - 単一シナリオ因果境界追跡 (Inlet ➔ Outlet)           │
│  - 非同期境界の切断、分岐スライシング                  │
│  ➔ RawContextModel                                     │ 【抽出: 事実スライス】
└──────────────────────┬─────────────────────────────────┘
                       │ RawContextModel
                       ▼
┌────────────────────────────────────────────────────────┐
│ M2: FormalTranspiler                                   │
│  - 状態変数と分岐の結果から状態を組み立てる            │
│  - 実装詳細の隠蔽、ドメイン語彙への言い換え            │
│  - 状態を決められなければ AmbiguityReport（件数も出す）│
│  ➔ FormalSpec (Alloy 6 形式仕様コード)                 │ 【昇華: 形式モデル】
└──────────────────────┬─────────────────────────────────┘
                       │ FormalSpec
                       ▼
┌────────────────────────────────────────────────────────┐
│ M3: FormalSolver                                       │
│  - Alloy 6（外部実行・SolverPort 経由）による          │
│    スコープとステップ数の範囲での網羅的な検査          │
│  - 届かなければ UNVERIFIED と理由                      │
│  - 状態爆発時の分割実行は範囲外（現在は分割しない）    │
│  ➔ SolverReport (元の記録: 全反例＋実行条件)           │ 【検査: 決定論的検証】
└──────────────────────┬─────────────────────────────────┘
                       │ SolverReport + FormalSpec
                       ▼
┌────────────────────────────────────────────────────────┐
│ M4: LedgerSynthesizer                                  │
│  - 反例の自然言語化、根本論点の抽出                    │
│  - 意思決定の問いと選択肢の提示（採択は人が行う）      │
│  ➔ DomainLedgerCatalog                                 │ 【論点の整理】
└──────────────────────┬─────────────────────────────────┘
                       │ FormalSpec + DomainLedgerCatalog
                       ▼
┌────────────────────────────────────────────────────────┐
│ M5: SpecProjector                                      │
│  - 1 つの中間表現から各ビューを作る（論点は未決と表示）│
│  ➔ 仕様書 / 操作の一覧表 / 操作の流れ図 / 全体の俯瞰図 │ 【射影: 複数のビュー】
└────────────────────────────────────────────────────────┘
```

M2 が `AmbiguityReport` を返したシナリオは、そこで止まる（M3 以降に進まない）。オーケストレーターは、シナリオごとに「M5 まで進んだ」か「どの段で何の理由で止まったか」を実行の報告に残し、`AmbiguityReport` の件数と中身を集計する。

---

## 3. Loom ライフサイクルの全体実装

本システム全体のオーケストレーションは、Loom の 3 つの基本操作をパイプライン全体に渡って適用することで駆動される。初回の実行で行うのは「置く」だけであり、「畳む」と「移す」は人間の合意の後、2 回目以降の実行で行う（全体仕様 1.5）。現在の設計と実装の範囲は初回の実行である。

### 3.1 「置く（分解 / Decompose）」のフロー（初回から行う）
1. **マクロ置く**: M0 がリポジトリ全体から Bounded Context（プロジェクト）を同定し、Event Storming 全体マップ上に境界を敷く。
2. **ミクロ置く**: M0 がコマンド・ポリシーを起点として個別シナリオ（タスク）をアトミックに切り出す。
3. **事実スライス置く**: M1 が各個別シナリオの因果境界（Inlet ➔ Outlet）のみをピンポイントで切り出し、M2 が形式仕様述語へとコンパイルする。

### 3.2 「畳む（集約 / Fold）」のフロー（2 回目以降。現在の範囲外）
1. **親文脈への還元**: 人間が合意した意思決定結果（Domain Ledger の決定）と、検査で確かめた事実（検査の種類と範囲を添える）を、親である Bounded Context の「仕様正本・ドメイン文脈」へと畳む。
2. 初回の実行で M4 が行う論点のグルーピングは、反例を論点として整理する処理であり、この「畳む」には当たらない。

### 3.3 「移す（伝播 / Transfer）」のフロー（2 回目以降。現在の範囲外）
1. ある Bounded Context（例: `ユーザー認証`）のシナリオ完了で確定したドメインイベント（例: `UserRegistered`）を、別コンテキスト（例: `通知基盤`）のポリシー起動トリガーへと越境伝播させる。
2. 両コンテキストは直接結合せず、Event Storming Map 上の共有イベント定義のみを介して疎結合に結合する。

---

## 4. アーキテクチャ特性と物理構造規約

### 4.1 Zero-I/O Core とポート・アダプター
本システムは、Node.js（コマンドラインと GitHub Actions）と Itera OS（ブラウザ）の両方で、同じコアのコードで動く。どちらの環境でも、ほかのサービスに頼らず単独で（Standalone で）動く。
- **Core モジュールの純粋性**:
  - `M0` 〜 `M5` とオーケストレーターは、直接 `fs` や `fetch`、`child_process`、DOM を一切インポートしない。
  - すべてインメモリデータとポートを受け取り、インメモリデータを返す。
- **ポート（抽象インターフェース）は 3 つ**:

| ポート | 役割 | Node.js 側のアダプター | Itera OS 側のアダプター |
| :--- | :--- | :--- | :--- |
| `FileSystemPort` | 解析対象の読み取り、出力と LLM の記録の書き込み | `NodeFsAdapter`（`node:fs/promises`） | `IteraVfsAdapter`（`MetaOS.fs`） |
| `SolverPort` | Alloy 6 の実行 | `CliAlloyAdapter`（`java` を子プロセスで起動） | `LocalBridgeAlloyAdapter`（ローカルブリッジ経由で手元の PC の `java` を起動） |
| `LanguageModelPort` | LLM の呼び出し（1.3） | `ClaudeCodeCliAdapter`（Claude Code CLI を子プロセスで起動） | `IteraLlmAdapter`（Itera から LLM を呼ぶ） |

- 両環境のアダプターは、`RecordingLanguageModel`（1.3）で包んで使う。
- 検証エンジンは Alloy 6 の 1 系統に限り、環境ごとに別のエンジンを使わない。Alloy の版と SAT ソルバは、Alloy 6 の推奨の版と既定のソルバとし、実際に使った版とソルバを `SolverReport` に記録する。
- **未確定の事項**: `LocalBridgeAlloyAdapter` がローカルブリッジのどの口を呼ぶか、`IteraLlmAdapter` がどの API を呼ぶかは、まだ確かめていない。決まったら本節に書き足す。決まるまでは、両アダプターは届かないものとして扱い、M3 は `UNVERIFIED`、LLM の項目は `NOT_GENERATED` になる。
- **入口**: Node.js 用のコマンドライン（`src/cli.ts`）と、Itera OS 用の起動アプリを置く。どちらも、アダプターを組み立ててオーケストレーターに渡すだけで、解析の処理は持たない。

### 4.2 言語・ビルドパイプライン方針 (TypeScript ➔ JavaScript ESM)
- **開発・実装言語**: **TypeScript (`.ts`)**。型の検査は `strict` で行い、`any` を使わない。
- **実行形式**: **JavaScript (Pure ESM, Target: ES2022)**。
- **ビルド**:
  - `tsc` で `src/` と `tests/` を `dist/` へ出力する（`dist/src/`・`dist/tests/`）。
  - Itera OS 用には、`esbuild` で `dist/src` から 1 ファイルの ESM（`dist/specula.itera.js`）を作る。Itera OS のアプリは `@babel/parser` のような名前だけの import を解決できないため、依存を含めて 1 つにまとめる。
  - `dist/` は `.gitignore` に入れ、リポジトリに置かない。手で書いた `dist/` や bundle を置かない。Itera OS から使うために一時的に必要なときだけ、そのことを PR に書いたうえで置いてよい。
- **テスト**:
  - テストは `tests/` に `.test.ts` で書き、Node.js 組み込みのテストランナー（`node:test` と `node:assert`）を使う。
  - 実行は Node.js 22 で、ビルドの後に `node --test "dist/tests/**/*.test.js"`。
  - テストは、実際の入力から作った出力を `assert` で確かめる。決まった値を返すだけのテストを置かない。
- **CI**: GitHub Actions で、push と PR ごとに `npm ci`、型の検査（`tsc --noEmit`）、ビルド、テストを走らせる。Alloy を使うテストは、Java と Alloy がある環境でだけ走らせる（無ければ、届かないときの扱い 1.4 を確かめるテストだけを走らせる）。
- **依存の方針**: 実行時の依存は `@babel/parser` だけにする。開発用の依存は `typescript` と `esbuild` だけにする。小さく書けるもの（ハッシュ、JSON の正準化、グラフの整列など）は自分で書く。Node.js 22 とブラウザの両方にある標準の機能（Web Crypto など）は使ってよい。
- **リポジトリ構造規約**:
  ```
  specula/
  ├── package.json          # Pure ESM, type: "module"
  ├── tsconfig.json         # Target: ES2022, Module: NodeNext, strict
  ├── .github/workflows/    # CI（型の検査・ビルド・テスト）
  ├── src/                  # TypeScript ソースコード (.ts)
  │   ├── types/            # モジュール間の契約の型
  │   ├── ports/            # FileSystemPort / SolverPort / LanguageModelPort
  │   ├── adapters/         # NodeFs, CliAlloy, ClaudeCodeCli, IteraVfs, LocalBridgeAlloy, IteraLlm, RecordingLanguageModel
  │   ├── cli.ts            # Node.js の入口
  │   └── core/             # Zero-I/O コアパイプライン
  │       ├── scenario_extractor.ts   # M0: シナリオ同定・イベントストーミング
  │       ├── context_extractor.ts    # M1: 因果境界事実抽出
  │       ├── formal_transpiler.ts    # M2: 形式仕様コンパイル
  │       ├── formal_solver.ts        # M3: 数学ソルバ・検証
  │       ├── ledger_synthesizer.ts   # M4: 論点の自然言語化・根本論点の抽出
  │       ├── spec_projector.ts       # M5: 多面的仕様射影
  │       └── orchestrator.ts         # 全体パイプライン制御
  ├── dist/                 # ビルド生成物（.gitignore。リポジトリに置かない）
  └── tests/                # テスト (.test.ts)
  ```