# FormalSolver 基本設計書

本設計書は、形式仕様検証モジュールの仕様書（`03_formal_solver.spec.md`）に規定された検証を、全体基本設計書（`system_solution.design.md`）の規約に準拠して**どのように技術的・構造的に実現するか（How）**を定義する。

---

## 1. アーキテクチャと全体設計制約の継承

### 1.1 全体設計制約の適用
- **配置場所**: `specula/src/core/formal_solver.ts`（ビルド後は `dist/` の JS）（Pure ESM, Target: ES2022+）。
- **Zero-I/O Core の遵守**: コアに置くのは「検査コマンドの組み立て」と「エンジンの出力の読み取り・正規化」だけとする。検証エンジンの実行は外部プロセスで行い、コアは `SolverPort` を介してだけ呼び出す。
- **依存方向の一方向性**: `src/ports/` と `src/types/` だけを参照し、エンジンの所在（手元の PC、CI）を知らない。
- **LLM は使わない**（全体設計 1.2）。

### 1.2 公開する関数
```typescript
verifySpecification(
  spec: FormalSpecification,
  deps: { solver: SolverPort | null },
  options?: SolverOptions,
): Promise<SolverReport>;
```
- `deps.solver` が `null` のとき（その環境にアダプターが無いとき）は、検査をせずに `UNVERIFIED`（理由 `NO_SOLVER`）の報告を返す（4 節）。
- 入力の `FormalSpecification` が M2 の契約を破っているとき（`operations` が空、`guardPredicate` が無い、`stateVariables` の識別子がソースに無いなど）は、例外 `SolverContractError` にする。オーケストレーターは「M3 で止まった」と理由付きで実行の報告に残す。

### 1.3 構成
```
[FormalSpecification]
      │
      ▼
[ContractGuard]          ── 入力の契約を確かめる（破れていれば例外）
      │
      ▼
[CheckPlanner]           ── stateVariables と operations から検査の一覧を作る（2 節）
      │
      ▼
[CommandPrinter]         ── 検査ごとに Alloy のコマンドを書き、M2 のソースの後ろに足す
      │
      ▼
«SolverPort»             ── Alloy 6 で実行する（3 節）
      │
      ▼
[ReportNormalizer]       ── エンジンの出力を、M2 の識別子でたどれる形に直す
      │
      ▼
[SolverReport]（元の記録）
```

- **エンジンは Alloy 6 の 1 系統に限る。** 実行環境ごとにエンジンを使い分けると、同じ仕様でも環境によって結果が変わるためである。簡易なエンジンで代わりに判定することもしない。
- **状態爆発時の分割（Compositional Slicer）は範囲外**とする（中瀬古様の判断、2026-10-30）。時間内に終わらない検査は分割せずに `UNVERIFIED`（理由 `TIMEOUT`）にする。報告には、分割していないことを `partitioning: "NONE"` として書く。
- **将来の選択肢（現時点では作らない）**: Alloy から SAT への変換部を自前で持ち、同じ SAT ソルバ（WebAssembly 版など）をどの環境でも使う構成。処理能力の低いマシンでは WebAssembly の実行が難しい場合があるため、まずは外部実行とする。

---

## 2. 検査の組み立て（CheckPlanner と CommandPrinter）

### 2.1 前提にする M2 の出力
M3 は、M2 が作った Alloy のソースを書き換えない。ソースの後ろに検査のコマンドを足すだけである。検査は、次の M2 の出力から組み立てる（M2 の設計 4.3）。

- `stateVariables`: 状態変数の識別子、値の種類（`BOOL`・`ENUM`・`INT`）、値の識別子。状態は `System` のフィールドとして持つ。
- `operations`: 操作（スライス）の識別子、出口の識別子、出口の種類、**操作を実行できる条件の述語の名前（`guardPredicate`）**。
- `propositions`: 環境が決める命題。各時点で自由に決まる（M2 の設計 2.3）。

`guardPredicate` は、その操作の条件だけを、**その時点の状態と `Env.holds` に対する式**として書いた述語（`pred op1_guard {}`）である。プライム（次の時点の値）を含まない。M2 は、条件を、それより前の書き込みを反映した値に対して評価するので（M2 の設計 3.1）、条件は書き込みを合成した式として、その時点の状態だけで書ける。操作の述語 `op1` は `op1_guard` と書き込み・出口・フレーム条件の連言になる。
> この述語の作り方は M2 の設計 3.1、型は M2 の設計 4.3（`operations[].guardPredicate`）にある。

`SolverOptions` の型は次のとおりである。省いた項目は既定値（2.4）になる。
```typescript
interface SolverOptions {
  maxSteps?: number;        // 既定 10
  bitwidth?: number;        // 既定 4
  timeoutMs?: number;       // 検査 1 回（ステップ数 1 つ）あたり。既定 60000
}
```

### 2.2 初回に行う検査
初回の実行では、業務上の不変条件（`assert`）が無い（M2 の設計 3.3）。このため、M3 が行うのは、**仕様の形そのものから決まる検査**だけである。検査は次の順に並べる（同じ入力から同じ順になる）。

| 順 | 検査 | Alloy のコマンド | 見つかったときの記録 |
| :-- | :-- | :-- | :-- |
| 1 | 未定義遷移: 到達できる状態と、その時点の命題の組み合わせで、どの操作も実行できないものがあるか | `check m3_cover { always (op1_guard or op2_guard or …) }` | `UNHANDLED_TRANSITION` |
| 2 | 操作の重なり: 同じ状態と命題で、2 つの操作がどちらも実行できるか（操作の組ごと、番号の小さい順） | `check m3_overlap_op1_op2 { always not (op1_guard and op2_guard) }` | `OVERLAPPING_OPERATIONS` |
| 3 | 到達不能な操作: その操作が一度でも実行される実行列があるか（操作ごと） | `run m3_reach_op1 { eventually op1 }` | 見つからなければ `UNREACHABLE_OPERATION` |
| 4 | デッドロック: 1 で見つかった状態のそれぞれについて、命題をどう選んでもどの操作も実行できないか | `run m3_escape_<n> { eventually (<その状態> and (op1_guard or …)) }` | 見つからなければ `DEADLOCK` |

- **1 と 4 の関係**: 1 の反例は「その状態で、その命題の組み合わせでは実行できる操作が無い」ことを示す。命題は環境が各時点で自由に決めるので、別の組み合わせなら実行できることがある。4 は、1 で見つかった状態の値（状態変数の値の組）について、実行できる組み合わせが 1 つも無いかを確かめる。無ければ、その状態は抜け出せない（デッドロック）。1 は反例が見つかるたびに 1 件だけ返すので、4 は 1 の反例 1 件ごとに 1 回行う。
- **1 で見つかる反例は 1 件だけである。** `check` は反例を 1 つ返すと止まる。同じ検査で別の反例を探すために、見つかった状態の値を除く条件を足して繰り返すことはしない（初回の範囲外）。報告には「この検査の反例は 1 件目だけ」と書く（`exhaustive: false`）。
- **2 は操作の組の数だけ行う。** 操作の数 n に対して n(n−1)/2 回である。M1 のスライスは出口ごとに 1 つなので、n は分岐の組み合わせでは増えない（M1 の設計）。
- **3 の「見つからない」は、指定のスコープ（時相のステップ数の上限）の中で見つからないという意味である。** 報告にもそう書く。
- **不変条件違反の検査は行わない。** 報告の `invariantChecks` は `{ status: "NOT_APPLICABLE", reason: "NO_ASSERTIONS_FIRST_RUN" }` とする。「違反が無かった」とは書かない。2 回目以降、人が論点に判断を下して M2 が `assert` を作るようになったら、ここに `check` を足す。

### 2.3 状態の値の書き方（4 の検査）
4 の検査で使う「その状態」は、1 の反例の最後の時点の状態変数の値から作る。

```alloy
System.v1 = True and System.v2 = v2_3 and System.v3 = 2
```
- `BOOL` と `ENUM` は値の識別子、`INT` は整数で書く。値の識別子はすべて M2 が機械的に作ったものなので、原文の式を埋め込まない（全体設計の注入の防止）。
- 出口（`System.outcome`）はこの条件に入れない。どの操作を実行できるかは、状態変数と命題だけで決まるためである。

### 2.4 スコープと最短の反例
- コマンドのスコープは `for 3 but <bitwidth> Int, 1..<k> steps` の形で書く。M2 の型はほぼすべて `one sig` なので、既定のスコープ 3 は結果に影響しない。
- **既定値**: 整数のビット幅 4、時相のステップ数の上限 10。どちらも Alloy 6 の既定と同じ値である（中瀬古様の判断「推奨の既定で試す」）。`SolverOptions` で変えられる。
- **整数のあふれ**: Alloy の整数はビット幅を超えると折り返す。あふれによる偽の反例を避けるため、あふれを禁じる設定（Alloy の Prevent Overflows）を有効にし、報告に書く。設定の渡し方はアダプターで決める（3.3）。
- **最短の反例**: 検査ごとに、ステップ数の上限を 1 から 1 ずつ上げて実行し、最初に反例（`run` では実例）が見つかった長さで止める。こうすると、エンジンの探索の順によらず、返す反例が最短になる。代わりに、検査 1 件につき最大 k 回エンジンを呼ぶ。
  - 同じ長さの反例が複数あるとき、どれが返るかは SAT ソルバとその版による。このため、実行条件（4.2）を記録し、決定論性は「同一の実行条件のもとで」約束する。

---

## 3. ソルバの呼び出し（SolverPort とアダプター）

### 3.1 ポートの型
```typescript
interface SolverRequest {
  source: string;                       // M2 のソース + M3 のコマンド
  command: string;                      // 実行するコマンドの名前（"m3_cover" など）
  steps: number;                        // このときのステップ数の上限
  bitwidth: number;
  preventOverflow: boolean;
  timeoutMs: number;
}

type SolverResponse =
  | { kind: "UNSAT"; engine: EngineInfo }
  | { kind: "SAT"; engine: EngineInfo; instance: RawInstance }
  | { kind: "ENGINE_ERROR"; engine: EngineInfo | null; message: string }
  | { kind: "UNREACHABLE"; detail: string }
  | { kind: "TIMEOUT"; engine: EngineInfo | null };

interface EngineInfo { alloyVersion: string; satSolver: string; satSolverVersion: string | null }

interface SolverPort {
  run(request: SolverRequest): Promise<SolverResponse>;
}
```
- `RawInstance` は、エンジンが出した実例を、時点ごとの各フィールドの値（原子の名前の組）として表したものである。形はアダプターがそろえ、コアは Alloy の出力の書式を知らない。
- アダプターは例外を投げず、届かないことも値（`UNREACHABLE`・`TIMEOUT`）で返す。全体設計 1.3 の `LlmText` と同じ考え方である。

### 3.2 アダプター
| アダプター | 環境 | 動き |
| :-- | :-- | :-- |
| `CliAlloyAdapter` | Node.js・GitHub Actions | ソースを一時ファイルに書き、`java` で Alloy 6 を子プロセスとして起動し、出力を読む |
| `LocalBridgeAlloyAdapter` | Itera OS | ローカルブリッジ経由で、手元の PC の `java` で Alloy 6 を起動する。ブラウザの中では Java 製の Alloy を動かせないためである |

### 3.3 未確定の事項
次はまだ確かめていない。実際のエンジンで確かめてから本節に書き足す。確かめるまで、両アダプターは `UNREACHABLE` を返すものとして扱う。
- Alloy 6 をコマンドラインから実行し、実例を機械で読める形（JSON など）で受け取るコマンドの形と、そのときの Alloy の版。
- あふれを禁じる設定と、SAT ソルバの指定を、コマンドラインでどう渡すか。
- `LocalBridgeAlloyAdapter` がローカルブリッジのどの口を呼ぶか。ローカルブリッジは中瀬古様の手元で用意していただく。用意していただくもの（Java の版、Alloy の版と置き場所、呼ぶコマンドの形）は、Alloy の段でスレッドにまとめる。

---

## 4. 報告（ReportNormalizer と SolverReport）

### 4.1 報告の状態
| `status` | 意味 |
| :-- | :-- |
| `CHECKED` | 2.2 の検査をすべてエンジンで実行した。見つかったもの（`findings`）が 0 件でもこの状態になる。0 件は「指定のスコープの中で見つからなかった」という意味である |
| `UNVERIFIED` | 一部またはすべての検査をエンジンで実行できなかった。理由（`reason`）を付ける |

- `UNVERIFIED` の理由: `NO_SOLVER`（アダプターが無い）、`UNREACHABLE`（ローカルブリッジやエンジンにつながらない）、`TIMEOUT`（時間内に終わらない）、`ENGINE_ERROR`（エンジンがソースを受け付けない。M2 のソースの誤りを示すので、エンジンのメッセージをそのまま `detail` に残す）。
- 途中で実行できなくなったときは、そこで検査をやめる。それまでに見つかったもの（`findings`）は残し、実行しなかった検査を `unexecutedChecks` に並べる。見つかった反例はエンジンが実際に出したものなので、未検証の報告でも捨てない。
- **未検証の報告を、反例が無かった報告として扱わない。** M4 と M5 は、`UNVERIFIED` をそのまま「未検証」と表示し、`unexecutedChecks` を示す。
- `isSound`（健全かどうかの真偽値）は持たない。言えるのは「どの検査を、どの条件で実行し、何が見つかったか」だけだからである。

### 4.2 型
```typescript
interface SolverReport {
  reportId: string;                     // 下の注を参照
  scenarioId: string;
  specSourceHash: string;               // M2 のソースの SHA-256
  status: "CHECKED" | "UNVERIFIED";
  reason: null | { kind: "NO_SOLVER" | "UNREACHABLE" | "TIMEOUT" | "ENGINE_ERROR"; detail: string };
  conditions: {
    engine: EngineInfo | null;          // 実際に使われた版。実行できなかったときは null
    scope: number;                      // 3
    bitwidth: number;
    maxSteps: number;
    preventOverflow: boolean;
    timeoutMs: number;
    partitioning: "NONE";
  };
  checks: Array<{
    id: string;                         // "m3_cover" など。2.2 の順
    kind: "COVER" | "OVERLAP" | "REACH" | "ESCAPE";
    targets: string[];                  // 対象の操作の識別子
    result: "FOUND" | "NOT_FOUND_WITHIN_SCOPE";
    exhaustive: boolean;                // COVER は false（反例は 1 件目だけ）
    steps: number | null;               // 見つかった長さ。見つからなければ null
  }>;
  unexecutedChecks: string[];
  findings: Finding[];
  invariantChecks: { status: "NOT_APPLICABLE"; reason: "NO_ASSERTIONS_FIRST_RUN" };
}

interface Finding {
  kind: "UNHANDLED_TRANSITION" | "OVERLAPPING_OPERATIONS" | "UNREACHABLE_OPERATION" | "DEADLOCK";
  checkId: string;
  operations: string[];                 // 関わる操作の識別子
  trace: TraceStep[] | null;            // UNREACHABLE_OPERATION は実行列が無いので null
}

interface TraceStep {
  index: number;                        // 0 が初期状態
  values: Record<string, string | number>;  // 状態変数の識別子 → 値の識別子か整数
  outcome: string;                      // "Idle" か出口の識別子
  holds: string[];                      // その時点で成り立つ命題の識別子（番号順）
}
```
- **`reportId`**: `specSourceHash`、検査の一覧、`conditions` を正準化した JSON（キーを辞書順に並べたもの）の SHA-256 とする。同じ仕様を同じ条件で検査した報告は同じ識別子になる。M4 は、論点カタログに、元にした報告をこの識別子で書く。
- **時点の操作**: どの操作が実行されたかは、次の時点の `outcome` から読む（出口と操作は 1 対 1。M2 の設計 2.2）。同じ出口が続く遷移は、同じ操作をもう一度実行したのか、何もしない遷移（`stutter`）なのかを区別しない。状態変数の値が同じなら、どちらでも結果は変わらない。
- **並び**: `findings` は検査の順（2.2）、同じ検査の中では操作の識別子の順に並べる。

### 4.3 元の記録の扱い
- `SolverReport` は**元の記録**である。見つかったものを要約・省略しない。要約は M4 が行う。
- 一度出した報告を書き換えない。検査し直した結果は、新しい報告として出す。
- 「指定のスコープの中で、行った検査について漏れなく」の約束は、この報告に課す。行っていない検査（不変条件違反、1 の 2 件目以降の反例）は、そのことを報告に書くことで、漏れと区別する。