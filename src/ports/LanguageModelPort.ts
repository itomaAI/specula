// LLM を呼ぶ口（全体設計 1.3）。
// コアは LanguageModelPort だけを使う。記録の参照と保存は RecordingLanguageModel（アダプター層）が行い、
// コアは記録の有無を知らない。

import type { LlmRequest, LlmText } from "../types/index.js";

/**
 * LLM の出力が期待する形かを確かめる関数。各処理（コア）が渡す。
 * 形が合わなければ INVALID_OUTPUT になり、記録されない。
 */
export type OutputCheck = (text: string) => { ok: true } | { ok: false; detail: string };

export interface LanguageModelPort {
  /** 例外を投げない。届かないことも、形が合わないことも LlmText の値で返す。 */
  generate(request: LlmRequest, check: OutputCheck): Promise<LlmText>;
}

/** 実際の LLM に 1 回問い合わせた結果。 */
export type LlmCompletion =
  | { kind: "TEXT"; text: string; model: string }
  | { kind: "UNREACHABLE"; detail: string };

/**
 * 実際の LLM のアダプター（ClaudeCodeCliAdapter・IteraLlmAdapter）が実装する口。
 * 記録も形の確認もしない。RecordingLanguageModel に包んで LanguageModelPort にする。
 */
export interface LanguageModelClient {
  /** 例外を投げない。つながらない、時間切れのときは UNREACHABLE を返す。 */
  complete(request: LlmRequest): Promise<LlmCompletion>;
}