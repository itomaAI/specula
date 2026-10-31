# FormalTranspiler 基本設計書

本設計書は、形式仕様変換モジュールの仕様書（`formal_transpiler.spec.md`）に規定された、事実モデルから形式仕様正本（Alloy 6）への変換を、全体基本設計書（`system_solution.design.md`）の規約に準拠して**どのように技術的・構造的に実現するか（How）**を定義する。

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
  deps: { llm?: LanguageModelPort },
  previous?: FormalSpecification | null,
): Promise<TranspilerResult>;
```
- `deps.llm` は省略できる。省略したときは、表示名と質問の文をすべて `NOT_GENERATED`（理由 `UNREACHABLE`、detail「LLM のポートが渡されていない」）にする（CommandExtractor と同じ扱い）。ソースは LLM によらないので、そのまま作る。
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

状態は、**状態変数の値**と、**直前の操作の結果（どの出口に至ったか）**の組である。前者は ContextExtractor の `STATE` と `STATE_WRITE`、後者はスライスの `outlet` から作る。

### 2.1 状態変数
- `RawContextModel.units` の `STATE` ごとに、状態変数を 1 つ作る。
- 値の集合（ドメイン）は、その変数への `STATE_WRITE` の代入の式（`details.expression`）と、`STATE` の初期値（`details.initial`）から決める。

| 書き込みの式の形 | ドメイン | Alloy での表し方 |
| :-- | :-- | :-- |
| すべてが `true`・`false` のリテラル | 真偽値 | 自前の `abstract sig Bool`（`True`・`False`） |
| すべてが文字列・数値・`null`・`undefined` のリテラル | 列挙 | 値ごとに `one sig`（`v1_1`・`v1_2` …） |
| `x++`・`x--`・`x += <整数リテラル>`・`x = x + <整数リテラル>`（`-` も同じ） | 整数 | `Int`（`plus`・`minus`） |
| 上のどれにも当たらない式（関数の戻り値、ほかの変数、オブジェクトなど） | 決められない | `UNDETERMINED_VALUE` として曖昧性に記録する（5 節） |

- 状態変数は、`one sig System` の可変のフィールドとして置く（`var v1: one Bool`、`var v2: one V2`、`var v3: one Int`。`V2` は列挙の値の `abstract sig`）。FormalSolver は `System.v1` の形で値を参照する。
- 列挙と整数が混ざる変数（例: `x = 0` と `x++`）は整数とする。真偽値と列挙が混ざる変数は列挙とする。
- 初期値がリテラルでないとき（引数で受け取ったオブジェクトのプロパティなど）は、初期値を決めない。列挙ではドメインに値 `v<n>_unknown`（初期値として置く、書き込みでは現れない値）を足す。真偽値と整数では値を足さず、初期値を制約しない（真偽値は 2 値なので、制約しなければすべての場合を含む）。初期値をどれかの値に決め打ちしない。
- 値の並び: 列挙の値の識別子は、初期値 → 書き込みの順に、初めて出てきた順に振る。最上位の `let` で初期値が無いときは、初期値を `undefined` のリテラルとする。
- 書き込みのない `STATE`（読むだけの変数）は、初期値から変わらない変数として作る。
- データベースへの変更（`DATA_MUTATION`）は、現在の範囲では状態変数にしない。データベースの中身を値の集合として表すには、スキーマから値の区分を決める規則が別に要るためである。経路にある `DATA_MUTATION` は、`sourceMap` で操作に結び付けて残し、SpecProjector が「状態として検証していない変更」として表示する。

### 2.2 操作の結果
- `one sig System` に `var outcome: one Outcome` を置く。`Outcome` の値は、初期の `Idle` と、スライスごとの出口（`o1`・`o2` …）である。
- 出口の種類（`RETURN`・`THROW`・`RESPONSE`・`ASYNC_CUT`）は `operations` に記録し、FormalSolver と LedgerSynthesizer が使う。

### 2.3 環境が決める条件（命題）
- 状態変数で表せない条件（関数の戻り値、引数の値、外部パッケージの結果など）は、**その時点で環境が自由に決める命題**として表す。
- `abstract sig Prop {}` の下に、命題ごとに `one sig c1 extends Prop {}` を置き、`one sig Env { var holds: set Prop }` とする。`Env.holds` に制約を置かないので、各時点でどの命題が成り立つ組み合わせも探索される。
- 命題は出現ごとに別にする（識別子は条件のユニットの識別子と、式の中の位置から作る）。同じ式でも、途中で状態が変わりうるためである。これにより、表せない部分はすべての可能性を含む（取りこぼさない）形で扱う。

---

## 3. 経路の訳し方（PathTranslator）

### 3.1 スライスから述語へ
スライス 1 つにつき、述語を 1 つ作る（`pred op1 {}` …）。ContextExtractor のスライスは出口ごとに 1 つなので、述語の数はスライスの数と同じになり、分岐の組み合わせで増えない。

述語の中身は、スライスの `unitIds` を**経路の順**にたどって作る。

1. **条件**（`conditions` の各項目）: その時点での状態変数の値に対する式に訳し、`holds` が `false` なら否定する。条件は、その条件のユニットが経路に出てきた位置に置く。ContextExtractor の `unitIds` は重複しないので、1 つの条件のユニットが両方の側で `conditions` に出てくるスライス（ループに入って抜けるなど）では、最初の側をユニットの位置に置き、残りの側を出口の前に置く。経路に出てこなかった条件も出口の前に置く。
2. **書き込み**（`STATE_WRITE`）: その時点の値を更新する。書き込みの条件は ContextExtractor の `details.guardTerms`（条件のユニットと側の組）から作る。`guardTerms` には経路の条件（早く抜ける `if` の偽の側など）も入っているので、経路の上でその書き込みより前に同じ側の条件を置いた項は除く（操作の guard が要求しているため）。残った項があれば、`(条件) => 新しい値 else いまの値` の形で更新する。
3. **出口**: `System.outcome' = o<n>`。
4. **フレーム条件**: 経路で書き込まれなかった状態変数は `x' = x` とする。

同じ変数への複数の書き込みは、経路の順に合成する（Alloy の `条件 => 値 else 値` の式を重ねる）。経路の条件（1）は、それより前の書き込みを反映した値に対して評価する。書き込みの条件（2）の各項は、**その条件のユニットを持つ最初の書き込みの直前の値**で評価する。両側とも続く枝では ContextExtractor が条件のユニットを経路から落とすので、条件を評価した位置が経路に残らない。枝の条件は枝の中のどの書き込みよりも前に評価されるので、その項を持つ最初の書き込みの直前が、評価した時点の値になる（`if (n < 3) { n++; n++; }` の 2 度目の書き込みの条件を、1 度目の書き込みの後の値で評価しない）。

限界: 条件の式の中で状態変数を書き換えるとき（`if (n++ > 0)`）は、評価の時点がずれうる。ループの本体は 1 回分だけを表す（ContextExtractor の初回の範囲と同じ）。

**実行できる条件の述語**: 述語ごとに、条件（1）だけを集めた述語 `pred op1_guard {}` を別に作る。条件は、それより前の書き込みを合成した式で書くので、その時点の状態と `Env.holds` だけで書け、プライム（次の時点の値）を含まない。操作の述語は `pred op1 { op1_guard and <書き込み・出口・フレーム条件> }` とする。FormalSolver は、この述語を使って未定義遷移・操作の重なり・デッドロックの検査を組み立てる（FormalSolver の設計 2.2）。

### 3.2 条件の式の訳し方
条件の式（原文）は `@babel/parser` の `parseExpression` で構文木にしてから訳す。

| 式 | 訳し方 |
| :-- | :-- |
| 状態変数の名前（`flag`・`this.flag`・`obj.flag`。ContextExtractor の `STATE` の名前と一致するもの） | その時点の値（真偽値なら `= True`） |
| 状態変数とリテラルの比較（`===`・`==`・`!==`・`!=`） | 値の等号・不等号 |
| 整数の状態変数とリテラルの大小（`<`・`<=`・`>`・`>=`） | `lt`・`lte`・`gt`・`gte` |
| `!`・`&&`・`\|\|`・かっこ | `not`・`and`・`or` |
| 上のどれにも当たらない部分式 | 命題（2.3）。部分式ごとに置き換え、訳せる部分は訳す |

`switch` の各 `case` は、ContextExtractor が条件の式（`<対象> === <case の値>`）として渡す前提で、同じ規則で訳す。

次の条件は、式全体を 1 つの命題にする: `for…of`・`for…in` の条件（繰り返す対象の式で、真偽ではない）、`catch` の条件（式は `"catch"`）、構文木にできない式。条件のユニットは、ユニットの並び順に 1 度だけ訳して使い回す（命題の番号を入力だけで決めるため。同じ条件のユニットを複数のスライスや書き込みが指しても、同じ命題になる）。

### 3.3 全体の述語
```alloy
fact Init { System.outcome = Idle  -- 状態変数の初期値（決まっているものだけ）
}
pred stutter { -- すべての状態変数と outcome が変わらない
}
fact Steps { always (op1 or op2 or ... or stutter) }
```
業務上の不変条件（`fact`）と、守るべき性質（`assert`）は、初回は作らない。これらは人が論点に判断を下した後（2 回目以降）に足すものであり、初回にコードから推測して作ると、実装をそのまま正しいとみなすことになるためである。検査のコマンドは FormalSolver が組み立てる。

---

## 4. 出力（AlloyPrinter と VocabularyLabeler）

### 4.1 識別子と並び
- 識別子は、ContextExtractor のユニットの並び（ファイル → 行 → 列 → 種類）に従って番号を振る。状態変数は `v<n>`、列挙の値は `v<n>_<m>`、命題は `c<n>`、述語は `op<n>`、出口は `o<n>`（スライスの並び順）。
- ソースは、モジュール宣言 → `Bool` → 値の `sig` → `Prop` → `Outcome` → `System`・`Env` → `Init` → 述語（番号順。各操作の `op<n>_guard` の直後に `op<n>`）→ `stutter` → `Steps` の順に書く。同じ入力からは 1 バイトも違わないソースになる。
- 各要素の直上に、元のユニットの識別子を `-- @source: <ユニットの識別子>` として書く（仕様 3.3 のトレーサビリティ）。複数あれば空白で区切る（`op<n>` はスライスの `unitIds`、`op<n>_guard` は条件のユニット）。`sourceMap` も同じユニットを持つ。射影と論点カタログでは取り除く。
- モジュール名は `specula_m2`。`Bool` と `Prop` は、使われていなくても必ず宣言する（ソースの形を入力によらず一定にするため）。
- 命題が 1 つも無いときは、`Prop` の宣言の直後に `fact NoProp { no Prop }` を書く。子の無い abstract sig は空に制約されないため、書かないとエンジンが `Env.holds` に名前の無い原子を入れる（FormalSolver の結合テストで確かめた）。
- 真と偽の定数は `(no none)` と `(some none)` と書く（AND の引数が空なら真、OR の引数が空なら偽）。負の整数はリテラル（`-8`）で書く。`minus[0, n]` は、いちばん小さい整数（4 Int なら -8）で範囲の外の `8` を使うので、FormalSolver があふれを禁じて走ると充足できなくなる（FormalSolver の結合テストで確かめた）。リテラルは、あふれを許しても禁じても正しい値になる。

### 4.2 表示名（VocabularyLabeler）
- シナリオごとに LLM を 1 回呼ぶ（`task: "m2.label-vocabulary"`）。入力は、識別子ごとの種類・実装上の名前・条件や代入の式の原文。出力は、識別子から表示名への JSON のオブジェクト。
- 出力の検査: すべての識別子に表示名があり、各表示名が 1 行で 40 文字以内であること。合わなければ `INVALID_OUTPUT` として、すべての表示名を未生成にする。
- 届かないときや検査に通らないときは、`labels` の各項目を `NOT_GENERATED` にする。識別子は機械的なので、ソースはそのまま使える。表示名を実装の名前で埋めない。
- 曖昧性の質問の文（5 節）も、シナリオごとに 1 回で全部の論点の分を頼む（`task: "m2.ambiguity-question"`）。出力は論点の番号から質問の文への JSON のオブジェクトで、検査は「すべての論点に文があり、各文が 1 行で 200 文字以内」。1 つでも欠ければ、すべての質問の文を未生成にする。論点ごとに呼ぶと、論点の数だけ LLM を呼ぶことになるためである。
- 質問の文の検査（2026-10-30 に足した）: 質問の文は利用者向けの表示（曖昧さの一覧）にそのまま出るので、実装の名前が入っていたら `INVALID_OUTPUT` にし、上と同じくすべての質問の文を未生成にする（全体設計 2.2）。照合する名前は、そのシナリオの `RawContextModel` から機械的に集める: 起点の `handler` のファイルのパスと関数名、ユニットの所在のファイルのパス（パス全体と、最後の `/` より後ろのファイル名）、`componentScope`、`details` の文字列の値のうち識別子の形（英字か `_`・`$` で始まり、英数字と `_`・`$` だけ）のもの。
  - 照合は大文字小文字を区別し、識別子は前後が英数字・`_`・`$` でないときだけ当たりとする（`status` は `statusCode` の一部としては当たらない）。2 文字以下の名前は照合しない（`id`・`ok` のような語が、ふつうの文に出るため）。
  - 辞書（`Glossary`）は受け取らない。辞書を受け取るのは SpecProjector だけとしたためである（全体設計 2）。辞書にしか無い名前（スキーマの項目など）が質問の文に入る可能性は残る。これは、実装のあとに specula 自身にかけたときの件数を見てから扱いを決める。
  - 指示の文にも「ファイル名・関数名・変数名などの実装の名前とコードの断片を書かず、業務の言葉で問う」を足す。指示を変えるので `M2_PROMPT_VERSION` を `"2"` に上げる（それまでの記録は使わない）。
- LLM の出力が ```` ```json ```` の囲みで返ってきたときは、囲みを外して読む。プロンプトの版は `M2_PROMPT_VERSION`（いまは `"1"`）。指示の文を変えたら版を上げる。

### 4.3 型
```typescript
interface FormalSpecification {
  commandId: string;
  source: string;                                  // Alloy 6 のソース
  stateVariables: Array<{
    id: string;                                    // "v1"
    unitId: string;                                // ContextExtractor の STATE の識別子
    name: string;                                  // 実装上の名前（STATE の name。SpecProjector の実装との対応表が使う。LLM の入力には入れない）
    domain: "BOOL" | "ENUM" | "INT";
    values: string[];                              // ENUM の値の識別子（BOOL・INT は空）
    valueLiterals: Record<string, string>;         // ENUM の値の識別子 → リテラルの原文（SpecProjector の表示用）
    initial: string | null;                        // 初期値の識別子か整数。決まらなければ null
  }>;
  propositions: Array<{ id: string; unitId: string; expression: string }>;
  operations: Array<{
    id: string;                                    // "op1"
    sliceId: string;
    outcome: string;                               // "o1"
    outletKind: "RETURN" | "THROW" | "RESPONSE" | "ASYNC_CUT";
    guardPredicate: string;                        // "op1_guard"（3.1）
    steps: OperationStep[];                        // 経路の順の条件と書き込み（3.1。SpecProjector が表示する）
    dataMutations: string[];                       // 経路にある DATA_MUTATION のユニットの識別子（2.1。経路の順）
  }>;
  sourceMap: Record<string, string[]>;             // Alloy の識別子 → ユニットの識別子
  labels: Record<string, LlmText>;                 // Alloy の識別子 → 表示名
  labelStatus: Record<string, ConfirmationStatus>; // labels と同じキー。表示名の確定の状態（6 節）
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
      when: WriteCondition[];                                         // 書き込みの条件（項の AND。3.1 の 2。空なら条件なし）
    };

interface WriteCondition {
  unitId: string;                                                     // 条件のユニット（BRANCH_CONDITION）
  holds: boolean;
  expr: GuardExpr;                                                    // その項を持つ最初の書き込みの直前の値で評価する
}

type TranspilerResult =
  | { kind: "SPEC"; spec: FormalSpecification }
  | { kind: "AMBIGUITY"; report: AmbiguityReport };
```
- 既存の型からの変更: `isSound` を外した（検証していない段で健全かどうかは言えない）。`signatures`・`predicates`・`assertions` を、FormalSolver と LedgerSynthesizer が使う `stateVariables`・`propositions`・`operations` に置き換えた。`sourceCode` を `source` にした。
- `steps` と `dataMutations` は、SpecProjector が操作の中身を表示するために持つ。SpecProjector が Alloy のソースを読み直さずに済むよう、PathTranslator が訳した結果をそのまま構造で残す。`steps` は Alloy のソースの述語と同じ内容を持つので、どちらも同じ訳し方（3.1・3.2）から作る。真偽値と列挙の状態変数とリテラルの比較（`===`・`==`・`!==`・`!=`）は、ドメインの値ごとに JavaScript の意味で評価し、成り立つ値の `IS` の `OR` とする（`!==` も同じ。`NOT` と `IS` の組と同じ意味で、値ごとの評価に 1 本化した）。列挙で初期値が決まらない値 `v<n>_unknown` については、その値のとき比較が成り立つかを命題にし、`AND(IS v<n>_unknown, 命題)` を `OR` に足す（推測しない）。整数では `CMP` の `eq`・`neq` とし、整数と整数でない値の比較は命題にする。
- `stateVariables` の `name` は 2026-10-30 に足した。SpecProjector の実装との対応表（SpecProjector の設計 5・8.5）が状態変数の実装上の名前を出すためである。名前は StateBuilder が状態変数を作るときに STATE のユニットから写す。SpecProjector が ContextExtractor の出力を読まずに済むので、モジュールどうしの依存を増やさない。質問の文の入力と LedgerSynthesizer の語彙には入れない（4.2 の「実装の名前を問いに書かない」を守るため）。表示名を付ける入力（`m2.label-vocabulary`）は、表示名を決めるのに実装の名前が要るので、これまでどおり STATE のユニットの name を渡している（この変更で入力は変わらない）。

---

## 5. 曖昧性の検知（AmbiguityCollector）

状態を決められない箇所を、**すべて**集めてから返す（最初の 1 件で止めない）。1 件でもあれば、Alloy のソースは作らずに `AmbiguityReport` を返し、そのシナリオは FormalSolver に進まない。

| 種類 | 起きる条件 | 人に確かめること |
| :-- | :-- | :-- |
| `UNDETERMINED_VALUE` | 状態変数への書き込みの式が、2.1 の表のどの形にも当たらない | その変数がとりうる値（業務上の区分） |
| `EXTERNAL_EFFECT` | 経路にある `EXTERNAL_CALL`・`RECURSION` の引数か受け手（`receiver`。`a.push(x)` の `a`）に、状態変数、それを持つオブジェクト、`this`、関数のいずれかがある。ただし、呼び先が状態を変えない組み込みのメソッドのときは、表の下の規則で判定する | その呼び出しが状態を変えるかどうか |
| `CONFLICTING_SLICES` | 条件の組（ユニットと側）が同じなのに、出口が違うスライスが 2 つ以上ある | ContextExtractor が区別できなかった条件（実装を読み直す） |

- 外部の呼び出しの戻り値は、命題（2.3）として扱うので曖昧性にしない。状態を渡していない外部の呼び出しは、状態を変えないものとして扱う。経路で追跡しているのは、関数の外の変数・クラスのフィールド・引数のプロパティだけであり、渡されていないものに外部のコードは触れられないためである。
- 呼び先が状態を変えない組み込みのメソッドのときは、次の規則で判定する（2026-10-30 に決めた。specula 自身にかけたとき、ローカルの配列への `value.map((x) => …)` のような呼び出しが、関数を渡しているという理由だけで当たっていたため）。
  - 受け手は、参照だけを見る。状態変数、それを持つオブジェクト、`this` のどれかがあれば当たりとする。受け手の中の関数（`a.map((x) => …).join(",")` の `(x) => …`）は、それを受け取った呼び出し（`a.map(…)`）のユニットが判定するので、ここでは見ない。
  - 引数にその場で書いた関数（アロー関数・関数式）があれば、その本体を見る。本体が状態変数か `this` を参照するとき、または本体の中に、状態を変えない組み込みのメソッドではない呼び出しがあるときは、当たりとする。ContextExtractor はコールバックの中に入らないため、本体の中の呼び出しは経路に出てこない。そこで慎重側に倒す。その場で書いた関数ではない引数は、これまでどおり見る（引数の式の奥にある関数は、本体を見ずに当たりとする）。
  - 受け手に状態変数か `this` があれば、名前が一覧にあっても当たりのままとする。独自のクラスが同じ名前のメソッドを持つことがあるためである。
- 状態を変えない組み込みのメソッドの一覧（`src/core/m2/pure_calls.ts`）:
  - 配列: `map`・`filter`・`reduce`・`reduceRight`・`slice`・`concat`・`join`・`some`・`every`・`find`・`findIndex`・`findLast`・`findLastIndex`・`indexOf`・`lastIndexOf`・`includes`・`flat`・`flatMap`・`at`・`entries`・`keys`・`values`・`forEach`・`toSorted`・`toReversed`・`toSpliced`・`with`
  - 文字列: `trim`・`trimStart`・`trimEnd`・`toLowerCase`・`toUpperCase`・`split`・`replace`・`replaceAll`・`startsWith`・`endsWith`・`padStart`・`padEnd`・`charAt`・`charCodeAt`・`codePointAt`・`substring`・`localeCompare`・`normalize`・`repeat`・`match`・`matchAll`・`search`・`toString`
  - `Map`・`Set`: `get`・`has`
  - 静的なメソッド: `Object.keys`・`Object.values`・`Object.entries`・`Array.isArray`・`Array.from`・`JSON.stringify`・`JSON.parse`・`Math` のすべて・`Number.isInteger`・`Number.isFinite`・`Number.isNaN`
  - 大域の関数: `String`・`Number`・`Boolean`・`parseInt`・`parseFloat`
  - 一覧に入れないもの: `sort`・`reverse`・`push`・`splice`・`set`・`add`・`delete`・`Object.assign`・`Object.freeze` など、受け手か引数を変えるもの。
- 呼び先は名前だけで照合する。メソッドは `callee` の原文の最後のプロパティの名前で、静的なメソッドと大域の関数は `callee` の原文全体で照合する。
- 限界: 型を見ないので、一覧と同じ名前を持つ独自のメソッドを、受け手が状態に関係しないときは状態を変えないものとして扱う。名前で渡した関数（`arr.map(toItem)`）の本体は、これまでどおり見ない（関数の名前そのものが状態変数でなければ当たらない）。
- 次は ContextExtractor の契約違反であり、曖昧性ではなく例外（`TranspileContractError`）にする: スライスが 0 個（`NO_SLICES`）、`STATE_WRITE` に代入の式が無い（`WRITE_WITHOUT_EXPRESSION`）、`unitIds` に存在しないユニットがある（`UNKNOWN_UNIT`）、`details` の形が合わない（`MALFORMED_DETAILS`。`STATE_WRITE` の `target` が `STATE` でない、`guardTerms` が無い・読めない・`BRANCH_CONDITION` でないユニットを指す、など）。オーケストレーターはこれを「FormalTranspiler で止まった」と理由付きで報告に残す。
- 論点の並び: ユニットの並び（ContextExtractor が並べ済み）→ 種類 → 原文。`CONFLICTING_SLICES` の `unitIds` は出口のユニットで、`detail` は「スライスの識別子（条件の組）」とする。

```typescript
interface AmbiguityIssue {
  kind: "UNDETERMINED_VALUE" | "EXTERNAL_EFFECT" | "CONFLICTING_SLICES";
  unitIds: string[];
  location: UnitLocation;         // 最初のユニットの所在（ContextExtractor のユニットの所在。列を含む。ContextExtractor のユニットに symbol が無いため）
  detail: string;                 // 式や呼び出しの原文
  question: LlmText;              // 人への質問の文（LLM。task: "m2.ambiguity-question"）
  questionStatus: ConfirmationStatus; // 質問の文の確定の状態（6 節）
}

interface AmbiguityReport {
  commandId: string;
  issues: AmbiguityIssue[];       // ユニットの並び順
  counts: Record<AmbiguityIssue["kind"], number>;
}
```
- 種類・ユニット・所在・原文は決定論的に決める。質問の文だけを LLM で作り、届かなければ `NOT_GENERATED` とする。
- オーケストレーターは、全シナリオの `counts` を合計して実行の報告に出す（全体設計 2 節）。件数が多いときに優先度で畳むのは、将来の課題である。

---

## 6. 画面の仕様に合わせて足したもの（2026-10-31）

仕様 2.2 の変更（表示名と質問の文に、その確定の状態を持たせる）を、次の形で実装した。確定の状態（`ConfirmationStatus`）の意味は SpecViewer の仕様 2.4 にあり、型は `src/types/index.ts` にある。実装は `src/types/formal.ts`・`src/core/formal_transpiler.ts`。

### 6.1 型に足すもの
```typescript
interface FormalSpecification {
  // …これまでの欄…
  labelStatus: Record<string, ConfirmationStatus>;  // labels と同じキー。各表示名の確定の状態
}

interface AmbiguityIssue {
  // …これまでの欄…
  questionStatus: ConfirmationStatus;               // 質問の文の確定の状態
}
```

### 6.2 決めたこと
- 状態は、文（`LlmText`）とは別の欄に持つ。仕様が「文と、その確定の状態」を出力に持つと書いているためである。GlossaryBuilder の `termStatus`、IntentSynthesizer の `intentStatus` と同じ形にそろえる。また、`CONFIRMED`・`NEEDS_RECHECK` は文から求められないので、確定の操作を足すときにはどのみち欄が要る。
- 確定の操作は現在の範囲に無いので、本モジュールが書くのは `NOT_GENERATED` と `CANDIDATE` だけである。文が `GENERATED` なら `CANDIDATE`、`NOT_GENERATED` なら `NOT_GENERATED` とする（GlossaryBuilder・IntentSynthesizer と同じ規則）。
- 状態は、表示名や質問の文を受け取った直後に、同じ関数で付ける。`labelStatus` のキーは `labels` のキーと必ず一致する。
- 採らなかった案: 欄を足さず、`LlmText` から状態を求める関数を後段と共有する案。今は文と状態がずれないが、出力の形が仕様と合わず、確定の操作を足すときに型を変えることになるため採らなかった。
- SpecProjector はまだこの欄を読まない。表示は SpecProjector の変更（画面の仕様に合わせる変更の次の段）で行う。