// M5（SpecProjector）の入出力の型（M5 の設計 5）。

import type { AmbiguityReport, FormalSpecification } from "./formal.js";
import type { Glossary, GlossaryLocation } from "./glossary.js";
import type { IntentCatalog } from "./intent.js";
import type { DomainLedgerCatalog } from "./ledger.js";
import type { CommandTarget } from "./command.js";

/** コマンド 1 つのビューの形式。 */
export type CommandViewFormat = "DOCUMENT" | "MATRIX" | "FLOW";

/** 全体の俯瞰図の形式。 */
export type SystemViewFormat = "SYSTEM_MERMAID" | "SYSTEM_JSON";

/**
 * 表示の役割（全体設計 2.2、SpecProjector の設計 8.3、全体仕様 4.5）。既定は BUSINESS。画面の表示名は「業務／実装」。
 * - BUSINESS: ファイルのパス・関数名・行番号・コードの断片を出さない。
 * - IMPLEMENTATION: 文は BUSINESS と同じにし、実装の名前と所在を併記する。仕様書に形式仕様のソースの付録を載せる。
 * URL や CLI では小文字で受け取ってよく、読むときに大文字へ戻す。列挙に無い値はエラーにする。
 */
export type ViewRole = "BUSINESS" | "IMPLEMENTATION";

/** 両方の役割。出力は役割ごとに、この順で書く（全体設計 4.1）。 */
export const VIEW_ROLES: readonly ViewRole[] = ["BUSINESS", "IMPLEMENTATION"];

/** 役割で中身が変わる出力の置き場所（出力先からの相対パス）。役割の識別子を小文字にする（全体仕様 4.5、全体設計 4.1）。 */
export function viewsDirOf(viewRole: ViewRole): string {
  return `views/${viewRole.toLowerCase()}`;
}

export interface ProjectionRequest {
  format: CommandViewFormat;
  viewRole: ViewRole;
  /** コマンドの表示の id（"C-01"）。オーケストレーターが切り出しの順に振る。 */
  displayId: string;
}

/** 曖昧さの一覧（SpecProjector の設計 8.4）。コマンドのビューの format に入れると projectSpecification が型の上で受け付けてしまうので、別の型にする。 */
export interface AmbiguityProjectionRequest {
  format: "AMBIGUITY_DOCUMENT";
  viewRole: ViewRole;
  /** コマンドの表示の id（"C-01"）。 */
  displayId: string;
}

/** 俯瞰図の階層（SpecProjector の設計 8.9）。地図 1 は Bounded Context のつながり、地図 2 は 1 つの Bounded Context の中。 */
export type SystemMapLevel = "CONTEXT_MAP" | "CONTEXT_DETAIL";

export interface SystemProjectionRequest {
  format: SystemViewFormat;
  viewRole: ViewRole;
  /** 省くと今の 1 枚の俯瞰図（設計 4.4）。 */
  level?: SystemMapLevel;
  /** CONTEXT_DETAIL のときの Bounded Context（全体マップの id）。出力には出さない。 */
  contextId?: string;
  /** CONTEXT_DETAIL のときだけ。アクター・リードモデル・アグリゲートとそのつながりを足す（既定 false）。 */
  includeSupporting?: boolean;
}

/** コマンドの射影で、表示の用語と意図の候補を引くための入力（M5 の設計 5）。 */
export interface ProjectionContext {
  /** 起点のコマンドまたはポリシーの、辞書の項目を引くため。 */
  commandTarget: CommandTarget;
  /** null のときは、起点の用語を「名前は未生成」として表す（単体で呼んだときと試験のときだけ）。 */
  glossary: Glossary | null;
  /** null のときは「意図の候補が無い」と書く。 */
  intents: IntentCatalog | null;
}

export interface SpecificationView {
  /** 内部の識別子。出力の置き場所を決めるためだけに使い、content には出さない。全体の俯瞰図は null。 */
  commandId: string | null;
  /** 表示の id（"C-01"）。全体の俯瞰図は null。 */
  displayId: string | null;
  viewRole: ViewRole;
  format: CommandViewFormat | "AMBIGUITY_DOCUMENT" | SystemViewFormat;
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

/** 実装との対応表の、コマンド 1 つ分の入力（SpecProjector の設計 5・8.5）。 */
export interface ImplementationMapInput {
  /** コマンドの表示の id（"C-01"）。 */
  displayId: string;
  commandTarget: CommandTarget;
  /** FormalTranspiler で止まったコマンドは null。 */
  spec: FormalSpecification | null;
  /** 曖昧さで止まったときだけある。 */
  ambiguity: AmbiguityReport | null;
  /** 論点カタログ。LedgerSynthesizer まで進まなかったコマンドは null。論点の表示の id と識別子の対応に使う（設計 8.7）。 */
  ledger: DomainLedgerCatalog | null;
}

export type ImplementationMapEntryKind =
  | "BOUNDED_CONTEXT"
  | "COMMAND"
  | "EVENT"
  | "POLICY"
  | "COMMAND_TARGET"
  | "AMBIGUITY"
  | "STATE_VARIABLE"
  | "LEDGER_ISSUE";

export interface ImplementationMapEntry {
  /** "c1"・"n1"・"C-01"・"C-01-A-001"・"C-01-V-01"・"C-01-L-001" */
  displayId: string;
  kind: ImplementationMapEntryKind;
  /** 地図の要素の id、コマンドの id、状態変数の識別子、論点の識別子など。曖昧さは最初のユニットの識別子。 */
  internalId: string;
  /** 辞書の項目の id。結び付けられなければ null（設計 8.5）。 */
  glossaryEntryId: string | null;
  implementation: {
    names: string[];
    locations: GlossaryLocation[];
  };
}

/** 実装との対応表（implementation_map.json。設計 8.5）。表示の役割に関係なく、同じ入力からは同じ表を作る。 */
export interface ImplementationMap {
  /** 設計 8.5 の並び。 */
  entries: ImplementationMapEntry[];
  /** 元にした辞書の basis をそのまま写す。 */
  basis: { mapHash: string; documentsHash: string };
}

/**
 * 形式仕様と論点カタログの組が契約を破っている（M5 の設計 1.2・7.7）。
 * カタログが古いことは契約違反ではない（ビューの中で知らせる）。
 */
export class ProjectionContractError extends Error {
  constructor(
    readonly commandId: string,
    readonly reason:
      | "COMMAND_MISMATCH"
      | "UNKNOWN_OPERATION"
      | "UNKNOWN_STATE_VARIABLE"
      // 表現形式が関数の受け付けるものでない。表示の役割が BUSINESS・IMPLEMENTATION のどちらでもないときも、この理由にする
      | "UNSUPPORTED_FORMAT"
      // 辞書の basis.mapHash が、受け取った全体マップのハッシュと違う（SpecProjector の設計 7.7・8.1）
      | "GLOSSARY_STALE"
      // 俯瞰図の地図 2 で、contextId が無いか、全体マップに無い Bounded Context を指す（SpecProjector の設計 8.9）
      | "UNKNOWN_CONTEXT",
    readonly detail: string,
  ) {
    super(`M5 の入力の契約が破れている（${commandId}）: ${reason}: ${detail}`);
    this.name = "ProjectionContractError";
  }
}