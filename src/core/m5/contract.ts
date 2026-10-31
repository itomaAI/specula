// M5 の入力の契約を確かめる（M5 の設計 1.2・7.7、仕様 3.1）。破れていれば ProjectionContractError。
//
// - 表現形式が DOCUMENT・MATRIX・FLOW のどれかで、表示の役割が BUSINESS・IMPLEMENTATION のどちらかであること。
// - context.commandTarget と論点カタログのコマンドが、形式仕様のコマンドと同じであること。
// - 論点が指す操作と、論点の実行列の状態変数が、形式仕様にあること（表示名を引けなくならないように）。
// カタログが古いこと（ソースの SHA-256 が違うこと）は契約違反ではない。ビューの先頭で知らせる（設計 3.3）。

import type { AmbiguityReport, FormalSpecification } from "../../types/formal.js";
import type { DomainLedgerCatalog } from "../../types/ledger.js";
import {
  ProjectionContractError,
  type AmbiguityProjectionRequest,
  type ProjectionContext,
  type ProjectionRequest,
  type ViewRole,
} from "../../types/projection.js";

const COMMAND_FORMATS: readonly string[] = ["DOCUMENT", "MATRIX", "FLOW"];
const VIEW_ROLES: readonly string[] = ["BUSINESS", "IMPLEMENTATION"] satisfies readonly ViewRole[];

/** 表示の役割が BUSINESS・IMPLEMENTATION のどちらかであること。俯瞰図の射影からも使う。 */
export function isViewRole(value: unknown): value is ViewRole {
  return typeof value === "string" && VIEW_ROLES.includes(value);
}

export function checkProjectionContract(
  spec: FormalSpecification,
  ledger: DomainLedgerCatalog | null,
  context: ProjectionContext,
  request: ProjectionRequest,
): void {
  const fail = (reason: ProjectionContractError["reason"], detail: string): never => {
    throw new ProjectionContractError(spec.commandId, reason, detail);
  };

  if (!COMMAND_FORMATS.includes(request.format)) {
    fail("UNSUPPORTED_FORMAT", String(request.format));
  }
  if (!isViewRole(request.viewRole)) {
    fail("UNSUPPORTED_FORMAT", `表示の役割: ${String(request.viewRole)}`);
  }

  if (context.commandTarget.id !== spec.commandId) {
    fail("COMMAND_MISMATCH", `context のコマンドは ${context.commandTarget.id}、形式仕様は ${spec.commandId}`);
  }

  if (ledger === null) return;

  if (ledger.commandId !== spec.commandId) {
    fail("COMMAND_MISMATCH", `カタログは ${ledger.commandId}、形式仕様は ${spec.commandId}`);
  }

  const operations = new Set(spec.operations.map((operation) => operation.id));
  const variables = new Set(spec.stateVariables.map((variable) => variable.id));
  for (const issue of ledger.issues) {
    for (const operation of issue.operations) {
      if (!operations.has(operation)) fail("UNKNOWN_OPERATION", `${issue.id}: ${operation}`);
    }
    for (const step of issue.trace ?? []) {
      for (const variable of Object.keys(step.values)) {
        if (!variables.has(variable)) fail("UNKNOWN_STATE_VARIABLE", `${issue.id} の時点 ${step.index}: ${variable}`);
      }
    }
  }
}

/**
 * 曖昧さの一覧の入力の契約（設計 7.7・8.4）。
 * 表現形式が AMBIGUITY_DOCUMENT で、表示の役割が BUSINESS・IMPLEMENTATION のどちらかで、context のコマンドが報告のコマンドと同じであること。
 */
export function checkAmbiguityContract(
  report: AmbiguityReport,
  context: ProjectionContext,
  request: AmbiguityProjectionRequest,
): void {
  const fail = (reason: ProjectionContractError["reason"], detail: string): never => {
    throw new ProjectionContractError(report.commandId, reason, detail);
  };

  if (request.format !== "AMBIGUITY_DOCUMENT") {
    fail("UNSUPPORTED_FORMAT", String(request.format));
  }
  if (!isViewRole(request.viewRole)) {
    fail("UNSUPPORTED_FORMAT", `表示の役割: ${String(request.viewRole)}`);
  }
  if (context.commandTarget.id !== report.commandId) {
    fail("COMMAND_MISMATCH", `context のコマンドは ${context.commandTarget.id}、曖昧さの報告は ${report.commandId}`);
  }
}