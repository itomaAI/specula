// M1（ContextExtractor）の出力の型（M1 の設計 4）。

/** コードの中の位置（M1 のユニット用）。line・column は 1 から数える。 */
export interface UnitLocation {
  file: string;
  line: number;
  column: number;
}

export type ExtractionUnitKind =
  | "STATE"
  | "STATE_WRITE"
  | "OPERATION"
  | "INTERFACE_TEXT"
  | "BRANCH_CONDITION"
  | "API_ENDPOINT"
  | "DATA_MUTATION"
  | "SCHEMA_ENTITY"
  /** 追跡した呼び出し（中へ入った呼び出し）。 */
  | "CALL"
  | "RETURN"
  | "THROW"
  | "ASYNC_CUT"
  | "EXTERNAL_CALL"
  | "RECURSION";

export type ExtractionLayer = "UI" | "LOGIC" | "DATABASE" | "ASYNC_TRIGGER";

export interface ExtractionUnit {
  /** "<ファイル>:<行>:<列>:<種類>" */
  id: string;
  kind: ExtractionUnitKind;
  /** 実装上の名前（変数名、関数名、呼び出しの式など）。 */
  name: string;
  layer: ExtractionLayer;
  location: UnitLocation;
  /** たどった関数の名前（ユニットを含む関数）。 */
  componentScope?: string;
  /** 種類ごとの項目（M1 の設計 4 の表）。式はすべて原文のまま。 */
  details?: Record<string, string | number | boolean | null>;
}

export type OutletKind = "RETURN" | "THROW" | "RESPONSE" | "ASYNC_CUT";

export interface UseCaseSlice {
  /** "<commandId>#<呼び出しのユニットの識別子>>…><出口のユニットの識別子>" */
  sliceId: string;
  /** 出口に至る条件（経路の順）。holds: true は条件が成り立つ側。 */
  conditions: Array<{ unitId: string; expression: string; holds: boolean }>;
  outlet: { unitId: string; kind: OutletKind };
  /** この経路で通る STATE_WRITE と DATA_MUTATION の識別子（経路の順）。 */
  writes: string[];
  /** この経路で通るユニットの識別子（経路の順。条件・書き込み・呼び出し・出口を含む）。 */
  unitIds: string[];
}

/** 解析しなかった層と、その理由（報告に出す）。 */
export interface ExtractionCoverage {
  analyzed: Array<"LOGIC">;
  notAnalyzed: Array<{ analyzer: "UI" | "API_ENDPOINT" | "ASYNC_TRIGGER" | "SCHEMA"; reason: string }>;
}

export interface RawContextModel {
  commandId: string;
  inlet: {
    /** 追跡を始めた関数（コマンドのハンドラ）の所在。2026-10-31（T-0070）に kind を外した（起点はコマンドだけ）。 */
    handler: { file: string; symbol: string; line: number };
    route?: string;
  };
  /** ファイル → 行 → 列 → 種類の順。 */
  units: ExtractionUnit[];
  /** 出口のユニットの並びの順。 */
  slices: UseCaseSlice[];
  /** EXTERNAL_CALL と RECURSION の要約（ユニットの並びの順）。 */
  unresolved: Array<{ unitId: string; location: UnitLocation; reason: string }>;
  coverage: ExtractionCoverage;
}

/** 構文の解析に失敗した（推測で続けない）。 */
export class SyntaxExtractionError extends Error {
  constructor(
    readonly file: string,
    readonly line: number,
    readonly column: number,
    readonly causeMessage: string,
  ) {
    super(`構文の解析に失敗した: ${file}:${line}:${column}: ${causeMessage}`);
    this.name = "SyntaxExtractionError";
  }
}

/** 起点の関数が見つからない（別の関数を起点にしない）。 */
export class InletNotFoundError extends Error {
  constructor(
    readonly file: string,
    readonly symbol: string,
    readonly reason: string,
  ) {
    super(`起点が見つからない: ${file}#${symbol}: ${reason}`);
    this.name = "InletNotFoundError";
  }
}