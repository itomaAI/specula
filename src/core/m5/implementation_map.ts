// 実装との対応表（implementation_map.json）の項目を作る（SpecProjector の設計 8.5。ImplementationMapBuilder）。
//
// - 並び: Bounded Context（c1…。map.boundedContexts の順）→ 俯瞰図のノード（n1…。events → commands → policies。
//   render_system.ts と同じ振り方）→ シナリオごとに入力の順で、シナリオ → 曖昧さ（A-001…）→ 状態変数（V-01…）→ 論点（L-001…）。
// - 地図の要素とシナリオは、辞書の項目の implementation をそのまま写す（Eng の併記と同じ値。implementation.ts）。
// - 曖昧さと論点は、辞書と結び付けない（glossaryEntryId は null）。
// - 状態変数は、実装の名前（StateVariable.name）を implementation.names にそのまま持つ辞書の項目がちょうど 1 つのときだけ
//   結び付ける。0 件・2 件以上なら null にする（取り違えを避けるため）。辞書には足さない（全体設計 2.2）。
// - 状態変数の所在は spec.sourceMap のユニット、論点の所在は論点の操作ごとの出口のユニットから作る。
//   経路の全ユニット（spec.sourceMap[operation.id]）は数が多いので使わない。
// - 辞書の古さとシナリオの食い違いは、呼び出し元（spec_projector.ts）が確かめてある。
//   ここでは、辞書に地図の要素や起点の項目が無いときだけ GLOSSARY_STALE にする。

import type { Glossary, GlossaryEntry, GlossaryLocation } from "../../types/glossary.js";
import type { ImplementationMapEntry, ImplementationMapInput } from "../../types/projection.js";
import { ProjectionContractError } from "../../types/projection.js";
import type { EventStormingMap } from "../../types/scenario.js";

type MapKind = "BOUNDED_CONTEXT" | "COMMAND" | "EVENT" | "POLICY";
type Implementation = ImplementationMapEntry["implementation"];

/** 辞書の implementation を写す（呼び出し元の配列を共有しない）。 */
function copyImplementation(entry: GlossaryEntry): Implementation {
  return {
    names: [...entry.implementation.names],
    locations: entry.implementation.locations.map((location) => ({ ...location })),
  };
}

/** 地図の要素の辞書の項目。無いか種類が違えば、辞書と地図が食い違っている。 */
function mapEntryOf(
  entries: ReadonlyMap<string, GlossaryEntry>,
  kind: MapKind,
  mapId: string,
  scenarioId: string,
): GlossaryEntry {
  const entry = entries.get(mapId);
  if (entry === undefined || entry.kind !== kind) {
    throw new ProjectionContractError(scenarioId, "GLOSSARY_STALE", `辞書に ${kind} の項目 ${mapId} が無い`);
  }
  return entry;
}

/** ユニットの識別子 "<ファイル>:<行>:<列>:<種類>" から所在を作る。ファイルのパスに ":" があってもよいよう、右から分ける。 */
export function locationOfUnitId(unitId: string): GlossaryLocation {
  const parts = unitId.split(":");
  const line = Number(parts[parts.length - 3]);
  if (parts.length < 4 || !Number.isInteger(line)) {
    throw new Error(`ユニットの識別子の形が "<ファイル>:<行>:<列>:<種類>" でない: ${unitId}`);
  }
  return { file: parts.slice(0, -3).join(":"), line };
}

/** 同じファイルと行の所在を重ねずに足す。 */
function pushLocation(list: GlossaryLocation[], location: GlossaryLocation): void {
  if (!list.some((item) => item.file === location.file && item.line === location.line)) list.push(location);
}

function numbered(index: number, width: number): string {
  return String(index + 1).padStart(width, "0");
}

export function buildImplementationMap(
  map: EventStormingMap,
  glossary: Glossary,
  scenarios: readonly ImplementationMapInput[],
): ImplementationMapEntry[] {
  const entries = new Map(glossary.entries.map((entry) => [entry.id, entry] as const));
  const result: ImplementationMapEntry[] = [];

  // ---- 地図の要素 ----
  map.boundedContexts.forEach((context, index) => {
    const entry = mapEntryOf(entries, "BOUNDED_CONTEXT", context.id, "(system)");
    result.push({
      displayId: `c${index + 1}`,
      kind: "BOUNDED_CONTEXT",
      internalId: context.id,
      glossaryEntryId: entry.id,
      implementation: copyImplementation(entry),
    });
  });
  const nodes: Array<{ kind: MapKind; mapId: string }> = [
    ...map.events.map((event) => ({ kind: "EVENT" as const, mapId: event.id })),
    ...map.commands.map((command) => ({ kind: "COMMAND" as const, mapId: command.id })),
    ...map.policies.map((policy) => ({ kind: "POLICY" as const, mapId: policy.id })),
  ];
  nodes.forEach(({ kind, mapId }, index) => {
    const entry = mapEntryOf(entries, kind, mapId, "(system)");
    result.push({
      displayId: `n${index + 1}`,
      kind,
      internalId: mapId,
      glossaryEntryId: entry.id,
      implementation: copyImplementation(entry),
    });
  });

  // ---- シナリオごと ----
  for (const { displayId, scenario, spec, ambiguity, ledger } of scenarios) {
    const inlet = mapEntryOf(entries, scenario.inletType, scenario.inletTrigger.id, scenario.id);
    result.push({
      displayId,
      kind: "SCENARIO",
      internalId: scenario.id,
      glossaryEntryId: inlet.id,
      implementation: copyImplementation(inlet),
    });

    (ambiguity?.issues ?? []).forEach((issue, index) => {
      result.push({
        displayId: `${displayId}-A-${numbered(index, 3)}`,
        kind: "AMBIGUITY",
        internalId: issue.unitIds[0] ?? "",
        glossaryEntryId: null,
        implementation: { names: [], locations: [{ file: issue.location.file, line: issue.location.line }] },
      });
    });

    if (spec === null) continue;

    const width = Math.max(2, String(spec.stateVariables.length).length);
    spec.stateVariables.forEach((variable, index) => {
      const locations: GlossaryLocation[] = [];
      for (const unitId of spec.sourceMap[variable.id] ?? [variable.unitId]) pushLocation(locations, locationOfUnitId(unitId));
      const matches = glossary.entries.filter((entry) => entry.implementation.names.includes(variable.name));
      result.push({
        displayId: `${displayId}-V-${numbered(index, width)}`,
        kind: "STATE_VARIABLE",
        internalId: variable.id,
        glossaryEntryId: matches.length === 1 ? (matches[0] as GlossaryEntry).id : null,
        implementation: { names: [variable.name], locations },
      });
    });

    if (ledger === null) continue;

    const operations = new Map(spec.operations.map((operation) => [operation.id, operation] as const));
    ledger.issues.forEach((issue, index) => {
      const locations: GlossaryLocation[] = [];
      for (const operationId of issue.operations) {
        const operation = operations.get(operationId);
        if (operation === undefined) continue; // 呼び出し元が UNKNOWN_OPERATION で止めてある
        for (const unitId of spec.sourceMap[operation.outcome] ?? []) pushLocation(locations, locationOfUnitId(unitId));
      }
      result.push({
        displayId: `${displayId}-L-${numbered(index, 3)}`,
        kind: "LEDGER_ISSUE",
        internalId: issue.id,
        glossaryEntryId: null,
        implementation: { names: [], locations },
      });
    });
  }

  return result;
}