# ContextExtractor 基本設計書

本設計書は、実装事実抽出モジュールの仕様書（`01_context_extractor.spec.md`）に規定された多層システム事実抽出（UI・処理・バッチ・DBスキーマ）を、全体基本設計書（`system_solution.design.md`）の規約に準拠して**どのように技術的・構造的に実現するか（How）**を定義する。

---

## 1. アーキテクチャと全体設計制約の継承

### 1.1 全体設計制約の適用
- **配置場所**: `specula/src/core/context_extractor.ts`（ビルド後は `dist/` の JS）（Pure ESM, Target: ES2022+）。
- **Zero-I/O Core の遵守**: 本モジュールは `node:fs` や `window.MetaOS.fs` を直接インポートしてはならない。ソースは `FileSystemPort` から読み取り専用で取得する（追跡で必要になったファイルだけを読む）。
- **依存方向の一方向性**: 本モジュールは `src/ports/` のインターフェースのみに依存し、`src/adapters/` の具象環境実装を一切参照しない。
- **LLM を使わない**: 事実の抽出はすべて AST から決定論的に行う。

### 1.2 公開する関数
```typescript
extractContext(target: ScenarioTarget, deps: { fs: FileSystemPort }): Promise<RawContextModel>;
```

### 1.3 構成
起点から呼び出しをたどる `CallTracer` が中心にあり、たどり着いたファイルにだけ各層のアナライザーをかける。

```
[ScenarioTarget.inletTrigger.handler]
              │
              ▼
      [CallTracer]  ── 呼び出しをたどる（import を解決）
              │          追跡できない呼び出しは記録して止まる
              │          非同期境界で止まる
              ▼
 たどり着いた関数・ファイル
   ├─➔ [UIAnalyzer]       （readModel があるときだけ）
   ├─➔ [LogicAnalyzer]    状態変数・分岐・出口・API・関数呼び出し
   ├─➔ [TriggerAnalyzer]
   └─➔ [SchemaAnalyzer]   （データ変更が対象とするスキーマだけ）
              │
              ▼
      [SliceBuilder]  ── 出口ごとにユースケーススライスを作る
              │
              ▼
      [RawContextModel]
```

---

## 2. 各部の詳細設計 (Detailed Design)

構文解析はすべて `@babel/parser`（Plugins: `typescript`, `jsx`）で行う。外部バイナリやネイティブCLIを使わず、Node.js と Itera OS で同じに動く。

### 2.1 CallTracer（呼び出しの追跡）
- **起点**: `target.inletTrigger.handler`（ファイル・関数名・行）。そのファイルに、その名前の関数（関数宣言、関数を代入した変数、クラスのメソッド、`export default` の関数）が無いときは、`InletNotFoundError` を投げる。別の関数を起点にしない。
- **たどる呼び出し**: 関数本体の呼び出し式のうち、呼び出し先を AST から決められるものをたどる。
  - 同じファイルで定義された関数。
  - `import` で取り込んだ関数。相対パスの指定を解決する（`./x.js` は `./x.ts`・`./x.tsx`・`./x.js`・`./x/index.ts` の順に探す）。
- **たどらない呼び出し**: 次は `EXTERNAL_CALL` として所在と理由を記録し、中へは入らない。
  - 外部パッケージ（相対パスでない import）の関数。
  - 呼び出し先を決められないもの（引数で受け取った関数、計算されたプロパティ名、動的 import など）。
- **再帰と重複**: たどった関数を記録し、同じ関数には 2 度入らない。再帰の呼び出しは、その場で `RECURSION` として記録して止まる。
- **非同期境界**: メッセージキューへのエンキュー（SQS/Kafka等）、DB イベントトリガーの発火点、イベントの発行（`emit`・`dispatch`・`publish`）を見つけたら、`ASYNC_CUT` として記録し、受け手の処理へは入らない。

### 2.2 UIAnalyzer (フロントエンド構文・視覚解析)
- `target.readModel` があるときだけ、`readModel.entryFile` に対して動く。
- **AST トラバース規則**:
  - `VariableDeclarator`: `useState` および状態管理フックの呼び出しを走査し、変数名と初期値を `STATE` として抽出。
  - `FunctionDeclaration` / `ArrowFunctionExpression`: コンポーネント内の関数を走査。関数名、引数型、および関数内部で発火される API 呼び出し（`fetch`, `httpsCallable` 等）を `OPERATION` として抽出。
  - `JSXElement` / `JSXAttribute`: `label`, `title`, `placeholder` 属性および `JSXText` の文字列リテラルを `INTERFACE_TEXT` として抽出。
  - `ConditionalExpression` / `LogicalExpression` / `IfStatement`: 画面の条件付き描画ロジックを `BRANCH_CONDITION` として抽出。
- **コンポーネントスコープの保持**: 各要素の親コンポーネント名（関数名）を `componentScope` として付与し、同一ファイル内の複数コンポーネントの混同を防止する。

### 2.3 LogicAnalyzer（処理の解析）
CallTracer がたどった各関数に対して動く。画面を持たないシステムでは、これが中心の解析になる。
- **状態変数 (`STATE`)**: 関数の外で宣言された `let` の変数、クラスのフィールド（`this.x`）、引数で受け取ったオブジェクトのプロパティのうち、たどった関数の中で代入・変更されるもの。変更の箇所を `STATE_WRITE` として記録する。
- **分岐 (`BRANCH_CONDITION`)**: `if`・`switch`・三項演算子・`try`/`catch`。条件の式は原文のまま持つ（意味づけしない）。
- **出口**: `return`（`RETURN`）と `throw`（`THROW`）。呼び出し先の関数の `throw` で、呼び出し元が `catch` しないものは、起点の出口として扱う。
- **API**: ルート定義（`app.get`, `app.post`, `httpsCallable`, Next.js route handlers）からHTTPメソッドとパスを `API_ENDPOINT` として抽出し、リクエストバリデーション（zod, Joi, 型定義）から入力パラメータを抽出する。
- **データ変更 (`DATA_MUTATION`)**: ORM メソッド、Firestore SDK 操作など。

### 2.4 TriggerAnalyzer (非同期バッチ・イベントトリガー解析)
- **対象**: Cron 設定ファイル、クラウドストレージ/DBイベントトリガー定義。
- **解析規則**: 起点がポリシー（`inletType: "POLICY"`）のとき、トリガーの起動契機（定期実行スケジュール、オブジェクト作成イベント、DBミューテーション）と、それによって呼び出されるハンドラ関数の紐付けを抽出する。

### 2.5 SchemaAnalyzer (データモデル解析)
- **対象**: DDL, Prisma/TypeORM スキーマ, Firestore rules/indexes, JSON Schema。データ変更が対象とするエンティティの定義だけを読む。
- **解析規則**: エンティティ名、フィールド名、データ型、Null 許容性、外部キー・リレーション制約、ユニーク制約を抽出。

---

## 3. スライスの作り方と正規化 (Slice Building & Normalization)

1. **出口ごとに 1 スライス**:
   - 起点の処理の出口（`RETURN`・`THROW`・応答・`ASYNC_CUT`）ごとに、スライスを 1 つ作る。
   - スライスの条件は、関数の入口からその出口までの構文上の経路で通る分岐の条件と、その側（`holds: true` は条件が成り立つ側）である。経路より前にある早期の出口については、その出口に入らなかったことを条件として足す。
   - 出口に至らない分岐（中で状態を変えて、そのまま先へ進む `if` など）はスライスを分けない。その中の `STATE_WRITE` に、条件の式と側を付けて記録する。経路の組み合わせ（分岐が n 個なら 2 の n 乗）でスライスを増やさないためである。
   - スライスは、ユニットを写さずに識別子で参照する。
2. **因果接続**: UI 側の API 呼び出しと処理側のエンドポイントパスを突合してリンクし、データ変更とスキーマのエンティティ定義を突合してリンクする。突合できないものは、リンクを作らずにそのまま残す。
3. **決定論的な並び**: ユニットはファイル → 行 → 列 → 種類の順、スライスは出口のユニットの並びの順に並べる。識別子は所在から作る（`<ファイル>:<行>:<列>:<種類>`）。スライスの識別子は `<scenarioId>#<出口のユニットの識別子>`。
4. **エラーハンドリング**:
   - 構文解析エラーが起きたら、推測や不完全なパース結果を返さず、ファイル・行・列・原因を含む `SyntaxExtractionError` を投げる（Fail-Fast）。
   - オーケストレーターはこれと `InletNotFoundError` を受け止め、そのシナリオを「M1 で止まった」と理由付きで実行の報告に残して、ほかのシナリオの処理を続ける。

---

## 4. データ構造 (`RawContextModel`)

```typescript
type ExtractionUnitKind =
  | "STATE" | "STATE_WRITE" | "OPERATION" | "INTERFACE_TEXT" | "BRANCH_CONDITION"
  | "API_ENDPOINT" | "DATA_MUTATION" | "SCHEMA_ENTITY"
  | "RETURN" | "THROW" | "ASYNC_CUT" | "EXTERNAL_CALL" | "RECURSION";

interface ExtractionUnit {
  id: string;                      // "<ファイル>:<行>:<列>:<種類>"
  kind: ExtractionUnitKind;
  name: string;                    // 実装上の名前（変数名、関数名、エンドポイントのパスなど）
  layer: "UI" | "LOGIC" | "DATABASE" | "ASYNC_TRIGGER";
  location: SourceLocation;
  componentScope?: string;
  details?: Record<string, string | number | boolean | null>; // 種類ごとの項目は下の表
}

interface UseCaseSlice {
  sliceId: string;                 // "<scenarioId>#<出口のユニットの識別子>"
  conditions: Array<{ unitId: string; expression: string; holds: boolean }>;
  outlet: { unitId: string; kind: "RETURN" | "THROW" | "RESPONSE" | "ASYNC_CUT" };
  writes: string[];                // この経路で通る STATE_WRITE と DATA_MUTATION の識別子（経路の順）
  unitIds: string[];               // この経路で通るユニットの識別子（経路の順。条件・書き込み・呼び出し・出口を含む）
}

interface RawContextModel {
  scenarioId: string;
  inlet: { kind: "COMMAND" | "POLICY"; handler: SourceLocation; route?: string };
  units: ExtractionUnit[];
  slices: UseCaseSlice[];
  unresolved: Array<{ location: SourceLocation; reason: string }>; // EXTERNAL_CALL と RECURSION の要約
}
```

- `details` に置く項目（M2 が使うもの。式はすべて原文のまま）:

| 種類 | 項目 |
| :-- | :-- |
| `STATE` | `initial`: 初期値の式（宣言に初期値が無ければ `null`） |
| `STATE_WRITE` | `target`: 書き込む `STATE` の識別子、`expression`: 代入の式（`x++` などは式全体）、`guard`: 出口に至らない分岐の中の書き込みなら、その条件の式（無ければ `null`）、`guardHolds`: その側 |
| `BRANCH_CONDITION` | `expression`: 条件の式。`switch` は `case` ごとに 1 つのユニットとし、`<対象> === <case の値>` の形で持つ（`default` は、ほかの `case` のどれでもないこととして、各 `case` の式を `!==` にして `&&` でつないだ形） |
| `EXTERNAL_CALL`・`RECURSION` | `callee`: 呼び出しの式、`args`: 引数の式を JSON の配列にした文字列、`reason`: たどらなかった理由 |

- 既存の型からの変更: `intent` を外した（`ScenarioTarget` が持つ）。`entryPoint` を `inlet` にした（起点の所在を `SourceLocation` で持つ）。`UseCaseSlice` の `precondition`・`outcome`（文字列）を、条件の一覧と出口に分けた。`isAsyncCutEnforced` は `ASYNC_CUT` のユニットで表すので外した。