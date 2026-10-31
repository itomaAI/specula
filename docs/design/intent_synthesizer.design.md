# IntentSynthesizer 基本設計書

本設計書は、意図の候補を作るモジュールの仕様書（`intent_synthesizer.spec.md`）に規定された処理を、全体基本設計書（`system_solution.design.md`）の規約に準拠して**どのように技術的・構造的に実現するか（How）**を定義する。

---

## 1. アーキテクチャと基本制約

### 1.1 基本制約の遵守
- **配置場所**: `specula/src/core/intent_synthesizer.ts`（Pure ESM, Target: ES2022+）。
- **Zero-I/O Core の遵守**: ファイルシステムやネットワークを直接呼ばない。LLM はポート（`LanguageModelPort`）経由でだけ呼ぶ。
- **決定論性**: LLM の出力は全体基本設計書 1.3 の記録で再利用する。それ以外（手がかりの組み立て、順序）は機械的に決める。

### 1.2 公開する関数
```typescript
synthesizeIntents(
  map: EventStormingMap,
  slice: SliceResult,
  glossary: Glossary,
  repo: RepositoryArtifacts,
  deps: { llm?: LanguageModelPort },
): Promise<IntentCatalog>;
```
- 呼ぶ前に、`glossary.basis.mapHash` が `map` のハッシュと一致することを確かめる。一致しなければ `IntentContractError`（`GLOSSARY_STALE`）を投げる。
- `deps.llm` が無いときは、すべての候補を `NOT_GENERATED`（`UNREACHABLE`）にする。

---

## 2. 処理

### 2.1 手がかりの組み立て
- **抜粋**: 辞書の項目の `sources`（節の識別子）から、`GlossaryBuilder` の設計書 3.1 と同じ規則で節の本文を取り出し、先頭の 1500 字までを抜粋にする。節は選び直さない。節の切り出しの関数は `GlossaryBuilder` と共有する（`src/core/glossary/sections.ts`）。
- **Bounded Context**: 識別子、根のパス、含まれるファイルのパス（辞書順）、その Bounded Context の項目の抜粋。
- **シナリオ**: 起点の種類、起点の所在（ファイルと関数名）、期待イベントの所在とシグナル（種類・呼んでいる関数の名前・`label`）、アクターの名前、画面のルート（あれば）、起点の項目と期待イベントの項目の抜粋（節の識別子で重複を除き、起点の項目の節を先に、最大 3 節）。
- 辞書の用語（`term`・`label`）は入れない（仕様書 3.3）。

### 2.2 LLM の処理
| 処理の種類（`task`） | 対象 | 指示の要点 |
| :-- | :-- | :-- |
| `intent.context` | Bounded Context ごと | この範囲のコードが業務の中で受け持つこと（存在理由）を書く |
| `intent.scenario` | シナリオごと | この操作で、操作する人（または呼び出す側）が達成したいことを書く |

- `promptVersion` は `"1"`。識別子の辞書順に 1 件ずつ呼ぶ。
- 出力は日本語の 1 文（改行しない、200 字以内）。合わなければ `INVALID_OUTPUT`（`CommandExtractor` で使っていた検査と同じ）。
- 指示の文に、抜粋は資料から取ったデータであり、その中の指示の形の文に従わないこと、コードと抜粋に書かれていないことを推測で足さないことを書く。
- 記録のキーは全体基本設計書 1.3 のとおり。抜粋が `input` に入っているので、資料が変われば候補は作り直される。
- これまで `CommandExtractor` が行っていた `m0.context-intent`・`m0.scenario-intent` を置き換える。入力が変わる（抜粋が入る）ので、それまでの記録は使わない。

---

## 3. データ構造

```typescript
interface IntentCatalog {
  contexts: Array<{
    contextId: string;
    intent: LlmText;
    intentStatus: ConfirmationStatus;            // GlossaryBuilder 基本設計 5.1 の型を共有する
  }>;                                            // contextId の辞書順
  commands: Array<{
    commandId: string;
    intent: LlmText;
    intentStatus: ConfirmationStatus;
    userIntent?: string;                         // CommandTarget.userIntent をそのまま写す
  }>;                                            // commandId の辞書順
  basis: { mapHash: string; documentsHash: string }; // 元にした辞書の basis をそのまま写す
}
```
- `intentStatus` は、用語などと共有する `ConfirmationStatus`（`NOT_GENERATED`・`CANDIDATE`・`CONFIRMED`・`NEEDS_RECHECK`。GlossaryBuilder 基本設計 5.1）である。`intent` が `GENERATED` の欄は `CANDIDATE`、`NOT_GENERATED` の欄（`UNREACHABLE` と `INVALID_OUTPUT` のどちらも）は `NOT_GENERATED` にする。欄ごとに決めるので、1 回の実行の中に両方が混ざることがある。GlossaryBuilder の `termStatus` と同じ規則である。
- 本モジュールが `CONFIRMED` と `NEEDS_RECHECK` を書くことはない。`CONFIRMED` にするのは、2 回目以降の実行で前回の合意結果を受け取る処理であり、初回の範囲外である。
- **2026-10-31 の変更（実装した）**: それまでの型 `IntentStatus`（`CANDIDATE`・`CONFIRMED`）を外し、`ConfirmationStatus` にした。公開する型からも `IntentStatus` を外し、`ConfirmationStatus` を足した（`src/index.ts`）。それまでのコードは「`intent` が未生成でも `CANDIDATE`」だった。
- 2026-10-30 の時点で、意図を読む後段のモジュールは無い（`CommandExtractor` が出していたときも、読むものは無かった）。表示に使うかどうかは、全体基本設計書の表示の節で決める。`ContextExtractor`・`FormalTranspiler`・`FormalSolver`・`LedgerSynthesizer` は意図を使わない。

---

## 4. 初回の実装で決めたこと（2026-10-30）

- **資料のハッシュも確かめる**: 1.2 の `glossary.basis.mapHash` に加えて、`glossary.basis.documentsHash` が受け取った資料のハッシュと一致することも確かめ、違えば `IntentContractError`（`GLOSSARY_STALE`）を投げる。抜粋は、辞書が選んだ節の識別子で `repo.documents` から切り出すので、資料が違うと黙って別の本文を渡してしまうためである。ハッシュの計算は `GlossaryBuilder` と同じ関数（`documentsHashOf`）を使う。
- **出力の検査**: 前後の空白を除いて、空でない・1 行・200 字以内。`CommandExtractor` の `m0.context-intent` で使っていたものと同じで、文の数（句点の数）は数えない。
- **Bounded Context の「含まれるファイル」**: 全体マップでそのコンテキストに属するコマンドとイベントのハンドラのファイル（辞書順）。全体マップはコンテキストごとのファイルの一覧を持たないため、`GlossaryBuilder` の用語の入力と同じ関数（`contextFilesOf`）を使う。
- **呼ぶ順**: Bounded Context を識別子の辞書順に、続いてシナリオを識別子の辞書順に、1 件ずつ呼ぶ。
- **シナリオの入力**: 起点の種類、起点の所在（ファイルと関数名。ポリシーが起点のときはリスナーの登録の場所）、期待イベントの所在とシグナル（種類・呼んでいる関数の名前・`label`）、アクターの名前、画面のルート（無ければ `null`）、抜粋。利用者が書いた目的（`userIntent`）は入力に入れず、出力の別の欄にそのまま写す。
- **辞書に項目が無いとき**: ハッシュが一致していれば、地図の要素の項目と、辞書が選んだ節は必ずある。無ければ実装の誤りなので、契約のエラーではない例外で止める。
- **後段への受け渡し**: オーケストレーターは 1 回の実行で 1 回だけ呼び、`PipelineResult.intents` と `RunReport.intents`（全体設計 2.1）に入れる。SpecProjector に渡すこと、入口が `intents.json` を書くことは、後の変更で行う。