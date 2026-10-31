// IntentSynthesizer（意図の候補）の出力の型（IntentSynthesizer の設計 3）。

import type { ConfirmationStatus, LlmText } from "./index.js";

// intentStatus は、用語などと共有する確定の状態（IntentSynthesizer の設計 3）。
// intent が GENERATED なら CANDIDATE、NOT_GENERATED なら NOT_GENERATED。
// CONFIRMED と NEEDS_RECHECK は確定の操作で付けるもので、本モジュールは書かない。

export interface ContextIntent {
  contextId: string;
  intent: LlmText;
  intentStatus: ConfirmationStatus;
}

export interface CommandIntent {
  commandId: string;
  intent: LlmText;
  intentStatus: ConfirmationStatus;
  /** CommandTarget.userIntent をそのまま写す（利用者定義のシナリオで、利用者が書いたときだけ）。 */
  userIntent?: string;
}

export interface IntentCatalog {
  /** contextId の辞書順。全体マップのすべての Bounded Context がちょうど 1 つずつある。 */
  contexts: ContextIntent[];
  /** commandId の辞書順。切り出したすべてのシナリオがちょうど 1 つずつある。 */
  commands: CommandIntent[];
  /** 元にした辞書の basis をそのまま写す。後段はこれで一覧が古くないかを確かめる。 */
  basis: { mapHash: string; documentsHash: string };
}

/** 全体マップ・資料と辞書の組が契約を破っている（IntentSynthesizer の設計 1.2）。 */
export class IntentContractError extends Error {
  constructor(
    // 辞書の basis（mapHash・documentsHash）が、受け取った全体マップか資料のハッシュと違う
    readonly reason: "GLOSSARY_STALE",
    readonly detail: string,
  ) {
    super(`IntentSynthesizer の入力の契約が破れている: ${reason}: ${detail}`);
    this.name = "IntentContractError";
  }
}