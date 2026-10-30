// 表示名の解決（M5 の設計 3.1）。
//
// - 識別子の表示名は spec.labels から取る。GENERATED ならその文、NOT_GENERATED（または記録が無い）なら
//   「<識別子>（表示名は未生成）」とする。実装の名前や定型文で埋めない（M2 の設計 4.2）。
// - 真偽値の True・False は「真」「偽」、初期値が決まらない値 v<n>_unknown は「初期値は決まらない」。
// - 出口の種類と検査の種類は、固定の語に置き換える。検査の id（m3_reach_op1 など）は形式仕様の識別子を
//   含むので、そのまま表示しない（仕様 3.2）。

import type { OutletKind } from "../../types/context.js";
import type { FormalSpecification, StateVariable } from "../../types/formal.js";
import type { ConfirmationStatus } from "../../types/index.js";

export function labelOf(spec: FormalSpecification, id: string): string {
  const label = spec.labels[id];
  if (label !== undefined && label.status === "GENERATED") return label.text;
  return `${id}（表示名は未生成）`;
}

/**
 * 確定の状態の印（設計 8.9）。候補は印を付けない（仕様書の冒頭に 1 回だけ書くため）。
 * 未生成も印を付けない。文そのものが「未生成」と書かれていて、もう分かるため。
 */
export function statusMark(status: ConfirmationStatus | null | undefined): string {
  if (status === "CONFIRMED") return "（確定）";
  if (status === "NEEDS_RECHECK") return "（要再確認）";
  return "";
}

/** 表示名に確定の状態の印を足す。項目を定義する箇所でだけ使い、文の中の表示名には使わない（設計 8.9）。 */
export function markedLabelOf(spec: FormalSpecification, id: string): string {
  return `${labelOf(spec, id)}${statusMark(spec.labelStatus[id])}`;
}

export const OUTLET_KIND_TEXT: Readonly<Record<OutletKind, string>> = {
  RETURN: "戻り値を返して終わる",
  THROW: "例外で終わる",
  RESPONSE: "応答を返して終わる",
  ASYNC_CUT: "非同期の処理に引き渡して終わる",
};

/** 状態変数の値（BOOL は True・False、ENUM は値の識別子、INT は整数）を表示する。 */
export function valueText(spec: FormalSpecification, variable: StateVariable, value: string | number): string {
  if (typeof value === "number") return String(value);
  if (variable.domain === "BOOL") {
    if (value === "True") return "真";
    if (value === "False") return "偽";
  }
  if (variable.domain === "INT") return value;
  if (value === `${variable.id}_unknown`) return "初期値は決まらない";
  return labelOf(spec, value);
}

/** 状態の表の「とりうる値」。 */
export function domainValuesText(spec: FormalSpecification, variable: StateVariable): string {
  switch (variable.domain) {
    case "BOOL":
      return "真、偽";
    case "INT":
      return "整数";
    case "ENUM":
      // 列挙の値は、ここが定義の箇所なので確定の状態の印を付ける（設計 8.9）。
      return variable.values
        .map((value) => (value === `${variable.id}_unknown` ? valueText(spec, variable, value) : markedLabelOf(spec, value)))
        .join("、");
  }
}

/** 状態の表の「初期値」。 */
export function initialText(spec: FormalSpecification, variable: StateVariable): string {
  if (variable.initial === null) return "初期値は決まらない";
  return valueText(spec, variable, variable.initial);
}

/**
 * 出口（o1 など）を「〈表示名〉（〈出口の種類の語〉）」で表示する。出口の種類は、その出口を持つ最初の操作から取る。
 * marked が true なら表示名に確定の状態の印を足す（操作の「結果」の行。実行列の中では足さない。設計 8.9）。
 */
export function outcomeText(spec: FormalSpecification, outcome: string, marked = false): string {
  const operation = spec.operations.find((candidate) => candidate.outcome === outcome);
  const label = marked ? markedLabelOf(spec, outcome) : labelOf(spec, outcome);
  return operation === undefined ? label : `${label}（${OUTLET_KIND_TEXT[operation.outletKind]}）`;
}

/** 実行列の時点の「直前の操作の結果」。 */
export function traceOutcomeText(spec: FormalSpecification, outcome: string): string {
  return outcome === "Idle" ? "まだ操作していない" : outcomeText(spec, outcome);
}

/** 検査の id（M3 の plan.ts の形）を、種類ごとの固定の文にする。 */
export function checkText(spec: FormalSpecification, checkId: string): string {
  if (checkId === "m3_cover") return "どの操作の条件も成り立たない状態を探す検査";
  if (/^m3_escape_\d+$/.test(checkId)) return "抜けられない状態を探す検査";

  const operations = spec.operations.map((operation) => operation.id);
  const reach = /^m3_reach_(.+)$/.exec(checkId);
  if (reach !== null && operations.includes(reach[1]!)) {
    return `「${labelOf(spec, reach[1]!)}」に到達できるかの検査`;
  }
  const overlap = /^m3_overlap_(.+)$/.exec(checkId);
  if (overlap !== null) {
    for (const a of operations) {
      const prefix = `${a}_`;
      if (!overlap[1]!.startsWith(prefix)) continue;
      const b = overlap[1]!.slice(prefix.length);
      if (operations.includes(b)) {
        return `「${labelOf(spec, a)}」と「${labelOf(spec, b)}」の条件が重なる状態を探す検査`;
      }
    }
  }
  return "種類の分からない検査";
}