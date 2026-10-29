// 検査の一覧とコマンドの文（M3 の設計 2.2〜2.4。CheckPlanner と CommandPrinter）。
//
// 並び: COVER → OVERLAP（操作の組を番号の小さい順）→ REACH（操作の順）。ESCAPE は COVER の反例から後で作る。
// コマンドに埋め込むのは M2 が機械的に作った識別子と整数だけ（原文の式を埋め込まない）。
// M2 のソースは書き換えず、検査 1 件ごとに、ソースの後ろにそのコマンド 1 つだけを足して渡す。

import type { FormalSpecification, StateVariable } from "../../types/formal.js";
import type { CheckKind } from "../../types/solver.js";

export const SCOPE = 3;

export interface PlannedCheck {
  id: string;
  kind: CheckKind;
  targets: string[];
  /** "check" は反例を、"run" は実例を探す。 */
  verb: "check" | "run";
  /** コマンドの本体（`{ … }` の中身）。 */
  body: string;
  /** COVER は false（反例は 1 件目だけ）。 */
  exhaustive: boolean;
}

const TRUE = "(no none)";

export function planChecks(spec: FormalSpecification): PlannedCheck[] {
  const operations = spec.operations;
  const checks: PlannedCheck[] = [];
  checks.push({
    id: "m3_cover",
    kind: "COVER",
    targets: operations.map((operation) => operation.id),
    verb: "check",
    body: `always (${anyGuard(spec)})`,
    exhaustive: false,
  });
  for (let i = 0; i < operations.length; i++) {
    for (let j = i + 1; j < operations.length; j++) {
      const a = operations[i] as FormalSpecification["operations"][number];
      const b = operations[j] as FormalSpecification["operations"][number];
      checks.push({
        id: `m3_overlap_${a.id}_${b.id}`,
        kind: "OVERLAP",
        targets: [a.id, b.id],
        verb: "check",
        body: `always not (${a.guardPredicate} and ${b.guardPredicate})`,
        exhaustive: true,
      });
    }
  }
  for (const operation of operations) {
    checks.push({
      id: `m3_reach_${operation.id}`,
      kind: "REACH",
      targets: [operation.id],
      verb: "run",
      body: `eventually ${operation.id}`,
      exhaustive: true,
    });
  }
  return checks;
}

/** COVER の n 件目の反例の状態（状態変数の値の組）から抜け出せるかの検査（M3 の設計 2.2 の 4・2.3）。 */
export function planEscape(spec: FormalSpecification, n: number, values: Record<string, string | number>): PlannedCheck {
  return {
    id: `m3_escape_${n}`,
    kind: "ESCAPE",
    targets: spec.operations.map((operation) => operation.id),
    verb: "run",
    body: `eventually (${stateCondition(spec.stateVariables, values)} and (${anyGuard(spec)}))`,
    exhaustive: true,
  };
}

/** `System.v1 = True and System.v3 = 2` の形。出口（outcome）は入れない。 */
export function stateCondition(variables: StateVariable[], values: Record<string, string | number>): string {
  const terms: string[] = [];
  for (const variable of variables) {
    const value = values[variable.id];
    if (value === undefined) throw new Error(`M3: 状態の値に ${variable.id} が無い`);
    terms.push(`System.${variable.id} = ${valueText(variable, value)}`);
  }
  return terms.length === 0 ? TRUE : terms.join(" and ");
}

/** M2 のソースの後ろに、このコマンド 1 つだけを足したもの。 */
export function commandSource(spec: FormalSpecification, check: PlannedCheck, steps: number, bitwidth: number): string {
  const command = `${check.verb} ${check.id} {\n  ${check.body}\n} for ${SCOPE} but ${bitwidth} Int, 1..${steps} steps`;
  return `${spec.source.replace(/\n*$/, "")}\n\n-- M3\n${command}\n`;
}

function anyGuard(spec: FormalSpecification): string {
  return spec.operations.map((operation) => operation.guardPredicate).join(" or ");
}

function valueText(variable: StateVariable, value: string | number): string {
  if (variable.domain === "INT") {
    const number = typeof value === "number" ? value : Number(value);
    if (!Number.isInteger(number)) throw new Error(`M3: ${variable.id} の値が整数でない: ${String(value)}`);
    return number >= 0 ? String(number) : `minus[0, ${-number}]`;
  }
  const text = String(value);
  if (variable.domain === "BOOL" ? text !== "True" && text !== "False" : !variable.values.includes(text)) {
    throw new Error(`M3: ${variable.id} の値が値の識別子でない: ${text}`);
  }
  return text;
}