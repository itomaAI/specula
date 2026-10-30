// 出力先のファイルを読み、画面の入力（RunOutputs）にする（SpecViewer 基本設計 6.1）。
// writeOutputs と対にする。Node.js と Itera OS の起動アプリの両方から使うので、FileSystemPort だけを通し、node:path を使わない。
// 形の検査はしない（JSON のパースだけ）。形と組み合わせの検査は checkRunOutputs が行う。
// FileSystemPort.read は無いファイルで例外を投げるので、exists で確かめてから読む。それ以外の読み込みの失敗は例外のまま返す（環境の故障のため）。

import type { FileSystemPort } from "../ports/FileSystemPort.js";
import type { AmbiguityReport } from "../types/formal.js";
import type { Glossary } from "../types/glossary.js";
import type { IntentCatalog } from "../types/intent.js";
import type { DomainLedgerCatalog } from "../types/ledger.js";
import type { ImplementationMap } from "../types/projection.js";
import type { RunReport, SystemMapBundle } from "../types/run.js";
import type { FileRead, RunOutputs, ScenarioOutputs } from "../viewer/types.js";
import { safeName } from "./write_outputs.js";

async function readText(fs: FileSystemPort, path: string): Promise<FileRead<string>> {
  if (!(await fs.exists(path))) return { kind: "MISSING" };
  return { kind: "OK", value: await fs.read(path) };
}

async function readJson<T>(fs: FileSystemPort, path: string): Promise<FileRead<T>> {
  const text = await readText(fs, path);
  if (text.kind !== "OK") return text;
  try {
    return { kind: "OK", value: JSON.parse(text.value) as T };
  } catch (error) {
    return { kind: "INVALID", reason: error instanceof Error ? error.message : String(error) };
  }
}

export async function readRunOutputs(fs: FileSystemPort, outDir: string): Promise<RunOutputs> {
  // パスのつなぎ方は writeOutputs と同じ。
  const root = outDir.replace(/\/+$/, "");
  const at = (...parts: string[]): string => [root, ...parts].filter((p) => p !== "").join("/");

  const report = await readJson<RunReport>(fs, at("run_report.json"));
  const systemMap = await readJson<SystemMapBundle>(fs, at("system_map.json"));
  const glossary = await readJson<Glossary>(fs, at("glossary.json"));
  const intents = await readJson<IntentCatalog>(fs, at("intents.json"));
  const implementationMap = await readJson<ImplementationMap>(fs, at("implementation_map.json"));

  // シナリオのディレクトリは run_report.json の行から引く（list は順序を保証しないため。設計 6.1）。
  // 形は検査しないが、scenarios が配列でなければシナリオを読まない。
  const scenarios: ScenarioOutputs[] = [];
  const rows = report.kind === "OK" && Array.isArray(report.value.scenarios) ? report.value.scenarios : [];
  for (const row of rows) {
    const dir = at("scenarios", safeName(row.scenarioId));
    const base = { scenarioId: row.scenarioId, displayId: row.displayId };
    if (row.kind === "COMPLETED") {
      scenarios.push({
        ...base,
        kind: "COMPLETED",
        document: await readText(fs, `${dir}/spec.md`),
        matrix: await readText(fs, `${dir}/matrix.md`),
        flow: await readText(fs, `${dir}/flow.mmd`),
        source: await readText(fs, `${dir}/spec.als`),
        ledger: await readJson<DomainLedgerCatalog>(fs, `${dir}/ledger.json`),
      });
    } else if (row.kind === "AMBIGUOUS") {
      scenarios.push({ ...base, kind: "AMBIGUOUS", ambiguity: await readJson<AmbiguityReport>(fs, `${dir}/ambiguity.json`) });
    } else {
      scenarios.push({ ...base, kind: "STOPPED" });
    }
  }

  return { report, systemMap, glossary, intents, implementationMap, scenarios };
}