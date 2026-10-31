# SpecProjector 基本設計書

本設計書は、仕様射影モジュールの仕様書（`spec_projector.spec.md`）に規定された、形式仕様正本と論点カタログから人が読むビューを作る処理を、全体基本設計書（`system_solution.design.md`）の規約に準拠して**どのように技術的・構造的に実現するか（How）**を定義する。

---

## 1. アーキテクチャと全体設計制約の継承

### 1.1 全体設計制約の適用
- **配置場所**: `specula/src/core/spec_projector.ts`（ビルド後は `dist/` の JS）（Pure ESM, Target: ES2022+）。
- **Zero-I/O Core の遵守**: ファイルの読み書きも画面の操作もしない。形式仕様正本・論点カタログ・曖昧性レポート・全体マップ・辞書・意図の候補を受け取り、ビューの文字列と実装との対応表を返す。
- **依存方向の一方向性**: `src/ports/` と `src/types/` だけを参照する。
- **LLM を使わない**: 射影はすべて決定論的に行う（全体設計 1.2）。LLM が作った文（用語、表示名、意図の候補、論点の文、質問の文）は、GlossaryBuilder・IntentSynthesizer・FormalTranspiler・LedgerSynthesizer が記録したものを表示するだけである。
- **テストコードは作らない**: 仕様からテストコードを作る処理は、別のツールの責務である（仕様 1.2）。

### 1.2 公開する関数
```typescript
projectSpecification(
  spec: FormalSpecification,
  ledger: DomainLedgerCatalog | null,
  context: ProjectionContext,
  request: ProjectionRequest,
): Promise<SpecificationView>;

projectAmbiguities(
  report: AmbiguityReport,
  context: ProjectionContext,
  request: AmbiguityProjectionRequest,    // format は "AMBIGUITY_DOCUMENT"（8.4）
): Promise<SpecificationView>;

projectSystemMap(
  map: EventStormingMap,
  glossary: Glossary,
  intents: IntentCatalog | null,
  request: SystemProjectionRequest,
): Promise<SpecificationView>;

projectImplementationMap(
  map: EventStormingMap,
  glossary: Glossary,
  commands: ImplementationMapInput[],
): Promise<ImplementationMap>;
```
- `projectSpecification` は、シナリオ 1 つのビューを作る。`ledger` が `null` のときは、論点の節に「論点カタログが無い」と書く（LedgerSynthesizer を実行していないため）。
- `projectAmbiguities` は、FormalTranspiler の `AmbiguityReport` で止まったシナリオの曖昧さの一覧を作る（8.4）。
- `projectSystemMap` は、CommandExtractor の全体マップと辞書からシステム全体の俯瞰図を作る。シナリオの単位では作れない図（コマンド・イベント・ポリシーのつながり）なので、別の関数にする。
- `projectImplementationMap` は、表示の id から内部の識別子と実装の名前・所在を引く対応表を作る（8.5）。表示の役割に関係なく作る。
- どれも非同期なのは、正本のソースと全体マップの SHA-256 を Web Crypto で計算するためである（3.3・8.1。全体設計 1.3 と同じ方法）。
- 入力の契約が破れているとき（表現形式が対応外、`ledger.commandId` が `spec.commandId` と違う、論点が `spec` に無い操作や状態変数の識別子を指す、辞書が別の全体マップから作られている）は、例外 `ProjectionContractError` にする（理由の一覧は 7.7）。カタログが古いこと（3.3）は契約違反ではなく、ビューの中で知らせる。

### 1.3 構成
```
[FormalSpecification] + [DomainLedgerCatalog | null] + [ProjectionContext] + [ProjectionRequest]
      │
      ▼
[ContractGuard]         ── 入力の契約を確かめる（破れていれば例外）
      │
      ▼
[ViewModelBuilder]      ── 表示名・用語の解決、検証の状態、論点、古さの判定、
      │                    表示の役割による実装の併記を 1 つの中間表現にまとめる（3 節・8 節）
      ├──➔ [DocumentRenderer]  ➔ Markdown の仕様書（4.1）
      ├──➔ [MatrixRenderer]    ➔ 操作の一覧表（Markdown の表。4.2）
      └──➔ [FlowRenderer]      ➔ 操作ごとの流れ図（Mermaid。4.3）

[AmbiguityReport] + [ProjectionContext] ──➔ [AmbiguityRenderer] ➔ 曖昧さの一覧（Markdown。8.4）
[EventStormingMap] + [Glossary] + [IntentCatalog | null] ──➔ [SystemMapRenderer] ➔ 全体の俯瞰図（Mermaid または JSON。4.4）
[EventStormingMap] + [Glossary] + [各シナリオの結果] ──➔ [ImplementationMapBuilder] ➔ 実装との対応表（JSON。8.5）
```
- **すべてのビューを同じ中間表現から作る。** 表示名の解決や「未決」「未検証」の判定を描画ごとに書くと、ビューどうしで表示が食い違うためである。描画の部品は、中間表現を文字列にするだけにする。

---

## 2. 初回の射影で守ること

| 守ること | 理由 |
| :-- | :-- |
| 論点はすべて「未決」と表示する。選択肢は候補として並べ、どれにも「採択」「合意済み」の印を付けない | 初回は人がまだ判断していない（全体仕様 1.5）。論点の `decision` は初回は常に `null` である（LedgerSynthesizer の設計 4 節）。既存のコードは先頭の選択肢（`options[0]`）を採択済みとして表示していたので、これをやめる |
| 検証の状態（検査済みか未検証か）を、論点より前に書く | 未検証の報告を、反例が無かった報告と読み違えないようにするため（FormalSolver の設計 4.1） |
| 表示名が未生成の項目は、識別子のまま「表示名は未生成」と書く | 実装の名前や定型文で埋めると、LLM の結果と見分けが付かなくなるため（FormalTranspiler の設計 4.2） |
| LLM の文が未生成の論点は、文の欄に「未生成」と理由を書く | 同じ理由（LedgerSynthesizer の設計 5 節） |
| 正本のソースの付録は、表示の役割が Eng のときだけ載せる。載せるときも `-- @source:` の行を取り除く | 正本のソースは識別子と実装の所在を含み、PdM 向けの表示から実装の名前を外すため（全体設計 2.2・8.3）。所在は対応表（8.5）で引けるので、付録には重ねて書かない（FormalTranspiler の設計 4.1） |
| 状態として検証していない変更（`dataMutations`）は、操作ごとにその旨を書く | データベースへの変更は FormalSolver の検査の対象に入っていないため（FormalTranspiler の設計 2.1） |
| 不変条件の節には「初回は作らない」と書く | 不変条件が無いことを、不変条件を満たしていることと読み違えないようにするため（FormalTranspiler の設計 3.3） |

---

## 3. 中間表現（ViewModelBuilder）

### 3.1 表示名の解決
- 識別子の表示名は `spec.labels[識別子]` から取る。`GENERATED` ならその文、`NOT_GENERATED` なら `<識別子>（表示名は未生成）` とする。
- 真偽値の値 `True`・`False` は、表示名を持たない固定の値なので「真」「偽」と書く。
- 初期値が決まらない値 `v<n>_unknown` は「初期値は決まらない」と書く（FormalTranspiler の設計 2.1）。
- 出口の種類は、固定の語に置き換える: `RETURN` は「戻り値を返して終わる」、`THROW` は「例外で終わる」、`RESPONSE` は「応答を返して終わる」、`ASYNC_CUT` は「非同期の処理に引き渡して終わる」。

### 3.2 条件と書き込みの文
操作の `steps`（FormalTranspiler の設計 4.3）を、経路の順に文にする。Alloy のソースは読まない。

| 項目 | 文の形 |
| :-- | :-- |
| `PROP` | 「〈命題の表示名〉が成り立つ」 |
| `IS` | 「〈状態変数の表示名〉が〈値の表示名〉である」 |
| `CMP` | 「〈状態変数の表示名〉が 〈数〉 と等しい／等しくない／より小さい／以下／より大きい／以上」 |
| `NOT` | 「次が成り立たない: 〈中身〉」 |
| `AND`・`OR` | 中身を「かつ」「または」でつなぎ、入れ子はかっこで囲む |
| 条件（`CONDITION`） | `holds` が `true` なら式の文のまま、`false` なら `NOT` と同じ形にする |
| 書き込み（`WRITE`） | `SET` は「〈状態変数〉を〈値〉にする」、`ADD` は「〈状態変数〉に 〈数〉 を足す（負なら引く）」。`when` があれば前に「「〈条件〉」のとき、」を付ける（かぎかっこの理由は 7.4） |

- 条件の文は、その時点の値（それより前の書き込みを反映した値）についての文である。このため、操作の中では文を経路の順に並べ、並べ替えない。

### 3.3 カタログの古さ
- `spec.source` の SHA-256 を計算し、`ledger.basis.specSourceHash` と比べる。違えば、ビューの先頭に「この論点カタログは、いまの形式仕様正本とは別の版から作った」と書く（LedgerSynthesizer の設計 6 節）。論点は消さずにそのまま表示する。
- `ledger` が `null` のときは比べない（`ledgerIsStale` は `null`）。

### 3.4 検証の状態
`ledger.verification` をそのまま写す。

| 状態 | 書くこと |
| :-- | :-- |
| `CHECKED` で論点 0 件 | 「指定のスコープの中で、行った検査では見つからなかった」と、スコープ・ビット幅・ステップ数の上限（`basis.conditions`） |
| `CHECKED` で論点 1 件以上 | 「検査済み」と、論点の件数 k と元の反例の件数 N |
| `UNVERIFIED` | 「未検証」と理由（`reason.kind` ごとの固定の文。`reason.detail` は出さない。7.2）、実行しなかった検査の一覧（検査の種類の文。7.2） |

どの状態でも、不変条件の検査をしていないこと（`invariantChecks` が `NOT_APPLICABLE`）と、反例を 1 件しか返さない検査（`nonExhaustiveChecks`）を書く。「健全」「証明済み」「問題なし」の語は使わない。

### 3.5 論点
- 論点は、本体の反例の種類で見出しを分ける。見出しの順は `DEADLOCK`（抜けられない状態）→ `UNHANDLED_TRANSITION`（扱いの決まっていない状況）→ `OVERLAPPING_OPERATIONS`（複数の操作の条件が重なる状況）→ `UNREACHABLE_OPERATION`（到達しない操作）とする。見出しの中は、カタログの並び（LedgerSynthesizer の設計 3.2）のままにする。
- 論点ごとに、次を出す: 識別子、状態（「未決」）、主張・観測事実・判断質問の文、関わる操作（表示名）、実行列、選択肢（識別子と意味の文）、従属する反例の件数（種類は出さない。7.5）。
- 実行列は、時点ごとに、状態変数の値・直前の操作の結果・成り立つ命題を表示名で書く。`outcome` が `Idle` の時点は「まだ操作していない」とする。

### 3.6 並びと書式（決定論）
- 状態変数・命題・操作は、`spec` の配列の並び（FormalTranspiler が振った番号の順）で出す。識別子の文字列で並べ替えない（文字列の順では `op10` が `op2` より前になるため）。
- 時刻、乱数、ロケールに依存する比較（`localeCompare` など）を使わない。改行は `\n`、ファイルの末尾は改行 1 つで終える。
- 同じ入力からは、1 バイトも違わない出力になる。

---

## 4. ビュー

### 4.1 仕様書（DOCUMENT）
Markdown で、次の順に節を置く。
1. 題と、カタログが古いときの注意（3.3）。題は「〈表示の id〉 〈起点の用語〉」（例: 「S-01 注文を確定する」）とする。表示の id は `context.displayId`、起点の用語は、辞書で起点のコマンドまたはポリシーの項目（`context.commandTarget.inletTrigger.id` と同じ id の項目）を引いた `term.label`（8.2）。用語が未生成なら「〈表示の id〉（名前は未生成）」とする。シナリオの内部の識別子は題に出さない（全体設計 2.2）
2. 検証の状態（3.4）
3. 意図の候補: `context.intents` からこのシナリオの候補を引き、「候補」と明記して書く（IntentSynthesizer が LLM で作った推測であり、人が確かめていないため）。`context.intents` が `null` か、このシナリオの候補が無ければ「意図の候補が無い」と書く
4. 状態: 状態変数の表（表示名、値の種類、とりうる値、初期値）と、「直前の操作の結果」も状態に含むこと
5. 環境が決める条件: 命題の表（表示名）。命題は、各時点で環境が自由に決める条件であること（FormalTranspiler の設計 2.3）を一文で書く
6. 操作: 操作ごとに、表示名、条件と書き込みの文（3.2。経路の順）、結果（3.1）、状態として検証していない変更
7. 不変条件: 「初回は作らない」
8. 論点（3.5）
9. 付録（表示の役割が Eng のときだけ。2 節）: 形式仕様のソース（`-- @source:` の行を取り除いたもの）。囲みの記号は、ソースの中の最も長いバッククォートの並びより 1 つ長くする。PdM のときは付録の節を置かない

### 4.2 操作の一覧表（MATRIX）
- 行を操作、列を「表示名」「実行できる条件」「結果」「状態の変化」「状態として検証していない変更」「関わる論点」とする Markdown の表にする。
- 既存の設計にあった「状態 × 操作」の表はやめる。状態の数は状態変数の値の組み合わせで増え、整数の変数があると表にできないためである。状態ごとの振る舞いは、論点の実行列で示す。
- 表のセルの中の `|` は `\|` に、改行は空白に置き換える。

### 4.3 操作の流れ図（FLOW）
- Mermaid の `flowchart TD` で、シナリオの起点から操作ごとに枝を出し、条件と書き込み（3.2）を経路の順に並べて結果に至る図にする。論点に関わる操作は、結果のノードに論点の識別子を書き添える。
- 既存の設計にあったシーケンス図はやめる。アクターとシステムのやり取りの情報は、形式仕様正本に無いためである。
- ノードの識別子は機械的に振る（`s`、`op1_1`、`op1_2` …）。表示する文は `["…"]` の中に置き、`"` を `#quot;` に、改行を空白に置き換える。表示名に Mermaid の記号が入っていても図が壊れないようにするためである。

### 4.4 全体の俯瞰図（SYSTEM_MERMAID・SYSTEM_JSON）
- CommandExtractor の全体マップの、Bounded Context・コマンド・ドメインイベント・ポリシーと、そのつながり（コマンドが発生させるイベント、イベントの `after`、ポリシーが反応するイベントと起動するコマンド）を図にする。
- `SYSTEM_MERMAID` は、Bounded Context ごとに `subgraph` を作る。ノードの識別子は全体マップの並び順に `n1`・`n2` … と振り、表示する文は 4.3 と同じ規則で置き換える。`subgraph` への振り分けは要素の `contextId` で行う。
- ノードの文は、辞書でその要素の項目を引いた `term.label` とする（8.2）。用語が未生成の要素は、全体マップの id を出さずに「〈種類〉 nN（名前は未生成）」と書く（7.6）。
- `subgraph` の題も、辞書で `BOUNDED_CONTEXT` の項目を引いた `term.label` とする。いまの実装は `DEFAULT_CONTEXT` のような実装の名前を題に出しているので、これをやめる。用語が未生成なら「Bounded Context cN（名前は未生成）」と書く（`cN` は Bounded Context の並び順に振る）。
- 表示の役割が Eng のときは、ノードの文の後ろに「 / 〈ファイル〉#〈関数〉」を足す（8.3）。PdM のときは足さない。
- `SYSTEM_JSON` は `{ nodes: [{ id, kind, label, context, intent, broken, implementation }], edges: [{ from, to, kind, broken }] }` の形にする（DAG Viewer で読むため。`broken` は 2026-10-31 に足した壊れた印の欄で、初回は常に `null`。地図 1・地図 2 の形は 8.9）。`intent` は IntentSynthesizer の候補の文（`intents.contexts[].intent` が `GENERATED` のときの文）で、Bounded Context のノードだけに置く。候補が無いか未生成なら `null` にし、ほかの種類のノードには置かない。シナリオの意図の候補は俯瞰図に載せず、シナリオごとの仕様書（4.1）に書く。俯瞰図は `CommandTarget` を受け取らず、起点 1 つが複数のシナリオに分かれることもあるので、コマンドのノードに意図を 1 つ決められないためである（8.6）。`implementation` は表示の役割が Eng のときだけ置き（`{ names, locations }`。辞書の項目の `implementation` を写す）、PdM のときはキーごと置かない。キーの並びと配列の並びは決まった順にする。

---

## 5. 型

```typescript
type ViewRole = "PdM" | "Eng";            // 既定は PdM（全体設計 2.2）

interface ProjectionRequest {
  format: "DOCUMENT" | "MATRIX" | "FLOW" | "AMBIGUITY_DOCUMENT";
  viewRole: ViewRole;
  displayId: string;                      // シナリオの表示の id（"S-01"）。オーケストレーターが切り出しの順に振る
}

interface SystemProjectionRequest {
  format: "SYSTEM_MERMAID" | "SYSTEM_JSON";
  viewRole: ViewRole;
  level?: "CONTEXT_MAP" | "CONTEXT_DETAIL"; // 省くと今の 1 枚の俯瞰図（8.9）
  contextId?: string;                     // CONTEXT_DETAIL のときの Bounded Context（全体マップの id。出力には出さない）
  includeSupporting?: boolean;            // CONTEXT_DETAIL のときだけ。アクター・リードモデル・アグリゲートを足す（既定 false）
}

interface ProjectionContext {
  commandTarget: CommandTarget;               // 起点と期待するイベントの、辞書の項目を引くため
  glossary: Glossary | null;              // null のときは、地図の要素をすべて「名前は未生成」として表す
  intents: IntentCatalog | null;          // null のときは「意図の候補が無い」と書く
}

interface ImplementationMapInput {
  displayId: string;
  commandTarget: CommandTarget;
  spec: FormalSpecification | null;       // FormalTranspiler で止まったシナリオは null
  ambiguity: AmbiguityReport | null;      // 曖昧さで止まったときだけある
  ledger: DomainLedgerCatalog | null;     // 論点カタログ。LedgerSynthesizer まで進まなかったシナリオは null（8.7・8.8）
}

interface ImplementationMap {
  entries: Array<{
    displayId: string;                    // "c1"・"n1"・"S-01"・"S-01-A-001"・"S-01-V-01"・"S-01-L-001"
    kind: "BOUNDED_CONTEXT" | "COMMAND" | "EVENT" | "POLICY" | "COMMAND_TARGET" | "AMBIGUITY" | "STATE_VARIABLE" | "LEDGER_ISSUE";
    internalId: string;                   // 地図の要素の id、シナリオの id、状態変数の識別子、論点の識別子など。曖昧さは最初のユニットの識別子（8.8）
    glossaryEntryId: string | null;       // 辞書の項目の id。実装の名前が辞書と一致しなければ null（8.5）
    implementation: {
      names: string[];
      locations: Array<{ file: string; symbol?: string; line?: number }>;
    };
  }>;                                     // 8.5 の順
  basis: { mapHash: string; documentsHash: string }; // 元にした辞書の basis をそのまま写す
}

interface SpecificationView {
  commandId: string | null;              // 内部の識別子。ファイルの置き場所を決めるため。全体の俯瞰図は null
  displayId: string | null;               // 表示の id。全体の俯瞰図は null
  viewRole: ViewRole;
  format: "DOCUMENT" | "MATRIX" | "FLOW" | "AMBIGUITY_DOCUMENT" | "SYSTEM_MERMAID" | "SYSTEM_JSON";
  mediaType: "text/markdown" | "text/vnd.mermaid" | "application/json";
  content: string;
  basis: {
    specSourceHash: string | null;        // いまの正本のソースの SHA-256。全体の俯瞰図と曖昧さの一覧は null
    ledgerReportId: string | null;        // 元にした論点カタログの basis.reportId
    ledgerIsStale: boolean | null;        // カタログが古いか（3.3）。カタログが無ければ null
  };
}
```
- ビューは正本ではない。保存するのはオーケストレーターの判断だが、いつでも正本から作り直せるものとして扱う（仕様 1.2）。
- `SpecificationView.commandId` は内部の識別子だが、ビューの `content` には出さない。オーケストレーターが出力のディレクトリを決めるためだけに使う（全体設計 4.1）。
- `projectSystemMap` と `projectImplementationMap` の `glossary` は `null` を受け付けない。GlossaryBuilder が契約のエラーで止まったときは、パイプラインが実行を止めるためである（全体設計 2.1）。シナリオの射影の `context.glossary` が `null` になるのは、単体で呼んだときと試験のときだけである。

---

## 6. 既存の設計からの変更
- 入力の論点カタログを「合意された」ものとして扱うのをやめ、初回はすべて未決として表示する。
- 形式仕様のソースを読み直して射影するのをやめ、FormalTranspiler が構造で残した `stateVariables`・`propositions`・`operations`（`steps` を含む）から作る。
- 事前条件・事後条件・不変条件の節は、操作の条件と書き込み（3.2）と「不変条件は初回は作らない」に置き換えた。
- シーケンス図と「状態 × 操作」の表をやめ、操作の流れ図と操作の一覧表にした（4.2・4.3 に理由）。
- 俯瞰（システム全体）と詳細（シナリオ）の粒度は、関数を分けて扱う（1.2）。操作 1 つだけのビューなど、それより細かい粒度の切り替えは初回の範囲に入れない。

---

## 7. 初回の実装で決めたこと
設計に書かれていなかったことと、実装で変えたことを記録する。本文と食い違う箇所（1.2・3.2・3.4・3.5・4.4）は、本文もこの章に合わせて直した。

### 7.1 検証の状態の対応
- 3.4 の表の 3 つの状態は、`ledger.verification.outcome` で見分ける。「`CHECKED` で論点 0 件」は `NONE_FOUND_WITHIN_SCOPE`、「`CHECKED` で論点 1 件以上」は `FOUND`、「`UNVERIFIED`」は `UNVERIFIED` に対応させる。
- `UNVERIFIED` でも、見つかった反例から作った論点があれば論点の節に出す。この場合、「見つからなかった」とは書かない。
- 論点カタログが無いとき（`ledger` が `null`）は、検証の状態の節に「論点カタログが無いので、検証の状態は分からない」と書き、論点の節に「論点カタログが無い（LedgerSynthesizer を実行していない）」と書く。`basis.ledgerReportId` と `basis.ledgerIsStale` は `null` にする。

### 7.2 ビューに出さないもの
仕様 3.2 は、形式仕様の識別子や実装の所在をビューに出さないことを求めている。次のものはこの理由で出さず、決まった文に置き換える。
- **検査の id**（`m3_reach_op1` など）: 操作の識別子を含むため。検査の種類ごとに次の文にし、操作は表示名で書く。
  - `m3_cover` は「どの操作の条件も成り立たない状態を探す検査」
  - `m3_overlap_<A>_<B>` は「「〈A〉」と「〈B〉」の条件が重なる状態を探す検査」
  - `m3_reach_<操作>` は「「〈操作〉」に到達できるかの検査」
  - `m3_escape_<n>` は「抜けられない状態を探す検査」
  - この形に当てはまらない id は、識別子を出さずに「種類の分からない検査」と書く。
- **未検証の理由の詳細**（`verification.reason.detail`）: エンジンのメッセージに識別子が入りうるため。理由の種類ごとに固定の文にする（`NO_SOLVER` は「検査のエンジンが用意されていない」、`UNREACHABLE` は「検査のエンジンに届かなかった」、`TIMEOUT` は「検査が制限時間を超えた」、`ENGINE_ERROR` は「検査のエンジンがエラーを返した」）。3.4 の表の「理由（`reason.kind` と `reason.detail`）」は、この固定の文に変えた。
- **LLM の文が未生成のときの詳細**（`LlmText` の `detail`）: 検出した識別子を含みうるため。「未生成（LLM に届かなかった）」「未生成（LLM の出力が検査を通らなかった）」と、理由の種類だけを書く。
- **状態として検証していない変更の中身**（`dataMutations`）: 中身は ContextExtractor のユニットの id（`<ファイル>:<行>:<列>:<種類>`）で、実装の所在になるため。件数だけを書く。
- **値のリテラルと命題の原文**（`valueLiterals`・`expression`）: コードの断片なので。状態の表と命題の表には表示名だけを書く（4.1 と同じ）。
- **全体マップの id**: ハンドラの所在を含むため。俯瞰図の扱いは 7.6 に書く。

### 7.3 ビューに出すもの
- 論点は表示の id（`S-01-L-001` など。8.7）で出し、選択肢の識別子（`SPECIFY_HANDLING` など）はそのまま出す。どちらも、人が判断を返すときに指す名前だからである（3.5）。
- 2026-10-30 に、論点の識別子（`LEDGER-<シナリオの識別子>-001`）をそのまま出すことをやめた。シナリオの識別子が起点のファイルと関数を含み、PdM 向けの出力に実装の所在が出てしまうためである（8.7）。

### 7.4 文の形
- **操作の結果**: 「〈出口の表示名〉（〈出口の種類の語〉）」と書く。出口の表示名は `spec.labels` の出口の識別子（`o1` など）から取り、出口の種類の語は 3.1 の固定の語を使う。
- **実行列の値**: 真偽値は「真」「偽」、列挙は値の表示名（`v<n>_unknown` は「初期値は決まらない」）、整数は数のまま書く。成り立つ命題は表示名を読点でつなぎ、無ければ「なし」と書く。
- **状態の表の「とりうる値」**: 真偽値は「真、偽」、列挙は値の表示名を `spec` の並びで、整数は「整数」と書く。
- **書き込みの条件**: 3.2 の「〈条件〉のとき、」は、条件の文をかぎかっこで囲んで「「〈条件〉」のとき、」とする。条件の文が「成り立たない」で終わるとき、そのまま「のとき」を付けると読みにくいためである。
- **一覧表の条件と書き込み**: 4.2 の「実行できる条件」と「状態の変化」の列では、各項目の前に経路の位置「(n)」を付ける。条件は前の書き込みを反映した値についての文なので（3.2）、セルの中でも順番が分かるようにする。
- **Mermaid の文**: 4.3 の置き換えに加えて、`<` を `#lt;`、`>` を `#gt;` にする。
- **流れ図の起点**: 起点のノードの文は「シナリオ 〈表示の id〉 の起点」（例: 「シナリオ S-01 の起点」）とする。シナリオの内部の識別子は、起点のファイルと関数を含むので出さない（2026-10-30 に「〈シナリオの識別子〉」から変えた。8.6）。

### 7.5 従属する反例
- 3.5 の「従属する反例の件数と種類」は、件数だけを出すことにした。SpecProjector は FormalSolver の報告を受け取らず、論点の `dependentFindings` は FormalSolver の `findings` の中の位置なので、SpecProjector からは種類を引けないためである。

### 7.6 全体の俯瞰図
- 4.4 の「名前が未生成の要素は、識別子のまま」は変えた。全体マップの id にはハンドラの所在が入るため、出さない。ノードには `n1`・`n2` … を振り、名前が未生成の要素は「〈種類〉 nN（名前は未生成）」と書く。
- `subgraph` への振り分けは、要素の `contextId` で行う。

### 7.7 入力の契約
`ProjectionContractError` の理由は次の 6 つにした（1.2 の 2 つに 2 つを足し、2026-10-30 に辞書の照合の 1 つを、2026-10-31 に地図 2 の Bounded Context の 1 つを足した）。
| 理由 | 起きるとき |
| :-- | :-- |
| `UNSUPPORTED_FORMAT` | 表現形式が関数の受け付けるものでない。`projectSpecification` は `DOCUMENT`・`MATRIX`・`FLOW`、`projectAmbiguities` は `AMBIGUITY_DOCUMENT`、`projectSystemMap` は `SYSTEM_MERMAID`・`SYSTEM_JSON`（仕様 3.1）。表示の役割が `PdM`・`Eng` のどちらでもないとき、俯瞰図の `level` が `CONTEXT_MAP`・`CONTEXT_DETAIL` のどちらでもないとき、`CONTEXT_DETAIL` 以外で `includeSupporting` が `true` のときも、この理由にする（8.9） |
| `UNKNOWN_CONTEXT` | `projectSystemMap` の `CONTEXT_DETAIL` で、`contextId` が無いか、全体マップに無い Bounded Context を指す（8.9） |
| `COMMAND_MISMATCH` | `ledger.commandId` が `spec.commandId` と違う。2026-10-30 から、`context.commandTarget.id` が `spec.commandId`（曖昧さの一覧では `report.commandId`）と違うときも、この理由にする |
| `UNKNOWN_OPERATION` | 論点が `spec` に無い操作の識別子を指す |
| `UNKNOWN_STATE_VARIABLE` | 論点の実行列の値が `spec` に無い状態変数を指す。表示名を引けなくなるため（LedgerSynthesizer の契約と同じ） |
| `GLOSSARY_STALE` | `projectSystemMap`・`projectImplementationMap` で、`glossary.basis.mapHash` が受け取った全体マップの SHA-256 と違う。別の全体マップから作った辞書では、地図の要素の id が辞書の項目と一致する保証がないため（8.1） |

---

## 8. 辞書と表示の役割（2026-10-30）
GlossaryBuilder と IntentSynthesizer を足し、利用者向けの出力から実装の名前を外したこと（全体設計 2.2）に合わせて、本モジュールで決めたことを書く。

### 8.1 辞書と全体マップの照合
- `projectSystemMap` と `projectImplementationMap` は、受け取った全体マップを正準化した JSON の SHA-256 を計算し、`glossary.basis.mapHash` と比べる。違えば `GLOSSARY_STALE`（7.7）にする。正準化は GlossaryBuilder と同じ方法（全体設計 1.3）を使う。
- シナリオの射影（`projectSpecification`・`projectAmbiguities`）は全体マップを受け取らないので、照合しない。辞書の項目は id で引き、見つからなければ「名前は未生成」と同じ扱いにする（8.2）。

### 8.2 用語の解決
- 地図の要素（Bounded Context・コマンド・イベント・ポリシー）は、辞書で同じ id の項目を引き、`term` が `GENERATED` ならその `label` で表す。
- 項目が無いか、`term` が `NOT_GENERATED` のときは、「〈種類〉 〈番号〉（名前は未生成）」と書く。種類の語は「Bounded Context」「コマンド」「イベント」「ポリシー」、番号は俯瞰図と同じ規則で振る（Bounded Context は `c1`…、ほかは `n1`…。4.4）。シナリオの射影では、起点の用語が無いときに題を「〈表示の id〉（名前は未生成）」とする（4.1）だけなので、番号は使わない。
- 状態変数・命題・操作・出口は、これまでどおり FormalTranspiler の表示名（`spec.labels`）で表す。辞書の用語は付けない（全体設計 1.2 の辞書の範囲）。
- `GlossaryTerm.detail`（未生成の理由の詳細）は出さない。7.2 の `LlmText` の `detail` と同じ理由である。

### 8.3 表示の役割
- `PdM`（既定）: ファイルのパス・関数名・行番号・コードの断片を出さない。
- `Eng`: 本文の文は `PdM` と同じにし、実装の名前と所在を後ろに併記するだけにする。併記の形は次のとおり。
  - Markdown: 「〈表示〉（`〈ファイル〉#〈関数〉` L〈行〉）」。所在が複数あるときは読点でつなぐ。関数か行が無いときは、その部分を省く。
  - Mermaid: ノードの文の後ろに「 / 〈ファイル〉#〈関数〉」を足す（4.3・7.4 の置き換えを、足した部分にも同じように行う）。
  - JSON: `implementation` のキーを置く（4.4）。
- 併記の中身は、対応表（8.5）と同じものを使う。ビューごとに別の方法で引くと、表と表示が食い違うためである。
- 仕様書の付録（形式仕様のソース）は `Eng` のときだけ載せる（2 節・4.1）。

### 8.4 曖昧さの一覧（AMBIGUITY_DOCUMENT）
`projectAmbiguities` は、FormalTranspiler の `AmbiguityReport` を Markdown にする。
1. 題: 「〈表示の id〉 〈起点の用語〉 の曖昧さ」（起点の用語の引き方は 4.1 と同じ）と、「このシナリオは曖昧さがあるので、形式仕様の検査まで進まなかった」の一文
2. 件数: `Eng` では種類ごとの件数（`report.counts`）。`PdM` では「エンジニアの確認待ち: N 件」と、種類を分けない合計（`report.counts` の和）だけを書き、そこで終える（8.9。2026-10-31 に変えた）
3. 曖昧さ（`Eng` のときだけ）: `report.issues` の並びのまま、1 件ずつ次を書く
   - 表示の id: 「〈シナリオの表示の id〉-A-〈3 桁の番号〉」（`S-01-A-001`。全体設計 2.2）
   - 種類: 固定の語にする。`UNDETERMINED_VALUE` は「値が決まらない」、`EXTERNAL_EFFECT` は「外部への作用がある」、`CONFLICTING_SLICES` は「同じ条件で別の経路に進む」
   - 質問の文: `question` が `GENERATED` ならその文、`NOT_GENERATED` なら「未生成（LLM に届かなかった）」か「未生成（LLM の出力が検査を通らなかった）」（7.2 と同じ）。後ろに確定の状態の印（8.9）を付ける
   - 所在（`location` を「〈ファイル〉 L〈行〉」の形で）と、原文（`detail`。コードの囲みに入れ、囲みの記号は 4.1 の付録と同じ規則で決める）
- `unitIds` は出さない。ユニットの id にはファイルと行が入るためである（7.2 の `dataMutations` と同じ理由）。
- 質問の文に実装の名前が入らないことは、FormalTranspiler の出力の検査で確かめる（全体設計 2.2）。本モジュールは文を書き換えない。
- **実装で決めたこと（2026-10-30）**:
  - 要求の型は `AmbiguityProjectionRequest`（`format: "AMBIGUITY_DOCUMENT"`・`viewRole`・`displayId`）として、シナリオのビューの `ProjectionRequest` と分けた。`CommandViewFormat` に足すと、`projectSpecification` が型の上で `AMBIGUITY_DOCUMENT` を受け付けてしまうためである。`SpecificationView.format` の和には `AMBIGUITY_DOCUMENT` を足した。
  - 形式仕様も論点カタログも無いので、`basis` の 3 つはすべて `null` にする。
  - 題は「# 〈表示の id〉 〈起点の用語〉〈Eng の併記〉 の曖昧さ」とした。用語の引き方と併記は仕様書の題と同じ関数で作る（8.3・8.7）。
  - 件数は 3 つの種類を固定の順（値が決まらない・外部への作用がある・同じ条件で別の経路に進む）に、0 件のものも書く。曖昧さが 0 件なら「曖昧さは無い。」と書く。
  - 所在は「`〈ファイル〉` L〈行〉」（列は書かない）、原文は言語の名前を付けないコードの囲みにした。
  - 契約は、`format` が `AMBIGUITY_DOCUMENT` でない・役割が `PdM`・`Eng` でないときに `UNSUPPORTED_FORMAT`、`context.commandTarget.id` が `report.commandId` と違うときに `COMMAND_MISMATCH`（7.7）。
  - オーケストレーターは、曖昧さで止まったシナリオで `projectAmbiguities` を呼び、成果物の `view` に入れる。M5 の段として呼ぶので、契約のエラーならそのシナリオは M5 で止まったことになる。ファイルへの書き出し（CLI と起動アプリ）は、まだ行っていない（`src/lib/write_outputs.ts` は `ambiguity.json` だけを書く）。

### 8.5 実装との対応表（`implementation_map.json`）
- `projectImplementationMap` が作る。表示の役割に関係なく、同じ入力からは同じ表を作る。
- 項目の並び: まず俯瞰図の Bounded Context（`c1`…）、続いて俯瞰図のノード（`n1`…。4.4 の並び）、そのあとシナリオごとに表示の id の順で、シナリオ（`S-01`）→ 曖昧さ（`S-01-A-001`…）→ 状態変数（`S-01-V-01`…、`spec.stateVariables` の並び）→ 論点（`S-01-L-001`…、論点カタログの `issues` の並び。8.7）とする。
- 地図の要素とシナリオ: 辞書の項目をそのまま引き、`glossaryEntryId` に項目の id、`implementation` に項目の `implementation` を写す。シナリオは起点のコマンドまたはポリシーの項目を引く。
- 曖昧さ: `implementation` は `location` から作る（`names` は空、`locations` は 1 件）。辞書の項目とは結び付けない（`glossaryEntryId` は `null`）。
- 状態変数: 正本の構造に残る出どころ（`spec.sourceMap` で状態変数の識別子から引けるユニット）から所在を作る。実装の名前が辞書の `implementation.names` と完全に一致したときだけ、`glossaryEntryId` にその項目の id を入れる。一致しなければ `null` にし、辞書には足さない（全体設計 2.2。2026-10-30 中瀬古様了承、C0AF4DJJK8A 1793354518.934329）。
  - 状態変数の実装の名前は `StateVariable.name`（M1 の `ExtractionUnit.name` を M2 が写したもの。FormalTranspiler の設計 4.3）から取る。2026-10-30 に、この欄を足して決めた（8.8）。
- 論点: `internalId` は論点の識別子（`LEDGER-…`）。`implementation` は、論点に関わる操作ごとの出口のユニットの所在から作る（`names` は空）。辞書の項目とは結び付けない（`glossaryEntryId` は `null`）。
- 状態変数の表示の id（`S-01-V-01`）は対応表のキーとしてだけ使い、PdM 向けのビューには出さない。

### 8.6 既存の設計からの変更
- 7.6 の俯瞰図のノードの文は、全体マップの `name`（LLM の結果）から辞書の `term.label` に変えた。CommandExtractor が名前を作らなくなったためである。
- `subgraph` の題を、実装の名前（`DEFAULT_CONTEXT` など）から辞書の用語に変えた（4.4）。
- 仕様書の題と流れ図の起点から、シナリオの内部の識別子を外し、表示の id に変えた（4.1・7.4）。
- 仕様書に意図の候補の節を足した（4.1）。俯瞰図には Bounded Context の意図の候補だけを載せる（4.4）。
- 曖昧さの一覧と実装との対応表を、新しい出力として足した（8.4・8.5）。
- 形式仕様のソースの付録は、`Eng` のときだけ載せる（2 節）。

### 8.7 表示の役割と表示の id を実装したときに決めたこと（2026-10-30）
- **論点の表示の id**: 論点は「〈シナリオの表示の id〉-L-〈3 桁の番号〉」（`S-01-L-001`）で表す。番号は論点カタログの `issues` の並びで振る。論点の識別子（`LEDGER-<シナリオの識別子>-NNN`）はシナリオの識別子を含み、そこに起点のファイルと関数が入るため、ビューには出さない（7.3）。論点の識別子との対応は実装との対応表（8.5）に入れる。そのため 8.5 の項目に論点の種類を足すことになる（並びと種類の名前は、対応表を実装するときに決める）。
- **俯瞰図の JSON の Bounded Context**: 4.4 は「Bounded Context のノードだけに `intent` を置く」としているが、これまでの JSON には Bounded Context のノードが無く、各ノードの `context` の欄に表示名を持つだけだった。そこで、ノードの並びの先頭に Bounded Context のノード（id は `c1`…、種類は `BOUNDED_CONTEXT`、`context` は `null`、文は Mermaid の `subgraph` の題と同じ）を置いた。辺は足さない。所属は、これまでどおり各ノードの `context` の欄で表す。
- **Mermaid の併記**: `Eng` の併記（8.3）は、イベント・コマンド・ポリシーのノードだけに付け、`subgraph` の題には付けない。
- **Markdown の併記**: 仕様書では、題（起点の用語）にだけ併記する。状態変数などは FormalTranspiler の表示名で書いており、辞書の項目と結び付ける方法は対応表（8.5）で決めるためである。
- **併記の中身**: 辞書の項目の `implementation.locations` だけを使う。所在が無い項目には併記しない。
- **意図の候補の照合**: `projectSystemMap` は、意図の候補の一覧の `basis` が辞書の `basis` と違えば `GLOSSARY_STALE` にする。別の辞書と全体マップから作った意図の候補を、いまの地図に載せないためである。シナリオの射影は全体マップを受け取らないので照合しない（8.1 と同じ）。
- **意図の候補が未生成のとき**: 「未生成（LLM に届かなかった）」「未生成（LLM の出力が検査を通らなかった）」と書く（7.2 と同じく、詳細は出さない）。利用者が書いた目的（`userIntent`）があれば、「利用者が書いた目的」として別の行に書く。
- **シナリオの表示の id の桁**: 2 桁（`S-01`）を最小にし、シナリオが 100 件以上のときは、すべての id を件数の桁数にそろえる（`S-001`…）。文字列として並べたときに順が崩れないようにするためである。振るのはオーケストレーターで、切り出しの順に振る（全体設計 2.1・2.2）。
- **表示の役割の誤り**: 役割が `PdM`・`Eng` のどちらでもなければ `UNSUPPORTED_FORMAT` にする（7.7）。オーケストレーターは入口で既定の `PdM` を入れる。俯瞰図の射影はシナリオごとの段の外で呼ぶので、役割の誤りは実行全体を止める。

### 8.8 実装との対応表を実装したときに決めたこと（2026-10-30）
- **状態変数の実装の名前**: `StateVariable` に `name`（M1 の `ExtractionUnit.name`。実装上の変数名）を足し、FormalTranspiler が状態変数を作るときに写すことにした（FormalTranspiler の設計 4.3）。入力に M1 の結果（`RawContextModel`）を足して `unitId` から名前を引く案もあったが、本モジュールが M1 の出力の型に依存することになるので採らなかった。`name` は内部の記録で、PdM 向けのビューには出さない。M4 の LLM の入力にも入らない（M4 の語彙は項目を名指しで写すため）。
- **入力に論点カタログを足した**: 論点の表示の id（`S-01-L-001`）と論点の識別子の対応を表に入れるため（8.7）、`ImplementationMapInput` に `ledger` を足し、項目の種類に `LEDGER_ISSUE` を足した（5 節）。
- **番号の桁**: 状態変数の番号（`V-01`）は 2 桁を最小にし、100 件以上なら件数の桁数にそろえる（シナリオの表示の id と同じ規則。8.7）。曖昧さ（`A-001`）と論点（`L-001`）は、曖昧さの一覧と仕様書の表示に合わせて 3 桁に固定する。
- **俯瞰図のノードの並び**: `n1`… はイベント → コマンド → ポリシーの順に振る。俯瞰図の描画と同じ振り方にし、同じ要素が表と俯瞰図で同じ番号になるようにした。
- **曖昧さの内部の識別子**: 曖昧さ（`AmbiguityIssue`）は識別子を持たないので、`internalId` には最初のユニットの識別子（所在と同じユニット）を入れる。
- **状態変数と辞書の結び付け**: 辞書の項目のうち、`implementation.names` に状態変数の `name` をそのまま含むものがちょうど 1 つのときだけ、`glossaryEntryId` にその id を入れる。0 件と 2 件以上のときは `null` にする。同じ名前の変数が別のファイルにあると、別の項目と取り違えるためである。
- **状態変数の所在**: `spec.sourceMap` で状態変数の識別子から引けるユニット（無ければ `StateVariable.unitId`）の識別子 `<ファイル>:<行>:<列>:<種類>` を右から分けて、ファイルと行を取る。ファイルのパスに `:` が入っていても分けられるようにするためである。同じファイルと行の所在は重ねない。
- **論点の所在**: 論点に関わる操作ごとに、出口のユニット（`spec.sourceMap[operation.outcome]`）の所在だけを並べる。操作の経路の全ユニット（`spec.sourceMap[operation.id]`）は数が多く、表で引く目的に合わないためである。
- **入力の契約**: 次のときに `ProjectionContractError` にする（7.7 の理由を使う）。
  - `glossary.basis.mapHash` が全体マップと違う、または辞書に地図の要素や起点の項目が無い（種類が違う場合を含む）: `GLOSSARY_STALE`
  - `spec`・`ambiguity`・`ledger` の `commandId` が `commandTarget.id` と違う、または `ledger` があるのに `spec` が無い: `COMMAND_MISMATCH`
  - 論点が `spec` に無い操作を指す: `UNKNOWN_OPERATION`
- **オーケストレーター**: 対応表は、俯瞰図と同じくシナリオごとの段の外で 1 回だけ作り、`PipelineResult.implementationMap` に入れる。最後まで進んだシナリオには `spec` と `ledger` を、曖昧さで止まったシナリオには `ambiguity` を渡し、ほかの段で止まったシナリオはシナリオの項目だけになる。契約のエラーは実行全体を止める。ファイルへの書き出し（`implementation_map.json`。CLI と起動アプリ）は、まだ行っていない。

### 8.9 画面の仕様に合わせて変えたこと（2026-10-31。すべて実装した）
仕様 1.1・2.1 の変更（俯瞰図の 2 階層、地図 2 の切り替え、壊れた印の欄、検査の範囲、確定の状態、曖昧さの質問の例外）を、次の形で実装した。画面の仕様は `spec_viewer.spec.md` にある。

- **俯瞰図の階層（実装した）**: `SystemProjectionRequest` に `level?: "CONTEXT_MAP" | "CONTEXT_DETAIL"` と、`CONTEXT_DETAIL` のときの `contextId`（全体マップの Bounded Context の id）を足した。
  - `CONTEXT_MAP`（地図 1）: Bounded Context のノード（`c1`…）と、Bounded Context をまたぐポリシーのつながりだけを出す。つながりは、ポリシーが反応するイベントの Bounded Context から、起動するコマンドの Bounded Context へ向ける。またぐポリシー 1 つにつながり 1 本（種類 `POLICY`）とし、つながりにポリシーの番号（`policy: "nN"`）と文（`label`）を持たせる。Mermaid では `c1 -->|ポリシー: 〈表示名〉| c2` と書く。
  - `CONTEXT_DETAIL`（地図 2）: 1 つの Bounded Context の中のイベント・コマンド・ポリシーとそのつながりを、その Bounded Context の `subgraph` 1 つにまとめて出す。今の俯瞰図の `subgraph` 1 つ分に当たる。
  - ポリシーの所属は GlossaryBuilder の設計 5.1 と同じ規則で、全体マップから求める。反応するイベントの Bounded Context に所属し、起動するコマンドの Bounded Context が違えば「またいでいる」。
  - またぐポリシーは、両方の Bounded Context の地図 2 に出す。JSON のポリシーのノードに `crossing: { from: "cN", to: "cM" }` を置き（またがないポリシーは `null`）、Mermaid では文の後ろに「（cN から cM へまたぐ）」と足す。地図 2 のつながりは、両端がその地図 2 にあるものだけを描く。相手の Bounded Context の要素は出さない。
  - 番号（`c1`・`n1`）は、階層と `includeSupporting` によらず全体マップの並びで振る（8.8 と同じ）。イベント・コマンド・ポリシーの順に振ったあと、アクター・リードモデル・アグリゲートの順に続けて振る。地図 1・地図 2・対応表で、同じ要素が同じ番号になるようにするためである。対応表（8.5）にアクター・リードモデル・アグリゲートの行は無い。
  - `level` を省いたときは、今の 1 枚の俯瞰図（4.4）を出す。オーケストレーターは、Mermaid ではこの 1 枚の図を `system_map.mmd` に書き、JSON では地図 1 と Bounded Context ごとの地図 2（足す要素なし・あり）を `system_map.json` に束ねる（全体設計 4.1）。
  - 求めた `contextId` が無いか全体マップに無いときは、`ProjectionContractError` の理由 `UNKNOWN_CONTEXT` で止める。`level` が上の 2 つのどれでもないときは `UNSUPPORTED_FORMAT` にする。
- **地図 2 に足す要素（実装した）**: `SystemProjectionRequest` に `includeSupporting?: boolean`（既定 `false`）を足した。`true` のとき、地図 2 にアクター・リードモデル・アグリゲートとそのつながりを足す。`CONTEXT_DETAIL` 以外で `true` を渡したときは `UNSUPPORTED_FORMAT` にする（黙って無視しない）。
  - これらの要素は辞書の用語を持たないので（GlossaryBuilder 仕様 1.2）、ノードの文は「〈種類〉 nN」（例: 「アクター n5」）とし、実装の名前で埋めない。用語を付けるかは、画面で使ってみてから決める。
  - アクターとリードモデルは、その Bounded Context のコマンドとつながるものだけを出す。アクターからコマンドへ「実行する」（`EXECUTES`）、リードモデルからコマンドへ「この画面から操作する」（`VIEWED_FROM`）とつなぐ。Mermaid では `subgraph` の外に置く。
  - アグリゲートは、全体マップに独立した要素が無く、イベントの `aggregate` にだけ書かれている。そこで、Bounded Context と `aggregate` の組ごとに 1 つのアグリゲートとし、Bounded Context の id、`aggregate` の順に並べて番号を振る。アグリゲートからイベントへ「起こす」（`RAISES`）とつなぐ。Mermaid では `subgraph` の中に置く。
  - 役割が `Eng` のときの `implementation`（8.3）: アクターとリードモデルは、辞書に同じ id・同じ種類の項目があればその `implementation` を写し、無ければ全体マップの名前だけ（所在は空）にする。アグリゲートは `aggregate` の名前だけにする。文（`label`）は役割で変えない。
- **壊れた印の欄（実装した）**: 俯瞰図の JSON のノードとつながりに `broken: null` を足した（3 つの形すべて）。初回は常に `null` である。中身の形（何が、なぜ壊れているか）は、判定を作るときに決める。Mermaid の出力には、`null` のあいだは何も足さない。JSON のノードのキーは `id`・`kind`・`label`・`context`・`intent`（Bounded Context だけ）・`crossing`（地図 2 のポリシーだけ）・`broken`・`implementation`（Eng のときだけ）の順にする。
- **検査の範囲（実装した）**: 仕様書の検証の状態の節に、固定の文「検査はこのシナリオだけで行った。ほかのシナリオとの矛盾は見ていない。」を書く。実行の概要（`run_report.json`）に同じ内容を持たせるのはオーケストレーターである（全体設計 2.1 の `inspectionScope`）。
  - 置き場所は、検査の範囲の箇条（スコープ・整数のビット幅・ステップ数の上限）のすぐ後ろの箇条とした。検証の結果（見つからなかった・見つかった・未検証）によらず書く。
  - 論点カタログが無いときは、検査をしていないので書かない。
- **確定の状態（実装した）**: 表示名・用語・意図の候補・論点の文・曖昧さの質問の文に、記録された `ConfirmationStatus`（GlossaryBuilder 基本設計 5.1）に応じた印を付ける。仕様書の中の表示名すべてに「（候補）」を付けると読みにくくなるので、次のようにした。
  - 仕様書の題のすぐ後ろに、「この文書の表示名と用語は、人が確かめていない候補である。人が確定したものには「（確定）」、確定のあとで元の資料やコードが変わったものには「（要再確認）」を付けた。」と 1 回書く。候補の項目には個別の印を付けない。
  - 印は、確定（`CONFIRMED`）に「（確定）」、要再確認（`NEEDS_RECHECK`）に「（要再確認）」を、文の後ろに付ける（`src/core/m5/labels.ts` の `statusMark`）。未生成（`NOT_GENERATED`）には新しい印を付けない。表示名は「〈識別子〉（表示名は未生成）」、文は「未生成（理由）」と、すでに書かれているためである。
  - 表示名の印は、項目を定義する箇所にだけ付ける。状態の表の状態変数と列挙の値、環境が決める条件の一覧、操作の見出し、操作の「結果」の行である。条件と書き込みの文、実行列、検査の文、論点の「関わる操作」の中の表示名には付けない。文の途中に印が入ると読みにくく、定義の箇所を見れば状態が分かるためである。
  - 題の用語には辞書の `termStatus`、意図の候補には `intentStatus`、論点の主張・観測事実・判断質問にはそれぞれ `claimStatus`・`observationStatus`・`questionStatus`、曖昧さの質問の文（`Eng` のときだけ出る）には `questionStatus` の印を付ける。意図の候補は、これまでどおり「候補」と書く（7.2）。
  - 印は中間表現（3 節）の文字列に入れる。そのため、操作の一覧表と流れ図にも同じ印が出る。ビューどうしで表示が食い違わないようにするためである（1.3）。冒頭の 1 文は仕様書にだけ書く。
  - 初回の実行では、確定と要再確認を書くモジュールが無いので、印は出ない（確定の操作は現在の範囲外）。
- **曖昧さの一覧の例外（実装した）**: `projectAmbiguities` は、役割が `PdM` のとき、題と「このシナリオは曖昧さがあるので、形式仕様の検査まで進まなかった。」の文のあとに、「エンジニアの確認待ち: N 件」（`report.counts` の和）と「曖昧さの質問は実装の振る舞いについての問いなので、エンジニアが確かめる。」だけを書く。質問の文・種類・表示の id・所在・原文は出さない。表示の id と内部の識別子の対応は、これまでどおり実装との対応表（8.5）に残る。`Eng` のときは、これまでどおりすべてを書く（8.4）。仕様書・操作の一覧表・流れ図・俯瞰図の本文は、これまでどおり役割で変えない。