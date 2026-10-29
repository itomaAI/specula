# LedgerSynthesizer 基本設計書

本設計書は、論点合成モジュールの仕様書（`04_ledger_synthesizer.spec.md`）に規定された、検証結果から人が判断する論点への変換を、全体基本設計書（`system_solution.design.md`）の規約に準拠して**どのように技術的・構造的に実現するか（How）**を定義する。

---

## 1. アーキテクチャと全体設計制約の継承

### 1.1 全体設計制約の適用
- **配置場所**: `specula/src/core/ledger_synthesizer.ts`（ビルド後は `dist/` の JS）（Pure ESM, Target: ES2022+）。
- **Zero-I/O Core の遵守**: ファイルの読み書きをしない。`SolverReport` と `FormalSpecification` を受け取り、論点カタログ `DomainLedgerCatalog` を返す。
- **依存方向の一方向性**: `src/ports/` と `src/types/` だけを参照する。LLM は `LanguageModelPort` 経由でだけ呼ぶ。
- **LLM の担当**: 論点の文（主張・観測事実・判断質問）だけ。論点の数、まとめ方、選択肢の種類、並びは決定論的に決める（全体設計 1.2）。

### 1.2 公開する関数
```typescript
synthesizeLedger(
  report: SolverReport,
  spec: FormalSpecification,
  deps: { llm: LanguageModelPort },
): Promise<DomainLedgerCatalog>;
```
- 報告 1 つ（シナリオ 1 つ）から、カタログを 1 つ作る。
- 入力の契約が破れているとき（`report.scenarioId` と `spec.scenarioId` が違う、`report.specSourceHash` が `spec.source` の SHA-256 と違う、`findings` が `spec` に無い操作の識別子を指す）は、例外 `LedgerContractError` にする。

### 1.3 構成
```
[SolverReport] + [FormalSpecification]
      │
      ▼
[ContractGuard]         ── 入力の契約を確かめる（破れていれば例外）
      │
      ▼
[VerificationSummary]   ── 報告の状態・実行条件・行っていない検査を写す（2 節）
      │
      ▼
[FindingGrouper]        ── 同じ状態を指す反例を 1 つの論点にまとめる（3 節）
      │
      ▼
[OptionCatalog]         ── 反例の種類ごとに決まった選択肢を付ける（4 節）
      │
      ▼
[IssueWriter]           ── LLM で論点の文を書く（5 節）
      │
      ▼
[DomainLedgerCatalog]（要約）
```

---

## 2. 検証の状態をそのまま伝える（VerificationSummary）

カタログの先頭に、元にした報告の状態を写す。論点が 0 件でも、何を確かめて何を確かめていないかを人が読めるようにするためである。

| 報告の状態 | カタログに書くこと |
| :-- | :-- |
| `UNVERIFIED` | 「未検証」と理由、実行しなかった検査の一覧。見つかったものがあれば論点にする（未検証の報告でも、エンジンが出した反例は本物なので捨てない） |
| `CHECKED` で見つかったものが 0 件 | 「指定のスコープの中で、行った検査では見つからなかった」と、スコープ（ステップ数の上限など） |
| `CHECKED` で見つかったものが 1 件以上 | 論点の一覧（3 節以降） |

どの場合も、次を書く。
- 不変条件の検査をしていないこと（`invariantChecks` が `NOT_APPLICABLE` のとき）。
- 未定義遷移の検査は 1 件目の反例しか返さないこと（`exhaustive: false` の検査があるとき）。

**見つかったものが 0 件でも、仕様を確定する（ロックする）推奨は出さない。** 既存の設計にあった「証明成功時の確定推奨」はやめる。初回は不変条件が無く、検査は仕様の形についてのものだけなので、0 件は「仕様が正しい」ことを示さない。仕様を確定するかどうかは、人が論点に判断を下した後に決めることである。

---

## 3. 反例のまとめ方（FindingGrouper）

### 3.1 依存の決め方（初回は簡単な形）
反例どうしの依存は、**同じ状態を指しているかどうか**だけで決める（中瀬古様の判断「M4 は簡単な依存分析」）。

- 反例が指す状態は、実行列（`trace`）の最後の時点の状態変数の値の組（`values`）とする。
- 同じ状態を指す反例は、1 つの論点にまとめる。どれを論点の本体（根本の反例）にするかは、種類の順で決める: `DEADLOCK` → `UNHANDLED_TRANSITION` → `OVERLAPPING_OPERATIONS`。残りは、その論点に従属する反例として記録する。
  - 例: 同じ状態について、未定義遷移の反例と、それを確かめたデッドロックの反例があるとき、論点はデッドロック 1 件になり、未定義遷移の反例はそれに従属する。M3 はデッドロックを未定義遷移の反例から確かめるので（M3 の設計 2.2）、この組は必ず同じ状態を指す。
- `UNREACHABLE_OPERATION` は実行列を持たないので、ほかの反例とまとめず、1 件で 1 つの論点にする。
- 状態をまたぐ依存（ある反例を解消すると、別の状態の反例も解消する、という鎖）は、初回は作らない。そのような鎖を正しく判定するには、人の判断で仕様が変わった後の再検査が要るためである。既存の設計にあった因果グラフとトポロジカルソートは、この理由で初回の範囲から外す。

### 3.2 並び
- 論点は、本体の反例の `findings` の中の順（M3 の設計 4.2）に並べる。
- 論点の識別子は `LEDGER-<scenarioId>-<3 桁の連番>` とする。同じ報告からは同じ識別子になる。

### 3.3 グルーピング
- カタログはシナリオに 1 つなので、シナリオでのグルーピングはカタログの単位で済む。カタログの中では、本体の反例の種類で見出しを分ける（M5 が表示する）。

---

## 4. 選択肢（OptionCatalog）

選択肢は、反例の種類ごとに決まった 3 つとする。種類ごとに意味が違うので、1 つの選択肢（既存のコードの `ALLOW_EDGE_CASE` など）をすべての種類に使い回さない。

| 反例の種類 | 選択肢の識別子 | 意味 |
| :-- | :-- | :-- |
| `UNHANDLED_TRANSITION` | `SPECIFY_HANDLING` | この状況での扱い（エラーにする、操作を受け付けないなど）を仕様として決める。中身は人が書く |
| | `FIX_IMPLEMENTATION` | 実装の誤りとして直す |
| | `ACCEPT_AS_UNREACHABLE` | 実際には起きない状況として認める。理由を人が書く |
| `OVERLAPPING_OPERATIONS` | `SPECIFY_PRIORITY` | 両方の条件が成り立つときに、どちらの結果にするかを仕様として決める |
| | `FIX_IMPLEMENTATION` | 実装の誤りとして直す |
| | `ACCEPT_AS_UNREACHABLE` | 両方が成り立つことは実際には起きないとして認める。理由を人が書く |
| `UNREACHABLE_OPERATION` | `FIX_IMPLEMENTATION` | 届くべき処理なので、実装の誤りとして直す |
| | `REMOVE_OPERATION` | 不要な処理として消す |
| | `RECHECK_WITH_LARGER_SCOPE` | ステップ数の上限を上げて検査し直す |
| `DEADLOCK` | `SPECIFY_EXIT` | この状態からの抜け方を仕様として決める |
| | `DECLARE_TERMINAL` | 終わりの状態（それ以上の操作を受け付けない状態）として認める |
| | `FIX_IMPLEMENTATION` | 実装の誤りとして直す |

- 選択肢の識別子と意味の文は、この表で固定する（LLM で作らない）。表の文は人が読む定型の説明であり、LLM の出力の代わりではない。
- **どの選択肢も採択しない。** 論点の `decision` は初回はすべて `null`（未決）である。既存のコードのように先頭の選択肢（`options[0]`）を採択済みとして扱うことはしない。`decision` の型は 2 回目以降のために置くだけである。

---

## 5. 論点の文（IssueWriter）

- 論点ごとに LLM を 1 回呼ぶ（`task: "m4.issue-text"`）。
- 入力: 反例の種類、関わる操作（識別子・出口の種類・表示名）、実行列（時点ごとの状態変数の値・出口・成り立つ命題）、命題の原文の式（`spec.propositions[].expression`）、従属する反例の種類。表示名は `spec.labels` の `GENERATED` の文だけを渡し、`NOT_GENERATED` の項目は識別子のまま渡して、表示名が無いことを伝える。
- 出力: `claim`（本来あるべき前提の文）、`observation`（検査で見つかったことの平易な文）、`question`（人に判断を求める問いの文）の 3 つを持つ JSON。
- 出力の検査: 3 つがすべてあり、それぞれ空でなく 400 文字以内であること。合わなければ `INVALID_OUTPUT` として、3 つとも未生成にする。
- 届かないときや検査に通らないときは、3 つの文を `NOT_GENERATED` にする。論点の構成（反例、選択肢、従属）はそのまま残す。文を定型文で埋めない。
- 文の中に Alloy の識別子（`op1`・`v1` など）を出さないよう、プロンプトで指示する。出たかどうかは機械で確かめ、出ていれば `INVALID_OUTPUT` とする。

---

## 6. 型

```typescript
interface DomainLedgerCatalog {
  scenarioId: string;
  basis: {                                    // 要約の範囲
    reportId: string;                         // 元にした SolverReport
    specSourceHash: string;                   // 元にした形式仕様正本の版
    conditions: SolverReport["conditions"];
    findingCount: number;                     // 元の記録の反例の件数 N
    issueCount: number;                       // まとめた論点の件数 k
  };
  verification: {
    status: "CHECKED" | "UNVERIFIED";
    reason: SolverReport["reason"];
    unexecutedChecks: string[];
    invariantChecks: SolverReport["invariantChecks"];
    nonExhaustiveChecks: string[];            // 反例を 1 件だけ返す検査の id
  };
  issues: LedgerIssue[];
}

interface LedgerIssue {
  id: string;                                 // "LEDGER-<scenarioId>-001"
  kind: Finding["kind"];                      // 本体の反例の種類
  rootFinding: number;                        // 本体の反例の findings の中の位置
  dependentFindings: number[];                // 従属する反例の位置
  operations: string[];
  trace: TraceStep[] | null;
  claim: LlmText;
  observation: LlmText;
  question: LlmText;
  options: Array<{ id: string; meaning: string }>;   // 4 節の表から
  decision: null;                             // 初回は常に未決
}
```
- `findingCount` と、すべての論点の `rootFinding` と `dependentFindings` の合計は一致する（すべての反例がどれかの論点からたどれる）。
- **古くなったことの印**: カタログは `basis.specSourceHash` を持つ。M5 またはオーケストレーターは、いまの形式仕様正本のソースの SHA-256 と比べ、違えば「このカタログは古い仕様から作った」と表示する。2 回目以降に人の決定を持つようになっても、この印で決定を消したり上書きしたりしない（全体アーキテクチャ 4.3）。