# FormalTranspiler 基本設計書

本設計書は、形式仕様変換モジュールの仕様書（`02_formal_transpiler.spec.md`）に規定された、事実モデルから形式仕様正本（Alloy 6）への変換を、全体基本設計書（`system_solution.design.md`）の規約に準拠して**どのように技術的・構造的に実現するか（How）**を定義する。

---

## 1. アーキテクチャと全体設計制約の継承

### 1.1 全体設計制約の適用
- **配置場所**: `specula/src/core/formal_transpiler.ts`（ビルド後は `dist/` の JS）（Pure ESM, Target: ES2022+）。
- **Zero-I/O Core の遵守**: ファイルの読み書きをしない。`RawContextModel` を受け取り、Alloy 6 のソースを含む `FormalSpecification` か `AmbiguityReport` を返す。
- **依存方向の一方向性**: `src/ports/` と `src/types/` だけを参照する。LLM は `LanguageModelPort` 経由でだけ呼ぶ。
- **LLM の担当**: ドメインの語（表示名）を付けることと、曖昧性レポートの質問文だけ。状態・操作・条件の組み立てには使わない。

### 1.2 公開する関数
```typescript
transpileFormal(
  facts: RawContextModel,
  deps: { llm: LanguageModelPort },
  previous?: FormalSpecification | null,
): Promise<TranspilerResult>;
```
- `previous`（前版の正本）との差分は 2 回目以降の処理で、現在の範囲外である。初回は `null` で呼ぶ。`null` でないときも差分は作らず、`previousDiff` に「範囲外」と記録する（4 節）。

### 1.3 構成
```
[RawContextModel]
      │
      ▼
[ContractGuard]        ── 入力の契約を確かめる（破れていれば例外）
      │
      ▼
[StateBuilder]         ── 状態変数とその値の集合、初期値を決める
      │
      ▼
[PathTranslator]       ── スライスごとに、経路の順に条件と書き込みを訳す
      │
      ▼
[AmbiguityCollector]   ── 決められなかった箇所をすべて集める
      │          （1 件でもあれば AmbiguityReport を返して終わる）
      ▼
[AlloyPrinter]         ── 決まった順で Alloy 6 のソースを書き出す
      │
      ▼
[VocabularyLabeler]    ── LLM で表示名を付ける（ソースには入れない）
      │
      ▼
[FormalSpecification]
```

**Alloy の識別子は機械的に決める**（`v1`・`op1`・`c1` など、4.1）。ドメインの語は識別子に入れず、識別子から表示名への対応表（`labels`）として別に持つ。こうすると、Alloy のソースは LLM の結果によらず、同じ入力から必ず同じものになる。また、実装の識別子が公開識別子に出ないこと（仕様 3.3 の完全隠蔽性）も、LLM に届かないときを含めて常に守られる。

---

## 2. 状態の作り方（StateBuilder）

状態は、**状態変数の値**と、**直前の操作の結果（どの出口に至ったか）**の組である。前者は M1 の `STATE` と `STATE_WRITE`、後者はスライスの `outlet` から作る。

### 2.1 状態変数
- `RawContextModel.units` の `STATE` ごとに、状態変数を 1 つ作る。
- 値の集合（ドメイン）は、その変数への `STATE_WRITE` の代入の式（`details.expression`）と、`STATE` の初期値（`details.initial`）から決める。

| 書き込みの式の形 | ドメイン | Alloy での表し方 |
| :-- | :-- | :-- |
| すべてが `true`・`false` のリテラル | 真偽値 | 自前の `abstract sig Bool`（`True`・`False`） |
| すべてが文字列・数値・`null`・`undefined` のリテラル | 列挙 | 値ごとに `one sig`（`v1_1`・`v1_2` …） |
| `x++`・`x--`・`x += <整数リテラル>`・`x = x + <整数リテラル>`（`-` も同じ） | 整数 | `Int`（`plus`・`minus`） |
| 上のどれにも当たらない式（関数の戻り値、ほかの変数、オブジェクトなど） | 決められない | `UNDETERMINED_VALUE` として曖昧性に記録する（5 節） |

- 状態変数は、`one sig System` の可変のフィールドとして置く（`var v1: one Bool`、`var v2: one V2`、`var v3: one Int`。`V2` は列挙の値の `abstract sig`）。M3 は `System.v1` の形で値を参照する。
- 列挙と整数が混ざる変数（例: `x = 0` と `x++`）は整数とする。真偽値と列挙が混ざる変数は列挙とする。
- 初期値がリテラルでないとき（引数で受け取ったオブジェクトのプロパティなど）は、初期値を決めない。列挙と真偽値ではドメインに値 `v<n>_unknown`（初期値として置く、書き込みでは現れない値）を足し、整数では初期値を制約しない。初期値をどれかの値に決め打ちしない。
- 書き込みのない `STATE`（読むだけの変数）は、初期値から変わらない変数として作る。
- データベースへの変更（`DATA_MUTATION`）は、現在の範囲では状態変数にしない。データベースの中身を値の集合として表すには、スキーマから値の区分を決める規則が別に要るためである。経路にある `DATA_MUTATION` は、`sourceMap` で操作に結び付けて残し、M5 が「状態として検証していない変更」として表示する。

### 2.2 操作の結果
- `one sig System` に `var outcome: one Outcome` を置く。`Outcome` の値は、初期の `Idle` と、スライスごとの出口（`o1`・`o2` …）である。
- 出口の種類（`RETURN`・`THROW`・`RESPONSE`・`ASYNC_CUT`）は `operations` に記録し、M3 と M4 が使う。

### 2.3 環境が決める条件（命題）
- 状態変数で表せない条件（関数の戻り値、引数の値、外部パッケージの結果など）は、**その時点で環境が自由に決める命題**として表す。
- `abstract sig Prop {}` の下に、命題ごとに `one sig c1 extends Prop {}` を置き、`one sig Env { var holds: set Prop }` とする。`Env.holds` に制約を置かないので、各時点でどの命題が成り立つ組み合わせも探索される。
- 命題は出現ごとに別にする（識別子は条件のユニットの識別子と、式の中の位置から作る）。同じ式でも、途中で状態が変わりうるためである。これにより、表せない部分はすべての可能性を含む（取りこぼさない）形で扱う。

---

## 3. 経路の訳し方（PathTranslator）

### 3.1 スライスから述語へ
スライス 1 つにつき、述語を 1 つ作る（`pred op1 {}` …）。M1 のスライスは出口ごとに 1 つなので、述語の数はスライスの数と同じになり、分岐の組み合わせで増えない。

述語の中身は、スライスの `unitIds` を**経路の順**にたどって作る。

1. **条件**（`conditions` の各項目）: その時点での状態変数の値に対する式に訳し、`holds` が `false` なら否定する。
2. **書き込み**（`STATE_WRITE`）: その時点の値を更新する。書き込みに `details.guard`（出口に至らない分岐の中の書き込み）があるときは、`guard implies 新しい値 else いまの値` の形で更新する。
3. **出口**: `System.outcome' = o<n>`。
4. **フレーム条件**: 経路で書き込まれなかった状態変数は `x' = x` とする。

同じ変数への複数の書き込みは、経路の順に合成する（Alloy の `条件 => 値 else 値` の式を重ねる）。条件は、それより前の書き込みを反映した値に対して評価する。

**実行できる条件の述語**: 述語ごとに、条件（1）だけを集めた述語 `pred op1_guard {}` を別に作る。条件は、それより前の書き込みを合成した式で書くので、その時点の状態と `Env.holds` だけで書け、プライム（次の時点の値）を含まない。操作の述語は `pred op1 { op1_guard and <書き込み・出口・フレーム条件> }` とする。M3 は、この述語を使って未定義遷移・操作の重なり・デッドロックの検査を組み立てる（M3 の設計 2.2）。

### 3.2 条件の式の訳し方
条件の式（原文）は `@babel/parser` の `parseExpression` で構文木にしてから訳す。

| 式 | 訳し方 |
| :-- | :-- |
| 状態変数の名前（`flag`・`this.flag`・`obj.flag`。M1 の `STATE` の名前と一致するもの） | その時点の値（真偽値なら `= True`） |
| 状態変数とリテラルの比較（`===`・`==`・`!==`・`!=`） | 値の等号・不等号 |
| 整数の状態変数とリテラルの大小（`<`・`<=`・`>`・`>=`） | `lt`・`lte`・`gt`・`gte` |
| `!`・`&&`・`\|\|`・かっこ | `not`・`and`・`or` |
| 上のどれにも当たらない部分式 | 命題（2.3）。部分式ごとに置き換え、訳せる部分は訳す |

`switch` の各 `case` は、M1 が条件の式（`<対象> === <case の値>`）として渡す前提で、同じ規則で訳す。

### 3.3 全体の述語
```alloy
fact Init { System.outcome = Idle  -- 状態変数の初期値（決まっているものだけ）
}
pred stutter { -- すべての状態変数と outcome が変わらない
}
fact Steps { always (op1 or op2 or ... or stutter) }
```
業務上の不変条件（`fact`）と、守るべき性質（`assert`）は、初回は作らない。これらは人が論点に判断を下した後（2 回目以降）に足すものであり、初回にコードから推測して作ると、実装をそのまま正しいとみなすことになるためである。検査のコマンドは M3 が組み立てる。

---

## 4. 出力（AlloyPrinter と VocabularyLabeler）

### 4.1 識別子と並び
- 識別子は、M1 のユニットの並び（ファイル → 行 → 列 → 種類）に従って番号を振る。状態変数は `v<n>`、列挙の値は `v<n>_<m>`、命題は `c<n>`、述語は `op<n>`、出口は `o<n>`（スライスの並び順）。
- ソースは、モジュール宣言 → `Bool` → 値の `sig` → `Prop` → `Outcome` → `System`・`Env` → `Init` → 述語（番号順。各操作の `op<n>_guard` の直後に `op<n>`）→ `stutter` → `Steps` の順に書く。同じ入力からは 1 バイトも違わないソースになる。
- 各要素の直上に、元のユニットの識別子を `-- @source: <ユニットの識別子>` として書く（仕様 3.3 のトレーサビリティ）。射影と論点カタログでは取り除く。

### 4.2 表示名（VocabularyLabeler）
- シナリオごとに LLM を 1 回呼ぶ（`task: "m2.label-vocabulary"`）。入力は、識別子ごとの種類・実装上の名前・条件や代入の式の原文。出力は、識別子から表示名への JSON のオブジェクト。
- 出力の検査: すべての識別子に表示名があり、各表示名が 1 行で 40 文字以内であること。合わなければ `INVALID_OUTPUT` として、すべての表示名を未生成にする。
- 届かないときや検査に通らないときは、`labels` の各項目を `NOT_GENERATED` にする。識別子は機械的なので、ソースはそのまま使える。表示名を実装の名前で埋めない。

### 4.3 型
```typescript
interface FormalSpecification {
  scenarioId: string;
  source: string;                                  // Alloy 6 のソース
  stateVariables: Array<{
    id: string;                                    // "v1"
    unitId: string;                                // M1 の STATE の識別子
    domain: "BOOL" | "ENUM" | "INT";
    values: string[];                              // ENUM の値の識別子（BOOL・INT は空）
    initial: string | null;                        // 初期値の識別子か整数。決まらなければ null
  }>;
  propositions: Array<{ id: string; unitId: string; expression: string }>;
  operations: Array<{
    id: string;                                    // "op1"
    sliceId: string;
    outcome: string;                               // "o1"
    outletKind: "RETURN" | "THROW" | "RESPONSE" | "ASYNC_CUT";
    guardPredicate: string;                        // "op1_guard"（3.1）
    steps: OperationStep[];                        // 経路の順の条件と書き込み（3.1。M5 が表示する）
    dataMutations: string[];                       // 経路にある DATA_MUTATION のユニットの識別子（2.1。経路の順）
  }>;
  sourceMap: Record<string, string[]>;             // Alloy の識別子 → ユニットの識別子
  labels: Record<string, LlmText>;                 // Alloy の識別子 → 表示名
  previousDiff: { status: "NOT_COMPUTED"; reason: "FIRST_RUN" | "OUT_OF_SCOPE" };
}

// 条件の式を訳した結果（3.2）。変数は、その時点の値（それより前の書き込みを反映した値）を指す
type GuardExpr =
  | { op: "PROP"; prop: string }                                      // 命題（"c1"）
  | { op: "IS"; variable: string; value: string }                     // 真偽値・列挙の値（"True"・"v1_2"）
  | { op: "CMP"; variable: string; cmp: "eq" | "neq" | "lt" | "lte" | "gt" | "gte"; value: number } // 整数
  | { op: "NOT"; arg: GuardExpr }
  | { op: "AND" | "OR"; args: GuardExpr[] };

type OperationStep =
  | { kind: "CONDITION"; unitId: string; expr: GuardExpr; holds: boolean }
  | {
      kind: "WRITE";
      unitId: string;
      variable: string;                                               // "v1"
      change: { op: "SET"; value: string | number } | { op: "ADD"; amount: number }; // ADD は負の数で減らす
      when: GuardExpr | null;                                         // details.guard があるときの書き込みの条件
    };

type TranspilerResult =
  | { kind: "SPEC"; spec: FormalSpecification }
  | { kind: "AMBIGUITY"; report: AmbiguityReport };
```
- 既存の型からの変更: `isSound` を外した（検証していない段で健全かどうかは言えない）。`signatures`・`predicates`・`assertions` を、M3 と M4 が使う `stateVariables`・`propositions`・`operations` に置き換えた。`sourceCode` を `source` にした。
- `steps` と `dataMutations` は、M5 が操作の中身を表示するために持つ。M5 が Alloy のソースを読み直さずに済むよう、PathTranslator が訳した結果をそのまま構造で残す。`steps` は Alloy のソースの述語と同じ内容を持つので、どちらも同じ訳し方（3.1・3.2）から作る。`!==`・`!=` の比較は、真偽値と列挙では `NOT` と `IS` の組、整数では `CMP` の `neq` とする。

---

## 5. 曖昧性の検知（AmbiguityCollector）

状態を決められない箇所を、**すべて**集めてから返す（最初の 1 件で止めない）。1 件でもあれば、Alloy のソースは作らずに `AmbiguityReport` を返し、そのシナリオは M3 に進まない。

| 種類 | 起きる条件 | 人に確かめること |
| :-- | :-- | :-- |
| `UNDETERMINED_VALUE` | 状態変数への書き込みの式が、2.1 の表のどの形にも当たらない | その変数がとりうる値（業務上の区分） |
| `EXTERNAL_EFFECT` | 経路にある `EXTERNAL_CALL`・`RECURSION` の引数に、状態変数、それを持つオブジェクト、`this`、関数のいずれかが渡されている | その呼び出しが状態を変えるかどうか |
| `CONFLICTING_SLICES` | 条件の組（ユニットと側）が同じなのに、出口が違うスライスが 2 つ以上ある | M1 が区別できなかった条件（実装を読み直す） |

- 外部の呼び出しの戻り値は、命題（2.3）として扱うので曖昧性にしない。状態を渡していない外部の呼び出しは、状態を変えないものとして扱う。経路で追跡しているのは、関数の外の変数・クラスのフィールド・引数のプロパティだけであり、渡されていないものに外部のコードは触れられないためである。
- 次は M1 の契約違反であり、曖昧性ではなく例外（`TranspileContractError`）にする: スライスが 0 個、`STATE_WRITE` に代入の式が無い、`unitIds` に存在しないユニットがある。オーケストレーターはこれを「M2 で止まった」と理由付きで報告に残す。

```typescript
interface AmbiguityIssue {
  kind: "UNDETERMINED_VALUE" | "EXTERNAL_EFFECT" | "CONFLICTING_SLICES";
  unitIds: string[];
  location: SourceLocation;
  detail: string;                 // 式や呼び出しの原文
  question: LlmText;              // 人への質問の文（LLM。task: "m2.ambiguity-question"）
}

interface AmbiguityReport {
  scenarioId: string;
  issues: AmbiguityIssue[];       // ユニットの並び順
  counts: Record<AmbiguityIssue["kind"], number>;
}
```
- 種類・ユニット・所在・原文は決定論的に決める。質問の文だけを LLM で作り、届かなければ `NOT_GENERATED` とする。
- オーケストレーターは、全シナリオの `counts` を合計して実行の報告に出す（全体設計 2 節）。件数が多いときに優先度で畳むのは、将来の課題である。