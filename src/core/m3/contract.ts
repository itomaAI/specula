// M3 の入力の契約を確かめる（M3 の設計 1.2）。破れていれば SolverContractError。
//
// M3 は M2 の識別子をそのままコマンドの文に埋め込むので、識別子が Alloy の識別子の形であることも確かめる
// （原文の式を埋め込まないという全体設計の注入の防止を、M3 の側でも守るため）。

import type { FormalSpecification } from "../../types/formal.js";
import { SolverContractError } from "../../types/solver.js";

const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_]*$/;

export function checkSpecContract(spec: FormalSpecification): void {
  const fail = (reason: SolverContractError["reason"], detail: string): never => {
    throw new SolverContractError(spec.commandId, reason, detail);
  };

  if (spec.operations.length === 0) fail("NO_OPERATIONS", "operations が空");

  const identifiers: string[] = [];
  for (const variable of spec.stateVariables) {
    identifiers.push(variable.id, ...variable.values);
  }
  for (const prop of spec.propositions) identifiers.push(prop.id);
  for (const operation of spec.operations) identifiers.push(operation.id, operation.outcome, operation.guardPredicate);
  for (const identifier of identifiers) {
    if (!IDENTIFIER.test(identifier)) fail("INVALID_IDENTIFIER", JSON.stringify(identifier));
  }

  const lines = new Set(spec.source.split("\n").map((line) => line.trim()));
  for (const operation of spec.operations) {
    if (!lines.has(`pred ${operation.guardPredicate} {`)) {
      fail("MISSING_GUARD_PREDICATE", `${operation.id}: pred ${operation.guardPredicate} がソースに無い`);
    }
    if (!lines.has(`pred ${operation.id} {`)) {
      fail("MISSING_GUARD_PREDICATE", `${operation.id}: pred ${operation.id} がソースに無い`);
    }
  }

  const declared = new Set<string>();
  for (const line of lines) {
    const match = /^var ([A-Za-z][A-Za-z0-9_]*):/.exec(line);
    if (match) declared.add(match[1] as string);
  }
  for (const variable of spec.stateVariables) {
    if (!declared.has(variable.id)) fail("MISSING_STATE_VARIABLE", `${variable.id} が System のフィールドとしてソースに無い`);
  }
}