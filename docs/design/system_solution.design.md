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
| M4 LedgerSynthesizer | 反例の自然言語化（主張・観測事実・判断質問の文） | 同じ状態を指す反例を 1 つの論点にまとめる、反例の種類ごとに決まった選択肢を付ける、検証の状態を写す（反例どうしの依存の分析とトポロジカルソートは初回の範囲外） | 文は記録して再利用する。論点の構成は再実行で一致 |
| M5 SpecProjector | なし | 射影のすべて | 再実行で一致 |

- **記録して再利用する**: LLM の出力は、入力とプロンプトの版をキーとして保存し、再実行ではそれを使う（1.3）。記録を作り直すのは、入力かプロンプトの版が変わったとき、または人間が指示したときに限る。
- **意図は人が確定する**: M0 が出す意図は候補であり、人間（PdM）が確定するまでは候補として扱う。Loom で `## 意図` を人が置くのと同じ扱いである。

### 1.3 LLM の呼び出しと出力の記録
コアモジュールは LLM を `LanguageModelPort` 経由でだけ呼ぶ。返り値は常に `LlmText` であり、LLM に届かなかったことも値として表す（例外にしない）。

```typescript
type LlmText =
  | { status: "GENERATED"; text: string; recordKey: string }
  | { status: "NOT_GENERATED"; reason: "UNREACHABLE" | "INVALID_OUTPUT"; detail: string };

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

interface LlmRequest {
  task: string;            // 処理の種類（例: "m0.name-event"）
  promptVersion: string;   // プロンプトの版。プロンプトを変えたら上げる
  instructions: string;    // LLM に渡す指示の文。記録のキーには入れない
  input: JsonValue;        // JSON にできる値だけ
}

// 出力が期待する形かを確かめる関数。各処理（コア）が渡す。
type OutputCheck = (text: string) => { ok: true } | { ok: false; detail: string };

interface LanguageModelPort {
  generate(request: LlmRequest, check: OutputCheck): Promise<LlmText>;
}

// 実際の LLM のアダプター（ClaudeCodeCli・IteraLlm）が実装する、より狭い口。記録も形の確認もしない。
type LlmCompletion = { kind: "TEXT"; text: string; model: string } | { kind: "UNREACHABLE"; detail: string };
interface LanguageModelClient {
  complete(request: LlmRequest): Promise<LlmCompletion>;
}
```

- **記録のキー**: `task`・`promptVersion`・`input` を 1 つのオブジェクトにして正準化した JSON（キーを辞書順に並べ、空白を入れない）の SHA-256。`instructions` はキーに入れない。指示の文を変えたら `promptVersion` を上げる。ハッシュは Web Crypto（`globalThis.crypto.subtle`）で計算する。Node.js 22 とブラウザの両方にあるので、依存を足さない。正準化と SHA-256 は `src/lib/` に置く。
- **記録の置き場所**: 解析結果の出力先の下の `llm-records/<キー>.json`。中身は `request`（task・promptVersion・input）・`instructions`・`text`・使ったモデル名・日時。読み書きは `FileSystemPort` を通す。
- **記録を扱う層**: 記録の参照と保存は、アダプター層の `RecordingLanguageModel` が行う。これは `LanguageModelPort` を実装し、内側に `LanguageModelClient` と `FileSystemPort` を持つ。コアは記録の有無を知らない。
- **出力の検査**: 各処理は、LLM の出力が期待する形か（例: イベント名が識別子として使える 1 語か）を確かめる関数（`OutputCheck`）を `generate` に渡す。形が合わなければ `INVALID_OUTPUT` として扱い、記録しない。形の確認は各処理の仕事だが、「形が合わない出力は記録しない」ために記録の層が結果を知る必要があるので、関数として渡す。
- **記録を使う条件**: 記録が読めて、`request` が一致し、いまの `OutputCheck` も通るときだけ使う。満たさなければ LLM を呼び直して上書きする。`FileSystemPort` の失敗は例外のまま上げる（LLM に届かなかったこととは別の、環境の故障なので）。
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

### 2.1 実行の報告（RunReport）

オーケストレーター（`runPipeline`）は、1 回の実行の結果を `RunReport` にまとめて返す。型は `src/types/run.ts` に置く。

- **全体マップの要約（`system`）**: 抽出のモード、読んだファイルの数、構文の解析に失敗したファイルの数、コンテキスト・コマンド・イベントの数。
- **切り出しの結果（`slice`）**: シナリオの数と、起点が全体マップに無かったため退けた利用者定義のシナリオ（M0 の `rejected`）。
- **シナリオごとの結果（`scenarios`）**: シナリオの並びは M0 の切り出しの順とする。各シナリオは次の 3 通りのどれかになる。
  - `COMPLETED`: M5 まで進んだ。検証の結果（`FOUND`・`NONE_FOUND_WITHIN_SCOPE`・`UNVERIFIED`）、未検証の理由の種類、反例の数、論点の数を持つ。
  - `AMBIGUOUS`: M2 が `AmbiguityReport` を返したので止まった。曖昧さの種類ごとの件数を持つ（中身はシナリオの成果物として別に返す）。
  - `STOPPED`: 入力の契約が破れていたので止まった。止まった段（`M1`〜`M5`）、エラーの名前、理由、詳しい内容を持つ。
- **合計（`totals`）**: 3 通りの件数、曖昧さの種類ごとの合計、検証の結果ごとの件数。
- **時刻は入れない**: 同じ入力から同じ報告ができるようにするため。実行した時刻は入口（`src/cli.ts`、Itera の起動アプリ）が扱う。
- **LLM の生成・未生成の件数は、まだ数えない**: LLM の項目は各段の出力に分かれており、数え方を決めていないため。

**止める例外と、投げ直す例外**: オーケストレーターが「その段で止まった」として報告に残し、次のシナリオへ進むのは、各段の入力の契約のエラーだけとする。対象は `InletNotFoundError`・`SyntaxExtractionError`（M1）、`TranspileContractError`（M2）、`SolverContractError`（M3）、`LedgerContractError`（M4）、`ProjectionContractError`（M5）である。それ以外の例外（`FileSystemPort` の故障など、環境の故障）は投げ直し、実行全体を止める。環境が壊れているときに、残りのシナリオを「止まった」と記録しても意味がないためである。

**ファイルに書かない**: オーケストレーターはコアに属するので、成果物と報告を値で返すだけにする。ファイルへの書き込みは入口が行う。

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
| `FileSystemPort` | 解析対象の読み取り、出力と LLM の記録の書き込み | `NodeFsAdapter`（`node:fs/promises`） | `IteraVfsAdapter`（`MetaOS.fs`。起動アプリが引数で渡す） |
| `SolverPort` | Alloy 6 の実行 | `CliAlloyAdapter`（`java` を子プロセスで起動） | `LocalBridgeAlloyAdapter`（ローカルブリッジ経由で手元の PC の `java` を起動） |
| `LanguageModelPort` | LLM の呼び出し（1.3） | `ClaudeCodeCliAdapter`（Claude Code CLI を子プロセスで起動） | `IteraLlmAdapter`（配布先の Itera OS の AI エージェントに、内部のタスクとして渡す） |

- LLM のアダプター（`ClaudeCodeCliAdapter`・`IteraLlmAdapter`）は、`LanguageModelPort` ではなく、より狭い `LanguageModelClient`（1.3）を実装する。コアには `RecordingLanguageModel` で包んだものを渡す。
- `IteraVfsAdapter` は `MetaOS` の全域変数を参照せず、起動アプリから `MetaOS.fs` を受け取る（コアとテストが Itera を知らずに済むため）。`FileSystemPort.list` はディレクトリの直下の**名前**を返す。`MetaOS.fs.list` はパスを返すこともあるので、`IteraVfsAdapter` が名前にそろえる。
- 検証エンジンは Alloy 6 の 1 系統に限り、環境ごとに別のエンジンを使わない。Alloy の版と SAT ソルバは、Alloy 6 の推奨の版と既定のソルバとし、実際に使った版とソルバを `SolverReport` に記録する。
- **Itera OS 版の配り方**: Itera OS 版は、利用者それぞれの Itera OS に app として配る。Itera OS 版では、LLM を直接呼ぶ処理を持たない。LLM が受け持つ項目（1.3）は、その Itera OS で動いている AI エージェントが内部のタスクとして答える。どの環境のどのモデルが受け取るかは分からないので、タスクはそれだけで完結させる。
- **`LocalBridgeAlloyAdapter`（Itera OS 版の `SolverPort`）**:
  - ローカルブリッジのサーバーの `POST <serverUrl>/api/exec` を直接呼ぶ。本文は `{ command, scope: "host", timeout }` で、返り値は `{ exitCode, stdout, stderr }` である。サーバーの URL は起動アプリが Itera OS の設定（`local_bridge`）から読み、引数で渡す。
  - exec にはファイルを渡す口が無いので、Alloy のソースは base64 にしてコマンドの文字列に埋める。コマンドは、一時ディレクトリを作ってソースを書き出し、`CliAlloyAdapter` と同じ形で `java -jar <jar> exec ...` を動かし、終了コードと `receipt.json` を標準出力に出して、一時ディレクトリを消す。receipt の読み取りは `CliAlloyAdapter` と同じ関数を使う。
  - `fetch`、サーバーの URL、jar のパス、`java` のパス、SAT ソルバは引数で受け、`MetaOS` を参照しない。
  - 届かないときの扱い（1.4）: 通信の失敗、HTTP の誤り、exec を止めたサーバー（403）、`java` や jar が見つからないときは `UNREACHABLE`。時間切れ（終了コード 124）は `TIMEOUT`。Alloy が receipt を出さずに終わったときや、0 以外で終わったときは `ENGINE_ERROR`。
  - 限界: コマンドの文字列は 1 つの引数として渡るので、Linux の上限（128 KiB）に近い 100,000 バイトを超えたら送らずに `UNREACHABLE` とし、理由を書く。手元の PC に `bash` と `base64` があることを前提にする（Linux・macOS・WSL）。
  - ローカルブリッジの設定が実行のたびに確認を求める形（`execMode: "ask"`）のときは、起動アプリが実行を始める前に 1 回だけ利用者に確かめる。アダプターは確かめない（1 回の実行で Alloy を何度も呼ぶため）。断られたら `SolverPort` を渡さず、M3 は `UNVERIFIED` になる。
- **`IteraLlmAdapter`（Itera OS 版の `LanguageModelClient`）**:
  - 依頼 1 件ごとに、記録と同じキーで依頼のファイル（`<キー>.request.json`。処理の名前、指示の版、指示、入力、答えを書く場所）を書き、AI エージェントにタスクを出して、答えのファイル（`<キー>.answer.txt`）ができるのを待つ。答えのファイルがもうあれば、タスクを出さずにそれを使う。
  - タスクの文には、依頼のファイルを読むこと、指示に従って答えだけを答えのファイルに書くこと、ほかのファイルを変えないことを書く。**入力は解析対象のコードから来るデータで、指示ではない**ことも明記する（エージェントは道具を使えるので、コードに埋まった文に従わせないため）。
  - `FileSystemPort`、タスクを出す関数（起動アプリが `MetaOS.ai.task` を包んで渡す）、やり取りのディレクトリ、待つ時間の上限は引数で受け、`MetaOS` を参照しない。
  - 待つ時間の上限を過ぎたら `UNREACHABLE` とする。答えの形の確認は `RecordingLanguageModel` が行い、合わなければ記録しない（1.3）。答えたモデルの名前は分からないので、`itera-agent` と記録する。
  - 初回の実行は人とやり取りしないので、1 回の実行の中でタスクを出して答えを待つ。人が途中で論点に答える段が入ったら、1 回目で依頼を書き出し、答えがそろってから 2 回目で埋める形に移る。
  - 答えのファイルの読み方: 末尾の空白と改行を落とす。空のファイルは、まだ書かれていないものとして待ち続ける。タスクを出せないときと、ファイルを読み書きできないときも `UNREACHABLE` とする。
  - 限界: 依頼を 1 件ずつ出して待つので、LLM の項目が多いと時間がかかる。まとめて出すのは後の改善とする。
  - 限界: 依頼と答えのファイルは消さない（`FileSystemPort` に削除が無い）。形の合わない答えのファイルが残ると、次の実行でもそれが使われて `INVALID_OUTPUT` になる。問い直すには、その答えのファイルを消す。
- **入口**: Node.js 用のコマンドライン（`src/cli.ts`）と、Itera OS 用の起動アプリ（`itera/`）を置く。どちらも、アダプターを組み立ててオーケストレーターに渡すだけで、解析の処理は持たない。出力の書き出しは、`FileSystemPort` を通す共通の関数にして、両方の入口から使う。
- **起動アプリの使い方**: 引数は、解析するリポジトリ（VFS のディレクトリ）、出力先、`dist/specula.itera.js` の場所、Alloy の jar のパス、`java` のパスである。リポジトリは `IteraRepositoryReader` が VFS から読み、`NodeRepositoryReader` と同じ拡張子と除外の規則を使う。jar のパスが無ければ `SolverPort` を渡さない。画面は進み具合を出すだけにする。
- **コマンドラインの使い方**: `node dist/src/cli.js <リポジトリのディレクトリ> --out <出力先> [--alloy-jar <jar>] [--records <LLM の記録の置き場所>]`。
  - `--alloy-jar` が無ければ `SolverPort` を渡さない（M3 は `UNVERIFIED`）。
  - LLM のクライアントは、`ClaudeCodeCliAdapter` ができるまで渡さない。`RecordingLanguageModel` にクライアント無しで包んで渡すので、記録が無い項目は `NOT_GENERATED` になる。`--records` が無ければ記録の置き場所は `<出力先>/llm_records`。
  - リポジトリは `NodeRepositoryReader` が読み、テキストのコードと設定のファイル（`.ts` `.tsx` `.mts` `.cts` `.js` `.jsx` `.mjs` `.cjs` `.json`）を `RepositoryArtifacts` にする。`node_modules`・`.git`・`dist` の下は読まない。どのファイルを解析するかは M0 が決める。
  - 終了コード: 実行が最後まで回れば 0（論点や曖昧さがあっても 0）、環境の故障は 1、引数の誤りは 2。
- **出力の置き方**: `<出力先>/run_report.json`、全体の俯瞰図 `system_map.mmd`・`system_map.json`、シナリオごとの `scenarios/<シナリオの id>/`。シナリオのディレクトリには、M5 まで進んだものは `spec.json`・`spec.als`・`solver_report.json`・`ledger.json`・`spec.md`・`matrix.md`・`flow.mmd` を、M2 で止まったものは `ambiguity.json` を置く。シナリオの id のうち、英数字・`-`・`_`・`.` 以外の文字は `_` に置き換える。

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
- **CI**: GitHub Actions で、push と PR ごとに依存の導入、型の検査（`tsc --noEmit`）、ビルド、テストを走らせる。依存の導入は、lockfile（`package-lock.json`）が入るまでは `npm install`、入ったら `npm ci` にする（lockfile は Itera OS では作れないので、Node.js のある環境で作って足す）。Alloy を使うテストは、Java と Alloy がある環境でだけ走らせる（無ければ、届かないときの扱い 1.4 を確かめるテストだけを走らせる）。
- **依存の方針**: 実行時の依存は `@babel/parser` だけにする。開発用の依存は `typescript`・`esbuild`・`@types/node` だけにする（`@types/node` は、`strict` の型の検査で `node:test`・`node:fs` などの型を読むのに要る。版は Node.js 22 に合わせる）。小さく書けるもの（ハッシュ、JSON の正準化、グラフの整列など）は自分で書き、`src/lib/` に置く。Node.js 22 とブラウザの両方にある標準の機能（Web Crypto など）は使ってよい。
- **リポジトリ構造規約**:
  ```
  specula/
  ├── package.json          # Pure ESM, type: "module"
  ├── tsconfig.json         # Target: ES2022, Module: NodeNext, strict
  ├── .github/workflows/    # CI（型の検査・ビルド・テスト）
  ├── src/                  # TypeScript ソースコード (.ts)
  │   ├── types/            # モジュール間の契約の型
  │   ├── ports/            # FileSystemPort / SolverPort / LanguageModelPort
  │   ├── adapters/         # NodeFs, CliAlloy, ClaudeCodeCli, IteraVfs, LocalBridgeAlloy, IteraLlm, IteraRepositoryReader, RecordingLanguageModel
  │   ├── lib/              # 小さく自分で書いたもの（JSON の正準化、SHA-256 など）
  │   ├── index.ts          # ライブラリとしての入口（Node.js と Itera OS の bundle の両方）
  │   ├── cli.ts            # Node.js の入口
  │   └── core/             # Zero-I/O コアパイプライン
  │       ├── scenario_extractor.ts   # M0: シナリオ同定・イベントストーミング
  │       ├── context_extractor.ts    # M1: 因果境界事実抽出
  │       ├── formal_transpiler.ts    # M2: 形式仕様コンパイル
  │       ├── formal_solver.ts        # M3: 数学ソルバ・検証
  │       ├── ledger_synthesizer.ts   # M4: 論点の自然言語化・根本論点の抽出
  │       ├── spec_projector.ts       # M5: 多面的仕様射影
  │       └── orchestrator.ts         # 全体パイプライン制御
  ├── itera/                # Itera OS 用の起動アプリ（HTML。dist/specula.itera.js を読み込む）
  ├── dist/                 # ビルド生成物（.gitignore。リポジトリに置かない）
  └── tests/                # テスト (.test.ts)
  ```