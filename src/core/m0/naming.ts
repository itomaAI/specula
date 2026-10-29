// M0 で LLM に頼む 5 つの処理（M0 の設計 3.1 の 3、3.2 の 2、3.3 の 1・4、3.4 の 3）。
// 入力にはコードから機械的に決まる値だけを入れる（ほかの LLM の結果は入れない）。
// そうしておくと、記録のキーが LLM の結果によらず決まり、未生成の項目があっても他の項目の記録は使える。

import type { JsonValue, LlmText } from "../../types/index.js";
import type { LanguageModelPort, OutputCheck } from "../../ports/LanguageModelPort.js";

export const M0_PROMPT_VERSION = "1";

/** 関数の頭として LLM に渡す行数。 */
export const SNIPPET_LINES = 12;

const MAX_INTENT_LENGTH = 200;

export const pascalCaseCheck: OutputCheck = (text) => {
  const value = text.trim();
  return /^[A-Z][A-Za-z0-9]*$/.test(value)
    ? { ok: true }
    : { ok: false, detail: `PascalCase の 1 語ではない: ${JSON.stringify(value.slice(0, 80))}` };
};

export const intentCheck: OutputCheck = (text) => {
  const value = text.trim();
  if (value.length === 0) return { ok: false, detail: "空" };
  if (value.includes("\n")) return { ok: false, detail: "1 行ではない" };
  if (value.length > MAX_INTENT_LENGTH) return { ok: false, detail: `${MAX_INTENT_LENGTH} 字を超える（${value.length} 字）` };
  return { ok: true };
};

async function ask(
  llm: LanguageModelPort,
  task: string,
  instructions: string,
  input: JsonValue,
  check: OutputCheck,
): Promise<LlmText> {
  const result = await llm.generate({ task, promptVersion: M0_PROMPT_VERSION, instructions, input }, check);
  // 形の確認は前後の空白を除いて行っているので、使う側にも除いた文を渡す。
  return result.status === "GENERATED" ? { ...result, text: result.text.trim() } : result;
}

const NAME_RULES =
  "Answer with exactly one English word in PascalCase (letters and digits only, starting with an uppercase letter). " +
  "Do not add quotes, punctuation, explanations or line breaks.";

const INTENT_RULES =
  "日本語の 1 文で答える（改行しない、200 字以内）。コードに書かれていないことを推測で足さない。説明や前置きを付けない。";

export function nameEvent(
  llm: LanguageModelPort,
  input: { handler: { file: string; symbol: string }; signalKind: string; callee: string; label: string | null; snippet: string },
): Promise<LlmText> {
  return ask(
    llm,
    "m0.name-event",
    "Name the domain event that becomes a fact when the signal in this function completes. " +
      "Use a past participle phrase such as UserRegistered or PaymentCompleted. " +
      NAME_RULES,
    input,
    pascalCaseCheck,
  );
}

export function nameCommand(
  llm: LanguageModelPort,
  input: {
    handler: { file: string; symbol: string };
    signals: Array<{ kind: string; callee: string; label: string | null }>;
    snippet: string;
  },
): Promise<LlmText> {
  return ask(
    llm,
    "m0.name-command",
    "Name the command (the request made by the caller) that this function handles. " +
      "Use an imperative verb phrase such as ChangePassword or SubmitOrder. " +
      NAME_RULES,
    input,
    pascalCaseCheck,
  );
}

export function namePolicy(
  llm: LanguageModelPort,
  input: {
    eventName: string;
    listener: { file: string; symbol: string };
    target: { file: string; symbol: string };
  },
): Promise<LlmText> {
  return ask(
    llm,
    "m0.name-policy",
    "Name the policy: when the event with the given name happens, the target function is started. " +
      "Use a phrase such as SendWelcomeMailOnRegistration. " +
      NAME_RULES,
    input,
    pascalCaseCheck,
  );
}

export function contextIntent(
  llm: LanguageModelPort,
  input: { contextId: string; rootPaths: string[]; filePaths: string[] },
): Promise<LlmText> {
  return ask(
    llm,
    "m0.context-intent",
    "この範囲のコードが業務の中で受け持つこと（存在理由）を書く。" + INTENT_RULES,
    input,
    intentCheck,
  );
}

export function scenarioIntent(
  llm: LanguageModelPort,
  input: {
    inletType: string;
    handler: { file: string; symbol: string };
    expectedEvent: { file: string; symbol: string; kind: string; callee: string; label: string | null };
    actor: string;
    route: string | null;
  },
): Promise<LlmText> {
  return ask(
    llm,
    "m0.scenario-intent",
    "この操作で、操作する人（または呼び出す側）が達成したいことを書く。" + INTENT_RULES,
    input,
    intentCheck,
  );
}

/** 関数の頭の数行（行番号は 1 から）。ファイルが無ければ空の文字列。 */
export function snippetOf(text: string | undefined, line: number): string {
  if (text === undefined || line < 1) return "";
  return text
    .split("\n")
    .slice(line - 1, line - 1 + SNIPPET_LINES)
    .join("\n");
}