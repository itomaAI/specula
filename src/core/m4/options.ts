// 反例の種類ごとの選択肢（M4 の設計 4 の表）。文は固定で、LLM で作らない。
// どの選択肢も採択済みとして扱わない（論点の decision は初回は常に null）。

import type { LedgerOption } from "../../types/ledger.js";
import type { FindingKind } from "../../types/solver.js";

const OPTIONS: Record<FindingKind, readonly LedgerOption[]> = {
  UNHANDLED_TRANSITION: [
    { id: "SPECIFY_HANDLING", meaning: "この状況での扱い（エラーにする、操作を受け付けないなど）を仕様として決める。中身は人が書く" },
    { id: "FIX_IMPLEMENTATION", meaning: "実装の誤りとして直す" },
    { id: "ACCEPT_AS_UNREACHABLE", meaning: "実際には起きない状況として認める。理由を人が書く" },
  ],
  OVERLAPPING_OPERATIONS: [
    { id: "SPECIFY_PRIORITY", meaning: "両方の条件が成り立つときに、どちらの結果にするかを仕様として決める" },
    { id: "FIX_IMPLEMENTATION", meaning: "実装の誤りとして直す" },
    { id: "ACCEPT_AS_UNREACHABLE", meaning: "両方が成り立つことは実際には起きないとして認める。理由を人が書く" },
  ],
  UNREACHABLE_OPERATION: [
    { id: "FIX_IMPLEMENTATION", meaning: "届くべき処理なので、実装の誤りとして直す" },
    { id: "REMOVE_OPERATION", meaning: "不要な処理として消す" },
    { id: "RECHECK_WITH_LARGER_SCOPE", meaning: "ステップ数の上限を上げて検査し直す" },
  ],
  DEADLOCK: [
    { id: "SPECIFY_EXIT", meaning: "この状態からの抜け方を仕様として決める" },
    { id: "DECLARE_TERMINAL", meaning: "終わりの状態（それ以上の操作を受け付けない状態）として認める" },
    { id: "FIX_IMPLEMENTATION", meaning: "実装の誤りとして直す" },
  ],
};

/** 呼ぶたびに新しい配列を返す（カタログを書き換えても表が変わらないように）。 */
export function optionsFor(kind: FindingKind): LedgerOption[] {
  return OPTIONS[kind].map((option) => ({ id: option.id, meaning: option.meaning }));
}