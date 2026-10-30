# ContextExtractor 基本設計書

本設計書は、実装事実抽出モジュールの仕様書（`context_extractor.spec.md`）に規定された多層システム事実抽出（UI・処理・バッチ・DBスキーマ）を、全体基本設計書（`system_solution.design.md`）の規約に準拠して**どのように技術的・構造的に実現するか（How）**を定義する。

---

## 1. アーキテクチャと全体設計制約の継承

### 1.1 全体設計制約の適用
- **配置場所**: `specula/src/core/context_extractor.ts`（ビルド後は `dist/` の JS）（Pure ESM, Target: ES2022+）。内部の部品は `src/core/m1/` に置く。
- **Zero-I/O Core の遵守**: 本モジュールは `node:fs` や `window.MetaOS.fs` を直接インポートしてはならない。ソースは `FileSystemPort` から読み取り専用で取得する（追跡で必要になったファイルだけを読む）。
- **依存方向の一方向性**: 本モジュールは `src/ports/` のインターフェースのみに依存し、`src/adapters/` の具象環境実装を一切参照しない。
- **LLM を使わない**: 事実の抽出はすべて AST から決定論的に行う。
- **パス**: `ScenarioTarget` のパスはリポジトリのルートからの相対パスである。本モジュールはこの相対パスをそのまま `FileSystemPort` に渡す。ルートを付け足すのは呼び出し元の責任とし、ポートだけを使う小さな包み `withRoot(fs, root)`（`src/lib/rooted_file_system.ts`）を用意する。

### 1.2 公開する関数
```typescript
extractContext(target: ScenarioTarget, deps: { fs: FileSystemPort }): Promise<RawContextModel>;
```

### 1.3 構成
起点から呼び出しをたどる `CallTracer` が中心にあり、たどり着いたファイルにだけ各層のアナライザーをかける。初回の実装で作ったのは CallTracer・LogicAnalyzer（API を除く）・SliceBuilder（因果接続を除く）である。作っていない部分は `RawContextModel.coverage` に理由つきで残す（2.6）。

```
[ScenarioTarget.inletTrigger.handler]
              │
              ▼
      [CallTracer]  ── 呼び出しをたどる（import を解決）
              │          追跡できない呼び出しは記録して止まる
              │          非同期境界は記録する（初回は出口にしない）
              ▼
 たどり着いた関数・ファイル
   ├─➔ [UIAnalyzer]       （readModel があるときだけ。初回は未実装）
   ├─➔ [LogicAnalyzer]    状態変数・分岐・出口・関数呼び出し（API は初回は未実装）
   ├─➔ [TriggerAnalyzer]  （初回は未実装）
   └─➔ [SchemaAnalyzer]   （データ変更が対象とするスキーマだけ。初回は未実装）
              │
              ▼
      [SliceBuilder]  ── 出口ごとにユースケーススライスを作る
              │
              ▼
      [RawContextModel]
```

| ファイル | 役割 |
| :-- | :-- |
| `src/types/context.ts` | 出力の型と、2 つの例外（`SyntaxExtractionError`・`InletNotFoundError`） |
| `src/core/m1/source_loader.ts` | ファイルの読み込み・パース・結果の使い回し、import の解決、原文の切り出し |
| `src/core/m1/locate.ts` | 起点の関数を見つけることと、呼び出し先を関数の定義まで解決すること |
| `src/core/m1/units.ts` | ユニットの登録（識別子・層・details）と状態変数の判定 |
| `src/core/m1/paths.ts` | 経路のたどり方、関数の要約、出口ごとの経路の組み立て |
| `src/core/context_extractor.ts` | `extractContext`。ユニットとスライスの並び、`unresolved`、`coverage` |

---

## 2. 各部の詳細設計 (Detailed Design)

構文解析はすべて `@babel/parser`（Plugins: `typescript`, `jsx`）で行う。外部バイナリやネイティブCLIを使わず、Node.js と Itera OS で同じに動く。AST の基本的な道具（子の列挙、識別子の名前、呼び出しの分類）は ScenarioExtractor のもの（`src/core/m0/ast.ts`・`signals.ts`）を使う。同じ規則を 2 か所に書かないためである。

### 2.1 CallTracer（呼び出しの追跡）
- **読み込み**: 追跡でたどり着いたファイルだけを `fs.read` で読み、パースした結果をその実行の中で使い回す。パースに失敗したら `SyntaxExtractionError`（ファイル・行・列・原因）を投げる。
- **起点**: `target.inletTrigger.handler`（ファイル・関数名・行）。そのファイルの次のものから、名前だけで探す（行は照合に使わない）。
  - 名前付きの最上位の関数（関数宣言と、関数を値に持つ `const`）。
  - `"default"`（`export default` の関数）。
  - `"クラス名.メソッド名"`（クラスのメソッド）。
  - 起点がポリシー（`inletType: "POLICY"`）のときは、handler の行にあるリスナーの登録（`on`・`addEventListener` など）の 2 番目の引数を解決し、その関数から追跡する。
  - 見つからないときは `InletNotFoundError` を投げる。別の関数を起点にしない。
- **たどる呼び出し**: 関数本体の呼び出し式のうち、呼び出し先を AST から関数の定義まで決められるものをたどり、`CALL` のユニットを作る。
  - 同じファイルで定義された関数。
  - 相対パスの `import` で取り込んだ関数（再公開と名前空間の import を含む）。相対パスは ScenarioExtractor の解決と同じ候補の順（`.ts`・`.tsx`・`.js`・`.jsx` など）で `fs.exists` を確かめて決める。
- **たどらない呼び出し**: 次は `EXTERNAL_CALL` として所在と理由（`details.reason`）を記録し、中へは入らない。追跡しなかった呼び出しは、すべてこのどれかになる。

| 理由 | 対象 |
| :-- | :-- |
| `PACKAGE` | 外部パッケージ（相対パスでない import）の関数 |
| `UNRESOLVED` | 引数で受け取った関数、入れ子の関数、名前から定義を決められないもの |
| `METHOD` | 値のメソッドの呼び出し（`arr.map(...)`、`list.push(...)` など） |
| `DYNAMIC` | 計算されたプロパティ名、動的 import |
| `CONSTRUCTOR` | `new` の式 |

- **入れ子の関数には入らない**: コールバックなどとして渡された関数の中はたどらない。その関数を受け取った呼び出しが `EXTERNAL_CALL` として残り、`args` に関数の原文が入るので、FormalTranspiler はそれを手がかりに扱いを決められる。入れ子の関数の中の書き込みが、実行されるか分からないまま経路に入るのを避けるためである。
- **再帰と重複**: 関数は `<ファイル>#<関数名>` で識別する。いま追跡している関数の並び（呼び出しの積み重ね）に同じ関数があれば、その場で `RECURSION` として記録して止まる。追跡した関数は 1 度だけ解析し、その要約（3.3）を使い回す。
- **非同期境界**: イベントの発行（`emit`・`dispatch`・`publish` など）を ScenarioExtractor と同じ規則（`classifyCall`）で見つけたら、`ASYNC_CUT` として記録し、受け手の処理へは入らない。初回の実装では `ASYNC_CUT` を出口にせず、経路の途中のユニットとして残す。メッセージキューや DB イベントトリガーの発火点の判定は、TriggerAnalyzer と合わせて後で足す。

### 2.2 UIAnalyzer (フロントエンド構文・視覚解析)
初回の実装では作っていない（2.6）。次の設計は、作るときの方針として残す。
- `target.readModel` があるときだけ、`readModel.entryFile` に対して動く。
- **AST トラバース規則**:
  - `VariableDeclarator`: `useState` および状態管理フックの呼び出しを走査し、変数名と初期値を `STATE` として抽出。
  - `FunctionDeclaration` / `ArrowFunctionExpression`: コンポーネント内の関数を走査。関数名、引数型、および関数内部で発火される API 呼び出し（`fetch`, `httpsCallable` 等）を `OPERATION` として抽出。
  - `JSXElement` / `JSXAttribute`: `label`, `title`, `placeholder` 属性および `JSXText` の文字列リテラルを `INTERFACE_TEXT` として抽出。
  - `ConditionalExpression` / `LogicalExpression` / `IfStatement`: 画面の条件付き描画ロジックを `BRANCH_CONDITION` として抽出。
- **コンポーネントスコープの保持**: 各要素の親コンポーネント名（関数名）を `componentScope` として付与し、同一ファイル内の複数コンポーネントの混同を防止する。

### 2.3 LogicAnalyzer（処理の解析）
CallTracer がたどった各関数に対して動く。画面を持たないシステムでは、これが中心の解析になる。
- **状態変数 (`STATE`)**: たどった関数の中で代入・`++`・`--` されるもののうち、次のもの。変更の箇所を `STATE_WRITE` として記録する。
  - 同じファイルの最上位の `let`・`var`。所在は宣言で、`details.initial` に初期値の式の原文を持つ。
  - `this.x`（クラスのメソッドの中）。所在は最初の書き込み。
  - 引数のプロパティ（`<引数名>.x`）。所在は引数。
  - 関数の中のローカル変数は状態にしない。メソッドの呼び出しによる変更（`list.push(...)` など）は、`EXTERNAL_CALL` の `receiver`（受け手の式）で残す。
- **分岐 (`BRANCH_CONDITION`)**: `if`・`switch` の各 `case`・ループ（`while`・`for`・`for…of`・`for…in`）・`try`/`catch`。条件の式は原文のまま持つ（意味づけしない）。式の中の短絡評価（`a && f()`）と三項演算子は、初回の実装では分岐として分けない。
- **出口**: `return`（`RETURN`）と `throw`（`THROW`）。関数の終わりまで来た経路には、関数の閉じかっこの位置に暗黙の `RETURN`（`details.implicit: true`）を置く。呼び出し先の関数の `throw` で、呼び出し元が `catch` しないものは、起点の出口として扱う。
- **API**: ルート定義（`app.get`, `app.post`, `httpsCallable`, Next.js route handlers）からHTTPメソッドとパスを `API_ENDPOINT` として抽出し、リクエストバリデーション（zod, Joi, 型定義）から入力パラメータを抽出する。初回の実装では作っていない（2.6）。
- **データ変更 (`DATA_MUTATION`)**: ORM メソッド、Firestore SDK 操作など。ScenarioExtractor と同じ規則（`classifyCall`）で見つける。

### 2.4 TriggerAnalyzer (非同期バッチ・イベントトリガー解析)
初回の実装では作っていない（2.6）。
- **対象**: Cron 設定ファイル、クラウドストレージ/DBイベントトリガー定義。
- **解析規則**: 起点がポリシー（`inletType: "POLICY"`）のとき、トリガーの起動契機（定期実行スケジュール、オブジェクト作成イベント、DBミューテーション）と、それによって呼び出されるハンドラ関数の紐付けを抽出する。

### 2.5 SchemaAnalyzer (データモデル解析)
初回の実装では作っていない（2.6）。
- **対象**: DDL, Prisma/TypeORM スキーマ, Firestore rules/indexes, JSON Schema。データ変更が対象とするエンティティの定義だけを読む。
- **解析規則**: エンティティ名、フィールド名、データ型、Null 許容性、外部キー・リレーション制約、ユニーク制約を抽出。

### 2.6 解析した範囲の報告（`coverage`）
解析しなかった層を、理由とともに `RawContextModel.coverage.notAnalyzed` に入れる。報告を読む人が、出力に無いものを「無い」と読み違えないためである。初回の実装では、`analyzed` は `["LOGIC"]` で、`notAnalyzed` は次の 4 つになる。

| analyzer | 理由 |
| :-- | :-- |
| `UI` | シナリオに画面が無い（`readModel` が無いとき）、または初回の範囲では画面の解析を作っていない |
| `API_ENDPOINT` | 初回の範囲ではルート定義の解析を作っていない |
| `ASYNC_TRIGGER` | 初回の範囲ではトリガーの定義の解析を作っていない（イベントの発行は `ASYNC_CUT` として残す） |
| `SCHEMA` | 初回の範囲ではスキーマの解析を作っていない（データの変更は `DATA_MUTATION` として残す） |

---

## 3. スライスの作り方と正規化 (Slice Building & Normalization)

### 3.1 出口ごとに 1 スライス
- 起点の処理の出口（`RETURN`・`THROW`・応答・`ASYNC_CUT`）ごとに、スライスを 1 つ作る。初回の実装で出口になるのは `RETURN` と `THROW` である。
- スライスの条件は、関数の入口からその出口までの構文上の経路で通る分岐の条件と、その側（`holds: true` は条件が成り立つ側）である。経路より前にある早期の出口については、その出口に入らなかったことを条件として足す。
- 出口に至らない分岐（中で状態を変えて、そのまま先へ進む `if` など）はスライスを分けない。その中の `STATE_WRITE` に、条件の式と側を付けて記録する。経路の組み合わせ（分岐が n 個なら 2 の n 乗）でスライスを増やさないためである。
- スライスは、ユニットを写さずに識別子で参照する。

### 3.2 経路のたどり方
文を順にたどり、先へ続く経路は常に 1 本にする。分岐の扱いは、その枝が出口に至るかどうかで決める。

| 枝の性質 | スライス | 続く経路の条件 |
| :-- | :-- | :-- |
| 片側がいつも出口に至る（ガード節） | その側を分けてスライスにする | 「その側に入らなかった」条件（`holds` を逆にしたもの）を足す |
| ときどき出口に至る | 出口に至る経路だけを分けてスライスにする | 足さない（どちら側を通ったか決められないため。推測で条件を作らない） |
| 出口に至らない | 分けない | 足さない。中の書き込みに `details.guard` で条件を付ける |

- **ループ**: 中身を 1 回通るものとして扱う。`for…of`・`for…in` の条件のユニットは、繰り返す対象の式を原文で持つ。`details.loop` に種類（`WHILE`・`FOR`・`FOR_OF`・`FOR_IN`）を書く。`do…while` は必ず中身に入るので、条件のユニットを作らない。`break`・`continue` はその枝の終わりとして扱う。
- **`switch`**: `case` ごとに枝として扱う（式の形は 4 の表）。`details.switchCase` に `CASE` か `DEFAULT` を書く。次の `case` へ落ちる形は、初回の実装ではその `case` の中身だけを見る。`break` で抜けた経路と、`switch` の中の `continue` は、`switch` の後へ続くものとして扱う。
- **`try…catch`**: `try` の中の `throw` と、`try` の中で呼んだ関数から伝わる `throw` は出口にしない（`catch` へ行く）。`try` の中の `throw` は `THROW` のユニット（`details.caught: true`）として残す。`catch` の枝の条件のユニットは、式を `"catch"` とし、`details.branch` を `"CATCH"` にする（FormalTranspiler は構文木にできない式を命題として扱う）。`catch` に入る経路には、`try` の中で `throw` の前に通ったユニットを含める。`catch` の無い `try…finally` の中の `throw` は出口にする。`finally` はそのまま続けてたどる。
- **関数の終わり**: 関数の終わりまで来た経路は、暗黙の `RETURN` を出口にする（2.3）。
- **入れ子の関数**: 中の `return`・`throw` は出口にしない。中へは入らない（2.1）。

### 3.3 追跡した関数の中身の扱い
追跡した関数は 1 度だけ解析し、次の 2 つを要約として持つ。

1. `catch` されない `throw` に至る経路（条件・ユニット・書き込み）。
2. それ以外の経路のユニットと書き込み。

呼び出した側では、要約を次のように使う。
- 呼ばれた関数の `catch` されない `throw` は、呼び出した側の出口になる。条件は、呼び出しまでの経路の条件に、呼ばれた関数の中の条件を足したものである。呼び出しが `catch` のある `try` の中にあるときは、出口にせずに `catch` へ行く経路にする。
- それ以外の経路のユニットは、呼び出しの位置に経路の順で入れる（重複は除く）。入れるのは `CALL`・`STATE_WRITE`・`DATA_MUTATION`・`EXTERNAL_CALL`・`ASYNC_CUT`・`RECURSION` だけで、呼ばれた関数の中の条件と出口は入れない。経路の組み合わせでスライスを増やさないためである。その代わりに、書き込みの `details.guard` に、呼ばれた関数の中でその書き込みに至る条件を合成して付ける。
- `details.guard` の合成: その関数の中で書き込みに至る条件（経路の条件と、いま中にいる枝の条件）をすべて集め、重複を除く。1 つならその式と側を、2 つ以上なら `(a) && !(b)` の形の式にして `guardHolds: true` にする。起点の関数でも、呼ばれた関数でも同じ規則にする。`if (a) { if (b) return; x = 1 }` の `!(b)` のように、枝を戻すときに経路の条件が落ちる形でも、書き込みの条件が消えないためである。このため、`guard` がスライスの条件と重なることがある。
- `details.guardTerms` は、同じ条件を `BRANCH_CONDITION` のユニットの識別子と側の組で、経路の条件 → いま中にいる枝の条件の順に並べたもの。重複は識別子と側の組で除く（`guard` は式と側で除くので、同じ式の条件が 2 か所にあると、`guardTerms` のほうが項が多くなる）。FormalTranspiler はこれを使い、命題と状態変数の識別子を条件のユニットからそろえる。

### 3.4 因果接続
UI 側の API 呼び出しと処理側のエンドポイントパスを突合してリンクし、データ変更とスキーマのエンティティ定義を突合してリンクする。突合できないものは、リンクを作らずにそのまま残す。初回の実装では UI・API・スキーマの解析を作っていないので、因果接続も作っていない。

### 3.5 決定論的な並び
- ユニットはファイル → 行 → 列 → 種類の順に並べる。識別子は所在から作る（`<ファイル>:<行>:<列>:<種類>`）。メソッドの呼び出しの所在はプロパティの名前の位置にする。`a.b().c()` の 2 つの呼び出しの識別子が重ならないためである。
- スライスは出口のユニットの並びの順に並べる。
- スライスの識別子は `<scenarioId>#<呼び出しのユニットの識別子>>…><出口のユニットの識別子>` である。呼ばれた関数の `throw` が出口になるときは、起点から出口までの `CALL` の識別子を `>` でつなぐ。同じ出口に別の呼び出しから至るとき、識別子が重ならないためである。それでも重なったときは、後のものに `~2` から番号を付ける。
- 同じ入力からは、同じ `RawContextModel` が出る。

### 3.6 エラーハンドリング
- 構文解析エラーが起きたら、推測や不完全なパース結果を返さず、ファイル・行・列・原因を含む `SyntaxExtractionError` を投げる（Fail-Fast）。
- オーケストレーターはこれと `InletNotFoundError` を受け止め、そのシナリオを「ContextExtractor で止まった」と理由付きで実行の報告に残して、ほかのシナリオの処理を続ける。

---

## 4. データ構造 (`RawContextModel`)

```typescript
type ExtractionUnitKind =
  | "STATE" | "STATE_WRITE" | "OPERATION" | "INTERFACE_TEXT" | "BRANCH_CONDITION"
  | "API_ENDPOINT" | "DATA_MUTATION" | "SCHEMA_ENTITY"
  | "CALL"                          // 追跡した呼び出し（中へ入った呼び出し）
  | "RETURN" | "THROW" | "ASYNC_CUT" | "EXTERNAL_CALL" | "RECURSION";

interface UnitLocation { file: string; line: number; column: number } // 1 から数える

interface ExtractionUnit {
  id: string;                      // "<ファイル>:<行>:<列>:<種類>"
  kind: ExtractionUnitKind;
  name: string;                    // 実装上の名前（変数名、関数名、呼び出しの式など）
  layer: "UI" | "LOGIC" | "DATABASE" | "ASYNC_TRIGGER";
  location: UnitLocation;
  componentScope?: string;         // ユニットを含む、たどった関数の名前
  details?: Record<string, string | number | boolean | null>; // 種類ごとの項目は下の表
}

interface UseCaseSlice {
  sliceId: string;                 // "<scenarioId>#<呼び出しのユニットの識別子>>…><出口のユニットの識別子>"
  conditions: Array<{ unitId: string; expression: string; holds: boolean }>;
  outlet: { unitId: string; kind: "RETURN" | "THROW" | "RESPONSE" | "ASYNC_CUT" };
  writes: string[];                // この経路で通る STATE_WRITE と DATA_MUTATION の識別子（経路の順）
  unitIds: string[];               // この経路で通るユニットの識別子（経路の順。条件・書き込み・呼び出し・出口を含む）
}

interface RawContextModel {
  scenarioId: string;
  inlet: {
    kind: "COMMAND" | "POLICY";
    handler: { file: string; symbol: string; line: number }; // 追跡を始めた関数（POLICY ではリスナーとして渡された関数）
    route?: string;
  };
  units: ExtractionUnit[];         // ファイル → 行 → 列 → 種類の順
  slices: UseCaseSlice[];          // 出口のユニットの並びの順
  unresolved: Array<{ unitId: string; location: UnitLocation; reason: string }>; // EXTERNAL_CALL と RECURSION の要約
  coverage: {
    analyzed: Array<"LOGIC">;
    notAnalyzed: Array<{ analyzer: "UI" | "API_ENDPOINT" | "ASYNC_TRIGGER" | "SCHEMA"; reason: string }>;
  };
}
```

- 層（`layer`）は種類から決める。`OPERATION`・`INTERFACE_TEXT` は `UI`、`DATA_MUTATION`・`SCHEMA_ENTITY` は `DATABASE`、`ASYNC_CUT` は `ASYNC_TRIGGER`、それ以外は `LOGIC` である。
- `details` に置く項目（FormalTranspiler が使うもの。式はすべて原文のまま）:

| 種類 | 項目 |
| :-- | :-- |
| `STATE` | `initial`: 初期値の式（最上位の変数で初期値があるときだけ。ほかは `null`）、`scope`: 状態変数の区切り（`MODULE`: 最上位の `let`・`var`、`CLASS`: `this.x`、`PARAMETER`: 引数のプロパティ）、`owner`: 区切りの持ち主（`MODULE` は `null`、`CLASS` はクラス名（クラスの外の `this.x` は関数の名前）、`PARAMETER` は関数の名前）。`componentScope` は最初に書き込んだ関数の名前で、区切りとは一致しないため、FormalTranspiler は名前の照合に `scope` と `owner` を使う |
| `STATE_WRITE` | `target`: 書き込む `STATE` の識別子、`expression`: 代入の式（`x++` などは式全体）、`guard`: その関数の中で書き込みに至る条件を合成した式（3.3。無ければ `null`。人が読むためのもの）、`guardHolds`: その側、`guardTerms`: 同じ条件を構造で持つもの（`[{ "unitId": <BRANCH_CONDITION の識別子>, "holds": <側> }]` を JSON にした文字列。条件が無ければ `"[]"`）。FormalTranspiler は `guardTerms` を使う。条件の式に `catch` や `for…of` の対象のような、式として読めないものが入るためである |
| `BRANCH_CONDITION` | `expression`: 条件の式。`switch` は `case` ごとに 1 つのユニットとし、`<対象> === <case の値>` の形で持つ（`default` は、ほかの `case` のどれでもないこととして、各 `case` の式を `!==` にして `&&` でつないだ形。ほかの `case` が無ければ `true`）。加えて、ループなら `loop`（`WHILE`・`FOR`・`FOR_OF`・`FOR_IN`）、`switch` なら `switchCase`（`CASE`・`DEFAULT`）、`catch` なら `branch: "CATCH"`（式は `"catch"`） |
| `RETURN` | `implicit`: 関数の終わりに置いた暗黙の `RETURN` なら `true`、`expression`: 返す式（無ければ `null`） |
| `THROW` | `caught`: `catch` のある `try` の中なら `true`（出口にしない）、`expression`: 投げる式 |
| `CALL` | `callee`: 呼び出しの式、`args`: 引数の式を JSON の配列にした文字列、`receiver`: メソッドの受け手の式（無ければ `null`）、`target`: 呼ばれた関数（`<ファイル>#<関数名>`） |
| `EXTERNAL_CALL`・`RECURSION` | `callee`・`args`・`receiver`（`CALL` と同じ）、`reason`: たどらなかった理由（2.1 の表。`RECURSION` は `"RECURSION"`） |
| `DATA_MUTATION`・`ASYNC_CUT` | `callee`・`args`・`receiver`（`CALL` と同じ） |

- 既存の型からの変更: `intent` を外した（当時は `ScenarioTarget` が持った。2026-10-30 からは `IntentSynthesizer` の出力が持つ）。`entryPoint` を `inlet` にした（起点の所在を持つ）。`UseCaseSlice` の `precondition`・`outcome`（文字列）を、条件の一覧と出口に分けた。`isAsyncCutEnforced` は `ASYNC_CUT` のユニットで表すので外した。
- 初回の実装での変更: 種類に `CALL` を足した（`unitIds` の「呼び出し」に当たる種類が一覧に無かったため）。`unresolved` の各項目に `unitId` を足した。`coverage` を足した（2.6）。スライスの識別子の形を変えた（3.5）。

---

## 5. 初回の実装の限界

次の点は、初回の実装では扱っていない。出力を読むときは、これらを前提にする。

- 式の中の短絡評価（`a && f()`）と三項演算子は分岐として分けない。中の呼び出しは、条件なしで経路に入る。
- `switch` で次の `case` へ落ちる形は、その `case` の中身だけを見る。
- `try…catch` で `try` 側と `catch` 側の両方が出口に至るとき、`finally` の中をたどらない。
- 関数の中で、最上位の `let` と同じ名前のローカル変数を宣言して代入すると、状態の書き込みと読み違える（スコープを見ていない）。
- `export default function f` は、起点として探すと `"default"`、名前で呼ばれると `"f"` になり、同じ関数を 2 度解析することがある（結果は変わらない）。
- `ASYNC_CUT` は出口にしない。応答（`RESPONSE`）の出口は作らない。
- UI・API・トリガー・スキーマの解析と、因果接続は作っていない（2.6、3.4）。

FormalTranspiler に引き継ぐこと（FormalTranspiler の書き直しで扱う）:
- `EXTERNAL_EFFECT` の条件に、「メソッドの受け手（`receiver`）が状態変数か `this`」を足す。メソッドの呼び出しによる状態の変更（`list.push(...)` など）は、ContextExtractor では `STATE_WRITE` にならず `EXTERNAL_CALL` として残るためである。
- 構文木にできない条件の式（`"catch"` など）は命題として扱う。