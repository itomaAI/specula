// M2 で LLM に頼む 2 つの処理（M2 の設計 4.2・5）。
//
// - 表示名: コマンドごとに 1 回（task "m2.label-vocabulary"）。出力は識別子 → 表示名の JSON のオブジェクト。
//   検査: すべての識別子に表示名があり、各表示名が 1 行・40 文字以内。合わなければ INVALID_OUTPUT で、全部を未生成にする。
// - 質問の文: レポートごとに 1 回（task "m2.ambiguity-question"）。出力は issue の番号（"1" から）→ 文の JSON のオブジェクト。
//   設計の「issue ごと」から、呼ぶ回数を減らすためにまとめた（設計 02 を直す）。検査は 1 行・200 文字以内。
// - 入力にはコードから機械的に決まる値だけを入れる（ほかの LLM の結果は入れない）。記録のキーが LLM の結果によらず決まる。
// - 未生成の項目を、実装の名前や機械的な文で埋めない。

import type { JsonValue, LlmText } from "../../types/index.js";
import type { LanguageModelPort, OutputCheck } from "../../ports/LanguageModelPort.js";
import type { AmbiguityDraft } from "./ambiguity.js";

export const M2_PROMPT_VERSION = "1";

const MAX_LABEL_LENGTH = 40;
const MAX_QUESTION_LENGTH = 200;

const NO_LLM: LlmText = { status: "NOT_GENERATED", reason: "UNREACHABLE", detail: "LLM のポートが渡されていない" };

export interface VocabularyItem {
  /** Alloy の識別子（"v1"・"v1_2"・"c1"・"op1"・"o1"）。 */
  id: string;
  /** "STATE_VARIABLE" | "VALUE" | "PROPOSITION" | "OPERATION" | "OUTCOME" */
  kind: string;
  /** 実装上の名前（変数名、関数の symbol など）。 */
  name: string;
  /** 条件・代入・リテラルの原文。無ければ空。 */
  expression: string;
}

/** 前後の空白と、```json … ``` の囲みを外す。 */
function stripFence(text: string): string {
  const value = text.trim();
  const fenced = /^```[a-zA-Z]*\n([\s\S]*?)\n```$/.exec(value);
  return fenced !== null ? (fenced[1] as string).trim() : value;
}

function parseObject(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(stripFence(text));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function checkLine(value: unknown, max: number): string | null {
  if (typeof value !== "string") return "文字列ではない";
  const line = value.trim();
  if (line.length === 0) return "空";
  if (line.includes("\n")) return "1 行ではない";
  if (line.length > max) return `${max} 文字を超える（${line.length} 文字）`;
  return null;
}

function objectCheck(keys: string[], max: number): OutputCheck {
  return (text) => {
    const object = parseObject(text);
    if (object === null) return { ok: false, detail: "JSON のオブジェクトではない" };
    for (const key of keys) {
      if (!(key in object)) return { ok: false, detail: `${key} が無い` };
      const problem = checkLine(object[key], max);
      if (problem !== null) return { ok: false, detail: `${key}: ${problem}` };
    }
    return { ok: true };
  };
}

/** 1 回の呼び出しの結果を、キーごとの LlmText に分ける。 */
async function askObject(
  llm: LanguageModelPort | undefined,
  task: string,
  instructions: string,
  input: JsonValue,
  keys: string[],
  max: number,
): Promise<Record<string, LlmText>> {
  const result: Record<string, LlmText> = {};
  if (keys.length === 0) return result;
  const answer = llm === undefined ? NO_LLM : await llm.generate({ task, promptVersion: M2_PROMPT_VERSION, instructions, input }, objectCheck(keys, max));
  if (answer.status !== "GENERATED") {
    for (const key of keys) result[key] = answer;
    return result;
  }
  const object = parseObject(answer.text);
  for (const key of keys) {
    const value = object?.[key];
    result[key] =
      typeof value === "string"
        ? { status: "GENERATED", text: value.trim(), recordKey: answer.recordKey }
        : { status: "NOT_GENERATED", reason: "INVALID_OUTPUT", detail: `${key} が無い` };
  }
  return result;
}

export function labelVocabulary(
  llm: LanguageModelPort | undefined,
  commandId: string,
  items: VocabularyItem[],
): Promise<Record<string, LlmText>> {
  const input: JsonValue = {
    commandId,
    items: items.map((item) => ({ id: item.id, kind: item.kind, name: item.name, expression: item.expression })),
  };
  return askObject(
    llm,
    "m2.label-vocabulary",
    "You are given identifiers of a formal model generated from source code. For every item, give a short display name " +
      "in Japanese that a business person can read (what the state, value, condition, operation or outcome means). " +
      `Each name must be one line and at most ${MAX_LABEL_LENGTH} characters. Do not guess beyond what the name and expression say. ` +
      'Answer with only a JSON object that maps every id to its name, for example {"v1": "…", "c1": "…"}. No explanations.',
    input,
    items.map((item) => item.id),
    MAX_LABEL_LENGTH,
  );
}

export async function askQuestions(
  llm: LanguageModelPort | undefined,
  commandId: string,
  issues: AmbiguityDraft[],
): Promise<LlmText[]> {
  const keys = issues.map((_, index) => String(index + 1));
  const input: JsonValue = {
    commandId,
    issues: issues.map((issue, index) => ({
      number: String(index + 1),
      kind: issue.kind,
      file: issue.location.file,
      line: issue.location.line,
      detail: issue.detail,
    })),
  };
  const answers = await askObject(
    llm,
    "m2.ambiguity-question",
    "Each issue is a place in the code where a formal model could not be built automatically. " +
      "UNDETERMINED_VALUE: ask which business values the variable can take. " +
      "EXTERNAL_EFFECT: ask whether the call changes the state that is passed to it. " +
      "CONFLICTING_SLICES: ask what condition distinguishes the listed paths. " +
      `For every issue, write one question in Japanese to the developer (one line, at most ${MAX_QUESTION_LENGTH} characters). ` +
      'Answer with only a JSON object that maps every issue number to its question, for example {"1": "…"}. No explanations.',
    input,
    keys,
    MAX_QUESTION_LENGTH,
  );
  return keys.map((key) => answers[key] as LlmText);
}