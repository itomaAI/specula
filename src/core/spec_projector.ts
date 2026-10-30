// M5: SpecProjector（M5 の設計 1.2・1.3）。
//
// 形式仕様正本と論点カタログから、人が読むビューを決定論的に作る。LLM は呼ばない。ファイルの読み書きもしない。
// 流れ: ContractGuard → ViewModelBuilder（中間表現 1 つ）→ 描画（仕様書・操作の一覧表・操作の流れ図）。
// 全体の俯瞰図は、シナリオの単位では作れない図なので、別の関数にする。
// 表示の役割（PdM・Eng）と表示の id（S-01）は request で受け取る（全体設計 2.2、設計 8.3）。

import { sha256Hex } from "../lib/sha256.js";
import type { AmbiguityReport, FormalSpecification } from "../types/formal.js";
import type { Glossary } from "../types/glossary.js";
import type { IntentCatalog } from "../types/intent.js";
import type { DomainLedgerCatalog } from "../types/ledger.js";
import type {
  AmbiguityProjectionRequest,
  ProjectionContext,
  ProjectionRequest,
  SpecificationView,
  SystemProjectionRequest,
} from "../types/projection.js";
import { ProjectionContractError } from "../types/projection.js";
import type { EventStormingMap } from "../types/scenario.js";
import { mapHashOf } from "./glossary_builder.js";
import { checkAmbiguityContract, checkProjectionContract, isViewRole } from "./m5/contract.js";
import { renderAmbiguities } from "./m5/render_ambiguities.js";
import { renderDocument } from "./m5/render_document.js";
import { renderFlow } from "./m5/render_flow.js";
import { renderMatrix } from "./m5/render_matrix.js";
import { renderSystemJson, renderSystemMermaid } from "./m5/render_system.js";
import { buildViewModel } from "./m5/view_model.js";

export async function projectSpecification(
  spec: FormalSpecification,
  ledger: DomainLedgerCatalog | null,
  context: ProjectionContext,
  request: ProjectionRequest,
): Promise<SpecificationView> {
  checkProjectionContract(spec, ledger, context, request);
  const specSourceHash = await sha256Hex(spec.source);
  const model = buildViewModel(spec, ledger, specSourceHash, context, request);

  let content: string;
  let mediaType: SpecificationView["mediaType"];
  switch (request.format) {
    case "DOCUMENT":
      content = renderDocument(model);
      mediaType = "text/markdown";
      break;
    case "MATRIX":
      content = renderMatrix(model);
      mediaType = "text/markdown";
      break;
    case "FLOW":
      content = renderFlow(model);
      mediaType = "text/vnd.mermaid";
      break;
  }

  return {
    scenarioId: spec.scenarioId,
    displayId: request.displayId,
    viewRole: request.viewRole,
    format: request.format,
    mediaType,
    content,
    basis: {
      specSourceHash,
      ledgerReportId: model.ledgerReportId,
      ledgerIsStale: model.ledgerIsStale,
    },
  };
}

/**
 * FormalTranspiler の曖昧さの報告から、曖昧さの一覧を作る（設計 1.2・8.4）。
 * 形式仕様も論点カタログも無いので、basis はすべて null。ほかの射影とそろえて非同期にしている。
 */
export async function projectAmbiguities(
  report: AmbiguityReport,
  context: ProjectionContext,
  request: AmbiguityProjectionRequest,
): Promise<SpecificationView> {
  checkAmbiguityContract(report, context, request);
  return {
    scenarioId: report.scenarioId,
    displayId: request.displayId,
    viewRole: request.viewRole,
    format: request.format,
    mediaType: "text/markdown",
    content: renderAmbiguities(report, context, request),
    basis: { specSourceHash: null, ledgerReportId: null, ledgerIsStale: null },
  };
}

/**
 * 全体マップと辞書から俯瞰図を作る（設計 4.4）。
 * 辞書が別の全体マップから作られていたら GLOSSARY_STALE（設計 7.7・8.1）。
 * 意図の候補の一覧が別の辞書から作られていたとき（basis が辞書の basis と違うとき）も GLOSSARY_STALE にする。
 * 一覧は辞書の basis をそのまま写すので、違えば別の実行の一覧を渡している（IntentSynthesizer の設計 3）。
 */
export async function projectSystemMap(
  map: EventStormingMap,
  glossary: Glossary,
  intents: IntentCatalog | null,
  request: SystemProjectionRequest,
): Promise<SpecificationView> {
  if (request.format !== "SYSTEM_MERMAID" && request.format !== "SYSTEM_JSON") {
    throw new ProjectionContractError("(system)", "UNSUPPORTED_FORMAT", String(request.format));
  }
  if (!isViewRole(request.viewRole)) {
    throw new ProjectionContractError("(system)", "UNSUPPORTED_FORMAT", `表示の役割: ${String(request.viewRole)}`);
  }
  const mapHash = await mapHashOf(map);
  if (glossary.basis.mapHash !== mapHash) {
    throw new ProjectionContractError(
      "(system)",
      "GLOSSARY_STALE",
      `辞書の mapHash ${glossary.basis.mapHash} が全体マップの ${mapHash} と違う`,
    );
  }
  if (
    intents !== null &&
    (intents.basis.mapHash !== glossary.basis.mapHash || intents.basis.documentsHash !== glossary.basis.documentsHash)
  ) {
    throw new ProjectionContractError("(system)", "GLOSSARY_STALE", "意図の候補の一覧の basis が辞書の basis と違う");
  }
  let content: string;
  let mediaType: SpecificationView["mediaType"];
  if (request.format === "SYSTEM_MERMAID") {
    content = renderSystemMermaid(map, glossary, intents, request.viewRole);
    mediaType = "text/vnd.mermaid";
  } else {
    content = renderSystemJson(map, glossary, intents, request.viewRole);
    mediaType = "application/json";
  }
  return {
    scenarioId: null,
    displayId: null,
    viewRole: request.viewRole,
    format: request.format,
    mediaType,
    content,
    basis: { specSourceHash: null, ledgerReportId: null, ledgerIsStale: null },
  };
}