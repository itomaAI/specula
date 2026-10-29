// Alloy 6 のソースを書く（M2 の設計 3・4.1）。同じ入力からは 1 バイトも違わないソースになる。
//
// 並び: モジュール宣言 → Bool → 値の sig → Prop → Outcome → System・Env → Init → 述語（op<n>_guard の直後に op<n>）
//       → stutter → Steps。各要素の直上に `-- @source: <ユニットの識別子>`（複数なら空白区切り）を書く。
//
// 決めたこと（設計 02 に書く）:
// - 経路は記号的にたどる。各状態変数の「いまの値の式」を System.v<n> から始め、書き込みのたびに置き換える。
//   条件はその時点の式で書くので、op<n>_guard はプライムを含まない（いまの状態と Env.holds だけで書ける）。
// - 条件つきの書き込み（when）は `(when) => (新しい値) else (いまの値)`。ADD は plus・minus。
// - 真と偽の定数は `(no none)`・`(some none)`（AND の引数が空なら真、OR が空なら偽）。
// - 負の整数はリテラル（`-8`）で書く。`minus[0, n]` は最小の整数で範囲の外の n を使い、あふれを禁じると充足できない。
// - Bool と Prop は、使われていなくても必ず宣言する（ソースの形を入力によらず一定にするため）。
//   命題が無いときは `fact NoProp { no Prop }` を足す（子の無い abstract sig は空に制約されないため）。

import type { UseCaseSlice } from "../../types/context.js";
import type { GuardExpr, Operation, Proposition, StateVariable } from "../../types/formal.js";

export interface AlloyInput {
  stateVariables: StateVariable[];
  propositions: Proposition[];
  operations: Operation[];
  slices: UseCaseSlice[];
}

export interface AlloyOutput {
  source: string;
  /** Alloy の識別子 → ユニットの識別子。 */
  sourceMap: Record<string, string[]>;
}

const TRUE = "(no none)";
const FALSE = "(some none)";

export function printAlloy(input: AlloyInput): AlloyOutput {
  const lines: string[] = [];
  const sourceMap: Record<string, string[]> = {};
  const source = (id: string, unitIds: string[]): void => {
    sourceMap[id] = [...unitIds];
    lines.push(`-- @source: ${unitIds.join(" ")}`);
  };
  const indent = (id: string, unitIds: string[]): void => {
    sourceMap[id] = [...unitIds];
    lines.push(`  -- @source: ${unitIds.join(" ")}`);
  };

  lines.push("module specula_m2", "");
  lines.push("abstract sig Bool {}", "one sig True, False extends Bool {}", "");

  for (const variable of input.stateVariables) {
    if (variable.domain !== "ENUM") continue;
    lines.push(`abstract sig ${sigName(variable)} {}`);
    for (const value of variable.values) {
      source(value, [variable.unitId]);
      lines.push(`one sig ${value} extends ${sigName(variable)} {}`);
    }
    lines.push("");
  }

  lines.push("abstract sig Prop {}");
  for (const prop of input.propositions) {
    source(prop.id, [prop.unitId]);
    lines.push(`one sig ${prop.id} extends Prop {}`);
  }
  // 子の無い abstract sig は空に制約されないので、命題が無いときは空と書く（Env.holds に知らない原子が入らないように）。
  if (input.propositions.length === 0) lines.push("fact NoProp { no Prop }");
  lines.push("");

  lines.push("abstract sig Outcome {}", "one sig Idle extends Outcome {}");
  input.operations.forEach((operation, index) => {
    const slice = input.slices[index] as UseCaseSlice;
    source(operation.outcome, [slice.outlet.unitId]);
    lines.push(`one sig ${operation.outcome} extends Outcome {}`);
  });
  lines.push("");

  lines.push("one sig System {");
  lines.push(`  var outcome: one Outcome${input.stateVariables.length > 0 ? "," : ""}`);
  input.stateVariables.forEach((variable, index) => {
    indent(variable.id, [variable.unitId]);
    const comma = index < input.stateVariables.length - 1 ? "," : "";
    lines.push(`  var ${variable.id}: one ${typeOf(variable)}${comma}`);
  });
  lines.push("}", "", "one sig Env {", "  var holds: set Prop", "}", "");

  lines.push("fact Init {", "  System.outcome = Idle");
  for (const variable of input.stateVariables) {
    if (variable.initial === null) continue;
    lines.push(`  System.${variable.id} = ${valueText(variable, variable.initial)}`);
  }
  lines.push("}", "");

  const byId = new Map(input.stateVariables.map((variable) => [variable.id, variable]));
  input.operations.forEach((operation, index) => {
    const slice = input.slices[index] as UseCaseSlice;
    const { guards, finals } = walk(operation, byId);
    source(operation.guardPredicate, slice.conditions.map((condition) => condition.unitId));
    lines.push(`pred ${operation.guardPredicate} {`);
    if (guards.length === 0) lines.push(`  ${TRUE}`);
    for (const guard of guards) lines.push(`  ${guard}`);
    lines.push("}", "");

    source(operation.id, slice.unitIds);
    lines.push(`pred ${operation.id} {`, `  ${operation.guardPredicate}`);
    for (const variable of input.stateVariables) {
      const final = finals.get(variable.id) ?? `System.${variable.id}`;
      lines.push(`  System.${variable.id}' = ${final}`);
    }
    lines.push(`  System.outcome' = ${operation.outcome}`, "}", "");
  });

  lines.push("pred stutter {", "  System.outcome' = System.outcome");
  for (const variable of input.stateVariables) lines.push(`  System.${variable.id}' = System.${variable.id}`);
  lines.push("}", "");

  const alternatives = [...input.operations.map((operation) => operation.id), "stutter"];
  lines.push("fact Steps {", `  always (${alternatives.join(" or ")})`, "}", "");

  return { source: lines.join("\n"), sourceMap };
}

function sigName(variable: StateVariable): string {
  return `V${variable.id.slice(1)}`;
}

function typeOf(variable: StateVariable): string {
  if (variable.domain === "BOOL") return "Bool";
  if (variable.domain === "INT") return "Int";
  return sigName(variable);
}

function intText(value: number): string {
  return String(value);
}

function valueText(variable: StateVariable, value: string | number): string {
  if (variable.domain === "INT") return intText(typeof value === "number" ? value : Number(value));
  return String(value);
}

/**
 * 経路をたどり、条件の式（その時点の値で書いたもの）と、各変数の最後の値の式を返す。
 * 書き込みの条件（when）の各項は、その条件のユニットを持つ最初の書き込みの直前の値で評価する。
 * 枝の条件は枝の中のどの書き込みよりも前に評価されるので、枝の中で同じ変数を 2 度書いても、
 * 2 度目の条件が 1 度目の書き込みの後の値で評価されることはない。
 */
function walk(operation: Operation, byId: ReadonlyMap<string, StateVariable>): { guards: string[]; finals: Map<string, string> } {
  const current = new Map<string, string>();
  const valueIn = (values: ReadonlyMap<string, string>) => (id: string): string => values.get(id) ?? `System.${id}`;
  const now = valueIn(current);
  const snapshots = new Map<string, ReadonlyMap<string, string>>();
  const guards: string[] = [];
  for (const step of operation.steps) {
    if (step.kind === "CONDITION") {
      const text = render(step.expr, now);
      guards.push(step.holds ? text : `(not ${text})`);
      continue;
    }
    const variable = byId.get(step.variable) as StateVariable;
    const before = now(step.variable);
    const after =
      step.change.op === "ADD"
        ? step.change.amount >= 0
          ? `plus[${before}, ${step.change.amount}]`
          : `minus[${before}, ${-step.change.amount}]`
        : valueText(variable, step.change.value);
    const terms = step.when.map((term) => {
      let snapshot = snapshots.get(term.unitId);
      if (snapshot === undefined) {
        snapshot = new Map(current);
        snapshots.set(term.unitId, snapshot);
      }
      const text = render(term.expr, valueIn(snapshot));
      return term.holds ? text : `(not ${text})`;
    });
    if (terms.length === 0) {
      current.set(step.variable, after);
    } else {
      const condition = terms.length === 1 ? (terms[0] as string) : `(${terms.join(" and ")})`;
      current.set(step.variable, `(${condition} => ${after} else ${before})`);
    }
  }
  return { guards, finals: current };
}

const CMP_TEXT = { eq: "=", neq: "!=", lt: "<", lte: "=<", gt: ">", gte: ">=" } as const;

function render(expr: GuardExpr, now: (id: string) => string): string {
  switch (expr.op) {
    case "PROP":
      return `(${expr.prop} in Env.holds)`;
    case "IS":
      return `(${now(expr.variable)} = ${expr.value})`;
    case "CMP":
      return `(${now(expr.variable)} ${CMP_TEXT[expr.cmp]} ${intText(expr.value)})`;
    case "NOT":
      return `(not ${render(expr.arg, now)})`;
    case "AND":
      return expr.args.length === 0 ? TRUE : `(${expr.args.map((arg) => render(arg, now)).join(" and ")})`;
    case "OR":
      return expr.args.length === 0 ? FALSE : `(${expr.args.map((arg) => render(arg, now)).join(" or ")})`;
  }
}