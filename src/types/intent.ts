// IntentSynthesizer（意図の候補）の出力の型（IntentSynthesizer の設計 3）。

import type { LlmText } from "./index.js";

/** 意図の確定の状態。初回の実行ではすべて CANDIDATE。CONFIRMED にするのは人間（PdM）で、本モジュールはしない。 */
export type IntentStatus = "CANDIDATE" | "CONFIRMED";

export interface ContextIntent {
  contextId: string;
  intent: LlmText;
  intentStatus: IntentStatus;
}

export interface ScenarioIntent {
  scenarioId: string;
  intent: LlmText;
  intentStatus: IntentStatus;
  /** ScenarioTarget.userIntent をそのまま写す（利用者定義のシナリオで、利用者が書いたときだけ）。 */
  userIntent?: string;
}

export interface IntentCatalog {
  /** contextId の辞書順。全体マップのすべての Bounded Context がちょうど 1 つずつある。 */
  contexts: ContextIntent[];
  /** scenarioId の辞書順。切り出したすべてのシナリオがちょうど 1 つずつある。 */
  scenarios: ScenarioIntent[];
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