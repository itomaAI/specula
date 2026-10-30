// M5（SpecProjector）の入出力の型（M5 の設計 5）。

import type { Glossary } from "./glossary.js";
import type { IntentCatalog } from "./intent.js";
import type { ScenarioTarget } from "./scenario.js";

/** シナリオ 1 つのビューの形式。 */
export type ScenarioViewFormat = "DOCUMENT" | "MATRIX" | "FLOW";

/** 全体の俯瞰図の形式。 */
export type SystemViewFormat = "SYSTEM_MERMAID" | "SYSTEM_JSON";

/**
 * 表示の役割（全体設計 2.2、SpecProjector の設計 8.3）。既定は PdM。
 * - PdM: ファイルのパス・関数名・行番号・コードの断片を出さない。
 * - Eng: 文は PdM と同じにし、実装の名前と所在を併記する。仕様書に形式仕様のソースの付録を載せる。
 */
export type ViewRole = "PdM" | "Eng";

export interface ProjectionRequest {
  format: ScenarioViewFormat;
  viewRole: ViewRole;
  /** シナリオの表示の id（"S-01"）。オーケストレーターが切り出しの順に振る。 */
  displayId: string;
}

/** 曖昧さの一覧（SpecProjector の設計 8.4）。シナリオのビューの format に入れると projectSpecification が型の上で受け付けてしまうので、別の型にする。 */
export interface AmbiguityProjectionRequest {
  format: "AMBIGUITY_DOCUMENT";
  viewRole: ViewRole;
  /** シナリオの表示の id（"S-01"）。 */
  displayId: string;
}

export interface SystemProjectionRequest {
  format: SystemViewFormat;
  viewRole: ViewRole;
}

/** シナリオの射影で、表示の用語と意図の候補を引くための入力（M5 の設計 5）。 */
export interface ProjectionContext {
  /** 起点のコマンドまたはポリシーの、辞書の項目を引くため。 */
  scenario: ScenarioTarget;
  /** null のときは、起点の用語を「名前は未生成」として表す（単体で呼んだときと試験のときだけ）。 */
  glossary: Glossary | null;
  /** null のときは「意図の候補が無い」と書く。 */
  intents: IntentCatalog | null;
}

export interface SpecificationView {
  /** 内部の識別子。出力の置き場所を決めるためだけに使い、content には出さない。全体の俯瞰図は null。 */
  scenarioId: string | null;
  /** 表示の id（"S-01"）。全体の俯瞰図は null。 */
  displayId: string | null;
  viewRole: ViewRole;
  format: ScenarioViewFormat | "AMBIGUITY_DOCUMENT" | SystemViewFormat;
  mediaType: "text/markdown" | "text/vnd.mermaid" | "application/json";
  /** 改行は "\n"、末尾は改行 1 つ。 */
  content: string;
  basis: {
    /** いまの正本のソースの SHA-256。全体の俯瞰図と曖昧さの一覧は null。 */
    specSourceHash: string | null;
    /** 元にした論点カタログの basis.reportId。カタログが無ければ null。 */
    ledgerReportId: string | null;
    /** カタログが古いか（M5 の設計 3.3）。カタログが無ければ null。 */
    ledgerIsStale: boolean | null;
  };
}

/**
 * 形式仕様と論点カタログの組が契約を破っている（M5 の設計 1.2・7.7）。
 * カタログが古いことは契約違反ではない（ビューの中で知らせる）。
 */
export class ProjectionContractError extends Error {
  constructor(
    readonly scenarioId: string,
    readonly reason:
      | "SCENARIO_MISMATCH"
      | "UNKNOWN_OPERATION"
      | "UNKNOWN_STATE_VARIABLE"
      // 表現形式が関数の受け付けるものでない。表示の役割が PdM・Eng のどちらでもないときも、この理由にする
      | "UNSUPPORTED_FORMAT"
      // 辞書の basis.mapHash が、受け取った全体マップのハッシュと違う（SpecProjector の設計 7.7・8.1）
      | "GLOSSARY_STALE",
    readonly detail: string,
  ) {
    super(`M5 の入力の契約が破れている（${scenarioId}）: ${reason}: ${detail}`);
    this.name = "ProjectionContractError";
  }
}