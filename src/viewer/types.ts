// 画面（SpecViewer）の入力と事前条件の型（SpecViewer 基本設計 6.1・6.2）。
// src/types/ だけを参照する。画面ごとのビューモデルの型は、その画面を実装するときにここへ足す（設計 6.3）。

import type { AmbiguityReport } from "../types/formal.js";
import type { Glossary } from "../types/glossary.js";
import type { IntentCatalog } from "../types/intent.js";
import type { DomainLedgerCatalog } from "../types/ledger.js";
import type { ImplementationMap } from "../types/projection.js";
import type { RunReport, SystemMapBundle } from "../types/run.js";

/**
 * 1 つのファイルを読んだ結果（設計 6.1）。無いのか壊れているのかで表示する理由が違うので、3 通りに分ける。
 * JSON は JSON.parse の結果をそのまま value に置く。形は検査しないので、型は書き出した側の型を当てているだけである。
 * 書き出した実行が同じものかは checkRunOutputs が basis で確かめる。
 */
export type FileRead<T> =
  | { kind: "OK"; value: T }
  | { kind: "MISSING" }
  // JSON としてパースできない。reason はパースのエラーの文
  | { kind: "INVALID"; reason: string };

/** シナリオ 1 つのファイル。読むファイルは run_report.json のシナリオの kind で決まる（設計 6.1）。 */
export type ScenarioOutputs =
  | {
      scenarioId: string;
      displayId: string;
      kind: "COMPLETED";
      /** spec.md */
      document: FileRead<string>;
      /** matrix.md */
      matrix: FileRead<string>;
      /** flow.mmd */
      flow: FileRead<string>;
      /** spec.als */
      source: FileRead<string>;
      /** ledger.json */
      ledger: FileRead<DomainLedgerCatalog>;
    }
  | {
      scenarioId: string;
      displayId: string;
      kind: "AMBIGUOUS";
      /** ambiguity.json */
      ambiguity: FileRead<AmbiguityReport>;
    }
  | { scenarioId: string; displayId: string; kind: "STOPPED" };

/** 出力先から読んだファイルの中身（設計 2 節・6.1）。 */
export interface RunOutputs {
  /** run_report.json */
  report: FileRead<RunReport>;
  /** system_map.json */
  systemMap: FileRead<SystemMapBundle>;
  /** glossary.json */
  glossary: FileRead<Glossary>;
  /** intents.json */
  intents: FileRead<IntentCatalog>;
  /** implementation_map.json */
  implementationMap: FileRead<ImplementationMap>;
  /** run_report.json の scenarios の順。run_report.json が読めなければ空。 */
  scenarios: ScenarioOutputs[];
}

/** 画面を作れない理由（設計 6.2）。 */
export interface RunOutputsProblem {
  reason:
    // run_report.json が無い
    | "REPORT_MISSING"
    // JSON のファイルがパースできない
    | "INVALID_JSON"
    // basis を持たない（basis を足す前の古い出力）
    | "NO_BASIS"
    // basis が run_report.json のものと違う（別の実行の出力が混ざっている）
    | "BASIS_MISMATCH"
    // run_report.json のシナリオの kind から決まるファイルが無い
    | "SCENARIO_FILE_MISSING";
  /** 出力先の直下のファイルの名前（"glossary.json"）か、シナリオのディレクトリの中のファイルの名前（"spec.md"）。 */
  file: string;
  /** シナリオのファイルなら、そのシナリオの表示の id。内部の識別子は出さない（仕様 2.3）。 */
  scenario: string | null;
  detail: string;
}

/** 事前条件の検査の結果（仕様 3.1、設計 6.2）。problems はすべて画面を作れない理由なので、ok は problems が空のときだけ true。 */
export interface RunOutputsCheck {
  ok: boolean;
  problems: RunOutputsProblem[];
}