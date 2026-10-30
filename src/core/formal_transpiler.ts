// M2（FormalTranspiler）: RawContextModel から Alloy 6 の FormalSpecification か AmbiguityReport を作る（M2 の設計 1.3）。
// ファイルを読み書きしない。LLM は表示名と質問の文にだけ使い、ソースは LLM の結果によらず同じ入力から同じものになる。

import type { ConfirmationStatus, LlmText } from "../types/index.js";
import type { RawContextModel } from "../types/context.js";
import type { FormalSpecification, TranspilerResult } from "../types/formal.js";
import type { LanguageModelPort } from "../ports/LanguageModelPort.js";
import { collectAmbiguity } from "./m2/ambiguity.js";
import { printAlloy } from "./m2/alloy.js";
import { checkContract } from "./m2/contract.js";
import { translateGuards } from "./m2/guards.js";
import { type VocabularyItem, askQuestions, labelVocabulary } from "./m2/labels.js";
import { translatePaths } from "./m2/paths.js";
import { buildStates } from "./m2/states.js";

export { M2_PROMPT_VERSION } from "./m2/labels.js";

/**
 * @param deps.llm 無ければ表示名と質問の文は NOT_GENERATED（UNREACHABLE）になる。
 * @param previous 前版の正本。差分は現在の範囲外なので使わない（null なら FIRST_RUN、そうでなければ OUT_OF_SCOPE）。
 * @throws TranspileContractError M1 の契約が破れているとき。
 */
export async function transpileFormal(
  facts: RawContextModel,
  deps: { llm?: LanguageModelPort },
  previous?: FormalSpecification | null,
): Promise<TranspilerResult> {
  const checked = checkContract(facts);
  const states = buildStates(checked);
  const guards = translateGuards(checked, states);
  const paths = translatePaths(checked, states, guards);
  const collected = collectAmbiguity(checked, states, paths);

  if (collected.issues.length > 0) {
    const questions = await askQuestions(deps.llm, facts.scenarioId, collected.issues);
    return {
      kind: "AMBIGUITY",
      report: {
        scenarioId: facts.scenarioId,
        issues: collected.issues.map((issue, index) => {
          const question = questions[index] as (typeof questions)[number];
          return { ...issue, question, questionStatus: statusOf(question) };
        }),
        counts: collected.counts,
      },
    };
  }

  const stateVariables = states.states.map((state) => state.variable);
  const { source, sourceMap } = printAlloy({
    stateVariables,
    propositions: guards.propositions,
    operations: paths.operations,
    slices: facts.slices,
  });

  const items: VocabularyItem[] = [];
  for (const state of states.states) {
    items.push({ id: state.variable.id, kind: "STATE_VARIABLE", name: state.unit.name, expression: initialText(state.unit.details) });
    for (const value of state.literals) {
      items.push({ id: value.id, kind: "VALUE", name: state.unit.name, expression: value.literal.text });
    }
    if (state.unknownId !== null) {
      items.push({ id: state.unknownId, kind: "VALUE", name: state.unit.name, expression: "(初期値が決まらない)" });
    }
  }
  for (const prop of guards.propositions) {
    const unit = checked.units.get(prop.unitId);
    items.push({ id: prop.id, kind: "PROPOSITION", name: unit?.componentScope ?? "", expression: prop.expression });
  }
  paths.operations.forEach((operation, index) => {
    const slice = facts.slices[index];
    const outlet = slice === undefined ? undefined : checked.units.get(slice.outlet.unitId);
    const scope = outlet?.componentScope ?? "";
    const conditions = slice === undefined ? "" : slice.conditions.map((c) => `${c.holds ? "" : "!"}(${c.expression})`).join(" && ");
    items.push({ id: operation.id, kind: "OPERATION", name: scope, expression: conditions });
    items.push({ id: operation.outcome, kind: "OUTCOME", name: `${operation.outletKind} ${scope}`.trim(), expression: outlet?.name ?? "" });
  });
  const labels = await labelVocabulary(deps.llm, facts.scenarioId, items);
  const labelStatus: Record<string, ConfirmationStatus> = {};
  for (const [id, label] of Object.entries(labels)) labelStatus[id] = statusOf(label);

  return {
    kind: "SPEC",
    spec: {
      scenarioId: facts.scenarioId,
      source,
      stateVariables,
      propositions: guards.propositions,
      operations: paths.operations,
      sourceMap,
      labels,
      labelStatus,
      previousDiff: { status: "NOT_COMPUTED", reason: previous === undefined || previous === null ? "FIRST_RUN" : "OUT_OF_SCOPE" },
    },
  };
}

function initialText(details: Record<string, string | number | boolean | null> | undefined): string {
  const initial = details?.["initial"];
  return typeof initial === "string" ? initial : "";
}

/** 確定の状態。確定の操作は無いので、書くのは NOT_GENERATED と CANDIDATE だけ（M2 の設計 6。GlossaryBuilder・IntentSynthesizer と同じ規則）。 */
function statusOf(text: LlmText): ConfirmationStatus {
  return text.status === "GENERATED" ? "CANDIDATE" : "NOT_GENERATED";
}