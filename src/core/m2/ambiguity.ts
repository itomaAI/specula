// 曖昧性を集める（M2 の設計 5）。最初の 1 件で止めず、すべて集める。
//
// - 種類・ユニット・所在・原文は決定論的に決める。質問の文（question）は labels.ts が LLM で後から付ける。
// - 並びはユニットの並び順（M1 の units の並び。ファイル → 行 → 列 → 種類）。同じユニットなら種類の順、さらに原文の順。
// - UNDETERMINED_VALUE: 書き込みの式が設計 2.1 の表のどの形にも当たらない（states.undeterminedWrites）。
// - EXTERNAL_EFFECT: 経路にある EXTERNAL_CALL・RECURSION のうち、引数か受け手に状態・this・関数があるもの
//   （paths.externalEffects）。
// - CONFLICTING_SLICES: 条件の組（ユニットと側）が同じなのに出口のユニットが違うスライスの組。
//   unitIds はそれらの出口のユニット（ユニットの並び順）。

import type { ExtractionUnit } from "../../types/context.js";
import type { AmbiguityIssue, AmbiguityKind } from "../../types/formal.js";
import type { CheckedFacts } from "./contract.js";
import { type TranslatedPaths, conditionKey } from "./paths.js";
import type { StateModel } from "./states.js";

export type AmbiguityDraft = Omit<AmbiguityIssue, "question">;

export interface CollectedAmbiguity {
  issues: AmbiguityDraft[];
  counts: Record<AmbiguityKind, number>;
}

const KIND_ORDER: readonly AmbiguityKind[] = ["UNDETERMINED_VALUE", "EXTERNAL_EFFECT", "CONFLICTING_SLICES"];

export function collectAmbiguity(checked: CheckedFacts, states: StateModel, paths: TranslatedPaths): CollectedAmbiguity {
  const order = new Map<string, number>();
  checked.facts.units.forEach((unit, index) => order.set(unit.id, index));
  const rank = (id: string): number => order.get(id) ?? Number.MAX_SAFE_INTEGER;
  const byRank = (a: string, b: string): number => rank(a) - rank(b);
  const unitOf = (id: string): ExtractionUnit => checked.units.get(id) as ExtractionUnit;

  const issues: AmbiguityDraft[] = [];

  for (const write of states.undeterminedWrites) {
    issues.push({ kind: "UNDETERMINED_VALUE", unitIds: [...write.unitIds], location: write.location, detail: write.detail });
  }

  for (const id of [...paths.externalEffects].sort(byRank)) {
    const unit = unitOf(id);
    issues.push({ kind: "EXTERNAL_EFFECT", unitIds: [id], location: unit.location, detail: callText(unit) });
  }

  const groups = new Map<string, { sliceIds: string[]; outlets: string[] }>();
  for (const slice of checked.facts.slices) {
    const key = conditionKey(slice);
    const group = groups.get(key) ?? { sliceIds: [], outlets: [] };
    group.sliceIds.push(slice.sliceId);
    if (!group.outlets.includes(slice.outlet.unitId)) group.outlets.push(slice.outlet.unitId);
    groups.set(key, group);
  }
  for (const [key, group] of groups) {
    if (group.outlets.length < 2) continue;
    const outlets = [...group.outlets].sort(byRank);
    const first = unitOf(outlets[0] as string);
    const conditions = key === "" ? "条件なし" : key;
    issues.push({
      kind: "CONFLICTING_SLICES",
      unitIds: outlets,
      location: first.location,
      detail: `${group.sliceIds.join(", ")}（${conditions}）`,
    });
  }

  issues.sort((a, b) => {
    const byUnit = rank(a.unitIds[0] as string) - rank(b.unitIds[0] as string);
    if (byUnit !== 0) return byUnit;
    const byKind = KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind);
    if (byKind !== 0) return byKind;
    return a.detail < b.detail ? -1 : a.detail > b.detail ? 1 : 0;
  });

  const counts: Record<AmbiguityKind, number> = { UNDETERMINED_VALUE: 0, EXTERNAL_EFFECT: 0, CONFLICTING_SLICES: 0 };
  for (const issue of issues) counts[issue.kind] += 1;
  return { issues, counts };
}

/** 呼び出しの原文に近い形（callee(引数, …)）。M1 の details の callee と args から作る。 */
function callText(unit: ExtractionUnit): string {
  const callee = unit.details?.["callee"];
  const raw = unit.details?.["args"];
  let args: string[] = [];
  if (typeof raw === "string") {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) args = parsed.filter((item): item is string => typeof item === "string");
    } catch {
      args = [];
    }
  }
  const name = typeof callee === "string" ? callee : unit.name;
  return `${name}(${args.join(", ")})`;
}