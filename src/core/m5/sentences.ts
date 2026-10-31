// 操作の条件と書き込みを文にする（M5 の設計 3.2）。Alloy のソースは読まず、M2 が残した steps から作る。
//
// 条件の文は、その時点の値（それより前の書き込みを反映した値）についての文である。
// このため、呼び出し側は文を経路の順に並べ、並べ替えない。

import type { FormalSpecification, GuardExpr, OperationStep, StateVariable, WriteCondition } from "../../types/formal.js";
import { labelOf, valueText } from "./labels.js";

const CMP_TEXT: Readonly<Record<"EQ" | "NEQ" | "LT" | "LTE" | "GT" | "GTE", (n: string) => string>> = {
  EQ: (n) => `${n} と等しい`,
  NEQ: (n) => `${n} と等しくない`,
  LT: (n) => `${n} より小さい`,
  LTE: (n) => `${n} 以下`,
  GT: (n) => `${n} より大きい`,
  GTE: (n) => `${n} 以上`,
};

function variableOf(spec: FormalSpecification, id: string): StateVariable | undefined {
  return spec.stateVariables.find((variable) => variable.id === id);
}

function valueOf(spec: FormalSpecification, variableId: string, value: string | number): string {
  const variable = variableOf(spec, variableId);
  if (variable === undefined) return typeof value === "number" ? String(value) : labelOf(spec, value);
  return valueText(spec, variable, value);
}

/** 入れ子の中に置くときにかっこで囲むか。 */
function needsParens(expr: GuardExpr): boolean {
  return expr.op === "AND" || expr.op === "OR" || expr.op === "NOT";
}

export function guardText(spec: FormalSpecification, expr: GuardExpr): string {
  switch (expr.op) {
    case "PROP":
      return `${labelOf(spec, expr.prop)}が成り立つ`;
    case "IS":
      return `${labelOf(spec, expr.variable)}が${valueOf(spec, expr.variable, expr.value)}である`;
    case "CMP":
      return `${labelOf(spec, expr.variable)}が ${CMP_TEXT[expr.cmp](String(expr.value))}`;
    case "NOT": {
      const inner = guardText(spec, expr.arg);
      return `次が成り立たない: ${needsParens(expr.arg) ? `（${inner}）` : inner}`;
    }
    case "AND":
    case "OR": {
      const joiner = expr.op === "AND" ? "、かつ、" : "、または、";
      return expr.args
        .map((arg) => {
          const inner = guardText(spec, arg);
          return needsParens(arg) ? `（${inner}）` : inner;
        })
        .join(joiner);
    }
  }
}

/** holds が false の条件は、NOT と同じ形にする。 */
export function heldText(spec: FormalSpecification, expr: GuardExpr, holds: boolean): string {
  if (holds) return guardText(spec, expr);
  return guardText(spec, { op: "NOT", arg: expr });
}

function whenText(spec: FormalSpecification, when: WriteCondition[]): string {
  return when
    .map((term) => {
      const inner = heldText(spec, term.expr, term.holds);
      return when.length > 1 && (term.expr.op === "AND" || term.expr.op === "OR" || !term.holds) ? `（${inner}）` : inner;
    })
    .join("、かつ、");
}

export function stepText(spec: FormalSpecification, step: OperationStep): string {
  if (step.kind === "CONDITION") return heldText(spec, step.expr, step.holds);

  const variable = labelOf(spec, step.variable);
  let body: string;
  if (step.change.op === "SET") {
    body = `${variable}を${valueOf(spec, step.variable, step.change.value)}にする`;
  } else if (step.change.amount < 0) {
    body = `${variable}から ${String(-step.change.amount)} を引く`;
  } else {
    body = `${variable}に ${String(step.change.amount)} を足す`;
  }
  // 条件の文は「…が成り立たない」などで終わるので、かぎかっこで囲んでから「のとき」を付ける。
  return step.when.length === 0 ? body : `「${whenText(spec, step.when)}」のとき、${body}`;
}