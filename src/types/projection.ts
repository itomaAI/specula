// M5（SpecProjector）の入出力の型（M5 の設計 5）。

/** シナリオ 1 つのビューの形式。 */
export type ScenarioViewFormat = "DOCUMENT" | "MATRIX" | "FLOW";

/** 全体の俯瞰図の形式。 */
export type SystemViewFormat = "SYSTEM_MERMAID" | "SYSTEM_JSON";

export interface ProjectionRequest {
  format: ScenarioViewFormat;
}

export interface SystemProjectionRequest {
  format: SystemViewFormat;
}

export interface SpecificationView {
  /** 全体の俯瞰図は null。 */
  scenarioId: string | null;
  format: ScenarioViewFormat | SystemViewFormat;
  mediaType: "text/markdown" | "text/vnd.mermaid" | "application/json";
  /** 改行は "\n"、末尾は改行 1 つ。 */
  content: string;
  basis: {
    /** いまの正本のソースの SHA-256。全体の俯瞰図は null。 */
    specSourceHash: string | null;
    /** 元にした論点カタログの basis.reportId。カタログが無ければ null。 */
    ledgerReportId: string | null;
    /** カタログが古いか（M5 の設計 3.3）。カタログが無ければ null。 */
    ledgerIsStale: boolean | null;
  };
}

/**
 * 形式仕様と論点カタログの組が契約を破っている（M5 の設計 1.2）。
 * カタログが古いことは契約違反ではない（ビューの中で知らせる）。
 */
export class ProjectionContractError extends Error {
  constructor(
    readonly scenarioId: string,
    readonly reason:
      | "SCENARIO_MISMATCH"
      | "UNKNOWN_OPERATION"
      | "UNKNOWN_STATE_VARIABLE"
      | "UNSUPPORTED_FORMAT"
      // 辞書の basis.mapHash が、受け取った全体マップのハッシュと違う（SpecProjector の設計 7.7・8.1）
      | "GLOSSARY_STALE",
    readonly detail: string,
  ) {
    super(`M5 の入力の契約が破れている（${scenarioId}）: ${reason}: ${detail}`);
    this.name = "ProjectionContractError";
  }
}