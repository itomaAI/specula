// エンジンの実例を、M2 の識別子でたどれる実行列に直す（M3 の設計 4.2。ReportNormalizer の前半）。
//
// RawInstance の各時点は「式 → 単項の組の並び」で、式は `System.outcome`・`System.v<n>`・`Env.holds`。
// 原子の名前の `$<数>`（Alloy が sig の原子に付ける番号）は外す。one sig なので原子は 1 つずつである。
// 形が想定と違えば InstanceShapeError（formal_solver が ENGINE_ERROR として扱う）。

import type { RawInstance } from "../../ports/SolverPort.js";
import type { FormalSpecification } from "../../types/formal.js";
import type { TraceStep } from "../../types/solver.js";

export class InstanceShapeError extends Error {
  constructor(detail: string) {
    super(`M3: エンジンの実例の形が想定と違う: ${detail}`);
    this.name = "InstanceShapeError";
  }
}

export function toTrace(spec: FormalSpecification, instance: RawInstance): TraceStep[] {
  if (instance.states.length === 0) throw new InstanceShapeError("時点が 0 個");
  const propIds = new Set(spec.propositions.map((prop) => prop.id));
  return instance.states.map((state, index) => {
    const single = (expression: string): string => {
      const tuples = state[expression];
      if (tuples === undefined) throw new InstanceShapeError(`時点 ${index} に ${expression} が無い`);
      if (tuples.length !== 1 || tuples[0]?.length !== 1) {
        throw new InstanceShapeError(`時点 ${index} の ${expression} が 1 つの原子でない: ${JSON.stringify(tuples)}`);
      }
      return atomName(tuples[0][0] as string);
    };
    const values: Record<string, string | number> = {};
    for (const variable of spec.stateVariables) {
      const text = single(`System.${variable.id}`);
      if (variable.domain === "INT") {
        const number = Number(text);
        if (!Number.isInteger(number)) throw new InstanceShapeError(`時点 ${index} の ${variable.id} が整数でない: ${text}`);
        values[variable.id] = number;
      } else {
        values[variable.id] = text;
      }
    }
    const outcome = single("System.outcome");
    const holdsTuples = state["Env.holds"];
    if (holdsTuples === undefined) throw new InstanceShapeError(`時点 ${index} に Env.holds が無い`);
    const holds = holdsTuples.map((tuple) => {
      if (tuple.length !== 1) throw new InstanceShapeError(`時点 ${index} の Env.holds の組が単項でない`);
      const name = atomName(tuple[0] as string);
      if (!propIds.has(name)) throw new InstanceShapeError(`時点 ${index} の Env.holds に知らない命題: ${name}`);
      return name;
    });
    holds.sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
    return { index, values, outcome, holds };
  });
}

export function atomName(atom: string): string {
  return atom.replace(/\$\d+$/, "");
}