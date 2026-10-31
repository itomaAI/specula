// M4 の入力の契約を確かめる（M4 の設計 1.2）。破れていれば LedgerContractError。
//
// - 報告と形式仕様が同じシナリオのものであること。
// - 報告が元にした形式仕様のソースが、渡された形式仕様のソースと同じ版であること（SHA-256 で比べる）。
// - 反例が指す操作と、実行列の状態変数が、形式仕様にあること（M5 が表示名を引けなくならないように）。

import { sha256Hex } from "../../lib/sha256.js";
import type { FormalSpecification } from "../../types/formal.js";
import { LedgerContractError } from "../../types/ledger.js";
import type { SolverReport } from "../../types/solver.js";

export async function checkLedgerContract(report: SolverReport, spec: FormalSpecification): Promise<void> {
  const fail = (reason: LedgerContractError["reason"], detail: string): never => {
    throw new LedgerContractError(report.commandId, reason, detail);
  };

  if (report.commandId !== spec.commandId) {
    fail("COMMAND_MISMATCH", `報告は ${report.commandId}、形式仕様は ${spec.commandId}`);
  }

  const hash = await sha256Hex(spec.source);
  if (report.specSourceHash !== hash) {
    fail("SPEC_HASH_MISMATCH", `報告は ${report.specSourceHash}、形式仕様のソースは ${hash}`);
  }

  const operations = new Set(spec.operations.map((operation) => operation.id));
  const variables = new Set(spec.stateVariables.map((variable) => variable.id));
  report.findings.forEach((finding, index) => {
    for (const operation of finding.operations) {
      if (!operations.has(operation)) fail("UNKNOWN_OPERATION", `findings[${index}]: ${operation}`);
    }
    for (const step of finding.trace ?? []) {
      for (const variable of Object.keys(step.values)) {
        if (!variables.has(variable)) fail("UNKNOWN_STATE_VARIABLE", `findings[${index}] の時点 ${step.index}: ${variable}`);
      }
    }
  });
}