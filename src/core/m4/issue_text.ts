// 論点の文を LLM で書く（M4 の設計 5）。論点ごとに 1 回（task "m4.issue-text"）。
//
// - 入力は機械的に決まる値だけ（反例の種類と操作、実行列、関わる識別子の語彙）。記録のキーが LLM の結果によらず決まる。
//   語彙の表示名は spec.labels の GENERATED の文だけを渡し、NOT_GENERATED は null にして「表示名が無い」ことを伝える。
// - 出力は {"claim", "observation", "question"} の JSON のオブジェクト。検査: 3 つとも文字列で、空でなく、400 文字以内、
//   形式仕様の識別子（v1・v1_2・c1・op1・op1_guard・o1 など）を語として含まない。合わなければ INVALID_OUTPUT で、3 つとも未生成にする。
// - 未生成の文を定型文で埋めない。

import type { JsonValue, LlmText } from "../../types/index.js";
import type { LanguageModelPort, OutputCheck } from "../../ports/LanguageModelPort.js";
import type { FormalSpecification, GuardExpr } from "../../types/formal.js";
import type { Finding } from "../../types/solver.js";

export const M4_PROMPT_VERSION = "1";

const MAX_TEXT_LENGTH = 400;
const KEYS = ["claim", "observation", "question"] as const;
type Key = (typeof KEYS)[number];

export type IssueTexts = Record<Key, LlmText>;

const INSTRUCTIONS =
  "You are given one issue found by checking a formal model that was built from source code. " +
  "UNHANDLED_TRANSITION: in the last state of the trace, no operation can run. " +
  "OVERLAPPING_OPERATIONS: in the last state, the conditions of two operations hold at the same time. " +
  "UNREACHABLE_OPERATION: the operation was never reached within the step limit. " +
  "DEADLOCK: from the last state, the system can never get out. " +
  "Dependent findings point to the same state and are decided together with the root finding. " +
  "Write three texts in Japanese for a business person who decides the specification: " +
  '"claim" (the premise the system should satisfy), "observation" (what the check found, in plain words), ' +
  '"question" (the decision you ask the person to make). ' +
  `Each text must be at most ${MAX_TEXT_LENGTH} characters. ` +
  "Refer to states, values, conditions, operations and outcomes by their label. When the label is null, describe them by " +
  "their literal or expression. Never write the identifiers themselves (such as v1, v1_2, c1, op1, o1). " +
  "Do not decide the answer and do not guess beyond the input. " +
  'Answer with only a JSON object {"claim": "…", "observation": "…", "question": "…"}. No explanations.';

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

/** 形式仕様の識別子の一覧（文に出てはいけないもの）。 */
export function specIdentifiers(spec: FormalSpecification): Set<string> {
  const identifiers = new Set<string>();
  for (const variable of spec.stateVariables) {
    identifiers.add(variable.id);
    for (const value of variable.values) identifiers.add(value);
  }
  for (const prop of spec.propositions) identifiers.add(prop.id);
  for (const operation of spec.operations) {
    identifiers.add(operation.id);
    identifiers.add(operation.guardPredicate);
    identifiers.add(operation.outcome);
  }
  return identifiers;
}

/** 文の中に、英数字と _ で区切られた語として出てくる識別子（出てきた順、重ねない）。 */
export function leakedIdentifiers(text: string, identifiers: Set<string>): string[] {
  const found: string[] = [];
  for (const word of text.match(/[A-Za-z0-9_]+/g) ?? []) {
    if (identifiers.has(word) && !found.includes(word)) found.push(word);
  }
  return found;
}

export function issueTextCheck(identifiers: Set<string>): OutputCheck {
  return (text) => {
    const object = parseObject(text);
    if (object === null) return { ok: false, detail: "JSON のオブジェクトではない" };
    for (const key of KEYS) {
      const value = object[key];
      if (typeof value !== "string") return { ok: false, detail: `${key} が文字列ではない` };
      const trimmed = value.trim();
      if (trimmed.length === 0) return { ok: false, detail: `${key} が空` };
      if (trimmed.length > MAX_TEXT_LENGTH) return { ok: false, detail: `${key} が ${MAX_TEXT_LENGTH} 文字を超える（${trimmed.length} 文字）` };
      const leaked = leakedIdentifiers(trimmed, identifiers);
      if (leaked.length > 0) return { ok: false, detail: `${key} に形式仕様の識別子がある: ${leaked.join(", ")}` };
    }
    return { ok: true };
  };
}

function labelOf(spec: FormalSpecification, id: string): string | null {
  const label = spec.labels[id];
  return label !== undefined && label.status === "GENERATED" ? label.text : null;
}

function propsOf(expr: GuardExpr, into: Set<string>): void {
  switch (expr.op) {
    case "PROP":
      into.add(expr.prop);
      return;
    case "NOT":
      propsOf(expr.arg, into);
      return;
    case "AND":
    case "OR":
      for (const arg of expr.args) propsOf(arg, into);
      return;
    default:
      return;
  }
}

/** LLM への入力（機械的に決まる値だけ）。 */
export function issueInput(
  spec: FormalSpecification,
  issueId: string,
  findings: Finding[],
  root: number,
  dependents: number[],
  operationIds: string[],
): JsonValue {
  const rootFinding = findings[root] as Finding;
  const operations = spec.operations.filter((operation) => operationIds.includes(operation.id));
  operations.sort((a, b) => operationIds.indexOf(a.id) - operationIds.indexOf(b.id));

  const props = new Set<string>();
  const outcomes = new Set<string>(operations.map((operation) => operation.outcome));
  for (const step of rootFinding.trace ?? []) {
    for (const prop of step.holds) props.add(prop);
    if (step.outcome !== "Idle") outcomes.add(step.outcome);
  }
  for (const operation of operations) {
    for (const step of operation.steps) if (step.kind === "CONDITION") propsOf(step.expr, props);
  }

  return {
    issueId,
    scenarioId: spec.scenarioId,
    kind: rootFinding.kind,
    root: { kind: rootFinding.kind, operations: [...rootFinding.operations] },
    dependents: dependents.map((index) => {
      const finding = findings[index] as Finding;
      return { kind: finding.kind, operations: [...finding.operations] };
    }),
    trace:
      rootFinding.trace === null
        ? null
        : rootFinding.trace.map((step) => ({ index: step.index, values: { ...step.values }, outcome: step.outcome, holds: [...step.holds] })),
    vocabulary: {
      stateVariables: spec.stateVariables.map((variable) => ({
        id: variable.id,
        domain: variable.domain,
        label: labelOf(spec, variable.id),
        values: variable.values.map((value) => ({
          id: value,
          label: labelOf(spec, value),
          literal: variable.valueLiterals[value] ?? null,
        })),
      })),
      propositions: spec.propositions
        .filter((prop) => props.has(prop.id))
        .map((prop) => ({ id: prop.id, label: labelOf(spec, prop.id), expression: prop.expression })),
      operations: operations.map((operation) => ({
        id: operation.id,
        label: labelOf(spec, operation.id),
        outcome: operation.outcome,
        outletKind: operation.outletKind,
        conditions: operation.steps.flatMap((step) =>
          step.kind === "CONDITION" ? [{ expr: step.expr as unknown as JsonValue, holds: step.holds }] : [],
        ),
      })),
      outcomes: [...outcomes].sort().map((outcome) => ({ id: outcome, label: labelOf(spec, outcome) })),
    },
  };
}

const NO_LLM: LlmText = { status: "NOT_GENERATED", reason: "UNREACHABLE", detail: "LLM のポートが渡されていない" };

export async function writeIssueTexts(
  llm: LanguageModelPort | undefined,
  spec: FormalSpecification,
  input: JsonValue,
): Promise<IssueTexts> {
  const answer =
    llm === undefined
      ? NO_LLM
      : await llm.generate(
          { task: "m4.issue-text", promptVersion: M4_PROMPT_VERSION, instructions: INSTRUCTIONS, input },
          issueTextCheck(specIdentifiers(spec)),
        );
  if (answer.status !== "GENERATED") return { claim: answer, observation: answer, question: answer };
  const object = parseObject(answer.text);
  const result = {} as IssueTexts;
  for (const key of KEYS) {
    const value = object?.[key];
    result[key] =
      typeof value === "string"
        ? { status: "GENERATED", text: value.trim(), recordKey: answer.recordKey }
        : { status: "NOT_GENERATED", reason: "INVALID_OUTPUT", detail: `${key} が無い` };
  }
  return result;
}