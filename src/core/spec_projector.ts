// M5: SpecProjector（M5 の設計 1.2・1.3）。
//
// 形式仕様正本と論点カタログから、人が読むビューを決定論的に作る。LLM は呼ばない。ファイルの読み書きもしない。
// 流れ: ContractGuard → ViewModelBuilder（中間表現 1 つ）→ 描画（仕様書・操作の一覧表・操作の流れ図）。
// 全体の俯瞰図は、シナリオの単位では作れない図なので、別の関数にする。

import { sha256Hex } from "../lib/sha256.js";
import type { FormalSpecification } from "../types/formal.js";
import type { DomainLedgerCatalog } from "../types/ledger.js";
import type { ProjectionRequest, SpecificationView, SystemProjectionRequest } from "../types/projection.js";
import { ProjectionContractError } from "../types/projection.js";
import type { EventStormingMap } from "../types/scenario.js";
import { checkProjectionContract } from "./m5/contract.js";
import { renderDocument } from "./m5/render_document.js";
import { renderFlow } from "./m5/render_flow.js";
import { renderMatrix } from "./m5/render_matrix.js";
import { renderSystemJson, renderSystemMermaid } from "./m5/render_system.js";
import { buildViewModel } from "./m5/view_model.js";

export async function projectSpecification(
  spec: FormalSpecification,
  ledger: DomainLedgerCatalog | null,
  request: ProjectionRequest,
): Promise<SpecificationView> {
  checkProjectionContract(spec, ledger, request);
  const specSourceHash = await sha256Hex(spec.source);
  const model = buildViewModel(spec, ledger, specSourceHash);

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

export function projectSystemMap(map: EventStormingMap, request: SystemProjectionRequest): SpecificationView {
  let content: string;
  let mediaType: SpecificationView["mediaType"];
  if (request.format === "SYSTEM_MERMAID") {
    content = renderSystemMermaid(map);
    mediaType = "text/vnd.mermaid";
  } else if (request.format === "SYSTEM_JSON") {
    content = renderSystemJson(map);
    mediaType = "application/json";
  } else {
    throw new ProjectionContractError("(system)", "UNSUPPORTED_FORMAT", String(request.format));
  }
  return {
    scenarioId: null,
    format: request.format,
    mediaType,
    content,
    basis: { specSourceHash: null, ledgerReportId: null, ledgerIsStale: null },
  };
}