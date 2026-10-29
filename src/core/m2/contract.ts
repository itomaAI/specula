// 入力の契約を確かめる（M2 の設計 5「M1 の契約違反」）。破れていれば TranspileContractError。
// 確かめたついでに、後の段が使う表（ユニットの索引と、書き込みの guardTerms）を作って返す。

import type { ExtractionUnit, RawContextModel } from "../../types/context.js";
import { TranspileContractError } from "../../types/formal.js";

export interface GuardTerm {
  /** BRANCH_CONDITION のユニットの識別子。 */
  unitId: string;
  holds: boolean;
}

export interface CheckedFacts {
  facts: RawContextModel;
  units: ReadonlyMap<string, ExtractionUnit>;
  /** STATE_WRITE の識別子 → 書き込みの条件（M1 の details.guardTerms）。 */
  guardTerms: ReadonlyMap<string, GuardTerm[]>;
}

export function checkContract(facts: RawContextModel): CheckedFacts {
  const fail = (reason: TranspileContractError["reason"], detail: string): never => {
    throw new TranspileContractError(facts.scenarioId, reason, detail);
  };
  if (facts.slices.length === 0) fail("NO_SLICES", "スライスが 0 個");

  const units = new Map<string, ExtractionUnit>();
  for (const unit of facts.units) units.set(unit.id, unit);
  const requireUnit = (id: string, where: string): ExtractionUnit => {
    const unit = units.get(id);
    return unit === undefined ? fail("UNKNOWN_UNIT", `${where} の ${id} がユニットに無い`) : unit;
  };

  const guardTerms = new Map<string, GuardTerm[]>();
  for (const unit of facts.units) {
    if (unit.kind !== "STATE_WRITE") continue;
    const expression = unit.details?.["expression"];
    if (typeof expression !== "string" || expression === "") fail("WRITE_WITHOUT_EXPRESSION", unit.id);
    const target = unit.details?.["target"];
    if (typeof target !== "string") fail("MALFORMED_DETAILS", `${unit.id} に target が無い`);
    if (requireUnit(target as string, unit.id).kind !== "STATE") fail("MALFORMED_DETAILS", `${unit.id} の target が STATE でない`);
    guardTerms.set(unit.id, parseGuardTerms(unit, (detail) => fail("MALFORMED_DETAILS", detail), requireUnit));
  }

  for (const slice of facts.slices) {
    for (const id of slice.unitIds) requireUnit(id, slice.sliceId);
    for (const id of slice.writes) requireUnit(id, slice.sliceId);
    for (const condition of slice.conditions) {
      if (requireUnit(condition.unitId, slice.sliceId).kind !== "BRANCH_CONDITION") {
        fail("MALFORMED_DETAILS", `${slice.sliceId} の条件 ${condition.unitId} が BRANCH_CONDITION でない`);
      }
    }
    requireUnit(slice.outlet.unitId, slice.sliceId);
  }
  return { facts, units, guardTerms };
}

function parseGuardTerms(
  unit: ExtractionUnit,
  fail: (detail: string) => never,
  requireUnit: (id: string, where: string) => ExtractionUnit,
): GuardTerm[] {
  const raw = unit.details?.["guardTerms"];
  if (typeof raw !== "string") return fail(`${unit.id} に guardTerms が無い`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return fail(`${unit.id} の guardTerms が JSON でない`);
  }
  if (!Array.isArray(parsed)) return fail(`${unit.id} の guardTerms が配列でない`);
  const terms: GuardTerm[] = [];
  for (const item of parsed) {
    if (typeof item !== "object" || item === null) return fail(`${unit.id} の guardTerms の項目が壊れている`);
    const { unitId, holds } = item as { unitId?: unknown; holds?: unknown };
    if (typeof unitId !== "string" || typeof holds !== "boolean") return fail(`${unit.id} の guardTerms の項目が壊れている`);
    if (requireUnit(unitId, unit.id).kind !== "BRANCH_CONDITION") return fail(`${unit.id} の guardTerms の ${unitId} が BRANCH_CONDITION でない`);
    terms.push({ unitId, holds });
  }
  return terms;
}