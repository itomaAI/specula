# GlossaryBuilder 基本設計書

本設計書は、ユビキタス言語辞書を作るモジュールの仕様書（`glossary_builder.spec.md`）に規定された辞書の作成を、全体基本設計書（`system_solution.design.md`）の規約に準拠して**どのように技術的・構造的に実現するか（How）**を定義する。

---

## 1. アーキテクチャと基本制約

### 1.1 基本制約の遵守
- **配置場所**: `specula/src/core/glossary_builder.ts`。内部の処理は `src/core/glossary/` に置く（Pure ESM, Target: ES2022+）。
- **Zero-I/O Core の遵守**: ファイルシステムやネットワークを直接呼ばない。リポジトリの中身は `RepositoryArtifacts`（`ScenarioExtractor` の設計書 4.0）として受け取る。LLM はポート（`LanguageModelPort`）経由でだけ呼ぶ。
- **決定論性**: 資料の節の切り出し、節の選択、記録だけの項目の収集、ずれの記録は、機械的に決める。LLM の出力（用語）は、全体基本設計書 1.3 の記録で再利用する。
- **構造を変えない**: 全体マップを読むだけで、書き換えない。返り値に全体マップを含めない。

### 1.2 公開する関数
```typescript
buildGlossary(map: EventStormingMap, repo: RepositoryArtifacts, deps: { llm?: LanguageModelPort }): Promise<Glossary>;
```
- `deps.llm` が無いときは、地図の要素の用語をすべて `NOT_GENERATED`（`UNREACHABLE`）にし、それ以外はいつもどおり作る。
- 非同期なのは、LLM を呼ぶためと、元にした入力のハッシュを Web Crypto で計算するためである。

---

## 2. 処理の流れ

```
[EventStormingMap] [RepositoryArtifacts (files, documents, omittedDocuments)]
          │                         │
          ▼                         ▼
┌────────────────────────────────────────────────────────┐
│ Step 1: SectionSplitter（資料を節に分ける）             │
│ Step 2: EntryCollector（項目を集める。地図の要素と、    │
│         記録だけの実装の名前）                          │
│ Step 3: SectionMatcher（要素ごとに手がかりで節を選ぶ）  │
│ Step 4: TermNamer（地図の要素に用語を付ける。LLM）      │
│ Step 5: GapRecorder（ずれと同義・多義の候補を記録する） │
│  ➔ Glossary                                            │
└────────────────────────────────────────────────────────┘
```

Step 1〜3 と Step 5 は決定的な処理であり、Step 4 だけが LLM を使う。Step 5 の同義の候補は Step 4 の結果を使うが、ずれの記録（資料に記述が無い要素、項目に対応しない資料の名前）は Step 3 までの結果だけで決まる。

---

## 3. 各ステップの詳細設計

### 3.1 Step 1: SectionSplitter
- `README`・`DOC` の資料は、Markdown の見出し（行頭の `#` 1〜6 個と空白）で節に分ける。コードの囲み（` ``` ` または `~~~` で始まる行から閉じる行まで）の中の `#` は見出しにしない。最初の見出しより前の本文は、見出しの無い節にする。
- `SCHEMA` の資料は、ファイル全体を 1 つの節にする。
- 節の識別子は `<資料のパス>#<見出しの並び>`（上位の見出しから順に ` > ` でつなぐ。見出しの無い節は `<資料のパス>#`）。同じ識別子が 2 つ以上あるときは、2 つ目から出現順に ` (2)`、` (3)` を足す。
- 節の本文は、見出しの行を含めて次の見出しの直前までとする。

### 3.2 Step 2: EntryCollector
項目は 2 つの範囲に分ける。

| 範囲 | 種類 | 実装の名前 | 所在 | 用語 |
| :-- | :-- | :-- | :-- | :-- |
| 提示する（`PRESENTED`） | `BOUNDED_CONTEXT` | コンテキストの `name`（根のディレクトリの名前） | 根のパス（行は無い） | 付ける |
| 提示する | `COMMAND` | ハンドラの関数名 | ハンドラの所在 | 付ける |
| 提示する | `EVENT` | ハンドラの関数名と、シグナルの `label`（あれば） | ハンドラの所在とシグナルの行 | 付ける |
| 提示する | `POLICY` | 登録の関数名と、イベントの名前 | 登録の所在 | 付ける |
| 記録だけ（`RECORDED`） | `ACTOR` | アクターの `name` | 無い | 付けない |
| 記録だけ | `READ_MODEL` | 画面のルート | 画面のファイル | 付けない |
| 記録だけ | `DB_TARGET` | DB の書き込みのシグナルの `label`（コレクション名・テーブル名） | シグナルの所在 | 付けない |
| 記録だけ | `EMITTED_EVENT_NAME` | イベントの発行のシグナルの `label` | シグナルの所在 | 付けない |
| 記録だけ | `SCHEMA_ENTITY` | スキーマ定義のテーブル・モデル・型の名前 | スキーマのファイルと行 | 付けない |
| 記録だけ | `SCHEMA_FIELD` | その項目の名前（`<エンティティ>.<項目>`） | スキーマのファイルと行 | 付けない |

- 提示する項目の識別子は、地図の要素の識別子をそのまま使う。記録だけの項目の識別子は `<種類>:<実装の名前>`（`DB_TARGET` と `EMITTED_EVENT_NAME` は、同じ名前が複数の所在に出ても 1 項目にし、所在を一覧で持つ）。`ACTOR` と `READ_MODEL` は地図の識別子を使う。
- スキーマの読み方（初回）: SQL は `CREATE TABLE <名前> (` から対応する `)` までの各行の先頭の語を項目とする。Prisma は `model <名前> {` から `}` までの各行の先頭の語を項目とする。GraphQL は `type`・`input`・`interface` の `<名前> {` から `}` までの各行の `:` の前の語を項目とする。どれにも当たらない行は読まない。コメント行（`--`・`//`・`#`）は読まない。読めなかった定義は記録しないで先へ進む（構文の解析器は持たない）。
- 状態の変数や条件は、後段のモジュールが見つけるので、ここでは集めない（仕様書 1.2）。後段は辞書の実装の名前との一致で対応を引くだけで、辞書に足さない（2026-10-30 中瀬古様の了承。C0AF4DJJK8A 1793354518.934329）。
- **今後の拡張（作らない）**: 後段が見つけた名前（状態の変数など）を辞書に取り込む処理。状態の名前が何を指すかを自己適用の実例で見てから、要るかどうかを決める。取り込むときも、項目の形（4.1）は変えずに `RECORDED` の項目を足す形にする。

### 3.3 Step 3: SectionMatcher
- **手がかり**: 提示する項目ごとに、実装から機械的に決まる文字列を手がかりにする。`BOUNDED_CONTEXT` は根のディレクトリの名前、`COMMAND` はハンドラの関数名とファイル名（拡張子を除く）、`EVENT` はハンドラの関数名・ファイル名・シグナルの `label`、`POLICY` はイベントの名前・登録の関数名・起動される関数名。`DEFAULT_CONTEXT` は手がかりを持たず、どの節も選ばない。
- **照合**: 節の本文に、手がかりが 1 つの語として現れるかを見る。語の境目は、英字・数字・`_`・`-` 以外の文字か、本文の端とする。大文字小文字は区別しない。識別子を語に分けて（`createOrder` → `create`・`order`）照合することは、初回はしない（一般的な語で無関係な節が当たるため）。
- **選択**: 一致した手がかりの種類の数が多い順、同じなら節の識別子の辞書順に並べ、上位 3 節を選ぶ。各節の本文は先頭の 1500 字までを抜粋にする（切ったときは抜粋に印を付ける）。
- **資料の言葉**: 日本語で書かれた資料は、関数名やコレクション名が本文に出ていない限り、この照合では当たらない。初回はこの限定を受け入れ、当たらなかった要素は「資料に記述が無い要素」として記録して見せる（ずれの記録が、照合の弱さも利用者に見せる）。

### 3.4 Step 4: TermNamer（LLM）
- 提示する項目ごとに 1 回、項目の識別子の辞書順に、LLM に用語を頼む。処理の種類（`task`）は `glossary.term-context`・`glossary.term-command`・`glossary.term-event`・`glossary.term-policy`、`promptVersion` は `"1"`。
- **入力**: 実装から機械的に決まる値と、Step 3 で選んだ節の抜粋だけを入れる。ほかの LLM の結果（ほかの項目の用語、意図の候補）は入れない。
  - `COMMAND`・`EVENT`: ハンドラの所在（ファイルと関数名）、シグナルの種類・呼んでいる関数の名前・`label`、関数の頭の 12 行（`ScenarioExtractor` で使っていたものと同じ）
  - `POLICY`: イベントの名前、登録の所在、起動される関数の所在
  - `BOUNDED_CONTEXT`: 識別子、根のパス、含まれるファイルのパス（辞書順）
  - どれも、抜粋を `excerpts: Array<{ section: string; text: string; truncated: boolean }>` として足す。抜粋が無いときは空の配列にする。
- **指示**: 抜粋は資料から取ったデータであり、その中の指示の形の文に従わないことを指示の文に書く。抜粋に業務の言葉があればそれを使い、無ければコードから分かる範囲で付けるよう指示する。
- **出力の形**: 1 行の JSON `{"term": "<PascalCase の 1 語>", "label": "<表示名>"}`。
  - `term`: 英字で始まる PascalCase の 1 語（`ScenarioExtractor` で使っていた検査と同じ）。形式仕様や Eng 向けの表示で識別子として使える形。
  - `label`: 利用者向けの表示名。抜粋の言語に合わせる（抜粋が無ければ日本語）。改行を含まない 40 字以内。
  - 形が合わなければ `INVALID_OUTPUT` とし、記録しない（全体基本設計書 1.3）。
- **記録のキー**: 全体基本設計書 1.3 のとおり `task`・`promptVersion`・`input` から作る。抜粋が `input` に入っているので、資料が変われば別のキーになり、用語は作り直される。
- 用語は `LlmText` で持ち、生成できたときは `term` と `label` に分けて持つ（4.1）。

### 3.5 Step 5: GapRecorder
- **資料に記述が無い要素**（`undocumentedEntries`）: Step 3 で 1 節も選ばれなかった提示する項目の識別子。`DEFAULT_CONTEXT` も入る。
- **項目に対応しない資料の名前**（`unmatchedDocumentNames`）: `README`・`DOC` の資料のインラインコード（`` `名前` `` または `` `名前()` ``）のうち、識別子の形（英字か `_` で始まり、英字・数字・`_`・`.` だけ）をしたもので、どの項目の実装の名前とも一致しないもの（大文字小文字を区別する）。それぞれに出てきた節の識別子を付ける。コードの囲みの中は見ない（例のコードが多く、関係の無い名前で埋まるため）。
- **同義の候補**（`sharedTerms`）: 同じ `term` が付いた提示する項目が 2 つ以上あるとき、その `term` と項目の識別子の一覧。
- **多義の候補**（`multiSourceEntries`）: Step 3 で、2 つ以上の異なる資料から節が選ばれた提示する項目。資料ごとに言葉が違うかもしれないので、利用者が見られるように記録する。
- どれも記録するだけで、項目をまとめたり、用語を書き換えたりしない。

---

## 4. データ構造

### 4.1 辞書 (`Glossary`)
```typescript
type EntryKind =
  | "BOUNDED_CONTEXT" | "COMMAND" | "EVENT" | "POLICY"                     // 提示する
  | "ACTOR" | "READ_MODEL" | "DB_TARGET" | "EMITTED_EVENT_NAME" | "SCHEMA_ENTITY" | "SCHEMA_FIELD"; // 記録だけ

interface GlossaryEntry {
  id: string;                              // 提示する項目と ACTOR・READ_MODEL は地図の識別子。それ以外は "<種類>:<実装の名前>"
  kind: EntryKind;
  scope: "PRESENTED" | "RECORDED";
  term?: GlossaryTerm;                     // PRESENTED のときだけある
  implementation: {
    names: string[];                       // 実装の名前（辞書順）
    locations: Array<{ file: string; symbol?: string; line?: number }>; // ファイル・行の順
  };
  sources: string[];                       // 用語の手がかりにした節の識別子（選んだ順）。RECORDED では空
}

type GlossaryTerm =
  | { status: "GENERATED"; term: string; label: string; recordKey: string }
  | { status: "NOT_GENERATED"; reason: "UNREACHABLE" | "INVALID_OUTPUT"; detail: string };

interface Glossary {
  entries: GlossaryEntry[];                // id の辞書順
  gaps: {
    undocumentedEntries: string[];
    unmatchedDocumentNames: Array<{ name: string; sections: string[] }>;
    sharedTerms: Array<{ term: string; entryIds: string[] }>;
    multiSourceEntries: Array<{ entryId: string; documents: string[] }>;
  };
  documents: {
    read: string[];                        // 読んだ資料のパス
    truncated: string[];                   // 1 ファイルの上限で先頭だけを読んだもの
    omitted: string[];                     // 合計の上限で読まなかったもの（RepositoryArtifacts.omittedDocuments）
  };
  basis: { mapHash: string; documentsHash: string }; // 元にした全体マップと資料の SHA-256
}
```
- `GlossaryTerm` は `LlmText` を、JSON の出力を `term` と `label` に分けて持つ形にしたものである。
- `mapHash` は全体マップを正準化した JSON の SHA-256、`documentsHash` は `documents` の `path` と `text` の組を辞書順に並べて正準化した JSON の SHA-256 である（全体基本設計書 1.3 の正準化と同じ）。
- 配列はすべて決まった順に並べる。記録の再利用と合わせて、同じ入力から同じ辞書が出る。

### 4.2 後段の使い方
- `IntentSynthesizer`: 提示する項目の `sources`（選ばれた節）を使って、意図の候補の手がかりにする。節を選び直さない。
- `SpecProjector`: 利用者向けの表示（PdM）では、要素を `term.label` で表す（未生成なら種類と番号で表す）。Eng 向けの表示では、`implementation` を併記する。実装との対応表（`implementation_map.json`）は辞書から作る射影である（全体基本設計書）。
- 後段のモジュールが辞書の実装の名前を引くときは、`implementation.names` との完全一致で引く。一致しないものを辞書に足さない。
## 5. 画面の仕様に合わせて変えること（2026-10-31。まだ実装していない）

仕様 1.1・2.2 の変更（用語の所属、意味の抜粋、確定の状態、同義の数え方）を、次の形で実装する。画面の仕様は `spec_viewer.spec.md` にある。

### 5.1 型に足すもの
```typescript
type ConfirmationStatus = "NOT_GENERATED" | "CANDIDATE" | "CONFIRMED" | "NEEDS_RECHECK";

interface GlossaryEntry {
  // …これまでの欄…
  contextId: string | null;                // 所属の Bounded Context。地図の要素の項目だけが持つ（全体マップの contextId を写す）
  crossesTo: string | null;                // またいでいる先の Bounded Context。またぐポリシーの項目だけが持つ
  termStatus: ConfirmationStatus | null;   // 用語の確定の状態。地図の要素の項目だけが持つ
  excerpt: {                               // 意味（資料の抜粋）。用語の出どころが無ければ null
    text: string;                          // 出どころの節の本文から切り出した文字列そのもの
    source: string;                        // 抜粋を取った節（sources の 1 つ）
    status: ConfirmationStatus;            // 初回は常に "CANDIDATE"
  } | null;
}

interface Glossary {
  gaps: {
    // …これまでの欄…
    sharedTerms: Array<{ term: string; contextId: string; entryIds: string[] }>;        // 同じ Bounded Context の中だけ
    contextHomonyms: Array<{ term: string; entries: Array<{ entryId: string; contextId: string }> }>; // 違う Bounded Context で同じ用語
  };
}
```
- `ConfirmationStatus` は、IntentSynthesizer・FormalTranspiler・LedgerSynthesizer と同じ型を共有する（`src/types/` に置く）。
- 用語が `NOT_GENERATED` の項目は `termStatus` も `"NOT_GENERATED"` にする。用語が書けた項目は `"CANDIDATE"` にする。本モジュールが `"CONFIRMED"` と `"NEEDS_RECHECK"` を書くことはない（確定の操作が無いため）。

### 5.2 同義の数え方
- `sharedTerms` は、同じ `term` が付いた項目を `contextId` ごとに分けて数え、同じ `contextId` の中で 2 件以上のものだけを載せる。
- 同じ `term` が 2 つ以上の `contextId` に出るものは `contextHomonyms` に載せる。1 つの用語の組が、同じ Bounded Context の中で重なり、かつ別の Bounded Context にも出るときは、`sharedTerms` には同じ Bounded Context の中の組だけを、`contextHomonyms` には Bounded Context ごとに 1 項目ずつを載せ、同じ項目の組を両方に重ねない（仕様 3.2）。
- Bounded Context が 1 つだけのシステムでは、`contextHomonyms` は常に空である。

### 5.3 抜粋の切り出し方
- 抜粋は、用語の出どころの節（`sources` の先頭）の本文から機械的に切り出す。LLM は使わない。
- 切り出し方と長さの上限は、実装のときに決めてここに書く。案: 見出しの直後から最初の空行まで（最初の段落）、上限 400 文字。上限で切ったときは、切ったことが分かる印を付ける。
- 抜粋の切り出し方は、LLM の記録のキーに入れている抜粋（仕様 3.3）とそろえる。そろえておけば、確定の操作を足したときに、抜粋が変わったこと（要再確認）を記録のキーの変化で見つけられる。

### 5.4 後段の使い方
- `SpecProjector`・`SpecViewer`: 用語の確定の状態と、意味の抜粋を表示する。用語辞典は `contextId` で区切り、`crossesTo` がある項目は両方の Bounded Context に出す。