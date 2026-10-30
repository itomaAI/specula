// 1 回の実行の画面すべてのビューモデルを束ねる（SpecViewer 基本設計 1.2・6.11）。
// 画面ごとの組み立ては scenarios.ts・issues.ts・glossary.ts・map.ts にあり、ここでは呼ぶだけで判定を足さない。

import type { ViewRole } from "../types/projection.js";
import { checkRunOutputs } from "./check.js";
import { buildGlossaryView } from "./glossary.js";
import { buildIssueList } from "./issues.js";
import { buildMapView } from "./map.js";
import { buildScenarioDetails, buildScenarioList } from "./scenarios.js";
import type { RunOutputs, RunView } from "./types.js";

/**
 * 4 つの画面（シナリオ一覧・全体地図・仕様不備一覧・用語辞典）とシナリオの詳細のビューモデルを作る。
 * 事前条件（checkRunOutputs）を満たさない入力では例外を投げる。起動アプリは先に checkRunOutputs を呼び、
 * 破れがあれば画面を作らずに理由を出す（設計 1.2）。
 */
export function buildRunView(outputs: RunOutputs, viewRole: ViewRole): RunView {
  const check = checkRunOutputs(outputs);
  if (!check.ok) {
    const where = check.problems.map((p) => `${p.reason} ${p.scenario === null ? "" : `${p.scenario}/`}${p.file}`);
    throw new Error(`画面を作れない（事前条件の破れ）: ${where.join(", ")}`);
  }
  return {
    viewRole,
    scenarioList: buildScenarioList(outputs, viewRole),
    scenarioDetails: buildScenarioDetails(outputs, viewRole),
    issues: buildIssueList(outputs, viewRole),
    glossary: buildGlossaryView(outputs, viewRole),
    map: buildMapView(outputs, viewRole),
  };
}