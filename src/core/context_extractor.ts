// M1（ContextExtractor）の公開する関数（M1 の設計 1.2）。
// 起点の関数から呼び出しをたどり、出口ごとにユースケーススライスを作る。LLM は使わない。
// パスはリポジトリのルートからの相対パス。ルートの付け足しは呼び出し元が withRoot（src/lib/rooted_file_system.ts）で行う。

import type { FileSystemPort } from "../ports/FileSystemPort.js";
import type { ExtractionCoverage, RawContextModel, UseCaseSlice } from "../types/context.js";
import type { CommandTarget } from "../types/command.js";
import { locateInlet } from "./m1/locate.js";
import { PathWalker } from "./m1/paths.js";
import { SourceLoader } from "./m1/source_loader.js";
import { UnitCollector } from "./m1/units.js";

/**
 * コマンド 1 つの事実を抜き出す。
 * 失敗: 起点が無ければ InletNotFoundError、たどったファイルの構文が読めなければ SyntaxExtractionError（どちらも推測で続けない）。
 */
export async function extractContext(target: CommandTarget, deps: { fs: FileSystemPort }): Promise<RawContextModel> {
  const loader = new SourceLoader(deps.fs);
  const units = new UnitCollector();
  const inlet = await locateInlet(loader, target);
  const exits = await new PathWalker(loader, units).exitsOf(inlet);

  const sortedUnits = units.sorted();
  const order = new Map(sortedUnits.map((unit, index) => [unit.id, index] as const));

  const slices: UseCaseSlice[] = exits.map((exit) => ({
    sliceId: `${target.id}#${[...exit.chain, exit.outlet.unitId].join(">")}`,
    conditions: exit.conditions.map((condition) => ({
      unitId: condition.unitId,
      expression: condition.expression,
      holds: condition.holds,
    })),
    outlet: { unitId: exit.outlet.unitId, kind: exit.outlet.kind },
    writes: [...exit.writes],
    unitIds: [...exit.unitIds],
  }));
  slices.sort((a, b) => {
    const byOutlet = (order.get(a.outlet.unitId) ?? 0) - (order.get(b.outlet.unitId) ?? 0);
    if (byOutlet !== 0) return byOutlet;
    return a.sliceId < b.sliceId ? -1 : a.sliceId > b.sliceId ? 1 : 0;
  });
  // 識別子が重なったとき（同じ呼び出しから同じ出口へ別の経路で至るとき）は、並びの順に "~2" から番号を付ける
  const counts = new Map<string, number>();
  for (const slice of slices) {
    const seen = (counts.get(slice.sliceId) ?? 0) + 1;
    counts.set(slice.sliceId, seen);
    if (seen > 1) slice.sliceId = `${slice.sliceId}~${seen}`;
  }

  const unresolved = sortedUnits
    .filter((unit) => unit.kind === "EXTERNAL_CALL" || unit.kind === "RECURSION")
    .map((unit) => ({ unitId: unit.id, location: { ...unit.location }, reason: String(unit.details?.["reason"] ?? "") }));

  const model: RawContextModel = {
    commandId: target.id,
    inlet: {
      handler: { file: inlet.file.path, symbol: inlet.symbol, line: inlet.line },
    },
    units: sortedUnits,
    slices,
    unresolved,
    coverage: coverageOf(target),
  };
  if (target.readModel !== undefined) model.inlet.route = target.readModel.route;
  return model;
}

/** 初回の範囲で解析しなかった層（報告に出す）。 */
function coverageOf(target: CommandTarget): ExtractionCoverage {
  return {
    analyzed: ["LOGIC"],
    notAnalyzed: [
      {
        analyzer: "UI",
        reason: target.readModel === undefined ? "コマンドに画面が無い" : "初回の範囲では画面の解析を作っていない",
      },
      { analyzer: "API_ENDPOINT", reason: "初回の範囲ではルート定義の解析を作っていない" },
      { analyzer: "ASYNC_TRIGGER", reason: "初回の範囲ではトリガーの定義の解析を作っていない（イベントの発行は ASYNC_CUT として残す）" },
      { analyzer: "SCHEMA", reason: "初回の範囲ではスキーマの解析を作っていない（データの変更は DATA_MUTATION として残す）" },
    ],
  };
}