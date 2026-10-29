# FormalTranspiler 基本設計書

本設計書は、形式仕様変換モジュールの仕様書（`02_formal_transpiler.spec.md`）に規定された事実モデルから形式仕様正本（Alloy 6）への決定論的コンパイルを、全体基本設計書（`system_solution.design.md`）の規約に準拠して**どのように技術的・構造的に実現するか（How）**を定義する。

---

## 1. アーキテクチャと全体設計制約の継承

### 1.1 全体設計制約の適用
- **配置場所**: `specula/src/core/formal_transpiler.ts`（ビルド後は `dist/` の JS）（Pure ESM, Target: ES2022+）。
- **Zero-I/O Core の遵守**: 本モジュールは直接ファイル読み込みや書き込みを行わず、メモリ上で `RawContextModel` を受領し、Alloy 6 ソース文字列を返す純粋関数として実装する。
- **依存方向の一方向性**: `src/ports/` の型定義のみを参照し、インフラや実行環境に依存しない。

### 1.2 変換エンジン構成
```
[RawContextModel] ──➔ [DomainVocabularyMapper] ──➔ [AlloyASTBuilder] ──➔ [CanonicalPrinter] ──➔ [FormalSpec (*.als)]
                                                          │
[PreviousSpec]    ────────────────────────────────────────┘ (差分アノテーション)
```

---

## 2. Alloy 6 への厳格なマッピング規則 (Mapping Rules)

### 2.1 ドメイン構造とエンティティ (`sig`)
- 各コンポーネントおよび DB エンティティをシグネチャとして宣言。
  ```alloy
  -- @source: "User"
  sig User {
    id: one String,
    email: lone String
  }
  ```

### 2.2 状態空間と時相変数 (`var sig`)
- 画面およびプロセスの離散状態遷移は、Alloy 6 の時相論理（`var`）を用いて定式化する。
  ```alloy
  abstract sig ScreenState {}
  one sig InitialLoading, Ready, Processing, ErrorState extends ScreenState {}

  -- 実行時の現在状態を表す時相変数
  var one sig CurrentState in ScreenState {}
  ```

### 2.3 操作と状態遷移述語 (`pred`)
- ユーザー操作および API コールを、事前条件と事後状態の関係を表す述語として生成する。
  ```alloy
  -- @source: "handlePasswordReset"
  -- @trigger: "PWリセットボタン押下"
  pred RequestPasswordReset [u: User] {
    -- 事前条件 (Precondition)
    CurrentState in Ready
    some u.email

    -- 事後条件 (Postcondition)
    CurrentState' in Processing

    -- 不変条件 (Frame condition / Invariant)
    u.id' = u.id
  }
  ```

### 2.4 大域的不変条件 (`fact`)
- システム全体で常に維持されるべき制約を `fact` として生成する。
  ```alloy
  fact Invariants {
    -- 有効なユーザーのみが処理を実行可能
    always (all u: User | some u.email or CurrentState not in Processing)
  }
  ```

---

## 3. 曖昧性検知アルゴリズム (Ambiguity Detection)

形式仕様コードの生成に先立ち、入力モデルの検証を実施する：
1. **条件分岐の未完結検知**: `if` に対する `else` 側の状態遷移がコードおよび画像から特定できない場合。
2. **遷移不能状態の検知**: ある状態へ遷移した後、脱出するための操作が一切バインドされていない場合。
3. **曖昧性レポートの生成**:
   - 不足している前提や操作を特定し、コード生成を中断して `AmbiguityReport` を生成。PdM への具体的な質問文を提示する。

---

## 4. トレーサビリティと正規化出力 (Traceability & Normalization)

1. **アノテーション埋め込み**:
   - すべての `sig`, `pred`, `fact` の直上に、原本コードの識別子や行番号を `-- @source: "..."` 形式で保持し、双方向トレーサビリティを確保する。
2. **正準化出力 (Canonical Printing)**:
   - 出力される Alloy コード内の要素は、シグネチャ名順、述語名順で辞書ソートされ、何度実行しても 1 バイトの差異も発生しない（diff=0）。